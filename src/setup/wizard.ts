import fs from "fs";
import path from "path";
import chalk from "chalk";
import type { AutomatonConfig, BlockRunConfig, ProviderMode, TreasuryPolicy } from "../types.js";
import {
  DEFAULT_BLOCKRUN_CONFIG,
  DEFAULT_TREASURY_POLICY,
  STANDALONE_TREASURY_POLICY,
} from "../types.js";
import { getWallet, getAutomatonDir } from "../identity/wallet.js";
import { provision } from "../identity/provision.js";
import { createConfig, saveConfig } from "../config.js";
import { writeDefaultHeartbeatConfig } from "../heartbeat/config.js";
import { showBanner } from "./banner.js";
import {
  promptRequired,
  promptMultiline,
  promptAddress,
  promptOptional,
  promptWithDefault,
  promptOptionalPositive,
  closePrompts,
} from "./prompts.js";
import { detectEnvironment } from "./environment.js";
import { generateSoulMd, installDefaultSkills } from "./defaults.js";
import type { ChainType, ChainIdentity } from "../identity/chain.js";

export async function runSetupWizard(): Promise<AutomatonConfig> {
  showBanner();

  console.log(chalk.white("  First-run setup. Let's bring your automaton to life.\n"));

  // ─── 0. Infrastructure provider ───────────────────────────────
  console.log(chalk.cyan("  Infrastructure provider"));
  console.log(chalk.dim("  standalone = no Conway: host execution + BlockRun inference paid in USDC (x402) on Base."));
  console.log(chalk.dim("  conway     = legacy Conway Cloud (requires an existing Conway account).\n"));
  const providerInput = (await promptOptional("Provider (standalone or conway) [standalone]")).toLowerCase();
  const providerMode: ProviderMode = providerInput === "conway" ? "conway" : "standalone";
  const standalone = providerMode === "standalone";
  console.log(chalk.green(`  Provider: ${providerMode}\n`));

  // ─── 1. Chain selection + wallet ──────────────────────────────
  console.log(chalk.cyan("  [1/6] Chain selection & identity (wallet)..."));
  let selectedChain: ChainType = "evm";
  if (standalone) {
    console.log(chalk.green("  Chain: EVM (Base) — required for x402 USDC payments\n"));
  } else {
    const chainInput = await promptOptional("Chain type (evm or solana) [evm]");
    if (chainInput && chainInput.toLowerCase() === "solana") {
      selectedChain = "solana";
      console.log(chalk.green("  Chain: Solana (Ed25519)\n"));
    } else {
      console.log(chalk.green("  Chain: EVM (secp256k1)\n"));
    }
  }

  const { account, chainIdentity, chainType: walletChainType, isNew } = await getWallet(selectedChain);
  const walletAddress = chainIdentity.address;
  if (isNew) {
    console.log(chalk.green(`  Wallet created: ${walletAddress}`));
  } else {
    console.log(chalk.green(`  Wallet loaded: ${walletAddress}`));
  }
  console.log(chalk.dim(`  Private key stored at: ${getAutomatonDir()}/wallet.json\n`));

  // ─── 2. Provision API key ─────────────────────────────────────
  let apiKey = "";
  if (standalone) {
    console.log(chalk.cyan("  [2/6] Conway API key"));
    console.log(chalk.dim("  Skipped: standalone mode does not use Conway.\n"));
  } else {
    apiKey = await provisionConwayApiKey(walletChainType, chainIdentity, walletAddress);
  }

  // ─── 3. Interactive questions ─────────────────────────────────
  console.log(chalk.cyan("  [3/6] Setup questions\n"));

  const name = await promptRequired("What do you want to name your automaton?");
  console.log(chalk.green(`  Name: ${name}\n`));

  const genesisPrompt = await promptMultiline("Enter the genesis prompt (system prompt) for your automaton.");
  console.log(chalk.green(`  Genesis prompt set (${genesisPrompt.length} chars)\n`));

  console.log(chalk.dim(`  Your automaton's address is ${walletAddress}`));
  console.log(chalk.dim("  Now enter YOUR wallet address (the human creator/owner).\n"));
  const creatorAddressLabel = walletChainType === "solana"
    ? "Creator wallet address (base58)"
    : "Creator wallet address (0x...)";
  const creatorAddress = await promptAddress(creatorAddressLabel, walletChainType);
  console.log(chalk.green(`  Creator: ${creatorAddress}\n`));

  let blockrun: BlockRunConfig | undefined;
  let openaiApiKey = "";
  let anthropicApiKey = "";
  let ollamaBaseUrl: string | undefined;
  if (standalone) {
    console.log(chalk.white("  BlockRun inference models (paid per call in USDC via x402)."));
    console.log(chalk.dim("  Pick tool-capable models. List: GET https://blockrun.ai/api/v1/models\n"));
    const defaults = DEFAULT_BLOCKRUN_CONFIG.models;
    console.log(chalk.dim(`  low_compute and critical stay on ${defaults.lowCompute} (cheapest). A stronger model for`));
    console.log(chalk.dim("  normal/high costs more per call but still counts against the daily cap.\n"));
    const normal = (await promptOptional(`Model for the normal tier [${defaults.normal}]`)) || defaults.normal;
    const high = (await promptOptional(`Model for the high tier [${defaults.high || normal}]`)) || defaults.high || normal;
    blockrun = {
      apiUrl: DEFAULT_BLOCKRUN_CONFIG.apiUrl,
      models: { high, normal, lowCompute: defaults.lowCompute, critical: defaults.critical },
    };
    console.log(chalk.green(`  Models: high=${high}, normal=${normal}, low/critical=${defaults.lowCompute}\n`));
  } else {
    ({ openaiApiKey, anthropicApiKey, ollamaBaseUrl } = await promptProviderKeys());
  }

  // ─── Financial Safety Policy ─────────────────────────────────
  console.log(chalk.cyan("  Financial Safety Policy"));
  console.log(chalk.dim("  These limits protect against unauthorized spending. Press Enter for defaults.\n"));

  const treasuryPolicy: TreasuryPolicy = standalone ? {
    ...STANDALONE_TREASURY_POLICY,
    maxTotalDailySpendCents: await promptWithDefault(
      "Max total daily spend, all payments combined (cents)", STANDALONE_TREASURY_POLICY.maxTotalDailySpendCents),
    maxInferenceDailyCents: await promptWithDefault(
      "Max daily inference spend (cents)", STANDALONE_TREASURY_POLICY.maxInferenceDailyCents),
    maxX402PaymentCents: await promptWithDefault(
      "Max x402 payment per request (cents)", STANDALONE_TREASURY_POLICY.maxX402PaymentCents),
    minimumReserveCents: await promptWithDefault(
      "Wallet reserve never spent (cents)", STANDALONE_TREASURY_POLICY.minimumReserveCents),
    maxSingleTransferCents: await promptWithDefault(
      "Max single transfer (cents)", STANDALONE_TREASURY_POLICY.maxSingleTransferCents),
  } : {
    maxSingleTransferCents: await promptWithDefault(
      "Max single transfer (cents)", DEFAULT_TREASURY_POLICY.maxSingleTransferCents),
    maxHourlyTransferCents: await promptWithDefault(
      "Max hourly transfers (cents)", DEFAULT_TREASURY_POLICY.maxHourlyTransferCents),
    maxDailyTransferCents: await promptWithDefault(
      "Max daily transfers (cents)", DEFAULT_TREASURY_POLICY.maxDailyTransferCents),
    minimumReserveCents: await promptWithDefault(
      "Minimum reserve (cents)", DEFAULT_TREASURY_POLICY.minimumReserveCents),
    maxX402PaymentCents: await promptWithDefault(
      "Max x402 payment (cents)", DEFAULT_TREASURY_POLICY.maxX402PaymentCents),
    x402AllowedDomains: DEFAULT_TREASURY_POLICY.x402AllowedDomains,
    transferCooldownMs: DEFAULT_TREASURY_POLICY.transferCooldownMs,
    maxTransfersPerTurn: DEFAULT_TREASURY_POLICY.maxTransfersPerTurn,
    maxInferenceDailyCents: await promptWithDefault(
      "Max daily inference spend (cents)", DEFAULT_TREASURY_POLICY.maxInferenceDailyCents),
    maxTotalDailySpendCents: await promptWithDefault(
      "Max total daily spend, all categories (cents)", DEFAULT_TREASURY_POLICY.maxTotalDailySpendCents),
    requireConfirmationAboveCents: await promptWithDefault(
      "Require confirmation above (cents)", DEFAULT_TREASURY_POLICY.requireConfirmationAboveCents),
  };

  const maxInferenceHourlyCents = await promptOptionalPositive(
    "Max hourly inference spend (cents, empty = daily / 6)");
  if (maxInferenceHourlyCents !== undefined) {
    treasuryPolicy.maxInferenceHourlyCents = maxInferenceHourlyCents;
  }

  console.log(chalk.green("  Treasury policy configured.\n"));

  // ─── 4. Detect environment ────────────────────────────────────
  console.log(chalk.cyan("  [4/6] Detecting environment..."));
  const env = detectEnvironment();
  if (env.sandboxId) {
    console.log(chalk.green(`  Conway sandbox detected: ${env.sandboxId}\n`));
  } else {
    console.log(chalk.dim(`  Environment: ${env.type} (no sandbox detected)\n`));
  }

  // ─── 5. Write config + heartbeat + SOUL.md + skills ───────────
  console.log(chalk.cyan("  [5/6] Writing configuration..."));

  const config = createConfig({
    name,
    genesisPrompt,
    creatorAddress,
    registeredWithConway: !standalone && !!apiKey,
    // Standalone: always execute on the host, never in a Conway sandbox.
    sandboxId: standalone ? "" : env.sandboxId,
    walletAddress,
    apiKey,
    openaiApiKey: openaiApiKey || undefined,
    anthropicApiKey: anthropicApiKey || undefined,
    ollamaBaseUrl,
    treasuryPolicy,
    chainType: walletChainType,
    providerMode,
    blockrun,
  });

  saveConfig(config);
  console.log(chalk.green("  automaton.json written"));

  writeDefaultHeartbeatConfig();
  console.log(chalk.green("  heartbeat.yml written"));

  // constitution.md (immutable — copied from repo, protected from self-modification)
  const automatonDir = getAutomatonDir();
  const constitutionSrc = path.join(process.cwd(), "constitution.md");
  const constitutionDst = path.join(automatonDir, "constitution.md");
  if (fs.existsSync(constitutionSrc)) {
    fs.copyFileSync(constitutionSrc, constitutionDst);
    fs.chmodSync(constitutionDst, 0o444); // read-only
    console.log(chalk.green("  constitution.md installed (read-only)"));
  }

  // SOUL.md
  const soulPath = path.join(automatonDir, "SOUL.md");
  fs.writeFileSync(soulPath, generateSoulMd(name, walletAddress, creatorAddress, genesisPrompt), { mode: 0o600 });
  console.log(chalk.green("  SOUL.md written"));

  // Default skills
  const skillsDir = config.skillsDir || "~/.automaton/skills";
  installDefaultSkills(skillsDir);
  console.log(chalk.green("  Default skills installed (conway-compute, conway-payments, survival)\n"));

  // ─── 6. Funding guidance ──────────────────────────────────────
  console.log(chalk.cyan("  [6/6] Funding\n"));
  if (standalone) {
    showStandaloneFundingPanel(walletAddress, treasuryPolicy);
  } else {
    showFundingPanel(walletAddress, walletChainType);
  }

  closePrompts();

  return config;
}

