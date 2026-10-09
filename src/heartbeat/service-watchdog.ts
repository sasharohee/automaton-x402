/**
 * Service Watchdog (standalone only)
 *
 * Built-in heartbeat task `service_watchdog`: checks
 * http://127.0.0.1:<port><healthPath> and, after N consecutive failures,
 * runs the configured restart command through the same local exec path as
 * the agent's `exec` tool (scrubbed environment, timeout), confined to
 * ~/work. Restarts are limited per rolling hour, and each restart leaves a
 * wake event (source "watchdog") so the agent learns about it.
 *
 * Settings: `serviceWatchdog` in automaton.json, overridden by the params
 * the agent saved with modify_heartbeat. Off unless one of them enables it.
 */

import os from "node:os";
import path from "node:path";
import type BetterSqlite3 from "better-sqlite3";
import type {
  AutomatonConfig,
  AutomatonDatabase,
  HeartbeatLegacyContext,
  ServiceWatchdogConfig,
} from "../types.js";
import { isStandalone } from "../conway/provider.js";
import { getStandaloneWorkDir } from "../agent/workdir.js";
import { getExecSecretAccessMatch } from "../agent/policy-rules/secret-access.js";
import { DEFAULT_PUBLIC_SERVICE_PORT } from "../config.js";
import { getHeartbeatTask, insertWakeEvent, upsertHeartbeatSchedule } from "../state/database.js";
import { createLogger } from "../observability/logger.js";

type DatabaseType = BetterSqlite3.Database;
const logger = createLogger("heartbeat.watchdog");

export const SERVICE_WATCHDOG_TASK = "service_watchdog";
export const SERVICE_WATCHDOG_STATE_KEY = "service_watchdog.state";
export const WATCHDOG_HEALTH_TIMEOUT_MS = 3_000;
export const WATCHDOG_RESTART_TIMEOUT_MS = 20_000;
/** Scheduler timeout: health check + restart command, with margin. */
const WATCHDOG_TASK_TIMEOUT_MS = 60_000;
const HOUR_MS = 3_600_000;

export interface ServiceWatchdogSettings {
  port: number;
  healthPath: string;
  restartCommand: string;
  /** Absolute directory inside the work root. */
  cwd: string;
  intervalSec: number;
  failuresBeforeRestart: number;
  maxRestartsPerHour: number;
}

export interface WatchdogRoots {
  /** Directory `~` expands to. */
  home: string;
  /** The only tree the restart command may reference (~/work). */
  workRoot: string;
}

export function defaultWatchdogRoots(): WatchdogRoots {
  return { home: os.homedir(), workRoot: getStandaloneWorkDir() };
}

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

function intInRange(value: unknown, name: string, min: number, max: number): Result<number> {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    return { ok: false, error: `${name} must be an integer in ${min}-${max} (got ${JSON.stringify(value)})` };
  }
  return { ok: true, value };
}

function expandHome(p: string, home: string): string {
  return p
    .replace(/^~(?=$|\/)/, home)
    .replace(/^\$\{HOME\}(?=$|\/)/, home)
    .replace(/^\$HOME(?=$|\/)/, home);
}

function isInside(resolved: string, root: string): boolean {
  return resolved === root || resolved.startsWith(root + path.sep);
}

/** Paths that can never be referenced, whatever the work root. */
function forbiddenReference(text: string): string | null {
  if (/\.automaton/i.test(text)) return "~/.automaton";
  if (/wallet/i.test(text)) return "the wallet";
  if (/(^|[^\w])\.env(?![\w-])/i.test(text)) return ".env files";
  const secret = getExecSecretAccessMatch(text);
  return secret;
}

/**
 * Directory the restart command runs in: must resolve inside the work root.
 */
