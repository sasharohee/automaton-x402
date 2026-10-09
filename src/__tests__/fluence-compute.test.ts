/**
 * Fluence CPU Cloud provider (standalone): SIWE auth + API key, compute spend
 * caps, x402 top-up, VM client guards, SSH / upload guards, balance awareness.
 *
 * Everything is mocked: the signing key is a throwaway constant that has
 * never been funded, Fluence HTTP answers and SSH come from stubs, and no
 * request leaves the process.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { BASE_USDC_ADDRESS, PAYMENT_SIGNATURE_HEADER } from "../conway/x402-v2.js";
import { SpendTracker } from "../agent/spend-tracker.js";
import { SpendGuard } from "../survival/spend-guard.js";
import { FluenceAuth, FLUENCE_SIWE_DOMAIN } from "../fluence/auth.js";
import { FluenceBilling } from "../fluence/billing.js";
import {
  FluenceVmClient,
  FluenceGuardError,
  mapVm,
  parseBalance,
  parseQuoteCents,
  pickUbuntuImage,
  sanitizeFluenceName,
  sharedCandidates,
  sshFingerprint,
  vmHourlyPrice,
} from "../fluence/client.js";
import { FluenceSsh, isValidHost, type SshTransport } from "../fluence/ssh.js";
import { planUpload, isSafeRemotePath, looksLikePrivateKey } from "../fluence/upload-guard.js";
import {
  FLUENCE_TOOLS,
  isFluenceEnabled,
  parseFluenceConfig,
  resolveFluenceConfig,
} from "../fluence/config.js";
import { checkComputeBalance, computeRunwayHours, fluenceStatusLine, FLUENCE_STATUS_KV } from "../fluence/status.js";
import { filterToolsForProvider, STANDALONE_FORBIDDEN_TOOLS } from "../conway/provider.js";
import { createBuiltinTools } from "../agent/tools.js";
import { createSecretAccessRules } from "../agent/policy-rules/secret-access.js";
import { createDefaultRules } from "../agent/policy-rules/index.js";
import { SENSITIVE_STATE_FILES, buildStateGitignore } from "../git/state-versioning.js";
import { isProtectedFile } from "../self-mod/code.js";
import { STANDALONE_TREASURY_POLICY } from "../types.js";
import type { AutomatonDatabase, PolicyRequest, TreasuryPolicy } from "../types.js";
import { createTestConfig, createTestDb } from "./mocks.js";

const TEST_ACCOUNT = privateKeyToAccount(`0x${"cd".repeat(32)}`);
const FLUENCE = "https://api.fluence.dev";
const PAY_TO = "0x2222222222222222222222222222222222222222";

/** Owner's intended production config: 20¢ per request, $10 / $10 compute. */
const POLICY: TreasuryPolicy = {
  ...STANDALONE_TREASURY_POLICY,
  maxX402PaymentCents: 20,
  maxInferenceDailyCents: 500,
  maxTotalDailySpendCents: 500,
  minimumReserveCents: 100,
  x402AllowedDomains: ["blockrun.ai", "api.fluence.dev"],
  maxComputeTopupCents: 1000,
  maxComputeMonthlyCents: 1000,
};

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64");

