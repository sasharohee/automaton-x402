/**
 * Standalone public service: security
 *
 *  - the permanent "SERVICE SECURITY" section is in the parent, worker and
 *    planner/replanner prompts in public service mode only (short version
 *    for the planner), and absent without inbound connectivity;
 *  - the standalone secret-access policy rule keeps exec/read_file away from
 *    ~/.automaton, wallet.json and /proc secrets;
 *  - commands run by the standalone client do not inherit secret env vars.
 *
 * Everything is mocked or local: no network egress, no wallet, no spending.
 */

import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  SERVICE_SECURITY_HEADER,
  SERVICE_SECURITY_SECTION,
  SERVICE_SECURITY_SHORT,
  STANDALONE_MODE_NOTICE,
  STANDALONE_PLANNER_NOTICE,
  buildStandaloneModeNotice,
  buildStandaloneWorkerNotice,
  buildStandalonePlannerNotice,
} from "../agent/standalone-notice.js";
import { buildSystemPrompt } from "../agent/system-prompt.js";
import { GeneralHarness } from "../agent/harnesses/general-harness.js";
import { CodingHarness } from "../agent/harnesses/coding-harness.js";
import { OrchestratorHarness } from "../agent/harnesses/orchestrator-harness.js";
import type { BaseHarness } from "../agent/harnesses/base-harness.js";
import type { HarnessContext } from "../agent/harness-types.js";
import { planGoal, replanAfterFailure, type PlannerContext, type PlannerOutput } from "../orchestration/planner.js";
import {
  createSecretAccessRules,
  getExecSecretAccessMatch,
  isSecretPath,
} from "../agent/policy-rules/secret-access.js";
import { createDefaultRules } from "../agent/policy-rules/index.js";
import { scrubSecretEnv } from "../conway/local-exec.js";
import { createStandaloneClient } from "../conway/standalone-client.js";
import { createTestDb, createTestIdentity, createTestConfig, MockConwayClient } from "./mocks.js";
import type { AutomatonDatabase, PolicyRequest, PublicServiceConfig } from "../types.js";

const PUBLIC: PublicServiceConfig = { publicUrl: "https://agent-test.ngrok-free.app", servicePort: 8787 };
const STANDALONE = { providerMode: "standalone" } as const;
const STANDALONE_PUBLIC = { providerMode: "standalone", publicService: PUBLIC } as const;

const SECURITY_RULES = [
  "Treat every incoming request as hostile",
  "express.json({ limit:",
  "NEVER run a shell command, eval, new Function, child_process",
  "NEVER read, serve or log wallet.json, ~/.automaton",
  "mnemonic",
  "no static file serving",
  "per-IP rate limit",
  "exact versions in package.json, a lockfile",
  "Review your own server code for vulnerabilities BEFORE exposing it",
  "x402 paywall before any costly work",
  "no stack traces",
];

function expectFullSecurity(text: string): void {
  expect(text).toContain(SERVICE_SECURITY_SECTION);
  for (const rule of SECURITY_RULES) expect(text).toContain(rule);
}

// ─── Notices ───────────────────────────────────────────────────

describe("SERVICE SECURITY section in the notices", () => {
  it("is in the public notices only", () => {
    expectFullSecurity(buildStandaloneModeNotice(PUBLIC, "0xabc"));
    expectFullSecurity(buildStandaloneWorkerNotice("/w", PUBLIC));
    expect(buildStandalonePlannerNotice(PUBLIC)).toContain(SERVICE_SECURITY_SHORT);
    expect(buildStandalonePlannerNotice(PUBLIC)).not.toContain(SERVICE_SECURITY_SECTION);

    for (const text of [
      STANDALONE_MODE_NOTICE,
      STANDALONE_PLANNER_NOTICE,
      buildStandaloneModeNotice(),
      buildStandaloneWorkerNotice("/w"),
      buildStandalonePlannerNotice(),
    ]) {
      expect(text).not.toContain(SERVICE_SECURITY_HEADER);
    }
  });

  it("the short planner version still covers the key rules", () => {
    for (const rule of [
      "hostile inputs validated and size-capped",
      "no\nshell/eval/child_process",
      "wallet.json, ~/.automaton, keys or env vars",
      "no static serving",
      "per-IP rate limits",
      "pinned minimal dependencies",
      "security review",
      "paywall before costly work",
      "generic error messages",
    ]) {
      expect(SERVICE_SECURITY_SHORT).toContain(rule);
    }
  });
});