export function validateWatchdogCwd(cwd: unknown, roots: WatchdogRoots): Result<string> {
  if (cwd === undefined) return { ok: true, value: roots.workRoot };
  if (typeof cwd !== "string" || cwd.trim() === "" || cwd.length > 300 || /[\0\n\r'"`$;&|<>]/.test(cwd.replace(/^\$\{?HOME\}?/, ""))) {
    return { ok: false, error: `cwd must be a plain directory path inside ${roots.workRoot}` };
  }
  const forbidden = forbiddenReference(cwd);
  if (forbidden) return { ok: false, error: `cwd may not reference ${forbidden}` };
  const resolved = path.resolve(roots.workRoot, expandHome(cwd.trim(), roots.home));
  if (!isInside(resolved, roots.workRoot)) {
    return { ok: false, error: `cwd "${cwd}" resolves to ${resolved}, outside the work directory ${roots.workRoot}` };
  }
  return { ok: true, value: resolved };
}

/**
 * Restart command checks (best effort, on top of the scrubbed environment):
 * no reference to ~/.automaton, the wallet, .env files or /proc secrets; no
 * `..`; no command substitution or variables other than $HOME; every
 * absolute or ~ path must stay inside the work root (/dev/null aside).
 */
export function validateWatchdogCommand(command: unknown, roots: WatchdogRoots): Result<string> {
  if (typeof command !== "string" || command.trim() === "") {
    return { ok: false, error: "restartCommand is required (e.g. \"bash ~/work/<service>/restart.sh\")" };
  }
  const trimmed = command.trim();
  if (trimmed.length > 500 || /[\0\n\r]/.test(trimmed)) {
    return { ok: false, error: "restartCommand must be a single line of at most 500 characters" };
  }
  const forbidden = forbiddenReference(trimmed);
  if (forbidden) return { ok: false, error: `restartCommand may not reference ${forbidden}` };
  if (/`|\$\(/.test(trimmed) || /\$(?!HOME\b|\{HOME\})/.test(trimmed)) {
    return { ok: false, error: "restartCommand may not use command substitution or variables other than $HOME" };
  }
  if (/(^|[\s/'"=:])\.\.(?=$|[\s/'"])/.test(trimmed)) {
    return { ok: false, error: "restartCommand may not use \"..\" paths" };
  }
  for (const token of trimmed.split(/[\s;|&<>()'"=]+/)) {
    if (!/^(\/|~|\$HOME\b|\$\{HOME\})/.test(token)) continue;
    if (token === "/dev/null") continue;
    const resolved = path.resolve(expandHome(token, roots.home));
    if (!isInside(resolved, roots.workRoot)) {
      return {
        ok: false,
        error: `restartCommand path "${token}" is outside the work directory ${roots.workRoot}`,
      };
    }
  }
  return { ok: true, value: trimmed };
}

/**
 * Merge config defaults, the `serviceWatchdog` block and the agent's saved
 * params, then validate everything.
 */
export function resolveServiceWatchdogSettings(
  config: Pick<AutomatonConfig, "providerMode" | "publicService" | "serviceWatchdog">,
  params: Record<string, unknown> | undefined,
  roots: WatchdogRoots = defaultWatchdogRoots(),
): Result<ServiceWatchdogSettings> {
  if (!isStandalone(config)) {
    return { ok: false, error: "service_watchdog is only available in standalone mode" };
  }
  const raw: ServiceWatchdogConfig & Record<string, unknown> = {
    ...(config.serviceWatchdog ?? {}),
    ...(params ?? {}),
  };
  const known = new Set([
    "port", "healthPath", "restartCommand", "cwd", "intervalSec", "failuresBeforeRestart", "maxRestartsPerHour",
  ]);
  const unknown = Object.keys(raw).filter((key) => !known.has(key));
  if (unknown.length > 0) {
    return { ok: false, error: `unknown service_watchdog setting(s): ${unknown.join(", ")}. Allowed: ${[...known].join(", ")}` };
  }

  const port = intInRange(
    raw.port ?? config.publicService?.servicePort ?? DEFAULT_PUBLIC_SERVICE_PORT,
    "port",
    1024,
    65535,
  );
  if (!port.ok) return port;

  const healthPath = raw.healthPath ?? "/health";
  if (typeof healthPath !== "string" || !/^\/[A-Za-z0-9._~\-/]{0,199}$/.test(healthPath)) {
    return { ok: false, error: "healthPath must start with \"/\" and contain only URL path characters (no query)" };
  }

  const command = validateWatchdogCommand(raw.restartCommand, roots);
  if (!command.ok) return command;
  const cwd = validateWatchdogCwd(raw.cwd, roots);
  if (!cwd.ok) return cwd;

  const intervalSec = intInRange(raw.intervalSec ?? 120, "intervalSec", 30, 3600);
  if (!intervalSec.ok) return intervalSec;
  const failures = intInRange(raw.failuresBeforeRestart ?? 2, "failuresBeforeRestart", 1, 10);
  if (!failures.ok) return failures;
  const maxRestarts = intInRange(raw.maxRestartsPerHour ?? 3, "maxRestartsPerHour", 1, 12);
  if (!maxRestarts.ok) return maxRestarts;

  return {
    ok: true,
    value: {
      port: port.value,
      healthPath,
      restartCommand: command.value,
      cwd: cwd.value,
      intervalSec: intervalSec.value,
      failuresBeforeRestart: failures.value,
      maxRestartsPerHour: maxRestarts.value,
    },
  };
}

/** Params the agent saved for the watchdog with modify_heartbeat. */
export function getSavedWatchdogParams(db: Pick<AutomatonDatabase, "getHeartbeatEntries">): Record<string, unknown> | undefined {
  const entry = db.getHeartbeatEntries().find((e) => e.name === SERVICE_WATCHDOG_TASK);
  return entry?.params && Object.keys(entry.params).length > 0 ? entry.params : undefined;
}

/**
 * Make the scheduler run `taskName` (heartbeat_schedule is what the
 * scheduler reads). Keeps run history and counters of an existing row.
 */
export function applyHeartbeatSchedule(
  db: DatabaseType,
  taskName: string,
  schedule: { cronExpression?: string; intervalMs?: number | null; enabled: boolean; timeoutMs?: number },
): void {
  const existing = getHeartbeatTask(db, taskName);
  if (existing) {
    db.prepare(
      `UPDATE heartbeat_schedule
       SET cron_expression = ?, interval_ms = ?, enabled = ?, timeout_ms = ?, updated_at = datetime('now')
       WHERE task_name = ?`,
    ).run(
      schedule.cronExpression ?? existing.cronExpression,
      schedule.intervalMs === undefined ? existing.intervalMs : schedule.intervalMs,
      schedule.enabled ? 1 : 0,
      schedule.timeoutMs ?? existing.timeoutMs,
      taskName,
    );
    return;
  }
  upsertHeartbeatSchedule(db, {
    taskName,
    cronExpression: schedule.cronExpression ?? "",
    intervalMs: schedule.intervalMs ?? null,
    enabled: schedule.enabled ? 1 : 0,
    priority: 0,
    timeoutMs: schedule.timeoutMs ?? 30_000,
    maxRetries: 0,
    tierMinimum: "dead",
    lastRunAt: null,
    nextRunAt: null,
    lastResult: null,
    lastError: null,
    runCount: 0,
    failCount: 0,
    leaseOwner: null,
    leaseExpiresAt: null,
  });
}

/** Schedule the watchdog every `intervalSec` (interval-based, no cron). */
export function scheduleServiceWatchdog(db: DatabaseType, settings: ServiceWatchdogSettings, enabled: boolean): void {
  applyHeartbeatSchedule(db, SERVICE_WATCHDOG_TASK, {
    cronExpression: "",
    intervalMs: settings.intervalSec * 1000,
    enabled,
    timeoutMs: WATCHDOG_TASK_TIMEOUT_MS,
  });
}

/**
 * Startup: a valid `serviceWatchdog` config block schedules the watchdog
 * (keeping the enabled flag the agent may have changed since).
 */
export function initServiceWatchdog(
  db: AutomatonDatabase,
  config: AutomatonConfig,
  roots: WatchdogRoots = defaultWatchdogRoots(),
): void {
  if (!isStandalone(config) || !config.serviceWatchdog) return;
  const settings = resolveServiceWatchdogSettings(config, getSavedWatchdogParams(db), roots);
  if (!settings.ok) {
    logger.warn(`[WATCHDOG] serviceWatchdog config ignored: ${settings.error}`);
    return;
  }
  const existing = getHeartbeatTask(db.raw, SERVICE_WATCHDOG_TASK);
  scheduleServiceWatchdog(db.raw, settings.value, existing ? existing.enabled === 1 : true);
  logger.info(
    `[WATCHDOG] Watching 127.0.0.1:${settings.value.port}${settings.value.healthPath} every ${settings.value.intervalSec}s`,
  );
}

// ─── Runtime ───────────────────────────────────────────────────

interface WatchdogState {
  consecutiveFailures: number;
  /** ISO timestamps of restarts (pruned to the last hour). */
  restarts: string[];
}

function readState(db: Pick<AutomatonDatabase, "getKV">): WatchdogState {
  try {
    const parsed = JSON.parse(db.getKV(SERVICE_WATCHDOG_STATE_KEY) || "{}");
    return {
      consecutiveFailures: Number.isInteger(parsed.consecutiveFailures) ? parsed.consecutiveFailures : 0,
      restarts: Array.isArray(parsed.restarts) ? parsed.restarts.filter((r: unknown) => typeof r === "string") : [],
    };
  } catch {
    return { consecutiveFailures: 0, restarts: [] };
  }
}

/** GET the health route on localhost. Never throws. */
export async function checkLocalHealth(
  port: number,
  healthPath: string,
  timeoutMs: number = WATCHDOG_HEALTH_TIMEOUT_MS,
): Promise<{ ok: boolean; detail: string }> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}${healthPath}`, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "manual",
    });
    await response.body?.cancel().catch(() => undefined);
    return { ok: response.ok, detail: `HTTP ${response.status}` };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

export interface ServiceWatchdogDeps {
  checkHealth?: (port: number, healthPath: string) => Promise<{ ok: boolean; detail: string }>;
  now?: () => number;
  roots?: WatchdogRoots;
}

function quote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export async function runServiceWatchdog(
  taskCtx: HeartbeatLegacyContext,
  deps: ServiceWatchdogDeps = {},
): Promise<{ shouldWake: boolean; message?: string }> {
  const { db, config, conway } = taskCtx;
  const settingsResult = resolveServiceWatchdogSettings(config, getSavedWatchdogParams(db), deps.roots);
  if (!settingsResult.ok) {
    logger.warn(`[WATCHDOG] Not running: ${settingsResult.error}`);
    return { shouldWake: false };
  }
  const settings = settingsResult.value;
  const now = deps.now?.() ?? Date.now();
  const checkHealth = deps.checkHealth ?? checkLocalHealth;
  const target = `127.0.0.1:${settings.port}${settings.healthPath}`;

  const state = readState(db);
  state.restarts = state.restarts.filter((r) => now - new Date(r).getTime() < HOUR_MS);

  const health = await checkHealth(settings.port, settings.healthPath);
  if (health.ok) {
    state.consecutiveFailures = 0;
    db.setKV(SERVICE_WATCHDOG_STATE_KEY, JSON.stringify(state));
    return { shouldWake: false };
  }

  state.consecutiveFailures++;
  logger.warn(
    `[WATCHDOG] Health check failed (${state.consecutiveFailures}/${settings.failuresBeforeRestart}) for ${target}: ${health.detail}`,
  );

  if (state.consecutiveFailures < settings.failuresBeforeRestart) {
    db.setKV(SERVICE_WATCHDOG_STATE_KEY, JSON.stringify(state));
    return { shouldWake: false };
  }
  if (state.restarts.length >= settings.maxRestartsPerHour) {
    logger.warn(
      `[WATCHDOG] Restart limit reached (${state.restarts.length}/${settings.maxRestartsPerHour} in the last hour); not restarting ${target}.`,
    );
    db.setKV(SERVICE_WATCHDOG_STATE_KEY, JSON.stringify(state));
    return { shouldWake: false };
  }

  // Record the restart before running it: a command that hangs or crashes
  // the task still counts toward the hourly limit.
  state.restarts.push(new Date(now).toISOString());
  const failures = state.consecutiveFailures;
  state.consecutiveFailures = 0;
  db.setKV(SERVICE_WATCHDOG_STATE_KEY, JSON.stringify(state));

  logger.warn(`[WATCHDOG] Restarting service: ${settings.restartCommand} (cwd ${settings.cwd})`);
  let summary: string;
  try {
    const result = await conway.exec(
      `cd ${quote(settings.cwd)} && ${settings.restartCommand}`,
      WATCHDOG_RESTART_TIMEOUT_MS,
    );
    const stderr = result.stderr ? `, stderr: ${result.stderr.slice(0, 200)}` : "";
    summary = `exit code ${result.exitCode}${stderr}`;
  } catch (error) {
    summary = `error: ${error instanceof Error ? error.message : String(error)}`;
  }
  logger.warn(`[WATCHDOG] Restart finished: ${summary}`);

  insertWakeEvent(
    db.raw,
    "watchdog",
    `Service watchdog restarted your service after ${failures} failed health checks of ${target} ` +
      `(last: ${health.detail}). Restart ${summary}. Restarts in the last hour: ` +
      `${state.restarts.length}/${settings.maxRestartsPerHour}. Check ~/work logs if it keeps failing.`,
  );
  return { shouldWake: false };
}
