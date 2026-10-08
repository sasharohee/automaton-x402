/**
 * Spend Guard Tests — spending caps and wallet reserve.
 * Uses a temporary SQLite DB and a mocked balance reader; no real wallet.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SpendGuard, keepsReserve } from "../survival/spend-guard.js";
import { SpendTracker } from "../agent/spend-tracker.js";
import { STANDALONE_TREASURY_POLICY } from "../types.js";
import type { AutomatonDatabase, TreasuryPolicy } from "../types.js";
import { createTestDb } from "./mocks.js";

const policy: TreasuryPolicy = { ...STANDALONE_TREASURY_POLICY };

describe("keepsReserve", () => {
  it("allows payments that leave at least the reserve", () => {
    expect(keepsReserve({ balanceCents: 500, pendingCents: 0, amountCents: 400, minimumReserveCents: 100 })).toBe(true);
    expect(keepsReserve({ balanceCents: 500, pendingCents: 0, amountCents: 401, minimumReserveCents: 100 })).toBe(false);
  });

  it("accounts for spend not yet visible on-chain", () => {
    expect(keepsReserve({ balanceCents: 500, pendingCents: 350, amountCents: 60, minimumReserveCents: 100 })).toBe(false);
  });
});

describe("SpendGuard", () => {
  let db: AutomatonDatabase;
  let tracker: SpendTracker;

  beforeEach(() => {
    db = createTestDb();
    tracker = new SpendTracker(db.raw);
  });

  afterEach(() => {
    db.close();
  });

  const make = (balanceCents: number | (() => Promise<number>), overrides: Partial<TreasuryPolicy> = {}) =>
    new SpendGuard({
      policy: { ...policy, ...overrides },
      category: "inference",
      spendTracker: tracker,
      getBalanceCents: typeof balanceCents === "number" ? async () => balanceCents : balanceCents,
    });

  it("allows a small payment with a healthy balance", async () => {
    const guard = make(1000);
    expect(await guard.authorize({ amountCents: 0.25, host: "blockrun.ai" })).toBeNull();
  });

  it("enforces the per-request maximum ($0.10 by default)", async () => {
    const guard = make(10_000);
    expect(await guard.authorize({ amountCents: 10, host: "blockrun.ai" })).toBeNull();
    expect(await guard.authorize({ amountCents: 10.01, host: "blockrun.ai" })).toMatch(/per-request max/);
  });

  it("enforces the daily inference cap ($2/day by default)", async () => {
    const guard = make(100_000, { maxX402PaymentCents: 100 });
    // Hourly envelope derived from the daily cap: ceil(200 / 6) = 34 cents.
    tracker.recordSpend({ toolName: "t", amountCents: 34, category: "inference" });
    expect(await guard.authorize({ amountCents: 1, host: "blockrun.ai" })).toMatch(/Hourly/);

    const db2 = createTestDb();
    const t2 = new SpendTracker(db2.raw);
    // Simulate earlier hours of the day directly in the table.
    const today = new Date().toISOString().slice(0, 10);
    db2.raw
      .prepare(
        "INSERT INTO spend_tracking (id, tool_name, amount_cents, category, window_hour, window_day) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run("old-1", "t", 199, "inference", `${today}T00`, today);
    const guard2 = new SpendGuard({
      policy: { ...policy, maxX402PaymentCents: 100 },
      category: "inference",
      spendTracker: t2,
      getBalanceCents: async () => 100_000,
    });
    expect(await guard2.authorize({ amountCents: 1, host: "blockrun.ai" })).toBeNull();
    expect(await guard2.authorize({ amountCents: 2, host: "blockrun.ai" })).toMatch(/Daily/);
    db2.close();
  });

  it("refuses payments that would breach the reserve (upstream #396)", async () => {
    const guard = make(105); // $1.05 on-chain, reserve $1.00
    expect(await guard.authorize({ amountCents: 5, host: "blockrun.ai" })).toBeNull();
    expect(await guard.authorize({ amountCents: 6, host: "blockrun.ai" })).toMatch(/reserve/);
  });

  it("counts recorded spend against the reserve until the next balance read", async () => {
    const guard = make(110);
    expect(await guard.authorize({ amountCents: 8, host: "blockrun.ai" })).toBeNull();
    guard.record({ amountCents: 8, host: "blockrun.ai", settled: true });
    // Cached balance still says 110, but 8 cents are already committed.
    expect(await guard.authorize({ amountCents: 3, host: "blockrun.ai" })).toMatch(/reserve/);
  });

  it("records spend in the persistent tracker", async () => {
    const guard = make(1000);
    guard.record({ amountCents: 0.5, host: "blockrun.ai", settled: true });
    guard.record({ amountCents: 0.25, host: "blockrun.ai", settled: false });
    expect(tracker.getDailySpend("inference")).toBeCloseTo(0.75, 5);
  });

  it("fails closed when the balance cannot be read", async () => {
    const guard = make(async () => {
      throw new Error("rpc down");
    });
    expect(await guard.authorize({ amountCents: 1, host: "blockrun.ai" })).toMatch(/unavailable/);
  });

  it("caches the balance read", async () => {
    const reader = vi.fn(async () => 1000);
    const guard = make(reader);
    await guard.authorize({ amountCents: 1, host: "blockrun.ai" });
    await guard.authorize({ amountCents: 1, host: "blockrun.ai" });
    expect(reader).toHaveBeenCalledTimes(1);
  });
});

/** Insert spend recorded earlier today (never matches the current hour window). */
function seedEarlierToday(db: AutomatonDatabase, category: string, amountCents: number, id: string) {
  const today = new Date().toISOString().slice(0, 10);
  db.raw
    .prepare(
      "INSERT INTO spend_tracking (id, tool_name, amount_cents, category, window_hour, window_day) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(id, "t", amountCents, category, `${today}T-earlier`, today);
}

describe("global daily cap (all categories combined)", () => {
  let db: AutomatonDatabase;
  let tracker: SpendTracker;

  beforeEach(() => {
    db = createTestDb();
    tracker = new SpendTracker(db.raw);
  });

  afterEach(() => {
    db.close();
  });

  const guardFor = (category: "inference" | "x402", overrides: Partial<TreasuryPolicy> = {}) =>
    new SpendGuard({
      policy: { ...policy, ...overrides },
      category,
      spendTracker: tracker,
      getBalanceCents: async () => 100_000,
    });

  it("caps x402_fetch at $2/day, not the $5/day x402 envelope", async () => {
    // Before the fix, x402 had its own 50 × $0.10 = $5/day envelope.
    seedEarlierToday(db, "x402", 195, "x-1");
    const guard = guardFor("x402");
    expect(await guard.authorize({ amountCents: 5, host: "blockrun.ai" })).toBeNull();
    expect(await guard.authorize({ amountCents: 1, host: "blockrun.ai" })).toMatch(/Global daily spend cap/);
  });

  it("counts inference and x402 spend together", async () => {
    seedEarlierToday(db, "inference", 120, "i-1");
    seedEarlierToday(db, "x402", 75, "x-1");
    // Each category is well under its own cap, but together they hit $2.
    expect(await guardFor("x402").authorize({ amountCents: 5, host: "blockrun.ai" })).toBeNull();
    expect(await guardFor("inference").authorize({ amountCents: 1, host: "blockrun.ai" })).toMatch(
      /Global daily spend cap/,
    );
  });

  it("also applies to transfers checked by the policy engine", () => {
    seedEarlierToday(db, "inference", 190, "i-1");
    const check = tracker.checkLimit(20, "transfer", policy);
    expect(check.allowed).toBe(false);
    expect(check.reason).toMatch(/Global daily spend cap/);
  });

  it("is configurable", async () => {
    seedEarlierToday(db, "x402", 195, "x-1");
    const guard = guardFor("x402", { maxTotalDailySpendCents: 1_000 });
    expect(await guard.authorize({ amountCents: 10, host: "blockrun.ai" })).toBeNull();
  });
});

describe("atomic check + record (reservation)", () => {
  let db: AutomatonDatabase;
  let tracker: SpendTracker;

  beforeEach(() => {
    db = createTestDb();
    tracker = new SpendTracker(db.raw);
  });

  afterEach(() => {
    db.close();
  });

  /** Balance read that resolves later, so concurrent callers interleave. */
  const slowBalance = () => new Promise<number>((resolve) => setTimeout(() => resolve(100_000), 5));

  it("parallel payments through one guard cannot exceed the cap", async () => {
    const guard = new SpendGuard({
      policy: { ...policy, maxTotalDailySpendCents: 50 },
      category: "x402",
      spendTracker: tracker,
      getBalanceCents: slowBalance,
    });
    const results = await Promise.all(
      Array.from({ length: 20 }, () => guard.authorize({ amountCents: 10, host: "blockrun.ai" })),
    );
    expect(results.filter((r) => r === null)).toHaveLength(5);
    expect(tracker.getTotalDailySpend()).toBe(50);
  });

  it("parallel workers with separate guards sharing the ledger cannot exceed the cap", async () => {
    // x402_fetch builds a fresh SpendGuard per call: only the DB is shared.
    const workers = Array.from(
      { length: 12 },
      () =>
        new SpendGuard({
          policy: { ...policy, maxTotalDailySpendCents: 30 },
          category: "x402",
          spendTracker: tracker,
          getBalanceCents: slowBalance,
        }),
    );
    const results = await Promise.all(workers.map((g) => g.authorize({ amountCents: 10, host: "blockrun.ai" })));
    expect(results.filter((r) => r === null)).toHaveLength(3);
    expect(tracker.getTotalDailySpend()).toBe(30);
  });

  it("records the spend at authorization; record() does not double count", async () => {
    const guard = new SpendGuard({ policy, category: "x402", spendTracker: tracker, getBalanceCents: async () => 1000 });
    expect(await guard.authorize({ amountCents: 4, host: "blockrun.ai" })).toBeNull();
    expect(tracker.getDailySpend("x402")).toBe(4);
    guard.record({ amountCents: 4, host: "blockrun.ai", settled: true });
    expect(tracker.getDailySpend("x402")).toBe(4);
  });

  it("release() cancels a reservation that was not charged", async () => {
    const guard = new SpendGuard({ policy, category: "x402", spendTracker: tracker, getBalanceCents: async () => 105 });
    expect(await guard.authorize({ amountCents: 5, host: "blockrun.ai" })).toBeNull();
    // Reserve is now exhausted by the pending reservation...
    expect(await guard.authorize({ amountCents: 1, host: "blockrun.ai" })).toMatch(/reserve/);
    guard.release({ amountCents: 5, host: "blockrun.ai" });
    expect(tracker.getDailySpend("x402")).toBe(0);
    // ...and freed again once released.
    expect(await guard.authorize({ amountCents: 1, host: "blockrun.ai" })).toBeNull();
  });

  it("reserveSpend is a single transaction (check and insert together)", () => {
    const limits = { ...policy, maxTotalDailySpendCents: 10 };
    const first = tracker.reserveSpend({ toolName: "t", amountCents: 10, category: "x402" }, limits);
    expect(first.allowed).toBe(true);
    expect(first.reservationId).toBeTruthy();
    const second = tracker.reserveSpend({ toolName: "t", amountCents: 1, category: "x402" }, limits);
    expect(second.allowed).toBe(false);
    expect(second.reservationId).toBeUndefined();
    tracker.releaseSpend(first.reservationId!);
    expect(tracker.getTotalDailySpend()).toBe(0);
  });
});
