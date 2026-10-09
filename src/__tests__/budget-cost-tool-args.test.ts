/**
 * Production fixes of 2026-10-08:
 *   1. inference_costs / turn.costCents record the x402 amount actually paid
 *   2. a spend-cap refusal sleeps until the cap's window resets
 *   3. truncated / invalid tool-call arguments never run the tool
 *
 * Everything is mocked: the signing key is a throwaway constant that has
 * never been funded, balances are stubbed, and no request leaves the process.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import {
  BASE_USDC_ADDRESS,
  PaymentLedger,
  X402PaymentError,
  createX402Fetch,
  getX402Payment,
} from "../conway/x402-v2.js";
import { createInferenceClient } from "../conway/inference.js";
import { SpendGuard } from "../survival/spend-guard.js";
import { SpendTracker } from "../agent/spend-tracker.js";
import { InferenceRouter } from "../inference/router.js";
import { ModelRegistry } from "../inference/registry.js";
import { InferenceBudgetTracker } from "../inference/budget.js";
import { runAgentLoop, parseToolArguments } from "../agent/loop.js";
import { createBuiltinTools, executeTool, validateToolArgs } from "../agent/tools.js";
import {
  BUDGET_SLEEP_UNTIL_KEY,
  budgetWindowResetAt,
  formatBudgetSleepLog,
  getActiveBudgetSleep,
  getSpendLimitRefusal,
} from "../agent/budget-sleep.js";
import {
  DEFAULT_MODEL_STRATEGY_CONFIG,
  STANDALONE_TREASURY_POLICY,
} from "../types.js";
import type {
  AgentTurn,
  AutomatonDatabase,
  ChatMessage,
  InferenceClient,
  InferenceOptions,
  InferenceResponse,
  SpendLimitRefusal,
  TreasuryPolicy,
} from "../types.js";
import {
  MockConwayClient,
  createTestConfig,
  createTestDb,
  createTestIdentity,
  noToolResponse,
  toolCallResponse,
} from "./mocks.js";

const TEST_ACCOUNT = privateKeyToAccount(`0x${"ab".repeat(32)}`);
const PAY_TO = "0x1111111111111111111111111111111111111111";
const BLOCKRUN_API = "https://blockrun.ai/api";
const BLOCKRUN_URL = `${BLOCKRUN_API}/v1/chat/completions`;

/** The production limits (must not change): $5/day, hourly ceil(500/6) = 84c. */
const POLICY: TreasuryPolicy = {
  ...STANDALONE_TREASURY_POLICY,
  maxInferenceDailyCents: 500,
  maxTotalDailySpendCents: 500,
  maxX402PaymentCents: 10,
  minimumReserveCents: 100,
};

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64");

/** x402 v2 challenge quoting `amountAtomic` USDC units (63971 = 6.3971 cents). */
function challengeResponse(amountAtomic: string): Response {
  return new Response("{}", {
    status: 402,
    headers: {
      "PAYMENT-REQUIRED": b64({
        x402Version: 2,
        resource: { url: BLOCKRUN_URL },
        accepts: [
          {
            scheme: "exact",
            network: "eip155:8453",
            amount: amountAtomic,
            asset: BASE_USDC_ADDRESS,
            payTo: PAY_TO,
            maxTimeoutSeconds: 300,
            extra: { name: "USD Coin", version: "2" },
          },
        ],
      }),
    },
  });
}

function completionResponse(): Response {
  return new Response(
    JSON.stringify({
      id: "cmpl-1",
      model: "deepseek-chat",
      choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 23_000, completion_tokens: 300, total_tokens: 23_300 },
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "PAYMENT-RESPONSE": b64({ success: true, transaction: "0xfeed", network: "eip155:8453" }),
      },
    },
  );
}

function abortError(): Error {
  const err = new Error("This operation was aborted");
  err.name = "AbortError";
  return err;
}

function capError(limit: SpendLimitRefusal): X402PaymentError {
  return new X402PaymentError(`inference spend cap reached: ${limit.limitType}`, "GUARD_REFUSED", limit);
}

const HOURLY_LIMIT: SpendLimitRefusal = {
  limitType: "hourly",
  category: "inference",
  currentCents: 83.8662,
  amountCents: 6.3971,
  limitCents: 84,
};

