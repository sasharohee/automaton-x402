/**
 * Standalone idle / orchestrator fixes
 *
 *  - the orchestration runtime (worker pool + orchestrator) survives across
 *    runAgentLoop calls, and the parent sleeps while a local worker runs
 *  - a recovered task is never re-assigned to a dead local:// worker, and a
 *    task that keeps losing its worker ends up failed
 *  - idle detectors sleep with a persisted 5/10/20/40/60 min backoff
 *  - the planner gets the loop's real budget, not funding.getBalance(parent)
 *  - write_file is confined to ~/work in standalone mode
 *
 * Everything is mocked: no network, no wallet, no spending.
 */

import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// No RPC call for the on-chain USDC balance.
vi.mock("../conway/x402.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../conway/x402.js")>();
  return { ...actual, getUsdcBalance: vi.fn(async () => 12.5) };
});

// Spy on the planner context to check the budget it receives.
vi.mock("../orchestration/planner-context.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../orchestration/planner-context.js")>();
  return { ...actual, buildPlannerContext: vi.fn(actual.buildPlannerContext) };
});

import { runAgentLoop, getOrchestrationRuntime } from "../agent/loop.js";
import {
  computeIdleSleepMs,
  scheduleIdleSleep,
  getIdleBackoffLevel,
  resetIdleBackoff,
} from "../agent/idle-backoff.js";
import { confinePathToSandbox, createBuiltinTools, USDC_BALANCE_CACHE_KEY } from "../agent/tools.js";
import { resolveWriteRoots } from "../agent/workdir.js";
import { Orchestrator } from "../orchestration/orchestrator.js";
import { SimpleAgentTracker } from "../orchestration/simple-tracker.js";
import { ColonyMessaging, LocalDBTransport } from "../orchestration/messaging.js";
import { buildPlannerContext } from "../orchestration/planner-context.js";
import { getUsdcBalance } from "../conway/x402.js";
import {
  MockInferenceClient,
  MockConwayClient,
  createTestDb,
  createTestIdentity,
  createTestConfig,
  toolCallResponse,
  noToolResponse,
} from "./mocks.js";
import type { AutomatonDatabase, ToolContext } from "../types.js";

const MIN = 60_000;

function sleepRemainingMs(db: AutomatonDatabase): number {
  const until = db.getKV("sleep_until");
  expect(until).toBeDefined();
  return new Date(until!).getTime() - Date.now();
}