async function provisionConwayApiKey(
  walletChainType: ChainType,
  chainIdentity: ChainIdentity,
  walletAddress: string,
): Promise<string> {
  const provisionLabel = walletChainType === "solana"
    ? "  [2/6] Provisioning Conway API key (SIWS)..."
    : "  [2/6] Provisioning Conway API key (SIWE)...";
  console.log(chalk.cyan(provisionLabel));
  let apiKey = "";
  try {
    const result = await provision(undefined, walletChainType === "solana" ? chainIdentity : undefined);
    apiKey = result.apiKey;
    console.log(chalk.green(`  API key provisioned: ${result.keyPrefix}...\n`));
  } catch (err: any) {
    console.log(chalk.yellow(`  Auto-provision failed: ${err.message}`));
    console.log(chalk.yellow("  You can enter a key manually, or press Enter to skip.\n"));
    const manual = await promptOptional("Conway API key (cnwy_k_..., optional)");
    if (manual) {
      apiKey = manual;
      // Save to config.json for loadApiKeyFromConfig()
      const configDir = getAutomatonDir();
      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
      }
      fs.writeFileSync(
        path.join(configDir, "config.json"),
        JSON.stringify({ apiKey, walletAddress: walletAddress, provisionedAt: new Date().toISOString() }, null, 2),
        { mode: 0o600 },
      );
      console.log(chalk.green("  API key saved.\n"));
    }
  }

  if (!apiKey) {
    console.log(chalk.yellow("  No API key set. The automaton will have limited functionality.\n"));
  }
  return apiKey;
}