/** Inference client whose calls follow a script (return or throw). */
class ScriptedInference implements InferenceClient {
  calls = 0;
  constructor(private readonly steps: Array<() => InferenceResponse>) {}
  async chat(_messages: ChatMessage[], _options?: InferenceOptions): Promise<InferenceResponse> {
    const step = this.steps[this.calls++];
    return step ? step() : noToolResponse("Nothing to do.");
  }
  setLowComputeMode(): void {}
  getDefaultModel(): string {
    return "mock-model";
  }
}

function inferenceCosts(db: AutomatonDatabase): number[] {
  return (db.raw.prepare("SELECT cost_cents FROM inference_costs ORDER BY created_at ASC").all() as any[]).map(
    (r) => r.cost_cents,
  );
}

// ─── 1. Real charged cost ──────────────────────────────────────

describe("real x402 cost in inference_costs", () => {
  let db: AutomatonDatabase;
  let tracker: SpendTracker;

  beforeEach(() => {
    db = createTestDb();
    tracker = new SpendTracker(db.raw);
  });

  afterEach(() => {
    db.close();
  });

  const makeGuard = () =>
    new SpendGuard({
      policy: POLICY,
      category: "inference",
      spendTracker: tracker,
      getBalanceCents: async () => 10_000,
      toolName: "blockrun_inference",
    });

  const makePaidFetch = (fetchImpl: typeof fetch, guard = makeGuard()) =>
    createX402Fetch({
      account: TEST_ACCOUNT,
      maxPaymentCents: POLICY.maxX402PaymentCents,
      allowedDomains: POLICY.x402AllowedDomains,
      guard,
      fetchImpl,
      ledger: new PaymentLedger(),
    });

  const makeBlockRunClient = (paidFetch: typeof fetch) =>
    createInferenceClient({
      apiUrl: "https://api.conway.tech",
      apiKey: "",
      defaultModel: "deepseek-chat",
      maxTokens: 1000,
      getModelProvider: () => "blockrun",
      blockrun: { apiUrl: BLOCKRUN_API, fetch: paidFetch },
    });

  it("BlockRun responses carry the exact x402 amount charged", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(challengeResponse("63971"))
      .mockResolvedValueOnce(completionResponse()) as unknown as typeof fetch;
    const client = makeBlockRunClient(makePaidFetch(fetchImpl));

    const response = await client.chat([{ role: "user", content: "hello" }]);

    expect(response.chargedCents).toBe(6.3971);
    // The spend ledger counts the same amount (what the caps see).
    expect(tracker.getHourlySpend("inference")).toBeCloseTo(6.3971, 6);
  });

  it("concurrent paid calls each report their own amount", async () => {
    const amounts: Record<string, string> = { a: "55000", b: "69000" };
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const tag = body.messages[0].content as string;
      const headers = (init?.headers ?? {}) as Record<string, string>;
      if (!Object.keys(headers).some((k) => k.toLowerCase() === "payment-signature")) {
        return challengeResponse(amounts[tag]);
      }
      await new Promise((r) => setTimeout(r, tag === "a" ? 20 : 0));
      return completionResponse();
    }) as unknown as typeof fetch;
    const client = makeBlockRunClient(makePaidFetch(fetchImpl));

    const [a, b] = await Promise.all([
      client.chat([{ role: "user", content: "a" }]),
      client.chat([{ role: "user", content: "b" }]),
    ]);

    expect(a.chargedCents).toBe(5.5);
    expect(b.chargedCents).toBe(6.9);
  });

  it("the router records the charged amount, not the token estimate", async () => {
    const registry = new ModelRegistry(db.raw);
    registry.initialize();
    const budget = new InferenceBudgetTracker(db.raw, DEFAULT_MODEL_STRATEGY_CONFIG);
    const router = new InferenceRouter(db.raw, registry, budget);

    const charged = { ...noToolResponse("ok"), chargedCents: 6.3971 };
    const result = await router.route(
      { messages: [{ role: "user", content: "hi" }], taskType: "agent_turn", tier: "normal", sessionId: "s1" },
      async () => charged,
    );

    expect(result.costCents).toBe(6.3971);
    expect(inferenceCosts(db)).toEqual([6.3971]);
  });

  it("falls back to the token estimate when no x402 payment is associated", async () => {
    const registry = new ModelRegistry(db.raw);
    registry.initialize();
    const budget = new InferenceBudgetTracker(db.raw, DEFAULT_MODEL_STRATEGY_CONFIG);
    const router = new InferenceRouter(db.raw, registry, budget);

    const result = await router.route(
      { messages: [{ role: "user", content: "hi" }], taskType: "agent_turn", tier: "normal", sessionId: "s1" },
      async () => noToolResponse("ok"),
    );

    expect(Number.isInteger(result.costCents)).toBe(true);
    expect(inferenceCosts(db)).toEqual([result.costCents]);
  });

  it("a paid request that times out keeps its spend reservation and its cost", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(challengeResponse("63971"))
      .mockRejectedValueOnce(abortError()) as unknown as typeof fetch;
    const guard = makeGuard();
    const release = vi.spyOn(guard, "release");
    const client = makeBlockRunClient(makePaidFetch(fetchImpl, guard));

    let thrown: unknown;
    try {
      await client.chat([{ role: "user", content: "hello" }]);
    } catch (err) {
      thrown = err;
    }

    expect((thrown as Error).name).toBe("AbortError");
    expect(getX402Payment(thrown)?.amountCents).toBe(6.3971);
    expect(release).not.toHaveBeenCalled();
    expect(tracker.getHourlySpend("inference")).toBeCloseTo(6.3971, 6);

    // The router records the paid timeout at its real cost.
    const registry = new ModelRegistry(db.raw);
    registry.initialize();
    const router = new InferenceRouter(db.raw, registry, new InferenceBudgetTracker(db.raw, DEFAULT_MODEL_STRATEGY_CONFIG));
    const result = await router.route(
      { messages: [{ role: "user", content: "hi" }], taskType: "agent_turn", tier: "normal", sessionId: "s1" },
      async () => {
        throw thrown;
      },
    );
    expect(result.finishReason).toBe("timeout");
    expect(result.costCents).toBe(6.3971);
    expect(inferenceCosts(db)).toEqual([6.3971]);
    // Still counted exactly once by the caps.
    expect(tracker.getHourlySpend("inference")).toBeCloseTo(6.3971, 6);
  });

  it("the hourly cap refuses when ledger + quote > cap, with a structured refusal", async () => {
    tracker.recordSpend({ toolName: "blockrun_inference", amountCents: 83.8662, category: "inference", domain: "blockrun.ai" });
    const fetchImpl = vi.fn().mockResolvedValueOnce(challengeResponse("63971")) as unknown as typeof fetch;
    const paidFetch = makePaidFetch(fetchImpl);

    let thrown: unknown;
    try {
      await paidFetch(BLOCKRUN_URL, { method: "POST", body: "{}" });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(X402PaymentError);
    expect((thrown as X402PaymentError).code).toBe("GUARD_REFUSED");
    expect((thrown as X402PaymentError).limit).toEqual({
      limitType: "hourly",
      category: "inference",
      currentCents: 83.8662,
      amountCents: 6.3971,
      limitCents: 84,
    });
    // Nothing signed or sent after the refusal.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(tracker.getHourlySpend("inference")).toBeCloseTo(83.8662, 6);
  });

  it("spend never exceeds the hourly cap, even with concurrent calls", async () => {
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const paid = Object.keys(headers).some((k) => k.toLowerCase() === "payment-signature");
      return paid ? completionResponse() : challengeResponse("63971");
    }) as unknown as typeof fetch;
    const client = makeBlockRunClient(makePaidFetch(fetchImpl));

    const results = await Promise.allSettled(
      Array.from({ length: 30 }, (_, i) => client.chat([{ role: "user", content: `call ${i}` }])),
    );

    const paid = results.filter((r) => r.status === "fulfilled").length;
    const refused = results.filter(
      (r) => r.status === "rejected" && getSpendLimitRefusal(r.reason)?.limitType === "hourly",
    ).length;
    expect(paid).toBe(13); // 13 × 6.3971 = 83.16 ≤ 84 < 14 × 6.3971
    expect(refused).toBe(17);
    expect(tracker.getHourlySpend("inference")).toBeLessThanOrEqual(84);
  });

  it("global daily refusals are tagged; other refusals are not", async () => {
    const guard = makeGuard();

    tracker.recordSpend({ toolName: "x", amountCents: 499, category: "x402" });
    const global = await new SpendGuard({
      policy: POLICY,
      category: "inference",
      spendTracker: tracker,
      getBalanceCents: async () => 10_000,
    }).authorizeDetailed({ amountCents: 2, host: "blockrun.ai" });
    expect(global?.limit?.limitType).toBe("global_daily");
    expect(global?.limit?.currentCents).toBe(499);
    expect(global?.limit?.limitCents).toBe(500);

    const perRequest = await guard.authorizeDetailed({ amountCents: 11, host: "blockrun.ai" });
    expect(perRequest?.reason).toMatch(/per-request max/);
    expect(perRequest?.limit).toBeUndefined();

    const lowBalance = await new SpendGuard({
      policy: POLICY,
      category: "inference",
      spendTracker: new SpendTracker(createTestDb().raw),
      getBalanceCents: async () => 100,
    }).authorizeDetailed({ amountCents: 1, host: "blockrun.ai" });
    expect(lowBalance?.reason).toMatch(/reserve/);
    expect(lowBalance?.limit).toBeUndefined();
  });

  it("the daily category cap is tagged as daily", () => {
    // Spread spend over earlier hours of today so only the daily cap trips.
    const today = new Date().toISOString().slice(0, 10);
    db.raw
      .prepare(
        `INSERT INTO spend_tracking (id, tool_name, amount_cents, category, window_hour, window_day)
         VALUES ('old', 'blockrun_inference', 480, 'inference', 'earlier-hour', ?)`,
      )
      .run(today);
    const check = tracker.checkLimit(30, "inference", POLICY);
    expect(check.allowed).toBe(false);
    expect(check.limitType).toBe("daily");
  });
});