function challenge(amountAtomic: string, network = "eip155:8453"): Response {
  return new Response("{}", {
    status: 402,
    headers: {
      "PAYMENT-REQUIRED": b64({
        x402Version: 2,
        resource: { url: `${FLUENCE}/v2/x402/top-up` },
        accepts: [
          {
            scheme: "exact",
            network,
            amount: amountAtomic,
            asset: BASE_USDC_ADDRESS,
            payTo: PAY_TO,
            maxTimeoutSeconds: 300,
            extra: { name: "USD Coin", version: "2" },
          },
        ],
      }),
    },
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** Account whose signing calls are observable (to prove "refused before signing"). */
function spyAccount() {
  const signTypedData = vi.fn((args: any) => TEST_ACCOUNT.signTypedData(args));
  return { account: { ...TEST_ACCOUNT, signTypedData } as any, signTypedData };
}

function topupFetch(handler: (req: { url: string; init?: RequestInit; paid: boolean }) => Response) {
  const calls: { url: string; paid: boolean; apiKey?: string; authorization?: string }[] = [];
  const fetchImpl = vi.fn(async (url: any, init?: RequestInit) => {
    const headers = new Headers(init?.headers as HeadersInit);
    const paid = headers.has(PAYMENT_SIGNATURE_HEADER);
    calls.push({
      url: String(url),
      paid,
      apiKey: headers.get("X-API-KEY") ?? undefined,
      authorization: headers.get("Authorization") ?? undefined,
    });
    return handler({ url: String(url), init, paid });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

function billing(db: AutomatonDatabase, opts: { policy?: TreasuryPolicy; balanceCents?: number; fetchImpl: typeof fetch; account?: any }) {
  return new FluenceBilling({
    account: opts.account ?? TEST_ACCOUNT,
    apiUrl: FLUENCE,
    policy: opts.policy ?? POLICY,
    spendTracker: new SpendTracker(db.raw),
    getBalanceCents: async () => opts.balanceCents ?? 5000,
    authHeaders: async () => ({ "X-API-KEY": "test-key" }),
    fetchImpl: opts.fetchImpl,
  });
}

function computeRows(db: AutomatonDatabase): { amount_cents: number; domain: string }[] {
  return db.raw.prepare("SELECT amount_cents, domain FROM spend_tracking WHERE category = 'compute'").all() as any;
}

// ─── Config ─────────────────────────────────────────────────────

describe("fluence config", () => {
  it("is disabled unless explicitly enabled, and only in standalone mode", () => {
    expect(parseFluenceConfig(undefined)).toBeUndefined();
    expect(parseFluenceConfig({ enabled: false })).toBeUndefined();
    expect(parseFluenceConfig("yes")).toBeUndefined();
    expect(parseFluenceConfig({ enabled: true })).toEqual({ enabled: true });
    expect(isFluenceEnabled({ providerMode: "standalone", fluence: { enabled: true } })).toBe(true);
    expect(isFluenceEnabled({ providerMode: "conway", fluence: { enabled: true } })).toBe(false);
    expect(isFluenceEnabled({ providerMode: "standalone" })).toBe(false);
  });

  it("never allows more than one VM and keeps the disk ≤ 50 GB", () => {
    expect(parseFluenceConfig({ enabled: true, maxComputeVms: 5 })?.maxComputeVms).toBe(1);
    expect(resolveFluenceConfig({ fluence: { enabled: true, maxComputeVms: 3 } }).maxComputeVms).toBe(1);
    expect(resolveFluenceConfig({ fluence: { enabled: true } }).maxComputeVms).toBe(1);
    expect(parseFluenceConfig({ enabled: true, diskGb: 200 })?.diskGb).toBeUndefined();
    expect(resolveFluenceConfig({ fluence: { enabled: true } }).diskGb).toBe(25);
    expect(parseFluenceConfig({ enabled: true, apiUrl: "http://evil.example" })?.apiUrl).toBeUndefined();
  });

  it("leaves the existing defaults unchanged (compute disabled, allowlist = blockrun.ai)", () => {
    expect(STANDALONE_TREASURY_POLICY.maxComputeTopupCents).toBeUndefined();
    expect(STANDALONE_TREASURY_POLICY.maxComputeMonthlyCents).toBeUndefined();
    expect(STANDALONE_TREASURY_POLICY.x402AllowedDomains).toEqual(["blockrun.ai"]);
    expect(STANDALONE_TREASURY_POLICY.maxX402PaymentCents).toBe(10);
    expect(STANDALONE_TREASURY_POLICY.minimumReserveCents).toBe(100);
  });
});

// ─── Ledger: compute category ───────────────────────────────────

describe("compute spend ledger", () => {
  let db: AutomatonDatabase;
  beforeEach(() => {
    db = createTestDb();
  });
  afterEach(() => db.close());

  it("accepts the compute category (migration v12) and keeps it out of the daily caps", () => {
    const tracker = new SpendTracker(db.raw);
    tracker.recordSpend({ toolName: "fluence_topup", amountCents: 1000, domain: "api.fluence.dev", category: "compute" });
    expect(tracker.getMonthlySpend("compute")).toBe(1000);
    expect(tracker.getTotalDailySpend()).toBe(0);
    // A $0.05 inference call still fits the $5 global daily cap.
    expect(tracker.checkLimit(5, "inference", POLICY).allowed).toBe(true);
  });

  it("refuses compute when the caps are absent, above the top-up cap, or above the monthly cap", () => {
    const tracker = new SpendTracker(db.raw);
    expect(tracker.checkLimit(1000, "compute", STANDALONE_TREASURY_POLICY).allowed).toBe(false);
    expect(tracker.checkLimit(1001, "compute", POLICY).allowed).toBe(false);
    tracker.recordSpend({ toolName: "fluence_topup", amountCents: 500, category: "compute" });
    const monthly = tracker.checkLimit(1000, "compute", POLICY);
    expect(monthly.allowed).toBe(false);
    expect(monthly.reason).toMatch(/Monthly compute cap/);
    expect(monthly.limitType).toBeUndefined();
    expect(tracker.checkLimit(500, "compute", POLICY).allowed).toBe(true);
  });

  it("never prunes compute rows younger than 35 days", () => {
    const insert = db.raw.prepare(
      `INSERT INTO spend_tracking (id, tool_name, amount_cents, category, window_hour, window_day, created_at)
       VALUES (?, 't', 1, ?, 'x', 'x', datetime('now', ?))`,
    );
    insert.run("inf-20d", "inference", "-20 days");
    insert.run("cmp-20d", "compute", "-20 days");
    insert.run("cmp-40d", "compute", "-40 days");
    new SpendTracker(db.raw).pruneOldRecords(7);
    const ids = (db.raw.prepare("SELECT id FROM spend_tracking").all() as { id: string }[]).map((r) => r.id);
    expect(ids).toEqual(["cmp-20d"]);
  });
});

// ─── SpendGuard: compute vs. other payments ────────────────────

describe("compute spend guard", () => {
  let db: AutomatonDatabase;
  beforeEach(() => {
    db = createTestDb();
  });
  afterEach(() => db.close());

  const guard = (category: "compute" | "inference", policy: TreasuryPolicy, balanceCents = 5000) =>
    new SpendGuard({ policy, category, spendTracker: new SpendTracker(db.raw), getBalanceCents: async () => balanceCents });

  it("uses maxComputeTopupCents only for compute payments to api.fluence.dev", async () => {
    const g = guard("compute", POLICY);
    expect(await g.authorize({ host: "api.fluence.dev", amountCents: 1000, payTo: PAY_TO })).toBeNull();
    expect(await g.authorize({ host: "blockrun.ai", amountCents: 5, payTo: PAY_TO })).toMatch(/only allowed to api\.fluence\.dev/);
  });

  it("still refuses a non-compute payment above 20¢", async () => {
    const reason = await guard("inference", POLICY).authorize({ host: "blockrun.ai", amountCents: 21, payTo: PAY_TO });
    expect(reason).toMatch(/exceeds per-request max of 20¢/);
    // And the Fluence host gets no special treatment outside the compute guard.
    expect(await guard("inference", POLICY).authorize({ host: "api.fluence.dev", amountCents: 1000, payTo: PAY_TO })).toMatch(/per-request max/);
  });

  it("refuses compute when it would cross the reserve", async () => {
    const reason = await guard("compute", POLICY, 1050).authorize({ host: "api.fluence.dev", amountCents: 1000, payTo: PAY_TO });
    expect(reason).toMatch(/reserve/);
    expect(computeRows(db)).toHaveLength(0);
  });

  it("refuses compute when the caps are absent", async () => {
    const reason = await guard("compute", { ...POLICY, maxComputeTopupCents: undefined }).authorize({
      host: "api.fluence.dev",
      amountCents: 1000,
      payTo: PAY_TO,
    });
    expect(reason).toMatch(/disabled/);
  });
});

// ─── Top-up over x402 ──────────────────────────────────────────

describe("fluence top-up (x402 v2)", () => {
  let db: AutomatonDatabase;
  beforeEach(() => {
    db = createTestDb();
  });
  afterEach(() => db.close());

  it("pays exactly the requested amount and records it as compute spend", async () => {
    const { fetchImpl, calls } = topupFetch(({ paid }) =>
      paid
        ? new Response("{}", { status: 200, headers: { "PAYMENT-RESPONSE": b64({ success: true, transaction: "0xabc" }) } })
        : challenge("10000000"),
    );
    const result = await billing(db, { fetchImpl }).topUp(1000);
    expect(result.ok).toBe(true);
    expect(calls[0].url).toBe(`${FLUENCE}/v2/x402/top-up?amountUsd=10.00`);
    expect(calls.map((c) => c.paid)).toEqual([false, true]);
    // The API key goes in X-API-KEY, never as a Bearer token.
    expect(calls.every((c) => c.apiKey === "test-key" && c.authorization === undefined)).toBe(true);
    expect(computeRows(db)).toEqual([{ amount_cents: 1000, domain: "api.fluence.dev" }]);
  });

  it.each([
    ["above maxComputeTopupCents", { ...POLICY, maxComputeTopupCents: 500 }, 5000, 1000],
    ["above the monthly cap", { ...POLICY, maxComputeMonthlyCents: 900 }, 5000, 1000],
    ["below Fluence's $10 minimum", POLICY, 5000, 999],
    ["with compute caps absent", { ...POLICY, maxComputeTopupCents: undefined, maxComputeMonthlyCents: undefined }, 5000, 1000],
    ["when api.fluence.dev is not allowlisted", { ...POLICY, x402AllowedDomains: ["blockrun.ai"] }, 5000, 1000],
  ])("is refused %s before any request or signature", async (_label, policy, balanceCents, amount) => {
    const { account, signTypedData } = spyAccount();
    const { fetchImpl, calls } = topupFetch(() => challenge(String(amount * 10_000)));
    const result = await billing(db, { policy, balanceCents, fetchImpl, account }).topUp(amount);
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
    expect(signTypedData).not.toHaveBeenCalled();
    expect(computeRows(db)).toHaveLength(0);
  });

  it("is refused before signing when it would cross the reserve", async () => {
    const { account, signTypedData } = spyAccount();
    const { fetchImpl, calls } = topupFetch(() => challenge("10000000"));
    const result = await billing(db, { balanceCents: 1050, fetchImpl, account }).topUp(1000);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/reserve/);
    expect(calls.filter((c) => c.paid)).toHaveLength(0);
    expect(signTypedData).not.toHaveBeenCalled();
    expect(computeRows(db)).toHaveLength(0);
  });

  it("refuses a challenge whose amount differs from the request, before signing", async () => {
    const { account, signTypedData } = spyAccount();
    const { fetchImpl, calls } = topupFetch(() => challenge("9000000")); // $9 instead of $10
    const result = await billing(db, { fetchImpl, account }).topUp(1000);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/does not match the requested/);
    expect(calls.filter((c) => c.paid)).toHaveLength(0);
    expect(signTypedData).not.toHaveBeenCalled();
  });

  it("refuses a challenge on another network", async () => {
    const { account, signTypedData } = spyAccount();
    const { fetchImpl } = topupFetch(() => challenge("10000000", "eip155:1"));
    const result = await billing(db, { fetchImpl, account }).topUp(1000);
    expect(result.ok).toBe(false);
    expect(signTypedData).not.toHaveBeenCalled();
  });

  it("does not re-sign on 409, and a 503 retry reuses the same authorization", async () => {
    const { account, signTypedData } = spyAccount();
    const conflict = topupFetch(({ paid }) => (paid ? new Response("{}", { status: 409 }) : challenge("10000000")));
    const r409 = await billing(db, { fetchImpl: conflict.fetchImpl, account }).topUp(1000);
    expect(r409.ok).toBe(false);
    expect(r409.status).toBe(409);
    expect(conflict.calls.filter((c) => c.paid)).toHaveLength(1);
    expect(signTypedData).toHaveBeenCalledTimes(1);

    const db2 = createTestDb();
    const signatures: string[] = [];
    const unavailable = topupFetch(({ paid, init }) => {
      if (!paid) return challenge("10000000");
      signatures.push((init!.headers as Record<string, string>)[PAYMENT_SIGNATURE_HEADER]);
      return new Response("{}", { status: 503 });
    });
    const b = billing(db2, { fetchImpl: unavailable.fetchImpl, account });
    expect((await b.topUp(1000)).status).toBe(503);
    expect((await b.topUp(1000)).status).toBe(503);
    expect(signatures).toHaveLength(2);
    expect(signatures[0]).toBe(signatures[1]);
    expect(signTypedData).toHaveBeenCalledTimes(2); // 1 for the 409 case + 1 here
    expect(computeRows(db2)).toHaveLength(1);
    db2.close();
  });
});

// ─── SIWE auth + API key ───────────────────────────────────────

describe("fluence auth", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fluence-auth-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  type Seen = { url: string; method: string; body?: any; bearer?: string; apiKey?: string };

  /**
   * Mock Fluence with the documented shapes. `routes` may override any
   * "METHOD /path" answer; `n` is the call count for that route.
   */
  function fluenceServer(routes: Record<string, (req: Seen, n: number) => Response> = {}) {
    const seen: Seen[] = [];
    const counts: Record<string, number> = {};
    let keys = 0;
    const fetchImpl = vi.fn(async (url: any, init?: RequestInit) => {
      const u = String(url).replace(FLUENCE, "");
      const headers = new Headers(init?.headers as HeadersInit);
      const method = init?.method || "GET";
      const req: Seen = {
        url: u,
        method,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        bearer: headers.get("Authorization")?.replace(/^Bearer /, ""),
        apiKey: headers.get("X-API-KEY") ?? undefined,
      };
      seen.push(req);
      const route = `${method} ${u}`;
      counts[route] = (counts[route] ?? 0) + 1;
      if (routes[route]) return routes[route](req, counts[route]);
      if (route === "GET /v1/auth/siwe/nonce") return json({ nonce: "abcdef12345678", expiresAt: "2030-01-01T00:00:00Z" });
      if (route === "POST /v1/auth/siwe")
        return json({ accessToken: "ACCESS-SECRET-1", refreshToken: "REFRESH-SECRET-1", userData: { id: "u1" } });
      if (route === "POST /v1/api_keys") {
        keys++;
        return json({ id: `k${keys}`, name: "automaton", value: `FLUENCE-API-KEY-SECRET-${keys}` }, 201);
      }
      if (route === "GET /v2/users/balances")
        return json([
          {
            balance: "12.34",
            usage: "0",
            estimatedUsage: "0",
            overage: "0",
            totalDepositedAmount: "20",
            usageDaysLeft: null,
            userId: "u1",
            featureKey: "vm",
          },
        ]);
      return json({}, 404);
    });
    return { fetchImpl: fetchImpl as unknown as typeof fetch, seen, keyCount: () => keys };
  }

  const newAuth = (fetchImpl: typeof fetch, credentialsPath = path.join(dir, ".automaton", "fluence.json")) =>
    new FluenceAuth({ account: TEST_ACCOUNT, apiUrl: FLUENCE, fetchImpl, credentialsPath });

  it("logs in with SIWE (api.fluence.dev, chain 8453) and stores ONE API key (`value`) with mode 0600", async () => {
    const server = fluenceServer();
    const credentialsPath = path.join(dir, ".automaton", "fluence.json");
    const out: string[] = [];
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: any) => {
      out.push(String(chunk));
      return true;
    });
    try {
      const body = await newAuth(server.fetchImpl, credentialsPath).apiJson("/v2/users/balances");
      expect(body[0].balance).toBe("12.34");
      // A second instance (restart) reuses the stored key: no new SIWE login, no new key.
      await newAuth(server.fetchImpl, credentialsPath).apiJson("/v2/users/balances");
    } finally {
      writeSpy.mockRestore();
    }

    const login = server.seen.find((s) => s.url === "/v1/auth/siwe")!;
    expect(login.body.message).toContain(`${FLUENCE_SIWE_DOMAIN} wants you to sign in`);
    expect(login.body.message).toContain("URI: https://api.fluence.dev");
    expect(login.body.message).toContain("Chain ID: 8453");
    expect(login.body.message).toContain("Nonce: abcdef12345678");
    expect(login.body.message).toContain(TEST_ACCOUNT.address);
    expect(server.keyCount()).toBe(1);
    const keyReq = server.seen.find((s) => s.url === "/v1/api_keys")!;
    expect(keyReq.bearer).toBe("ACCESS-SECRET-1");
    expect(keyReq.body.name).toMatch(/^[a-z0-9-]{1,25}$/);
    expect(keyReq.body.scopes).toEqual([
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
    ]);
    expect(new Date(keyReq.body.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(365 * 86_400_000);
    // API calls carry the key in X-API-KEY, never as a Bearer token.
    const balanceCalls = server.seen.filter((s) => s.url === "/v2/users/balances");
    expect(balanceCalls).toHaveLength(2);
    expect(balanceCalls.every((s) => s.apiKey === "FLUENCE-API-KEY-SECRET-1" && s.bearer === undefined)).toBe(true);

    const stat = fs.statSync(credentialsPath);
    expect(stat.mode & 0o777).toBe(0o600);
    const stored = JSON.parse(fs.readFileSync(credentialsPath, "utf-8"));
    expect(stored.apiKey).toBe("FLUENCE-API-KEY-SECRET-1");
    expect(stored.apiKeyId).toBe("k1");
    // Session tokens are memory-only.
    expect(JSON.stringify(stored)).not.toContain("ACCESS-SECRET-1");
    expect(JSON.stringify(stored)).not.toContain("REFRESH-SECRET-1");
    // Nothing secret reaches the logs.
    const logs = out.join("");
    for (const secret of ["ACCESS-SECRET-1", "REFRESH-SECRET-1", "FLUENCE-API-KEY-SECRET"]) {
      expect(logs).not.toContain(secret);
    }
  });

  it("refuses an API key response without `value`", async () => {
    const server = fluenceServer({ "POST /v1/api_keys": () => json({ id: "k1", key: "WRONG-FIELD" }) });
    await expect(newAuth(server.fetchImpl).apiJson("/v2/vms")).rejects.toThrow(/API key missing/);
  });

  it("retries key creation once with the scopes listed in /v1/users/me → permissions", async () => {
    const server = fluenceServer({
      "POST /v1/api_keys": (_req, n) =>
        n === 1 ? json({ message: "unknown scope prices:read" }, 400) : json({ id: "k9", value: "SCOPED-KEY" }),
      "GET /v1/users/me": () => json({ id: "u1", permissions: ["vms:read", "vms:write", "clusters:read", "billing:admin"] }),
      "GET /v2/vms": () => json({ items: [] }),
    });
    await newAuth(server.fetchImpl).apiJson("/v2/vms");
    const keyReqs = server.seen.filter((s) => s.url === "/v1/api_keys");
    expect(keyReqs).toHaveLength(2);
    expect(keyReqs[1].body.scopes).toEqual(["vms:read", "vms:write", "clusters:read"]);
    expect(server.seen.find((s) => s.url === "/v1/users/me")?.bearer).toBe("ACCESS-SECRET-1");
    expect(server.seen.find((s) => s.url === "/v2/vms")?.apiKey).toBe("SCOPED-KEY");
  });

  it("on 401/403 deletes the rejected key server-side, then recreates it at most once per process", async () => {
    const server = fluenceServer({
      "GET /v2/vms": (req) => (req.apiKey === "FLUENCE-API-KEY-SECRET-2" ? json({ items: [] }) : json({}, 401)),
      "DELETE /v1/api_keys/k1": () => new Response(null, { status: 204 }),
      "GET /v1/clusters/resources": () => json({}, 403),
    });
    const auth = newAuth(server.fetchImpl);
    expect(await auth.apiJson("/v2/vms")).toEqual({ items: [] });
    const delIndex = server.seen.findIndex((s) => s.method === "DELETE");
    const del = server.seen[delIndex];
    expect(del.url).toBe("/v1/api_keys/k1");
    expect(del.bearer).toBe("ACCESS-SECRET-1");
    expect(del.apiKey).toBeUndefined();
    // Deleted server-side BEFORE the new key is created.
    expect(delIndex).toBeLessThan(server.seen.map((s) => s.url).lastIndexOf("/v1/api_keys"));
    expect(server.keyCount()).toBe(2);
    // The new key is rejected too: no second re-creation (no key-creation loop).
    await expect(auth.apiJson("/v1/clusters/resources")).rejects.toThrow(/403/);
    expect(server.keyCount()).toBe(2);
    expect(server.seen.filter((s) => s.method === "DELETE")).toHaveLength(1);
  });

  it("refreshes the session with {refresh_token} and reads {access_token}", async () => {
    const server = fluenceServer({
      "POST /v1/api_keys": (req) => (req.bearer === "ACCESS-SECRET-2" ? json({ id: "k1", value: "KEY" }) : json({}, 401)),
      "POST /auth/refresh": () => json({ access_token: "ACCESS-SECRET-2" }),
      "GET /v2/vms": () => json({ items: [] }),
    });
    await newAuth(server.fetchImpl).apiJson("/v2/vms");
    const refresh = server.seen.find((s) => s.url === "/auth/refresh")!;
    expect(refresh.body).toEqual({ refresh_token: "REFRESH-SECRET-1" });
    expect(server.seen.filter((s) => s.url === "/v1/auth/siwe")).toHaveLength(1);
    expect(server.seen.filter((s) => s.url === "/v1/api_keys").map((s) => s.bearer)).toEqual([
      "ACCESS-SECRET-1",
      "ACCESS-SECRET-2",
    ]);
  });

  it("reads the balance array with the API key and falls back to the Bearer session on 403", async () => {
    const server = fluenceServer({
      "GET /v2/users/balances": (req) =>
        req.apiKey ? json({}, 403) : json([{ balance: "3.50", usageDaysLeft: 2 }, { balance: "1.00", usageDaysLeft: null }]),
    });
    const testDb = createTestDb();
    const vms = new FluenceVmClient({
      auth: newAuth(server.fetchImpl),
      db: testDb.raw,
      policy: POLICY,
      config: resolveFluenceConfig({ fluence: { enabled: true } }),
      ssh: { ensureKey: async () => "", forgetHost: () => undefined },
    });
    expect(await vms.getBalance()).toEqual({ cents: 450, usageDaysLeft: 2 });
    const calls = server.seen.filter((s) => s.url === "/v2/users/balances");
    expect(calls.map((c) => [c.apiKey, c.bearer])).toEqual([
      ["FLUENCE-API-KEY-SECRET-1", undefined],
      [undefined, "ACCESS-SECRET-1"],
    ]);
    // A 403 on the balance is a missing scope, not a bad key: no re-creation.
    expect(server.keyCount()).toBe(1);
    expect(server.seen.some((s) => s.method === "DELETE")).toBe(false);
    testDb.close();
  });

  it("top-up headers carry the key as X-API-KEY, or nothing when no key can be obtained", async () => {
    const ok = fluenceServer();
    expect(await newAuth(ok.fetchImpl).authHeaders()).toEqual({ "X-API-KEY": "FLUENCE-API-KEY-SECRET-1" });
    const down = fluenceServer({ "GET /v1/auth/siwe/nonce": () => json({}, 503) });
    expect(await newAuth(down.fetchImpl, path.join(dir, "other.json")).authHeaders()).toEqual({});
  });
});

// ─── VM client ─────────────────────────────────────────────────

const PUB_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHRlc3R0ZXN0dGVzdHRlc3R0ZXN0dGVzdHRlc3R0ZXN0 automaton-fluence";

/** GET /v1/clusters/resources: two usable clusters and one without public IPv4. */
const CLUSTER_RESOURCES = {
  resources: {
    "cl-a": {
      availableConfigurations: [
        { id: "cfg-a2", slug: "cpu-shared-2vcpu-4gb", name: "2 vCPU", vcpu: 2, ramGb: 4, dedicated: false },
        { id: "cfg-a1", slug: "cpu-shared-1vcpu-2gb", name: "1 vCPU", vcpu: 1, ramGb: 2, dedicated: false },
        { id: "cfg-ad", slug: "cpu-dedicated-1vcpu-2gb", name: "dedicated", vcpu: 1, ramGb: 2, dedicated: true },
      ],
      availablePublicIps: { V4: 3 },
      availableStorage: { amd: [{ storageType: "NVME", replicated: false, volumeGb: 500 }] },
    },
    "cl-b": {
      availableConfigurations: [{ id: "cfg-b1", slug: "cpu-shared-1vcpu-2gb", vcpu: 1, ramGb: 2, dedicated: false }],
      availablePublicIps: { V4: 5 },
      availableStorage: { amd: [{ storageType: "NVME", replicated: false, volumeGb: 500 }] },
    },
    "cl-noip": {
      availableConfigurations: [{ id: "cfg-c1", slug: "cpu-shared-1vcpu-1gb", vcpu: 1, ramGb: 1, dedicated: false }],
      availablePublicIps: { V4: 0 },
      availableStorage: { amd: [{ storageType: "NVME", replicated: false, volumeGb: 500 }] },
    },
  },
};

/** GET /v1/prices/vm?clusterId=… */
const VM_PRICES: Record<string, { items: any[] }> = {
  "cl-a": {
    items: [
      { vmTypeId: { vmConfigurationId: "cfg-a2", clusterId: "cl-a" }, priceInfo: { pricePerHourPerQty: "0.02" } },
      { vmTypeId: { vmConfigurationId: "cfg-a1", clusterId: "cl-a" }, priceInfo: { pricePerHourPerQty: "0.012" } },
    ],
  },
  "cl-b": {
    items: [{ vmTypeId: { vmConfigurationId: "cfg-b1", clusterId: "cl-b" }, priceInfo: { pricePerHourPerQty: "0.01" } }],
  },
  "cl-noip": {
    items: [{ vmTypeId: { vmConfigurationId: "cfg-c1", clusterId: "cl-noip" }, priceInfo: { pricePerHourPerQty: "0.001" } }],
  },
};

/** GET /v1/storages/default_images */
const DEFAULT_IMAGES = {
  items: [
    { id: "i1", name: "Debian 12", distribution: "debian", slug: "debian-12", downloadUrl: "https://img.example/debian.qcow2", username: "debian" },
    { id: "i2", name: "Ubuntu 22.04", distribution: "ubuntu", slug: "ubuntu-22-04", downloadUrl: "https://img.example/u2204.qcow2", username: "ubuntu" },
    { id: "i3", name: "Ubuntu 24.04", distribution: "ubuntu", slug: "ubuntu-24-04", downloadUrl: "https://img.example/u2404.qcow2", username: "ubuntu" },
  ],
};

/** UserVmDto: `bootDisk` and `publicIp` are id strings; the address is under `expanded`. */
function vmDto(status: string, extra: Record<string, unknown> = {}) {
  return {
    id: "vm-1",
    name: "svc",
    status,
    bootDisk: "disk-1",
    publicIp: "ip-1",
    configurationSlug: "cpu-shared-1vcpu-2gb",
    priceHourlyUsd: "0.0104",
    priceMonthlyUsd: "7.50",
    createdAt: "2026-10-09T09:00:00Z",
    ...extra,
  };
}

describe("fluence VM client", () => {
  let db: AutomatonDatabase;
  beforeEach(() => {
    db = createTestDb();
  });
  afterEach(() => db.close());

  function api(opts: { vms?: any[]; quote?: string; vmStatuses?: string[]; sshKey409?: boolean; sshKeys?: any } = {}) {
    const calls: { method: string; path: string; body?: any }[] = [];
    const statuses = [...(opts.vmStatuses ?? ["launched"])];
    const apiJson = vi.fn(async (p: string, init: RequestInit = {}) => {
      const method = init.method || "GET";
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, path: p, body });
      if (method === "GET" && p === "/v2/vms?expand=publicIp")
        return { items: opts.vms ?? [], pagination: { total: (opts.vms ?? []).length } };
      if (method === "GET" && p === "/v1/clusters/resources") return CLUSTER_RESOURCES;
      if (method === "GET" && p.startsWith("/v1/prices/vm?clusterId=")) return VM_PRICES[p.split("=")[1]] ?? { items: [] };
      if (method === "GET" && p === "/v1/storages/default_images") return DEFAULT_IMAGES;
      if (method === "POST" && p === "/v1/prices/cost")
        return { costOfResources: [], totalCostPerSec: "0.0000029", periodSecs: 2592000, totalCost: opts.quote ?? "7.50" };
      if (method === "POST" && p === "/v1/ssh_keys") {
        if (opts.sshKey409) throw Object.assign(new Error("Fluence POST /v1/ssh_keys failed (409)"), { status: 409 });
        return { id: "key-1", name: body.name, publicKey: body.publicKey, algorithm: "ssh-ed25519", fingerprint: "SHA256:x" };
      }
      if (method === "GET" && p === "/v1/ssh_keys") return opts.sshKeys ?? [];
      if (method === "POST" && p === "/v2/vms") return vmDto("new");
      if (method === "GET" && p === "/v2/vms/vm-1?expand=publicIp") {
        const status = statuses.length > 1 ? statuses.shift()! : statuses[0];
        return vmDto(status, status === "launched" ? { expanded: { publicIp: { id: "ip-1", address: "203.0.113.5" } } } : {});
      }
      if (method === "POST" && p.endsWith("/terminate")) return {};
      if (method === "DELETE") return undefined;
      throw new Error(`unexpected ${method} ${p}`);
    });
    return { apiJson, calls };
  }

  function client(
    a: ReturnType<typeof api>,
    policy: TreasuryPolicy = POLICY,
    config = resolveFluenceConfig({ fluence: { enabled: true } }),
  ) {
    return new FluenceVmClient({
      auth: { apiJson: a.apiJson as any },
      db: db.raw,
      policy,
      config,
      ssh: { ensureKey: async () => PUB_KEY, forgetHost: vi.fn() },
      pollIntervalMs: 0,
      launchPollAttempts: 5,
      terminatePollAttempts: 3,
    });
  }

  it("creates the cheapest cpu-shared VM with the exact Fluence request shapes", async () => {
    const a = api({ vmStatuses: ["new", "launching", "launched"] });
    const c = client(a);
    const info = await c.createSandbox({ name: "My Service_v2!!" });
    expect(info.id).toBe("vm-1");
    expect(info.status).toBe("launched");
    expect(info.terminalUrl).toBe("ssh ubuntu@203.0.113.5");

    // Prices are read per candidate cluster (not the one without public IPs).
    const prices = a.calls.filter((x) => x.path.startsWith("/v1/prices/vm"));
    expect(prices.map((x) => x.path).sort()).toEqual(["/v1/prices/vm?clusterId=cl-a", "/v1/prices/vm?clusterId=cl-b"]);

    // Cheapest priced pair: cl-b / cfg-b1 at $0.01/h.
    const quote = a.calls.find((x) => x.path === "/v1/prices/cost")!;
    expect(quote.body).toEqual({
      secs: 2592000,
      resources: [
        { vm: { resource_id: { vmConfigurationId: "cfg-b1", clusterId: "cl-b" } } },
        { storage: { resource_id: { storageType: "NVME", replicated: false, clusterId: "cl-b" }, volume_gb: 25 } },
        { publicIp: { resource_id: { addressType: "V4", clusterId: "cl-b" } } },
      ],
    });

    const keyCall = a.calls.find((x) => x.method === "POST" && x.path === "/v1/ssh_keys")!;
    expect(keyCall.body).toEqual({ name: "automaton-fluence", publicKey: PUB_KEY });

    const create = a.calls.find((x) => x.method === "POST" && x.path === "/v2/vms")!;
    const name = create.body.name;
    expect(name).toBe("my-service-v2");
    expect(create.body).toEqual({
      name,
      clusterId: "cl-b",
      configurationId: "cfg-b1",
      bootDisk: {
        clusterId: "cl-b",
        name: `${name}-boot`,
        storageType: "NVME",
        volumeGb: 25,
        replicated: false,
        osImage: "https://img.example/u2404.qcow2",
      },
      publicIp: { clusterId: "cl-b", name: `${name}-ip`, addressType: "V4" },
      sshKeys: ["key-1"],
    });
    for (const n of [name, create.body.bootDisk.name, create.body.publicIp.name]) expect(n).toMatch(/^[a-z0-9-]{1,25}$/);
    expect(a.calls.indexOf(quote)).toBeLessThan(a.calls.indexOf(create));

    // bootDisk / publicIp ids (plain strings) and the image's SSH user are stored.
    const row = c.getTrackedVm("vm-1")!;
    expect([row.storage_id, row.public_ip_id, row.public_ip, row.ssh_user, row.status]).toEqual([
      "disk-1",
      "ip-1",
      "203.0.113.5",
      "ubuntu",
      "launched",
    ]);
    expect(await c.getSshTarget("vm-1")).toEqual({ vmId: "vm-1", host: "203.0.113.5", user: "ubuntu" });
  });

  it("reuses the registered SSH key on 409 (matched by public key or fingerprint)", async () => {
    const sameKeyOtherComment = `${PUB_KEY.split(" ").slice(0, 2).join(" ")} other-comment`;
    const a = api({
      sshKey409: true,
      sshKeys: [
        { id: "other", publicKey: "ssh-ed25519 AAAAOTHER x" },
        { id: "key-7", publicKey: sameKeyOtherComment },
      ],
    });
    await client(a).createSandbox();
    expect(a.calls.find((x) => x.method === "POST" && x.path === "/v2/vms")!.body.sshKeys).toEqual(["key-7"]);

    const byFingerprint = api({ sshKey409: true, sshKeys: { items: [{ id: "key-8", fingerprint: sshFingerprint(PUB_KEY) }] } });
    expect(await client(byFingerprint).ensureSshKeyId(PUB_KEY)).toBe("key-8");

    const missing = api({ sshKey409: true, sshKeys: [] });
    await expect(client(missing).ensureSshKeyId(PUB_KEY)).rejects.toThrow(/already registered/);
  });

  it("uses the config sshUser only as an override", async () => {
    const a = api();
    const c = client(a, POLICY, resolveFluenceConfig({ fluence: { enabled: true, sshUser: "admin" } }));
    await c.createSandbox();
    expect((await c.getSshTarget("vm-1")).user).toBe("admin");
  });

  it("refuses creation when the 30-day quote exceeds maxComputeMonthlyCents or is unreadable", async () => {
    for (const quote of ["10.01", "n/a"]) {
      const a = api({ quote });
      await expect(client(a).createSandbox()).rejects.toThrow(FluenceGuardError);
      expect(a.calls.some((x) => x.path === "/v2/vms" && x.method === "POST")).toBe(false);
    }
  });

  it("refuses creation when one VM already exists", async () => {
    const a = api({ vms: [vmDto("launched", { id: "existing" })] });
    await expect(client(a).createSandbox()).rejects.toThrow(/already exists/);
    expect(a.calls.some((x) => x.path === "/v1/prices/cost")).toBe(false);
  });

  it("refuses creation when compute caps are absent", async () => {
    const a = api();
    await expect(client(a, STANDALONE_TREASURY_POLICY).createSandbox()).rejects.toThrow(/Compute is disabled/);
    expect(a.calls).toHaveLength(0);
  });

  it("delete terminates the VM, waits for `terminated`, then deletes its public IP and its disk", async () => {
    const a = api();
    const c = client(a);
    await c.createSandbox();
    a.calls.length = 0;
    a.apiJson.mockImplementation(async (p: string, init: RequestInit = {}) => {
      const method = init.method || "GET";
      a.calls.push({ method, path: p });
      if (p === "/v2/vms/vm-1?expand=publicIp") {
        return vmDto(a.calls.filter((x) => x.path === p).length < 2 ? "terminating" : "terminated");
      }
      return method === "DELETE" ? undefined : {};
    });
    const result = await c.deleteSandbox("vm-1");
    expect(result).toEqual({ done: true, remaining: [] });
    expect(a.calls.map((x) => `${x.method} ${x.path}`)).toEqual([
      "POST /v2/vms/vm-1/terminate",
      "GET /v2/vms/vm-1?expand=publicIp",
      "GET /v2/vms/vm-1?expand=publicIp",
      "DELETE /v1/public_ips/ip-1",
      "DELETE /v1/storages/disk-1",
    ]);
    expect(c.getLiveTrackedVms()).toHaveLength(0);
  });

  it("leaves the IP and disk as remaining while the VM is not terminated yet, then finishes on retry", async () => {
    const a = api();
    const c = client(a);
    await c.createSandbox();
    let status = "terminating";
    a.apiJson.mockImplementation(async (p: string, init: RequestInit = {}) => {
      const method = init.method || "GET";
      a.calls.push({ method, path: p });
      if (p === "/v2/vms/vm-1?expand=publicIp") return vmDto(status);
      return method === "DELETE" ? undefined : {};
    });
    a.calls.length = 0;
    const first = await c.deleteSandbox("vm-1");
    expect(first.done).toBe(false);
    expect(first.remaining).toEqual([expect.stringMatching(/^public IP \(waiting/), expect.stringMatching(/^storage \(waiting/)]);
    expect(a.calls.some((x) => x.method === "DELETE")).toBe(false);
    // The IP / disk are still tracked as billing.
    expect(c.getLiveTrackedVms()).toHaveLength(1);

    status = "terminated";
    a.calls.length = 0;
    expect((await c.deleteSandbox("vm-1")).done).toBe(true);
    expect(a.calls.map((x) => `${x.method} ${x.path}`)).toEqual([
      "GET /v2/vms/vm-1?expand=publicIp",
      "DELETE /v1/public_ips/ip-1",
      "DELETE /v1/storages/disk-1",
    ]);
  });

  it("retries only the remaining steps after a partial delete, and refuses unknown VMs", async () => {
    const a = api();
    const c = client(a);
    await c.createSandbox();
    a.apiJson.mockImplementation(async (p: string, init: RequestInit = {}) => {
      a.calls.push({ method: init.method || "GET", path: p });
      if (p.startsWith("/v1/storages")) throw Object.assign(new Error("boom"), { status: 500 });
      if (p === "/v2/vms/vm-1?expand=publicIp") return vmDto("terminated");
      return {};
    });
    a.calls.length = 0;
    expect((await c.deleteSandbox("vm-1")).remaining).toEqual([expect.stringMatching(/^storage/)]);
    a.apiJson.mockImplementation(async (p: string, init: RequestInit = {}) => {
      a.calls.push({ method: init.method || "GET", path: p });
      return {};
    });
    a.calls.length = 0;
    expect((await c.deleteSandbox("vm-1")).done).toBe(true);
    expect(a.calls.map((x) => `${x.method} ${x.path}`)).toEqual(["DELETE /v1/storages/disk-1"]);
    await expect(c.deleteSandbox("someone-elses-vm")).rejects.toThrow(/not created by this agent/);
  });

  it("cleans up a VM that fails to start (terminate, IP, disk)", async () => {
    const a = api({ vmStatuses: ["launching", "failed"] });
    const c = client(a);
    await expect(c.createSandbox()).rejects.toThrow(/failed to start; it was cleaned up/);
    expect(
      a.calls
        .filter((x) => x.method !== "GET")
        .map((x) => `${x.method} ${x.path}`)
        .slice(-3),
    ).toEqual(["POST /v2/vms/vm-1/terminate", "DELETE /v1/public_ips/ip-1", "DELETE /v1/storages/disk-1"]);
    expect(c.getLiveTrackedVms()).toHaveLength(0);
  });

  it("a tracked VM reported `failed` is cleaned up before a new one is planned", async () => {
    const a = api();
    const c = client(a);
    await c.createSandbox();
    a.calls.length = 0;
    a.apiJson.mockImplementation(async (p: string, init: RequestInit = {}) => {
      const method = init.method || "GET";
      a.calls.push({ method, path: p });
      if (p === "/v2/vms?expand=publicIp") {
        const terminated = a.calls.some((x) => x.path.endsWith("/terminate"));
        return { items: terminated ? [] : [vmDto("failed")], pagination: {} };
      }
      if (p === "/v2/vms/vm-1?expand=publicIp") return vmDto("failed");
      if (p === "/v1/clusters/resources") return { resources: {} };
      return method === "DELETE" ? undefined : {};
    });
    await expect(c.createSandbox()).rejects.toThrow(/No priced cpu-shared/);
    expect(a.calls.map((x) => `${x.method} ${x.path}`)).toEqual(
      expect.arrayContaining(["POST /v2/vms/vm-1/terminate", "DELETE /v1/public_ips/ip-1", "DELETE /v1/storages/disk-1"]),
    );
    expect(c.getLiveTrackedVms()).toHaveLength(0);
  });

  it("never passes a non-IPv4 address to ssh", async () => {
    const a = api({ vmStatuses: ["new"] });
    const c = client(a);
    await c.createSandbox();
    a.apiJson.mockImplementation(async (p: string) =>
      p === "/v2/vms/vm-1?expand=publicIp"
        ? vmDto("launched", { expanded: { publicIp: { address: "-oProxyCommand=sh" } } })
        : {},
    );
    await expect(c.getSshTarget("vm-1")).rejects.toThrow(/no valid public IPv4/);
    expect(mapVm(vmDto("launched", { expanded: { publicIp: { address: "1.2.3.4; id" } } }))?.address).toBeUndefined();
    expect(mapVm(vmDto("launched", { expanded: { publicIp: { address: "999.1.1.1" } } }))?.address).toBeUndefined();
    expect(mapVm(vmDto("launched", { expanded: { publicIp: { address: "198.51.100.7" } } }))?.address).toBe("198.51.100.7");
  });

  it("parses the documented shapes and fails closed on anything else", () => {
    expect(
      sharedCandidates(CLUSTER_RESOURCES, 25)
        .map((x) => `${x.clusterId}/${x.id}`)
        .sort(),
    ).toEqual(["cl-a/cfg-a1", "cl-a/cfg-a2", "cl-b/cfg-b1"]);
    // Not enough NVME, or only replicated storage: no candidate.
    expect(sharedCandidates(CLUSTER_RESOURCES, 600)).toEqual([]);
    const replicatedOnly = {
      resources: {
        x: {
          ...CLUSTER_RESOURCES.resources["cl-a"],
          availableStorage: { amd: [{ storageType: "NVME", replicated: true, volumeGb: 500 }] },
        },
      },
    };
    expect(sharedCandidates(replicatedOnly, 25)).toEqual([]);
    expect(sharedCandidates([{ slug: "cpu-shared-1vcpu-1gb" }], 25)).toEqual([]);
    expect(vmHourlyPrice(VM_PRICES["cl-a"], "cl-a", "cfg-a1")).toBe(0.012);
    expect(vmHourlyPrice(VM_PRICES["cl-a"], "cl-b", "cfg-a1")).toBeUndefined();

    expect(parseQuoteCents({ costOfResources: [], totalCostPerSec: "0.0000016", periodSecs: 2592000, totalCost: "4.20" })).toBe(420);
    expect(parseQuoteCents({ totalCost: 4.2 })).toBeNull();
    expect(parseQuoteCents({ total: "4.20" })).toBeNull();

    expect(parseBalance([{ balance: "-2.5", usageDaysLeft: null }])).toEqual({ cents: -250, usageDaysLeft: null });
    expect(parseBalance([{ balance: "10" }, { balance: "2.25", usageDaysLeft: 4 }])).toEqual({ cents: 1225, usageDaysLeft: 4 });
    expect(parseBalance({ balance: "10" })).toBeNull();
    expect(parseBalance([{ balance: 10 }])).toBeNull();
    expect(parseBalance([])).toBeNull();

    expect(pickUbuntuImage(DEFAULT_IMAGES)).toEqual({
      downloadUrl: "https://img.example/u2404.qcow2",
      username: "ubuntu",
      name: "Ubuntu 24.04",
    });
    expect(pickUbuntuImage({ items: [DEFAULT_IMAGES.items[0], DEFAULT_IMAGES.items[1]] })?.downloadUrl).toBe(
      "https://img.example/u2204.qcow2",
    );
    expect(pickUbuntuImage({ items: [DEFAULT_IMAGES.items[0]] })).toBeNull();
    expect(pickUbuntuImage(DEFAULT_IMAGES.items)).toBeNull();

    expect(sanitizeFluenceName("A".repeat(60))).toBe("a".repeat(20));
    expect(sanitizeFluenceName("---")).toBe("automaton-service");
    expect(mapVm({ id: "x" })).toBeNull();
  });
});

// ─── SSH ───────────────────────────────────────────────────────

describe("fluence SSH", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fluence-ssh-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  function transport() {
    const runs: { file: string; args: string[] }[] = [];
    const t: SshTransport = {
      async run(file, args) {
        runs.push({ file, args });
        if (file === "ssh-keygen") {
          const keyPath = args[args.indexOf("-f") + 1];
          fs.writeFileSync(keyPath, "-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n", { mode: 0o644 });
          fs.writeFileSync(`${keyPath}.pub`, "ssh-ed25519 AAAAFAKE automaton-fluence\n");
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        if (file === "ssh-keyscan") return { stdout: "203.0.113.5 ssh-ed25519 AAAAHOSTKEY\n", stderr: "", exitCode: 0 };
        return { stdout: "hello", stderr: "", exitCode: 0 };
      },
    };
    return { t, runs };
  }

  it("generates a 0600 ed25519 key, pins the host key once, and runs ssh without a local shell", async () => {
    const { t, runs } = transport();
    const ssh = new FluenceSsh({ transport: t, sshDir: path.join(dir, "ssh") });
    const target = { vmId: "vm-1", host: "203.0.113.5", user: "ubuntu" };
    const pub = await ssh.ensureKey();
    expect(pub).toMatch(/^ssh-ed25519 /);
    expect(fs.statSync(ssh.keyPath).mode & 0o777).toBe(0o600);

    const r1 = await ssh.exec(target, "uname -a; echo $HOME");
    await ssh.exec(target, "true");
    expect(r1.stdout).toBe("hello");
    expect(runs.filter((r) => r.file === "ssh-keyscan")).toHaveLength(1);
    expect(fs.readFileSync(ssh.knownHostsPath("vm-1"), "utf-8")).toContain("AAAAHOSTKEY");

    const sshRun = runs.find((r) => r.file === "ssh")!;
    const opts = sshRun.args.join(" ");
    expect(opts).toContain("StrictHostKeyChecking=yes");
    expect(opts).toContain("BatchMode=yes");
    expect(opts).toContain(`UserKnownHostsFile=${ssh.knownHostsPath("vm-1")}`);
    expect(opts).toContain("ForwardAgent=no");
    expect(opts).toContain("ForwardX11=no");
    // The command is ONE argument after "--" (no local shell interpolation).
    expect(sshRun.args.slice(-3)).toEqual(["ubuntu@203.0.113.5", "--", "uname -a; echo $HOME"]);
  });

  it("refuses unsafe hosts and remote paths", async () => {
    const { t } = transport();
    const ssh = new FluenceSsh({ transport: t, sshDir: path.join(dir, "ssh") });
    await expect(ssh.exec({ vmId: "v", host: "a;rm -rf /", user: "ubuntu" }, "ls")).rejects.toThrow(/Invalid VM host/);
    // Only a plain IPv4 reaches ssh / scp / ssh-keyscan.
    for (const host of ["vm.example.com", "::1", "-oProxyCommand=id", "256.1.1.1", "1.2.3"]) {
      expect(isValidHost(host), host).toBe(false);
      await expect(ssh.exec({ vmId: "v", host, user: "ubuntu" }, "ls")).rejects.toThrow(/Invalid VM host/);
    }
    expect(isValidHost("203.0.113.5")).toBe(true);
    await expect(ssh.exec({ vmId: "v", host: "203.0.113.5", user: "-oX" }, "ls")).rejects.toThrow(/Invalid VM user/);
    expect(isSafeRemotePath("~/service/server.js")).toBe(true);
    expect(isSafeRemotePath("~/a b")).toBe(false);
    expect(isSafeRemotePath("../etc/passwd")).toBe(false);
    expect(isSafeRemotePath("$(id)")).toBe(false);
  });
});

// ─── Upload guard ──────────────────────────────────────────────

describe("sandbox_upload guard", () => {
  let home: string;
  let work: string;
  beforeEach(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fluence-home-")));
    work = path.join(home, "work");
    fs.mkdirSync(path.join(work, "svc", "node_modules"), { recursive: true });
    fs.mkdirSync(path.join(home, ".automaton", "ssh"), { recursive: true });
    fs.writeFileSync(path.join(work, "svc", "server.js"), "console.log('hi')\n");
    fs.writeFileSync(path.join(home, ".automaton", "wallet.json"), '{"privateKey":"0x' + "ab".repeat(32) + '"}');
    fs.writeFileSync(path.join(home, ".automaton", "fluence.json"), '{"apiKey":"x"}');
    fs.writeFileSync(path.join(home, ".automaton", "ssh", "fluence_ed25519"), "-----BEGIN OPENSSH PRIVATE KEY-----\n");
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  const plan = (p: string) => planUpload(p, { home, workRoot: work });

  it("allows files and directories under ~/work", () => {
    const file = plan("~/work/svc/server.js");
    expect(file.ok && file.files.map((f) => f.relPath)).toEqual(["server.js"]);
    const dir = plan("svc");
    expect(dir.ok && dir.files.map((f) => f.relPath)).toEqual(["server.js"]);
  });

  it.each([
    "~/.automaton/wallet.json",
    "~/.automaton/fluence.json",
    "~/.automaton/ssh/fluence_ed25519",
    "~/.automaton",
    "/proc/self/environ",
    "/etc/passwd",
    "~/work/../.automaton/wallet.json",
  ])("refuses %s", (p) => {
    expect(plan(p).ok).toBe(false);
  });

  it("refuses symlinks into ~/.automaton, wallet / key / .env files and key-looking content", () => {
    fs.symlinkSync(path.join(home, ".automaton", "wallet.json"), path.join(work, "svc", "data.json"));
    expect(plan("svc").ok).toBe(false);
    expect(plan("~/work/svc/data.json").ok).toBe(false);
    fs.rmSync(path.join(work, "svc", "data.json"));

    for (const [name, content] of [
      ["wallet-backup.json", "{}"],
      ["deploy.key", "x"],
      ["cert.pem", "x"],
      [".env.local", "A=1"],
      ["config.js", `const k = "0x${"12".repeat(32)}";`],
      ["notes.txt", "-----BEGIN EC PRIVATE KEY-----"],
    ]) {
      const p = path.join(work, "svc", name);
      fs.writeFileSync(p, content);
      expect(plan(`~/work/svc/${name}`).ok, name).toBe(false);
      expect(plan("svc").ok, `dir with ${name}`).toBe(false);
      fs.rmSync(p);
    }
    expect(looksLikePrivateKey("tx 0x" + "ab".repeat(32) + "ff")).toBe(false); // 66 hex: not a key
  });

  it("skips node_modules symlinks pointing outside ~/work", () => {
    fs.symlinkSync(path.join(home, ".automaton"), path.join(work, "svc", "node_modules", "evil"));
    const result = plan("svc");
    expect(result.ok).toBe(true);
    expect(result.ok && result.skipped).toEqual([path.join("node_modules", "evil")]);
    expect(result.ok && result.files.every((f) => f.absPath.startsWith(work))).toBe(true);
  });
});

// ─── Tools exposure and policies ───────────────────────────────

describe("fluence tools and policies", () => {
  const names = (config: any) => filterToolsForProvider(createBuiltinTools("sb"), config).map((t) => t.name);
  const standalone = { providerMode: "standalone" as const };
  const withFluence = { providerMode: "standalone" as const, fluence: { enabled: true } };

  it("hides the Fluence tools unless standalone + fluence.enabled", () => {
    for (const tool of FLUENCE_TOOLS) {
      expect(names(standalone)).not.toContain(tool);
      expect(names({ providerMode: "conway", fluence: { enabled: true } })).not.toContain(tool);
      expect(names(withFluence)).toContain(tool);
    }
    for (const tool of ["create_sandbox", "list_sandboxes", "delete_sandbox"]) {
      expect(names(standalone)).not.toContain(tool);
      expect(names(withFluence)).toContain(tool);
    }
  });

  it("keeps replication, transfers, credits, domains and ports disabled with Fluence", () => {
    const enabled = names(withFluence);
    for (const tool of [
      "spawn_child",
      "fund_child",
      "start_child",
      "transfer_credits",
      "topup_credits",
      "expose_port",
      "remove_port",
      "search_domains",
      "register_domain",
      "manage_dns",
    ]) {
      expect(enabled).not.toContain(tool);
    }
    for (const tool of ["spawn_child", "fund_child", "transfer_credits"]) {
      expect(STANDALONE_FORBIDDEN_TOOLS.has(tool)).toBe(true);
    }
  });

  it("fluence_topup is dangerous; sandbox_exec goes through the forbidden-command rule", () => {
    const tools = createBuiltinTools("sb");
    expect(tools.find((t) => t.name === "fluence_topup")?.riskLevel).toBe("dangerous");
    expect(tools.find((t) => t.name === "fluence_status")?.description).toMatch(/debt exceeds \$5 or lasts 3 days/);
    for (const name of ["create_sandbox", "fluence_status", "fluence_topup"]) {
      const d = tools.find((t) => t.name === name)!.description;
      expect(d, name).toMatch(/per second/);
      expect(d, name).toMatch(/at least 6 hours/);
      expect(d, name).toMatch(/billed separately/);
    }
    const forbidden = createDefaultRules().find((r) => r.id === "command.forbidden_patterns")!;
    expect((forbidden.appliesTo as any).names).toContain("sandbox_exec");
  });

  function request(toolName: string, args: Record<string, unknown>): PolicyRequest {
    return {
      tool: { name: toolName } as any,
      args,
      context: { config: createTestConfig({ providerMode: "standalone", fluence: { enabled: true } } as any) } as any,
      turnContext: { inputSource: undefined, turnToolCallCount: 0, sessionSpend: {} as any },
    };
  }

  it("the secret-access policy denies exec / read_file / sandbox_upload on fluence.json and the SSH key", () => {
    const [rule] = createSecretAccessRules();
    for (const [tool, args] of [
      ["exec", { command: "cat ~/.automaton/fluence.json" }],
      ["exec", { command: "ssh -i ~/.automaton/ssh/fluence_ed25519 ubuntu@1.2.3.4" }],
      ["read_file", { path: "~/.automaton/fluence.json" }],
      ["read_file", { path: "~/.automaton/ssh/fluence_ed25519" }],
      ["sandbox_upload", { local_path: "~/.automaton/ssh/fluence_ed25519", remote_path: "x" }],
      ["sandbox_upload", { local_path: "~/work/../.automaton/wallet.json", remote_path: "x" }],
    ] as const) {
      expect(rule.evaluate(request(tool, args as any))?.action, `${tool} ${JSON.stringify(args)}`).toBe("deny");
    }
    expect(rule.evaluate(request("sandbox_upload", { local_path: "~/work/svc", remote_path: "svc" }))).toBeNull();
  });

  it("never commits fluence.json or SSH keys to the state repo, and protects the Fluence code", () => {
    expect(SENSITIVE_STATE_FILES).toEqual(expect.arrayContaining(["fluence.json", "ssh/", "wallet.json"]));
    expect(buildStateGitignore()).toMatch(/^fluence\.json$/m);
    expect(buildStateGitignore()).toMatch(/^ssh\/$/m);
    for (const f of ["billing", "auth", "client", "ssh", "upload-guard", "config", "runtime", "status"]) {
      expect(isProtectedFile(`/app/src/fluence/${f}.ts`), f).toBe(true);
      expect(isProtectedFile(`/app/dist/fluence/${f}.js`), f).toBe(true);
    }
    expect(isProtectedFile("/app/src/survival/spend-guard.ts")).toBe(true);
  });
});

// ─── Balance awareness ─────────────────────────────────────────

describe("fluence balance awareness", () => {
  let db: AutomatonDatabase;
  beforeEach(() => {
    db = createTestDb();
  });
  afterEach(() => db.close());

  function runtime(balanceCents: number, burnPerHour: number | null, usageDaysLeft: number | null = null) {
    const topUp = vi.fn();
    const precheck = vi.fn((_amount: number) => null as string | null);
    return {
      rt: {
        vms: {
          getBalance: async () => ({ cents: balanceCents, usageDaysLeft }),
          getHourlyBurnCents: () => burnPerHour,
          getLiveTrackedVms: () => [{ vm_terminated: 0 }],
        } as any,
        billing: { precheck, topUp } as any,
      },
      topUp,
      precheck,
    };
  }

  it("wakes with [COMPUTE] under 3 days of runway, with a cooldown, and never pays", async () => {
    let now = Date.UTC(2026, 9, 9, 8, 0, 0);
    const { rt, topUp } = runtime(500, 10); // 50h
    const first = await checkComputeBalance(rt, db, () => now);
    expect(first.shouldWake).toBe(true);
    expect(first.message).toMatch(/^\[COMPUTE\] Fluence runway is 2\.1 days/);
    expect(first.message).toMatch(/debt exceeds \$5 or lasts 3 days/);
    now += 30 * 60_000;
    expect((await checkComputeBalance(rt, db, () => now)).shouldWake).toBe(false);
    expect(topUp).not.toHaveBeenCalled();
    expect(JSON.parse(db.getKV(FLUENCE_STATUS_KV)!).balanceCents).toBe(500);
  });

  it("under 1 day, says whether a top-up fits the caps (agent must call fluence_topup itself)", async () => {
    const ok = runtime(200, 10); // 20h
    const fits = await checkComputeBalance(ok.rt, db, () => Date.UTC(2026, 9, 9));
    expect(fits.message).toMatch(/you may call fluence_topup/);
    expect(ok.precheck).toHaveBeenCalledWith(1000);
    expect(ok.topUp).not.toHaveBeenCalled();

    const db2 = createTestDb();
    const refused = runtime(200, 10);
    refused.precheck.mockReturnValue("Monthly compute cap exceeded");
    const msg = await checkComputeBalance(refused.rt, db2, () => Date.UTC(2026, 9, 9));
    expect(msg.message).toMatch(/not possible within the caps/);
    db2.close();
  });

  it("uses Fluence's usageDaysLeft as the runway when present", async () => {
    const short = await checkComputeBalance(runtime(10_000, 1, 0.5).rt, db, () => Date.UTC(2026, 9, 9));
    expect(short.shouldWake).toBe(true);
    expect(short.message).toMatch(/runway is 0\.5 days/);
    const db2 = createTestDb();
    expect((await checkComputeBalance(runtime(100, 10, 10).rt, db2)).shouldWake).toBe(false);
    db2.close();
  });

  it("does not wake with a long runway or no live VM", async () => {
    expect((await checkComputeBalance(runtime(10_000, 10).rt, db)).shouldWake).toBe(false);
    expect((await checkComputeBalance(runtime(100, 0).rt, db)).shouldWake).toBe(false);
    expect(computeRunwayHours(100, null)).toBeNull();
  });

  it("shows the cached status in the prompt status block only when Fluence is enabled", () => {
    expect(fluenceStatusLine({ providerMode: "standalone" }, db)).toBe("");
    expect(fluenceStatusLine({ providerMode: "standalone", fluence: { enabled: true } }, db)).toMatch(/not checked yet/);
    db.setKV(
      FLUENCE_STATUS_KV,
      JSON.stringify({ balanceCents: 1234, burnCentsPerHour: 1, runwayHours: 1234, liveVms: 1, checkedAt: new Date().toISOString() }),
    );
    expect(fluenceStatusLine({ providerMode: "standalone", fluence: { enabled: true } }, db)).toMatch(
      /Fluence compute: balance \$12\.34, burn \$0\.01\/h, runway 51\.4 days, 1 VM/,
    );
  });
});
