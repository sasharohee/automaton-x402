/**
 * Fluence authentication
 *
 * 1. SIWE login, signed inside the runtime with the agent account:
 *    GET /v1/auth/siwe/nonce → sign → POST /v1/auth/siwe → access + refresh
 *    tokens, kept in memory only (refresh via POST /auth/refresh, re-login
 *    on 401).
 * 2. One API key (POST /v1/api_keys, minimal scopes, expiry ≤ 1 year), stored
 *    in ~/.automaton/fluence.json with mode 0600. Every other call uses it.
 *
 * Tokens and the API key are never logged and never returned to the model.
 */

import fs from "fs";
import path from "path";
import { SiweMessage } from "siwe";
import type { PrivateKeyAccount } from "viem";
import { getAutomatonDir } from "../identity/wallet.js";
import { createLogger } from "../observability/logger.js";

const logger = createLogger("fluence.auth");

export const FLUENCE_SIWE_DOMAIN = "api.fluence.dev";
export const FLUENCE_SIWE_URI = "https://api.fluence.dev";
export const FLUENCE_CREDENTIALS_FILE = "fluence.json";

/** Minimal scopes: VMs, SSH keys, public IPs, storages, balance/prices. */
export const FLUENCE_API_KEY_SCOPES = [
  "vms:read",
  "vms:write",
  "ssh_keys:read",
  "ssh_keys:write",
  "public_ips:read",
  "public_ips:write",
  "storages:read",
  "storages:write",
  "billing:read",
] as const;

/** API keys expire after 1 year at most (we ask for 180 days). */
export const FLUENCE_API_KEY_LIFETIME_MS = 180 * 86_400_000;
const MAX_API_KEY_LIFETIME_MS = 365 * 86_400_000;

export class FluenceApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "FluenceApiError";
  }
}

interface StoredCredentials {
  apiKey: string;
  apiKeyId?: string;
  expiresAt?: string;
  createdAt: string;
}

export interface FluenceAuthOptions {
  account: PrivateKeyAccount;
  apiUrl: string;
  fetchImpl?: typeof fetch;
  /** Default: ~/.automaton/fluence.json */
  credentialsPath?: string;
  now?: () => number;
}

function pickString(obj: any, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj?.[k];
    if (typeof v === "string" && v) return v;
  }
  return undefined;
}

/** Short error text from a response body, with anything token-like removed. */
async function errorText(resp: Response): Promise<string> {
  try {
    const text = (await resp.text()).slice(0, 300);
    return text.replace(/("?(?:token|access_?token|refresh_?token|key|api_?key|secret)"?\s*[:=]\s*)"[^"]*"/gi, '$1"[redacted]"');
  } catch {
    return "";
  }
}

export class FluenceAuth {
  private accessToken: string | null = null;
  private refreshToken: string | null = null;
  private cachedKey: StoredCredentials | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly credentialsPath: string;
  private readonly now: () => number;

