/**
 * Business escalation, refusal fallback and the optional hourly inference cap
 *
 *  - business heuristic: inbox / acquisition / decision turns, routine turns
 *  - precedence: think_hard > planning > business > coding
 *  - agent loop: inbox and wake-by-message turns use the escalation model
 *  - a spend guard refusal on the escalation model retries once on the tier model
 *  - treasuryPolicy.maxInferenceHourlyCents: explicit or derived (daily / 6)
 *
 * Everything is mocked: no network, no wallet, no spending.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// No RPC call for the on-chain USDC balance.
vi.mock("../conway/x402.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../conway/x402.js")>();
  return { ...actual, getUsdcBalance: vi.fn(async () => 12.5) };
});

import { runAgentLoop } from "../agent/loop.js";
import {
  businessReason,
  isAcquisitionText,
  isMessageWakeEvent,
  isRoutineTurn,
  loadBusinessFocus,
  loadWakeEvents,
} from "../agent/business-heuristic.js";
import {
  ModelEscalation,
  createEscalatingPlannerInference,
  escalationReason,
  routeWithEscalation,
} from "../inference/model-escalation.js";
import { SpendTracker, formatInferenceHourlyCap, inferenceHourlyCap } from "../agent/spend-tracker.js";
import { formatBudgetSleepLog } from "../agent/budget-sleep.js";
import { SpendGuard } from "../survival/spend-guard.js";
import { X402PaymentError, attachX402Payment } from "../conway/x402-v2.js";
import { insertGoal, insertTask, insertWakeEvent, consumeNextWakeEvent } from "../state/database.js";
import { STANDALONE_TREASURY_POLICY, DEFAULT_TREASURY_POLICY } from "../types.js";
import type {
  AutomatonDatabase,
  ChatMessage,
  InferenceOptions,
  InferenceResponse,
  InferenceResult,
  SpendLimitRefusal,
  TreasuryPolicy,
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

const GLM = "zai/glm-5.3";
const CHAT = "deepseek-chat";

function result(overrides: Partial<InferenceResult> = {}): InferenceResult {
  return {
    content: "ok",
    model: GLM,
    provider: "blockrun",
    inputTokens: 10,
    outputTokens: 10,
    costCents: 4.3,
    latencyMs: 5,
    finishReason: "stop",
    ...overrides,
  };
}

const HOURLY: SpendLimitRefusal = {
  limitType: "hourly",
  category: "inference",
  currentCents: 80,
  amountCents: 6.4,
  limitCents: 84,
};

const capRefusal = (limit: SpendLimitRefusal = HOURLY) =>
  new X402PaymentError("inference spend cap reached", "GUARD_REFUSED", limit);

const perRequestRefusal = () =>
  new X402PaymentError("Payment of 12c exceeds maxX402PaymentCents (10c)", "AMOUNT_EXCEEDS_MAX");

// ─── Business heuristic ────────────────────────────────────────

describe("business heuristic", () => {
  const tc = (name: string, error?: string) => ({ name, error });

  it("claimed inbox messages or a message input are business:inbox", () => {
    expect(businessReason({ claimedMessages: 1 })).toBe("business:inbox");
    expect(businessReason({ inputSource: "agent" })).toBe("business:inbox");
    expect(businessReason({ inputSource: "creator" })).toBe("business:inbox");
  });

  it("being woken by a message is business:inbox", () => {
    expect(
      businessReason({ wakeEvents: [{ source: "heartbeat", reason: "2 new message(s) from: 0xabc, 0xdef" }] }),
    ).toBe("business:inbox");
    expect(businessReason({ wakeEvents: [{ source: "creator", reason: "check this" }] })).toBe("business:inbox");
    expect(businessReason({ wakeEvents: [{ source: "customer", reason: "order" }] })).toBe("business:inbox");
  });

  it("other wake events are not business", () => {
    expect(isMessageWakeEvent({ source: "heartbeat", reason: "Credits dropped to low_compute tier: $0.40" })).toBe(false);
    expect(isMessageWakeEvent({ source: "local_worker", reason: "Local worker finished task 01ABC" })).toBe(false);
    expect(businessReason({ wakeEvents: [{ source: "heartbeat", reason: "Health check failed" }] })).toBeNull();
  });

  it("replying after a turn that read messages is business:inbox", () => {
    expect(businessReason({ previousTurn: { hadInbox: true, toolCalls: [] } })).toBe("business:inbox");
    expect(businessReason({ previousTurn: { inputSource: "agent", toolCalls: [] } })).toBe("business:inbox");
    expect(businessReason({ previousTurn: { inputSource: "wakeup", toolCalls: [] } })).toBeNull();
  });

  it("goal and task tools are business:decision", () => {
    for (const name of ["create_goal", "cancel_goal", "complete_goal", "complete_task", "set_goal"]) {
      expect(businessReason({ previousTurn: { toolCalls: [tc(name)] } })).toBe("business:decision");
    }
    // A failed call and read-only tools are not decisions.
    expect(businessReason({ previousTurn: { toolCalls: [tc("create_goal", "boom")] } })).toBeNull();
    expect(businessReason({ previousTurn: { toolCalls: [tc("list_goals"), tc("get_plan")] } })).toBeNull();
  });

  it("acquisition tools are business:acquisition", () => {
    for (const name of ["update_agent_card", "register_erc8004", "discover_agents", "send_message"]) {
      expect(businessReason({ previousTurn: { toolCalls: [tc(name)] } })).toBe("business:acquisition");
    }
  });

  it("matches acquisition keywords in FR and EN, without accents", () => {
    for (const text of [
      "Find paying customers for the summarizer",
      "Trouver des clients",
      "Prospection sur Bazaar",
      "Inscription dans les annuaires x402",
      "List the service on x402scan",
      "Register in the ERC-8004 registry",
      "Référencement du service",
      "Marketing and outreach",
      "Ventes du mois",
      "Sales pipeline",
      "Revoir le pricing",
      "Nouvelle tarification",
      "Submit to agent directories",
      "Create a listing",
    ]) {
      expect(isAcquisitionText(text), text).toBe(true);
    }
    for (const text of ["Fix the summarizer crash", "Write unit tests", "Restart the server", "", undefined]) {
      expect(isAcquisitionText(text), String(text)).toBe(false);
    }
  });

  it("an acquisition goal escalates, except after a pure maintenance turn", () => {
    const focusTexts = ["Get the first customers\nList the API on x402scan and Bazaar"];
    expect(businessReason({ focusTexts })).toBe("business:acquisition");
    expect(businessReason({ focusTexts, previousTurn: { toolCalls: [tc("exec")] } })).toBe("business:acquisition");
    expect(
      businessReason({ focusTexts, previousTurn: { toolCalls: [tc("check_usdc_balance"), tc("system_synopsis")] } }),
    ).toBeNull();
    expect(businessReason({ focusTexts, previousTurn: { toolCalls: [tc("sleep")] } })).toBeNull();
    expect(businessReason({ focusTexts: ["Fix the build"], previousTurn: { toolCalls: [tc("exec")] } })).toBeNull();
  });

  it("routine turns: status checks, reads and sleep", () => {
    expect(isRoutineTurn([tc("check_credits"), tc("sleep")])).toBe(true);
    expect(isRoutineTurn([tc("check_credits"), tc("exec")])).toBe(false);
    expect(isRoutineTurn([])).toBe(false);
    expect(businessReason({ previousTurn: { toolCalls: [tc("heartbeat_ping")] } })).toBeNull();
    expect(businessReason({})).toBeNull();
  });

  it("precedence: inbox > decision > acquisition", () => {
    expect(
      businessReason({ claimedMessages: 1, previousTurn: { toolCalls: [tc("create_goal"), tc("send_message")] } }),
    ).toBe("business:inbox");
    expect(businessReason({ previousTurn: { toolCalls: [tc("create_goal"), tc("send_message")] } })).toBe(
      "business:decision",
    );
  });

  describe("database signals", () => {
    let db: AutomatonDatabase;
    beforeEach(() => {
      db = createTestDb();
    });
    afterEach(() => db.close());

    it("loadBusinessFocus reads active goals and running tasks only", () => {
      const active = insertGoal(db.raw, { title: "Find customers", description: "x402scan listing" });
      const done = insertGoal(db.raw, { title: "Old sales goal", description: "done", status: "completed" });
      insertTask(db.raw, { goalId: active, title: "Write pricing page", description: "tarifs", status: "running" });
      insertTask(db.raw, { goalId: done, title: "Pending outreach", description: "later", status: "pending" });
      const focus = loadBusinessFocus(db.raw);
      expect(focus).toHaveLength(2);
      expect(focus.join("\n")).toContain("Find customers");
      expect(focus.join("\n")).toContain("Write pricing page");
      expect(focus.join("\n")).not.toContain("Old sales goal");
      expect(focus.join("\n")).not.toContain("Pending outreach");
    });

    it("loadWakeEvents returns events consumed around the start of the wake only", () => {
      insertWakeEvent(db.raw, "heartbeat", "1 new message(s) from: 0xabc");
      insertWakeEvent(db.raw, "heartbeat", "not consumed");
      consumeNextWakeEvent(db.raw);
      expect(loadWakeEvents(db.raw, new Date())).toEqual([
        { source: "heartbeat", reason: "1 new message(s) from: 0xabc" },
      ]);
      // A wake that starts long after the event was consumed does not see it.
      expect(loadWakeEvents(db.raw, new Date(Date.now() + 10 * 60_000))).toEqual([]);
    });
  });
});

// ─── Precedence ────────────────────────────────────────────────

describe("escalation precedence", () => {
  it("think_hard > planning > business > coding", () => {
    expect(escalationReason({ business: "business:inbox", coding: true })).toBe("business:inbox");
    expect(escalationReason({ planning: true, business: "business:inbox" })).toBe("planning");
    expect(escalationReason({ thinkHardReason: "proof", business: "business:inbox" })).toBe("think_hard: proof");
    expect(escalationReason({ business: null, coding: true })).toBe("coding");
    expect(escalationReason({ business: null })).toBeNull();
  });

  it("business escalation uses the hourly limit and the tier restriction", () => {
    const db = createTestDb();
    const logs: string[] = [];
    const esc = new ModelEscalation(db.raw, { model: GLM, maxCallsPerHour: 1 }, (m) => logs.push(m));
    expect(esc.begin("low_compute", "business:inbox")).toBeNull();
    expect(esc.begin("critical", "business:inbox")).toBeNull();
    expect(esc.begin("normal", "business:inbox")).not.toBeNull();
    expect(logs.at(-1)).toBe(`[MODEL] escalated to ${GLM} (reason: business:inbox) 1/1 this hour`);
    expect(esc.begin("high", "business:acquisition")).toBeNull();
    db.close();
  });
});

// ─── Refusal fallback ──────────────────────────────────────────

describe("spend guard refusal on an escalated call", () => {
  let db: AutomatonDatabase;
  let esc: ModelEscalation;
  let logs: string[];

  beforeEach(() => {
    db = createTestDb();
    logs = [];
    esc = new ModelEscalation(db.raw, { model: GLM, maxCallsPerHour: 6 }, (m) => logs.push(m));
  });
  afterEach(() => db.close());

  const route = (run: (model?: string) => Promise<InferenceResult>) =>
    routeWithEscalation({ escalation: esc, ticket: esc.begin("high", "business:inbox"), run, log: (m) => logs.push(m) });

  it("per-request refusal: the tier model is used", async () => {
    const run = vi.fn(async (model?: string) => {
      if (model === GLM) throw perRequestRefusal();
      return result({ model: CHAT });
    });
    const out = await route(run);
    expect(out.model).toBe(CHAT);
    expect(run.mock.calls).toEqual([[GLM], [undefined]]);
    expect(esc.usage().used).toBe(0);
  });

  it("hourly cap refusal on the escalated call: the tier model is used, logged once", async () => {
    const run = vi.fn(async (model?: string) => {
      if (model === GLM) throw capRefusal();
      return result({ model: CHAT });
    });
    const out = await route(run);
    expect(out.model).toBe(CHAT);
    expect(run.mock.calls).toEqual([[GLM], [undefined]]);
    expect(esc.usage().used).toBe(0);
    const refusalLogs = logs.filter((m) => m.includes("refused by the hourly inference cap"));
    expect(refusalLogs).toEqual([
      `[MODEL] Escalated call to ${GLM} refused by the hourly inference cap (80c + 6.4c > 84c); retrying once on the tier model.`,
    ]);
  });

  it("daily cap refusal on the escalated call: the tier model is used", async () => {
    const run = vi.fn(async (model?: string) => {
      if (model === GLM) throw capRefusal({ ...HOURLY, limitType: "daily", limitCents: 500, currentCents: 497 });
      return result({ model: CHAT });
    });
    expect((await route(run)).model).toBe(CHAT);
  });

  it("both refused: the tier model's refusal is rethrown (budget sleep), no third call", async () => {
    const tierErr = capRefusal();
    const run = vi.fn(async (model?: string) => {
      throw model === GLM ? capRefusal() : tierErr;
    });
    await expect(route(run)).rejects.toBe(tierErr);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("a charged failure is never retried and keeps its slot", async () => {
    const err = new Error("aborted");
    attachX402Payment(err, {
      url: "https://blockrun.ai/api/v1/chat/completions",
      host: "blockrun.ai",
      amountAtomic: 64000n,
      amountCents: 6.4,
      payTo: "0x0",
      network: "eip155:8453",
      settled: false,
    });
    const run = vi.fn(async () => {
      throw err;
    });
    await expect(route(run)).rejects.toBe(err);
    expect(run).toHaveBeenCalledTimes(1);
    expect(esc.usage().used).toBe(1);
  });

  it("planner: a cap refusal on the escalated call falls back to the tier model", async () => {
    const inner = {
      chat: vi.fn(async () => ({ content: "tier" }) as any),
      chatDirect: vi.fn(async () => {
        throw capRefusal();
      }),
    };
    const planner = createEscalatingPlannerInference({
      inner,
      escalation: esc,
      providerId: "blockrun",
      getTier: () => "high",
      log: (m) => logs.push(m),
    });
    expect((await planner.chat({ tier: "reasoning", messages: [] })).content).toBe("tier");
    expect(inner.chat).toHaveBeenCalledTimes(1);
    expect(esc.usage().used).toBe(0);
  });
});

// ─── Agent loop ────────────────────────────────────────────────

/** Mock inference whose escalation-model calls are refused by the spend guard. */
class RefusingInference extends MockInferenceClient {
  constructor(responses: InferenceResponse[], private readonly refuse: (model?: string) => Error | null) {
    super(responses);
  }
  async chat(messages: ChatMessage[], options?: InferenceOptions): Promise<InferenceResponse> {
    const err = this.refuse(options?.model);
    if (err) {
      this.calls.push({ messages, options });
      throw err;
    }
    return super.chat(messages, options);
  }
}

