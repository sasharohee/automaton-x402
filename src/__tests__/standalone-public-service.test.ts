/**
 * Standalone public service mode
 *
 *  - optional `publicService` config block: read only in standalone mode,
 *    validated (https:// URL, port 1024-65535, default 8787)
 *  - with the block: "public service" instructions replace "NO inbound
 *    connectivity" in the parent, worker, planner and replanner prompts
 *  - without the block: the prompts are unchanged
 *  - parent prompt status of the public port (local TCP probe)
 *
 * Everything is mocked or local: no network egress, no wallet, no spending.
 */

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { parsePublicServiceConfig, DEFAULT_PUBLIC_SERVICE_PORT } from "../config.js";
import {
  STANDALONE_MODE_NOTICE,
  STANDALONE_PLANNER_NOTICE,
  PAYAI_FACILITATOR_URL,
  BASE_USDC_ADDRESS,
  buildStandaloneModeNotice,
  buildStandaloneWorkerNotice,
  buildStandalonePlannerNotice,
  buildStandaloneEarningGuidance,
  buildPublicServiceStatus,
} from "../agent/standalone-notice.js";
import { getPublicService, probeLocalPort } from "../agent/public-service.js";
import { buildSystemPrompt } from "../agent/system-prompt.js";
import { GeneralHarness } from "../agent/harnesses/general-harness.js";
import { CodingHarness } from "../agent/harnesses/coding-harness.js";
import { OrchestratorHarness } from "../agent/harnesses/orchestrator-harness.js";
import type { BaseHarness } from "../agent/harnesses/base-harness.js";
import type { HarnessContext } from "../agent/harness-types.js";
import { planGoal, replanAfterFailure, type PlannerContext, type PlannerOutput } from "../orchestration/planner.js";
import { buildPlannerContext } from "../orchestration/planner-context.js";
import { Orchestrator } from "../orchestration/orchestrator.js";
import { SimpleAgentTracker } from "../orchestration/simple-tracker.js";
import { ColonyMessaging, LocalDBTransport } from "../orchestration/messaging.js";
import { createTestDb, createTestIdentity, createTestConfig, MockConwayClient } from "./mocks.js";
import type { AutomatonDatabase, PublicServiceConfig } from "../types.js";

const PUBLIC: PublicServiceConfig = { publicUrl: "https://agent-test.ngrok-free.app", servicePort: 8787 };
const STANDALONE = { providerMode: "standalone" } as const;
const STANDALONE_PUBLIC = { providerMode: "standalone", publicService: PUBLIC } as const;

const VALID_PLAN: PlannerOutput = {
  analysis: "Feasible.",
  strategy: "One local task.",
  customRoles: [],
  tasks: [{
    title: "Build the paid service",
    description: "Build it under ~/work on the public port.",
    agentRole: "generalist",
    dependencies: [],
    estimatedCostCents: 10,
    priority: 50,
    timeoutMs: 60_000,
  }],
  risks: [],
  estimatedTotalCostCents: 10,
  estimatedTimeMinutes: 5,
};

const GOAL_INPUT = {
  id: "goal-1",
  title: "Goal",
  description: "Goal description",
  status: "active",
  strategy: null,
  rootTasks: [],
  expectedRevenueCents: 0,
  actualRevenueCents: 0,
  createdAt: new Date().toISOString(),
  deadline: null,
};

function plannerContext(overrides: Partial<PlannerContext> = {}): PlannerContext {
  return {
    creditsCents: 1000,
    usdcBalance: 10,
    survivalTier: "normal",
    availableRoles: ["generalist"],
    customRoles: [],
    activeGoals: [],
    recentOutcomes: [],
    marketIntel: "none",
    idleAgents: 0,
    busyAgents: 0,
    maxAgents: 1,
    workspaceFiles: [],
    ...overrides,
  };
}

// ─── Config ────────────────────────────────────────────────────