async function promptProviderKeys(): Promise<{
  openaiApiKey: string;
  anthropicApiKey: string;
  ollamaBaseUrl: string | undefined;
}> {
  console.log(chalk.white("  Optional: bring your own inference provider keys (press Enter to skip)."));
  const openaiApiKey = await promptOptional("OpenAI API key (sk-..., optional)");
  if (openaiApiKey && !openaiApiKey.startsWith("sk-")) {
    console.log(chalk.yellow("  Warning: OpenAI keys usually start with sk-. Saving anyway."));
  }

  const anthropicApiKey = await promptOptional("Anthropic API key (sk-ant-..., optional)");
  if (anthropicApiKey && !anthropicApiKey.startsWith("sk-ant-")) {
    console.log(chalk.yellow("  Warning: Anthropic keys usually start with sk-ant-. Saving anyway."));
  }

  const ollamaInput = await promptOptional("Ollama base URL (http://localhost:11434, optional)");
  const ollamaBaseUrl = ollamaInput || undefined;
  if (ollamaBaseUrl) {
    console.log(chalk.green(`  Ollama URL saved: ${ollamaBaseUrl}`));
  }

  if (openaiApiKey || anthropicApiKey || ollamaBaseUrl) {
    const providers = [
      openaiApiKey ? "OpenAI" : null,
      anthropicApiKey ? "Anthropic" : null,
      ollamaBaseUrl ? "Ollama" : null,
    ].filter(Boolean).join(", ");
    console.log(chalk.green(`  Provider keys/URLs saved: ${providers}\n`));
  } else {
    console.log(chalk.dim("  No provider keys set. Inference will default to Conway.\n"));
  }
  return { openaiApiKey, anthropicApiKey, ollamaBaseUrl };
}

