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
