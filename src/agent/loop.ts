/**
 * The Agent Loop
 *
 * The core ReAct loop: Think -> Act -> Observe -> Persist.
 * This is the automaton's consciousness. When this runs, it is alive.
 */

import path from "node:path";
import type {
  AutomatonIdentity,
  AutomatonConfig,
  AutomatonDatabase,
  ConwayClient,
  InferenceClient,
  AgentState,
  AgentTurn,
  ToolCallResult,
  FinancialState,
  ToolContext,
  AutomatonTool,
  Skill,
  SocialClientInterface,
  SpendTrackerInterface,
  InputSource,
  ModelStrategyConfig,
} from "../types.js";
import { DEFAULT_MODEL_STRATEGY_CONFIG } from "../types.js";
import type { PolicyEngine } from "./policy-engine.js";
import { buildSystemPrompt, buildWakeupPrompt } from "./system-prompt.js";
import { buildContextMessages, trimContext } from "./context.js";
import {
  createBuiltinTools,
  loadInstalledTools,
  toolsToInferenceFormat,
  executeTool,
} from "./tools.js";
import { sanitizeInput } from "./injection-defense.js";
import { getSurvivalTier } from "../conway/credits.js";
import { getUsdcBalance } from "../conway/x402.js";
import {
  claimInboxMessages,
  markInboxProcessed,
  markInboxFailed,
  resetInboxToReceived,
  consumeNextWakeEvent,
} from "../state/database.js";
import type { InboxMessageRow } from "../state/database.js";
import { ulid } from "ulid";
import { ModelRegistry } from "../inference/registry.js";
import { InferenceBudgetTracker } from "../inference/budget.js";
import { InferenceRouter } from "../inference/router.js";
import { MemoryRetriever } from "../memory/retrieval.js";
import { MemoryIngestionPipeline } from "../memory/ingestion.js";
import { DEFAULT_MEMORY_BUDGET } from "../types.js";
import { formatMemoryBlock } from "./context.js";
import { createLogger } from "../observability/logger.js";
import { Orchestrator } from "../orchestration/orchestrator.js";
import { PlanModeController } from "../orchestration/plan-mode.js";
import { generateTodoMd, injectTodoContext } from "../orchestration/attention.js";
import { ColonyMessaging, LocalDBTransport } from "../orchestration/messaging.js";
import { LocalWorkerPool, markAllLocalWorkersDead } from "../orchestration/local-worker.js";
import { SimpleAgentTracker, SimpleFundingProtocol } from "../orchestration/simple-tracker.js";
import { HarnessRegistry } from "./harness-registry.js";
import { createWorkerInferenceBridge } from "./worker-inference-bridge.js";
import { ProviderRegistry } from "../inference/provider-registry.js";
import { UnifiedInferenceClient } from "../inference/inference-client.js";
import { isIdleOnlyTool } from "./idle-only-tools.js";
import { turnSignature } from "./loop-detector.js";
import { isStandalone, filterToolsForProvider, resolveBlockRunConfig } from "../conway/provider.js";
import { buildRoutingMatrix, registerMappedModels } from "../inference/model-map.js";
import { scheduleIdleSleep, resetIdleBackoff } from "./idle-backoff.js";
import { ensureStandaloneWorkDir } from "./workdir.js";

const logger = createLogger("loop");
const MAX_TOOL_CALLS_PER_TURN = 10;
const MAX_CONSECUTIVE_ERRORS = 5;
const MAX_REPETITIVE_TURNS = 3;
/** Consecutive idle-only turns, persisted across wakes. */
const IDLE_TOOL_TURNS_KEY = "loop.idle_tool_turns";
/** Reason for the last idle sleep, appended to the next wakeup prompt. */
const IDLE_SLEEP_NOTE_KEY = "loop.idle_sleep_note";

/**
 * Tools that count as real work. Used both for idle-turn detection and to
 * reset the idle sleep backoff.
 */
const MUTATING_TOOLS = new Set([
  "exec", "write_file", "edit_own_file", "transfer_credits", "topup_credits", "fund_child",
  "spawn_child", "start_child", "delete_sandbox", "create_sandbox",
  "install_npm_package", "install_mcp_server", "install_skill",
  "create_skill", "remove_skill", "install_skill_from_git",
  "install_skill_from_url", "pull_upstream", "git_commit", "git_push",
  "git_branch", "git_clone", "send_message", "message_child",
  "register_domain", "register_erc8004", "give_feedback",
  "update_genesis_prompt", "update_agent_card", "modify_heartbeat",
  "expose_port", "remove_port", "x402_fetch", "manage_dns",
  "distress_signal", "prune_dead_children", "sleep",
  "update_soul", "remember_fact", "set_goal", "complete_goal",
  "save_procedure", "note_about_agent", "forget",
  "enter_low_compute", "switch_model", "review_upstream_changes",
]);

const STANDALONE_EARNING_GUIDANCE =
  `You have NO inbound connectivity: no public IP, no open port, no domain. A server you start is only ` +
  `reachable from localhost on your own machine — nobody can call it or pay you through it, so do not build ` +
  `one to earn money and never claim a service is "live". Earn only through OUTBOUND requests: find paid ` +
  `bounties or tasks on the web that you can complete and deliver over outbound HTTP, using the tools you ` +
  `already have. You have no ETH: do not attempt on-chain transactions that need gas (e.g. register_erc8004). ` +
  `Every turn costs real money and your balance is already in your system prompt. If you have nothing ` +
  `concrete to do, call sleep with a long duration (30 minutes or more).`;

