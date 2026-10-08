/**
 * Local Agent Worker
 *
 * Runs inference-driven task execution in-process as an async background task.
 * Each worker executes through a harness chosen by role via HarnessRegistry.
 */

import path from "node:path";
import { ulid } from "ulid";
import { createLogger } from "../observability/logger.js";
import type { HarnessContext, WorkerInferenceClient } from "../agent/harness-types.js";
import { buildWisdomFromGoal, createBudgetFromTask } from "../agent/harness-types.js";
import { HarnessRegistry } from "../agent/harness-registry.js";
import { completeTask, failTask } from "./task-graph.js";
import type { TaskNode } from "./task-graph.js";
import { AgentWorkspace } from "./workspace.js";
import { insertWakeEvent } from "../state/database.js";
import type {
  AutomatonConfig,
  AutomatonIdentity,
  AutomatonTool,
  ConwayClient,
  InputSource,
  SpendTrackerInterface,
  ToolContext,
} from "../types.js";
import type { Database } from "better-sqlite3";
import type { PolicyEngine } from "../agent/policy-engine.js";

const logger = createLogger("orchestration.local-worker");
const DEFAULT_ALLOWED_EDIT_ROOT = process.cwd();

interface LocalWorkerConfig {
  db: Database;
  inference: WorkerInferenceClient;
  conway: ConwayClient;
  maxTurns?: number;
  harnessRegistry: HarnessRegistry;
  identity: AutomatonIdentity;
  config: AutomatonConfig;
  allowedEditRoot?: string;
  tools?: AutomatonTool[];
  toolContext?: ToolContext;
  policyEngine?: PolicyEngine;
  spendTracker?: SpendTrackerInterface;
  inputSource?: InputSource;
  /** Maximum number of workers running at once (unlimited when undefined). */
  maxConcurrent?: number;
}

export class LocalWorkerPool {
  private activeWorkers = new Map<string, {
    promise: Promise<void>;
    abortController: AbortController;
    taskId: string;
  }>();

  constructor(private readonly config: LocalWorkerConfig) {}

  /** True when another worker can be started (see maxConcurrent). */
  hasCapacity(): boolean {
    const max = this.config.maxConcurrent;
    return max === undefined || this.activeWorkers.size < max;
  }

  /** True when a live worker is already executing this task. */
  isRunningTask(taskId: string): boolean {
    for (const worker of this.activeWorkers.values()) {
      if (worker.taskId === taskId) {
        return true;
      }
    }
    return false;
  }

  spawn(task: TaskNode): { address: string; name: string; sandboxId: string } {
    if (this.isRunningTask(task.id)) {
      throw new Error(`A local worker is already running task ${task.id}`);
    }
    if (!this.hasCapacity()) {
      throw new Error(
        `Local worker limit reached (${this.activeWorkers.size}/${this.config.maxConcurrent})`,
      );
    }

    const workerId = `local-worker-${ulid()}`;
    const workerName = `worker-${task.agentRole ?? "generalist"}-${workerId.slice(-6)}`;
    const address = `local://${workerId}`;
    const abortController = new AbortController();

    const workerPromise = this.runWorker(workerId, task, abortController.signal)
      .catch((error) => {
        logger.error("Local worker crashed", error instanceof Error ? error : new Error(String(error)), {
          workerId,
          taskId: task.id,
        });
        try {
          failTask(
            this.config.db,
            task.id,
            `Worker crashed: ${error instanceof Error ? error.message : String(error)}`,
            true,
          );
        } catch {
          // Task may already be in a terminal state.
        }
      })
      .finally(() => {
        this.activeWorkers.delete(workerId);
        try {
          // A local worker runs a single task: once it exits, its children
          // row must never be picked again for an assignment.
          markLocalWorkerDead(this.config.db, address);
          // Wake the parent so it reacts to the result instead of waiting
          // for the end of its idle sleep.
          insertWakeEvent(this.config.db, "local_worker", `Local worker finished task ${task.id}`);
        } catch {
          // Bookkeeping only; never let it crash the pool.
        }
      });

    this.activeWorkers.set(workerId, { promise: workerPromise, abortController, taskId: task.id });
    return { address, name: workerName, sandboxId: workerId };
  }

