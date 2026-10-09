/**
 * Fluence CPU Cloud VM client (standalone mode).
 *
 * Scope: ONE small shared-CPU VM that hosts only the agent's public x402
 * service. No wallet and no agent runtime ever go to the VM.
 *
 * - create: cheapest `cpu-shared-*` configuration (GET /v1/clusters/resources
 *   + GET /v1/prices/vm), a 25 GB non-replicated NVME boot disk from an
 *   Ubuntu default image (GET /v1/storages/default_images), a V4 public IP and
 *   the agent's SSH key (POST /v1/ssh_keys). Before creating, the 30-day
 *   quote (POST /v1/prices/cost, VM + disk + IP) must fit
 *   maxComputeMonthlyCents, and the live VM count must stay ≤ maxComputeVms (1).
 * - delete: terminate the VM, wait for `terminated`, then delete its public
 *   IP and its boot disk, so nothing keeps billing. Every resource is tracked
 *   in the `fluence_vms` table and retried on the next delete if a step
 *   failed. Failed VMs are cleaned up the same way.
 *
 * Shapes follow the Fluence API exactly; every guard fails closed when a
 * value cannot be read.
 */

import { createHash } from "crypto";
import type Database from "better-sqlite3";
import type { SandboxInfo, TreasuryPolicy } from "../types.js";
import { computeCaps } from "../agent/spend-tracker.js";
import type { FluenceAuth } from "./auth.js";
import type { FluenceSsh } from "./ssh.js";
import { isValidHost } from "./ssh.js";
import { DEFAULT_FLUENCE_SSH_USER, SSH_USER_PATTERN, type ResolvedFluenceConfig } from "./config.js";
import { createLogger } from "../observability/logger.js";

const logger = createLogger("fluence.client");

export const QUOTE_HOURS = 30 * 24;
export const QUOTE_SECS = QUOTE_HOURS * 3600;
/** Name of the agent's SSH key on Fluence (lowercase letters, digits, hyphens, ≤ 25). */
export const FLUENCE_SSH_KEY_LABEL = "automaton-fluence";
const MAX_NAME_LENGTH = 25;
/** Longest suffix added to the VM name ("-boot"), so every resource name stays ≤ 25. */
const VM_NAME_LENGTH = MAX_NAME_LENGTH - "-boot".length;

export interface FluenceVmRow {
  id: string;
  name: string;
  status: string;
  public_ip: string | null;
  public_ip_id: string | null;
  storage_id: string | null;
  ssh_key_id: string | null;
  ssh_user: string | null;
  configuration: string | null;
  monthly_cost_cents: number | null;
  vm_terminated: number;
  ip_deleted: number;
  storage_deleted: number;
  created_at: string;
  terminated_at: string | null;
}

export interface FluenceConfiguration {
  /** Configuration id (`configurationId` / `vmConfigurationId`). */
  id: string;
  slug: string;
  clusterId: string;
  vcpu: number;
  ramGb: number;
  pricePerHourUsd: number;
}

export interface FluenceImage {
  downloadUrl: string;
  username?: string;
  name: string;
}

export interface FluenceBalance {
  cents: number;
  /** `usageDaysLeft` from Fluence (null when it does not say). */
  usageDaysLeft: number | null;
}

export interface FluenceVm {
  id: string;
  status: string;
  name?: string;
  /** Plain IPv4 from `expanded.publicIp.address` (validated). */
  address?: string;
  publicIpId?: string;
  bootDiskId?: string;
  configurationSlug?: string;
  createdAt?: string;
}

export class FluenceGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FluenceGuardError";
  }
}

/** VM statuses that no longer count as a live VM. */
const NOT_LIVE_STATUSES = new Set(["terminated", "terminating", "failed"]);
/** VM statuses after which its public IP and boot disk can be deleted. */
const RELEASABLE_STATUSES = new Set(["terminated", "failed"]);

function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

function toCents(usd: number): number {
  return Math.round(usd * 100 * 100) / 100;
}

