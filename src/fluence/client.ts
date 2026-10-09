/**
 * Fluence CPU Cloud VM client (standalone mode).
 *
 * Scope: ONE small shared-CPU VM that hosts only the agent's public x402
 * service. No wallet and no agent runtime ever go to the VM.
 *
 * - create: cheapest `cpu-shared-*` configuration, small boot disk from an
 *   Ubuntu image, a V4 public IP, the agent's SSH public key. Before
 *   creating, a 30-day quote (VM + disk + IP) must fit
 *   maxComputeMonthlyCents, and the live VM count must stay ≤ maxComputeVms (1).
 * - delete: terminate the VM, then delete its public IP and its storage, so
 *   nothing keeps billing. Every resource is tracked in the `fluence_vms`
 *   table and retried on the next delete if a step failed.
 *
 * Request/response shapes are parsed leniently (several field names are
 * accepted) and every guard fails closed when a value cannot be read.
 */

import type Database from "better-sqlite3";
import type { SandboxInfo, TreasuryPolicy } from "../types.js";
import { computeCaps } from "../agent/spend-tracker.js";
import type { FluenceAuth } from "./auth.js";
import type { FluenceSsh } from "./ssh.js";
import type { ResolvedFluenceConfig } from "./config.js";
import { createLogger } from "../observability/logger.js";

const logger = createLogger("fluence.client");

export const QUOTE_HOURS = 30 * 24;

export interface FluenceVmRow {
  id: string;
  name: string;
  status: string;
  public_ip: string | null;
  public_ip_id: string | null;
  storage_id: string | null;
  ssh_key_id: string | null;
  configuration: string | null;
  monthly_cost_cents: number | null;
  vm_terminated: number;
  ip_deleted: number;
  storage_deleted: number;
  created_at: string;
  terminated_at: string | null;
}

export interface FluenceConfiguration {
  slug: string;
  vcpu: number;
  memoryGb: number;
  priceCents?: number;
}

export class FluenceGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FluenceGuardError";
  }
}

const TERMINAL_STATUSES = new Set(["terminated", "terminating", "deleted", "removed", "stopped", "failed"]);

function asArray(body: any, ...keys: string[]): any[] {
  if (Array.isArray(body)) return body;
  for (const k of keys) {
    if (Array.isArray(body?.[k])) return body[k];
  }
  return [];
}

function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

function str(v: unknown): string | undefined {
  if (typeof v === "string" && v) return v;
  if (typeof v === "number") return String(v);
  return undefined;
}

/** "cpu-shared-2-ram-4gb" style slug → vCPU / RAM when fields are missing. */
function parseSlug(slug: string): { vcpu?: number; memoryGb?: number } {
  const cpu = /cpu-shared-(\d+)/.exec(slug) ?? /(\d+)\s*vcpu/i.exec(slug);
  const ram = /ram-(\d+)\s*gb/i.exec(slug) ?? /(\d+)\s*gb/i.exec(slug);
  return { vcpu: cpu ? Number(cpu[1]) : undefined, memoryGb: ram ? Number(ram[1]) : undefined };
}

/** Pick the cheapest / smallest `cpu-shared-*` configuration. */
export function pickCheapestSharedConfiguration(raw: any): FluenceConfiguration | null {
  const items = asArray(raw, "configurations", "data", "items", "results");
  const configs: FluenceConfiguration[] = [];
  for (const item of items) {
    const slug = typeof item === "string" ? item : str(item?.slug) ?? str(item?.name) ?? str(item?.id);
    if (!slug || !slug.startsWith("cpu-shared-")) continue;
    if (typeof item === "object" && item && item.available === false) continue;
    const fromSlug = parseSlug(slug);
    const vcpu = num(item?.vcpu) ?? num(item?.vcpus) ?? num(item?.cpu) ?? fromSlug.vcpu;
    const memoryGb =
      num(item?.memoryGb) ?? num(item?.ramGb) ?? num(item?.ram) ?? (num(item?.memoryMb) ? num(item?.memoryMb)! / 1024 : undefined) ?? fromSlug.memoryGb;
    const priceUsd = num(item?.price) ?? num(item?.pricePerHour) ?? num(item?.priceUsd);
    configs.push({
      slug,
      vcpu: vcpu ?? Number.MAX_SAFE_INTEGER,
      memoryGb: memoryGb ?? Number.MAX_SAFE_INTEGER,
      priceCents: priceUsd !== undefined ? priceUsd * 100 : undefined,
    });
  }
  configs.sort(
    (a, b) =>
      (a.priceCents ?? Infinity) - (b.priceCents ?? Infinity) ||
      a.vcpu - b.vcpu ||
      a.memoryGb - b.memoryGb ||
      a.slug.localeCompare(b.slug),
  );
  return configs[0] ?? null;
}