describe("publicService config", () => {
  describe("parsePublicServiceConfig", () => {
    it("accepts an https URL and a valid port", () => {
      expect(parsePublicServiceConfig({ publicUrl: "https://x.ngrok-free.app", servicePort: 9000 }))
        .toEqual({ publicUrl: "https://x.ngrok-free.app", servicePort: 9000 });
    });

    it("defaults the port to 8787 and strips the trailing slash", () => {
      expect(DEFAULT_PUBLIC_SERVICE_PORT).toBe(8787);
      expect(parsePublicServiceConfig({ publicUrl: "https://x.ngrok-free.app/" }))
        .toEqual({ publicUrl: "https://x.ngrok-free.app", servicePort: 8787 });
    });

    it("returns undefined when the block is absent", () => {
      expect(parsePublicServiceConfig(undefined)).toBeUndefined();
      expect(parsePublicServiceConfig(null)).toBeUndefined();
    });

    it.each([
      ["http URL", { publicUrl: "http://x.ngrok-free.app" }],
      ["not a URL", { publicUrl: "x.ngrok-free.app" }],
      ["missing URL", { servicePort: 8787 }],
      ["credentials in URL", { publicUrl: "https://user:pass@x.ngrok-free.app" }],
      ["privileged port", { publicUrl: "https://x.ngrok-free.app", servicePort: 80 }],
      ["port too high", { publicUrl: "https://x.ngrok-free.app", servicePort: 70000 }],
      ["non-integer port", { publicUrl: "https://x.ngrok-free.app", servicePort: 8787.5 }],
      ["string port", { publicUrl: "https://x.ngrok-free.app", servicePort: "8787" }],
      ["not an object", "https://x.ngrok-free.app"],
      ["array", [PUBLIC]],
    ])("rejects %s", (_label, raw) => {
      expect(parsePublicServiceConfig(raw)).toBeUndefined();
    });

    it("accepts the port bounds 1024 and 65535", () => {
      expect(parsePublicServiceConfig({ publicUrl: PUBLIC.publicUrl, servicePort: 1024 })?.servicePort).toBe(1024);
      expect(parsePublicServiceConfig({ publicUrl: PUBLIC.publicUrl, servicePort: 65535 })?.servicePort).toBe(65535);
    });
  });

  describe("loadConfig", () => {
    let prevHome: string | undefined;
    let prevMode: string | undefined;

    beforeEach(() => {
      prevHome = process.env.HOME;
      prevMode = process.env.AUTOMATON_PROVIDER_MODE;
      delete process.env.AUTOMATON_PROVIDER_MODE;
    });

    afterEach(() => {
      process.env.HOME = prevHome;
      if (prevMode === undefined) delete process.env.AUTOMATON_PROVIDER_MODE;
      else process.env.AUTOMATON_PROVIDER_MODE = prevMode;
      vi.resetModules();
    });

    async function load(raw: Record<string, unknown>) {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "automaton-home-"));
      fs.mkdirSync(path.join(home, ".automaton"));
      fs.writeFileSync(path.join(home, ".automaton", "automaton.json"), JSON.stringify({ name: "a", ...raw }));
      process.env.HOME = home;
      vi.resetModules();
      const { loadConfig } = await import("../config.js");
      return loadConfig()!;
    }

    it("reads a valid block in standalone mode", async () => {
      const cfg = await load({ providerMode: "standalone", publicService: { publicUrl: PUBLIC.publicUrl } });
      expect(cfg.publicService).toEqual({ publicUrl: PUBLIC.publicUrl, servicePort: 8787 });
      // Guardrails untouched.
      expect(cfg.maxChildren).toBe(0);
      expect(cfg.treasuryPolicy?.x402AllowedDomains).toEqual(["blockrun.ai"]);
    });

    it("has no publicService in standalone mode without the block", async () => {
      const cfg = await load({ providerMode: "standalone" });
      expect(cfg.publicService).toBeUndefined();
    });

    it("ignores an invalid block (stays in no-inbound mode)", async () => {
      const cfg = await load({ providerMode: "standalone", publicService: { publicUrl: "http://x.ngrok-free.app" } });
      expect(cfg.publicService).toBeUndefined();
    });

    it("ignores the block in Conway mode", async () => {
      const cfg = await load({ providerMode: "conway", publicService: PUBLIC });
      expect(cfg.publicService).toBeUndefined();
    });
  });

  it("getPublicService only returns the block in standalone mode", () => {
    expect(getPublicService({ providerMode: "standalone", publicService: PUBLIC })).toEqual(PUBLIC);
    expect(getPublicService({ providerMode: "standalone" })).toBeUndefined();
    expect(getPublicService({ providerMode: "conway", publicService: PUBLIC })).toBeUndefined();
    expect(getPublicService(undefined)).toBeUndefined();
  });
});

