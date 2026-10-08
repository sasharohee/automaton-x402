/**
 * Standalone Provider (no Conway)
 *
 * A `ConwayClient` implementation that does not depend on Conway Cloud:
 *   - exec / files run on the host machine
 *   - the "credits" balance is the agent's on-chain USDC balance on Base,
 *     minus the treasury reserve, so the existing survival-tier logic
 *     (loop, heartbeat, monitor) keeps working unchanged
 *   - model discovery uses BlockRun's free `GET /v1/models`
 *   - sandbox, port, domain, credit-transfer and registration operations are
 *     unavailable and throw `ProviderUnsupportedError` (the matching tools are
 *     not offered to the model in this mode)
 *
 * Phase 2 will add Fluence VMs (see docs/phase-2-fluence.md).
 */

import type {
  ConwayClient,
  ExecResult,
  PortInfo,
  SandboxInfo,
  PricingTier,
  CreditTransferResult,
  DomainSearchResult,
  DomainRegistration,
  DnsRecord,
  ModelInfo,
} from "../types.js";
import { execLocal, scrubSecretEnv, writeFileLocal, readFileLocal } from "./local-exec.js";
import { getUsdcBalanceDetailed } from "./x402.js";

export class ProviderUnsupportedError extends Error {
  constructor(operation: string) {
    super(
      `${operation} is not available in standalone mode (no Conway). ` +
        `Sandboxes/VMs will be provided by Fluence in phase 2.`,
    );
    this.name = "ProviderUnsupportedError";
  }
}

export interface StandaloneClientOptions {
  walletAddress: string;
  /** Cents kept untouched in the wallet; subtracted from the reported balance. */
  reserveCents: number;
  /** BlockRun base URL (for model discovery). */
  blockrunApiUrl?: string;
  /** Override for tests: returns the raw USDC balance in dollars. */
  readUsdcBalance?: (address: string) => Promise<number>;
  /** Override for tests. */
  fetchImpl?: typeof fetch;
}

/**
 * Spendable balance in cents = on-chain USDC (in cents, floored) − reserve,
 * never negative. Zero maps to the "critical" survival tier.
 */
export function spendableCents(usdcBalance: number, reserveCents: number): number {
  const balanceCents = Math.floor(usdcBalance * 100);
  return Math.max(0, balanceCents - Math.max(0, reserveCents));
}

async function defaultReadUsdcBalance(address: string): Promise<number> {
  const result = await getUsdcBalanceDetailed(address as `0x${string}`, "eip155:8453");
  if (!result.ok) {
    // Throw so callers fall back to their cached balance instead of
    // believing the wallet is empty.
    throw new Error(`USDC balance read failed: ${result.error}`);
  }
  return result.balance;
}

export function createStandaloneClient(options: StandaloneClientOptions): ConwayClient {
  const readBalance = options.readUsdcBalance ?? defaultReadUsdcBalance;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const unsupported = (op: string) => async (): Promise<never> => {
    throw new ProviderUnsupportedError(op);
  };

  const client: ConwayClient = {
    // Commands never inherit secret-looking env vars (API keys set by the loop).
    exec: async (command: string, timeout?: number): Promise<ExecResult> =>
      execLocal(command, timeout, { env: scrubSecretEnv() }),
    writeFile: async (path: string, content: string) => writeFileLocal(path, content),
    readFile: async (path: string) => readFileLocal(path),

    exposePort: unsupported("expose_port") as (port: number) => Promise<PortInfo>,
    removePort: unsupported("remove_port") as (port: number) => Promise<void>,
    createSandbox: unsupported("create_sandbox") as () => Promise<SandboxInfo>,
    deleteSandbox: unsupported("delete_sandbox") as (id: string) => Promise<void>,
    listSandboxes: async () => [],

    getCreditsBalance: async () => {
      const usdc = await readBalance(options.walletAddress);
      return spendableCents(usdc, options.reserveCents);
    },
    getCreditsPricing: async (): Promise<PricingTier[]> => [],
    transferCredits: unsupported("transfer_credits") as (
      to: string,
      amount: number,
    ) => Promise<CreditTransferResult>,
    registerAutomaton: unsupported("Conway automaton registration") as ConwayClient["registerAutomaton"],

    searchDomains: unsupported("search_domains") as (q: string) => Promise<DomainSearchResult[]>,
    registerDomain: unsupported("register_domain") as (d: string) => Promise<DomainRegistration>,
    listDnsRecords: unsupported("manage_dns") as (d: string) => Promise<DnsRecord[]>,
    addDnsRecord: unsupported("manage_dns") as ConwayClient["addDnsRecord"],
    deleteDnsRecord: unsupported("manage_dns") as ConwayClient["deleteDnsRecord"],

    listModels: async (): Promise<ModelInfo[]> => {
      if (!options.blockrunApiUrl) return [];
      try {
        // Model listing is free (no x402 challenge); never pay here.
        const resp = await fetchImpl(`${options.blockrunApiUrl.replace(/\/$/, "")}/v1/models`);
        if (!resp.ok) return [];
        const result = (await resp.json()) as any;
        const raw = result.data || result.models || [];
        return raw.map((m: any) => ({
          id: m.id,
          provider: "blockrun",
          pricing: {
            inputPerMillion: Number(m.pricing?.input ?? m.pricing?.input_per_million ?? 0),
            outputPerMillion: Number(m.pricing?.output ?? m.pricing?.output_per_million ?? 0),
          },
        }));
      } catch {
        return [];
      }
    },

    createScopedClient: () => {
      throw new ProviderUnsupportedError("Scoped sandbox clients");
    },
  };

  return client;
}
