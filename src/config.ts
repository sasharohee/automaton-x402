/**
 * Automaton Configuration
 *
 * Loads and saves the automaton's configuration from ~/.automaton/automaton.json
 */

import fs from "fs";
import path from "path";
import type {
  AutomatonConfig,
  TreasuryPolicy,
  ModelStrategyConfig,
  SoulConfig,
  ProviderMode,
  BlockRunConfig,
} from "./types.js";
import {
  DEFAULT_CONFIG,
  DEFAULT_TREASURY_POLICY,
  DEFAULT_MODEL_STRATEGY_CONFIG,
  DEFAULT_SOUL_CONFIG,
  DEFAULT_BLOCKRUN_CONFIG,
  STANDALONE_TREASURY_POLICY,
} from "./types.js";
import { getAutomatonDir } from "./identity/wallet.js";
import { loadApiKeyFromConfig } from "./identity/provision.js";
import { createLogger } from "./observability/logger.js";
import type { ChainType } from "./identity/chain.js";

const logger = createLogger("config");
const CONFIG_FILENAME = "automaton.json";

export function getConfigPath(): string {
  return path.join(getAutomatonDir(), CONFIG_FILENAME);
}

/**
 * Load the automaton config from disk.
 * Merges with defaults for any missing fields.
 */
export function loadConfig(): AutomatonConfig | null {
  const configPath = getConfigPath();
  if (!fs.existsSync(configPath)) {
    return null;
  }

  try {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    const providerMode: ProviderMode =
      process.env.AUTOMATON_PROVIDER_MODE === "standalone" ||
      process.env.AUTOMATON_PROVIDER_MODE === "conway"
        ? process.env.AUTOMATON_PROVIDER_MODE
        : raw.providerMode === "standalone"
          ? "standalone"
          : "conway";
    const standalone = providerMode === "standalone";
    const apiKey = raw.conwayApiKey || (standalone ? "" : loadApiKeyFromConfig()) || "";

    // Deep-merge treasury policy with mode-appropriate defaults
    const policyDefaults = standalone ? STANDALONE_TREASURY_POLICY : DEFAULT_TREASURY_POLICY;
    const treasuryPolicy: TreasuryPolicy = {
      ...policyDefaults,
      ...(raw.treasuryPolicy ?? {}),
    };

    // Validate all treasury values are positive numbers
    for (const [key, value] of Object.entries(treasuryPolicy)) {
      if (key === "x402AllowedDomains") continue; // array, not number
      if (typeof value !== "number" || value < 0 || !Number.isFinite(value)) {
        logger.warn(`Invalid treasury value for ${key}: ${value}, using default`);
        (treasuryPolicy as any)[key] = (policyDefaults as any)[key];
      }
    }

    // Standalone: model names come from the BlockRun tier map
    const blockrun: BlockRunConfig | undefined = standalone
      ? {
          apiUrl: raw.blockrun?.apiUrl || DEFAULT_BLOCKRUN_CONFIG.apiUrl,
          models: { ...DEFAULT_BLOCKRUN_CONFIG.models, ...(raw.blockrun?.models ?? {}) },
        }
      : raw.blockrun;

    // Deep-merge model strategy config with defaults. In standalone mode the
    // BlockRun tier map is the single source of truth for model names.
    const modelStrategy: ModelStrategyConfig = {
      ...DEFAULT_MODEL_STRATEGY_CONFIG,
      ...(raw.modelStrategy ?? {}),
      ...(blockrun && standalone
        ? {
            inferenceModel: blockrun.models.normal,
            lowComputeModel: blockrun.models.lowCompute,
            criticalModel: blockrun.models.critical,
          }
        : {}),
    };

    // Deep-merge soul config with defaults
    const soulConfig: SoulConfig = {
      ...DEFAULT_SOUL_CONFIG,
      ...(raw.soulConfig ?? {}),
    };

    return {
      ...DEFAULT_CONFIG,
      ...raw,
      sandboxId:
        typeof raw.sandboxId === "string"
          ? raw.sandboxId.trim()
          : DEFAULT_CONFIG.sandboxId,
      conwayApiKey: apiKey,
      treasuryPolicy,
      modelStrategy,
      soulConfig,
      chainType: raw.chainType || "evm",
      providerMode,
      blockrun,
      inferenceModel:
        standalone && blockrun
          ? blockrun.models.normal
          : raw.inferenceModel || DEFAULT_CONFIG.inferenceModel,
      // The Conway social relay is Conway infrastructure: opt-in in standalone mode.
      socialRelayUrl: standalone ? raw.socialRelayUrl : (raw.socialRelayUrl ?? DEFAULT_CONFIG.socialRelayUrl),
      // Standalone: replication is not available.
      maxChildren: standalone ? 0 : (raw.maxChildren ?? DEFAULT_CONFIG.maxChildren),
      autoUpdate: raw.autoUpdate === true,
    } as AutomatonConfig;
  } catch {
    return null;
  }
}