/** Lowercase letters, digits and hyphens only, ≤ `max` chars (Fluence resource names). */
export function sanitizeFluenceName(raw: string | undefined, max = VM_NAME_LENGTH, fallback = "automaton-service"): string {
  const name = (raw ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .slice(0, max)
    .replace(/-+$/, "");
  return name || fallback.slice(0, max);
}

/** "cpu-shared-2vcpu-2gb" → vCPU / RAM. */
function parseSlug(slug: string): { vcpu?: number; ramGb?: number } {
  const cpu = /(\d+)vcpu/i.exec(slug);
  const ram = /(\d+)gb/i.exec(slug);
  return { vcpu: cpu ? Number(cpu[1]) : undefined, ramGb: ram ? Number(ram[1]) : undefined };
}

/**
 * Candidate (cluster, configuration) pairs from GET /v1/clusters/resources:
 * `cpu-shared-*` configurations in clusters with a free V4 public IP and
 * enough non-replicated NVME storage for the boot disk.
 */
export function sharedCandidates(
  raw: any,
  diskGb: number,
): { clusterId: string; id: string; slug: string; vcpu: number; ramGb: number }[] {
  const resources = raw?.resources;
  if (!resources || typeof resources !== "object" || Array.isArray(resources)) return [];
  const out: { clusterId: string; id: string; slug: string; vcpu: number; ramGb: number }[] = [];
  for (const [clusterId, cluster] of Object.entries<any>(resources)) {
    if (!((num(cluster?.availablePublicIps?.V4) ?? 0) > 0)) continue;
    const storage = cluster?.availableStorage;
    const families = storage && typeof storage === "object" ? Object.values<any>(storage) : [];
    const hasNvme = families.some(
      (list) =>
        Array.isArray(list) &&
        list.some((s: any) => s?.storageType === "NVME" && s?.replicated === false && (num(s?.volumeGb) ?? 0) >= diskGb),
    );
    if (!hasNvme) continue;
    for (const c of Array.isArray(cluster?.availableConfigurations) ? cluster.availableConfigurations : []) {
      const id = str(c?.id);
      const slug = str(c?.slug);
      if (!id || !slug || !slug.startsWith("cpu-shared-") || c?.dedicated === true) continue;
      const fromSlug = parseSlug(slug);
      out.push({
        clusterId,
        id,
        slug,
        vcpu: num(c?.vcpu) ?? fromSlug.vcpu ?? Number.MAX_SAFE_INTEGER,
        ramGb: num(c?.ramGb) ?? fromSlug.ramGb ?? Number.MAX_SAFE_INTEGER,
      });
    }
  }
  return out;
}

/** Hourly price (USD) of a configuration from GET /v1/prices/vm, or undefined. */
export function vmHourlyPrice(raw: any, clusterId: string, configurationId: string): number | undefined {
  const items = Array.isArray(raw?.items) ? raw.items : [];
  const item = items.find(
    (i: any) => i?.vmTypeId?.vmConfigurationId === configurationId && i?.vmTypeId?.clusterId === clusterId,
  );
  const price = num(item?.priceInfo?.pricePerHourPerQty);
  return price !== undefined && price >= 0 ? price : undefined;
}

/** Cheapest priced pair, then fewest vCPU, then least RAM. */
export function pickCheapest(configs: FluenceConfiguration[]): FluenceConfiguration | null {
  const sorted = [...configs].sort(
    (a, b) =>
      a.pricePerHourUsd - b.pricePerHourUsd ||
      a.vcpu - b.vcpu ||
      a.ramGb - b.ramGb ||
      a.slug.localeCompare(b.slug) ||
      a.clusterId.localeCompare(b.clusterId),
  );
  return sorted[0] ?? null;
}

/** `totalCost` (USD string) of POST /v1/prices/cost in cents, or null. */
export function parseQuoteCents(raw: any): number | null {
  if (typeof raw?.totalCost !== "string") return null;
  const n = num(raw.totalCost);
  return n !== undefined && n >= 0 ? toCents(n) : null;
}

/**
 * GET /v2/users/balances: an array of `{ balance: string, usageDaysLeft, ... }`.
 * Balance = sum of the entries (negative = debt). Null when unreadable.
 */
export function parseBalance(raw: any): FluenceBalance | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  let usd = 0;
  let days: number | null = null;
  for (const entry of raw) {
    if (typeof entry?.balance !== "string") return null;
    const n = num(entry.balance);
    if (n === undefined) return null;
    usd += n;
    const d = entry.usageDaysLeft;
    if (typeof d === "number" && Number.isFinite(d)) days = days === null ? d : Math.min(days, d);
  }
  return { cents: toCents(usd), usageDaysLeft: days };
}

