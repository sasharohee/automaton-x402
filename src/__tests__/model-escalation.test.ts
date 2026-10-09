/**
 * Difficulty-based model routing
 *
 *  - blockrun.escalation config defaults and validation
 *  - the coding heuristic (source-file writes, failing build/test commands)
 *  - the hourly limit, persisted in the DB, with UTC hour rollover
 *  - tier restrictions (high/normal only)
 *  - think_hard escalates exactly one turn
 *  - fallback to the tier model when an escalated call fails unpaid
 *  - planner escalation
 *
 * Everything is mocked: no network, no wallet, no spending.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// No RPC call for the on-chain USDC balance.
vi.mock("../conway/x402.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../conway/x402.js")>();
  return { ...actual, getUsdcBalance: vi.fn(async () => 12.5) };
});

import { runAgentLoop } from "../agent/loop.js";
import { createBuiltinTools } from "../agent/tools.js";
import {
  isCodingTurn,
  isSourceFilePath,
  parseExitCode,
} from "../agent/coding-heuristic.js";
import {
  ModelEscalation,
  createEscalatingPlannerInference,
  escalationReason,
  nextUtcHour,
  resolveModelEscalation,
  routeWithEscalation,
  utcHourKey,
} from "../inference/model-escalation.js";
import { registerMappedModels } from "../inference/model-map.js";
import { ModelRegistry } from "../inference/registry.js";
import { resolveBlockRunConfig } from "../conway/provider.js";
import { createConfig } from "../config.js";
import { DEFAULT_BLOCKRUN_CONFIG, DEFAULT_MODEL_ESCALATION } from "../types.js";
import type {
  AutomatonDatabase,
  ExecResult,
  InferenceResult,
  SurvivalTier,
  ToolContext,
} from "../types.js";
import {
  MockConwayClient,
  MockInferenceClient,
  createTestConfig,
  createTestDb,
  createTestIdentity,
  noToolResponse,
  toolCallResponse,
} from "./mocks.js";

const PRO = "deepseek/deepseek-v4-pro";
const CHAT = "deepseek-chat";

function result(overrides: Partial<InferenceResult> = {}): InferenceResult {
  return {
    content: "ok",
    model: PRO,
    provider: "blockrun",
    inputTokens: 10,
    outputTokens: 10,
    costCents: 4.3,
    latencyMs: 5,
    finishReason: "stop",
    ...overrides,
  };
}

class Clock {
  constructor(public current: Date) {}
  now = (): Date => this.current;
}

// ─── Config ────────────────────────────────────────────────────

describe("blockrun.escalation config", () => {
  it("defaults to deepseek-v4-pro, 6 calls per hour", () => {
    expect(DEFAULT_MODEL_ESCALATION).toEqual({ model: PRO, maxCallsPerHour: 6 });
    expect(DEFAULT_BLOCKRUN_CONFIG.escalation).toEqual(DEFAULT_MODEL_ESCALATION);
    expect(resolveModelEscalation(undefined)).toEqual(DEFAULT_MODEL_ESCALATION);
  });

  it("configs without escalation keep working and get the default", () => {
    const resolved = resolveBlockRunConfig({
      blockrun: { apiUrl: "https://blockrun.ai/api", models: { normal: CHAT, lowCompute: CHAT, critical: CHAT } },
    });
    expect(resolved.models.normal).toBe(CHAT);
    expect(resolved.escalation).toEqual(DEFAULT_MODEL_ESCALATION);
    expect(resolveBlockRunConfig({}).escalation).toEqual(DEFAULT_MODEL_ESCALATION);
  });

  it("partial and invalid values fall back to the defaults", () => {
    expect(resolveModelEscalation({ maxCallsPerHour: 2 })).toEqual({ model: PRO, maxCallsPerHour: 2 });
    expect(resolveModelEscalation({ model: "  other/model " })).toEqual({ model: "other/model", maxCallsPerHour: 6 });
    expect(resolveModelEscalation({ model: "", maxCallsPerHour: -1 })).toEqual(DEFAULT_MODEL_ESCALATION);
    expect(resolveModelEscalation({ maxCallsPerHour: Number.NaN })).toEqual(DEFAULT_MODEL_ESCALATION);
    expect(resolveModelEscalation({ maxCallsPerHour: 3.7 }).maxCallsPerHour).toBe(3);
    expect(resolveModelEscalation({ maxCallsPerHour: 0 }).maxCallsPerHour).toBe(0);
  });

  it("standalone createConfig includes the default escalation block", () => {
    const config = createConfig({
      name: "a",
      genesisPrompt: "g",
      creatorAddress: "0x0000000000000000000000000000000000000001" as any,
      registeredWithConway: false,
      sandboxId: "",
      walletAddress: "0x0000000000000000000000000000000000000002" as any,
      apiKey: "",
      providerMode: "standalone",
    } as any);
    expect(config.blockrun?.escalation).toEqual(DEFAULT_MODEL_ESCALATION);
  });

  it("the escalation model is registered in the model registry", () => {
    const db = createTestDb();
    try {
      const registry = new ModelRegistry(db.raw);
      registry.initialize();
      registerMappedModels(registry, { normal: CHAT, lowCompute: CHAT, critical: CHAT }, "blockrun", PRO);
      const entry = registry.get(PRO);
      expect(entry).toBeDefined();
      expect(entry!.enabled).toBe(true);
      expect(entry!.provider).toBe("blockrun");
      expect(entry!.tierMinimum).toBe("normal");
      expect(registry.get(CHAT)?.tierMinimum).toBe("critical");
    } finally {
      db.close();
    }
  });
});

// ─── Coding heuristic ──────────────────────────────────────────

describe("coding heuristic", () => {
  const write = (path: string, error?: string) => ({
    name: "write_file",
    arguments: { path, content: "x" },
    result: error ? "" : "File written",
    error,
  });
  const exec = (command: string, exitCode: number) => ({
    name: "exec",
    arguments: { command },
    result: `exit_code: ${exitCode}\nstdout: \nstderr: `,
  });

  it("writing or editing a source file is coding", () => {
    for (const p of ["src/a.ts", "x.js", "x.mjs", "x.cjs", "s.py", "run.sh", "package.json", "q.sql", "~/work/api/server.tsx"]) {
      expect(isCodingTurn([write(p)]), p).toBe(true);
    }
    expect(
      isCodingTurn([{ name: "edit_own_file", arguments: { path: "src/agent/x.ts", content: "", description: "" }, result: "ok" }]),
    ).toBe(true);
  });

  it("notes, markdown and plain text are not coding", () => {
    for (const p of ["notes.md", "README.MD", "log.txt", "SOUL.md", "noext", ""]) {
      expect(isCodingTurn([write(p)]), p).toBe(false);
    }
    expect(isSourceFilePath(undefined)).toBe(false);
  });

  it("a failed write is not coding", () => {
    expect(isCodingTurn([write("src/a.ts", "Blocked: outside workspace")])).toBe(false);
  });

  it("a build/test/run command that exited non-zero is coding (debugging)", () => {
    for (const cmd of ["npm test", "cd ~/work/api && npm run build", "npx tsc --noEmit", "node server.js", "python3 main.py", "pnpm vitest run", "tsc"]) {
      expect(isCodingTurn([exec(cmd, 1)]), cmd).toBe(true);
    }
  });

  it("successful builds, and failing non-build commands, are not coding", () => {
    expect(isCodingTurn([exec("npm test", 0)])).toBe(false);
    expect(isCodingTurn([exec("ls /nope", 2)])).toBe(false);
    expect(isCodingTurn([exec("cat nodes.txt", 1)])).toBe(false);
    expect(isCodingTurn([{ name: "exec", arguments: { command: "npm test" }, result: "", error: "denied" }])).toBe(false);
  });

  it("other tools are not coding", () => {
    expect(isCodingTurn([{ name: "check_usdc_balance", arguments: {}, result: "12.5" }])).toBe(false);
    expect(isCodingTurn([])).toBe(false);
  });

  it("parses exit codes", () => {
    expect(parseExitCode("exit_code: 0\nstdout: x")).toBe(0);
    expect(parseExitCode("exit_code: 127")).toBe(127);
    expect(parseExitCode("no code")).toBeUndefined();
  });
});

// ─── Hourly limit, persistence, tiers ──────────────────────────

describe("ModelEscalation", () => {
  let db: AutomatonDatabase;
  let clock: Clock;
  let logs: string[];

  beforeEach(() => {
    db = createTestDb();
    clock = new Clock(new Date("2026-10-08T20:10:00Z"));
    logs = [];
  });

  afterEach(() => db.close());

  const make = (max = 6) =>
    new ModelEscalation(db.raw, { model: PRO, maxCallsPerHour: max }, (m) => logs.push(m), clock.now);

  it("escalation reasons: think_hard, then planning, then coding", () => {
    expect(escalationReason({})).toBeNull();
    expect(escalationReason({ coding: true })).toBe("coding");
    expect(escalationReason({ planning: true, coding: true })).toBe("planning");
    expect(escalationReason({ thinkHardReason: "proof", planning: true })).toBe("think_hard: proof");
  });

  it("only escalates in tiers high and normal", () => {
    const esc = make();
    expect(esc.begin("high", "coding")).not.toBeNull();
    expect(esc.begin("normal", "coding")).not.toBeNull();
    for (const tier of ["low_compute", "critical", "dead"] as SurvivalTier[]) {
      expect(esc.begin(tier, "coding"), tier).toBeNull();
    }
    expect(esc.usage().used).toBe(2);
  });

  it("no reason means no escalation", () => {
    expect(make().begin("high", null)).toBeNull();
  });

  it("logs one line per escalated call with the hourly count", () => {
    const esc = make();
    esc.begin("high", "coding");
    esc.begin("high", "think_hard: tricky bug");
    expect(logs).toEqual([
      `[MODEL] escalated to ${PRO} (reason: coding) 1/6 this hour`,
      `[MODEL] escalated to ${PRO} (reason: think_hard: tricky bug) 2/6 this hour`,
    ]);
  });

  it("stops at maxCallsPerHour and logs the limit once", () => {
    const esc = make(6);
    for (let i = 0; i < 6; i++) expect(esc.begin("high", "coding")).not.toBeNull();
    expect(esc.begin("high", "coding")).toBeNull();
    expect(esc.begin("high", "planning")).toBeNull();
    const limitLogs = logs.filter((l) => l.includes("limit reached"));
    expect(limitLogs).toEqual([
      "[MODEL] Escalation limit reached (6/6 this hour); using the tier model until 21:00Z.",
    ]);
  });

  it("the count is persisted: a restart does not reset it", () => {
    const first = make(3);
    first.begin("high", "coding");
    first.begin("high", "coding");
    const afterRestart = make(3);
    expect(afterRestart.usage().used).toBe(2);
    expect(afterRestart.begin("high", "coding")).not.toBeNull();
    expect(make(3).begin("high", "coding")).toBeNull();
  });

  it("rolls over at the next UTC clock hour", () => {
    const esc = make(2);
    esc.begin("high", "coding");
    esc.begin("high", "coding");
    expect(esc.begin("high", "coding")).toBeNull();

    clock.current = new Date("2026-10-08T20:59:59Z");
    expect(esc.begin("high", "coding")).toBeNull();

    clock.current = new Date("2026-10-08T21:00:00Z");
    expect(esc.usage()).toEqual({ hour: "2026-10-08T21", used: 0, limitLogged: false });
    expect(esc.begin("high", "coding")).not.toBeNull();
    expect(logs.at(-1)).toBe(`[MODEL] escalated to ${PRO} (reason: coding) 1/2 this hour`);
  });

  it("release gives a slot back within the same hour only", () => {
    const esc = make(2);
    const ticket = esc.begin("high", "coding")!;
    esc.release(ticket);
    expect(esc.usage().used).toBe(0);

    const stale = esc.begin("high", "coding")!;
    clock.current = new Date("2026-10-08T21:05:00Z");
    esc.begin("high", "coding");
    esc.release(stale);
    expect(esc.usage().used).toBe(1);
  });

  it("maxCallsPerHour 0 disables escalation", () => {
    expect(make(0).begin("high", "coding")).toBeNull();
  });

  it("hour helpers use UTC clock hours", () => {
    expect(utcHourKey(new Date("2026-10-08T23:59:59Z"))).toBe("2026-10-08T23");
    expect(nextUtcHour(new Date("2026-10-08T23:59:59Z")).toISOString()).toBe("2026-10-09T00:00:00.000Z");
  });

  describe("think_hard", () => {
    it("is consumed by a single turn", () => {
      const esc = make();
      const res = esc.requestThinkHard("  subtle race condition  ");
      expect(res.ok).toBe(true);
      expect(res.message).toContain(PRO);
      expect(esc.takeThinkHard()).toBe("subtle race condition");
      expect(esc.takeThinkHard()).toBeUndefined();
    });

    it("is refused over the hourly limit, until the next hour", () => {
      const esc = make(1);
      esc.begin("high", "coding");
      const res = esc.requestThinkHard("hard");
      expect(res.ok).toBe(false);
      expect(res.message).toContain("refused");
      expect(res.message).toContain("21:00Z");
      expect(esc.takeThinkHard()).toBeUndefined();
    });

    it("a think_hard request in a low tier is ignored and logged", () => {
      const esc = make();
      esc.requestThinkHard("hard");
      const reason = esc.takeThinkHard();
      expect(esc.begin("low_compute", escalationReason({ thinkHardReason: reason }))).toBeNull();
      expect(logs.at(-1)).toContain("think_hard ignored in tier low_compute");
    });
  });
});

// ─── think_hard tool ───────────────────────────────────────────

describe("think_hard tool", () => {
  let db: AutomatonDatabase;
  beforeEach(() => {
    db = createTestDb();
  });
  afterEach(() => db.close());

  const tool = () => createBuiltinTools("sandbox").find((t) => t.name === "think_hard")!;
  const ctx = (providerMode: "standalone" | "conway"): ToolContext => ({
    identity: createTestIdentity(),
    config: createTestConfig({ providerMode }),
    db,
    conway: new MockConwayClient(),
    inference: new MockInferenceClient(),
  });

  it("requires a reason and is described as reserved for hard reasoning", () => {
    const t = tool();
    expect(t.parameters.required).toEqual(["reason"]);
    expect(t.description).toMatch(/hard reasoning/i);
    expect(t.description).toMatch(/NEXT turn only/);
  });

  it("standalone: flags the next turn", async () => {
    const out = await tool().execute({ reason: "tricky bug" }, ctx("standalone"));
    expect(out).toContain("next inference turn");
    expect(db.getKV("model_escalation.think_hard")).toBe("tricky bug");
  });

  it("standalone: refused once the hourly limit is reached", async () => {
    const esc = new ModelEscalation(db.raw, DEFAULT_MODEL_ESCALATION);
    for (let i = 0; i < 6; i++) esc.begin("high", "coding");
    const out = await tool().execute({ reason: "tricky bug" }, ctx("standalone"));
    expect(out).toMatch(/refused/);
    expect(out).toMatch(/until \d\d:00Z/);
    expect(db.getKV("model_escalation.think_hard")).toBeUndefined();
  });

  it("Conway mode: not available", async () => {
    const out = await tool().execute({ reason: "x" }, ctx("conway"));
    expect(out).toMatch(/not available/);
  });
});

// ─── Fallback ──────────────────────────────────────────────────

describe("routeWithEscalation fallback", () => {
  let db: AutomatonDatabase;
  let esc: ModelEscalation;
  let logs: string[];

  beforeEach(() => {
    db = createTestDb();
    logs = [];
    esc = new ModelEscalation(db.raw, { model: PRO, maxCallsPerHour: 6 }, (m) => logs.push(m));
  });
  afterEach(() => db.close());

  it("no ticket: runs the tier model", async () => {
    const run = vi.fn(async () => result({ model: CHAT }));
    await routeWithEscalation({ escalation: esc, ticket: null, run });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(undefined);
  });

  it("success: uses the escalation model and keeps the slot", async () => {
    const ticket = esc.begin("high", "coding");
    const run = vi.fn(async (model?: string) => result({ model: model ?? CHAT }));
    const out = await routeWithEscalation({ escalation: esc, ticket, run });
    expect(out.model).toBe(PRO);
    expect(run).toHaveBeenCalledTimes(1);
    expect(esc.usage().used).toBe(1);
  });

  it("an unpaid error falls back to the tier model and gives the slot back", async () => {
    const ticket = esc.begin("high", "coding");
    const run = vi.fn(async (model?: string) => {
      if (model === PRO) throw new Error("upstream 502");
      return result({ model: CHAT, costCents: 1 });
    });
    const out = await routeWithEscalation({ escalation: esc, ticket, run, log: (m) => logs.push(m) });
    expect(out.model).toBe(CHAT);
    expect(run.mock.calls).toEqual([[PRO], [undefined]]);
    expect(esc.usage().used).toBe(0);
    expect(logs.at(-1)).toContain("falling back to the tier model");
  });

  it("an unpaid timeout falls back to the tier model", async () => {
    const ticket = esc.begin("high", "coding");
    const run = vi.fn(async (model?: string) =>
      model === PRO
        ? result({ model: PRO, finishReason: "timeout", costCents: 0, content: "Inference timeout" })
        : result({ model: CHAT }),
    );
    const out = await routeWithEscalation({ escalation: esc, ticket, run });
    expect(out.model).toBe(CHAT);
    expect(esc.usage().used).toBe(0);
  });

  it("a paid-but-timed-out call still counts and is not retried", async () => {
    const ticket = esc.begin("high", "coding");
    const run = vi.fn(async () => result({ model: PRO, finishReason: "timeout", costCents: 4.31 }));
    const out = await routeWithEscalation({ escalation: esc, ticket, run });
    expect(out.costCents).toBe(4.31);
    expect(run).toHaveBeenCalledTimes(1);
    expect(esc.usage().used).toBe(1);
  });

  it("a spend-cap refusal on both models is rethrown after one tier-model retry", async () => {
    const ticket = esc.begin("high", "coding");
    const err = Object.assign(new Error("Hourly spend cap exceeded"), {
      code: "GUARD_REFUSED",
      limit: { limitType: "hourly", category: "inference", currentCents: 83, amountCents: 5, limitCents: 84 },
    });
    const run = vi.fn(async () => {
      throw err;
    });
    await expect(routeWithEscalation({ escalation: esc, ticket, run })).rejects.toBe(err);
    expect(run.mock.calls).toEqual([[PRO], [undefined]]);
    expect(esc.usage().used).toBe(0);
  });

  it("an unregistered escalation model gives the slot back", async () => {
    const ticket = esc.begin("high", "coding");
    const run = vi.fn(async () => result({ model: CHAT }));
    await routeWithEscalation({ escalation: esc, ticket, run });
    expect(esc.usage().used).toBe(0);
  });
});

// ─── Planner escalation ────────────────────────────────────────

describe("planner escalation", () => {
  let db: AutomatonDatabase;
  beforeEach(() => {
    db = createTestDb();
  });
  afterEach(() => db.close());

  const unified = (fail = false) => ({
    chat: vi.fn(async (p: any) => ({ content: `chat:${p.tier}` }) as any),
    chatDirect: vi.fn(async (p: any) => {
      if (fail) throw new Error("boom");
      return { content: `direct:${p.modelId}` } as any;
    }),
  });

  it("planner calls (tier reasoning) use the escalation model in high/normal tiers", async () => {
    const inner = unified();
    const esc = new ModelEscalation(db.raw, { model: PRO, maxCallsPerHour: 6 });
    const planner = createEscalatingPlannerInference({ inner, escalation: esc, providerId: "blockrun", getTier: () => "normal" });
    const out = await planner.chat({ tier: "reasoning", messages: [] });
    expect(out.content).toBe(`direct:${PRO}`);
    expect(inner.chatDirect.mock.calls[0][0]).toMatchObject({ providerId: "blockrun", modelId: PRO });
    expect(esc.usage().used).toBe(1);
  });

  it("other tiers (classifier, JSON retry) are not escalated", async () => {
    const inner = unified();
    const esc = new ModelEscalation(db.raw, { model: PRO, maxCallsPerHour: 6 });
    const planner = createEscalatingPlannerInference({ inner, escalation: esc, providerId: "blockrun", getTier: () => "high" });
    expect((await planner.chat({ tier: "fast", messages: [] })).content).toBe("chat:fast");
    expect((await planner.chat({ tier: "cheap", messages: [] })).content).toBe("chat:cheap");
    expect(inner.chatDirect).not.toHaveBeenCalled();
  });

  it("not escalated in low tiers, with an unknown tier, or over the limit", async () => {
    const inner = unified();
    const esc = new ModelEscalation(db.raw, { model: PRO, maxCallsPerHour: 1 });
    let tier: SurvivalTier | undefined = "low_compute";
    const planner = createEscalatingPlannerInference({ inner, escalation: esc, providerId: "blockrun", getTier: () => tier });
    expect((await planner.chat({ tier: "reasoning", messages: [] })).content).toBe("chat:reasoning");
    tier = undefined;
    expect((await planner.chat({ tier: "reasoning", messages: [] })).content).toBe("chat:reasoning");
    tier = "high";
    expect((await planner.chat({ tier: "reasoning", messages: [] })).content).toBe(`direct:${PRO}`);
    expect((await planner.chat({ tier: "reasoning", messages: [] })).content).toBe("chat:reasoning");
  });

  it("a failed escalated planner call falls back to the tier model", async () => {
    const inner = unified(true);
    const esc = new ModelEscalation(db.raw, { model: PRO, maxCallsPerHour: 6 });
    const planner = createEscalatingPlannerInference({ inner, escalation: esc, providerId: "blockrun", getTier: () => "high" });
    expect((await planner.chat({ tier: "reasoning", messages: [] })).content).toBe("chat:reasoning");
    expect(esc.usage().used).toBe(0);
  });
});

// ─── Agent loop ────────────────────────────────────────────────

class FailingBuildConway extends MockConwayClient {
  async exec(command: string, timeout?: number): Promise<ExecResult> {
    await super.exec(command, timeout);
    return command.includes("npm test")
      ? { stdout: "", stderr: "1 failing", exitCode: 1 }
      : { stdout: "ok", stderr: "", exitCode: 0 };
  }
}

describe("agent loop routing", () => {
  let db: AutomatonDatabase;
  let conway: FailingBuildConway;

  beforeEach(() => {
    db = createTestDb();
    conway = new FailingBuildConway();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
  });

  const standaloneConfig = (maxCallsPerHour = 6) =>
    createTestConfig({
      providerMode: "standalone",
      blockrun: {
        apiUrl: "https://blockrun.ai/api",
        models: { high: CHAT, normal: CHAT, lowCompute: CHAT, critical: CHAT },
        escalation: { model: PRO, maxCallsPerHour },
      },
    });

  const run = (inference: MockInferenceClient, config = standaloneConfig()) =>
    runAgentLoop({ identity: createTestIdentity(), config, db, conway, inference });

  const models = (inference: MockInferenceClient) => inference.calls.map((c) => c.options?.model);

  it("routine turns stay on the tier model", async () => {
    const inference = new MockInferenceClient([
      toolCallResponse([{ name: "exec", arguments: { command: "echo hi" } }]),
      noToolResponse("done"),
    ]);
    await run(inference);
    expect(models(inference)).toEqual([CHAT, CHAT]);
  });

  it("think_hard escalates exactly the next turn, then reverts", async () => {
    const inference = new MockInferenceClient([
      toolCallResponse([{ name: "think_hard", arguments: { reason: "subtle bug" } }]),
      toolCallResponse([{ name: "exec", arguments: { command: "echo hi" } }]),
      noToolResponse("done"),
    ]);
    await run(inference);
    expect(models(inference)).toEqual([CHAT, PRO, CHAT]);
    expect(db.getKV("model_escalation.think_hard")).toBeUndefined();
  });

  it("a failing build/test escalates the next turn (coding)", async () => {
    const inference = new MockInferenceClient([
      toolCallResponse([{ name: "exec", arguments: { command: "cd ~/work/api && npm test" } }]),
      toolCallResponse([{ name: "exec", arguments: { command: "echo fixed" } }]),
      noToolResponse("done"),
    ]);
    await run(inference);
    expect(models(inference)).toEqual([CHAT, PRO, CHAT]);
  });

  it("no escalation in low_compute", async () => {
    conway.creditsCents = 30; // low_compute
    const inference = new MockInferenceClient([
      toolCallResponse([{ name: "think_hard", arguments: { reason: "subtle bug" } }]),
      toolCallResponse([{ name: "exec", arguments: { command: "npm test" } }]),
      noToolResponse("done"),
    ]);
    await run(inference);
    expect(models(inference).every((m) => m === CHAT)).toBe(true);
  });

  it("the hourly limit applies across wakes", async () => {
    const config = standaloneConfig(1);
    const failing = () => toolCallResponse([{ name: "exec", arguments: { command: "npm test" } }]);
    const first = new MockInferenceClient([failing(), failing(), noToolResponse("done")]);
    await run(first, config);
    // Turn 2 escalated (1/1), turn 3 is over the limit.
    expect(models(first)).toEqual([CHAT, PRO, CHAT]);

    const second = new MockInferenceClient([failing(), failing(), noToolResponse("done")]);
    await run(second, config);
    expect(models(second).every((m) => m === CHAT)).toBe(true);
  });

  it("Conway mode does not offer think_hard and never escalates", async () => {
    const inference = new MockInferenceClient([
      toolCallResponse([{ name: "exec", arguments: { command: "npm test" } }]),
      noToolResponse("done"),
    ]);
    await run(inference, createTestConfig());
    const offered = (inference.calls[0].options?.tools as any[] | undefined)?.map((t) => t.function?.name) ?? [];
    expect(offered).not.toContain("think_hard");
    expect(models(inference)).not.toContain(PRO);
  });
});