function insertGoal(db: AutomatonDatabase, id: string): void {
  db.raw.prepare(
    "INSERT INTO goals (id, title, description, status, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(id, "Goal", "Goal description", "active", new Date().toISOString());
}

function insertTask(
  db: AutomatonDatabase,
  params: { id: string; goalId: string; status: string; assignedTo: string | null; retryCount?: number; maxRetries?: number },
): void {
  db.raw.prepare(
    `INSERT INTO task_graph
     (id, goal_id, title, description, status, assigned_to, agent_role, priority, dependencies,
      retry_count, max_retries, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    params.id, params.goalId, "Task", "Task description", params.status, params.assignedTo,
    "generalist", 50, "[]", params.retryCount ?? 0, params.maxRetries ?? 3, new Date().toISOString(),
  );
}

function insertLocalChild(db: AutomatonDatabase, address: string, status = "running"): void {
  db.insertChild({
    id: `child-${address}`,
    name: `worker-${address.slice(-4)}`,
    address: address as `0x${string}`,
    sandboxId: address.replace("local://", ""),
    genesisPrompt: "Role: generalist",
    creatorMessage: "registered by orchestrator",
    fundedAmountCents: 0,
    status: status as any,
    createdAt: new Date().toISOString(),
  });
}

function setExecuting(db: AutomatonDatabase, goalId: string): void {
  db.setKV("orchestrator.state", JSON.stringify({
    phase: "executing", goalId, replanCount: 0, failedTaskId: null, failedError: null,
  }));
}

function childStatus(db: AutomatonDatabase, address: string): string | undefined {
  return (db.raw.prepare("SELECT status FROM children WHERE address = ?").get(address) as
    | { status: string }
    | undefined)?.status;
}

function makeOrchestrator(db: AutomatonDatabase, params: {
  isWorkerAlive?: (address: string) => boolean;
  spawnAgent?: (task: any) => Promise<any>;
  funding?: any;
  inference?: any;
  getFinancialState?: () => { creditsCents: number; usdcBalance: number } | undefined;
}): Orchestrator {
  return new Orchestrator({
    db: db.raw,
    agentTracker: new SimpleAgentTracker(db),
    funding: params.funding ?? {
      fundChild: vi.fn(async () => ({ success: true })),
      recallCredits: vi.fn(async () => ({ success: true, amountCents: 0 })),
      getBalance: vi.fn(async () => 0),
    },
    messaging: new ColonyMessaging(new LocalDBTransport(db), db),
    inference: params.inference ?? ({ chat: vi.fn(async () => ({ content: "{}" })) } as any),
    identity: createTestIdentity(),
    isWorkerAlive: params.isWorkerAlive,
    getFinancialState: params.getFinancialState,
    config: { spawnAgent: params.spawnAgent },
  });
}

describe("standalone idle / orchestrator fixes", () => {
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

  // ─── A + C: persistent orchestration runtime ─────────────────

  describe("orchestration runtime", () => {
    it("worker pool and orchestrator survive between two runAgentLoop calls", async () => {
      const config = createTestConfig();
      await runAgentLoop({ identity, config, db, conway, inference: new MockInferenceClient([noToolResponse("a")]) });
      const first = getOrchestrationRuntime(db);
      expect(first).toBeDefined();

      await runAgentLoop({ identity, config, db, conway, inference: new MockInferenceClient([noToolResponse("b")]) });
      const second = getOrchestrationRuntime(db);
      expect(second).toBe(first);
      expect(second!.workerPool).toBe(first!.workerPool);
      expect(second!.orchestrator).toBe(first!.orchestrator);
    });

    it("a worker started in a previous wake is still seen alive; the parent sleeps instead of running turns", async () => {
      const config = createTestConfig();
      await runAgentLoop({ identity, config, db, conway, inference: new MockInferenceClient([noToolResponse("a")]) });
      const runtime = getOrchestrationRuntime(db)!;

      // Simulate a long-running worker spawned during the previous wake.
      const workerId = "local-worker-STILLRUNNING";
      const address = `local://${workerId}`;
      (runtime.workerPool as any).activeWorkers.set(workerId, {
        promise: new Promise<void>(() => {}),
        abortController: new AbortController(),
      });
      insertGoal(db, "goal-1");
      insertTask(db, { id: "task-1", goalId: "goal-1", status: "assigned", assignedTo: address });
      insertLocalChild(db, address);
      setExecuting(db, "goal-1");

      const inference = new MockInferenceClient([noToolResponse("should not run")]);
      await runAgentLoop({ identity, config, db, conway, inference });

      // Not recovered: the task stays with the live worker.
      const task = db.raw.prepare("SELECT status, assigned_to FROM task_graph WHERE id = 'task-1'").get() as any;
      expect(task.status).toBe("assigned");
      expect(task.assigned_to).toBe(address);
      expect(childStatus(db, address)).toBe("running");
      // No parent inference while the worker runs; sleep uses the backoff.
      expect(inference.calls.length).toBe(0);
      expect(db.getAgentState()).toBe("sleeping");
      expect(sleepRemainingMs(db)).toBeGreaterThan(4 * MIN);

      (runtime.workerPool as any).activeWorkers.clear();
    });

    it("marks local:// children from a previous process as dead on startup", async () => {
      insertLocalChild(db, "local://local-worker-OLDPROCESS");
      await runAgentLoop({
        identity, config: createTestConfig(), db, conway,
        inference: new MockInferenceClient([noToolResponse("a")]),
      });
      expect(childStatus(db, "local://local-worker-OLDPROCESS")).toBe("dead");
    });
  });

  // ─── B: reliable task recovery ───────────────────────────────

  describe("stale task recovery", () => {
    it("a recovered task is never re-assigned to the dead local:// worker", async () => {
      const dead = "local://local-worker-DEAD";
      insertGoal(db, "goal-1");
      insertTask(db, { id: "task-1", goalId: "goal-1", status: "assigned", assignedTo: dead });
      insertLocalChild(db, dead);
      setExecuting(db, "goal-1");

      const spawnAgent = vi.fn(async () => ({
        address: "local://local-worker-NEW",
        name: "worker-new",
        sandboxId: "local-worker-NEW",
      }));
      const orchestrator = makeOrchestrator(db, {
        isWorkerAlive: (address) => address === "local://local-worker-NEW",
        spawnAgent,
      });

      const result = await orchestrator.tick();

      expect(childStatus(db, dead)).toBe("dead");
      expect(spawnAgent).toHaveBeenCalledTimes(1);
      const task = db.raw.prepare("SELECT status, assigned_to, retry_count FROM task_graph WHERE id = 'task-1'").get() as any;
      expect(task.assigned_to).toBe("local://local-worker-NEW");
      expect(task.retry_count).toBe(1);
      // A recovery is not counted as new work for the sleep decision.
      expect(result.tasksRecovered).toBe(1);
      expect(result.tasksAssigned).toBe(0);
    });

    it("local:// children are never idle candidates", () => {
      insertLocalChild(db, "local://local-worker-FINISHED");
      const tracker = new SimpleAgentTracker(db);
      expect(tracker.getIdle()).toEqual([]);
      expect(tracker.getBestForTask("generalist")).toBeNull();
    });

    it("a task that keeps losing its worker fails once retries are exhausted", async () => {
      const dead = "local://local-worker-DEAD2";
      insertGoal(db, "goal-1");
      insertTask(db, { id: "task-1", goalId: "goal-1", status: "assigned", assignedTo: dead, retryCount: 1, maxRetries: 1 });
      insertLocalChild(db, dead);
      setExecuting(db, "goal-1");

      const spawnAgent = vi.fn();
      const orchestrator = makeOrchestrator(db, { isWorkerAlive: () => false, spawnAgent });
      const result = await orchestrator.tick();

      const task = db.raw.prepare("SELECT status FROM task_graph WHERE id = 'task-1'").get() as any;
      expect(task.status).toBe("failed");
      expect(spawnAgent).not.toHaveBeenCalled();
      expect(result.tasksFailed).toBe(1);
    });

    it("never recovers a task self-assigned to the parent", async () => {
      insertGoal(db, "goal-1");
      insertTask(db, { id: "task-1", goalId: "goal-1", status: "assigned", assignedTo: identity.address });
      setExecuting(db, "goal-1");

      const orchestrator = makeOrchestrator(db, { isWorkerAlive: () => false });
      const result = await orchestrator.tick();

      const task = db.raw.prepare("SELECT status, assigned_to FROM task_graph WHERE id = 'task-1'").get() as any;
      expect(task.status).toBe("assigned");
      expect(task.assigned_to).toBe(identity.address);
      expect(result.tasksRecovered).toBe(0);
    });
  });

  // ─── D: idle sleep backoff ───────────────────────────────────

  describe("idle sleep backoff", () => {
    it("computes 5/10/20/40/60/60 min by default and honours config", () => {
      expect([0, 1, 2, 3, 4, 5, 9].map((l) => computeIdleSleepMs(l) / MIN)).toEqual([5, 10, 20, 40, 60, 60, 60]);
      const cfg = { idleSleepBaseSeconds: 60, idleSleepMaxSeconds: 180 };
      expect([0, 1, 2, 3].map((l) => computeIdleSleepMs(l, cfg) / 1000)).toEqual([60, 120, 180, 180]);
    });

    it("scheduleIdleSleep persists the level and resetIdleBackoff clears it", () => {
      const now = Date.now();
      expect(scheduleIdleSleep(db, undefined, now)).toBe(5 * MIN);
      expect(scheduleIdleSleep(db, undefined, now)).toBe(10 * MIN);
      expect(getIdleBackoffLevel(db)).toBe(2);
      resetIdleBackoff(db);
      expect(scheduleIdleSleep(db, undefined, now)).toBe(5 * MIN);
    });

    it("maintenance loop sleeps 5/10/20/40/60/60 min across successive wakes", async () => {
      const config = createTestConfig();
      const durations: number[] = [];

      for (let wake = 0; wake < 6; wake++) {
        // Every wake the agent only checks its status.
        const inference = new MockInferenceClient(
          Array.from({ length: 5 }, () => toolCallResponse([{ name: "check_credits", arguments: {} }])),
        );
        await runAgentLoop({ identity, config, db, conway, inference });
        expect(db.getAgentState()).toBe("sleeping");
        // First wake: 3 idle-only turns; later wakes: the persisted counter
        // sends it back to sleep after a single idle-only turn.
        expect(inference.calls.length).toBe(wake === 0 ? 3 : 1);
        durations.push(Math.round(sleepRemainingMs(db) / MIN));
      }

      expect(durations).toEqual([5, 10, 20, 40, 60, 60]);
    });

    it("text-only idle turns use the same backoff", async () => {
      const config = createTestConfig();
      const durations: number[] = [];
      for (let wake = 0; wake < 3; wake++) {
        await runAgentLoop({ identity, config, db, conway, inference: new MockInferenceClient([noToolResponse("idle")]) });
        durations.push(Math.round(sleepRemainingMs(db) / MIN));
      }
      expect(durations).toEqual([5, 10, 20]);
    });

    it("a turn doing real work resets the backoff", async () => {
      const config = createTestConfig();
      db.setKV("idle_backoff_level", "3");
      const inference = new MockInferenceClient([
        toolCallResponse([{ name: "exec", arguments: { command: "echo work" } }]),
        noToolResponse("done"),
      ]);
      await runAgentLoop({ identity, config, db, conway, inference });
      // Reset by exec, then one idle sleep at the base duration.
      expect(Math.round(sleepRemainingMs(db) / MIN)).toBe(5);
      expect(getIdleBackoffLevel(db)).toBe(1);
    });

    it("an inbox message resets the backoff", async () => {
      const config = createTestConfig();
      db.setKV("idle_backoff_level", "4");
      db.insertInboxMessage({
        id: "msg-1",
        from: "0xsender",
        to: identity.address,
        content: "hello",
        signedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      });
      const inference = new MockInferenceClient([
        toolCallResponse([{ name: "check_credits", arguments: {} }]),
        noToolResponse("read the message"),
      ]);
      await runAgentLoop({ identity, config, db, conway, inference });
      expect(Math.round(sleepRemainingMs(db) / MIN)).toBe(5);
    });

    it("the reason for the idle sleep is given with the next wakeup prompt", async () => {
      const config = createTestConfig();
      db.setKV("loop.idle_sleep_note", "MAINTENANCE LOOP DETECTED before your last sleep");
      const inference = new MockInferenceClient([noToolResponse("ok")]);
      await runAgentLoop({ identity, config, db, conway, inference });
      const prompt = inference.calls[0].messages.map((m) => String(m.content)).join("\n");
      expect(prompt).toContain("MAINTENANCE LOOP DETECTED before your last sleep");
      expect(db.getKV("loop.idle_sleep_note")).toBeUndefined();
    });
  });

  // ─── E: real planner budget ──────────────────────────────────

  describe("planner budget", () => {
    it("passes the loop's financial state to the planner and never funding.getBalance(parent)", async () => {
      insertGoal(db, "goal-1");
      db.setKV("orchestrator.state", JSON.stringify({
        phase: "planning", goalId: "goal-1", replanCount: 0, failedTaskId: null, failedError: null,
      }));
      const funding = {
        fundChild: vi.fn(async () => ({ success: true })),
        recallCredits: vi.fn(async () => ({ success: true, amountCents: 0 })),
        getBalance: vi.fn(async () => 0),
      };
      const orchestrator = makeOrchestrator(db, {
        funding,
        inference: { chat: vi.fn(async () => { throw new Error("no inference in tests"); }) },
        getFinancialState: () => ({ creditsCents: 1234, usdcBalance: 17.34 }),
      });

      await orchestrator.tick();

      const spy = vi.mocked(buildPlannerContext);
      expect(spy).toHaveBeenCalled();
      const opts = spy.mock.calls[spy.mock.calls.length - 1][0];
      expect(opts.creditsCents).toBe(1234);
      expect(opts.usdcBalance).toBe(17.34);
      expect(opts.funding).toBeUndefined();
      expect(funding.getBalance).not.toHaveBeenCalled();

      const context = await spy.mock.results[spy.mock.results.length - 1].value;
      expect(context.creditsCents).toBe(1234);
      expect(context.survivalTier).not.toBe("critical");
    });
  });

  // ─── F: writable work directory ──────────────────────────────

  describe("write_file confinement", () => {
    const home = os.homedir();
    const standaloneRoots = resolveWriteRoots({ providerMode: "standalone" });

    it("standalone accepts ~/work/... and relative paths under ~/work", () => {
      expect(confinePathToSandbox("~/work/app/index.js", standaloneRoots)).toBe(path.join(home, "work", "app", "index.js"));
      expect(confinePathToSandbox("notes.md", standaloneRoots)).toBe(path.join(home, "work", "notes.md"));
    });

    it("standalone refuses ~/.automaton/..., the rest of HOME and /app/...", () => {
      for (const p of ["~/.automaton/wallet.json", "~/.automaton/services/x.js", "~/summarize-api/package.json", "/app/dist/index.js", "~/work/../.automaton/state.db", "/root/x"]) {
        const result = confinePathToSandbox(p, standaloneRoots);
        expect(typeof result).toBe("object");
        expect((result as { error: string }).error).toContain("Blocked");
      }
    });

    it("Conway mode keeps /root", () => {
      const conwayRoots = resolveWriteRoots({ providerMode: "conway" });
      expect(confinePathToSandbox("~/app.js", conwayRoots)).toBe("/root/app.js");
      expect(typeof confinePathToSandbox("/home/node/work/x", conwayRoots)).toBe("object");
    });

    it("write_file tool writes under ~/work in standalone mode only", async () => {
      const writeFile = createBuiltinTools("sb").find((t) => t.name === "write_file")!;
      const ctx = {
        identity, config: createTestConfig({ providerMode: "standalone" } as any), db, conway,
        inference: new MockInferenceClient(),
      } as unknown as ToolContext;

      const ok = await writeFile.execute({ path: "~/work/hello.txt", content: "hi" }, ctx);
      expect(ok).toContain(path.join(home, "work", "hello.txt"));
      expect(conway.files[path.join(home, "work", "hello.txt")]).toBe("hi");

      const blocked = await writeFile.execute({ path: "~/.automaton/automaton.json", content: "x" }, ctx);
      expect(blocked).toContain("Blocked");
      const blockedApp = await writeFile.execute({ path: "/app/package.json", content: "x" }, ctx);
      expect(blockedApp).toContain("Blocked");
    });
  });

  // ─── D: check_usdc_balance cache ─────────────────────────────

  describe("check_usdc_balance cache (standalone)", () => {
    it("serves a fresh cached value with its age instead of reading the chain again", async () => {
      const tool = createBuiltinTools("sb").find((t) => t.name === "check_usdc_balance")!;
      const ctx = {
        identity, config: createTestConfig({ providerMode: "standalone" } as any), db, conway,
        inference: new MockInferenceClient(),
      } as unknown as ToolContext;
      const read = vi.mocked(getUsdcBalance);
      read.mockClear();

      const first = await tool.execute({}, ctx);
      expect(first).toContain("12.500000");
      expect(read).toHaveBeenCalledTimes(1);

      const second = await tool.execute({}, ctx);
      expect(second).toContain("cached");
      expect(read).toHaveBeenCalledTimes(1);

      // Expired cache → read again.
      db.setKV(USDC_BALANCE_CACHE_KEY, JSON.stringify({ balance: 1, checkedAt: Date.now() - 6 * MIN }));
      await tool.execute({}, ctx);
      expect(read).toHaveBeenCalledTimes(2);
    });

    it("Conway mode does not cache", async () => {
      const tool = createBuiltinTools("sb").find((t) => t.name === "check_usdc_balance")!;
      const ctx = { identity, config: createTestConfig(), db, conway, inference: new MockInferenceClient() } as unknown as ToolContext;
      const read = vi.mocked(getUsdcBalance);
      read.mockClear();
      await tool.execute({}, ctx);
      await tool.execute({}, ctx);
      expect(read).toHaveBeenCalledTimes(2);
    });
  });
});
