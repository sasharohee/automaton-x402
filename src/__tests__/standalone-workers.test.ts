/**
 * Standalone worker / planner fixes
 *
 *  - every worker harness, the planner and the replanner get the standalone
 *    notice (no inbound connectivity, outbound-only earning, no ETH, ~/work)
 *  - a task at max_retries never runs again; a replanner failure fails the
 *    goal without recreating the task; maxReplans defaults to 1
 *  - one local worker at a time, never two workers on the same task
 *  - repetition = same tools with the same arguments (parent and workers)
 *  - planner: JSON mode, large maxTokens, one retry with the lowCompute model
 *
 * Everything is mocked: no network, no wallet, no spending.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// No RPC call for the on-chain USDC balance.
vi.mock("../conway/x402.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../conway/x402.js")>();
  return { ...actual, getUsdcBalance: vi.fn(async () => 12.5) };
});

import { runAgentLoop } from "../agent/loop.js";
import { LoopDetector } from "../agent/loop-detector.js";
import { GeneralHarness } from "../agent/harnesses/general-harness.js";
import { CodingHarness } from "../agent/harnesses/coding-harness.js";
import { OrchestratorHarness } from "../agent/harnesses/orchestrator-harness.js";
import type { BaseHarness } from "../agent/harnesses/base-harness.js";
import type { AgentHarness, HarnessContext, HarnessTool } from "../agent/harness-types.js";
import { HarnessRegistry } from "../agent/harness-registry.js";
import { STANDALONE_PLANNER_NOTICE } from "../agent/standalone-notice.js";
import { Orchestrator } from "../orchestration/orchestrator.js";
import { SimpleAgentTracker } from "../orchestration/simple-tracker.js";
import { ColonyMessaging, LocalDBTransport } from "../orchestration/messaging.js";
import { LocalWorkerPool } from "../orchestration/local-worker.js";
import {
  planGoal,
  replanAfterFailure,
  STANDALONE_PLANNER_MAX_TOKENS,
  type PlannerContext,
  type PlannerOutput,
} from "../orchestration/planner.js";
import type { TaskNode, TaskResult } from "../orchestration/task-graph.js";
import {
  MockInferenceClient,
  MockConwayClient,
  createTestDb,
  createTestIdentity,
  createTestConfig,
  toolCallResponse,
  noToolResponse,
} from "./mocks.js";
import type { AutomatonDatabase } from "../types.js";

const STANDALONE = { providerMode: "standalone" } as const;

const VALID_PLAN: PlannerOutput = {
  analysis: "Feasible with outbound requests only.",
  strategy: "One local task.",
  customRoles: [],
  tasks: [{
    title: "New task",
    description: "Do the work under ~/work and deliver it over outbound HTTP.",
    agentRole: "generalist",
    dependencies: [],
    estimatedCostCents: 10,
    priority: 50,
    timeoutMs: 60_000,
  }],
  risks: [],
  estimatedTotalCostCents: 10,
  estimatedTimeMinutes: 5,
};

const TRUNCATED_JSON = '{"analysis": "The goal needs a public server so the summariz';

function insertGoal(db: AutomatonDatabase, id: string): void {
  db.raw.prepare(
    "INSERT INTO goals (id, title, description, status, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(id, "Goal", "Goal description", "active", new Date().toISOString());
}

function insertTask(
  db: AutomatonDatabase,
  params: { id: string; goalId: string; status: string; assignedTo?: string | null; retryCount?: number; maxRetries?: number },
): void {
  db.raw.prepare(
    `INSERT INTO task_graph
     (id, goal_id, title, description, status, assigned_to, agent_role, priority, dependencies,
      retry_count, max_retries, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    params.id, params.goalId, "Task", "Task description", params.status, params.assignedTo ?? null,
    "generalist", 50, "[]", params.retryCount ?? 0, params.maxRetries ?? 3, new Date().toISOString(),
  );
}

function setState(db: AutomatonDatabase, state: Record<string, unknown>): void {
  db.setKV("orchestrator.state", JSON.stringify({
    phase: "idle", goalId: null, replanCount: 0, failedTaskId: null, failedError: null, ...state,
  }));
}

function getState(db: AutomatonDatabase): { phase: string; goalId: string | null } {
  return JSON.parse(db.getKV("orchestrator.state")!);
}

function taskRows(db: AutomatonDatabase, goalId: string): Array<{ id: string; status: string; assigned_to: string | null }> {
  return db.raw.prepare(
    "SELECT id, status, assigned_to FROM task_graph WHERE goal_id = ? ORDER BY created_at, id",
  ).all(goalId) as any[];
}

function goalStatus(db: AutomatonDatabase, goalId: string): string {
  return (db.raw.prepare("SELECT status FROM goals WHERE id = ?").get(goalId) as { status: string }).status;
}

function makeOrchestrator(db: AutomatonDatabase, params: {
  config?: Record<string, unknown>;
  spawnAgent?: (task: any) => Promise<any>;
  inference?: any;
  isWorkerAlive?: (address: string) => boolean;
}): Orchestrator {
  return new Orchestrator({
    db: db.raw,
    agentTracker: new SimpleAgentTracker(db),
    funding: {
      fundChild: vi.fn(async () => ({ success: true })),
      recallCredits: vi.fn(async () => ({ success: true, amountCents: 0 })),
      getBalance: vi.fn(async () => 0),
    } as any,
    messaging: new ColonyMessaging(new LocalDBTransport(db), db),
    inference: params.inference ?? ({ chat: vi.fn(async () => { throw new Error("no inference in tests"); }) } as any),
    identity: createTestIdentity(),
    isWorkerAlive: params.isWorkerAlive,
    getFinancialState: () => ({ creditsCents: 1000, usdcBalance: 10 }),
    config: { ...(params.config ?? {}), spawnAgent: params.spawnAgent },
  });
}

function plannerContext(overrides: Partial<PlannerContext> = {}): PlannerContext {
  return {
    creditsCents: 1000,
    usdcBalance: 10,
    survivalTier: "normal",
    availableRoles: ["generalist"],
    customRoles: [],
    activeGoals: [],
    recentOutcomes: [],
    marketIntel: "none",
    idleAgents: 0,
    busyAgents: 0,
    maxAgents: 1,
    workspaceFiles: [],
    ...overrides,
  };
}

const GOAL_INPUT = {
  id: "goal-1",
  title: "Goal",
  description: "Goal description",
  status: "active",
  strategy: null,
  rootTasks: [],
  expectedRevenueCents: 0,
  actualRevenueCents: 0,
  createdAt: new Date().toISOString(),
  deadline: null,
};

/** Harness that stays busy until the test releases it. */
class GatedHarness implements AgentHarness {
  readonly id = "gated";
  readonly description = "gated harness";
  static gate: Promise<void> = Promise.resolve();
  async initialize(): Promise<void> {}
  async execute(): Promise<TaskResult> {
    await GatedHarness.gate;
    return { success: true, output: "done", artifacts: [], costCents: 0, duration: 1 };
  }
  getToolDefs(): HarnessTool[] { return []; }
  buildSystemPrompt(): string { return ""; }
  buildTaskPrompt(): string { return ""; }
}

