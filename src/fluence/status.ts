/**
 * Fluence balance awareness.
 *
 * Every ~30 min (heartbeat task `check_compute_balance`) the Fluence balance
 * and the hourly burn of live resources are read and cached in KV
 * (`fluence.status`). The system prompt shows that cache (no network call).
 *
 * - runway < 3 days: wake the agent with a [COMPUTE] warning;
 * - runway < 1 day: the message says whether a top-up fits the caps and the
 *   reserve. Nothing is ever paid here: only the agent's own `fluence_topup`
 *   call can sign a payment.
 *
 * Fluence terminates VMs when the debt exceeds $5 or lasts 3 days.
 */

import type { AutomatonConfig, AutomatonDatabase } from "../types.js";
import type { FluenceRuntime } from "./runtime.js";
import { MIN_TOPUP_CENTS, isFluenceEnabled } from "./config.js";

export const FLUENCE_STATUS_KV = "fluence.status";
const LAST_WAKE_KV = "fluence.last_compute_wake";
const WARN_RUNWAY_HOURS = 72;
const CRITICAL_RUNWAY_HOURS = 24;
const WARN_WAKE_COOLDOWN_MS = 6 * 3_600_000;
const CRITICAL_WAKE_COOLDOWN_MS = 2 * 3_600_000;

export const FLUENCE_TERMINATION_NOTE =
  "Fluence terminates VMs when the account debt exceeds $5 or lasts 3 days.";

/** Fluence billing rules, repeated in the tool descriptions. */
export const FLUENCE_BILLING_NOTE =
  "Fluence bills per second from your Fluence balance; a VM is accepted only if the balance covers all its " +
  "resources for at least 6 hours; the VM, its public IP and its disk are billed separately; if the debt " +
  "exceeds $5 or stays unpaid for 3 days, VMs and public IPs are terminated.";

/** System-prompt section shown when Fluence is enabled. */
export const FLUENCE_NOTICE = `--- FLUENCE COMPUTE ---
You may rent ONE small Fluence VM (create_sandbox) to host ONLY your public x402 service. It has its own public IPv4.
- The VM never gets your wallet, wallet.json, ~/.automaton, any private key or API key. Your service only needs your payTo address.
- Deploy with sandbox_upload (files from ~/work only) and sandbox_exec. Same service security rules as locally.
- It costs real money every hour from your Fluence balance (see the status block and fluence_status, which is free).
- ${FLUENCE_BILLING_NOTE} Top up with fluence_topup (min $10, within the compute caps and your reserve) only if the service earns more than it costs; otherwise delete the VM (delete_sandbox removes VM, IP and disk).
--- END FLUENCE COMPUTE ---`;

export interface FluenceStatusSnapshot {
  balanceCents: number;
  /** null = unknown (a live VM has no stored quote). */
  burnCentsPerHour: number | null;
  /** null = no burn (no live VM) or unknown. */
  runwayHours: number | null;
  liveVms: number;
  checkedAt: string;
}

export function computeRunwayHours(balanceCents: number, burnCentsPerHour: number | null): number | null {
  if (burnCentsPerHour === null || burnCentsPerHour <= 0) return null;
  return Math.max(0, balanceCents) / burnCentsPerHour;
}

/** Read balance + burn and cache them (used by the heartbeat and fluence_status). */
export async function refreshFluenceStatus(
  runtime: Pick<FluenceRuntime, "vms">,
  db: Pick<AutomatonDatabase, "setKV">,
  now: () => number = Date.now,
): Promise<FluenceStatusSnapshot> {
  const { cents: balanceCents, usageDaysLeft } = await runtime.vms.getBalance();
  const burnCentsPerHour = runtime.vms.getHourlyBurnCents();
  const liveVms = runtime.vms.getLiveTrackedVms().filter((v) => v.vm_terminated === 0).length;
  // Fluence's own `usageDaysLeft` is the runway when it gives one (and a VM is running).
  const runwayHours =
    usageDaysLeft !== null && liveVms > 0
      ? Math.max(0, usageDaysLeft) * 24
      : computeRunwayHours(balanceCents, burnCentsPerHour);
  const snapshot: FluenceStatusSnapshot = {
    balanceCents,
    burnCentsPerHour,
    runwayHours,
    liveVms,
    checkedAt: new Date(now()).toISOString(),
  };
  db.setKV(FLUENCE_STATUS_KV, JSON.stringify(snapshot));
  return snapshot;
}

