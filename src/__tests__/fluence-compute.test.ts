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
  pickCheapestSharedConfiguration,
  parseBalanceCents,
  parseQuoteCents,
} from "../fluence/client.js";
import { FluenceSsh, type SshTransport } from "../fluence/ssh.js";
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
  const calls: { url: string; paid: boolean }[] = [];
  const fetchImpl = vi.fn(async (url: any, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const paid = Object.keys(headers).some((k) => k.toUpperCase() === PAYMENT_SIGNATURE_HEADER);
    calls.push({ url: String(url), paid });
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
    authHeaders: async () => ({ Authorization: "Bearer test-key" }),
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

  function authServer() {
    const seen: { url: string; method: string; body?: any; auth?: string }[] = [];
    let apiKeyRequests = 0;
    const fetchImpl = vi.fn(async (url: any, init?: RequestInit) => {
      const u = String(url).replace(FLUENCE, "");
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      seen.push({ url: u, method: init?.method || "GET", body, auth: headers.Authorization });
      if (u === "/v1/auth/siwe/nonce") return json({ nonce: "abcdef12345678" });
      if (u === "/v1/auth/siwe") return json({ accessToken: "ACCESS-SECRET-1", refreshToken: "REFRESH-SECRET-1" });
      if (u === "/v1/api_keys") {
        apiKeyRequests++;
        return json({ id: "k1", key: "FLUENCE-API-KEY-SECRET" });
      }
      if (u === "/v2/users/balances") return json({ balance: "12.34" });
      return json({}, 404);
    });
    return { fetchImpl: fetchImpl as unknown as typeof fetch, seen, apiKeyRequests: () => apiKeyRequests };
  }

  it("logs in with SIWE (api.fluence.dev, chain 8453) and stores ONE API key with mode 0600", async () => {
    const server = authServer();
    const credentialsPath = path.join(dir, ".automaton", "fluence.json");
    const out: string[] = [];
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: any) => {
      out.push(String(chunk));
      return true;
    });
    const auth = new FluenceAuth({ account: TEST_ACCOUNT, apiUrl: FLUENCE, fetchImpl: server.fetchImpl, credentialsPath });
    try {
      const body = await auth.apiJson("/v2/users/balances");
      expect(body).toEqual({ balance: "12.34" });
      // A second instance (restart) reuses the stored key: no new SIWE login, no new key.
      const auth2 = new FluenceAuth({ account: TEST_ACCOUNT, apiUrl: FLUENCE, fetchImpl: server.fetchImpl, credentialsPath });
      await auth2.apiJson("/v2/users/balances");
    } finally {
      writeSpy.mockRestore();
    }

    const login = server.seen.find((s) => s.url === "/v1/auth/siwe")!;
    expect(login.body.message).toContain(`${FLUENCE_SIWE_DOMAIN} wants you to sign in`);
    expect(login.body.message).toContain("URI: https://api.fluence.dev");
    expect(login.body.message).toContain("Chain ID: 8453");
    expect(login.body.message).toContain(TEST_ACCOUNT.address);
    expect(server.apiKeyRequests()).toBe(1);
    const keyReq = server.seen.find((s) => s.url === "/v1/api_keys")!;
    expect(keyReq.auth).toBe("Bearer ACCESS-SECRET-1");
    expect(keyReq.body.scopes).toEqual(expect.arrayContaining(["vms:read", "vms:write"]));
    expect(new Date(keyReq.body.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(365 * 86_400_000);
    expect(server.seen.filter((s) => s.url === "/v2/users/balances").every((s) => s.auth === "Bearer FLUENCE-API-KEY-SECRET")).toBe(true);

    const stat = fs.statSync(credentialsPath);
    expect(stat.mode & 0o777).toBe(0o600);
    const stored = fs.readFileSync(credentialsPath, "utf-8");
    expect(stored).toContain("FLUENCE-API-KEY-SECRET");
    // Session tokens are memory-only.
    expect(stored).not.toContain("ACCESS-SECRET-1");
    expect(stored).not.toContain("REFRESH-SECRET-1");
    // Nothing secret reaches the logs.
    const logs = out.join("");
    for (const secret of ["ACCESS-SECRET-1", "REFRESH-SECRET-1", "FLUENCE-API-KEY-SECRET"]) {
      expect(logs).not.toContain(secret);
    }
  });

  it("drops a rejected API key and creates a new one on 401", async () => {
    let keys = 0;
    let first = true;
    const fetchImpl = (async (url: any, init?: RequestInit) => {
      const u = String(url).replace(FLUENCE, "");
      if (u === "/v1/auth/siwe/nonce") return json({ nonce: "abcdef12345678" });
      if (u === "/v1/auth/siwe") return json({ accessToken: "a", refreshToken: "r" });
      if (u === "/v1/api_keys") return json({ key: `key-${++keys}` });
      const auth = ((init?.headers ?? {}) as Record<string, string>).Authorization;
      if (first && auth === "Bearer key-1") {
        first = false;
        return json({}, 401);
      }
      return json({ ok: auth });
    }) as unknown as typeof fetch;
    const auth = new FluenceAuth({ account: TEST_ACCOUNT, apiUrl: FLUENCE, fetchImpl, credentialsPath: path.join(dir, "fluence.json") });
    expect(await auth.apiJson("/v2/vms")).toEqual({ ok: "Bearer key-2" });
  });
});