/** Total of a cost quote in cents (USD amounts in the response). */
export function parseQuoteCents(raw: any): number | null {
  const candidates = [raw?.totalUsd, raw?.total, raw?.totalCost, raw?.cost, raw?.amount, raw?.price, raw?.totalPrice];
  for (const c of candidates) {
    const n = num(c) ?? num(c?.amount) ?? num(c?.value);
    if (n !== undefined && n >= 0) return Math.round(n * 100 * 100) / 100;
  }
  const parts = asArray(raw, "items", "breakdown", "costs");
  if (parts.length > 0) {
    let sum = 0;
    for (const p of parts) {
      const n = num(p?.totalUsd) ?? num(p?.total) ?? num(p?.cost) ?? num(p?.amount) ?? num(p?.price);
      if (n === undefined) return null;
      sum += n;
    }
    return Math.round(sum * 100 * 100) / 100;
  }
  return null;
}

/** Fluence balance in cents (negative = debt), or null when unreadable. */
export function parseBalanceCents(raw: any): number | null {
  const direct = num(raw?.balance) ?? num(raw?.balanceUsd) ?? num(raw?.available) ?? num(raw?.amount) ?? num(raw?.total);
  if (direct !== undefined) return Math.round(direct * 100 * 100) / 100;
  const list = asArray(raw, "balances", "data");
  const usd = list.find((b) => /usd/i.test(String(b?.currency ?? b?.asset ?? b?.symbol ?? "usd"))) ?? list[0];
  const n = num(usd?.balance) ?? num(usd?.amount) ?? num(usd?.available) ?? num(usd?.value);
  return n === undefined ? null : Math.round(n * 100 * 100) / 100;
}

function mapVm(raw: any): { id: string; status: string; publicIp?: string; publicIpId?: string; storageId?: string; name?: string; configuration?: string; createdAt?: string } | null {
  const id = str(raw?.id) ?? str(raw?.vmId);
  if (!id) return null;
  const ip = raw?.publicIp ?? raw?.public_ip;
  const publicIp =
    typeof ip === "string" ? ip : str(ip?.address) ?? str(ip?.ip) ?? str(raw?.ip) ?? str(raw?.ipAddress);
  const publicIpId = typeof ip === "object" && ip ? str(ip.id) : str(raw?.publicIpId);
  const disk = raw?.bootDisk ?? raw?.storage ?? raw?.disk;
  const storageId = (typeof disk === "object" && disk ? str(disk.id) ?? str(disk.storageId) : undefined) ?? str(raw?.storageId) ?? str(raw?.bootDiskId);
  return {
    id,
    status: String(raw?.status ?? raw?.state ?? "unknown").toLowerCase(),
    publicIp,
    publicIpId,
    storageId,
    name: str(raw?.name),
    configuration: str(raw?.configuration?.slug ?? raw?.configuration),
    createdAt: str(raw?.createdAt ?? raw?.created_at),
  };
}

export interface FluenceVmClientOptions {
  auth: Pick<FluenceAuth, "apiJson">;
  db: Database.Database;
  policy: TreasuryPolicy;
  config: ResolvedFluenceConfig;
  ssh: Pick<FluenceSsh, "ensureKey" | "forgetHost">;
}

