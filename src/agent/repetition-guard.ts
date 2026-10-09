/**
 * Near-identical tool-call repetition guard.
 *
 * The turn-level loop detector only catches byte-identical arguments, so a
 * model re-running "almost the same" command (another sed placeholder, `;`
 * instead of `&&`, a dropped timeout) evades it. This guard compares the
 * normalized arguments of each call with the recent calls of the same tool.
 */

/** Calls allowed before the next near-identical one is blocked. */
export const MAX_SIMILAR_CALLS = 5;
/** Window: the last N tool calls... */
export const REPETITION_WINDOW_CALLS = 10;
/** ...or the calls made in the last ~2 minutes. */
export const REPETITION_WINDOW_MS = 120_000;
/** Token-set Jaccard similarity at or above which two calls are "the same". */
export const SIMILARITY_THRESHOLD = 0.8;
/** Length of the last result quoted back to the model. */
export const RESULT_SNIPPET_CHARS = 500;

/** Bound on the text compared, so a huge write_file stays cheap. */
const MAX_NORMALIZED_CHARS = 4000;
/** Argument names that only tune how a call runs, not what it does. */
const TIMING_ARG = /timeout|duration|seconds|_ms$|^ms$/i;

/**
 * Normalize tool arguments into a set of tokens: lowercase, quotes and
 * punctuation stripped, whitespace collapsed, timeout-like numeric arguments
 * dropped.
 */
export function normalizeToolArgs(args: unknown): Set<string> {
  const parts: string[] = [];
  collectValues(args, undefined, parts);
  const text = parts
    .join(" ")
    .slice(0, MAX_NORMALIZED_CHARS)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  return new Set(text ? text.split(/\s+/) : []);
}

function collectValues(value: unknown, key: string | undefined, out: string[]): void {
  if (value === null || value === undefined) return;
  if (typeof value === "number" || (typeof value === "string" && /^\s*\d+(\.\d+)?\s*$/.test(value))) {
    if (key && TIMING_ARG.test(key)) return;
    out.push(String(value));
    return;
  }
  if (typeof value === "string" || typeof value === "boolean") {
    out.push(String(value));
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectValues(item, key, out);
    return;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      collectValues(v, k, out);
    }
  }
}

/** Token-set Jaccard similarity (two empty sets are identical). */
export function argsSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection++;
  }
  return intersection / (a.size + b.size - intersection);
}

export function areNearIdentical(argsA: unknown, argsB: unknown): boolean {
  return argsSimilarity(normalizeToolArgs(argsA), normalizeToolArgs(argsB)) >= SIMILARITY_THRESHOLD;
}

interface RecordedCall {
  name: string;
  tokens: Set<string>;
  at: number;
  result: string;
}

export interface RepetitionHit {
  tool: string;
  /** Similar calls already made, including the blocked one. */
  count: number;
  lastResult: string;
}

/**
 * In-memory history of recent tool calls. Nothing is persisted.
 */
export class RepetitionGuard {
  private history: RecordedCall[] = [];

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Check a call before running it. Returns a hit when the same tool was
   * already called with near-identical arguments MAX_SIMILAR_CALLS times in
   * the window (in a row, or within the last calls / ~2 minutes).
   */
  check(name: string, args: unknown): RepetitionHit | null {
    this.prune();
    const tokens = normalizeToolArgs(args);
    const similar = this.history.filter(
      (call) => call.name === name && argsSimilarity(call.tokens, tokens) >= SIMILARITY_THRESHOLD,
    );
    if (similar.length < MAX_SIMILAR_CALLS) return null;
    return {
      tool: name,
      count: similar.length + 1,
      lastResult: similar[similar.length - 1].result,
    };
  }

  record(name: string, args: unknown, result: string, at: number = this.now()): void {
    this.history.push({
      name,
      tokens: normalizeToolArgs(args),
      at,
      result: result.slice(0, RESULT_SNIPPET_CHARS),
    });
    this.prune();
  }

  reset(): void {
    this.history = [];
  }

  /** Keep the last REPETITION_WINDOW_CALLS calls plus anything younger than the time window. */
  private prune(): void {
    const cutoff = this.now() - REPETITION_WINDOW_MS;
    const firstKept = this.history.length - REPETITION_WINDOW_CALLS;
    this.history = this.history.filter((call, i) => i >= firstKept || call.at >= cutoff);
  }
}

/** Error recorded for a call the guard did not run. */
export function repetitionBlockedError(hit: RepetitionHit): string {
  return (
    `REPETITION: the tool was NOT run. You already called ${hit.tool} with nearly the same ` +
    `arguments ${hit.count - 1} times recently.`
  );
}

/**
 * Build a guard seeded with the tool calls of recently persisted turns
 * (oldest first) that fall inside the time window. Calls the guard blocked
 * are not seeded.
 */
export function createRepetitionGuard(
  recentTurns: ReadonlyArray<{
    timestamp: string;
    toolCalls: ReadonlyArray<{ name: string; arguments: unknown; result: string; error?: string }>;
  }>,
  now: () => number = Date.now,
): RepetitionGuard {
  const guard = new RepetitionGuard(now);
  const cutoff = now() - REPETITION_WINDOW_MS;
  for (const turn of recentTurns) {
    const at = Date.parse(turn.timestamp);
    if (!Number.isFinite(at) || at < cutoff) continue;
    for (const call of turn.toolCalls) {
      if (call.error?.startsWith("REPETITION:")) continue;
      guard.record(call.name, call.arguments, call.error ? `Error: ${call.error}` : call.result, at);
    }
  }
  return guard;
}

/**
 * The note injected into the next prompt after a blocked repetition. It is
 * passed as a `system` input, which the context builder renders with the
 * `[system] ` prefix.
 */
export function formatRepetitionNote(hit: RepetitionHit): string {
  const snippet = hit.lastResult.slice(0, RESULT_SNIPPET_CHARS);
  return (
    `REPETITION: you called ${hit.tool} with nearly the same arguments ${hit.count} times. ` +
    `The last result was: ${snippet || "(empty)"}. ` +
    `You already have this output. Do something different, or sleep briefly.`
  );
}