export interface AgentLoopOptions {
  identity: AutomatonIdentity;
  config: AutomatonConfig;
  db: AutomatonDatabase;
  conway: ConwayClient;
  inference: InferenceClient;
  social?: SocialClientInterface;
  skills?: Skill[];
  policyEngine?: PolicyEngine;
  spendTracker?: SpendTrackerInterface;
  onStateChange?: (state: AgentState) => void;
  onTurnComplete?: (turn: AgentTurn) => void;
  ollamaBaseUrl?: string;
  /** Standalone mode: guarded x402 fetch used for BlockRun inference. */
  blockrunFetch?: typeof fetch;
}

/**
 * Run the agent loop. This is the main execution path.
 * Returns when the agent decides to sleep or when compute runs out.
 */
export async function runAgentLoop(
  options: AgentLoopOptions,
): Promise<void> {
  const { identity, config, db, conway, inference, social, skills, policyEngine, spendTracker, onStateChange, onTurnComplete, ollamaBaseUrl } =
    options;

  const standalone = isStandalone(config);
  const builtinTools = createBuiltinTools(identity.sandboxId);
  const installedTools = loadInstalledTools(db);
  // Standalone mode: Conway-only tools (sandboxes, ports, domains, credit
  // transfers, replication) are never offered to the model.
  const tools = filterToolsForProvider([...builtinTools, ...installedTools], config);
  const toolContext: ToolContext = {
    identity,
    config,
    db,
    conway,
    inference,
    social,
  };

  // Initialize inference router (Phase 2.3)
  const modelStrategyConfig: ModelStrategyConfig = {
    ...DEFAULT_MODEL_STRATEGY_CONFIG,
    ...(config.modelStrategy ?? {}),
  };
  const modelRegistry = new ModelRegistry(db.raw);
  modelRegistry.initialize();

  // Discover Ollama models if configured
  if (ollamaBaseUrl) {
    const { discoverOllamaModels } = await import("../ollama/discover.js");
    await discoverOllamaModels(ollamaBaseUrl, db.raw);
  }
  // Standalone: route to the configured BlockRun models instead of the
  // hard-coded Conway/OpenAI matrix.
  const blockrunConfig = standalone ? resolveBlockRunConfig(config) : undefined;
  if (blockrunConfig) {
    registerMappedModels(modelRegistry, blockrunConfig.models, "blockrun");
  }
  const budgetTracker = new InferenceBudgetTracker(db.raw, modelStrategyConfig);
  const inferenceRouter = new InferenceRouter(
    db.raw,
    modelRegistry,
    budgetTracker,
    blockrunConfig ? buildRoutingMatrix(blockrunConfig.models) : undefined,
  );

  // Optional orchestration bootstrap (requires V9 goals/task tables).
  // Created once per process and reused across wake/sleep cycles so the
  // worker pool keeps track of workers that are still running.
  const orchestration = getOrCreateOrchestrationRuntime({
    options,
    standalone,
    blockrunConfig,
    tools,
    toolContext,
  });
  const planModeController = orchestration?.planModeController;
  const orchestrator = orchestration?.orchestrator;
  const workerPool = orchestration?.workerPool;

  // Set start time
  if (!db.getKV("start_time")) {
    db.setKV("start_time", new Date().toISOString());
  }

  let consecutiveErrors = 0;
  let running = true;
  let lastToolPatterns: string[] = [];
  // Persisted across wakes so an agent that wakes up and only checks its
  // status goes straight back to sleep.
  let idleToolTurns = parseInt(db.getKV(IDLE_TOOL_TURNS_KEY) || "0", 10) || 0;
  // blockedGoalTurns removed — replaced by immediate sleep + exponential backoff

  /** Put the agent to sleep with the persisted idle backoff (5/10/20/40/60 min). */
  const sleepWithBackoff = (reason: string): void => {
    const sleepMs = scheduleIdleSleep(db, config);
    log(config, `${reason} Sleeping ${Math.round(sleepMs / 1000)}s (idle backoff).`);
    db.setAgentState("sleeping");
    onStateChange?.("sleeping");
    running = false;
  };

  // Drain any stale wake events from before this loop started,
  // so they don't re-wake the agent after its first sleep.
  let drained = 0;
  while (consumeNextWakeEvent(db.raw)) drained++;

  // Clear any stale sleep_until from a previous session so the agent
  // doesn't immediately go back to sleep on startup.
  db.deleteKV("sleep_until");

  // Transition to waking state
  db.setAgentState("waking");
  onStateChange?.("waking");

  // Get financial state
  let financial = await getFinancialState(conway, identity.address, db, config.chainType || identity.chainType || "evm");

  // Check if this is the first run
  const isFirstRun = db.getTurnCount() === 0;

  // Build wakeup prompt
  let wakeupInput = buildWakeupPrompt({
    identity,
    config,
    financial,
    db,
  });
  // Why the agent was put to sleep last time (loop detectors no longer
  // inject a message mid-cycle; the note rides along with the wakeup turn).
  const idleSleepNote = db.getKV(IDLE_SLEEP_NOTE_KEY);
  if (idleSleepNote) {
    wakeupInput = `${wakeupInput}\n\n${idleSleepNote}`;
    db.deleteKV(IDLE_SLEEP_NOTE_KEY);
  }

  // Transition to running
  db.setAgentState("running");
  onStateChange?.("running");

  log(config, `[WAKE UP] ${config.name} is alive. Credits: $${(financial.creditsCents / 100).toFixed(2)}`);

  // ─── The Loop ──────────────────────────────────────────────

  const MAX_IDLE_TURNS = 10; // Force sleep after N turns with no real work
  let idleTurnCount = 0;

  const maxCycleTurns = config.maxTurnsPerCycle ?? 25;
  let cycleTurnCount = 0;

  let pendingInput: { content: string; source: string } | undefined = {
    content: wakeupInput,
    source: "wakeup",
  };

  while (running) {
    // Declared outside try so the catch block can access for retry/failure handling
    let claimedMessages: InboxMessageRow[] = [];

    try {
      // Check if we should be sleeping
      const sleepUntil = db.getKV("sleep_until");
      if (sleepUntil && new Date(sleepUntil) > new Date()) {
        log(config, `[SLEEP] Sleeping until ${sleepUntil}`);
        // IMPORTANT: mark agent as sleeping so the outer runtime pauses instead of immediately re-running.
        db.setAgentState("sleeping");
        onStateChange?.("sleeping");
        running = false;
        break;
      }

      // Check for unprocessed inbox messages using the state machine:
      // received → in_progress (claim) → processed (on success) or received/failed (on failure)
      if (!pendingInput) {
        claimedMessages = claimInboxMessages(db.raw, 10);
        if (claimedMessages.length > 0) {
          // A real message arrived: the agent has something to do again.
          resetIdleBackoff(db);
          const formatted = claimedMessages
            .map((m) => {
              const from = sanitizeInput(m.fromAddress, m.fromAddress, "social_address");
              const content = sanitizeInput(m.content, m.fromAddress, "social_message");
              if (content.blocked) {
                return `[INJECTION BLOCKED from ${from.content}]: message was blocked by safety filter`;
              }
              return `[Message from ${from.content}]: ${content.content}`;
            })
            .join("\n\n");
          pendingInput = { content: formatted, source: "agent" };
        }
      }

      // Refresh financial state periodically
      financial = await getFinancialState(conway, identity.address, db, config.chainType || identity.chainType || "evm");
      if (orchestration) {
        orchestration.latestFinancial = financial.creditsCents === -1 ? undefined : financial;
      }

      // Check survival tier
      // api_unreachable: creditsCents === -1 means API failed with no cache.
      // Do NOT kill the agent; continue in low-compute mode and retry next tick.
      if (financial.creditsCents === -1) {
        log(config, "[API_UNREACHABLE] Balance API unreachable, continuing in low-compute mode.");
        inference.setLowComputeMode(true);
      } else {
        const tier = getSurvivalTier(financial.creditsCents);

        // Inline auto-topup: if credits are critically low and USDC is
        // available, buy credits NOW — before attempting inference.
        // This prevents the agent from dying mid-loop while waiting for
        // the heartbeat to fire. Uses a 60s cooldown to avoid hammering.
        // Standalone mode has no credits to buy: the USDC balance IS the budget.
        if (!standalone && (tier === "critical" || tier === "low_compute") && financial.usdcBalance >= 5) {
          const INLINE_TOPUP_COOLDOWN_MS = 60_000;
          const lastInlineTopup = db.getKV("last_inline_topup_attempt");
          const cooldownExpired = !lastInlineTopup ||
            Date.now() - new Date(lastInlineTopup).getTime() >= INLINE_TOPUP_COOLDOWN_MS;

          if (cooldownExpired) {
            db.setKV("last_inline_topup_attempt", new Date().toISOString());
            try {
              const { bootstrapTopup } = await import("../conway/topup.js");
              const topupResult = await bootstrapTopup({
                apiUrl: config.conwayApiUrl,
                account: identity.account,
                creditsCents: financial.creditsCents,
                chainType: config.chainType || identity.chainType || "evm",
              });
              if (topupResult?.success) {
                log(config, `[AUTO-TOPUP] Bought $${topupResult.amountUsd} credits from USDC mid-loop`);
                // Re-fetch financial state after topup so the rest of
                // the turn sees the updated balance.
                financial = await getFinancialState(conway, identity.address, db, config.chainType || identity.chainType || "evm");
              }
            } catch (err: any) {
              logger.warn(`Inline auto-topup failed: ${err.message}`);
            }
          }
        }

        // Re-evaluate tier after potential topup
        const effectiveTier = getSurvivalTier(financial.creditsCents);

        if (effectiveTier === "critical") {
          log(config, "[CRITICAL] Credits critically low. Limited operation.");
          db.setAgentState("critical");
          onStateChange?.("critical");
          inference.setLowComputeMode(true);
        } else if (effectiveTier === "low_compute") {
          db.setAgentState("low_compute");
          onStateChange?.("low_compute");
          inference.setLowComputeMode(true);
        } else {
          if (db.getAgentState() !== "running") {
            db.setAgentState("running");
            onStateChange?.("running");
          }
          inference.setLowComputeMode(false);
        }
      }

      // Build context — filter out purely idle turns (only status checks)
      // to prevent the model from continuing a status-check pattern
      const allTurns = db.getRecentTurns(20);
      const meaningfulTurns = allTurns.filter((t) => {
        if (t.toolCalls.length === 0) return true; // text-only turns are meaningful
        return t.toolCalls.some((tc) => !isIdleOnlyTool(tc.name));
      });
      // Keep at least the last 2 turns for continuity, even if idle
      const recentTurns = trimContext(
        meaningfulTurns.length > 0 ? meaningfulTurns : allTurns.slice(-2),
      );
      const systemPrompt = buildSystemPrompt({
        identity,
        config,
        financial,
        state: db.getAgentState(),
        db,
        tools,
        skills,
        isFirstRun,
      });

      // Phase 2.2: Pre-turn memory retrieval
      let memoryBlock: string | undefined;
      try {
        const sessionId = db.getKV("session_id") || "default";
        const retriever = new MemoryRetriever(db.raw, DEFAULT_MEMORY_BUDGET);
        const memories = retriever.retrieve(sessionId, pendingInput?.content);
        if (memories.totalTokens > 0) {
          memoryBlock = formatMemoryBlock(memories);
        }
      } catch (error) {
        logger.error("Memory retrieval failed", error instanceof Error ? error : undefined);
        // Memory failure must not block the agent loop
      }

      let messages = buildContextMessages(
        systemPrompt,
        recentTurns,
        pendingInput,
      );

      // Inject memory block after system prompt, before conversation history
      if (memoryBlock) {
        messages.splice(1, 0, { role: "system", content: memoryBlock });
      }

      if (orchestrator) {
        const orchestratorTick = await orchestrator.tick();
        db.setKV("orchestrator.last_tick", JSON.stringify(orchestratorTick));
        const localWorkersActive = workerPool?.getActiveCount() ?? 0;
        const hasSelfAssignedParentTask = !!db.raw.prepare(
          `SELECT 1 FROM task_graph WHERE assigned_to = ? AND status IN ('assigned', 'running') LIMIT 1`,
        ).get(identity.address);
        // A message from another agent or the creator always gets a turn.
        const hasInboxInput = pendingInput?.source === "agent";

        if (
          orchestratorTick.tasksAssigned > 0 ||
          orchestratorTick.tasksCompleted > 0 ||
          orchestratorTick.tasksFailed > 0 ||
          (orchestratorTick.tasksRecovered ?? 0) > 0
        ) {
          log(
            config,
            `[ORCHESTRATOR] phase=${orchestratorTick.phase} assigned=${orchestratorTick.tasksAssigned} completed=${orchestratorTick.tasksCompleted} failed=${orchestratorTick.tasksFailed} recovered=${orchestratorTick.tasksRecovered ?? 0}`,
          );
        }

        if (!hasSelfAssignedParentTask && !hasInboxInput) {
          // A local worker is executing a task of the active goal: parent
          // turns in parallel would only duplicate its work (and its spend).
          // The worker wakes the parent when it finishes.
          const runningLocalTask = workerPool && localWorkersActive > 0
            ? (db.raw.prepare(
                `SELECT assigned_to AS address FROM task_graph
                 WHERE assigned_to LIKE 'local://%' AND status IN ('assigned', 'running')`,
              ).all() as { address: string }[]).some((row) => workerPool.hasWorker(row.address))
            : false;

          if (runningLocalTask) {
            sleepWithBackoff(
              "[ORCHESTRATOR] A local worker is executing the active goal and the parent has no task of its own.",
            );
            break;
          }

          if (
            orchestratorTick.phase === "executing" &&
            orchestratorTick.tasksAssigned === 0 &&
            orchestratorTick.tasksCompleted === 0 &&
            orchestratorTick.tasksFailed === 0 &&
            (orchestratorTick.agentsActive > 0 || localWorkersActive > 0)
          ) {
            sleepWithBackoff(
              "[ORCHESTRATOR] All delegated work is active and no self-assigned parent task remains.",
            );
            break;
          }
        }
      }

      if (planModeController) {
        try {
          const todoMd = generateTodoMd(db.raw);
          messages = injectTodoContext(messages, todoMd);
        } catch (error) {
          logger.warn(
            `todo.md context injection skipped: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }

      // Capture input before clearing
      const currentInput = pendingInput;

      // Clear pending input after use
      pendingInput = undefined;

      // ── Inference Call (via router when available) ──
      const survivalTier = getSurvivalTier(financial.creditsCents);
      log(config, `[THINK] Routing inference (tier: ${survivalTier}, model: ${inference.getDefaultModel()})...`);

      const inferenceTools = toolsToInferenceFormat(tools);
      const routerResult = await inferenceRouter.route(
        {
          messages: messages,
          taskType: "agent_turn",
          tier: survivalTier,
          sessionId: db.getKV("session_id") || "default",
          turnId: ulid(),
          tools: inferenceTools,
        },
        (msgs, opts) => inference.chat(msgs, { ...opts, tools: inferenceTools }),
      );

      // Build a compatible response for the rest of the loop
      const response = {
        message: { content: routerResult.content, role: "assistant" as const },
        toolCalls: routerResult.toolCalls as any[] | undefined,
        usage: {
          promptTokens: routerResult.inputTokens,
          completionTokens: routerResult.outputTokens,
          totalTokens: routerResult.inputTokens + routerResult.outputTokens,
        },
        finishReason: routerResult.finishReason,
      };

      const turn: AgentTurn = {
        id: ulid(),
        timestamp: new Date().toISOString(),
        state: db.getAgentState(),
        input: currentInput?.content,
        inputSource: currentInput?.source as any,
        thinking: response.message.content || "",
        toolCalls: [],
        tokenUsage: response.usage,
        costCents: routerResult.costCents,
      };

      // ── Execute Tool Calls ──
      if (response.toolCalls && response.toolCalls.length > 0) {
        const toolCallMessages: any[] = [];
        let callCount = 0;
        const currentInputSource = currentInput?.source as InputSource | undefined;

        for (const tc of response.toolCalls) {
          if (callCount >= MAX_TOOL_CALLS_PER_TURN) {
            log(config, `[TOOLS] Max tool calls per turn reached (${MAX_TOOL_CALLS_PER_TURN})`);
            break;
          }

          let args: Record<string, unknown>;
          try {
            args = JSON.parse(tc.function.arguments);
          } catch (error) {
            logger.error("Failed to parse tool arguments", error instanceof Error ? error : undefined);
            args = {};
          }

          log(config, `[TOOL] ${tc.function.name}(${JSON.stringify(args).slice(0, 100)})`);

          const result = await executeTool(
            tc.function.name,
            args,
            tools,
            toolContext,
            policyEngine,
            spendTracker ? {
              inputSource: currentInputSource,
              turnToolCallCount: turn.toolCalls.filter(t => t.name === "transfer_credits").length,
              sessionSpend: spendTracker,
            } : undefined,
          );

          // Override the ID to match the inference call's ID
          result.id = tc.id;
          turn.toolCalls.push(result);

          log(
            config,
            `[TOOL RESULT] ${tc.function.name}: ${result.error ? `ERROR: ${result.error}` : result.result.slice(0, 200)}`,
          );

          callCount++;
        }
      }

      // ── Persist Turn (atomic: turn + tool calls + inbox ack) ──
      const claimedIds = claimedMessages.map((m) => m.id);
      db.runTransaction(() => {
        db.insertTurn(turn);
        for (const tc of turn.toolCalls) {
          db.insertToolCall(turn.id, tc);
        }
        // Mark claimed inbox messages as processed (atomic with turn persistence)
        if (claimedIds.length > 0) {
          markInboxProcessed(db.raw, claimedIds);
        }
      });
      onTurnComplete?.(turn);

      // Phase 2.2: Post-turn memory ingestion (non-blocking)
      try {
        const sessionId = db.getKV("session_id") || "default";
        const ingestion = new MemoryIngestionPipeline(db.raw);
        ingestion.ingest(sessionId, turn, turn.toolCalls);
      } catch (error) {
        logger.error("Memory ingestion failed", error instanceof Error ? error : undefined);
        // Memory failure must not block the agent loop
      }

      // ── create_goal BLOCKED fast-break ──
      // When a goal is already active, the parent loop has nothing useful to do.
      // Force sleep immediately on first BLOCKED (not second) with exponential
      // backoff so the agent doesn't wake every 2 minutes just to get BLOCKED again.
      const blockedGoalCall = turn.toolCalls.find(
        (tc) => tc.name === "create_goal" && tc.result?.includes("BLOCKED"),
      );
      if (blockedGoalCall) {
        // Exponential backoff: 2min → 4min → 8min → cap at 10min
        const prevBackoff = parseInt(db.getKV("blocked_goal_backoff") || "0", 10);
        const backoffMs = Math.min(
          prevBackoff > 0 ? prevBackoff * 2 : 120_000,
          600_000,
        );
        db.setKV("blocked_goal_backoff", String(backoffMs));
        log(config, `[LOOP] create_goal BLOCKED — sleeping ${Math.round(backoffMs / 1000)}s (backoff).`);
        db.setKV("sleep_until", new Date(Date.now() + backoffMs).toISOString());
        db.setAgentState("sleeping");
        onStateChange?.("sleeping");
        running = false;
        break;
      } else if (turn.toolCalls.some((tc) => tc.name === "create_goal" && !tc.error)) {
        // Goal was successfully created — reset backoff
        db.deleteKV("blocked_goal_backoff");
      }

      // ── Idle backoff reset ──
      // Only a turn that does real work (a mutating tool other than sleep
      // itself) clears the idle sleep backoff.
      const didRealWork = turn.toolCalls.some(
        (tc) => MUTATING_TOOLS.has(tc.name) && tc.name !== "sleep" && !tc.error,
      );
      if (didRealWork) {
        resetIdleBackoff(db);
      }

      // ── Loop Detection ──
      if (turn.toolCalls.length > 0) {
        const currentPattern = turn.toolCalls
          .map((tc) => tc.name)
          .sort()
          .join(",");
        // Repetition = same tools with the same arguments (or status checks
        // only). Different exec commands in a row are normal work.
        const currentSignature = turnSignature(
          turn.toolCalls.map((tc) => ({ name: tc.name, args: JSON.stringify(tc.arguments ?? {}) })),
        );
        lastToolPatterns.push(currentSignature);

        // Keep only the last MAX_REPETITIVE_TURNS entries
        if (lastToolPatterns.length > MAX_REPETITIVE_TURNS) {
          lastToolPatterns = lastToolPatterns.slice(-MAX_REPETITIVE_TURNS);
        }

        // Detect multi-tool maintenance loops: all tools in the turn are idle-only,
        // even if the specific combination varies across consecutive turns.
        const isAllIdleTools = turn.toolCalls.every((tc) => isIdleOnlyTool(tc.name));
        idleToolTurns = isAllIdleTools ? idleToolTurns + 1 : 0;
        db.setKV(IDLE_TOOL_TURNS_KEY, String(idleToolTurns));

        // Both detectors put the agent to sleep immediately (with backoff)
        // instead of injecting a message: an injected message is one more
        // paid turn, and it used to reset the idle counters.
        if (idleToolTurns >= MAX_REPETITIVE_TURNS) {
          db.setKV(
            IDLE_SLEEP_NOTE_KEY,
            `MAINTENANCE LOOP DETECTED before your last sleep: ${idleToolTurns} consecutive turns only used ` +
              `status-check tools (${turn.toolCalls.map((tc) => tc.name).join(", ")}). ` +
              `You already know your status. ` +
              (standalone
                ? STANDALONE_EARNING_GUIDANCE
                : `Review your genesis prompt and SOUL.md, then execute a CONCRETE task. ` +
                  `Write code, create a file, register a service, or build something new.`),
          );
          sleepWithBackoff(`[LOOP] Maintenance loop detected: ${idleToolTurns} consecutive idle-only turns.`);
          break;
        }

        if (
          lastToolPatterns.length === MAX_REPETITIVE_TURNS &&
          lastToolPatterns.every((p) => p === currentSignature)
        ) {
          db.setKV(
            IDLE_SLEEP_NOTE_KEY,
            `LOOP DETECTED before your last sleep: you called "${currentPattern}" with the same arguments ${MAX_REPETITIVE_TURNS} times in a row. ` +
              `Do not repeat it. Pick ONE concrete task from your genesis prompt and take a DIFFERENT approach.` +
              (standalone ? ` ${STANDALONE_EARNING_GUIDANCE}` : ""),
          );
          lastToolPatterns = [];
          sleepWithBackoff(`[LOOP] Repetitive pattern detected: ${currentPattern}.`);
          break;
        }
      }

      // Log the turn
      if (turn.thinking) {
        log(config, `[THOUGHT] ${turn.thinking.slice(0, 300)}`);
      }

      // ── Check for sleep command ──
      const sleepTool = turn.toolCalls.find((tc) => tc.name === "sleep");
      if (sleepTool && !sleepTool.error) {
        log(config, "[SLEEP] Agent chose to sleep.");
        db.setAgentState("sleeping");
        onStateChange?.("sleeping");
        running = false;
        break;
      }

      // ── Idle turn detection ──
      // If this turn had no pending input and didn't do any real work
      // (no mutations — only read/check/list/info tools), count as idle.
      // Use a blocklist of mutating tools rather than an allowlist of safe ones.
      // System-injected inputs are not real input: they don't reset the count.
      const didMutate = turn.toolCalls.some((tc) => MUTATING_TOOLS.has(tc.name));
      const hadRealInput = !!currentInput && currentInput.source !== "system";

      if (!hadRealInput && !didMutate) {
        idleTurnCount++;
        if (idleTurnCount >= MAX_IDLE_TURNS) {
          sleepWithBackoff(`[IDLE] ${idleTurnCount} consecutive idle turns with no work.`);
        }
      } else {
        idleTurnCount = 0;
      }

      // ── Cycle turn limit ──
      // Hard ceiling on turns per wake cycle, regardless of tool type.
      // Prevents runaway loops where mutating tools (exec, write_file)
      // defeat idle detection indefinitely.
      cycleTurnCount++;
      if (running && cycleTurnCount >= maxCycleTurns) {
        log(config, `[CYCLE LIMIT] ${cycleTurnCount} turns reached (max: ${maxCycleTurns}). Forcing sleep.`);
        db.setKV("sleep_until", new Date(Date.now() + 120_000).toISOString());
        db.setAgentState("sleeping");
        onStateChange?.("sleeping");
        running = false;
        break;
      }

      // ── If no tool calls and just text, the agent might be done thinking ──
      if (
        running &&
        (!response.toolCalls || response.toolCalls.length === 0) &&
        response.finishReason === "stop"
      ) {
        // Agent produced text without tool calls.
        // This is a natural pause point -- no work queued.
        sleepWithBackoff("[IDLE] No pending inputs.");
      }

      consecutiveErrors = 0;
    } catch (err: any) {
      consecutiveErrors++;
      log(config, `[ERROR] Turn failed: ${err.message}`);

      // Handle inbox message state on turn failure:
      // Messages that have retries remaining go back to 'received';
      // messages that have exhausted retries move to 'failed'.
      if (claimedMessages.length > 0) {
        const exhausted = claimedMessages.filter((m) => m.retryCount >= m.maxRetries);
        const retryable = claimedMessages.filter((m) => m.retryCount < m.maxRetries);

        if (exhausted.length > 0) {
          markInboxFailed(db.raw, exhausted.map((m) => m.id));
          log(config, `[INBOX] ${exhausted.length} message(s) moved to failed (max retries exceeded)`);
        }
        if (retryable.length > 0) {
          resetInboxToReceived(db.raw, retryable.map((m) => m.id));
          log(config, `[INBOX] ${retryable.length} message(s) reset to received for retry`);
        }
      }

      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        log(
          config,
          `[FATAL] ${MAX_CONSECUTIVE_ERRORS} consecutive errors. Sleeping.`,
        );
        db.setAgentState("sleeping");
        onStateChange?.("sleeping");
        db.setKV(
          "sleep_until",
          new Date(Date.now() + 300_000).toISOString(),
        );
        running = false;
      }
    }
  }

  log(config, `[LOOP END] Agent loop finished. State: ${db.getAgentState()}`);
}

// ─── Orchestration Runtime (one per process) ───────────────────

export interface OrchestrationRuntime {
  planModeController: PlanModeController;
  orchestrator: Orchestrator;
  workerPool: LocalWorkerPool;
  /** Updated by the loop every turn; read by the planner as its budget. */
  latestFinancial?: FinancialState;
}

// Keyed by database handle: one runtime per process (and per test database).
const orchestrationRuntimes = new WeakMap<AutomatonDatabase, OrchestrationRuntime | null>();

/** The runtime created for this database, if any (exposed for tests). */
export function getOrchestrationRuntime(db: AutomatonDatabase): OrchestrationRuntime | undefined {
  return orchestrationRuntimes.get(db) ?? undefined;
}

function getOrCreateOrchestrationRuntime(params: {
  options: AgentLoopOptions;
  standalone: boolean;
  blockrunConfig: ReturnType<typeof resolveBlockRunConfig> | undefined;
  tools: AutomatonTool[];
  toolContext: ToolContext;
}): OrchestrationRuntime | undefined {
  const { options, standalone, blockrunConfig, tools, toolContext } = params;
  const { identity, config, db, conway, policyEngine, spendTracker } = options;

  if (orchestrationRuntimes.has(db)) {
    return orchestrationRuntimes.get(db) ?? undefined;
  }
  if (!hasTable(db.raw, "goals")) {
    return undefined;
  }

  let runtime: OrchestrationRuntime | null = null;
  try {
    // Local workers only live in this process: rows left over from a
    // previous process can never be alive again.
    const staleWorkers = markAllLocalWorkersDead(db.raw);
    if (staleWorkers > 0) {
      logger.info(`Marked ${staleWorkers} local worker(s) from a previous process as dead`);
    }

    const planModeController = new PlanModeController(db.raw);

    let registry: ProviderRegistry;
    if (blockrunConfig && options.blockrunFetch) {
      // Standalone: orchestrator/workers use BlockRun, paid via the same
      // guarded x402 fetch as the main loop (shared caps and reserve).
      registry = ProviderRegistry.forBlockRun({
        apiUrl: blockrunConfig.apiUrl,
        models: {
          reasoning: blockrunConfig.models.normal,
          fast: blockrunConfig.models.lowCompute,
          cheap: blockrunConfig.models.critical,
        },
        paidFetch: options.blockrunFetch,
      });
    } else {
      // Bridge automaton config API keys to env vars for the provider registry.
      // The registry reads keys from process.env; the automaton config may have
      // them from config.json or Conway provisioning.
      if (config.openaiApiKey && !process.env.OPENAI_API_KEY) {
        process.env.OPENAI_API_KEY = config.openaiApiKey;
      }
      if (config.anthropicApiKey && !process.env.ANTHROPIC_API_KEY) {
        process.env.ANTHROPIC_API_KEY = config.anthropicApiKey;
      }
      // Conway Compute API is OpenAI-compatible. Use it as fallback when no
      // direct OpenAI key is available. The conwayApiKey is always present
      // (required for sandbox operations), so this ensures the orchestrator
      // can always make inference calls.
      if (config.conwayApiKey && !process.env.CONWAY_API_KEY) {
        process.env.CONWAY_API_KEY = config.conwayApiKey;
      }
      // If no OpenAI key is set but Conway key is available, use Conway as
      // the OpenAI provider (Conway Compute is OpenAI API-compatible).
      if (!process.env.OPENAI_API_KEY && config.conwayApiKey) {
        process.env.OPENAI_API_KEY = config.conwayApiKey;
        process.env.OPENAI_BASE_URL = `${config.conwayApiUrl}/v1`;
      }

      const providersPath = path.join(
        process.env.HOME || process.cwd(),
        ".automaton",
        "inference-providers.json",
      );
      registry = ProviderRegistry.fromConfig(providersPath);

      // If OPENAI_BASE_URL was set (Conway fallback), update the default
      // provider's baseUrl so the OpenAI client points to Conway Compute.
      if (process.env.OPENAI_BASE_URL) {
        registry.overrideBaseUrl("openai", process.env.OPENAI_BASE_URL);
      }
    }

    const unifiedInference = new UnifiedInferenceClient(registry);
    const agentTracker = new SimpleAgentTracker(db);
    const funding = new SimpleFundingProtocol(conway, identity, db);
    const messaging = new ColonyMessaging(
      new LocalDBTransport(db),
      db,
    );

    const harnessRegistry = new HarnessRegistry();

    // Adapter: local workers use the unified inference path so planner-backed
    // harnesses can preserve tier + responseFormat contracts.
    const workerInference = createWorkerInferenceBridge(unifiedInference);

    // Local worker pool: runs inference-driven agents in-process
    // as async tasks. Falls back from Conway sandbox spawning.
    const initializedWorkerPool = new LocalWorkerPool({
      db: db.raw,
      inference: workerInference,
      conway,
      harnessRegistry,
      identity,
      config,
      // Standalone: workers may only edit files under ~/work (the app
      // directory is read-only and ~/.automaton holds the wallet/state).
      allowedEditRoot: ensureStandaloneWorkDir(config) ?? process.cwd(),
      tools,
      toolContext,
      policyEngine,
      spendTracker,
      // Standalone: one paid worker at a time.
      maxConcurrent: standalone ? 1 : undefined,
    });

    const orchestrator: Orchestrator = new Orchestrator({
      db: db.raw,
      agentTracker,
      funding,
      messaging,
      inference: unifiedInference,
      identity,
      isWorkerAlive: (address: string) => {
        if (address.startsWith("local://")) {
          return initializedWorkerPool.hasWorker(address);
        }
        // Remote workers: check children table
        const child = db.raw.prepare(
          "SELECT status FROM children WHERE sandbox_id = ? OR address = ?",
        ).get(address, address) as { status: string } | undefined;
        if (!child) return false;
        return !["failed", "dead", "cleaned_up"].includes(child.status);
      },
      // Planner budget = the loop's real financial state (spendable USDC
      // in standalone mode), not the parent's row in the children table.
      getFinancialState: () => runtime?.latestFinancial,
      config: {
        ...config,
        spawnAgent: async (task: any) => {
          // Standalone: no sandboxes and no replication — in-process workers only.
          if (standalone) {
            // The task waits for the running worker to finish.
            if (!initializedWorkerPool.hasCapacity() || initializedWorkerPool.isRunningTask(task.id)) {
              return null;
            }
            try {
              return initializedWorkerPool.spawn(task);
            } catch (localError) {
              logger.warn("Failed to spawn local worker", {
                taskId: task.id,
                error: localError instanceof Error ? localError.message : String(localError),
              });
              return null;
            }
          }

          // Try Conway sandbox spawn first (production)
          try {
            const { generateGenesisConfig } = await import("../replication/genesis.js");
            const { spawnChild } = await import("../replication/spawn.js");
            const { ChildLifecycle } = await import("../replication/lifecycle.js");

            const role = task.agentRole ?? "generalist";
            const genesis = generateGenesisConfig(identity, config, {
              name: `worker-${role}-${Date.now().toString(36)}`,
              specialization: `${role}: ${task.title}`,
            });

            const lifecycle = new ChildLifecycle(db.raw);
            const child = await spawnChild(conway, identity, db, genesis, lifecycle);

            return {
              address: child.address,
              name: child.name,
              sandboxId: child.sandboxId,
            };
          } catch (sandboxError: any) {
            // If the error is a 402 (insufficient credits), attempt topup and retry once
            const is402 = sandboxError?.status === 402 ||
              sandboxError?.message?.includes("INSUFFICIENT_CREDITS");

            if (is402) {
              const SANDBOX_TOPUP_COOLDOWN_MS = 60_000;
              const lastAttempt = db.getKV("last_sandbox_topup_attempt");
              const cooldownExpired = !lastAttempt ||
                Date.now() - new Date(lastAttempt).getTime() >= SANDBOX_TOPUP_COOLDOWN_MS;

              if (cooldownExpired) {
                db.setKV("last_sandbox_topup_attempt", new Date().toISOString());
                try {
                  const { topupForSandbox } = await import("../conway/topup.js");
                  const topupResult = await topupForSandbox({
                    apiUrl: config.conwayApiUrl,
                    account: identity.account,
                    error: sandboxError,
                    chainType: config.chainType || identity.chainType || "evm",
                  });

                  if (topupResult?.success) {
                    logger.info(`Sandbox topup succeeded ($${topupResult.amountUsd}), retrying spawn`, {
                      taskId: task.id,
                    });
                    // Retry spawn once after successful topup
                    try {
                      const { generateGenesisConfig: genGenesis } = await import("../replication/genesis.js");
                      const { spawnChild: retrySpawn } = await import("../replication/spawn.js");
                      const { ChildLifecycle: RetryLifecycle } = await import("../replication/lifecycle.js");

                      const retryRole = task.agentRole ?? "generalist";
                      const retryGenesis = genGenesis(identity, config, {
                        name: `worker-${retryRole}-${Date.now().toString(36)}`,
                        specialization: `${retryRole}: ${task.title}`,
                      });
                      const retryLifecycle = new RetryLifecycle(db.raw);
                      const child = await retrySpawn(conway, identity, db, retryGenesis, retryLifecycle);
                      return {
                        address: child.address,
                        name: child.name,
                        sandboxId: child.sandboxId,
                      };
                    } catch (retryError) {
                      logger.warn("Spawn retry after topup failed", {
                        taskId: task.id,
                        error: retryError instanceof Error ? retryError.message : String(retryError),
                      });
                    }
                  }
                } catch (topupError) {
                  logger.warn("Sandbox topup attempt failed", {
                    taskId: task.id,
                    error: topupError instanceof Error ? topupError.message : String(topupError),
                  });
                }
              }
            }

            // Conway sandbox unavailable — fall back to local worker
            logger.info("Conway sandbox unavailable, spawning local worker", {
              taskId: task.id,
              error: sandboxError instanceof Error ? sandboxError.message : String(sandboxError),
            });

            try {
              const spawned = initializedWorkerPool.spawn(task);
              return spawned;
            } catch (localError) {
              logger.warn("Failed to spawn local worker", {
                taskId: task.id,
                error: localError instanceof Error ? localError.message : String(localError),
              });
              return null;
            }
          }
        },
      },
    });
runtime = { planModeController, orchestrator, workerPool: initializedWorkerPool };
  } catch (error) {
    logger.warn(
      `Orchestrator initialization failed, continuing without orchestration: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    runtime = null;
  }
  orchestrationRuntimes.set(db, runtime);
  return runtime ?? undefined;
}

// ─── Helpers ───────────────────────────────────────────────────

// Cache last known good balances so transient API failures don't
// cause the automaton to believe it has $0 and kill itself.
let _lastKnownCredits = 0;
let _lastKnownUsdc = 0;

async function getFinancialState(
  conway: ConwayClient,
  address: string,
  db?: AutomatonDatabase,
  chainType?: string,
): Promise<FinancialState> {
  let creditsCents = _lastKnownCredits;
  let usdcBalance = _lastKnownUsdc;

  try {
    creditsCents = await conway.getCreditsBalance();
    if (creditsCents > 0) _lastKnownCredits = creditsCents;
  } catch (error) {
    logger.error("Credits balance fetch failed", error instanceof Error ? error : undefined);
    // Use last known balance from KV, not zero
    if (db) {
      const cached = db.getKV("last_known_balance");
      if (cached) {
        try {
          const parsed = JSON.parse(cached);
          logger.warn("Balance API failed, using cached balance");
          return {
            creditsCents: parsed.creditsCents ?? 0,
            usdcBalance: parsed.usdcBalance ?? 0,
            lastChecked: new Date().toISOString(),
          };
        } catch (parseError) {
          logger.error("Failed to parse cached balance", parseError instanceof Error ? parseError : undefined);
        }
      }
    }
    // No cache available -- return conservative non-zero sentinel
    logger.error("Balance API failed, no cache available");
    return {
      creditsCents: -1,
      usdcBalance: -1,
      lastChecked: new Date().toISOString(),
    };
  }

  try {
    const network = chainType === "solana" ? "solana:mainnet" : "eip155:8453";
    usdcBalance = await getUsdcBalance(address, network, chainType as any);
    if (usdcBalance > 0) _lastKnownUsdc = usdcBalance;
  } catch (error) {
    logger.error("USDC balance fetch failed", error instanceof Error ? error : undefined);
  }

  // Cache successful balance reads
  if (db) {
    try {
      db.setKV(
        "last_known_balance",
        JSON.stringify({ creditsCents, usdcBalance }),
      );
    } catch (error) {
      logger.error("Failed to cache balance", error instanceof Error ? error : undefined);
    }
  }

  return {
    creditsCents,
    usdcBalance,
    lastChecked: new Date().toISOString(),
  };
}

function log(_config: AutomatonConfig, message: string): void {
  logger.info(message);
}

function hasTable(db: AutomatonDatabase["raw"], tableName: string): boolean {
  try {
    const row = db
      .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(tableName) as { ok?: number } | undefined;
    return Boolean(row?.ok);
  } catch {
    return false;
  }
}