  getActiveCount(): number {
    return this.activeWorkers.size;
  }

  hasWorker(addressOrId: string): boolean {
    const id = addressOrId.replace("local://", "");
    return this.activeWorkers.has(id);
  }

  async shutdown(): Promise<void> {
    for (const [, worker] of this.activeWorkers) {
      worker.abortController.abort();
    }
    await Promise.allSettled([...this.activeWorkers.values()].map((worker) => worker.promise));
    this.activeWorkers.clear();
  }

  private async runWorker(workerId: string, task: TaskNode, signal: AbortSignal): Promise<void> {
    const harness = this.config.harnessRegistry.createForRole(task.agentRole);
    const workspace = new AgentWorkspace(task.goalId);
    const allowedEditRoot = path.resolve(this.config.allowedEditRoot ?? DEFAULT_ALLOWED_EDIT_ROOT);
    const workerIdentity = createWorkerIdentity(this.config.identity, workerId, task.agentRole);
    const context: HarnessContext = {
      workspaceRoot: workspace.basePath,
      allowedEditRoot,
      workspace,
      identity: workerIdentity,
      config: this.config.config,
      db: this.config.db,
      conway: this.config.conway,
      inference: {
        chat: async (params) => this.config.inference.chat(params),
      },
      budget: createBudgetFromTask(task),
      wisdom: buildWisdomFromGoal(this.config.db, task.goalId, workspace),
      abortSignal: signal,
      goalId: task.goalId,
      toolCatalog: this.config.tools,
      toolContext: this.config.toolContext
        ? {
            ...this.config.toolContext,
            identity: workerIdentity,
          }
        : undefined,
      policyEngine: this.config.policyEngine,
      spendTracker: this.config.spendTracker,
      inputSource: this.config.inputSource,
    };

    if (this.config.maxTurns) {
      context.budget.maxTurns = this.config.maxTurns;
    }
    if (harness.id === "orchestrator" && !this.config.maxTurns) {
      context.budget.maxTurns = Math.max(context.budget.maxTurns, 50);
    }

    logger.info(
      `[WORKER ${workerId}] Starting task "${task.title}" (${task.id}), role: ${task.agentRole ?? "generalist"}, harness: ${harness.id}`,
    );

    try {
      await harness.initialize(task, context);
      const result = await harness.execute();

      if (result.success) {
        completeTask(this.config.db, task.id, result);
        logger.info("Local worker completed task", {
          workerId,
          taskId: task.id,
          title: task.title,
          duration: result.duration,
          harness: harness.id,
        });
      } else {
        failTask(this.config.db, task.id, result.output || "Task reported failure", true);
        logger.warn("Local worker reported task failure", {
          workerId,
          taskId: task.id,
          title: task.title,
          harness: harness.id,
          output: result.output.slice(0, 200),
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`[WORKER ${workerId}] Harness execution failed: ${message}`);
      failTask(this.config.db, task.id, message, true);
    }
  }
}

function markLocalWorkerDead(db: Database, address: string): void {
  db.prepare(
    `UPDATE children SET status = 'dead', last_checked = datetime('now')
     WHERE address = ? AND status NOT IN ('dead', 'failed', 'cleaned_up')`,
  ).run(address);
}

/**
 * Local workers live in process memory: none of them survives a restart.
 * Called once per process, before the first orchestrator tick.
 */
export function markAllLocalWorkersDead(db: Database): number {
  const result = db.prepare(
    `UPDATE children SET status = 'dead', last_checked = datetime('now')
     WHERE address LIKE 'local://%' AND status NOT IN ('dead', 'failed', 'cleaned_up')`,
  ).run();
  return result.changes;
}

function createWorkerIdentity(
  parentIdentity: AutomatonIdentity,
  workerId: string,
  role: string | null,
): AutomatonIdentity {
  return {
    ...parentIdentity,
    name: `worker-${role ?? "generalist"}-${workerId.slice(-6)}`,
    address: `local://${workerId}`,
    sandboxId: workerId,
  };
}