describe("agent loop: business escalation", () => {
  let db: AutomatonDatabase;
  let conway: MockConwayClient;

  beforeEach(() => {
    db = createTestDb();
    conway = new MockConwayClient();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
  });

  const config = () =>
    createTestConfig({
      providerMode: "standalone",
      blockrun: {
        apiUrl: "https://blockrun.ai/api",
        models: { high: CHAT, normal: CHAT, lowCompute: CHAT, critical: CHAT },
        escalation: { model: GLM, maxCallsPerHour: 6 },
      },
    });

  const run = (inference: MockInferenceClient) =>
    runAgentLoop({ identity: createTestIdentity(), config: config(), db, conway, inference });

  const models = (inference: MockInferenceClient) => inference.calls.map((c) => c.options?.model);

  const queueMessage = () =>
    db.insertInboxMessage({
      id: "msg-1",
      from: "0xabc",
      to: "0xdef",
      content: "Hi, how much for 100 summaries?",
      signedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    });

  it("the turn with inbox messages and the reply turn escalate, then revert", async () => {
    queueMessage();
    const inference = new MockInferenceClient([
      // Turn 1 (wakeup): real work, so the loop goes on to claim the inbox.
      toolCallResponse([{ name: "exec", arguments: { command: "echo hi" } }]),
      // Turn 2: reads the message.
      toolCallResponse([{ name: "exec", arguments: { command: "echo reading" } }]),
      // Turn 3: replies.
      toolCallResponse([{ name: "exec", arguments: { command: "echo replied" } }]),
      noToolResponse("done"),
    ]);
    await run(inference);
    expect(models(inference)).toEqual([CHAT, GLM, GLM, CHAT]);
    const msg = db.raw.prepare("SELECT status FROM inbox_messages WHERE id = 'msg-1'").get() as any;
    expect(msg.status).toBe("processed");
  });

  it("being woken by a new-message event escalates the first turn only", async () => {
    insertWakeEvent(db.raw, "heartbeat", "1 new message(s) from: 0xabc");
    consumeNextWakeEvent(db.raw); // consumed by the outer run loop
    const inference = new MockInferenceClient([
      toolCallResponse([{ name: "exec", arguments: { command: "echo hi" } }]),
      noToolResponse("done"),
    ]);
    await run(inference);
    expect(models(inference)).toEqual([GLM, CHAT]);
  });

  it("a goal decision escalates the next turn", async () => {
    const inference = new MockInferenceClient([
      toolCallResponse([{ name: "set_goal", arguments: { content: "Ship v2 of the API" } }]),
      toolCallResponse([{ name: "exec", arguments: { command: "echo hi" } }]),
      noToolResponse("done"),
    ]);
    await run(inference);
    expect(models(inference)).toEqual([CHAT, GLM, CHAT]);
  });

  it("an escalated turn refused by the spend guard runs once on the tier model", async () => {
    queueMessage();
    const inference = new RefusingInference(
      [
        toolCallResponse([{ name: "exec", arguments: { command: "echo hi" } }]),
        noToolResponse("replied"),
      ],
      (model) => (model === GLM ? perRequestRefusal() : null),
    );
    await run(inference);
    // Turn 2 tried the escalation model, was refused, and ran on the tier model.
    expect(models(inference)).toEqual([CHAT, GLM, CHAT]);
    expect(db.getKV("budget_sleep_until")).toBeUndefined();
    const msg = db.raw.prepare("SELECT status FROM inbox_messages WHERE id = 'msg-1'").get() as any;
    expect(msg.status).toBe("processed");
  });
});