  constructor(private readonly options: FluenceAuthOptions) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.credentialsPath = options.credentialsPath ?? path.join(getAutomatonDir(), FLUENCE_CREDENTIALS_FILE);
    this.now = options.now ?? Date.now;
  }

  private url(p: string): string {
    return `${this.options.apiUrl.replace(/\/$/, "")}${p}`;
  }

  // ─── SIWE session (memory only) ──────────────────────────────

  async login(): Promise<void> {
    const nonceResp = await this.fetchImpl(this.url("/v1/auth/siwe/nonce"), { method: "GET" });
    if (!nonceResp.ok) {
      throw new FluenceApiError(`Fluence SIWE nonce failed (${nonceResp.status})`, nonceResp.status);
    }
    const nonceBody = (await nonceResp.json().catch(() => ({}))) as any;
    const nonce = typeof nonceBody === "string" ? nonceBody : pickString(nonceBody, "nonce");
    if (!nonce) throw new FluenceApiError("Fluence SIWE nonce missing in response", nonceResp.status);

    const issuedAt = new Date(this.now());
    const message = new SiweMessage({
      domain: FLUENCE_SIWE_DOMAIN,
      address: this.options.account.address,
      statement: "Sign in to Fluence as an automaton.",
      uri: FLUENCE_SIWE_URI,
      version: "1",
      chainId: 8453,
      nonce,
      issuedAt: issuedAt.toISOString(),
      expirationTime: new Date(issuedAt.getTime() + 10 * 60_000).toISOString(),
    }).prepareMessage();
    const signature = await this.options.account.signMessage({ message });

    const resp = await this.fetchImpl(this.url("/v1/auth/siwe"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, signature }),
    });
    if (!resp.ok) {
      throw new FluenceApiError(`Fluence SIWE login failed (${resp.status}): ${await errorText(resp)}`, resp.status);
    }
    this.storeTokens(await resp.json().catch(() => ({})));
    if (!this.accessToken) throw new FluenceApiError("Fluence SIWE login returned no access token", resp.status);
    logger.info("Fluence SIWE login OK");
  }

  private storeTokens(body: any): void {
    const access = pickString(body, "accessToken", "access_token", "token");
    const refresh = pickString(body, "refreshToken", "refresh_token");
    if (access) this.accessToken = access;
    if (refresh) this.refreshToken = refresh;
  }

  private async refresh(): Promise<boolean> {
    if (!this.refreshToken) return false;
    const resp = await this.fetchImpl(this.url("/auth/refresh"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: this.refreshToken }),
    });
    if (!resp.ok) {
      this.accessToken = null;
      this.refreshToken = null;
      return false;
    }
    this.storeTokens(await resp.json().catch(() => ({})));
    return !!this.accessToken;
  }

  /** Fetch with the SIWE session token; refresh, then re-login, on 401. */
  async sessionFetch(p: string, init: RequestInit = {}): Promise<Response> {
    if (!this.accessToken) await this.login();
    const send = () =>
      this.fetchImpl(this.url(p), {
        ...init,
        headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${this.accessToken}` },
      });
    let resp = await send();
    if (resp.status === 401) {
      if (!(await this.refresh())) await this.login();
      resp = await send();
    }
    return resp;
  }

  // ─── API key (~/.automaton/fluence.json, 0600) ──────────────

  private readStoredKey(): StoredCredentials | null {
    try {
      if (!fs.existsSync(this.credentialsPath)) return null;
      const parsed = JSON.parse(fs.readFileSync(this.credentialsPath, "utf-8")) as StoredCredentials;
      if (typeof parsed.apiKey !== "string" || !parsed.apiKey) return null;
      if (parsed.expiresAt && new Date(parsed.expiresAt).getTime() - this.now() < 86_400_000) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  private writeStoredKey(creds: StoredCredentials): void {
    const dir = path.dirname(this.credentialsPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.credentialsPath, JSON.stringify(creds, null, 2), { mode: 0o600 });
    // writeFileSync keeps the mode of an existing file: enforce it.
    fs.chmodSync(this.credentialsPath, 0o600);
  }

  private forgetStoredKey(): void {
    this.cachedKey = null;
    try {
      fs.rmSync(this.credentialsPath, { force: true });
    } catch {
      // ignore
    }
  }

  /** The stored API key, creating ONE (via the SIWE session) if missing. */
  async getApiKey(): Promise<string> {
    if (this.cachedKey) return this.cachedKey.apiKey;
    const stored = this.readStoredKey();
    if (stored) {
      this.cachedKey = stored;
      return stored.apiKey;
    }
    const lifetime = Math.min(FLUENCE_API_KEY_LIFETIME_MS, MAX_API_KEY_LIFETIME_MS);
    const expiresAt = new Date(this.now() + lifetime).toISOString();
    const resp = await this.sessionFetch("/v1/api_keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "automaton", scopes: [...FLUENCE_API_KEY_SCOPES], expiresAt }),
    });
    if (!resp.ok) {
      throw new FluenceApiError(`Fluence API key creation failed (${resp.status}): ${await errorText(resp)}`, resp.status);
    }
    const body = (await resp.json().catch(() => ({}))) as any;
    const apiKey = pickString(body, "key", "apiKey", "api_key", "token", "secret");
    if (!apiKey) throw new FluenceApiError("Fluence API key missing in response", resp.status);
    const creds: StoredCredentials = {
      apiKey,
      apiKeyId: pickString(body, "id", "keyId"),
      expiresAt: pickString(body, "expiresAt", "expires_at") ?? expiresAt,
      createdAt: new Date(this.now()).toISOString(),
    };
    this.writeStoredKey(creds);
    this.cachedKey = creds;
    logger.info("Fluence API key created and stored (0600)");
    return apiKey;
  }

  /**
   * Fetch an API path with the stored API key. On 401 the key is dropped and
   * recreated once.
   */
  async apiFetch(p: string, init: RequestInit = {}): Promise<Response> {
    const send = async () =>
      this.fetchImpl(this.url(p), {
        ...init,
        headers: {
          ...(init.headers as Record<string, string>),
          Authorization: `Bearer ${await this.getApiKey()}`,
        },
      });
    let resp = await send();
    if (resp.status === 401) {
      this.forgetStoredKey();
      resp = await send();
    }
    return resp;
  }

  /** JSON helper: throws FluenceApiError on a non-2xx answer. */
  async apiJson<T = any>(p: string, init: RequestInit = {}): Promise<T> {
    const resp = await this.apiFetch(p, {
      ...init,
      headers: { ...(init.body ? { "Content-Type": "application/json" } : {}), ...(init.headers as Record<string, string>) },
    });
    if (!resp.ok) {
      throw new FluenceApiError(`Fluence ${init.method || "GET"} ${p} failed (${resp.status}): ${await errorText(resp)}`, resp.status);
    }
    if (resp.status === 204) return undefined as T;
    const text = await resp.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /** Authorization header for x402 top-ups (API key). */
  async authHeaders(): Promise<Record<string, string>> {
    return { Authorization: `Bearer ${await this.getApiKey()}` };
  }
}