// ─── 2. Cap refusal → sleep until the window resets ────────────

describe("spend-cap refusal in the agent loop", () => {
  let db: AutomatonDatabase;
  let conway: MockConwayClient;

  beforeEach(() => {
    db = createTestDb();
    conway = new MockConwayClient();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-08T18:57:12.345Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    db.close();
  });

  const run = (inference: InferenceClient, onTurnComplete?: (t: AgentTurn) => void) =>
    runAgentLoop({
      identity: createTestIdentity(),
      config: createTestConfig(),
      db,
      conway,
      inference,
      onTurnComplete,
    });

  it("hourly cap: sleeps until the next UTC hour, no retry burst, inbox message kept", async () => {
    db.insertInboxMessage({
      id: "msg-1",
      from: "0xabc",
      to: "0xdef",
      content: "please do something",
      signedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    });
    const inference = new ScriptedInference([
      // Turn 1 (wakeup, inbox claimed with it): the paid call is refused by the hourly cap.
      () => {
        throw capError(HOURLY_LIMIT);
      },
    ]);
    await run(inference);

    expect(inference.calls).toBe(1); // refused once, never retried
    expect(db.getAgentState()).toBe("sleeping");
    expect(db.getKV("sleep_until")).toBe("2026-10-08T19:00:05.000Z");
    expect(db.getKV(BUDGET_SLEEP_UNTIL_KEY)).toBe("2026-10-08T19:00:05.000Z");

    const msg = db.raw.prepare("SELECT status, retry_count FROM inbox_messages WHERE id = 'msg-1'").get() as any;
    expect(msg).toEqual({ status: "received", retry_count: 0 });

    // An early wake (heartbeat, inbox) does not run inference again.
    await run(inference);
    expect(inference.calls).toBe(1);
    expect(db.getAgentState()).toBe("sleeping");
    expect(db.getKV("sleep_until")).toBe("2026-10-08T19:00:05.000Z");

    // Once the window has reset, the agent runs again.
    vi.setSystemTime(new Date("2026-10-08T19:00:06Z"));
    await run(inference);
    expect(inference.calls).toBeGreaterThan(1);
    expect(db.getKV(BUDGET_SLEEP_UNTIL_KEY)).toBeUndefined();
  });

  it("hourly cap refusal is not counted as a turn error", async () => {
    const inference = new ScriptedInference([
      () => {
        throw capError(HOURLY_LIMIT);
      },
    ]);
    const errors: AgentTurn[] = [];
    await run(inference, (t) => errors.push(t));

    expect(inference.calls).toBe(1);
    expect(errors).toHaveLength(0);
    // Not the [FATAL] 5-consecutive-errors path (which sleeps 300s).
    expect(db.getKV("sleep_until")).toBe("2026-10-08T19:00:05.000Z");
  });

  it("daily cap: sleeps until the next UTC midnight", async () => {
    const inference = new ScriptedInference([
      () => {
        throw capError({ ...HOURLY_LIMIT, limitType: "daily", currentCents: 497, limitCents: 500 });
      },
    ]);
    await run(inference);

    expect(inference.calls).toBe(1);
    expect(db.getAgentState()).toBe("sleeping");
    expect(db.getKV("sleep_until")).toBe("2026-10-09T00:00:05.000Z");
  });

  it("global daily cap: sleeps until the next UTC midnight", async () => {
    const inference = new ScriptedInference([
      () => {
        throw capError({ ...HOURLY_LIMIT, limitType: "global_daily", currentCents: 498, limitCents: 500 });
      },
    ]);
    await run(inference);

    expect(inference.calls).toBe(1);
    expect(db.getKV("sleep_until")).toBe("2026-10-09T00:00:05.000Z");
  });

  it("a non-cap refusal keeps the current error behaviour", async () => {
    const reserveRefusal = () => {
      throw new X402PaymentError("Payment would breach the wallet reserve", "GUARD_REFUSED");
    };
    const inference = new ScriptedInference(Array.from({ length: 10 }, () => reserveRefusal));

    await run(inference);

    expect(inference.calls).toBe(5); // MAX_CONSECUTIVE_ERRORS
    expect(db.getAgentState()).toBe("sleeping");
    expect(db.getKV(BUDGET_SLEEP_UNTIL_KEY)).toBeUndefined();
    expect(db.getKV("sleep_until")).toBe(new Date(Date.now() + 300_000).toISOString());
  });
});

