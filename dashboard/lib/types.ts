// Format v1 de l'instantané poussé par la machine de l'agent.
// Tous les champs peuvent manquer ou valoir null : le contenu vient d'un agent
// autonome et doit être traité comme non fiable.

export type Nullable<T> = T | null | undefined;

export interface ContainerInfo {
  state?: Nullable<string>;
  startedAt?: Nullable<string>;
  finishedAt?: Nullable<string>;
  exitCode?: Nullable<number>;
  image?: Nullable<string>;
}

export interface AgentInfo {
  name?: Nullable<string>;
  container?: Nullable<ContainerInfo>;
  loopState?: Nullable<string>;
  sleepUntil?: Nullable<string>;
  tier?: Nullable<string>;
  model?: Nullable<string>;
  lastActivityAt?: Nullable<string>;
  turnsToday?: Nullable<number>;
}

export interface WalletInfo {
  address?: Nullable<string>;
  usdc?: Nullable<number>;
  eth?: Nullable<number>;
  checkedAt?: Nullable<string>;
}

export interface SpendInfo {
  day?: Nullable<string>;
  dayIsUtc?: Nullable<boolean>;
  todayUsd?: Nullable<number>;
  capUsd?: Nullable<number>;
  inferenceTodayUsd?: Nullable<number>;
  inferenceCallsToday?: Nullable<number>;
  lastHourUsd?: Nullable<number>;
}

export interface Goal {
  title?: Nullable<string>;
  status?: Nullable<string>;
  createdAt?: Nullable<string>;
  revenueUsd?: Nullable<number>;
}

export interface Heartbeat {
  name?: Nullable<string>;
  schedule?: Nullable<string>;
  enabled?: Nullable<boolean>;
}

export interface AgentEvent {
  t?: Nullable<string>;
  kind?: Nullable<string>;
  text?: Nullable<string>;
}

export interface Warning {
  t?: Nullable<string>;
  level?: Nullable<string>;
  text?: Nullable<string>;
}

export interface EarningItem {
  t?: Nullable<string>;
  amountUsd?: Nullable<number>;
  from?: Nullable<string>;
}

export interface DepositsInfo {
  totalUsd?: Nullable<number>;
  count?: Nullable<number>;
  items?: Nullable<EarningItem[]>;
}

/** Gains lus on-chain par le pusher (transferts USDC entrants). Les apports du créateur sont dans `deposits`. */
export interface EarningsInfo {
  currency?: Nullable<string>;
  totalUsd?: Nullable<number>;
  todayUsd?: Nullable<number>;
  day?: Nullable<string>;
  dayIsUtc?: Nullable<boolean>;
  count?: Nullable<number>;
  countToday?: Nullable<number>;
  last?: Nullable<EarningItem>;
  recent?: Nullable<EarningItem[]>;
  netTodayUsd?: Nullable<number>;
  deposits?: Nullable<DepositsInfo>;
  trackingSince?: Nullable<string>;
  checkedAt?: Nullable<string>;
  behindBlocks?: Nullable<number>;
  error?: Nullable<boolean>;
  checkEverySec?: Nullable<number>;
}

export interface Snapshot {
  v: 1;
  kind: "full";
  hash?: Nullable<string>;
  generatedAt?: Nullable<string>;
  agent?: Nullable<AgentInfo>;
  wallet?: Nullable<WalletInfo>;
  spend?: Nullable<SpendInfo>;
  earnings?: Nullable<EarningsInfo>;
  balanceHistory?: Nullable<unknown[]>;
  goals?: Nullable<Goal[]>;
  heartbeats?: Nullable<Heartbeat[]>;
  events?: Nullable<AgentEvent[]>;
  warnings?: Nullable<Warning[]>;
  pusher?: Nullable<{ version?: Nullable<string>; intervalSec?: Nullable<number> }>;
}

export type StateSource = "memory" | "kv" | "blob" | "none";

/** Statut du service public, vérifié par le serveur du tableau de bord (pas par le pusher). */
export interface ServiceStatus {
  ok: boolean;
  httpStatus: number | null;
  latencyMs: number | null;
  checkedAt: string;
  /** `host:port` uniquement. */
  target: string;
  /** Libellé générique en français, jamais un message d'exception brut. */
  error?: string;
}

export interface StateResponse {
  snapshot: Snapshot | null;
  receivedAt: string | null;
  serverNow: string;
  source: StateSource;
  service?: ServiceStatus | null;
}