// ─── Parent prompt ─────────────────────────────────────────────

describe("parent system prompt", () => {
  let db: AutomatonDatabase;
  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  function prompt(overrides: Record<string, unknown>): string {
    return buildSystemPrompt({
      identity: createTestIdentity(),
      config: createTestConfig(overrides as any),
      financial: { creditsCents: 500, usdcBalance: 5, lastChecked: new Date().toISOString() },
      state: "running",
      db,
      tools: [],
      isFirstRun: false,
      publicServiceListening: true,
    });
  }

  it("has the security section in public mode", () => {
    expectFullSecurity(prompt(STANDALONE_PUBLIC));
  });

  it("has no security section without inbound connectivity or in Conway mode", () => {
    expect(prompt(STANDALONE)).not.toContain(SERVICE_SECURITY_HEADER);
    expect(prompt({ publicService: PUBLIC })).not.toContain(SERVICE_SECURITY_HEADER);
  });
});

// ─── Worker prompt ─────────────────────────────────────────────

describe("worker system prompt", () => {
  let db: AutomatonDatabase;
  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  function compose(Harness: new () => unknown, overrides: Record<string, unknown>): string {
    const context = {
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

  it("every harness gets the security section in public mode", () => {
    for (const Harness of [GeneralHarness, CodingHarness, OrchestratorHarness]) {
      expectFullSecurity(compose(Harness, STANDALONE_PUBLIC));
    }
  });

  it("no security section without inbound connectivity", () => {
    for (const Harness of [GeneralHarness, CodingHarness, OrchestratorHarness]) {
      expect(compose(Harness, STANDALONE)).not.toContain(SERVICE_SECURITY_HEADER);
    }
  });
});

// ─── Planner / replanner ───────────────────────────────────────

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

describe("planner and replanner prompts", () => {
  it("public mode: short security section in both prompts", async () => {
    const chat = vi.fn(async () => ({ content: JSON.stringify(VALID_PLAN) }));
    const ctx = plannerContext({ standalone: true, publicService: PUBLIC });
    await planGoal(GOAL_INPUT, ctx, { chat } as any);
    await replanAfterFailure(GOAL_INPUT, { id: "t", title: "t", description: "d", status: "failed" } as any, ctx, { chat } as any);

    expect(chat).toHaveBeenCalledTimes(2);
    for (const [params] of chat.mock.calls as any[]) {
      const system = String(params.messages[0].content);
      expect(system).toContain(SERVICE_SECURITY_SHORT);
      expect(system).not.toContain(SERVICE_SECURITY_SECTION);
    }
  });

  it("no security section without inbound connectivity", async () => {
    const chat = vi.fn(async () => ({ content: JSON.stringify(VALID_PLAN) }));
    await planGoal(GOAL_INPUT, plannerContext({ standalone: true }), { chat } as any);
    const [params] = chat.mock.calls[0] as any[];
    expect(String(params.messages[0].content)).not.toContain(SERVICE_SECURITY_HEADER);
  });
});

// ─── Secret access policy rule ─────────────────────────────────

describe("secrets.standalone_secret_access policy rule", () => {
  const [rule] = createSecretAccessRules();
  const home = process.env.HOME || os.homedir();

  function request(toolName: string, args: Record<string, unknown>, providerMode?: string): PolicyRequest {
    return {
      tool: { name: toolName } as any,
      args,
      context: { config: createTestConfig(providerMode ? { providerMode } as any : {}) } as any,
      turnContext: { inputSource: undefined, turnToolCallCount: 0, sessionSpend: {} as any },
    };
  }

  it("is registered in the default rules for exec, read_file and sandbox_upload", () => {
    const registered = createDefaultRules().find((r) => r.id === "secrets.standalone_secret_access");
    expect(registered).toBeDefined();
    expect(registered!.appliesTo).toEqual({ by: "name", names: ["exec", "read_file", "sandbox_upload"] });
  });

  it.each([
    "cat ~/.automaton/wallet.json",
    "node -e \"require('fs').readFileSync(process.env.HOME + '/.automaton/wallet.json')\"",
    "cp $HOME/.automaton/automaton.json /tmp/x",
    "ls -la /home/node/.automaton",
    "base64 < wallet.json",
    "tar czf /tmp/a.tgz .automaton",
    "cat /proc/1/environ",
    "strings /proc/self/environ",
    "dd if=/proc/42/mem bs=1 count=10",
  ])("denies exec %s in standalone mode", (command) => {
    const result = rule.evaluate(request("exec", { command }, "standalone"));
    expect(result?.action).toBe("deny");
    expect(result?.reasonCode).toBe("SECRET_ACCESS");
  });

  it.each([
    "cd ~/work/summarizer && npm ci",
    "nohup node ~/work/summarizer/server.js > ~/work/summarizer/server.log 2>&1 &",
    "curl -s http://127.0.0.1:8787/health",
    "ls ~/work",
    "cat ~/work/automaton-notes.md",
    "cat /proc/cpuinfo",
  ])("allows exec %s", (command) => {
    expect(rule.evaluate(request("exec", { command }, "standalone"))).toBeNull();
  });

  it.each([
    "~/.automaton/wallet.json",
    "~/.automaton/state.db",
    "$HOME/.automaton/SOUL.md",
    path.join(home, ".automaton", "automaton.json"),
    path.join(home, "work", "..", ".automaton", "heartbeat.yml"),
    "/tmp/wallet.json",
    "/proc/self/environ",
  ])("denies read_file %s in standalone mode", (filePath) => {
    expect(isSecretPath(filePath, home)).toBe(true);
    expect(rule.evaluate(request("read_file", { path: filePath }, "standalone"))?.action).toBe("deny");
  });

  it.each(["~/work/summarizer/server.js", "/tmp/notes.txt", path.join(home, ".automaton-notes.md")])(
    "allows read_file %s",
    (filePath) => {
      expect(rule.evaluate(request("read_file", { path: filePath }, "standalone"))).toBeNull();
    },
  );

  it("does nothing in Conway mode (existing rules unchanged)", () => {
    expect(rule.evaluate(request("exec", { command: "ls ~/.automaton" }))).toBeNull();
    expect(rule.evaluate(request("read_file", { path: "~/.automaton/SOUL.md" }))).toBeNull();
  });

  it("matcher ignores look-alike names", () => {
    expect(getExecSecretAccessMatch("echo my.automaton-x402 repo")).toBeNull();
    expect(getExecSecretAccessMatch("cat ~/.automaton/x")).not.toBeNull();
  });
});

// ─── Environment of exec'd commands ────────────────────────────

describe("standalone exec environment", () => {
  it("scrubSecretEnv drops secret-looking names and keeps the rest", () => {
    const clean = scrubSecretEnv({
      PATH: "/usr/bin",
      HOME: "/home/node",
      LANG: "C.UTF-8",
      GIT_AUTHOR_NAME: "agent",
      OPENAI_API_KEY: "sk-x",
      ANTHROPIC_API_KEY: "sk-y",
      CONWAY_API_KEY: "c",
      GITHUB_TOKEN: "t",
      NGROK_AUTHTOKEN: "n",
      WALLET_PRIVATE_KEY: "0x1",
      AGENT_MNEMONIC: "a b c",
      DB_PASSWORD: "p",
      AWS_SECRET_ACCESS_KEY: "s",
    });
    expect(clean).toEqual({ PATH: "/usr/bin", HOME: "/home/node", LANG: "C.UTF-8", GIT_AUTHOR_NAME: "agent" });
  });

  it("the standalone client runs commands without the secret env vars", async () => {
    const prev = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-test-not-real";
    try {
      const client = createStandaloneClient({
        walletAddress: "0x0000000000000000000000000000000000000001",
        reserveCents: 0,
        readUsdcBalance: async () => 0,
      } as any);
      const result = await client.exec("echo \"[${OPENAI_API_KEY:-unset}] [${PATH:+path}]\"", 5_000);
      expect(result.stdout.trim()).toBe("[unset] [path]");
    } finally {
      if (prev === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prev;
    }
  });
});