// ─── Notices ───────────────────────────────────────────────────

function expectPublicInstructions(text: string): void {
  expect(text).toContain("0.0.0.0:8787");
  expect(text).toContain(PUBLIC.publicUrl);
  expect(text).toContain("ONLY exposed port");
  expect(text).toContain("@x402/express + @x402/evm");
  expect(text).toContain('"exact"');
  expect(text).toContain('"eip155:8453"');
  expect(text).toContain(BASE_USDC_ADDRESS);
  expect(text).toContain(PAYAI_FACILITATOR_URL);
  expect(text).toContain("must NEVER read\n  ~/.automaton or the wallet key");
  expect(text).toContain("BEFORE any inference call or costly work");
  expect(text).toContain("No free route may\n  trigger inference");
  expect(text).toContain("above its estimated BlockRun cost");
  expect(text).toContain("~/work/<service>/server.log 2>&1 &");
  expect(text).toContain("http://127.0.0.1:8787/");
  expect(text).toContain("START IT AGAIN after every restart");
  expect(text).toContain("GET /health");
  expect(text).toContain(`before checking it through ${PUBLIC.publicUrl}`);
  expect(text).toContain("OUTBOUND requests");
  expect(text).toContain("You have no ETH");
  expect(text).not.toContain("NO inbound connectivity");
}

describe("standalone notices", () => {
  it("default notices keep the no-inbound instructions", () => {
    expect(buildStandaloneModeNotice()).toBe(STANDALONE_MODE_NOTICE);
    expect(STANDALONE_MODE_NOTICE).toContain("You have NO inbound connectivity");
    expect(STANDALONE_MODE_NOTICE).not.toContain("PUBLIC SERVICE");
    expect(buildStandalonePlannerNotice()).toBe(STANDALONE_PLANNER_NOTICE);
    expect(STANDALONE_PLANNER_NOTICE).toContain("NEVER produce a task that assumes inbound connectivity");
    expect(buildStandaloneWorkerNotice("/w")).toContain("If the task needs inbound connectivity");
    expect(buildStandaloneEarningGuidance()).toContain("You have NO inbound connectivity");
  });

  it("public notice replaces the no-inbound instructions and uses the wallet address as payTo", () => {
    const notice = buildStandaloneModeNotice(PUBLIC, "0xabc");
    expectPublicInstructions(notice);
    expect(notice).toContain("payTo = your own address 0xabc");
    // The rest of the provider notice is kept.
    expect(notice).toContain("PROVIDER: STANDALONE");
    expect(notice).toContain("confined to ~/work");
    expect(notice).toContain("call sleep with a long");
  });

  it("public earning guidance (loop sleep notes)", () => {
    const guidance = buildStandaloneEarningGuidance(PUBLIC);
    expect(guidance).toContain(`0.0.0.0:8787`);
    expect(guidance).toContain(PUBLIC.publicUrl);
    expect(guidance).toContain("x402 paywall that runs before any inference");
    expect(guidance).toContain("OUTBOUND requests");
    expect(guidance).not.toContain("NO inbound connectivity");
  });

  it("port status", () => {
    expect(buildPublicServiceStatus(PUBLIC, true)).toContain("127.0.0.1:8787 is ANSWERING");
    const down = buildPublicServiceStatus(PUBLIC, false);
    expect(down).toContain("127.0.0.1:8787 is NOT answering");
    expect(down).toContain("start it again now");
  });
});

