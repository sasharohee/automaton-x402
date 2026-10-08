/**
 * Budget Sleep
 *
 * A spend-cap refusal (hourly, daily or global daily) is not a turn error:
 * every retry before the cap's window resets would be refused again. The
 * agent sleeps until the window resets instead, and early wake-ups are
 * ignored until then.
 */

import type { SpendLimitRefusal, SpendLimitType } from "../types.js";

/** KV key holding the ISO time until which a spend cap keeps the agent asleep. */
export const BUDGET_SLEEP_UNTIL_KEY = "budget_sleep_until";

/** Margin after the window boundary, so the new window is surely open. */
const RESET_MARGIN_MS = 5_000;

interface KVStore {
  getKV(key: string): string | undefined;
}

/**
 * The structured cap refusal carried by an error (X402PaymentError with
 * code GUARD_REFUSED and a `limit`), looking through `cause` chains.
 * Returns null for any other error, including non-cap guard refusals.
 */
export function getSpendLimitRefusal(err: unknown): SpendLimitRefusal | null {
  let current: any = err;
  for (let depth = 0; current && typeof current === "object" && depth < 5; depth++) {
    if (current.code === "GUARD_REFUSED" && isSpendLimitRefusal(current.limit)) {
      return current.limit;
    }
    current = current.cause;
  }
  return null;
}

function isSpendLimitRefusal(value: unknown): value is SpendLimitRefusal {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    (v.limitType === "hourly" || v.limitType === "daily" || v.limitType === "global_daily") &&
    typeof v.currentCents === "number" &&
    typeof v.limitCents === "number"
  );
}

/**
 * When the refusing window resets: the start of the next UTC hour for the
 * hourly cap, the next UTC midnight for daily caps (plus a small margin).
 */
export function budgetWindowResetAt(limitType: SpendLimitType, now: Date = new Date()): Date {
  const reset = new Date(now.getTime());
  if (limitType === "hourly") {
    reset.setUTCMinutes(0, 0, 0);
    reset.setUTCHours(reset.getUTCHours() + 1);
  } else {
    reset.setUTCHours(0, 0, 0, 0);
    reset.setUTCDate(reset.getUTCDate() + 1);
  }
  return new Date(reset.getTime() + RESET_MARGIN_MS);
}

/** The active budget sleep deadline, or null if none is pending. */
export function getActiveBudgetSleep(db: KVStore, now: Date = new Date()): Date | null {
  const raw = db.getKV(BUDGET_SLEEP_UNTIL_KEY);
  if (!raw) return null;
  const until = new Date(raw);
  if (Number.isNaN(until.getTime()) || until <= now) return null;
  return until;
}

function formatUtc(date: Date, timeOnly: boolean): string {
  const iso = date.toISOString().replace(/\.\d{3}Z$/, "Z");
  return timeOnly ? iso.slice(11) : iso;
}

/**
 * One log line, e.g.
 * `[BUDGET] Hourly inference cap reached (83.87c of 84c). Sleeping until 19:00:05Z.`
 */
export function formatBudgetSleepLog(refusal: SpendLimitRefusal, until: Date): string {
  const label =
    refusal.limitType === "hourly"
      ? `Hourly ${refusal.category} cap`
      : refusal.limitType === "daily"
        ? `Daily ${refusal.category} cap`
        : "Global daily spend cap";
  const current = Math.round(refusal.currentCents * 100) / 100;
  return `[BUDGET] ${label} reached (${current}c of ${refusal.limitCents}c). Sleeping until ${formatUtc(until, refusal.limitType === "hourly")}.`;
}
