/**
 * Fluence authentication
 *
 * 1. SIWE login, signed inside the runtime with the agent account:
 *    GET /v1/auth/siwe/nonce → sign → POST /v1/auth/siwe → access + refresh
 *    tokens, kept in memory only (refresh via POST /auth/refresh, re-login
 *    on 401).
 * 2. One API key (POST /v1/api_keys, minimal scopes, expiry ≤ 1 year), stored
 *    in ~/.automaton/fluence.json with mode 0600. Every other call sends it
 *    as `X-API-KEY` (Bearer is only used for the SIWE session token). A key
 *    rejected with 401/403 is deleted server-side and recreated at most once
 *    per process.
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

/** Minimal scopes (exact Fluence names): VMs, disks, public IPs, SSH keys, clusters, prices. */
export const FLUENCE_API_KEY_SCOPES = [
  "vms:read",
  "vms:write",
  "storage:read",
  "storage:write",
  "public_ip:read",
  "public_ip:write",
  "ssh_key:create",
  "ssh_key:list",
  "ssh_key:remove",
  "clusters:read",
  "prices:read",
] as const;

/** Name of the API key (lowercase letters, digits, hyphens, ≤ 25 chars). */
export const FLUENCE_API_KEY_NAME = "automaton";
export const API_KEY_HEADER = "X-API-KEY";

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

export interface ApiFetchOptions {
  /** On 403 with the API key, retry once with the SIWE session token (no key re-creation). */
  sessionFallbackOn403?: boolean;
}

export interface FluenceAuthOptions {
  account: PrivateKeyAccount;
  apiUrl: string;
  fetchImpl?: typeof fetch;
  /** Default: ~/.automaton/fluence.json */
  credentialsPath?: string;
  now?: () => number;
}

function pickString(obj: any, key: string): string | undefined {
  const v = obj?.[key];
  return typeof v === "string" && v ? v : undefined;
}

/** Short error text from a response body, with anything token-like removed. */
async function errorText(resp: Response): Promise<string> {
  try {
    const text = (await resp.text()).slice(0, 300);
    return text.replace(
      /("?(?:token|access_?token|refresh_?token|key|api_?key|secret|value)"?\s*[:=]\s*)"[^"]*"/gi,
      '$1"[redacted]"',
    );
  } catch {
    return "";
  }
}

