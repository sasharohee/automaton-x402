/**
 * Spend Tracker
 *
 * DB-backed spend tracking with hourly/daily window aggregation.
 * Implements SpendTrackerInterface for policy engine integration.
 */

import { ulid } from "ulid";
import type Database from "better-sqlite3";
import type {
  SpendTrackerInterface,
  SpendEntry,
  SpendCategory,
  TreasuryPolicy,
  LimitCheckResult,
  SpendReservationResult,
} from "../types.js";
import {
  insertSpendRecord,
  getSpendByWindow,
  pruneSpendRecords,
} from "../state/database.js";
import type { SpendTrackingRow } from "../state/database.js";

/** Whether an optional cap value is set: a positive finite number. */
export function isPositiveCap(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * The hourly inference cap: `maxInferenceHourlyCents` when set, otherwise
 * derived from the daily budget (daily / 6), so the whole daily budget
 * cannot be consumed in one hour.
 */
export function inferenceHourlyCap(
  limits: Pick<TreasuryPolicy, "maxInferenceDailyCents" | "maxInferenceHourlyCents">,
): { cents: number; explicit: boolean } {
  if (isPositiveCap(limits.maxInferenceHourlyCents)) {
    return { cents: limits.maxInferenceHourlyCents, explicit: true };
  }
  return { cents: Math.ceil(limits.maxInferenceDailyCents / 6), explicit: false };
}

/** For the startup caps line, e.g. "$0.84/hour inference (derived: daily / 6)". */
export function formatInferenceHourlyCap(
  limits: Pick<TreasuryPolicy, "maxInferenceDailyCents" | "maxInferenceHourlyCents">,
): string {
  const cap = inferenceHourlyCap(limits);
  return `$${(cap.cents / 100).toFixed(2)}/hour inference (${cap.explicit ? "maxInferenceHourlyCents" : "derived: daily / 6"})`;
}

/**
 * Compute (Fluence) caps: both must be set (> 0), otherwise compute spending
 * is disabled.
 */
export function computeCaps(
  limits: Pick<TreasuryPolicy, "maxComputeTopupCents" | "maxComputeMonthlyCents">,
): { topupCents: number; monthlyCents: number } | null {
  if (!isPositiveCap(limits.maxComputeTopupCents) || !isPositiveCap(limits.maxComputeMonthlyCents)) {
    return null;
  }
  return { topupCents: limits.maxComputeTopupCents, monthlyCents: limits.maxComputeMonthlyCents };
}

/** Current UTC calendar month: '2026-02'. */
function getCurrentMonthWindow(): string {
  return new Date().toISOString().slice(0, 7);
}

/** Compute rows are kept at least this long, so the monthly sum stays complete. */
export const COMPUTE_SPEND_RETENTION_DAYS = 35;

/**
 * Get the current hour window string in ISO format: '2026-02-19T14'
 */
function getCurrentHourWindow(): string {
  const now = new Date();
  return now.toISOString().slice(0, 13); // '2026-02-19T14'
}

/**
 * Get the current day window string in ISO format: '2026-02-19'
 */
function getCurrentDayWindow(): string {
  const now = new Date();
  return now.toISOString().slice(0, 10); // '2026-02-19'
}

export class SpendTracker implements SpendTrackerInterface {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  recordSpend(entry: SpendEntry): void {
    const row: SpendTrackingRow = {
      id: ulid(),
      toolName: entry.toolName,
      amountCents: entry.amountCents,
      recipient: entry.recipient ?? null,
      domain: entry.domain ?? null,
      category: entry.category,
      windowHour: getCurrentHourWindow(),
      windowDay: getCurrentDayWindow(),
    };
    insertSpendRecord(this.db, row);
  }

  getHourlySpend(category: SpendCategory): number {
    const window = getCurrentHourWindow();
    return getSpendByWindow(this.db, category, "hour", window);
  }

  getDailySpend(category: SpendCategory): number {
    const window = getCurrentDayWindow();
    return getSpendByWindow(this.db, category, "day", window);
  }

  /**
   * Spend recorded today (UTC) across every category except `compute`,
   * which has its own monthly budget.
   */
  getTotalDailySpend(): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(amount_cents), 0) as total FROM spend_tracking WHERE window_day = ? AND category != 'compute'`,
      )
      .get(getCurrentDayWindow()) as { total: number };
    return row.total;
  }

  /** Spend recorded in the current UTC calendar month for a category. */
  getMonthlySpend(category: SpendCategory): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(amount_cents), 0) as total FROM spend_tracking WHERE category = ? AND substr(window_day, 1, 7) = ?`,
      )
      .get(category, getCurrentMonthWindow()) as { total: number };
    return row.total;
  }

  /**
   * Atomically check the caps and record the spend (a reservation).
   * Runs in a single IMMEDIATE transaction, so concurrent callers — in this
   * process or another one sharing the database — cannot both pass the
   * check before either has recorded its spend.
   */
  reserveSpend(entry: SpendEntry, limits: TreasuryPolicy): SpendReservationResult {
    const reserve = this.db.transaction((): SpendReservationResult => {
      const check = this.checkLimit(entry.amountCents, entry.category, limits);
      if (!check.allowed) return check;
      const id = ulid();
      insertSpendRecord(this.db, {
        id,
        toolName: entry.toolName,
        amountCents: entry.amountCents,
        recipient: entry.recipient ?? null,
        domain: entry.domain ?? null,
        category: entry.category,
        windowHour: getCurrentHourWindow(),
        windowDay: getCurrentDayWindow(),
      });
      return { ...check, reservationId: id };
    });
    return reserve.immediate();
  }

  /** Cancel a reservation whose payment was never sent / not charged. */
  releaseSpend(reservationId: string): void {
    this.db.prepare("DELETE FROM spend_tracking WHERE id = ?").run(reservationId);
  }

  getTotalSpend(category: SpendCategory, since: Date): number {
    // SQLite datetime('now') stores as 'YYYY-MM-DD HH:MM:SS' (no T, no Z)
    // Convert the since Date to the same format for comparison
    const sinceStr = since.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(amount_cents), 0) as total FROM spend_tracking WHERE category = ? AND created_at >= ?`,
      )
      .get(category, sinceStr) as { total: number };
    return row.total;
  }

  checkLimit(
    amount: number,
    category: SpendCategory,
    limits: TreasuryPolicy,
  ): LimitCheckResult {
    if (category === "compute") return this.checkComputeLimit(amount, limits);

    const currentHourlySpend = this.getHourlySpend(category);
    const currentDailySpend = this.getDailySpend(category);

    let limitHourly: number;
    let limitDaily: number;
    let hourlyCapExplicit: boolean | undefined;

    if (category === "transfer") {
      limitHourly = limits.maxHourlyTransferCents;
      limitDaily = limits.maxDailyTransferCents;
    } else if (category === "x402") {
      // x402 payments have their own per-payment cap; use a reasonable
      // hourly/daily envelope derived from the per-payment maximum
      limitHourly = limits.maxX402PaymentCents * 10;
      limitDaily = limits.maxX402PaymentCents * 50;
    } else {
      const hourlyCap = inferenceHourlyCap(limits);
      limitHourly = hourlyCap.cents;
      hourlyCapExplicit = hourlyCap.explicit;
      limitDaily = limits.maxInferenceDailyCents;
    }

    if (currentHourlySpend + amount > limitHourly) {
      return {
        allowed: false,
        reason: `Hourly spend cap exceeded: current ${currentHourlySpend} + ${amount} > ${limitHourly}`,
        limitType: "hourly",
        currentHourlySpend,
        currentDailySpend,
        limitHourly,
        limitDaily,
        ...(hourlyCapExplicit !== undefined ? { hourlyCapExplicit } : {}),
      };
    }

    if (currentDailySpend + amount > limitDaily) {
      return {
        allowed: false,
        reason: `Daily spend cap exceeded: current ${currentDailySpend} + ${amount} > ${limitDaily}`,
        limitType: "daily",
        currentHourlySpend,
        currentDailySpend,
        limitHourly,
        limitDaily,
      };
    }

    // Global cap, all categories combined (inference + x402 + transfers + other).
    const limitTotal = limits.maxTotalDailySpendCents;
    if (typeof limitTotal === "number" && Number.isFinite(limitTotal)) {
      const totalDailySpend = this.getTotalDailySpend();
      if (totalDailySpend + amount > limitTotal) {
        return {
          allowed: false,
          reason: `Global daily spend cap exceeded (all categories): current ${totalDailySpend} + ${amount} > ${limitTotal}`,
          limitType: "global_daily",
          currentHourlySpend,
          currentDailySpend,
          limitHourly,
          limitDaily,
          currentTotalDailySpend: totalDailySpend,
          limitTotalDaily: limitTotal,
        };
      }
    }

    return {
      allowed: true,
      currentHourlySpend,
      currentDailySpend,
      limitHourly,
      limitDaily,
    };
  }

  /**
   * Compute (Fluence) top-ups: per-top-up max and UTC calendar month total.
   * Not part of the daily caps. Refusals carry no `limitType`: they are not
   * windows the agent loop should sleep through.
   */
  private checkComputeLimit(amount: number, limits: TreasuryPolicy): LimitCheckResult {
    const caps = computeCaps(limits);
    const currentMonthlySpend = this.getMonthlySpend("compute");
    const base = {
      currentHourlySpend: currentMonthlySpend,
      currentDailySpend: currentMonthlySpend,
      limitHourly: caps?.monthlyCents ?? 0,
      limitDaily: caps?.monthlyCents ?? 0,
    };
    if (!caps) {
      return {
        allowed: false,
        reason: "Compute spending is disabled (set treasuryPolicy.maxComputeTopupCents and maxComputeMonthlyCents)",
        ...base,
      };
    }
    if (amount > caps.topupCents) {
      return {
        allowed: false,
        reason: `Compute top-up of ${amount} exceeds maxComputeTopupCents ${caps.topupCents}`,
        ...base,
      };
    }
    if (currentMonthlySpend + amount > caps.monthlyCents) {
      return {
        allowed: false,
        reason: `Monthly compute cap exceeded: current ${currentMonthlySpend} + ${amount} > ${caps.monthlyCents}`,
        ...base,
      };
    }
    return { allowed: true, ...base };
  }

  pruneOldRecords(retentionDays: number): number {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - retentionDays);
    // SQLite datetime('now') stores as 'YYYY-MM-DD HH:MM:SS' (no T, no Z)
    // Convert to the same format for correct string comparison
    const cutoffStr = cutoff.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
    return pruneSpendRecords(this.db, cutoffStr);
  }
}