function showStandaloneFundingPanel(address: string, policy: TreasuryPolicy): void {
  const w = 58;
  const pad = (s: string, len: number) => s + " ".repeat(Math.max(0, len - s.length));
  const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;
  console.log(chalk.cyan(`  ${"╭" + "─".repeat(w) + "╮"}`));
  console.log(chalk.cyan(`  │${pad("  Fund your automaton (standalone)", w)}│`));
  console.log(chalk.cyan(`  │${" ".repeat(w)}│`));
  console.log(chalk.cyan(`  │${pad("  Send USDC on Base (chain 8453) to:", w)}│`));
  console.log(chalk.cyan(`  │${pad(`  ${address}`, w)}│`));
  console.log(chalk.cyan(`  │${" ".repeat(w)}│`));
  console.log(chalk.cyan(`  │${pad("  No ETH needed: x402 uses gasless EIP-3009 signatures.", w)}│`));
  console.log(chalk.cyan(`  │${pad(`  Caps: ${usd(policy.maxTotalDailySpendCents)}/day total, ${usd(policy.maxX402PaymentCents)}/request`, w)}│`));
  console.log(chalk.cyan(`  │${pad(`  Reserve never spent: ${usd(policy.minimumReserveCents)}`, w)}│`));
  console.log(chalk.cyan(`  ${"╰" + "─".repeat(w) + "╯"}`));
  console.log("");
}

function showFundingPanel(address: string, chainType: ChainType = "evm"): void {
  const short = `${address.slice(0, 6)}...${address.slice(-5)}`;
  const usdcNetwork = chainType === "solana" ? "Solana" : "Base";
  const w = 58;
  const pad = (s: string, len: number) => s + " ".repeat(Math.max(0, len - s.length));

  console.log(chalk.cyan(`  ${"╭" + "─".repeat(w) + "╮"}`));
  console.log(chalk.cyan(`  │${pad("  Fund your automaton", w)}│`));
  console.log(chalk.cyan(`  │${" ".repeat(w)}│`));
  console.log(chalk.cyan(`  │${pad(`  Address: ${short}`, w)}│`));
  console.log(chalk.cyan(`  │${pad(`  Chain: ${chainType === "solana" ? "Solana" : "EVM (Base)"}`, w)}│`));
  console.log(chalk.cyan(`  │${" ".repeat(w)}│`));
  console.log(chalk.cyan(`  │${pad("  1. Transfer Conway credits", w)}│`));
  console.log(chalk.cyan(`  │${pad("     conway credits transfer <address> <amount>", w)}│`));
  console.log(chalk.cyan(`  │${" ".repeat(w)}│`));
  console.log(chalk.cyan(`  │${pad(`  2. Send USDC on ${usdcNetwork} to the address above`, w)}│`));
  console.log(chalk.cyan(`  │${" ".repeat(w)}│`));
  console.log(chalk.cyan(`  │${pad("  3. Fund via Conway Cloud dashboard", w)}│`));
  console.log(chalk.cyan(`  │${pad("     https://app.conway.tech", w)}│`));
  console.log(chalk.cyan(`  │${" ".repeat(w)}│`));
  console.log(chalk.cyan(`  │${pad("  The automaton will start now. Fund it anytime —", w)}│`));
  console.log(chalk.cyan(`  │${pad("  the survival system handles zero-credit gracefully.", w)}│`));
  console.log(chalk.cyan(`  ${"╰" + "─".repeat(w) + "╯"}`));
  console.log("");
}
