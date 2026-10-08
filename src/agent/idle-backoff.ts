/**
 * Idle Sleep Backoff
 *
 * Every idle detector (maintenance loop, repetitive pattern, "no pending
 * inputs", consecutive idle turns, delegated work active) puts the agent to
 * sleep through this module. The sleep doubles on each consecutive idle
 * sleep (5 → 10 → 20 → 40 → 60 min by default) and the level is persisted in
 * KV so it survives the wake/sleep cycle. It only resets after a turn that
 * does real work or when an inbox message arrives.
 */

import type { AutomatonConfig, AutomatonDatabase } from "../types.js";

export const IDLE_BACKOFF_LEVEL_KEY = "idle_backoff_level";
export const DEFAULT_IDLE_SLEEP_BASE_SECONDS = 300;
export const DEFAULT_IDLE_SLEEP_MAX_SECONDS = 3600;

type BackoffConfig = Pick<AutomatonConfig, "idleSleepBaseSeconds" | "idleSleepMaxSeconds">;

function positiveOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Sleep duration (ms) for a given backoff level: base * 2^level, capped. */
export function computeIdleSleepMs(level: number, config?: BackoffConfig): number {
  const base = positiveOr(config?.idleSleepBaseSeconds, DEFAULT_IDLE_SLEEP_BASE_SECONDS);
  const max = Math.max(base, positiveOr(config?.idleSleepMaxSeconds, DEFAULT_IDLE_SLEEP_MAX_SECONDS));
  const safeLevel = Math.max(0, Math.min(30, Math.floor(level)));
  return Math.min(base * 2 ** safeLevel, max) * 1000;
}

export function getIdleBackoffLevel(db: Pick<AutomatonDatabase, "getKV">): number {
  const raw = parseInt(db.getKV(IDLE_BACKOFF_LEVEL_KEY) || "0", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

/**
 * Set sleep_until for the next idle sleep and bump the persisted level.
 * Returns the chosen sleep duration in ms.
 */
export function scheduleIdleSleep(
  db: Pick<AutomatonDatabase, "getKV" | "setKV">,
  config?: BackoffConfig,
  now: number = Date.now(),
): number {
  const level = getIdleBackoffLevel(db);
  const sleepMs = computeIdleSleepMs(level, config);
  db.setKV("sleep_until", new Date(now + sleepMs).toISOString());
  // Stop incrementing once the cap is reached so the level stays bounded.
  if (computeIdleSleepMs(level + 1, config) > sleepMs) {
    db.setKV(IDLE_BACKOFF_LEVEL_KEY, String(level + 1));
  }
  return sleepMs;
}

export function resetIdleBackoff(db: Pick<AutomatonDatabase, "deleteKV">): void {
  db.deleteKV(IDLE_BACKOFF_LEVEL_KEY);
}