export class FluenceAuth {
  private accessToken: string | null = null;
  private refreshToken: string | null = null;
  private cachedKey: StoredCredentials | null = null;
  /** A rejected key is recreated at most once per process start. */
  private keyRecreated = false;
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
    // { nonce, expiresAt }
    const nonce = pickString(await nonceResp.json().catch(() => ({})), "nonce");
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
    // { accessToken, refreshToken, userData }
    const body = (await resp.json().catch(() => ({}))) as any;
    this.accessToken = pickString(body, "accessToken") ?? null;
    this.refreshToken = pickString(body, "refreshToken") ?? null;
    if (!this.accessToken) throw new FluenceApiError("Fluence SIWE login returned no access token", resp.status);
    logger.info("Fluence SIWE login OK");
  }

  private async refresh(): Promise<boolean> {
    if (!this.refreshToken) return false;
    const resp = await this.fetchImpl(this.url("/auth/refresh"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: this.refreshToken }),
    });
    // { access_token }
    const access = resp.ok ? pickString(await resp.json().catch(() => ({})), "access_token") : undefined;
    if (!access) {
      this.accessToken = null;
      this.refreshToken = null;
      return false;
    }
    this.accessToken = access;
    return true;
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

  private postApiKey(scopes: readonly string[], expiresAt: string): Promise<Response> {
    return this.sessionFetch("/v1/api_keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: FLUENCE_API_KEY_NAME, scopes: [...scopes], expiresAt }),
    });
  }

  /** Our scopes that this account may grant (GET /v1/users/me → permissions), or null. */
  private async grantableScopes(): Promise<string[] | null> {
    const resp = await this.sessionFetch("/v1/users/me", { method: "GET" });
    if (!resp.ok) return null;
    const body = (await resp.json().catch(() => ({}))) as any;
    if (!Array.isArray(body?.permissions)) return null;
    const granted = new Set(body.permissions.filter((p: unknown): p is string => typeof p === "string"));
    return FLUENCE_API_KEY_SCOPES.filter((s) => granted.has(s));
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
    let resp = await this.postApiKey(FLUENCE_API_KEY_SCOPES, expiresAt);
    if (resp.status === 400 || resp.status === 403 || resp.status === 422) {
      // A scope was rejected: retry once with only the scopes this account has.
      const scopes = await this.grantableScopes();
      if (scopes && scopes.length > 0 && scopes.length < FLUENCE_API_KEY_SCOPES.length) {
        logger.warn(`Fluence API key: retrying with the ${scopes.length} scope(s) granted to this account`);
        resp = await this.postApiKey(scopes, expiresAt);
      }
    }
    if (!resp.ok) {
      throw new FluenceApiError(`Fluence API key creation failed (${resp.status}): ${await errorText(resp)}`, resp.status);
    }
    // The key is in `value` (shown once), its id in `id`.
    const body = (await resp.json().catch(() => ({}))) as any;
    const apiKey = pickString(body, "value");
    if (!apiKey) throw new FluenceApiError("Fluence API key missing in response", resp.status);
    const creds: StoredCredentials = {
      apiKey,
      apiKeyId: pickString(body, "id"),
      expiresAt: pickString(body, "expiresAt") ?? expiresAt,
      createdAt: new Date(this.now()).toISOString(),
    };
    this.writeStoredKey(creds);
    this.cachedKey = creds;
    logger.info("Fluence API key created and stored (0600)");
    return apiKey;
  }

  /** Delete a rejected key server-side when its id is known, then locally. */
  private async revokeStoredKey(): Promise<void> {
    const id = (this.cachedKey ?? this.readStoredKey())?.apiKeyId;
    if (id) {
      try {
        const resp = await this.sessionFetch(`/v1/api_keys/${encodeURIComponent(id)}`, { method: "DELETE" });
        if (!resp.ok && resp.status !== 404) logger.warn(`Fluence API key deletion failed (${resp.status})`);
      } catch (err) {
        logger.warn(`Fluence API key deletion failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    this.forgetStoredKey();
  }

  /**
   * Fetch an API path with the stored API key (`X-API-KEY`). On 401/403 the
   * key is deleted server-side and recreated, at most once per process.
   */
  async apiFetch(p: string, init: RequestInit = {}, options: ApiFetchOptions = {}): Promise<Response> {
    const send = async () =>
      this.fetchImpl(this.url(p), {
        ...init,
        headers: {
          ...(init.headers as Record<string, string>),
          [API_KEY_HEADER]: await this.getApiKey(),
        },
      });
    let resp = await send();
    if (resp.status === 403 && options.sessionFallbackOn403) {
      return this.sessionFetch(p, init);
    }
    if ((resp.status === 401 || resp.status === 403) && !this.keyRecreated) {
      this.keyRecreated = true;
      logger.warn(`Fluence API key rejected (${resp.status}); recreating it once`);
      await this.revokeStoredKey();
      resp = await send();
    }
    return resp;
  }

  /** JSON helper: throws FluenceApiError on a non-2xx answer. */
  async apiJson<T = any>(p: string, init: RequestInit = {}, options: ApiFetchOptions = {}): Promise<T> {
    const resp = await this.apiFetch(
      p,
      {
        ...init,
        headers: { ...(init.body ? { "Content-Type": "application/json" } : {}), ...(init.headers as Record<string, string>) },
      },
      options,
    );
    if (!resp.ok) {
      throw new FluenceApiError(`Fluence ${init.method || "GET"} ${p} failed (${resp.status}): ${await errorText(resp)}`, resp.status);
    }
    if (resp.status === 204) return undefined as T;
    const text = await resp.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /**
   * Headers for x402 top-ups: the API key as `X-API-KEY` when one can be
   * obtained, otherwise none (Fluence then credits the paying wallet's account).
   */
  async authHeaders(): Promise<Record<string, string>> {
    try {
      return { [API_KEY_HEADER]: await this.getApiKey() };
    } catch (err) {
      logger.warn(`Fluence top-up without API key: ${err instanceof Error ? err.message : String(err)}`);
      return {};
    }
  }
}