// ─── Parent prompt ─────────────────────────────────────────────

describe("parent system prompt", () => {
  let db: AutomatonDatabase;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  function prompt(overrides: Record<string, unknown>, publicServiceListening?: boolean): string {
    return buildSystemPrompt({
      identity: createTestIdentity(),
      config: createTestConfig(overrides as any),
      financial: { creditsCents: 500, usdcBalance: 5, lastChecked: new Date().toISOString() },
      state: "running",
      db,
      tools: [],
      isFirstRun: false,
      publicServiceListening,
    });
  }

  it("standalone without publicService: unchanged no-inbound notice, no port status", () => {
    const text = prompt(STANDALONE);
    expect(text).toContain(STANDALONE_MODE_NOTICE);
    expect(text).not.toContain("PUBLIC SERVICE");
  });

  it("standalone with publicService: public instructions, payTo = agent address", () => {
    const text = prompt(STANDALONE_PUBLIC, true);
    expectPublicInstructions(text);
    expect(text).toContain(`payTo = your own address ${createTestIdentity().address}`);
    expect(text).toContain("127.0.0.1:8787 is ANSWERING");
  });

  it("reports a port that does not answer", () => {
    const text = prompt(STANDALONE_PUBLIC, false);
    expect(text).toContain("127.0.0.1:8787 is NOT answering");
  });

  it("Conway mode: no standalone notice even if publicService is present", () => {
    const text = prompt({ publicService: PUBLIC }, true);
    expect(text).not.toContain("PROVIDER: STANDALONE");
    expect(text).not.toContain("PUBLIC SERVICE");
  });
});

// ─── Worker prompt ─────────────────────────────────────────────

describe("worker system prompt", () => {
  let db: AutomatonDatabase;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  function compose(Harness: new () => unknown, overrides: Record<string, unknown>): string {
    const context: HarnessContext = {
      workspaceRoot: "/tmp/ws",
      allowedEditRoot: "/home/node/work",
      workspace: { basePath: "/tmp/ws" } as any,
      identity: createTestIdentity(),
      config: createTestConfig(overrides as any),
      db: db.raw,
      conway: new MockConwayClient(),
      inference: { chat: async () => ({ content: "done" }) },
      budget: { maxTurns: 5, maxCostCents: 50, timeoutMs: 5_000, turnsUsed: 0, costUsedCents: 0, startedAt: 0 },
      wisdom: { conventions: [], successes: [], failures: [], gotchas: [] },
      abortSignal: new AbortController().signal,
      goalId: "goal-1",
    } as HarnessContext;
    const harness = new Harness() as BaseHarness;
    (harness as any).context = context;
    (harness as any).task = { id: "task-1", title: "t", description: "d", agentRole: "generalist" };
    return harness.composeSystemPrompt();
  }

  it("every harness gets the public instructions when publicService is configured", () => {
    for (const Harness of [GeneralHarness, CodingHarness, OrchestratorHarness]) {
      const text = compose(Harness, STANDALONE_PUBLIC);
      expectPublicInstructions(text);
      expect(text).toContain("Your working directory is /home/node/work");
      expect(text).toContain("must listen on 0.0.0.0:8787, live in /home/node/work/<service>");
      expect(text).toContain("Only port 8787 is public");
      expect(text).not.toContain("If the task needs inbound connectivity");
    }
  });

  it("keeps the no-inbound worker rules without publicService", () => {
    const text = compose(GeneralHarness, STANDALONE);
    expect(text).toContain(buildStandaloneWorkerNotice("/home/node/work"));
    expect(text).not.toContain("PUBLIC SERVICE");
  });
});

// ─── Planner / replanner ───────────────────────────────────────

