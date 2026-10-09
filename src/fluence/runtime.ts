/**
 * Fluence runtime: auth + VM client + billing + SSH, built once per
 * database (i.e. per agent process) and shared by the provider client, the
 * tools and the heartbeat.
 */

import type Database from "better-sqlite3";
import type { PrivateKeyAccount } from "viem";
import type { AutomatonConfig } from "../types.js";
import { SpendTracker } from "../agent/spend-tracker.js";
import { resolveTreasuryPolicy, readWalletBalanceCents } from "../conway/provider.js";
import { FluenceAuth } from "./auth.js";
import { FluenceBilling } from "./billing.js";
import { FluenceVmClient } from "./client.js";
import { FluenceSsh, type SshTransport } from "./ssh.js";
import { isFluenceEnabled, resolveFluenceConfig } from "./config.js";

export interface FluenceRuntime {
  auth: FluenceAuth;
  vms: FluenceVmClient;
  billing: FluenceBilling;
  ssh: FluenceSsh;
}

export interface FluenceRuntimeParams {
  config: AutomatonConfig;
  account: PrivateKeyAccount;
  db: Database.Database;
  /** Test overrides. */
  fetchImpl?: typeof fetch;
  sshTransport?: SshTransport;
  sshDir?: string;
  credentialsPath?: string;
  getWalletBalanceCents?: () => Promise<number>;
}

const runtimes = new WeakMap<object, FluenceRuntime>();

export function createFluenceRuntime(params: FluenceRuntimeParams): FluenceRuntime {
  const fluence = resolveFluenceConfig(params.config);
  const policy = resolveTreasuryPolicy(params.config);
  const auth = new FluenceAuth({
    account: params.account,
    apiUrl: fluence.apiUrl,
    fetchImpl: params.fetchImpl,
    credentialsPath: params.credentialsPath,
  });
  const ssh = new FluenceSsh({ transport: params.sshTransport, sshDir: params.sshDir });
  const vms = new FluenceVmClient({ auth, db: params.db, policy, config: fluence, ssh });
  const billing = new FluenceBilling({
    account: params.account,
    apiUrl: fluence.apiUrl,
    policy,
    spendTracker: new SpendTracker(params.db),
    getBalanceCents: params.getWalletBalanceCents ?? (() => readWalletBalanceCents(params.account.address)),
    authHeaders: () => auth.authHeaders(),
    fetchImpl: params.fetchImpl,
  });
  return { auth, vms, billing, ssh };
}

/** The shared runtime for this database, or null when Fluence is disabled. */
export function getFluenceRuntime(params: FluenceRuntimeParams): FluenceRuntime | null {
  if (!isFluenceEnabled(params.config)) return null;
  let runtime = runtimes.get(params.db);
  if (!runtime) {
    runtime = createFluenceRuntime(params);
    runtimes.set(params.db, runtime);
  }
  return runtime;
}

/** Tests: inject a runtime built with mocks. */
export function setFluenceRuntime(db: Database.Database, runtime: FluenceRuntime | null): void {
  if (runtime) runtimes.set(db, runtime);
  else runtimes.delete(db);
}