describe("budget sleep helpers", () => {
  it("computes the next UTC hour / midnight plus a margin", () => {
    const now = new Date("2026-10-08T18:57:12.345Z");
    expect(budgetWindowResetAt("hourly", now).toISOString()).toBe("2026-10-08T19:00:05.000Z");
    expect(budgetWindowResetAt("daily", now).toISOString()).toBe("2026-10-09T00:00:05.000Z");
    expect(budgetWindowResetAt("global_daily", now).toISOString()).toBe("2026-10-09T00:00:05.000Z");
    expect(budgetWindowResetAt("hourly", new Date("2026-12-31T23:59:59Z")).toISOString()).toBe(
      "2027-01-01T00:00:05.000Z",
    );
  });

  it("formats one clear log line", () => {
    expect(formatBudgetSleepLog(HOURLY_LIMIT, new Date("2026-10-08T19:00:05Z"))).toBe(
      "[BUDGET] Hourly inference cap reached (83.87c of 84c). Sleeping until 19:00:05Z.",
    );
  });

  it("only recognises structured cap refusals", () => {
    expect(getSpendLimitRefusal(capError(HOURLY_LIMIT))).toEqual(HOURLY_LIMIT);
    expect(getSpendLimitRefusal(new X402PaymentError("reserve", "GUARD_REFUSED"))).toBeNull();
    expect(getSpendLimitRefusal(new Error("Hourly spend cap exceeded"))).toBeNull();
    expect(getSpendLimitRefusal(new Error("wrapped", { cause: capError(HOURLY_LIMIT) }))).toEqual(HOURLY_LIMIT);
  });

  it("ignores an expired budget sleep", () => {
    const kv = new Map<string, string>([[BUDGET_SLEEP_UNTIL_KEY, "2026-10-08T19:00:05.000Z"]]);
    const store = { getKV: (k: string) => kv.get(k) };
    expect(getActiveBudgetSleep(store, new Date("2026-10-08T18:59:00Z"))?.toISOString()).toBe(
      "2026-10-08T19:00:05.000Z",
    );
    expect(getActiveBudgetSleep(store, new Date("2026-10-08T19:00:06Z"))).toBeNull();
  });
});

