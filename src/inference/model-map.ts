/**
 * Configurable Model Map
 *
 * Builds the routing matrix and registry entries from a survival-tier →
 * model mapping (`config.blockrun.models`) instead of hard-coded model names.
 */

import type {
  ModelEntry,
  ModelProvider,
  ModelTierMap,
  RoutingMatrix,
  SurvivalTier,
} from "../types.js";
import type { ModelRegistry } from "./registry.js";

/** Model to use for a survival tier (null = no inference allowed). */
export function modelForTier(map: ModelTierMap, tier: SurvivalTier): string | null {
  switch (tier) {
    case "high":
      return map.high || map.normal;
    case "normal":
      return map.normal;
    case "low_compute":
      return map.lowCompute;
    case "critical":
      return map.critical;
    case "dead":
      return null;
  }
}

function unique(ids: (string | undefined | null)[]): string[] {
  return [...new Set(ids.filter((id): id is string => !!id))];
}

/**
 * Same shape and budgets as DEFAULT_ROUTING_MATRIX, but candidates come
 * from the configured map. Cheaper tier models are used as fallbacks.
 */
export function buildRoutingMatrix(map: ModelTierMap): RoutingMatrix {
  const high = map.high || map.normal;
  const pref = (candidates: string[], maxTokens: number, ceilingCents: number) => ({
    candidates,
    maxTokens,
    ceilingCents,
  });
  const none = pref([], 0, 0);
  return {
    high: {
      agent_turn: pref(unique([high, map.normal]), 8192, -1),
      heartbeat_triage: pref(unique([map.lowCompute]), 2048, 5),
      safety_check: pref(unique([high, map.normal]), 4096, 20),
      summarization: pref(unique([map.normal, map.lowCompute]), 4096, 15),
      planning: pref(unique([high, map.normal]), 8192, -1),
    },
    normal: {
      agent_turn: pref(unique([map.normal, map.lowCompute]), 4096, -1),
      heartbeat_triage: pref(unique([map.lowCompute]), 2048, 5),
      safety_check: pref(unique([map.normal, map.lowCompute]), 4096, 10),
      summarization: pref(unique([map.normal, map.lowCompute]), 4096, 10),
      planning: pref(unique([map.normal, map.lowCompute]), 4096, -1),
    },
    low_compute: {
      agent_turn: pref(unique([map.lowCompute]), 4096, 10),
      heartbeat_triage: pref(unique([map.lowCompute]), 1024, 2),
      safety_check: pref(unique([map.lowCompute]), 2048, 5),
      summarization: pref(unique([map.lowCompute]), 2048, 5),
      planning: pref(unique([map.lowCompute]), 2048, 5),
    },
    critical: {
      agent_turn: pref(unique([map.critical]), 2048, 3),
      heartbeat_triage: pref(unique([map.critical]), 512, 1),
      safety_check: pref(unique([map.critical]), 1024, 2),
      summarization: none,
      planning: none,
    },
    dead: {
      agent_turn: none,
      heartbeat_triage: none,
      safety_check: none,
      summarization: none,
      planning: none,
    },
  };
}

/**
 * Rough per-1k-token estimates (hundredths of cents) used for budget
 * pre-checks only. Real charges are whatever the x402 challenge asks for,
 * and are capped by the spend guard.
 */
const DEFAULT_COST_ESTIMATE = { input: 3, output: 11 }; // ≈ deepseek-chat

/**
 * Register the mapped models in the model registry so the router can select
 * them. Lowest tier a model is mapped to becomes its `tierMinimum`.
 */
export function registerMappedModels(
  registry: Pick<ModelRegistry, "get" | "upsert">,
  map: ModelTierMap,
  provider: ModelProvider = "blockrun",
  escalationModel?: string,
): void {
  const now = new Date().toISOString();
  // The escalation model is only used in tiers high/normal.
  const tierFor = (id: string): SurvivalTier =>
    id === map.critical ? "critical" : id === map.lowCompute ? "low_compute" : "normal";

  for (const modelId of unique([map.high, map.normal, map.lowCompute, map.critical, escalationModel])) {
    const existing = registry.get(modelId);
    const entry: ModelEntry = {
      modelId,
      provider,
      displayName: existing?.displayName || modelId,
      tierMinimum: tierFor(modelId),
      costPer1kInput: existing?.provider === provider ? existing.costPer1kInput : DEFAULT_COST_ESTIMATE.input,
      costPer1kOutput: existing?.provider === provider ? existing.costPer1kOutput : DEFAULT_COST_ESTIMATE.output,
      maxTokens: existing?.maxTokens || 8192,
      contextWindow: existing?.contextWindow || 64000,
      supportsTools: true,
      supportsVision: existing?.supportsVision ?? false,
      parameterStyle: "max_tokens",
      enabled: true,
      lastSeen: null,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };
    registry.upsert(entry);
  }
}
