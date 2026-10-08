/**
 * Difficulty-Based Model Escalation
 *
 * Routine work runs on the tier model. Hard work (planning, non-trivial
 * coding, explicit think_hard) is escalated to `blockrun.escalation.model`,
 * only in tiers high/normal and at most `maxCallsPerHour` calls per UTC
 * clock hour. The hourly count lives in the KV table so a restart does not
 * reset it. Escalated calls go through the same guarded x402 fetch and
 * spend caps as every other call: this module only picks the model.
 */

import type BetterSqlite3 from "better-sqlite3";
import type {
  InferenceResult,
  ModelEscalationConfig,
  SurvivalTier,
} from "../types.js";
import { DEFAULT_MODEL_ESCALATION } from "../types.js";
import type { UnifiedInferenceClient } from "./inference-client.js";
import { getX402Payment } from "../conway/x402-v2.js";
import { getSpendLimitRefusal } from "../agent/budget-sleep.js";

type Database = BetterSqlite3.Database;

/** Survival tiers in which escalation is allowed. */
export const ESCALATION_TIERS: ReadonlySet<SurvivalTier> = new Set<SurvivalTier>(["high", "normal"]);

const USAGE_KEY = "model_escalation.usage";
const THINK_HARD_KEY = "model_escalation.think_hard";
const MAX_REASON_LENGTH = 120;

/** Router outcomes that mean the call failed without producing an answer. */
const FAILED_FINISH_REASONS = new Set(["timeout", "error", "budget_exceeded"]);

export interface EscalationTicket {
  model: string;
  reason: string;
  hour: string;
  used: number;
  max: number;
}

interface HourlyUsage {
  hour: string;
  used: number;
  limitLogged: boolean;
}

/** Escalation settings with defaults; invalid values fall back to them. */
export function resolveModelEscalation(
  raw?: Partial<ModelEscalationConfig> | null,
): ModelEscalationConfig {
  const model =
    typeof raw?.model === "string" && raw.model.trim() !== ""
      ? raw.model.trim()
      : DEFAULT_MODEL_ESCALATION.model;
  const max = raw?.maxCallsPerHour;
  const maxCallsPerHour =
    typeof max === "number" && Number.isFinite(max) && max >= 0
      ? Math.floor(max)
      : DEFAULT_MODEL_ESCALATION.maxCallsPerHour;
  return { model, maxCallsPerHour };
}

/** UTC clock hour, e.g. "2026-10-08T20". */
export function utcHourKey(now: Date): string {
  return now.toISOString().slice(0, 13);
}

export function nextUtcHour(now: Date): Date {
  const next = new Date(now.getTime());
  next.setUTCMinutes(0, 0, 0);
  next.setUTCHours(next.getUTCHours() + 1);
  return next;
}

function formatHour(date: Date): string {
  return `${date.toISOString().slice(11, 16)}Z`;
}

/**
 * Why a call should be escalated, or null. An explicit think_hard wins,
 * then planning, then coding.
 */
export function escalationReason(input: {
  thinkHardReason?: string;
  planning?: boolean;
  coding?: boolean;
}): string | null {
  if (input.thinkHardReason) return `think_hard: ${input.thinkHardReason}`;
  if (input.planning) return "planning";
  if (input.coding) return "coding";
  return null;
}

/** Whether an error (or its causes) carries an x402 payment that was sent. */
export function errorWasCharged(err: unknown): boolean {
  let current: any = err;
  for (let depth = 0; current && typeof current === "object" && depth < 5; depth++) {
    if (getX402Payment(current)) return true;
    current = current.cause;
  }
  return false;
}

export class ModelEscalation {
  constructor(
    private readonly db: Database,
    readonly config: ModelEscalationConfig,
    private readonly log: (message: string) => void = () => {},
    private readonly now: () => Date = () => new Date(),
  ) {}

  get model(): string {
    return this.config.model;
  }

  /** Escalated calls used in the current UTC hour. */
  usage(): HourlyUsage {
    const hour = utcHourKey(this.now());
    const row = this.db.prepare("SELECT value FROM kv WHERE key = ?").get(USAGE_KEY) as
      | { value: string }
      | undefined;
    try {
      const parsed = row ? JSON.parse(row.value) : undefined;
      if (parsed && parsed.hour === hour && Number.isFinite(parsed.used)) {
        return { hour, used: Math.max(0, Number(parsed.used)), limitLogged: parsed.limitLogged === true };
      }
    } catch {
      // Corrupt value: start the hour over.
    }
    return { hour, used: 0, limitLogged: false };
  }

  private saveUsage(usage: HourlyUsage): void {
    this.setKV(USAGE_KEY, JSON.stringify(usage));
  }

  /**
   * Reserve one escalated call for `reason` in `tier`. Returns null (use the
   * tier model) when there is no reason, the tier does not allow escalation,
   * or the hourly limit is reached.
   */
  begin(tier: SurvivalTier, reason: string | null): EscalationTicket | null {
    if (!reason) return null;
    if (!ESCALATION_TIERS.has(tier)) {
      if (reason.startsWith("think_hard")) {
        this.log(`[MODEL] think_hard ignored in tier ${tier}: escalation only runs in tiers high/normal.`);
      }
      return null;
    }
    const max = this.config.maxCallsPerHour;
    const usage = this.usage();
    if (usage.used >= max) {
      if (!usage.limitLogged) {
        this.log(
          `[MODEL] Escalation limit reached (${usage.used}/${max} this hour); ` +
            `using the tier model until ${formatHour(nextUtcHour(this.now()))}.`,
        );
        this.saveUsage({ ...usage, limitLogged: true });
      }
      return null;
    }
    const used = usage.used + 1;
    this.saveUsage({ ...usage, used });
    this.log(`[MODEL] escalated to ${this.config.model} (reason: ${reason}) ${used}/${max} this hour`);
    return { model: this.config.model, reason, hour: usage.hour, used, max };
  }