/**
 * Save the automaton config to disk.
 * Includes treasuryPolicy in the persisted config.
 */
export function saveConfig(config: AutomatonConfig): void {
  const dir = getAutomatonDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  const configPath = getConfigPath();
  const toSave = {
    ...config,
    treasuryPolicy: config.treasuryPolicy ?? DEFAULT_TREASURY_POLICY,
    modelStrategy: config.modelStrategy ?? DEFAULT_MODEL_STRATEGY_CONFIG,
    soulConfig: config.soulConfig ?? DEFAULT_SOUL_CONFIG,
  };
  fs.writeFileSync(configPath, JSON.stringify(toSave, null, 2), {
    mode: 0o600,
  });
}

/**
 * Resolve ~ paths to absolute paths.
 */
export function resolvePath(p: string): string {
  if (p.startsWith("~")) {
    return path.join(process.env.HOME || "/root", p.slice(1));
  }
  return p;
}

/**
 * Create a fresh config from setup wizard inputs.
 */
export function createConfig(params: {
  name: string;
  genesisPrompt: string;
  creatorMessage?: string;
  creatorAddress: string;
  registeredWithConway: boolean;
  sandboxId: string;
  walletAddress: string;
  apiKey: string;
  openaiApiKey?: string;
  anthropicApiKey?: string;
  ollamaBaseUrl?: string;
  parentAddress?: string;
  treasuryPolicy?: TreasuryPolicy;
  chainType?: ChainType;
  providerMode?: ProviderMode;
  blockrun?: BlockRunConfig;
}): AutomatonConfig {
  const normalizedSandboxId = (params.sandboxId || "").trim();
  const standalone = params.providerMode === "standalone";
  const blockrun = standalone ? (params.blockrun ?? DEFAULT_BLOCKRUN_CONFIG) : params.blockrun;
  return {
    name: params.name,
    genesisPrompt: params.genesisPrompt,
    creatorMessage: params.creatorMessage,
    creatorAddress: params.creatorAddress,
    registeredWithConway: params.registeredWithConway,
    sandboxId: normalizedSandboxId,
    conwayApiUrl:
      DEFAULT_CONFIG.conwayApiUrl || "https://api.conway.tech",
    conwayApiKey: params.apiKey,
    openaiApiKey: params.openaiApiKey,
    anthropicApiKey: params.anthropicApiKey,
    ollamaBaseUrl: params.ollamaBaseUrl,
    inferenceModel: standalone && blockrun
      ? blockrun.models.normal
      : DEFAULT_CONFIG.inferenceModel || "gpt-5.2",
    maxTokensPerTurn: DEFAULT_CONFIG.maxTokensPerTurn || 4096,
    heartbeatConfigPath:
      DEFAULT_CONFIG.heartbeatConfigPath || "~/.automaton/heartbeat.yml",
    dbPath: DEFAULT_CONFIG.dbPath || "~/.automaton/state.db",
    logLevel: (DEFAULT_CONFIG.logLevel as AutomatonConfig["logLevel"]) || "info",
    walletAddress: params.walletAddress,
    version: DEFAULT_CONFIG.version || "0.2.1",
    skillsDir: DEFAULT_CONFIG.skillsDir || "~/.automaton/skills",
    maxChildren: standalone ? 0 : (DEFAULT_CONFIG.maxChildren ?? 0),
    parentAddress: params.parentAddress,
    treasuryPolicy:
      params.treasuryPolicy ?? (standalone ? STANDALONE_TREASURY_POLICY : DEFAULT_TREASURY_POLICY),
    chainType: params.chainType || "evm",
    providerMode: params.providerMode ?? "conway",
    blockrun,
    ...(standalone && blockrun
      ? {
          modelStrategy: {
            ...DEFAULT_MODEL_STRATEGY_CONFIG,
            inferenceModel: blockrun.models.normal,
            lowComputeModel: blockrun.models.lowCompute,
            criticalModel: blockrun.models.critical,
          },
        }
      : {}),
    socialRelayUrl: standalone ? undefined : DEFAULT_CONFIG.socialRelayUrl,
    autoUpdate: false,
  };
}
