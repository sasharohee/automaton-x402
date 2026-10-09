/**
 * Infrastructure Provider Selection
 *
 * Single place that decides how the automaton reaches the outside world:
 *   - "conway"     : legacy Conway Cloud (sandboxes, credits, inference)
 *   - "standalone" : no Conway — host execution, BlockRun inference paid
 *                    per call with x402 v2, on-chain USDC as survival balance
 */

import type { PrivateKeyAccount } from "viem";
import type {
  AutomatonConfig,
  AutomatonTool,
  BlockRunConfig,
  ConwayClient,
  ModelTierMap,
  SpendTrackerInterface,
  TreasuryPolicy,
} from "../types.js";
import {
  DEFAULT_BLOCKRUN_CONFIG,
  DEFAULT_TREASURY_POLICY,
  STANDALONE_TREASURY_POLICY,
} from "../types.js";
import { createConwayClient } from "./client.js";
import { createStandaloneClient } from "./standalone-client.js";
import { createX402Fetch, PaymentLedger } from "./x402-v2.js";
import { getUsdcBalanceDetailed } from "./x402.js";
import { SpendGuard } from "../survival/spend-guard.js";
import { resolveModelEscalation } from "../inference/model-escalation.js";
import type Database from "better-sqlite3";
import { FLUENCE_SANDBOX_TOOLS, FLUENCE_TOOLS, isFluenceEnabled } from "../fluence/config.js";
import { getFluenceRuntime } from "../fluence/runtime.js";

export function isStandalone(config: Pick<AutomatonConfig, "providerMode"> | undefined | null): boolean {
  return config?.providerMode === "standalone";
}

/** Treasury policy with mode-appropriate defaults. */
export function resolveTreasuryPolicy(config: Pick<AutomatonConfig, "providerMode" | "treasuryPolicy">): TreasuryPolicy {
  const defaults = isStandalone(config) ? STANDALONE_TREASURY_POLICY : DEFAULT_TREASURY_POLICY;
  return { ...defaults, ...(config.treasuryPolicy ?? {}) };
}

export function resolveBlockRunConfig(config: Pick<AutomatonConfig, "blockrun">): BlockRunConfig {
  const apiUrl = process.env.BLOCKRUN_API_URL || config.blockrun?.apiUrl || DEFAULT_BLOCKRUN_CONFIG.apiUrl;
  const models: ModelTierMap = {
    ...DEFAULT_BLOCKRUN_CONFIG.models,
    ...(config.blockrun?.models ?? {}),
  };
  return {
    apiUrl: apiUrl.replace(/\/$/, ""),
    models,
    escalation: resolveModelEscalation(config.blockrun?.escalation),
  };
}

/**
 * Tools that require Conway infrastructure (sandboxes, ports, domains,
 * Conway credits) or that move money between agents. They are not offered
 * to the model in standalone mode.
 */
export const STANDALONE_DISABLED_TOOLS: ReadonlySet<string> = new Set([
  // Sandbox / ports
  "expose_port",
  "remove_port",
  "create_sandbox",
  "delete_sandbox",
  "list_sandboxes",
  // Conway credits
  "check_credits",
  "topup_credits",
  "transfer_credits",
  // Domains
  "search_domains",
  "register_domain",
  "manage_dns",
  // Replication
  "spawn_child",
  "fund_child",
  "start_child",
  "list_children",
  "check_child_status",
  "message_child",
  "verify_child_constitution",
  "prune_dead_children",
  // Upstream code updates (would overwrite the standalone guardrails)
  "pull_upstream",
  "reset_to_upstream",
  "review_upstream_changes",
]);

/** Tools that can never run in standalone mode, even if requested directly. */
export const STANDALONE_FORBIDDEN_TOOLS: ReadonlySet<string> = new Set([
  "spawn_child",
  "fund_child",
  "transfer_credits",
  "pull_upstream",
  "reset_to_upstream",
  "review_upstream_changes",
]);

/**
 * Tools offered to the model for this provider. Fluence (standalone only,
 * `fluence.enabled`) re-enables ONLY create/list/delete_sandbox and adds the
 * fluence_* / sandbox_exec / sandbox_upload tools; they are hidden otherwise.
 */
export function filterToolsForProvider<T extends Pick<AutomatonTool, "name">>(
  tools: T[],
  config: Pick<AutomatonConfig, "providerMode" | "fluence">,
): T[] {
  const fluence = isFluenceEnabled(config);
  if (!isStandalone(config)) return tools.filter((t) => !FLUENCE_TOOLS.has(t.name));
  return tools.filter((t) => {
    if (FLUENCE_TOOLS.has(t.name)) return fluence;
    if (fluence && FLUENCE_SANDBOX_TOOLS.has(t.name)) return true;
    return !STANDALONE_DISABLED_TOOLS.has(t.name);
  });
}

export function createProviderClient(params: {
  config: AutomatonConfig;
  apiKey: string;
  walletAddress: string;
  /** Standalone + Fluence: the agent account (SIWE, x402 top-ups) and the DB. */
  account?: PrivateKeyAccount;
  db?: Database.Database;
}): ConwayClient {
  const { config, apiKey, walletAddress } = params;
  if (isStandalone(config)) {
    const fluence =
      params.account && params.db
        ? getFluenceRuntime({ config, account: params.account, db: params.db })
        : null;
    return createStandaloneClient({
      walletAddress,
      reserveCents: resolveTreasuryPolicy(config).minimumReserveCents,
      blockrunApiUrl: resolveBlockRunConfig(config).apiUrl,
      sandboxes: fluence?.vms,
    });
  }
  return createConwayClient({
    apiUrl: config.conwayApiUrl,
    apiKey,
    sandboxId: config.sandboxId,
  });
}

/** Raw on-chain USDC balance in cents (throws if the RPC read fails). */
export async function readWalletBalanceCents(address: string): Promise<number> {
  const result = await getUsdcBalanceDetailed(address as `0x${string}`, "eip155:8453");
  if (!result.ok) throw new Error(result.error || "USDC balance read failed");
  return Math.floor(result.balance * 100);
}

/**
 * Build the x402-paying fetch used for BlockRun inference, wired to the
 * spend guard (per-request max, $/day inference cap, wallet reserve).
 */
export function createBlockRunPaymentFetch(params: {
  config: AutomatonConfig;
  account: PrivateKeyAccount;
  spendTracker: SpendTrackerInterface;
  getBalanceCents?: () => Promise<number>;
}): { fetch: typeof fetch; guard: SpendGuard } {
  const policy = resolveTreasuryPolicy(params.config);
  const guard = new SpendGuard({
    policy,
    category: "inference",
    spendTracker: params.spendTracker,
    getBalanceCents: params.getBalanceCents ?? (() => readWalletBalanceCents(params.account.address)),
    toolName: "blockrun_inference",
  });
  const paidFetch = createX402Fetch({
    account: params.account,
    maxPaymentCents: policy.maxX402PaymentCents,
    allowedDomains: policy.x402AllowedDomains,
    guard,
    ledger: new PaymentLedger(),
  });
  return { fetch: paidFetch, guard };
}