// ─── Optional hourly inference cap ─────────────────────────────

describe("treasuryPolicy.maxInferenceHourlyCents", () => {
  const policy = (overrides: Partial<TreasuryPolicy> = {}): TreasuryPolicy => ({
    ...STANDALONE_TREASURY_POLICY,
    maxInferenceDailyCents: 500,
    maxTotalDailySpendCents: 500,
    ...overrides,
  });

  it("defaults are unchanged and do not set it", () => {
    expect(STANDALONE_TREASURY_POLICY.maxInferenceHourlyCents).toBeUndefined();
    expect(DEFAULT_TREASURY_POLICY.maxInferenceHourlyCents).toBeUndefined();
    expect(STANDALONE_TREASURY_POLICY.maxInferenceDailyCents).toBe(200);
    expect(STANDALONE_TREASURY_POLICY.maxX402PaymentCents).toBe(10);
    expect(STANDALONE_TREASURY_POLICY.minimumReserveCents).toBe(100);
  });

  it("absent: derived exactly as before, ceil(daily / 6)", () => {
    expect(inferenceHourlyCap(policy())).toEqual({ cents: 84, explicit: false });
    expect(inferenceHourlyCap({ maxInferenceDailyCents: 200 })).toEqual({ cents: 34, explicit: false });
    // Non-positive or non-finite values are ignored.
    for (const value of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(inferenceHourlyCap(policy({ maxInferenceHourlyCents: value }))).toEqual({ cents: 84, explicit: false });
    }
  });

  it("set: used as the hourly cap", () => {
    expect(inferenceHourlyCap(policy({ maxInferenceHourlyCents: 150 }))).toEqual({ cents: 150, explicit: true });
  });

  describe("SpendTracker.checkLimit", () => {
    let db: AutomatonDatabase;
    let tracker: SpendTracker;
    beforeEach(() => {
      db = createTestDb();
      tracker = new SpendTracker(db.raw);
      tracker.recordSpend({ toolName: "inference", amountCents: 80, category: "inference", domain: "blockrun.ai" });
    });
    afterEach(() => db.close());

    it("derived path: 80 + 6.4 > 84 is refused, identical to before", () => {
      const check = tracker.checkLimit(6.4, "inference", policy());
      expect(check.allowed).toBe(false);
      expect(check.limitType).toBe("hourly");
      expect(check.limitHourly).toBe(84);
      expect(check.hourlyCapExplicit).toBe(false);
      expect(check.reason).toBe("Hourly spend cap exceeded: current 80 + 6.4 > 84");
    });

    it("explicit path: a higher hourly cap allows the call, the daily cap still applies", () => {
      const p = policy({ maxInferenceHourlyCents: 150 });
      const allowed = tracker.checkLimit(6.4, "inference", p);
      expect(allowed.allowed).toBe(true);
      expect(allowed.limitHourly).toBe(150);
      expect(allowed.limitDaily).toBe(500);

      const refused = tracker.checkLimit(80, "inference", p);
      expect(refused.allowed).toBe(false);
      expect(refused.limitType).toBe("hourly");
      expect(refused.limitHourly).toBe(150);
      expect(refused.hourlyCapExplicit).toBe(true);
    });

    it("explicit path: a lower hourly cap refuses earlier", () => {
      const check = tracker.checkLimit(6.4, "inference", policy({ maxInferenceHourlyCents: 50 }));
      expect(check.allowed).toBe(false);
      expect(check.limitHourly).toBe(50);
    });

    it("SpendGuard: the refusal carries the explicit cap; derived refusals are unchanged", async () => {
      const guard = (p: TreasuryPolicy) =>
        new SpendGuard({
          policy: p,
          category: "inference",
          spendTracker: tracker,
          getBalanceCents: async () => 10_000,
          toolName: "blockrun_inference",
        });
      const derived = await guard(policy()).authorizeDetailed({ amountCents: 6.4, host: "blockrun.ai" });
      expect(derived?.limit).toEqual({ limitType: "hourly", category: "inference", currentCents: 80, amountCents: 6.4, limitCents: 84 });
      const explicit = await guard(policy({ maxInferenceHourlyCents: 50 })).authorizeDetailed({ amountCents: 6.4, host: "blockrun.ai" });
      expect(explicit?.limit).toEqual({
        limitType: "hourly",
        category: "inference",
        currentCents: 80,
        amountCents: 6.4,
        limitCents: 50,
        hourlyCapExplicit: true,
      });
      expect(await guard(policy({ maxInferenceHourlyCents: 150 })).authorizeDetailed({ amountCents: 6.4, host: "blockrun.ai" })).toBeNull();
    });

    it("other categories are not affected", () => {
      const p = policy({ maxInferenceHourlyCents: 1 });
      expect(tracker.checkLimit(5, "x402", p).limitHourly).toBe(STANDALONE_TREASURY_POLICY.maxX402PaymentCents * 10);
      expect(tracker.checkLimit(5, "transfer", p).limitHourly).toBe(STANDALONE_TREASURY_POLICY.maxHourlyTransferCents);
    });
  });

  it("log lines: startup caps and [BUDGET]", () => {
    expect(formatInferenceHourlyCap(policy())).toBe("$0.84/hour inference (derived: daily / 6)");
    expect(formatInferenceHourlyCap(policy({ maxInferenceHourlyCents: 150 }))).toBe(
      "$1.50/hour inference (maxInferenceHourlyCents)",
    );
    const until = new Date("2026-10-09T06:00:05Z");
    expect(formatBudgetSleepLog({ ...HOURLY, currentCents: 83.8662, hourlyCapExplicit: false }, until)).toBe(
      "[BUDGET] Hourly inference cap reached (83.87c of 84c). Sleeping until 06:00:05Z.",
    );
    expect(formatBudgetSleepLog({ ...HOURLY, limitCents: 150, currentCents: 148, hourlyCapExplicit: true }, until)).toBe(
      "[BUDGET] Hourly inference cap (maxInferenceHourlyCents) reached (148c of 150c). Sleeping until 06:00:05Z.",
    );
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

    it("absent: not set, other caps unchanged", async () => {
      const cfg = await load({ providerMode: "standalone" });
      expect(cfg.treasuryPolicy?.maxInferenceHourlyCents).toBeUndefined();
      expect(cfg.treasuryPolicy).toEqual(STANDALONE_TREASURY_POLICY);
    });

    it("a positive value is kept", async () => {
      const cfg = await load({ providerMode: "standalone", treasuryPolicy: { maxInferenceHourlyCents: 150 } });
      expect(cfg.treasuryPolicy?.maxInferenceHourlyCents).toBe(150);
    });

    it("invalid values are dropped (derived cap applies)", async () => {
      for (const value of [0, -1, "100", null]) {
        const cfg = await load({ providerMode: "standalone", treasuryPolicy: { maxInferenceHourlyCents: value } });
        expect(cfg.treasuryPolicy && "maxInferenceHourlyCents" in cfg.treasuryPolicy, String(value)).toBe(false);
        expect(cfg.treasuryPolicy?.maxInferenceDailyCents).toBe(STANDALONE_TREASURY_POLICY.maxInferenceDailyCents);
      }
    });
  });
});