  /** Give back a reserved call that failed without being charged. */
  release(ticket: EscalationTicket): void {
    const usage = this.usage();
    if (usage.hour !== ticket.hour || usage.used <= 0) return;
    this.saveUsage({ ...usage, used: usage.used - 1 });
  }

  /** think_hard: escalate the next agent turn, unless the hour is used up. */
  requestThinkHard(reason: string): { ok: boolean; message: string } {
    const max = this.config.maxCallsPerHour;
    const usage = this.usage();
    if (usage.used >= max) {
      return {
        ok: false,
        message:
          `think_hard refused: the escalation limit is reached (${usage.used}/${max} this hour). ` +
          `Escalation is unavailable until ${formatHour(nextUtcHour(this.now()))}; continue with the current model.`,
      };
    }
    const trimmed = reason.trim().slice(0, MAX_REASON_LENGTH);
    this.setKV(THINK_HARD_KEY, trimmed);
    return {
      ok: true,
      message:
        `Your next inference turn will use ${this.config.model} (${usage.used}/${max} escalated calls used this hour). ` +
        `It applies to that single turn only (and only in survival tiers high/normal), then reverts to your normal model.`,
    };
  }

  /** The pending think_hard reason, consumed: it only applies to one turn. */
  takeThinkHard(): string | undefined {
    const row = this.db.prepare("SELECT value FROM kv WHERE key = ?").get(THINK_HARD_KEY) as
      | { value: string }
      | undefined;
    if (!row) return undefined;
    this.db.prepare("DELETE FROM kv WHERE key = ?").run(THINK_HARD_KEY);
    return row.value || "unspecified";
  }

  private setKV(key: string, value: string): void {
    this.db
      .prepare("INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now'))")
      .run(key, value);
  }
}

/**
 * Run an agent turn on the escalation model when `ticket` is set. A call
 * that fails without being charged gives its slot back and the turn runs on
 * the tier model. A charged call (even timed out) keeps its slot. Spend-cap
 * refusals are rethrown: the tier model would be refused too.
 */
export async function routeWithEscalation(params: {
  escalation: ModelEscalation | undefined;
  ticket: EscalationTicket | null;
  run: (modelOverride?: string) => Promise<InferenceResult>;
  log?: (message: string) => void;
}): Promise<InferenceResult> {
  const { escalation, ticket, run } = params;
  const log = params.log ?? (() => {});
  if (!escalation || !ticket) return run(undefined);

  let result: InferenceResult;
  try {
    result = await run(ticket.model);
  } catch (err) {
    if (errorWasCharged(err)) throw err;
    escalation.release(ticket);
    if (getSpendLimitRefusal(err)) throw err;
    log(
      `[MODEL] Escalated call to ${ticket.model} failed (${err instanceof Error ? err.message : String(err)}); ` +
        `falling back to the tier model for this turn.`,
    );
    return run(undefined);
  }

  if (result.model !== ticket.model) {
    // The escalation model is not in the registry: the router already used
    // the tier model.
    escalation.release(ticket);
    return result;
  }
  if (FAILED_FINISH_REASONS.has(result.finishReason) && !(result.costCents > 0)) {
    escalation.release(ticket);
    log(
      `[MODEL] Escalated call to ${ticket.model} ended with "${result.finishReason}" without a charge; ` +
        `falling back to the tier model for this turn.`,
    );
    return run(undefined);
  }
  return result;
}

export type PlannerInference = Pick<UnifiedInferenceClient, "chat">;

/**
 * Planner inference that escalates the planner's own calls (tier
 * "reasoning": planGoal / replanAfterFailure). Other calls (classifiers,
 * the lowCompute JSON retry) are passed through unchanged. Workers do not
 * use this client.
 */
export function createEscalatingPlannerInference(params: {
  inner: Pick<UnifiedInferenceClient, "chat" | "chatDirect">;
  escalation: ModelEscalation;
  providerId: string;
  getTier: () => SurvivalTier | undefined;
  log?: (message: string) => void;
}): PlannerInference {
  const { inner, escalation, providerId, getTier } = params;
  const log = params.log ?? (() => {});
  return {
    chat: async (request) => {
      const tier = request.tier === "reasoning" ? getTier() : undefined;
      const ticket = tier ? escalation.begin(tier, "planning") : null;
      if (!ticket) return inner.chat(request);
      try {
        return await inner.chatDirect({ ...request, providerId, modelId: ticket.model });
      } catch (err) {
        if (errorWasCharged(err)) throw err;
        escalation.release(ticket);
        if (getSpendLimitRefusal(err)) throw err;
        log(
          `[MODEL] Escalated planner call to ${ticket.model} failed (${err instanceof Error ? err.message : String(err)}); ` +
            `falling back to the tier model.`,
        );
        return inner.chat(request);
      }
    },
  };
}