function taskNode(id: string, goalId = "goal-1"): TaskNode {
  return {
    id,
    parentId: null,
    goalId,
    title: `Task ${id}`,
    description: "desc",
    status: "assigned",
    assignedTo: null,
    agentRole: "generalist",
    priority: 50,
    dependencies: [],
    result: null,
    metadata: {
      estimatedCostCents: 0,
      actualCostCents: 0,
      maxRetries: 3,
      retryCount: 0,
      timeoutMs: 60_000,
      createdAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
    },
  };
}

describe("standalone worker / planner fixes", () => {
  let db: AutomatonDatabase;
  let conway: MockConwayClient;
  let identity: ReturnType<typeof createTestIdentity>;

  beforeEach(() => {
    db = createTestDb();
    conway = new MockConwayClient();
    identity = createTestIdentity();
  });

  afterEach(() => {
    db.close();
  });

  // ─── A: standalone notice everywhere ─────────────────────────

  describe("standalone notice", () => {
    function harnessContext(config: ReturnType<typeof createTestConfig>): HarnessContext {
      return {
        workspaceRoot: "/tmp/ws",
        allowedEditRoot: "/home/node/work",
        workspace: { basePath: "/tmp/ws" } as any,
        identity,
        config,
        db: db.raw,
        conway,
        inference: { chat: async () => ({ content: "done" }) },
        budget: { maxTurns: 5, maxCostCents: 50, timeoutMs: 5_000, turnsUsed: 0, costUsedCents: 0, startedAt: 0 },
        wisdom: { conventions: [], successes: [], failures: [], gotchas: [] },
        abortSignal: new AbortController().signal,
        goalId: "goal-1",
      };
    }

    it("is in the system prompt of every worker harness in standalone mode", () => {
      for (const Harness of [GeneralHarness, CodingHarness, OrchestratorHarness]) {
        const harness = new Harness() as BaseHarness;
        (harness as any).context = harnessContext(createTestConfig(STANDALONE as any));
        (harness as any).task = taskNode("task-1");
        const prompt = harness.composeSystemPrompt();
        expect(prompt).toContain("You have NO inbound connectivity");
        expect(prompt).toContain("OUTBOUND requests");
        expect(prompt).toContain("You have no ETH");
        expect(prompt).toContain("Your working directory is /home/node/work");
        expect(prompt).toContain("call task_done immediately with success=false");
      }
    });

    it("is the first system message of an initialized worker", async () => {
      const harness = new GeneralHarness();
      await harness.initialize(taskNode("task-1"), harnessContext(createTestConfig(STANDALONE as any)));
      const system = String((harness as any).messages[0].content);
      expect(system).toContain("PROVIDER: STANDALONE");
      expect(system).toContain("WORKER RULES (standalone)");
    });

    it("is absent in Conway mode", () => {
      const harness = new GeneralHarness();
      (harness as any).context = harnessContext(createTestConfig());
      (harness as any).task = taskNode("task-1");
      expect(harness.composeSystemPrompt()).not.toContain("PROVIDER: STANDALONE");
    });

    it("is in the planner and replanner prompts, with JSON mode and a large maxTokens", async () => {
      const chat = vi.fn(async () => ({ content: JSON.stringify(VALID_PLAN) }));
      await planGoal(GOAL_INPUT, plannerContext({ standalone: true }), { chat } as any);
      await replanAfterFailure(
        GOAL_INPUT,
        { ...taskNode("task-1"), status: "failed" } as any,
        plannerContext({ standalone: true }),
        { chat } as any,
      );

      expect(chat).toHaveBeenCalledTimes(2);
      for (const [params] of chat.mock.calls as any[]) {
        expect(params.messages[0].content).toContain(STANDALONE_PLANNER_NOTICE);
        expect(params.messages[0].content).toContain("NEVER produce a task that assumes inbound connectivity");
        expect(params.responseFormat).toEqual({ type: "json_object" });
        expect(params.maxTokens).toBe(STANDALONE_PLANNER_MAX_TOKENS);
        expect(params.tier).toBe("reasoning");
      }
    });

    it("is not in the Conway-mode planner prompt", async () => {
      const chat = vi.fn(async () => ({ content: JSON.stringify(VALID_PLAN) }));
      await planGoal(GOAL_INPUT, plannerContext(), { chat } as any);
      const [params] = chat.mock.calls[0] as any[];
      expect(params.messages[0].content).not.toContain("standalone_runtime");
      expect(params.maxTokens).toBeUndefined();
    });
  });

  // ─── E: planner JSON retry ───────────────────────────────────

  describe("planner JSON retry (standalone)", () => {
    it("retries once with the lowCompute model (tier fast) after invalid JSON", async () => {
      const chat = vi.fn()
        .mockResolvedValueOnce({ content: TRUNCATED_JSON })
        .mockResolvedValueOnce({ content: JSON.stringify(VALID_PLAN) });
      const plan = await planGoal(GOAL_INPUT, plannerContext({ standalone: true }), { chat } as any);
      expect(plan.tasks).toHaveLength(1);
      expect(chat.mock.calls.map(([p]: any[]) => p.tier)).toEqual(["reasoning", "fast"]);
    });

    it("gives up after the single retry", async () => {
      const chat = vi.fn(async () => ({ content: TRUNCATED_JSON }));
      await expect(planGoal(GOAL_INPUT, plannerContext({ standalone: true }), { chat } as any))
        .rejects.toThrow(/invalid JSON/);
      expect(chat).toHaveBeenCalledTimes(2);
    });

    it("does not retry an inference/payment error", async () => {
      const chat = vi.fn(async () => { throw new Error("x402 payment refused"); });
      await expect(planGoal(GOAL_INPUT, plannerContext({ standalone: true }), { chat } as any))
        .rejects.toThrow(/payment refused/);
      expect(chat).toHaveBeenCalledTimes(1);
    });

    it("Conway mode keeps a single attempt", async () => {
      const chat = vi.fn(async () => ({ content: TRUNCATED_JSON }));
      await expect(planGoal(GOAL_INPUT, plannerContext(), { chat } as any)).rejects.toThrow(/invalid JSON/);
      expect(chat).toHaveBeenCalledTimes(1);
    });
  });

  // ─── B: no resurrection of exhausted tasks / failed goals ────

  describe("retries and replanning", () => {
    it("still runs the last legitimate retry of a pending task at max_retries", async () => {
      insertGoal(db, "goal-1");
      insertTask(db, { id: "task-1", goalId: "goal-1", status: "pending", retryCount: 3, maxRetries: 3 });
      setState(db, { phase: "executing", goalId: "goal-1" });
      const spawnAgent = vi.fn(async () => ({ address: "local://local-worker-X", name: "w", sandboxId: "x" }));

      const result = await makeOrchestrator(db, { config: STANDALONE, spawnAgent }).tick();

      expect(spawnAgent).toHaveBeenCalledTimes(1);
      expect(taskRows(db, "goal-1")[0].status).not.toBe("failed");
      expect(result.tasksAssigned).toBe(1);
      expect(result.tasksFailed).toBe(0);
    });

    it("never re-assigns a pending task past max_retries", async () => {
      insertGoal(db, "goal-1");
      insertTask(db, { id: "task-1", goalId: "goal-1", status: "pending", retryCount: 4, maxRetries: 3 });
      setState(db, { phase: "executing", goalId: "goal-1" });
      const spawnAgent = vi.fn(async () => ({ address: "local://local-worker-X", name: "w", sandboxId: "x" }));

      const result = await makeOrchestrator(db, { config: STANDALONE, spawnAgent }).tick();

      expect(spawnAgent).not.toHaveBeenCalled();
      expect(taskRows(db, "goal-1")[0].status).toBe("failed");
      expect(result.tasksAssigned).toBe(0);
      expect(result.tasksFailed).toBe(1);
    });

    it("a stale task at max_retries is failed, not recovered", async () => {
      insertGoal(db, "goal-1");
      insertTask(db, {
        id: "task-1", goalId: "goal-1", status: "running",
        assignedTo: "local://local-worker-GONE", retryCount: 3, maxRetries: 3,
      });
      setState(db, { phase: "executing", goalId: "goal-1" });
      const spawnAgent = vi.fn();

      await makeOrchestrator(db, { config: STANDALONE, spawnAgent, isWorkerAlive: () => false }).tick();

      expect(spawnAgent).not.toHaveBeenCalled();
      expect(taskRows(db, "goal-1")[0].status).toBe("failed");
    });

    it("replanner failure (truncated JSON) fails the goal without recreating the task", async () => {
      insertGoal(db, "goal-1");
      insertTask(db, { id: "task-1", goalId: "goal-1", status: "failed", retryCount: 3, maxRetries: 3 });
      setState(db, { phase: "replanning", goalId: "goal-1", failedTaskId: "task-1" });
      const chat = vi.fn(async () => ({ content: TRUNCATED_JSON }));
      const spawnAgent = vi.fn();
      const orchestrator = makeOrchestrator(db, { config: STANDALONE, spawnAgent, inference: { chat } });

      await orchestrator.tick();

      // Main model + one lowCompute retry, then give up.
      expect(chat).toHaveBeenCalledTimes(2);
      expect(goalStatus(db, "goal-1")).toBe("failed");
      expect(getState(db).phase).toBe("idle");
      const rows = taskRows(db, "goal-1");
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe("failed");

      // Next ticks: nothing is relaunched.
      await orchestrator.tick();
      await orchestrator.tick();
      expect(spawnAgent).not.toHaveBeenCalled();
      expect(taskRows(db, "goal-1")).toHaveLength(1);
    });

    it("replanner inference error fails the goal too (Conway mode as well)", async () => {
      insertGoal(db, "goal-1");
      insertTask(db, { id: "task-1", goalId: "goal-1", status: "failed", retryCount: 3, maxRetries: 3 });
      setState(db, { phase: "replanning", goalId: "goal-1", failedTaskId: "task-1" });

      await makeOrchestrator(db, {}).tick();

      expect(goalStatus(db, "goal-1")).toBe("failed");
      expect(getState(db).phase).toBe("idle");
      expect(taskRows(db, "goal-1")).toHaveLength(1);
    });

    it("a successful replan cancels the exhausted task instead of resetting it to pending", async () => {
      insertGoal(db, "goal-1");
      insertTask(db, { id: "task-1", goalId: "goal-1", status: "failed", retryCount: 3, maxRetries: 3 });
      setState(db, { phase: "replanning", goalId: "goal-1", failedTaskId: "task-1" });
      const chat = vi.fn(async () => ({ content: JSON.stringify(VALID_PLAN) }));

      await makeOrchestrator(db, { config: STANDALONE, inference: { chat } }).tick();

      const rows = taskRows(db, "goal-1");
      expect(rows.find((r) => r.id === "task-1")!.status).toBe("cancelled");
      const fresh = rows.filter((r) => r.id !== "task-1");
      expect(fresh).toHaveLength(1);
      expect(fresh[0].status).toBe("pending");
    });

    it("standalone defaults to a single replan", async () => {
      insertGoal(db, "goal-1");
      insertTask(db, { id: "task-1", goalId: "goal-1", status: "failed", retryCount: 3, maxRetries: 3 });
      setState(db, { phase: "executing", goalId: "goal-1", replanCount: 1 });

      await makeOrchestrator(db, { config: STANDALONE }).tick();
      expect(getState(db).phase).toBe("failed");

      // Conway mode keeps its default of 3.
      setState(db, { phase: "executing", goalId: "goal-1", replanCount: 1 });
      await makeOrchestrator(db, {}).tick();
      expect(getState(db).phase).toBe("replanning");
    });

    it("an infeasible standalone plan (no tasks) fails the goal instead of running it as one task", async () => {
      insertGoal(db, "goal-1");
      setState(db, { phase: "planning", goalId: "goal-1" });
      const chat = vi.fn(async () => ({
        content: JSON.stringify({ ...VALID_PLAN, analysis: "Needs inbound connectivity.", tasks: [] }),
      }));

      await makeOrchestrator(db, { config: STANDALONE, inference: { chat } }).tick();

      expect(goalStatus(db, "goal-1")).toBe("failed");
      expect(taskRows(db, "goal-1")).toHaveLength(0);
    });
  });

  // ─── C: one local worker at a time ───────────────────────────

  describe("single local worker", () => {
    let release: () => void;

    beforeEach(() => {
      GatedHarness.gate = new Promise<void>((resolve) => { release = resolve; });
    });

    afterEach(() => {
      release();
    });

    function createPool(maxConcurrent?: number): LocalWorkerPool {
      const registry = new HarnessRegistry();
      registry.setFallback(GatedHarness as any);
      registry.register("generalist", GatedHarness as any);
      return new LocalWorkerPool({
        db: db.raw,
        conway,
        inference: { chat: async () => ({ content: "done" }) },
        harnessRegistry: registry,
        identity,
        config: createTestConfig(STANDALONE as any),
        allowedEditRoot: "/tmp",
        maxConcurrent,
      });
    }

    it("refuses a second worker while one is running, then accepts after it finishes", async () => {
      insertGoal(db, "goal-1");
      insertTask(db, { id: "task-1", goalId: "goal-1", status: "assigned" });
      insertTask(db, { id: "task-2", goalId: "goal-1", status: "assigned" });
      const pool = createPool(1);

      pool.spawn(taskNode("task-1"));
      expect(pool.hasCapacity()).toBe(false);
      expect(() => pool.spawn(taskNode("task-2"))).toThrow(/limit reached/);
      expect(pool.getActiveCount()).toBe(1);

      release();
      await pool.shutdown();
      expect(pool.hasCapacity()).toBe(true);
    });

    it("never runs two workers on the same task", () => {
      insertGoal(db, "goal-1");
      insertTask(db, { id: "task-1", goalId: "goal-1", status: "assigned" });
      const pool = createPool(undefined);

      pool.spawn(taskNode("task-1"));
      expect(pool.isRunningTask("task-1")).toBe(true);
      expect(() => pool.spawn(taskNode("task-1"))).toThrow(/already running task task-1/);
      expect(pool.getActiveCount()).toBe(1);
    });

    it("the orchestrator leaves the task pending (never self-assigned to the parent) when the worker is busy", async () => {
      insertGoal(db, "goal-1");
      insertTask(db, { id: "task-1", goalId: "goal-1", status: "running", assignedTo: "local://local-worker-BUSY" });
      insertTask(db, { id: "task-2", goalId: "goal-1", status: "pending" });
      setState(db, { phase: "executing", goalId: "goal-1" });
      // Mirrors the standalone spawnAgent: no capacity → null.
      const spawnAgent = vi.fn(async () => null);

      const result = await makeOrchestrator(db, {
        config: STANDALONE,
        spawnAgent,
        isWorkerAlive: (address) => address === "local://local-worker-BUSY",
      }).tick();

      expect(spawnAgent).toHaveBeenCalledTimes(1);
      const task2 = taskRows(db, "goal-1").find((r) => r.id === "task-2")!;
      expect(task2.status).toBe("pending");
      expect(task2.assigned_to).toBeNull();
      expect(result.tasksAssigned).toBe(0);
    });
  });

  // ─── D: repetition = same tools with the same arguments ──────

  describe("repetition detection", () => {
    it("worker: three different exec commands are not a loop", () => {
      const detector = new LoopDetector({ maxIdenticalCalls: 3, maxIdleOnlyTurns: 3, windowSize: 10 });
      for (let i = 0; i < 9; i++) {
        expect(detector.recordToolCall("exec", JSON.stringify({ command: `npm run step-${i}` })).blocked).toBe(false);
        const check = detector.endTurn();
        expect(check.blocked).toBe(false);
        expect(check.reason).toBe("");
      }
    });

    it("worker: three identical exec turns warn, and repeating after the warning is enforced", () => {
      const detector = new LoopDetector({ maxIdenticalCalls: 10, maxIdleOnlyTurns: 3, windowSize: 10 });
      const args = JSON.stringify({ command: "npm test" });
      const results = [];
      for (let i = 0; i < 6; i++) {
        detector.recordToolCall("exec", args);
        results.push(detector.endTurn());
      }
      expect(results[2].blocked).toBe(false);
      expect(results[2].reason).toContain("WARNING");
      expect(results.some((r) => r.blocked && r.reason.includes("LOOP ENFORCEMENT"))).toBe(true);
    });

    it("worker: status-check-only turns still repeat by name", () => {
      const detector = new LoopDetector({ maxIdenticalCalls: 10, maxIdleOnlyTurns: 10, windowSize: 10 });
      const results = [];
      for (let i = 0; i < 3; i++) {
        detector.recordToolCall("check_credits", JSON.stringify({ nonce: i }));
        results.push(detector.endTurn());
      }
      expect(results[2].reason).toContain("WARNING");
    });

    it("parent: three different exec turns do not put the agent to sleep", async () => {
      const inference = new MockInferenceClient([
        toolCallResponse([{ name: "exec", arguments: { command: "mkdir -p ~/work/a" } }]),
        toolCallResponse([{ name: "exec", arguments: { command: "ls ~/work/a" } }]),
        toolCallResponse([{ name: "exec", arguments: { command: "echo done" } }]),
        noToolResponse("finished"),
      ]);
      await runAgentLoop({ identity, config: createTestConfig(), db, conway, inference });

      expect(inference.calls.length).toBe(4);
      expect(db.getKV("loop.idle_sleep_note") ?? "").not.toContain("LOOP DETECTED");
    });

    it("parent: three identical exec turns put the agent to sleep with backoff", async () => {
      const inference = new MockInferenceClient(
        Array.from({ length: 5 }, () => toolCallResponse([{ name: "exec", arguments: { command: "curl -s https://example.com" } }])),
      );
      await runAgentLoop({ identity, config: createTestConfig(), db, conway, inference });

      expect(inference.calls.length).toBe(3);
      expect(db.getAgentState()).toBe("sleeping");
      expect(db.getKV("loop.idle_sleep_note")).toContain("LOOP DETECTED");
      const remaining = new Date(db.getKV("sleep_until")!).getTime() - Date.now();
      expect(remaining).toBeGreaterThan(4 * 60_000);
    });
  });
});