// ─── VM client ─────────────────────────────────────────────────

describe("fluence VM client", () => {
  let db: AutomatonDatabase;
  beforeEach(() => {
    db = createTestDb();
  });
  afterEach(() => db.close());

  function api(opts: { vms?: any[]; quoteUsd?: number } = {}) {
    const calls: { method: string; path: string; body?: any }[] = [];
    const apiJson = vi.fn(async (p: string, init: RequestInit = {}) => {
      const method = init.method || "GET";
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, path: p, body });
      if (p.startsWith("/v2/vms?expand=publicIp")) return opts.vms ?? [];
      if (p === "/v2/vms/configurations")
        return [
          { slug: "cpu-shared-2-ram-4gb", price: 0.02 },
          { slug: "cpu-shared-1-ram-2gb", price: 0.01 },
          { slug: "cpu-4-ram-8gb", price: 0.001 },
        ];
      if (p === "/v2/vms/default_images") return [{ name: "Debian 12", url: "debian" }, { name: "Ubuntu 24.04", url: "ubuntu-24.04" }];
      if (p === "/v1/prices/cost") return { totalUsd: opts.quoteUsd ?? 7.5 };
      if (p === "/v1/ssh_keys") return { id: "key-1" };
      if (p === "/v2/vms" && method === "POST")
        return { id: "vm-1", status: "launching", publicIp: { id: "ip-1", address: "203.0.113.5" }, bootDisk: { id: "disk-1" } };
      if (method === "POST" && p.endsWith("/terminate")) return {};
      if (method === "DELETE") return undefined;
      throw new Error(`unexpected ${method} ${p}`);
    });
    return { apiJson, calls };
  }

  function client(a: ReturnType<typeof api>, policy: TreasuryPolicy = POLICY) {
    return new FluenceVmClient({
      auth: { apiJson: a.apiJson as any },
      db: db.raw,
      policy,
      config: resolveFluenceConfig({ fluence: { enabled: true } }),
      ssh: { ensureKey: async () => "ssh-ed25519 AAAATEST automaton-fluence", forgetHost: vi.fn() },
    });
  }

  it("creates the cheapest cpu-shared VM with an Ubuntu disk, IPv4 and the agent's SSH key", async () => {
    const a = api();
    const info = await client(a).createSandbox({ name: "svc" });
    expect(info.id).toBe("vm-1");
    const create = a.calls.find((c) => c.method === "POST" && c.path === "/v2/vms")!;
    expect(create.body.configuration).toBe("cpu-shared-1-ram-2gb");
    expect(create.body.bootDisk).toEqual({ osImage: "ubuntu-24.04", sizeGb: 25 });
    expect(create.body.publicIp).toEqual({ version: "V4" });
    expect(create.body.sshKeys).toEqual([{ id: "key-1" }]);
    const keyCall = a.calls.find((c) => c.path === "/v1/ssh_keys")!;
    expect(keyCall.body.publicKey).toMatch(/^ssh-ed25519 /);
    // Quote covers VM + disk + IP over 30 days, before creation.
    const quote = a.calls.find((c) => c.path === "/v1/prices/cost")!;
    expect(quote.body.durationHours).toBe(720);
    expect(quote.body.resources.map((r: any) => r.type)).toEqual(["vm", "storage", "public_ip"]);
    expect(a.calls.indexOf(quote)).toBeLessThan(a.calls.indexOf(create));
  });

  it("refuses creation when the 30-day quote exceeds maxComputeMonthlyCents", async () => {
    const a = api({ quoteUsd: 10.01 });
    await expect(client(a).createSandbox()).rejects.toThrow(FluenceGuardError);
    expect(a.calls.some((c) => c.path === "/v2/vms" && c.method === "POST")).toBe(false);
  });

  it("refuses creation when one VM already exists", async () => {
    const a = api({ vms: [{ id: "existing", status: "active" }] });
    await expect(client(a).createSandbox()).rejects.toThrow(/already exists/);
    expect(a.calls.some((c) => c.path === "/v1/prices/cost")).toBe(false);
  });

  it("refuses creation when compute caps are absent", async () => {
    const a = api();
    await expect(client(a, STANDALONE_TREASURY_POLICY).createSandbox()).rejects.toThrow(/Compute is disabled/);
    expect(a.calls).toHaveLength(0);
  });

  it("delete terminates the VM, then deletes its public IP and its disk", async () => {
    const a = api();
    const c = client(a);
    await c.createSandbox();
    a.calls.length = 0;
    const result = await c.deleteSandbox("vm-1");
    expect(result).toEqual({ done: true, remaining: [] });
    expect(a.calls.map((x) => `${x.method} ${x.path}`)).toEqual([
      "POST /v2/vms/vm-1/terminate",
      "DELETE /v1/public_ips/ip-1",
      "DELETE /v1/storages/disk-1",
    ]);
    expect(c.getLiveTrackedVms()).toHaveLength(0);
  });

  it("retries only the remaining steps after a partial delete, and refuses unknown VMs", async () => {
    const a = api();
    const c = client(a);
    await c.createSandbox();
    a.apiJson.mockImplementation(async (p: string, init: RequestInit = {}) => {
      a.calls.push({ method: init.method || "GET", path: p });
      if (p.startsWith("/v1/storages")) throw Object.assign(new Error("boom"), { status: 500 });
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

  it("parses configurations, quotes and balances leniently and fails closed", () => {
    expect(pickCheapestSharedConfiguration(["cpu-shared-2-ram-4gb", "cpu-shared-1-ram-2gb"])?.slug).toBe("cpu-shared-1-ram-2gb");
    expect(pickCheapestSharedConfiguration([{ slug: "cpu-2-ram-4gb" }])).toBeNull();
    expect(parseQuoteCents({ total: "4.20" })).toBe(420);
    expect(parseQuoteCents({ items: [{ cost: 1 }, { cost: 0.5 }] })).toBe(150);
    expect(parseQuoteCents({ nothing: true })).toBeNull();
    expect(parseBalanceCents({ balances: [{ currency: "USD", amount: "-2.5" }] })).toBe(-250);
    expect(parseBalanceCents({})).toBeNull();
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

  function runtime(balanceCents: number, burnPerHour: number | null) {
    const topUp = vi.fn();
    const precheck = vi.fn((_amount: number) => null as string | null);
    return {
      rt: {
        vms: {
          getBalanceCents: async () => balanceCents,
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