describe("planner and replanner prompts", () => {
  it("public mode: may plan the service on the public port, never another port/domain/ETH", async () => {
    const chat = vi.fn(async () => ({ content: JSON.stringify(VALID_PLAN) }));
    const ctx = plannerContext({ standalone: true, publicService: PUBLIC });
    await planGoal(GOAL_INPUT, ctx, { chat } as any);
    await replanAfterFailure(GOAL_INPUT, { id: "t", title: "t", description: "d", status: "failed" } as any, ctx, { chat } as any);

    expect(chat).toHaveBeenCalledTimes(2);
    for (const [params] of chat.mock.calls as any[]) {
      const system = String(params.messages[0].content);
      expect(system).toContain(buildStandalonePlannerNotice(PUBLIC));
      expect(system).toContain("You MAY plan tasks");
      expect(system).toContain("NEVER produce a task that assumes another exposed port, a domain");
      expect(system).toContain("NEVER produce a task that needs on-chain gas (ETH)");
      expect(system).not.toContain("NEVER produce a task that assumes inbound connectivity");
      expectPublicInstructions(system);
    }
  });

  it("standalone without publicService: unchanged no-inbound planner notice", async () => {
    const chat = vi.fn(async () => ({ content: JSON.stringify(VALID_PLAN) }));
    await planGoal(GOAL_INPUT, plannerContext({ standalone: true }), { chat } as any);
    const [params] = chat.mock.calls[0] as any[];
    expect(params.messages[0].content).toContain(STANDALONE_PLANNER_NOTICE);
    expect(params.messages[0].content).not.toContain("PUBLIC SERVICE");
  });

  describe("context and orchestrator wiring", () => {
    let db: AutomatonDatabase;

    beforeEach(() => {
      db = createTestDb();
    });

    afterEach(() => {
      db.close();
    });

    it("buildPlannerContext carries publicService only in standalone mode", async () => {
      const withIt = await buildPlannerContext({ db: db.raw, standalone: true, publicService: PUBLIC });
      expect(withIt.publicService).toEqual(PUBLIC);
      const conway = await buildPlannerContext({ db: db.raw, publicService: PUBLIC });
      expect(conway.publicService).toBeUndefined();
      expect(conway.standalone).toBeUndefined();
    });

    it("the orchestrator planner call gets the public instructions", async () => {
      db.raw.prepare(
        "INSERT INTO goals (id, title, description, status, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run("goal-1", "Goal", "Goal description", "active", new Date().toISOString());
      db.setKV("orchestrator.state", JSON.stringify({
        phase: "planning", goalId: "goal-1", replanCount: 0, failedTaskId: null, failedError: null,
      }));
      const chat = vi.fn(async () => ({ content: JSON.stringify(VALID_PLAN) }));
      const orchestrator = new Orchestrator({
        db: db.raw,
        agentTracker: new SimpleAgentTracker(db),
        funding: {
          fundChild: vi.fn(async () => ({ success: true })),
          recallCredits: vi.fn(async () => ({ success: true, amountCents: 0 })),
          getBalance: vi.fn(async () => 0),
        } as any,
        messaging: new ColonyMessaging(new LocalDBTransport(db), db),
        inference: { chat } as any,
        identity: createTestIdentity(),
        getFinancialState: () => ({ creditsCents: 1000, usdcBalance: 10 }),
        config: { ...STANDALONE_PUBLIC },
      } as any);

      await orchestrator.tick();

      expect(chat).toHaveBeenCalled();
      const [params] = chat.mock.calls[0] as any[];
      expect(params.messages[0].content).toContain(buildStandalonePlannerNotice(PUBLIC));
    });
  });
});

// ─── Port probe ────────────────────────────────────────────────

describe("probeLocalPort", () => {
  it("is true when a local server listens, false once it is closed", async () => {
    const server = net.createServer((socket) => socket.end());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as net.AddressInfo).port;
    try {
      expect(await probeLocalPort(port, 1_000)).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    expect(await probeLocalPort(port, 1_000)).toBe(false);
  });
});