// ─── 3. Truncated / invalid tool arguments ─────────────────────

describe("tool-call arguments", () => {
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

  const rawToolCall = (name: string, args: string): InferenceResponse => {
    const tc = { id: `call_${name}_${args.length}`, type: "function" as const, function: { name, arguments: args } };
    return {
      id: "resp",
      model: "mock-model",
      message: { role: "assistant", content: "", tool_calls: [tc] },
      toolCalls: [tc],
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      finishReason: "tool_calls",
    };
  };

  it("parseToolArguments rejects truncated JSON and non-objects", () => {
    expect(parseToolArguments('{"path": "/root/a", "content": "abc')).toMatchObject({ ok: false });
    expect(parseToolArguments("null")).toEqual({ ok: false, error: "expected a JSON object, got null" });
    expect(parseToolArguments("[1,2]")).toEqual({ ok: false, error: "expected a JSON object, got an array" });
    expect(parseToolArguments('"text"')).toEqual({ ok: false, error: "expected a JSON object, got string" });
    expect(parseToolArguments("")).toEqual({ ok: true, args: {} });
    expect(parseToolArguments('{"a":1}')).toEqual({ ok: true, args: { a: 1 } });
  });

  it("truncated arguments do not run the tool and return a clean error", async () => {
    const truncated = '{"path": "/root/big.js", "content": "const x = 1;\\n' + "a".repeat(1500);
    const inference = new ScriptedInference([() => rawToolCall("write_file", truncated)]);
    const turns: AgentTurn[] = [];

    await runAgentLoop({
      identity: createTestIdentity(),
      config: createTestConfig(),
      db,
      conway,
      inference,
      onTurnComplete: (t) => turns.push(t),
    });

    const call = turns[0].toolCalls[0];
    expect(call.id).toBe(`call_write_file_${truncated.length}`);
    expect(call.name).toBe("write_file");
    expect(call.error).toMatch(/^Tool arguments were truncated or invalid JSON \(.+\); the tool was NOT run\./);
    expect(call.error).toContain("split a large file into several smaller write_file calls");
    expect(Object.keys(conway.files)).toHaveLength(0);
  });

  it("arguments that parse to a non-object do not run the tool", async () => {
    const inference = new ScriptedInference([() => rawToolCall("exec", "null")]);
    const turns: AgentTurn[] = [];

    await runAgentLoop({
      identity: createTestIdentity(),
      config: createTestConfig(),
      db,
      conway,
      inference,
      onTurnComplete: (t) => turns.push(t),
    });

    expect(turns[0].toolCalls[0].error).toMatch(/truncated or invalid JSON \(expected a JSON object, got null\)/);
    expect(conway.execCalls).toHaveLength(0);
  });

  it("executeTool rejects missing or mistyped required parameters without throwing", async () => {
    const tools = createBuiltinTools("test-sandbox");
    const writeFile = tools.find((t) => t.name === "write_file")!;
    const context = {
      identity: createTestIdentity(),
      config: createTestConfig(),
      db,
      conway,
      inference: new ScriptedInference([]),
    };

    const missing = await executeTool("write_file", { content: "x" }, tools, context);
    expect(missing.error).toBe('Missing required parameter "path" for write_file; the tool was NOT run.');

    const mistyped = await executeTool("write_file", { path: 42, content: "x" }, tools, context);
    expect(mistyped.error).toBe(
      'Invalid parameter "path" for write_file: expected string, got number; the tool was NOT run.',
    );

    const nonObject = await executeTool("write_file", null as any, tools, context);
    expect(nonObject.error).toMatch(/expected a JSON object, got null/);

    expect(Object.keys(conway.files)).toHaveLength(0);
    expect(validateToolArgs(writeFile, { path: "/root/a.txt", content: "x" })).toBeNull();
  });

  it("validates number, boolean and object types", () => {
    const tool = {
      name: "t",
      description: "",
      parameters: {
        type: "object",
        properties: {
          n: { type: "number" },
          b: { type: "boolean" },
          o: { type: "object" },
        },
        required: ["n", "b", "o"],
      },
      execute: async () => "",
      riskLevel: "safe" as const,
      category: "vm" as const,
    };
    expect(validateToolArgs(tool, { n: 1, b: true, o: {} })).toBeNull();
    expect(validateToolArgs(tool, { n: "1", b: true, o: {} })).toMatch(/"n".*expected number, got string/);
    expect(validateToolArgs(tool, { n: 1, b: "yes", o: {} })).toMatch(/"b".*expected boolean/);
    expect(validateToolArgs(tool, { n: 1, b: true, o: [] })).toMatch(/"o".*expected object, got array/);
    expect(validateToolArgs(tool, [] as any)).toMatch(/expected a JSON object, got an array/);
  });
});
