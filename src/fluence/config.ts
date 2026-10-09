/**
 * Fluence CPU Cloud configuration (standalone mode only).
 *
 * Fluence is used for ONE small VM that hosts the agent's public x402
 * service. The VM never receives the wallet key or any API key.
 */

import type { AutomatonConfig, FluenceConfig } from "../types.js";
import { createLogger } from "../observability/logger.js";

const logger = createLogger("fluence.config");

export const FLUENCE_API_URL = "https://api.fluence.dev";
export const FLUENCE_HOST = "api.fluence.dev";
export const DEFAULT_FLUENCE_SSH_USER = "ubuntu";
export const DEFAULT_FLUENCE_DISK_GB = 25;
export const MAX_FLUENCE_DISK_GB = 50;
/** Hard limit: never more than one live Fluence VM. */
export const MAX_COMPUTE_VMS = 1;
/** Fluence's minimum top-up. */
export const MIN_TOPUP_CENTS = 1000;

/** Tools that exist only when Fluence is enabled. */
export const FLUENCE_TOOLS: ReadonlySet<string> = new Set([
  "fluence_topup",
  "fluence_status",
  "sandbox_exec",
  "sandbox_upload",
]);

/** Standalone-disabled tools that Fluence re-enables (and nothing else). */
export const FLUENCE_SANDBOX_TOOLS: ReadonlySet<string> = new Set([
  "create_sandbox",
  "list_sandboxes",
  "delete_sandbox",
]);

export interface ResolvedFluenceConfig {
  apiUrl: string;
  maxComputeVms: number;
  sshUser: string;
  osImage?: string;
  diskGb: number;
}

/**
 * Validate the optional `fluence` block. Returns undefined (Fluence
 * disabled) when absent or invalid.
 */
export function parseFluenceConfig(raw: unknown): FluenceConfig | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    logger.warn("Invalid fluence config (not an object), Fluence disabled");
    return undefined;
  }
  const r = raw as Record<string, unknown>;
  if (r.enabled !== true) return undefined;

  const out: FluenceConfig = { enabled: true };
  if (r.apiUrl !== undefined) {
    try {
      const url = new URL(String(r.apiUrl));
      if (url.protocol !== "https:") throw new Error("not https");
      out.apiUrl = url.toString().replace(/\/+$/, "");
    } catch {
      logger.warn(`Invalid fluence.apiUrl: ${String(r.apiUrl)}, using ${FLUENCE_API_URL}`);
    }
  }
  if (r.maxComputeVms !== undefined) {
    const n = r.maxComputeVms;
    if (typeof n === "number" && Number.isInteger(n) && n >= 0) {
      out.maxComputeVms = Math.min(n, MAX_COMPUTE_VMS);
    } else {
      logger.warn(`Invalid fluence.maxComputeVms: ${String(n)}, using ${MAX_COMPUTE_VMS}`);
    }
  }
  if (typeof r.sshUser === "string" && /^[a-z_][a-z0-9_-]{0,31}$/.test(r.sshUser)) {
    out.sshUser = r.sshUser;
  }
  if (typeof r.osImage === "string" && r.osImage.trim()) {
    out.osImage = r.osImage.trim();
  }
  if (r.diskGb !== undefined) {
    const n = r.diskGb;
    if (typeof n === "number" && Number.isInteger(n) && n >= 10 && n <= MAX_FLUENCE_DISK_GB) {
      out.diskGb = n;
    } else {
      logger.warn(`Invalid fluence.diskGb: ${String(n)}, using ${DEFAULT_FLUENCE_DISK_GB}`);
    }
  }
  return out;
}

export function isFluenceEnabled(
  config: Pick<AutomatonConfig, "providerMode" | "fluence"> | undefined | null,
): boolean {
  return config?.providerMode === "standalone" && config.fluence?.enabled === true;
}

export function resolveFluenceConfig(config: Pick<AutomatonConfig, "fluence">): ResolvedFluenceConfig {
  const f = config.fluence;
  return {
    apiUrl: f?.apiUrl || FLUENCE_API_URL,
    maxComputeVms: Math.min(f?.maxComputeVms ?? MAX_COMPUTE_VMS, MAX_COMPUTE_VMS),
    sshUser: f?.sshUser || DEFAULT_FLUENCE_SSH_USER,
    osImage: f?.osImage,
    diskGb: Math.min(f?.diskGb ?? DEFAULT_FLUENCE_DISK_GB, MAX_FLUENCE_DISK_GB),
  };
}
