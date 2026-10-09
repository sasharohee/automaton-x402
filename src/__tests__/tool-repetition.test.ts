/**
 * Tool calls kept in context for text-less turns, near-identical repetition
 * guard, and Fluence tools counted as real work. Mocks only.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { buildContextMessages } from "../agent/context.js";
import { MUTATING_TOOLS, runAgentLoop } from "../agent/loop.js";
import {
  MAX_SIMILAR_CALLS,
  RepetitionGuard,
  areNearIdentical,
  argsSimilarity,
  createRepetitionGuard,
  formatRepetitionNote,
  normalizeToolArgs,
} from "../agent/repetition-guard.js";
import {
  MockInferenceClient,
  MockConwayClient,
  createTestDb,
  createTestIdentity,
  createTestConfig,
  toolCallResponse,
} from "./mocks.js";
import type { AgentTurn, AutomatonDatabase } from "../types.js";

const BASE = "ls ~/work/github; cat ~/work/github/*.md | sed 's/X/Y/'";
/** Six near-identical variants of the incident's command. */
const VARIANTS: Record<string, unknown>[] = [
  { command: BASE },
  { command: "ls ~/work/github && cat ~/work/github/*.md | sed 's/X/Y/'" },
  { command: BASE, timeout: 30000 },
  { command: `ls ~/work/github;cat "~/work/github/*.md" | sed 's/X/Y/'` },
  { command: `LS  ~/work/github ; cat ~/work/github/*.md | sed "s/X/Y/"`, timeout: 5000 },
  { command: "ls ~/work/github; cat ~/work/github/*.md | sed 's/X/Z/'" },
];

describe("buildContextMessages: tool-call-only turns", () => {
  it("keeps a turn with empty thinking and one exec call", () => {
    const turn: AgentTurn = {
      id: "t1",
      timestamp: new Date().toISOString(),
      state: "running",
      thinking: "",
      toolCalls: [
        {
          id: "call_1",
          name: "exec",
          arguments: { command: "ls ~/work" },
          result: "README.md",
          durationMs: 5,
        },
      ],
      tokenUsage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      costCents: 0,
    };

    const messages = buildContextMessages("system prompt", [turn]);
    const assistant = messages.find((m) => m.role === "assistant");
    expect(assistant).toBeDefined();
    expect(assistant!.content).toBe("");
    expect(assistant!.tool_calls).toEqual([
      {
        id: "call_1",
        type: "function",
        function: { name: "exec", arguments: JSON.stringify({ command: "ls ~/work" }) },
      },
    ]);
    const tool = messages.find((m) => m.role === "tool");
    expect(tool).toMatchObject({ tool_call_id: "call_1", content: "README.md" });
    expect(messages.indexOf(tool!)).toBe(messages.indexOf(assistant!) + 1);
  });

  it("still skips a turn with neither text nor tool calls", () => {
    const turn: AgentTurn = {
      id: "t2",
      timestamp: new Date().toISOString(),
      state: "running",
      thinking: "",
      toolCalls: [],
      tokenUsage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      costCents: 0,
    };
    const messages = buildContextMessages("system prompt", [turn]);
    expect(messages.some((m) => m.role === "assistant")).toBe(false);
  });
});

describe("near-identical similarity", () => {
  it("normalizes case, quotes, punctuation, separators and timeout args", () => {
    expect(normalizeToolArgs({ command: `LS "a/b";  cat 'c'`, timeout: 30000 })).toEqual(
      new Set(["ls", "a", "b", "cat", "c"]),
    );
    expect(normalizeToolArgs({ command: "sleep", timeout_ms: 10, durationSeconds: 5 })).toEqual(
      new Set(["sleep"]),
    );
    // Numbers that are not timing arguments are kept.
    expect(normalizeToolArgs({ port: 8787 })).toEqual(new Set(["8787"]));
  });

  it("treats the incident's variants as near-identical", () => {
    for (const variant of VARIANTS) {
      expect(areNearIdentical(VARIANTS[0], variant)).toBe(true);
    }
  });

  it("does not treat different commands as near-identical", () => {
    expect(areNearIdentical({ command: "npm test" }, { command: "npm run build" })).toBe(false);
    expect(
      areNearIdentical({ command: "cat ~/work/a.md" }, { command: "node ~/work/server.js" }),
    ).toBe(false);
  });

  it("computes token-set Jaccard similarity", () => {
    expect(argsSimilarity(new Set(["a", "b"]), new Set(["a", "b"]))).toBe(1);
    expect(argsSimilarity(new Set(["a", "b"]), new Set(["b", "c"]))).toBeCloseTo(1 / 3);
    expect(argsSimilarity(new Set(), new Set())).toBe(1);
  });
});

