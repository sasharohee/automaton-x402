/**
 * Business Heuristic
 *
 * Decides whether an agent turn is business work, so it can be escalated
 * to the stronger model. Deterministic and cheap, in this order:
 *   - business:inbox: the turn carries claimed inbox / creator messages,
 *     the agent was woken by a message, or the previous turn read messages
 *     (this turn replies to them);
 *   - business:decision: the previous turn created, updated, completed or
 *     cancelled a goal or task;
 *   - business:acquisition: the previous turn used an acquisition tool
 *     (agent card, registry, discovery, outgoing message), or the active
 *     goal / current task is about customers, listings, marketing, outreach,
 *     sales or pricing (unless the previous turn was pure maintenance).
 * Routine turns (status checks, sleeping, log reading) return null.
 */

import type BetterSqlite3 from "better-sqlite3";
import type { ToolCallResult } from "../types.js";
import { isIdleOnlyTool } from "./idle-only-tools.js";

type Database = BetterSqlite3.Database;

export type BusinessReason = "business:inbox" | "business:acquisition" | "business:decision";

type ToolCallSummary = Pick<ToolCallResult, "name" | "error">;

export interface WakeEventSummary {
  source: string;
  reason: string;
}

export interface BusinessSignals {
  /** Inbox messages claimed for this turn. */
  claimedMessages?: number;
  /** Source of this turn's input ("agent" = inbox messages, "creator", "wakeup", ...). */
  inputSource?: string;
  /** Wake events that started this wake (first turn of a wake only). */
  wakeEvents?: readonly WakeEventSummary[];
  /** The previous turn: whether it read messages, and its tool calls. */
  previousTurn?: {
    hadInbox?: boolean;
    inputSource?: string;
    toolCalls: readonly ToolCallSummary[];
  };
  /** Title and description of the active goals and running tasks. */
  focusTexts?: readonly string[];
}

/** Input sources that carry messages from someone else. */
const MESSAGE_INPUT_SOURCES: ReadonlySet<string> = new Set(["agent", "creator"]);

/** Wake event sources that mean someone sent a message or a request. */
const MESSAGE_WAKE_SOURCES: ReadonlySet<string> = new Set(["creator", "inbox", "customer", "social"]);
const MESSAGE_WAKE_REASON = /\bnew message|\bcreator\b|\bcustomer\b|\binbox\b|\bclient\b/i;

/** Goal and task tools: using one is a business decision. */
export const DECISION_TOOLS: ReadonlySet<string> = new Set([
  "create_goal",
  "cancel_goal",
  "complete_goal",
  "complete_task",
  "set_goal",
]);

/** Tools that make the agent visible to customers or reach out to them. */
export const ACQUISITION_TOOLS: ReadonlySet<string> = new Set([
  "update_agent_card",
  "register_erc8004",
  "discover_agents",
  "send_message",
]);

/** Customer acquisition keywords (FR + EN), matched without accents. */
const ACQUISITION_KEYWORDS: readonly RegExp[] = [
  /\bclients?\b/,
  /\bcustomers?\b/,
  /\bprospect/,
  /\bannuaires?\b/,
  /\bdirector(y|ies)\b/,
  /\blistings?\b/,
  /\breferencement\b/,
  /\bmarketing\b/,
  /\boutreach\b/,
  /\bventes?\b/,
  /\bsales\b/,
  /\bpricing\b/,
  /\btarif/,
  /\bbazaar\b/,
  /x402scan/,
  /8004/,
];

function normalize(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

export function isAcquisitionText(text: unknown): boolean {
  if (typeof text !== "string" || text.trim() === "") return false;
  const normalized = normalize(text);
  return ACQUISITION_KEYWORDS.some((keyword) => keyword.test(normalized));
}

export function isMessageWakeEvent(event: WakeEventSummary): boolean {
  return MESSAGE_WAKE_SOURCES.has(event.source) || MESSAGE_WAKE_REASON.test(event.reason ?? "");
}

function usedTool(toolCalls: readonly ToolCallSummary[], names: ReadonlySet<string>): boolean {
  return toolCalls.some((tc) => names.has(tc.name) && !tc.error);
}

/** A turn that only checked status, read state or slept. */
export function isRoutineTurn(toolCalls: readonly ToolCallSummary[]): boolean {
  return toolCalls.length > 0 && toolCalls.every((tc) => tc.name === "sleep" || isIdleOnlyTool(tc.name));
}

/** Why this turn is business work, or null for routine work. */
export function businessReason(signals: BusinessSignals): BusinessReason | null {
  const previous = signals.previousTurn;
  const previousCalls = previous?.toolCalls ?? [];

  if (
    (signals.claimedMessages ?? 0) > 0 ||
    MESSAGE_INPUT_SOURCES.has(signals.inputSource ?? "") ||
    (signals.wakeEvents ?? []).some(isMessageWakeEvent) ||
    previous?.hadInbox === true ||
    MESSAGE_INPUT_SOURCES.has(previous?.inputSource ?? "")
  ) {
    return "business:inbox";
  }

  if (usedTool(previousCalls, DECISION_TOOLS)) return "business:decision";

  if (usedTool(previousCalls, ACQUISITION_TOOLS)) return "business:acquisition";
  if (!isRoutineTurn(previousCalls) && (signals.focusTexts ?? []).some(isAcquisitionText)) {
    return "business:acquisition";
  }
  return null;
}

/**
 * Title and description of the active goals and of the tasks being worked
 * on: what the agent is currently focused on.
 */
export function loadBusinessFocus(db: Database): string[] {
  const rows = db
    .prepare(
      `SELECT title, description FROM goals WHERE status = 'active'
       UNION ALL
       SELECT title, description FROM task_graph WHERE status IN ('assigned', 'running')`,
    )
    .all() as { title: string | null; description: string | null }[];
  return rows.map((row) => `${row.title ?? ""}\n${row.description ?? ""}`);
}

/** How long before the agent loop started a consumed wake event still counts. */
const WAKE_EVENT_LEAD_MS = 60_000;

/**
 * Wake events that started this wake: the event that woke the agent
 * (consumed by the outer run loop just before the agent loop started) and
 * the stale ones the agent loop drains when it starts.
 */
export function loadWakeEvents(db: Database, loopStartedAt: Date): WakeEventSummary[] {
  // SQLite datetime('now') format: 'YYYY-MM-DD HH:MM:SS'.
  const since = new Date(loopStartedAt.getTime() - WAKE_EVENT_LEAD_MS)
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d{3}Z$/, "");
  return db
    .prepare(
      `SELECT source, reason FROM wake_events
       WHERE consumed_at IS NOT NULL AND consumed_at >= ?
       ORDER BY id DESC LIMIT 20`,
    )
    .all(since) as WakeEventSummary[];
}
