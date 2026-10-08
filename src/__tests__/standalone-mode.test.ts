/**
 * Standalone (no Conway) Mode Tests
 *
 * Survival tiers from on-chain USDC minus reserve, provider client
 * behaviour, tool filtering, policy denials, configurable model routing,
 * heartbeat gating, config defaults and state-repo secret hygiene.
 * Everything is mocked: no network, no funded wallet.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  createStandaloneClient,
  spendableCents,
  ProviderUnsupportedError,
} from "../conway/standalone-client.js";
import {
  filterToolsForProvider,
  resolveTreasuryPolicy,
  resolveBlockRunConfig,
  STANDALONE_DISABLED_TOOLS,
} from "../conway/provider.js";
import { getSurvivalTier } from "../conway/credits.js";
import { createBuiltinTools, executeTool } from "../agent/tools.js";
import { PolicyEngine } from "../agent/policy-engine.js";
import { createDefaultRules } from "../agent/policy-rules/index.js";
import { SpendTracker } from "../agent/spend-tracker.js";
import { buildRoutingMatrix, modelForTier, registerMappedModels } from "../inference/model-map.js";
import { ModelRegistry } from "../inference/registry.js";
import { InferenceRouter } from "../inference/router.js";
import { InferenceBudgetTracker } from "../inference/budget.js";
import { createInferenceClient } from "../conway/inference.js";
import { BUILTIN_TASKS } from "../heartbeat/tasks.js";
import { loadHeartbeatConfig } from "../heartbeat/config.js";
import { buildStateGitignore, ensureSensitiveFilesIgnored } from "../git/state-versioning.js";
import { createConfig } from "../config.js";
import {
  DEFAULT_MODEL_STRATEGY_CONFIG,
  STANDALONE_TREASURY_POLICY,
  type AutomatonDatabase,
  type ModelTierMap,
  type TickContext,
} from "../types.js";
import { createTestConfig, createTestDb, createTestIdentity, MockConwayClient, MockInferenceClient } from "./mocks.js";

const standaloneConfig = (overrides = {}) =>
  createTestConfig({
    providerMode: "standalone",
    sandboxId: "",
    maxChildren: 0,
    treasuryPolicy: { ...STANDALONE_TREASURY_POLICY },
    ...overrides,
  });

// ─── Survival tiers ────────────────────────────────────────────

describe("survival tiers from on-chain USDC minus reserve", () => {
  it("computes the spendable balance", () => {
    expect(spendableCents(10, 100)).toBe(900);
    expect(spendableCents(1.0, 100)).toBe(0);
    expect(spendableCents(0.5, 100)).toBe(0); // never negative
    expect(spendableCents(1.239, 0)).toBe(123); // floors fractional cents
  });

  it("maps balances to tiers (reserve $1)", () => {
    const tier = (usdc: number) => getSurvivalTier(spendableCents(usdc, 100));
    expect(tier(20)).toBe("high"); // $19 spendable
    expect(tier(2)).toBe("normal"); // $1.00 spendable
    expect(tier(1.3)).toBe("low_compute"); // $0.30
    expect(tier(1.05)).toBe("critical"); // $0.05
    expect(tier(0.4)).toBe("critical"); // below reserve → 0, still alive
  });

  it("standalone client reports USDC − reserve as the credits balance", async () => {
    const readUsdcBalance = vi.fn(async () => 3.5);
    const client = createStandaloneClient({
      walletAddress: "0x1234567890abcdef1234567890abcdef12345678",
      reserveCents: 100,
      readUsdcBalance,
    });
    expect(await client.getCreditsBalance()).toBe(250);
    expect(readUsdcBalance).toHaveBeenCalledWith("0x1234567890abcdef1234567890abcdef12345678");
  });

  it("propagates balance read failures (callers fall back to cache, not $0)", async () => {
    const client = createStandaloneClient({
      walletAddress: "0x1234567890abcdef1234567890abcdef12345678",
      reserveCents: 100,
      readUsdcBalance: async () => {
        throw new Error("rpc down");
      },
    });
    await expect(client.getCreditsBalance()).rejects.toThrow("rpc down");
  });
});

// ─── Provider client ───────────────────────────────────────────

describe("standalone provider client", () => {
  const client = createStandaloneClient({
    walletAddress: "0x1234567890abcdef1234567890abcdef12345678",
    reserveCents: 100,
    readUsdcBalance: async () => 0,
    blockrunApiUrl: "https://blockrun.ai/api",
    fetchImpl: (async () =>
      new Response(JSON.stringify({ data: [{ id: "deepseek-chat" }] }), { status: 200 })) as any,
  });

  it("executes commands on the host", async () => {
    const result = await client.exec("echo standalone-ok");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("standalone-ok");
  });

  it("refuses Conway-only operations", async () => {
    await expect(client.createSandbox({})).rejects.toBeInstanceOf(ProviderUnsupportedError);
    await expect(client.exposePort(8080)).rejects.toBeInstanceOf(ProviderUnsupportedError);
    await expect(client.transferCredits("0xabc", 100)).rejects.toBeInstanceOf(ProviderUnsupportedError);
    await expect(client.registerDomain("x.com")).rejects.toBeInstanceOf(ProviderUnsupportedError);
    await expect(
      client.registerAutomaton({} as any),
    ).rejects.toBeInstanceOf(ProviderUnsupportedError);
  });

  it("lists BlockRun models", async () => {
    const models = await client.listModels();
    expect(models.map((m) => m.id)).toEqual(["deepseek-chat"]);
  });
});

// ─── Tools & policy ────────────────────────────────────────────

describe("tool availability in standalone mode", () => {
  it("does not offer server, port, domain, credit or replication tools", () => {
    const tools = filterToolsForProvider(createBuiltinTools(""), standaloneConfig());
    const names = new Set(tools.map((t) => t.name));
    for (const name of [
      "expose_port", "remove_port", "create_sandbox", "list_sandboxes",
      "search_domains", "register_domain", "manage_dns",
      "transfer_credits", "topup_credits", "spawn_child", "fund_child",
    ]) {
      expect(names.has(name)).toBe(false);
    }
    // Host execution and wallet tools remain
    expect(names.has("exec")).toBe(true);
    expect(names.has("check_usdc_balance")).toBe(true);
    expect(names.has("x402_fetch")).toBe(true);
  });

  it("keeps every tool in Conway mode", () => {
    const all = createBuiltinTools("sbx");
    expect(filterToolsForProvider(all, createTestConfig())).toHaveLength(all.length);
  });

  it("disabled-tool list only names real tools", () => {
    const names = new Set(createBuiltinTools("").map((t) => t.name));
    for (const name of STANDALONE_DISABLED_TOOLS) expect(names.has(name)).toBe(true);
  });
});

describe("policy: spawn / fund / transfer refused", () => {
  let db: AutomatonDatabase;
  beforeEach(() => {
    db = createTestDb();
  });
  afterEach(() => db.close());

  const run = async (toolName: string, args: Record<string, unknown>, config = standaloneConfig()) => {
    const engine = new PolicyEngine(db.raw, createDefaultRules(resolveTreasuryPolicy(config)));
    const conway = new MockConwayClient();
    const transferSpy = vi.spyOn(conway, "transferCredits");
    const result = await executeTool(
      toolName,
      args,
      createBuiltinTools(""),
      {
        identity: createTestIdentity(),
        config,
        db,
        conway,
        inference: new MockInferenceClient(),
      },
      engine,
      { inputSource: "agent", turnToolCallCount: 0, sessionSpend: new SpendTracker(db.raw) },
    );
    return { result, transferSpy };
  };

  it.each([
    ["transfer_credits", { to_address: "0x1111111111111111111111111111111111111111", amount_cents: 10 }],
    ["fund_child", { child_id: "c1", amount_cents: 10 }],
    ["spawn_child", { name: "kid" }],
  ])("denies %s in standalone mode", async (tool, args) => {
    const { result, transferSpy } = await run(tool, args);
    expect(result.error).toMatch(/Policy denied/);
    expect(transferSpy).not.toHaveBeenCalled();
  });

  it("denies spawn_child whenever maxChildren is 0 (default)", async () => {
    const { result } = await run("spawn_child", { name: "kid" }, createTestConfig({ maxChildren: 0 }));
    expect(result.error).toMatch(/REPLICATION_DISABLED/);
  });

  it("transfer_credits honours the reserve in Conway mode (upstream #396)", async () => {
    // MockConwayClient balance is 10_000 cents.
    const withReserve = (minimumReserveCents: number) =>
      createTestConfig({
        treasuryPolicy: { ...resolveTreasuryPolicy(createTestConfig()), minimumReserveCents },
      });
    const args = { to_address: "0x1111111111111111111111111111111111111111", amount_cents: 100 };

    const allowed = await run("transfer_credits", args, withReserve(9_000));
    expect(allowed.result.result).not.toMatch(/minimum reserve/);
    expect(allowed.transferSpy).toHaveBeenCalledTimes(1);

    const blocked = await run("transfer_credits", args, withReserve(9_950));
    expect(blocked.result.result).toMatch(/minimum reserve/);
    expect(blocked.transferSpy).not.toHaveBeenCalled();
  });
});

// ─── Model routing ─────────────────────────────────────────────

describe("configurable model map", () => {
  const map: ModelTierMap = { normal: "big-model", lowCompute: "deepseek-chat", critical: "deepseek-chat" };

  it("maps tiers to models", () => {
    expect(modelForTier(map, "high")).toBe("big-model");
    expect(modelForTier(map, "normal")).toBe("big-model");
    expect(modelForTier(map, "low_compute")).toBe("deepseek-chat");
    expect(modelForTier(map, "critical")).toBe("deepseek-chat");
    expect(modelForTier(map, "dead")).toBeNull();
  });

  it("builds a routing matrix without hard-coded model names", () => {
    const matrix = buildRoutingMatrix(map);
    const all = JSON.stringify(matrix);
    expect(all).not.toContain("gpt-5");
    expect(matrix.normal.agent_turn.candidates[0]).toBe("big-model");
    expect(matrix.low_compute.agent_turn.candidates).toEqual(["deepseek-chat"]);
    expect(matrix.critical.agent_turn.candidates).toEqual(["deepseek-chat"]);
    expect(matrix.dead.agent_turn.candidates).toEqual([]);
  });

  it("router selects the configured models per tier", () => {
    const db = createTestDb();
    const registry = new ModelRegistry(db.raw);
    registry.initialize();
    registerMappedModels(registry, map, "blockrun");
    const router = new InferenceRouter(
      db.raw,
      registry,
      new InferenceBudgetTracker(db.raw, DEFAULT_MODEL_STRATEGY_CONFIG),
      buildRoutingMatrix(map),
    );
    expect(router.selectModel("normal", "agent_turn")?.modelId).toBe("big-model");
    expect(router.selectModel("low_compute", "agent_turn")?.modelId).toBe("deepseek-chat");
    expect(router.selectModel("critical", "agent_turn")?.provider).toBe("blockrun");

    // Mapped models survive a registry re-initialization (restart).
    registry.initialize();
    expect(registry.get("big-model")?.enabled).toBe(true);
    db.close();
  });

  it("defaults to deepseek-chat and honours BLOCKRUN_API_URL", () => {
    const prev = process.env.BLOCKRUN_API_URL;
    process.env.BLOCKRUN_API_URL = "https://example.test/api/";
    try {
      const cfg = resolveBlockRunConfig({});
      expect(cfg.apiUrl).toBe("https://example.test/api");
      expect(cfg.models.lowCompute).toBe("deepseek-chat");
    } finally {
      if (prev === undefined) delete process.env.BLOCKRUN_API_URL;
      else process.env.BLOCKRUN_API_URL = prev;
    }
  });
});

describe("inference client BlockRun backend", () => {
  it("sends OpenAI-compatible requests through the paying fetch", async () => {
    const paidFetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          id: "c1",
          model: "deepseek-chat",
          choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
        }),
        { status: 200 },
      ),
    );
    const client = createInferenceClient({
      apiUrl: "https://api.conway.tech",
      apiKey: "",
      defaultModel: "deepseek-chat",
      maxTokens: 512,
      blockrun: { apiUrl: "https://blockrun.ai/api", fetch: paidFetch as any },
    });
    const resp = await client.chat([{ role: "user", content: "hello" }]);
    expect(resp.message.content).toBe("hi");
    const [url, init] = paidFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://blockrun.ai/api/v1/chat/completions");
    expect(JSON.parse(init.body as string).model).toBe("deepseek-chat");
  });
});

// ─── Heartbeat ─────────────────────────────────────────────────

describe("heartbeat in standalone mode", () => {
  let db: AutomatonDatabase;
  beforeEach(() => {
    db = createTestDb();
  });
  afterEach(() => db.close());

  const tick = (overrides: Partial<TickContext> = {}): TickContext => ({
    tickId: "t",
    startedAt: new Date(),
    creditBalance: 0,
    usdcBalance: 50,
    survivalTier: "critical",
    lowComputeMultiplier: 4,
    config: { entries: [], defaultIntervalMs: 60_000, lowComputeMultiplier: 4 },
    db: db.raw,
    ...overrides,
  });

  it("never buys Conway credit packs", async () => {
    const result = await BUILTIN_TASKS.check_usdc_balance(tick(), {
      identity: createTestIdentity(),
      config: standaloneConfig(),
      db,
      conway: new MockConwayClient(),
    });
    expect(result.shouldWake).toBe(false);
    expect(db.getKV("last_auto_topup_attempt")).toBeUndefined();
  });

  it("does not check upstream unless autoUpdate is enabled", async () => {
    const result = await BUILTIN_TASKS.check_for_updates(tick(), {
      identity: createTestIdentity(),
      config: createTestConfig(),
      db,
      conway: new MockConwayClient(),
    });
    expect(result.shouldWake).toBe(false);
    expect(db.getKV("upstream_status")).toBeUndefined();
  });

  it("ships check_for_updates disabled by default", () => {
    const cfg = loadHeartbeatConfig(path.join(os.tmpdir(), "does-not-exist-heartbeat.yml"));
    expect(cfg.entries.find((e) => e.name === "check_for_updates")?.enabled).toBe(false);
  });

  it("distress hint asks for USDC on Base", async () => {
    await BUILTIN_TASKS.heartbeat_ping(tick(), {
      identity: createTestIdentity(),
      config: standaloneConfig(),
      db,
      conway: new MockConwayClient(),
    });
    expect(db.getKV("last_distress")).toMatch(/USDC on Base/);
  });
});

// ─── Config defaults ───────────────────────────────────────────

describe("standalone configuration defaults", () => {
  it("createConfig applies the mandatory safety defaults", () => {
    const cfg = createConfig({
      name: "a",
      genesisPrompt: "g",
      creatorAddress: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
      registeredWithConway: false,
      sandboxId: "",
      walletAddress: "0x1234567890abcdef1234567890abcdef12345678",
      apiKey: "",
      providerMode: "standalone",
    });
    expect(cfg.maxChildren).toBe(0);
    expect(cfg.autoUpdate).toBe(false);
    expect(cfg.socialRelayUrl).toBeUndefined();
    expect(cfg.inferenceModel).toBe("deepseek-chat");
    expect(cfg.treasuryPolicy?.maxInferenceDailyCents).toBe(200);
    expect(cfg.treasuryPolicy?.maxX402PaymentCents).toBe(10);
    expect(cfg.treasuryPolicy?.maxSingleTransferCents).toBe(500);
    expect(cfg.treasuryPolicy?.x402AllowedDomains).toEqual(["blockrun.ai", "api.fluence.dev"]);
  });

  it("replication is off by default in Conway mode too", () => {
    const cfg = createConfig({
      name: "a",
      genesisPrompt: "g",
      creatorAddress: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
      registeredWithConway: true,
      sandboxId: "",
      walletAddress: "0x1234567890abcdef1234567890abcdef12345678",
      apiKey: "k",
    });
    expect(cfg.maxChildren).toBe(0);
    expect(cfg.providerMode).toBe("conway");
  });

  it("loadConfig: BlockRun map wins over persisted model names, mandatory defaults applied", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "automaton-home-"));
    fs.mkdirSync(path.join(home, ".automaton"));
    fs.writeFileSync(
      path.join(home, ".automaton", "automaton.json"),
      JSON.stringify({
        name: "a",
        providerMode: "standalone",
        maxChildren: 5,
        inferenceModel: "gpt-5.2",
        modelStrategy: { inferenceModel: "gpt-5.2", lowComputeModel: "gpt-5-mini" },
        blockrun: { models: { normal: "big-model" } },
      }),
    );
    const prevHome = process.env.HOME;
    process.env.HOME = home;
    vi.resetModules();
    try {
      const { loadConfig } = await import("../config.js");
      const cfg = loadConfig()!;
      expect(cfg.providerMode).toBe("standalone");
      expect(cfg.maxChildren).toBe(0);
      expect(cfg.autoUpdate).toBe(false);
      expect(cfg.socialRelayUrl).toBeUndefined();
      expect(cfg.conwayApiKey).toBe("");
      expect(cfg.inferenceModel).toBe("big-model");
      expect(cfg.modelStrategy?.lowComputeModel).toBe("deepseek-chat");
      expect(cfg.treasuryPolicy?.maxInferenceDailyCents).toBe(200);
      expect(cfg.treasuryPolicy?.x402AllowedDomains).toEqual(["blockrun.ai", "api.fluence.dev"]);
    } finally {
      process.env.HOME = prevHome;
      vi.resetModules();
    }
  });

  it("resolveTreasuryPolicy merges overrides on top of mode defaults", () => {
    const p = resolveTreasuryPolicy({ providerMode: "standalone", treasuryPolicy: { maxInferenceDailyCents: 50 } as any });
    expect(p.maxInferenceDailyCents).toBe(50);
    expect(p.minimumReserveCents).toBe(STANDALONE_TREASURY_POLICY.minimumReserveCents);
  });
});

// ─── Secrets ───────────────────────────────────────────────────

describe("state repo never commits secrets", () => {
  it("ignores the wallet, API-key config and env files", () => {
    const gitignore = buildStateGitignore();
    for (const p of ["wallet.json", "automaton.json", "config.json", ".env", "*.key", "state.db"]) {
      expect(gitignore.split("\n")).toContain(p);
    }
  });

  it("upgrades an old .gitignore and untracks already-committed secrets", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "state-repo-"));
    fs.writeFileSync(path.join(dir, ".gitignore"), "wallet.json\nconfig.json\n");
    const conway = new MockConwayClient();
    const writes: Record<string, string> = {};
    conway.readFile = async (p: string) => fs.readFileSync(p, "utf-8");
    conway.writeFile = async (p: string, c: string) => {
      writes[p] = c;
    };
    const execSpy = vi.spyOn(conway, "exec");

    await ensureSensitiveFilesIgnored(conway, dir);

    const updated = writes[`${dir}/.gitignore`];
    expect(updated).toContain("automaton.json");
    expect(updated.startsWith("wallet.json\nconfig.json\n")).toBe(true);
    const cmd = execSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(cmd).toContain("git rm -r --cached --ignore-unmatch");
    expect(cmd).toContain("'automaton.json'");
  });
});