export function readFluenceStatus(db: Pick<AutomatonDatabase, "getKV">): FluenceStatusSnapshot | null {
  try {
    const raw = db.getKV(FLUENCE_STATUS_KV);
    return raw ? (JSON.parse(raw) as FluenceStatusSnapshot) : null;
  } catch {
    return null;
  }
}

function usd(cents: number): string {
  return `${cents < 0 ? "-" : ""}$${(Math.abs(cents) / 100).toFixed(2)}`;
}

export function formatFluenceStatus(s: FluenceStatusSnapshot | null, now: number = Date.now()): string {
  if (!s) return "Fluence compute: not checked yet (use fluence_status)";
  const ageMin = Math.max(0, Math.round((now - new Date(s.checkedAt).getTime()) / 60_000));
  const burn = s.burnCentsPerHour === null ? "unknown" : `${usd(s.burnCentsPerHour)}/h`;
  const runway = s.runwayHours === null ? (s.liveVms === 0 ? "n/a (no VM)" : "unknown") : `${(s.runwayHours / 24).toFixed(1)} days`;
  return `Fluence compute: balance ${usd(s.balanceCents)}, burn ${burn}, runway ${runway}, ${s.liveVms} VM (checked ${ageMin}m ago)`;
}

/** Status-block line for the system prompt ("" when Fluence is disabled). */
export function fluenceStatusLine(
  config: Pick<AutomatonConfig, "providerMode" | "fluence">,
  db: Pick<AutomatonDatabase, "getKV">,
): string {
  if (!isFluenceEnabled(config)) return "";
  return `\n${formatFluenceStatus(readFluenceStatus(db))}`;
}

/**
 * Heartbeat check. Returns a wake message when the runway is short (with a
 * cooldown so the agent is not woken every 30 min), never pays anything.
 */
export async function checkComputeBalance(
  runtime: Pick<FluenceRuntime, "vms" | "billing">,
  db: Pick<AutomatonDatabase, "getKV" | "setKV">,
  now: () => number = Date.now,
): Promise<{ shouldWake: boolean; message?: string }> {
  const s = await refreshFluenceStatus(runtime, db, now);
  if (s.runwayHours === null || s.runwayHours >= WARN_RUNWAY_HOURS) return { shouldWake: false };

  const critical = s.runwayHours < CRITICAL_RUNWAY_HOURS;
  const cooldown = critical ? CRITICAL_WAKE_COOLDOWN_MS : WARN_WAKE_COOLDOWN_MS;
  const last = Number(db.getKV(LAST_WAKE_KV) || 0);
  if (Number.isFinite(last) && now() - last < cooldown) return { shouldWake: false };
  db.setKV(LAST_WAKE_KV, String(now()));

  let advice: string;
  if (critical) {
    const refusal = runtime.billing.precheck(MIN_TOPUP_CENTS);
    advice = refusal
      ? `A top-up is not possible within the caps right now (${refusal}). Ask your creator, or delete the VM before Fluence terminates it.`
      : `A $${(MIN_TOPUP_CENTS / 100).toFixed(2)} top-up fits within the caps; if the service earns more than it costs, you may call fluence_topup (subject to the reserve check).`;
  } else {
    advice = "Plan ahead: decide whether the service earns enough to keep the VM.";
  }
  return {
    shouldWake: true,
    message: `[COMPUTE] Fluence runway is ${(s.runwayHours / 24).toFixed(1)} days (balance ${usd(s.balanceCents)}, burn ${usd(s.burnCentsPerHour ?? 0)}/h). ${FLUENCE_TERMINATION_NOTE} ${advice}`,
  };
}