export class FluenceVmClient {
  constructor(private readonly options: FluenceVmClientOptions) {
    ensureFluenceTable(options.db);
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

  // ─── API ────────────────────────────────────────────────────

  async listVms(): Promise<NonNullable<ReturnType<typeof mapVm>>[]> {
    const body = await this.api.apiJson("/v2/vms?expand=publicIp");
    const vms = asArray(body, "vms", "data", "items").map(mapVm).filter((v): v is NonNullable<typeof v> => v !== null);
    // Refresh tracked rows (public IP appears after boot).
    const upd = this.options.db.prepare(
      "UPDATE fluence_vms SET status = ?, public_ip = COALESCE(?, public_ip), public_ip_id = COALESCE(public_ip_id, ?), storage_id = COALESCE(storage_id, ?) WHERE id = ?",
    );
    for (const v of vms) upd.run(v.status, v.publicIp ?? null, v.publicIpId ?? null, v.storageId ?? null, v.id);
    return vms;
  }

  async listSandboxes(): Promise<SandboxInfo[]> {
    const vms = await this.listVms();
    return vms.map((v) => ({
      id: v.id,
      status: v.status,
      region: "fluence",
      vcpu: parseSlug(v.configuration ?? "").vcpu ?? 0,
      memoryMb: (parseSlug(v.configuration ?? "").memoryGb ?? 0) * 1024,
      diskGb: this.options.config.diskGb,
      terminalUrl: v.publicIp ? `ssh ${this.options.config.sshUser}@${v.publicIp}` : undefined,
      createdAt: v.createdAt ?? "",
    }));
  }

  async countLiveVms(): Promise<number> {
    const remote = (await this.listVms()).filter((v) => !TERMINAL_STATUSES.has(v.status)).length;
    const tracked = this.getLiveTrackedVms().filter((v) => v.vm_terminated === 0).length;
    return Math.max(remote, tracked);
  }

  async getBalanceCents(): Promise<number> {
    const cents = parseBalanceCents(await this.api.apiJson("/v2/users/balances"));
    if (cents === null) throw new Error("Unreadable Fluence balance response");
    return cents;
  }

  async pickConfiguration(): Promise<FluenceConfiguration> {
    const config = pickCheapestSharedConfiguration(await this.api.apiJson("/v2/vms/configurations"));
    if (!config) throw new FluenceGuardError("No cpu-shared-* configuration is available on Fluence right now.");
    return config;
  }

  async pickOsImage(): Promise<string> {
    if (this.options.config.osImage) return this.options.config.osImage;
    const images = asArray(await this.api.apiJson("/v2/vms/default_images"), "images", "data", "items");
    const ubuntu = images.find((i) => /ubuntu/i.test(String(i?.name ?? i?.distribution ?? i?.slug ?? i)));
    const ref = ubuntu && (typeof ubuntu === "string" ? ubuntu : str(ubuntu.url) ?? str(ubuntu.slug) ?? str(ubuntu.id));
    if (!ref) throw new FluenceGuardError("No default Ubuntu image found; set fluence.osImage.");
    return ref;
  }

  /** 30-day cost (VM + boot disk + public IP) in cents. */
  async quoteMonthlyCents(configuration: string): Promise<number> {
    const body = await this.api.apiJson("/v1/prices/cost", {
      method: "POST",
      body: JSON.stringify({
        durationHours: QUOTE_HOURS,
        resources: [
          { type: "vm", configuration, count: 1 },
          { type: "storage", sizeGb: this.options.config.diskGb, count: 1 },
          { type: "public_ip", ipVersion: "V4", count: 1 },
        ],
      }),
    });
    const cents = parseQuoteCents(body);
    if (cents === null) throw new FluenceGuardError("Unreadable Fluence price quote; refusing to create a VM.");
    return cents;
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
    const live = await this.countLiveVms();
    if (live + 1 > max) {
      throw new FluenceGuardError(`A Fluence VM already exists (${live} live, limit ${max}). Delete it first.`);
    }
    const configuration = await this.pickConfiguration();
    const monthlyCents = await this.quoteMonthlyCents(configuration.slug);
    if (monthlyCents > caps.monthlyCents) {
      throw new FluenceGuardError(
        `The 30-day cost of ${configuration.slug} (VM + disk + IP) is $${(monthlyCents / 100).toFixed(2)}, above maxComputeMonthlyCents ($${(caps.monthlyCents / 100).toFixed(2)}).`,
      );
    }
    return { configuration, monthlyCents };
  }

  async createSandbox(options: { name?: string } = {}): Promise<SandboxInfo> {
    const { configuration, monthlyCents } = await this.planCreate();
    const osImage = await this.pickOsImage();
    const publicKey = await this.options.ssh.ensureKey();
    const name = (options.name || "automaton-service").replace(/[^A-Za-z0-9-]/g, "-").slice(0, 40);

    const keyResp = await this.api.apiJson("/v1/ssh_keys", {
      method: "POST",
      body: JSON.stringify({ name: `${name}-key`, publicKey }),
    });
    const sshKeyId = str(keyResp?.id) ?? str(keyResp?.fingerprint);

    const created = await this.api.apiJson("/v2/vms", {
      method: "POST",
      body: JSON.stringify({
        name,
        configuration: configuration.slug,
        instances: 1,
        bootDisk: { osImage, sizeGb: this.options.config.diskGb },
        publicIp: { version: "V4" },
        sshKeys: [sshKeyId ? { id: sshKeyId } : { publicKey }],
      }),
    });
    const vm = mapVm(Array.isArray(created) ? created[0] : created?.vm ?? asArray(created, "vms", "data")[0] ?? created);
    if (!vm) throw new Error("Fluence VM creation returned no VM id");

    this.options.db
      .prepare(
        `INSERT OR REPLACE INTO fluence_vms (id, name, status, public_ip, public_ip_id, storage_id, ssh_key_id, configuration, monthly_cost_cents, vm_terminated, ip_deleted, storage_deleted, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      )
      .run(
        vm.id,
        name,
        vm.status,
        vm.publicIp ?? null,
        vm.publicIpId ?? null,
        vm.storageId ?? null,
        sshKeyId ?? null,
        configuration.slug,
        monthlyCents,
        0,
        0,
        new Date().toISOString(),
      );
    logger.info(`Fluence VM created: ${vm.id} (${configuration.slug}, ~$${(monthlyCents / 100).toFixed(2)}/30d)`);
    return {
      id: vm.id,
      status: vm.status,
      region: "fluence",
      vcpu: Number.isFinite(configuration.vcpu) && configuration.vcpu < Number.MAX_SAFE_INTEGER ? configuration.vcpu : 0,
      memoryMb: Number.isFinite(configuration.memoryGb) && configuration.memoryGb < Number.MAX_SAFE_INTEGER ? configuration.memoryGb * 1024 : 0,
      diskGb: this.options.config.diskGb,
      terminalUrl: vm.publicIp ? `ssh ${this.options.config.sshUser}@${vm.publicIp}` : undefined,
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * Terminate the VM, then delete its public IP and its storage. Only VMs
   * created by this agent (tracked in the DB) can be deleted. Steps already
   * done are skipped, so a failed delete can simply be retried.
   */
  async deleteSandbox(id: string): Promise<{ done: boolean; remaining: string[] }> {
    let row = this.getTrackedVm(id);
    if (!row) throw new FluenceGuardError(`VM ${id} was not created by this agent; refusing to delete it.`);
    if (!row.public_ip_id || !row.storage_id) {
      try {
        await this.listVms();
        row = this.getTrackedVm(id)!;
      } catch {
        // keep what we have
      }
    }
    const db = this.options.db;
    const remaining: string[] = [];
    const enc = encodeURIComponent;

    if (!row.vm_terminated) {
      try {
        await this.api.apiJson(`/v2/vms/${enc(id)}/terminate`, { method: "POST" });
        db.prepare("UPDATE fluence_vms SET vm_terminated = 1, status = 'terminated', terminated_at = ? WHERE id = ?").run(
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
    // The IP and the disk are released only once the VM is gone.
    const vmGone = this.getTrackedVm(id)!.vm_terminated === 1;
    const step = async (column: "ip_deleted" | "storage_deleted", resourceId: string | null, p: string, label: string) => {
      if (row![column]) return;
      if (!vmGone) {
        remaining.push(label);
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

  /** SSH target of a tracked live VM (refreshes its IP if needed). */
  async getSshTarget(id: string): Promise<{ vmId: string; host: string; user: string }> {
    let row = this.getTrackedVm(id);
    if (!row || row.vm_terminated) throw new FluenceGuardError(`VM ${id} is not a live VM created by this agent.`);
    if (!row.public_ip) {
      await this.listVms();
      row = this.getTrackedVm(id)!;
    }
    if (!row.public_ip) throw new FluenceGuardError(`VM ${id} has no public IP yet (still booting?).`);
    return { vmId: id, host: row.public_ip, user: this.options.config.sshUser };
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
      configuration TEXT,
      monthly_cost_cents REAL,
      vm_terminated INTEGER NOT NULL DEFAULT 0,
      ip_deleted INTEGER NOT NULL DEFAULT 0,
      storage_deleted INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      terminated_at TEXT
    );
  `);
}