describe("RepetitionGuard", () => {
  it("allows 5 near-identical calls and blocks the 6th", () => {
    const guard = new RepetitionGuard();
    for (let i = 0; i < MAX_SIMILAR_CALLS; i++) {
      expect(guard.check("exec", VARIANTS[i])).toBeNull();
      guard.record("exec", VARIANTS[i], `result ${i}`);
    }
    const hit = guard.check("exec", VARIANTS[5]);
    expect(hit).toEqual({ tool: "exec", count: 6, lastResult: "result 4" });
  });

  it("counts near-identical calls within the last 10 calls, not only in a row", () => {
    const guard = new RepetitionGuard();
    for (let i = 0; i < MAX_SIMILAR_CALLS; i++) {
      guard.record("exec", VARIANTS[i], "out");
      guard.record("write_file", { path: `~/work/f${i}.ts`, content: `const x${i} = ${i};` }, "ok");
    }
    // 10 calls in history, 5 of them near-identical to the incident command.
    expect(guard.check("exec", VARIANTS[5])).not.toBeNull();
  });

  it("does not compare different tools or different commands", () => {
    const guard = new RepetitionGuard();
    for (let i = 0; i < 6; i++) guard.record("read_file", { path: BASE }, "out");
    expect(guard.check("exec", { command: BASE })).toBeNull();
    for (let i = 0; i < 6; i++) guard.record("exec", { command: `npm run step${i} --flag${i}` }, "out");
    expect(guard.check("exec", { command: "npm run step9 --flag9" })).toBeNull();
  });

  it("forgets calls older than the last 10 calls and ~2 minutes", () => {
    let now = 1_000_000;
    const guard = new RepetitionGuard(() => now);
    for (let i = 0; i < 5; i++) guard.record("exec", VARIANTS[i], "out");
    expect(guard.check("exec", VARIANTS[5])).not.toBeNull();
    for (let i = 0; i < 10; i++) guard.record("exec", { command: `echo unrelated ${i} ${"z".repeat(i)}` }, "x");
    // Still within 2 minutes: the time window keeps them.
    expect(guard.check("exec", VARIANTS[5])).not.toBeNull();
    now += 121_000;
    expect(guard.check("exec", VARIANTS[5])).toBeNull();
  });

  it("is seeded from recently persisted turns only", () => {
    const now = Date.parse("2026-10-09T12:00:00Z");
    const recent = new Date(now - 30_000).toISOString();
    const old = new Date(now - 10 * 60_000).toISOString();
    const turn = (timestamp: string, args: unknown) => ({
      timestamp,
      toolCalls: [{ name: "exec", arguments: args, result: "listing" }],
    });
    const fresh = createRepetitionGuard(VARIANTS.slice(0, 5).map((v) => turn(recent, v)), () => now);
    expect(fresh.check("exec", VARIANTS[5])).not.toBeNull();
    const stale = createRepetitionGuard(VARIANTS.slice(0, 5).map((v) => turn(old, v)), () => now);
    expect(stale.check("exec", VARIANTS[5])).toBeNull();
  });

  it("truncates the last result in the note to ~500 chars", () => {
    const guard = new RepetitionGuard();
    for (let i = 0; i < 5; i++) guard.record("exec", VARIANTS[i], "A".repeat(2000));
    const note = formatRepetitionNote(guard.check("exec", VARIANTS[5])!);
    expect(note).toBe(
      `REPETITION: you called exec with nearly the same arguments 6 times. ` +
        `The last result was: ${"A".repeat(500)}. You already have this output. ` +
        `Do something different, or sleep briefly.`,
    );
  });
});

describe("agent loop: near-identical repetition", () => {
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

  it("runs 5 near-identical calls, blocks the 6th and injects the note", async () => {
    const inference = new MockInferenceClient(
      VARIANTS.map((args) => toolCallResponse([{ name: "exec", arguments: args }])),
    );
    const turns: AgentTurn[] = [];

    await runAgentLoop({
      identity: createTestIdentity(),
      config: createTestConfig(),
      db,
      conway,
      inference,
      onTurnComplete: (turn) => turns.push(turn),
    });

    expect(conway.execCalls).toHaveLength(5);
    const blocked = turns[5].toolCalls[0];
    expect(blocked.name).toBe("exec");
    expect(blocked.error).toMatch(/^REPETITION: the tool was NOT run/);

    // The next prompt carries the note with the last result.
    const nextPrompt = inference.calls[6].messages;
    const last = nextPrompt[nextPrompt.length - 1];
    expect(last.role).toBe("user");
    // (consecutive user messages may be merged by the router)
    expect(last.content).toMatch(
      /(^|\n)\[system\] REPETITION: you called exec with nearly the same arguments 6 times\. The last result was: exit_code: 0/,
    );
    expect(last.content).toContain("You already have this output. Do something different, or sleep briefly.");
    // ...and the model sees its own previous (text-less) tool calls.
    expect(nextPrompt.filter((m) => m.role === "tool").length).toBeGreaterThanOrEqual(5);
  });

  it("sleeps briefly when the model repeats right after the note", async () => {
    const inference = new MockInferenceClient(
      [...VARIANTS, VARIANTS[0]].map((args) => toolCallResponse([{ name: "exec", arguments: args }])),
    );
    const before = Date.now();

    await runAgentLoop({
      identity: createTestIdentity(),
      config: createTestConfig(),
      db,
      conway,
      inference,
    });

    expect(conway.execCalls).toHaveLength(5);
    expect(inference.calls).toHaveLength(7);
    expect(db.getAgentState()).toBe("sleeping");
    const sleepMs = new Date(db.getKV("sleep_until")!).getTime() - before;
    expect(sleepMs).toBeGreaterThanOrEqual(55_000);
    expect(sleepMs).toBeLessThanOrEqual(65_000);
    expect(db.getKV("loop.idle_sleep_note")).toMatch(/^\[system\] REPETITION: /);
  });
});

describe("MUTATING_TOOLS", () => {
  it("includes the Fluence VM tools", () => {
    for (const tool of ["sandbox_exec", "sandbox_upload", "fluence_topup", "fluence_status"]) {
      expect(MUTATING_TOOLS.has(tool)).toBe(true);
    }
  });
});