/** Preferred image: Ubuntu 24.04, then 22.04, then any Ubuntu. */
export function pickUbuntuImage(raw: any): FluenceImage | null {
  const items: any[] = Array.isArray(raw?.items) ? raw.items : [];
  const usable = items
    .map((i) => ({
      downloadUrl: str(i?.downloadUrl),
      username: str(i?.username),
      name: str(i?.name) ?? str(i?.slug) ?? "",
      text: `${i?.distribution ?? ""} ${i?.name ?? ""} ${i?.slug ?? ""}`.toLowerCase(),
    }))
    .filter((i) => i.downloadUrl && /^https:\/\//.test(i.downloadUrl) && i.text.includes("ubuntu"));
  const pick =
    usable.find((i) => i.text.includes("24.04")) ?? usable.find((i) => i.text.includes("22.04")) ?? usable[0];
  return pick ? { downloadUrl: pick.downloadUrl!, username: pick.username, name: pick.name } : null;
}

/** UserVmDto → FluenceVm (`bootDisk` / `publicIp` are id strings, the address is in `expanded`). */
export function mapVm(raw: any): FluenceVm | null {
  const id = str(raw?.id);
  const status = str(raw?.status);
  if (!id || !status) return null;
  const address = str(raw?.expanded?.publicIp?.address);
  return {
    id,
    status,
    name: str(raw?.name),
    address: address && isValidHost(address) ? address : undefined,
    publicIpId: str(raw?.publicIp),
    bootDiskId: str(raw?.bootDisk),
    configurationSlug: str(raw?.configurationSlug),
    createdAt: str(raw?.createdAt),
  };
}

/** "SHA256:<base64>" fingerprint of an OpenSSH public key line. */
export function sshFingerprint(publicKey: string): string | null {
  const blob = publicKey.trim().split(/\s+/)[1];
  if (!blob) return null;
  const digest = createHash("sha256").update(Buffer.from(blob, "base64")).digest("base64");
  return `SHA256:${digest.replace(/=+$/, "")}`;
}

function sameKey(a: string, b: string): boolean {
  const parts = (k: string) => k.trim().split(/\s+/).slice(0, 2).join(" ");
  return parts(a) === parts(b);
}

export interface FluenceVmClientOptions {
  auth: Pick<FluenceAuth, "apiJson">;
  db: Database.Database;
  policy: TreasuryPolicy;
  config: ResolvedFluenceConfig;
  ssh: Pick<FluenceSsh, "ensureKey" | "forgetHost">;
  /** Delay between status polls (default 5 s). */
  pollIntervalMs?: number;
  /** Polls while waiting for `launched` after creation (default 24 ≈ 2 min). */
  launchPollAttempts?: number;
  /** Polls while waiting for `terminated` before deleting IP / disk (default 6). */
  terminatePollAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
}

export class FluenceVmClient {
  private readonly pollIntervalMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: FluenceVmClientOptions) {
    ensureFluenceTable(options.db);
    this.pollIntervalMs = options.pollIntervalMs ?? 5000;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private get api() {
    return this.options.auth;
  }

  // ─── DB tracking ────────────────────────────────────────────

  getTrackedVm(id: string): FluenceVmRow | undefined {
    return this.options.db.prepare("SELECT * FROM fluence_vms WHERE id = ?").get(id) as FluenceVmRow | undefined;
  }

  /** VMs (or their IP / disk) that may still be billing. */
  getLiveTrackedVms(): FluenceVmRow[] {
    return this.options.db
      .prepare("SELECT * FROM fluence_vms WHERE vm_terminated = 0 OR ip_deleted = 0 OR storage_deleted = 0 ORDER BY created_at")
      .all() as FluenceVmRow[];
  }

  /** Sum of the 30-day quotes of tracked live VMs, per hour, in cents. */
  getHourlyBurnCents(): number | null {
    const live = this.getLiveTrackedVms();
    if (live.length === 0) return 0;
    if (live.some((v) => v.monthly_cost_cents === null)) return null;
    return live.reduce((s, v) => s + (v.monthly_cost_cents ?? 0), 0) / QUOTE_HOURS;
  }

  private refreshRow(v: FluenceVm): void {
    this.options.db
      .prepare(
        "UPDATE fluence_vms SET status = ?, public_ip = COALESCE(?, public_ip), public_ip_id = COALESCE(public_ip_id, ?), storage_id = COALESCE(storage_id, ?) WHERE id = ?",
      )
      .run(v.status, v.address ?? null, v.publicIpId ?? null, v.bootDiskId ?? null, v.id);
  }

  // ─── API ────────────────────────────────────────────────────

  /** GET /v2/vms?expand=publicIp → { items, pagination }. */
  async listVms(): Promise<FluenceVm[]> {
    const body = await this.api.apiJson("/v2/vms?expand=publicIp");
    if (!Array.isArray(body?.items)) throw new Error("Unreadable Fluence VM list");
    const vms = body.items.map(mapVm).filter((v: FluenceVm | null): v is FluenceVm => v !== null);
    for (const v of vms) this.refreshRow(v);
    return vms;
  }

  /** GET /v2/vms/{id}?expand=publicIp, or null on 404. */
  async getVm(id: string): Promise<FluenceVm | null> {
    try {
      const vm = mapVm(await this.api.apiJson(`/v2/vms/${encodeURIComponent(id)}?expand=publicIp`));
      if (!vm) throw new Error("Unreadable Fluence VM");
      this.refreshRow(vm);
      return vm;
    } catch (err: any) {
      if (err?.status === 404) return null;
      throw err;
    }
  }

  async listSandboxes(): Promise<SandboxInfo[]> {
    const vms = await this.listVms();
    return vms.map((v) => {
      const size = parseSlug(v.configurationSlug ?? "");
      return {
        id: v.id,
        status: v.status,
        region: "fluence",
        vcpu: size.vcpu ?? 0,
        memoryMb: (size.ramGb ?? 0) * 1024,
        diskGb: this.options.config.diskGb,
        terminalUrl: v.address ? `ssh ${this.sshUserFor(this.getTrackedVm(v.id))}@${v.address}` : undefined,
        createdAt: v.createdAt ?? "",
      };
    });
  }

  async countLiveVms(): Promise<number> {
    const remote = (await this.listVms()).filter((v) => !NOT_LIVE_STATUSES.has(v.status)).length;
    const tracked = this.getLiveTrackedVms().filter((v) => v.vm_terminated === 0).length;
    return Math.max(remote, tracked);
  }

  /** Balance (API key; Bearer session if the key answers 403). */
  async getBalance(): Promise<FluenceBalance> {
    const balance = parseBalance(await this.api.apiJson("/v2/users/balances", {}, { sessionFallbackOn403: true }));
    if (!balance) throw new Error("Unreadable Fluence balance response");
    return balance;
  }

  async getBalanceCents(): Promise<number> {
    return (await this.getBalance()).cents;
  }

  async pickConfiguration(): Promise<FluenceConfiguration> {
    const candidates = sharedCandidates(await this.api.apiJson("/v1/clusters/resources"), this.options.config.diskGb);
    const priced: FluenceConfiguration[] = [];
    for (const clusterId of [...new Set(candidates.map((c) => c.clusterId))]) {
      const prices = await this.api.apiJson(`/v1/prices/vm?clusterId=${encodeURIComponent(clusterId)}`);
      for (const c of candidates.filter((x) => x.clusterId === clusterId)) {
        const price = vmHourlyPrice(prices, clusterId, c.id);
        if (price !== undefined) priced.push({ ...c, pricePerHourUsd: price });
      }
    }
    const config = pickCheapest(priced);
    if (!config) throw new FluenceGuardError("No priced cpu-shared-* configuration with a public IPv4 and NVME storage is available on Fluence right now.");
    return config;
  }

  async pickOsImage(): Promise<FluenceImage> {
    if (this.options.config.osImage) return { downloadUrl: this.options.config.osImage, name: "custom" };
    const image = pickUbuntuImage(await this.api.apiJson("/v1/storages/default_images"));
    if (!image) throw new FluenceGuardError("No default Ubuntu image found; set fluence.osImage.");
    return image;
  }

  /** 30-day cost (VM + boot disk + public IP) in cents. */
  async quoteMonthlyCents(configuration: Pick<FluenceConfiguration, "id" | "clusterId">): Promise<number> {
    const clusterId = configuration.clusterId;
    const body = await this.api.apiJson("/v1/prices/cost", {
      method: "POST",
      body: JSON.stringify({
        secs: QUOTE_SECS,
        resources: [
          { vm: { resource_id: { vmConfigurationId: configuration.id, clusterId } } },
          {
            storage: {
              resource_id: { storageType: "NVME", replicated: false, clusterId },
              volume_gb: this.options.config.diskGb,
            },
          },
          { publicIp: { resource_id: { addressType: "V4", clusterId } } },
        ],
      }),
    });
    const cents = parseQuoteCents(body);
    if (cents === null) throw new FluenceGuardError("Unreadable Fluence price quote; refusing to create a VM.");
    return cents;
  }

  /** Clean up tracked VMs that Fluence reports as `failed` (they still hold an IP and a disk). */
  private async cleanupFailedVms(): Promise<void> {
    for (const row of this.getLiveTrackedVms()) {
      if (row.vm_terminated === 0 && row.status === "failed") {
        logger.warn(`Fluence VM ${row.id} failed; cleaning it up`);
        await this.deleteSandbox(row.id);
      }
    }
  }

  /** Guards only (no creation): returns the plan or throws FluenceGuardError. */
  async planCreate(): Promise<{ configuration: FluenceConfiguration; monthlyCents: number }> {
    const caps = computeCaps(this.options.policy);
    if (!caps) {
      throw new FluenceGuardError(
        "Compute is disabled: treasuryPolicy.maxComputeTopupCents and maxComputeMonthlyCents are not set.",
      );
    }
    const max = this.options.config.maxComputeVms;
    await this.listVms();
    await this.cleanupFailedVms();
    const live = await this.countLiveVms();
    if (live + 1 > max) {
      throw new FluenceGuardError(`A Fluence VM already exists (${live} live, limit ${max}). Delete it first.`);
    }
    const configuration = await this.pickConfiguration();
    const monthlyCents = await this.quoteMonthlyCents(configuration);
    if (monthlyCents > caps.monthlyCents) {
      throw new FluenceGuardError(
        `The 30-day cost of ${configuration.slug} (VM + disk + IP) is $${(monthlyCents / 100).toFixed(2)}, above maxComputeMonthlyCents ($${(caps.monthlyCents / 100).toFixed(2)}).`,
      );
    }
    return { configuration, monthlyCents };
  }

  /** Register the agent's SSH key (409 = already registered: reuse its id). */
  async ensureSshKeyId(publicKey: string): Promise<string> {
    try {
      const created = await this.api.apiJson("/v1/ssh_keys", {
        method: "POST",
        body: JSON.stringify({ name: FLUENCE_SSH_KEY_LABEL, publicKey }),
      });
      const id = str(created?.id);
      if (!id) throw new Error("Fluence SSH key registration returned no id");
      return id;
    } catch (err: any) {
      if (err?.status !== 409) throw err;
    }
    const listed = await this.api.apiJson("/v1/ssh_keys");
    const keys: any[] = Array.isArray(listed) ? listed : Array.isArray(listed?.items) ? listed.items : [];
    const fingerprint = sshFingerprint(publicKey);
    const match = keys.find(
      (k) =>
        (typeof k?.publicKey === "string" && sameKey(k.publicKey, publicKey)) ||
        (fingerprint !== null && k?.fingerprint === fingerprint),
    );
    const id = str(match?.id);
    if (!id) throw new Error("Fluence says the SSH key is already registered, but it was not found in GET /v1/ssh_keys");
    return id;
  }

  private sshUserFor(row: FluenceVmRow | undefined): string {
    return this.options.config.sshUser ?? row?.ssh_user ?? DEFAULT_FLUENCE_SSH_USER;
  }

  /** Poll until `launched` (or a terminal status / the attempt limit). */
  private async waitForLaunch(id: string, attempts: number): Promise<FluenceVm | null> {
    let vm: FluenceVm | null = null;
    for (let i = 0; i < attempts; i++) {
      vm = await this.getVm(id);
      if (!vm || vm.status === "launched" || NOT_LIVE_STATUSES.has(vm.status)) return vm;
      await this.sleep(this.pollIntervalMs);
    }
    return vm;
  }

  async createSandbox(options: { name?: string } = {}): Promise<SandboxInfo> {
    const { configuration, monthlyCents } = await this.planCreate();
    const image = await this.pickOsImage();
    const publicKey = await this.options.ssh.ensureKey();
    const name = sanitizeFluenceName(options.name);
    const sshUser =
      image.username && SSH_USER_PATTERN.test(image.username) ? image.username : DEFAULT_FLUENCE_SSH_USER;

    const sshKeyId = await this.ensureSshKeyId(publicKey);
    const clusterId = configuration.clusterId;
    const created = await this.api.apiJson("/v2/vms", {
      method: "POST",
      body: JSON.stringify({
        name,
        clusterId,
        configurationId: configuration.id,
        bootDisk: {
          clusterId,
          name: `${name}-boot`,
          storageType: "NVME",
          volumeGb: this.options.config.diskGb,
          replicated: false,
          osImage: image.downloadUrl,
        },
        publicIp: { clusterId, name: `${name}-ip`, addressType: "V4" },
        sshKeys: [sshKeyId],
      }),
    });
    const vm = mapVm(created);
    if (!vm) throw new Error("Fluence VM creation returned no VM id");

    this.options.db
      .prepare(
        `INSERT OR REPLACE INTO fluence_vms (id, name, status, public_ip, public_ip_id, storage_id, ssh_key_id, ssh_user, configuration, monthly_cost_cents, vm_terminated, ip_deleted, storage_deleted, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?)`,
      )
      .run(
        vm.id,
        name,
        vm.status,
        vm.address ?? null,
        vm.publicIpId ?? null,
        vm.bootDiskId ?? null,
        sshKeyId,
        sshUser,
        configuration.slug,
        monthlyCents,
        new Date().toISOString(),
      );
    logger.info(`Fluence VM created: ${vm.id} (${configuration.slug}, ~$${(monthlyCents / 100).toFixed(2)}/30d)`);

    let launched: FluenceVm = vm;
    try {
      launched = (await this.waitForLaunch(vm.id, this.options.launchPollAttempts ?? 24)) ?? vm;
    } catch (err) {
      // The VM is tracked: list_sandboxes / sandbox_exec refresh its status later.
      logger.warn(`Fluence VM ${vm.id} status poll failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (launched.status === "failed") {
      const cleanup = await this.deleteSandbox(vm.id);
      throw new Error(
        `Fluence VM ${vm.id} failed to start; it was cleaned up${cleanup.done ? "" : ` (still pending: ${cleanup.remaining.join(", ")}; retry delete_sandbox)`}.`,
      );
    }
    const address = launched.address ?? vm.address;
    return {
      id: vm.id,
      status: launched.status,
      region: "fluence",
      vcpu: configuration.vcpu < Number.MAX_SAFE_INTEGER ? configuration.vcpu : 0,
      memoryMb: configuration.ramGb < Number.MAX_SAFE_INTEGER ? configuration.ramGb * 1024 : 0,
      diskGb: this.options.config.diskGb,
      terminalUrl: address ? `ssh ${this.options.config.sshUser ?? sshUser}@${address}` : undefined,
      createdAt: new Date().toISOString(),
    };
  }

  /** Wait until the VM is `terminated` (or `failed` / gone) so its IP and disk can be released. */
  private async waitForRelease(id: string): Promise<boolean> {
    const attempts = this.options.terminatePollAttempts ?? 6;
    for (let i = 0; i < attempts; i++) {
      const vm = await this.getVm(id);
      if (!vm || RELEASABLE_STATUSES.has(vm.status)) return true;
      if (i < attempts - 1) await this.sleep(this.pollIntervalMs);
    }
    return false;
  }

  /**
   * Terminate the VM, then delete its public IP and its boot disk. Only VMs
   * created by this agent (tracked in the DB) can be deleted. Steps already
   * done are skipped, so a failed delete can simply be retried.
   */
  async deleteSandbox(id: string): Promise<{ done: boolean; remaining: string[] }> {
    let row = this.getTrackedVm(id);
    if (!row) throw new FluenceGuardError(`VM ${id} was not created by this agent; refusing to delete it.`);
    const db = this.options.db;
    const remaining: string[] = [];
    const enc = encodeURIComponent;

    if (!row.public_ip_id || !row.storage_id) {
      try {
        await this.getVm(id);
        row = this.getTrackedVm(id)!;
      } catch {
        // keep what we have
      }
    }

    if (!row.vm_terminated) {
      try {
        await this.api.apiJson(`/v2/vms/${enc(id)}/terminate`, { method: "POST" });
        db.prepare("UPDATE fluence_vms SET vm_terminated = 1, status = 'terminating', terminated_at = ? WHERE id = ?").run(
          new Date().toISOString(),
          id,
        );
      } catch (err: any) {
        if (err?.status === 404) {
          db.prepare("UPDATE fluence_vms SET vm_terminated = 1, status = 'terminated' WHERE id = ?").run(id);
        } else {
          remaining.push(`vm (${err?.message ?? err})`);
        }
      }
    }

    row = this.getTrackedVm(id)!;
    const pending = !row.ip_deleted || !row.storage_deleted;
    // The IP and the disk are released only once the VM has reached `terminated`.
    let released = row.vm_terminated === 1 && row.status === "terminated";
    if (pending && row.vm_terminated === 1 && !released) {
      try {
        released = await this.waitForRelease(id);
      } catch {
        released = false;
      }
      if (released) db.prepare("UPDATE fluence_vms SET status = 'terminated' WHERE id = ?").run(id);
    }

    const step = async (column: "ip_deleted" | "storage_deleted", resourceId: string | null, p: string, label: string) => {
      if (row![column]) return;
      if (!released) {
        remaining.push(`${label} (waiting for the VM to be terminated)`);
        return;
      }
      if (!resourceId) {
        remaining.push(`${label} (id unknown)`);
        return;
      }
      try {
        await this.api.apiJson(`${p}/${enc(resourceId)}`, { method: "DELETE" });
        db.prepare(`UPDATE fluence_vms SET ${column} = 1 WHERE id = ?`).run(id);
      } catch (err: any) {
        if (err?.status === 404) db.prepare(`UPDATE fluence_vms SET ${column} = 1 WHERE id = ?`).run(id);
        else remaining.push(`${label} (${err?.message ?? err})`);
      }
    };
    await step("ip_deleted", row.public_ip_id, "/v1/public_ips", "public IP");
    await step("storage_deleted", row.storage_id, "/v1/storages", "storage");
    if (remaining.length === 0) this.options.ssh.forgetHost(id);
    return { done: remaining.length === 0, remaining };
  }

  /** SSH target of a tracked launched VM (refreshes its status / IP if needed). */
  async getSshTarget(id: string): Promise<{ vmId: string; host: string; user: string }> {
    let row = this.getTrackedVm(id);
    if (!row || row.vm_terminated) throw new FluenceGuardError(`VM ${id} is not a live VM created by this agent.`);
    if (!row.public_ip || row.status !== "launched") {
      await this.getVm(id);
      row = this.getTrackedVm(id)!;
    }
    if (row.status !== "launched") throw new FluenceGuardError(`VM ${id} is not running yet (status: ${row.status}).`);
    if (!row.public_ip || !isValidHost(row.public_ip)) {
      throw new FluenceGuardError(`VM ${id} has no valid public IPv4 yet.`);
    }
    return { vmId: id, host: row.public_ip, user: this.sshUserFor(row) };
  }
}

export function ensureFluenceTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS fluence_vms (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      public_ip TEXT,
      public_ip_id TEXT,
      storage_id TEXT,
      ssh_key_id TEXT,
      ssh_user TEXT,
      configuration TEXT,
      monthly_cost_cents REAL,
      vm_terminated INTEGER NOT NULL DEFAULT 0,
      ip_deleted INTEGER NOT NULL DEFAULT 0,
      storage_deleted INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      terminated_at TEXT
    );
  `);
  const columns = db.prepare("PRAGMA table_info(fluence_vms)").all() as { name: string }[];
  if (!columns.some((c) => c.name === "ssh_user")) db.exec("ALTER TABLE fluence_vms ADD COLUMN ssh_user TEXT");
}
