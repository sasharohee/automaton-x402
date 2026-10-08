"use client";

// Le contenu de l'instantané vient d'un agent autonome : il est traité comme
// non fiable. Tout est affiché en texte (échappement React), sans HTML brut,
// sans lien ni image générés à partir du contenu. Chaque valeur passe par
// str()/num()/arr()/obj() pour qu'un champ manquant ou mal typé ne plante pas.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import BalanceChart from "./BalanceChart";
import {
  arr,
  fmtAgo,
  fmtAmount,
  fmtDateTime,
  fmtDuration,
  fmtNum,
  fmtSmart,
  fmtTime,
  fmtUsd,
  num,
  obj,
  parseTime,
  shortAddress,
  str,
} from "@/lib/format";
import type {
  AgentEvent,
  AgentInfo,
  ContainerInfo,
  DepositsInfo,
  EarningItem,
  EarningsInfo,
  Goal,
  Heartbeat,
  SpendInfo,
  StateResponse,
  WalletInfo,
  Warning,
} from "@/lib/types";

const POLL_MS = 15_000;
const ONLINE_MS = 2 * 60_000;
const TRUNCATE = 240;

const EVENT_KINDS: Record<string, { label: string; icon: string }> = {
  think: { label: "Réflexion", icon: "💭" },
  thought: { label: "Pensée", icon: "🧠" },
  tool: { label: "Outil appelé", icon: "🔧" },
  result: { label: "Résultat", icon: "📄" },
  state: { label: "État", icon: "🔄" },
  sleep: { label: "Veille", icon: "😴" },
  wake: { label: "Réveil", icon: "⏰" },
  loop: { label: "Boucle", icon: "🔁" },
  warn: { label: "Avertissement", icon: "⚠️" },
  error: { label: "Erreur", icon: "⛔" },
  info: { label: "Info", icon: "ℹ️" },
};

const CONTAINER_STATES: Record<string, string> = {
  running: "en marche",
  exited: "arrêté",
  created: "créé",
  restarting: "redémarrage",
  paused: "en pause",
  dead: "mort",
  removing: "suppression",
};

const LOOP_STATES: Record<string, string> = {
  running: "active",
  sleeping: "en veille",
  waking: "réveil en cours",
  setup: "initialisation",
  dead: "arrêtée",
  critical: "critique",
  low_compute: "économie",
};

const GOAL_STATES: Record<string, string> = {
  active: "actif",
  completed: "terminé",
  failed: "échoué",
  paused: "en pause",
};

const SOURCES: Record<string, string> = {
  memory: "mémoire",
  kv: "Redis",
  blob: "sauvegarde Blob",
  none: "aucune",
};

function isObject(x: unknown): boolean {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function safeKind(k: string | null): string {
  return k && Object.hasOwn(EVENT_KINDS, k) ? k : "info";
}

/** Heure de Paris correspondant au prochain minuit UTC (2 h l'été, 1 h l'hiver). */
function utcResetHourParis(nowMs: number): string {
  const d = new Date(nowMs);
  const nextUtcMidnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  const hour = new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris", hour: "numeric" })
    .formatToParts(nextUtcMidnight)
    .find((p) => p.type === "hour")?.value;
  return `${Number(hour ?? 0)} h`;
}

export default function Dashboard() {
  const [data, setData] = useState<StateResponse | null>(null);
  const [offset, setOffset] = useState(0); // serverNow - heure locale
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/state", { cache: "no-store" });
      if (res.status === 401) {
        window.location.replace("/login");
        return;
      }
      if (!res.ok) throw new Error(`Erreur ${res.status}`);
      const body = (await res.json()) as StateResponse;
      const serverNow = parseTime(body.serverNow);
      if (serverNow !== null) setOffset(serverNow - Date.now());
      setData(body);
      setFetchError(null);
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : "Erreur réseau");
    }
  }, []);

  useEffect(() => {
    void load();
    const poll = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, POLL_MS);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  async function logout() {
    await fetch("/api/logout", { method: "POST" }).catch(() => {});
    window.location.replace("/login");
  }

  const serverNow = now + offset;
  const snap = data?.snapshot ?? null;
  const s = obj<Record<string, unknown>>(snap);
  const agent = obj<AgentInfo>(s.agent);
  const container = obj<ContainerInfo>(agent.container);
  const wallet = obj<WalletInfo>(s.wallet);
  const spend = obj<SpendInfo>(s.spend);
  const earnings = isObject(s.earnings) ? obj<EarningsInfo>(s.earnings) : null;
  const warnings = arr<Warning>(s.warnings).map((w) => obj<Warning>(w));
  const goals = arr<Goal>(s.goals).map((g) => obj<Goal>(g));
  const heartbeats = arr<Heartbeat>(s.heartbeats).map((h) => obj<Heartbeat>(h));

  const history = useMemo(() => {
    const out: [number, number][] = [];
    for (const p of arr(snap?.balanceHistory)) {
      if (!Array.isArray(p)) continue;
      const t = num(p[0]);
      const v = num(p[1]);
      if (t !== null && v !== null) out.push([t * 1000, v]);
    }
    return out;
  }, [snap]);

  const receivedAt = parseTime(data?.receivedAt);
  const online = receivedAt !== null && serverNow - receivedAt < ONLINE_MS;

  if (!data) {
    return (
      <main className="center">
        <p className="muted">{fetchError ? `Chargement impossible : ${fetchError}` : "Chargement…"}</p>
      </main>
    );
  }

  return (
    <main className="page">
      <header className="topbar">
        <div>
          <h1>{str(agent.name) ?? "Automaton"}</h1>
          <p className="muted small">
            <span className={`pill ${online ? "ok" : "off"}`}>{online ? "En ligne" : "Hors ligne"}</span>{" "}
            {receivedAt !== null
              ? `Dernière mise à jour il y a ${fmtAgo(serverNow - receivedAt)}`
              : "Aucune donnée reçue"}
          </p>
        </div>
        <button type="button" className="secondary" onClick={logout}>
          Se déconnecter
        </button>
      </header>

      {fetchError && <div className="banner error">Serveur injoignable ({fetchError}) — nouvel essai dans 15 s.</div>}

      {warnings.length > 0 && (
        <section className="card alerts">
          <h2>Alertes</h2>
          <ul>
            {warnings
              .slice(-20)
              .reverse()
              .map((w, i) => (
                <li key={i} className={str(w.level) === "error" ? "lvl-error" : "lvl-warn"}>
                  <span className="time">{fmtSmart(parseTime(w.t), serverNow)}</span>
                  <span className="text">{str(w.text) ?? "—"}</span>
                </li>
              ))}
          </ul>
        </section>
      )}

      {!snap ? (
        <section className="card">
          <p className="muted">
            Aucun instantané disponible pour l&apos;instant. Le tableau se remplira dès le prochain envoi du
            pusher.
          </p>
        </section>
      ) : (
        <>
          <EarningsCard earnings={earnings} spend={spend} serverNow={serverNow} />

          <div className="grid">
            <StatusCard container={container} serverNow={serverNow} />
            <WalletCard wallet={wallet} serverNow={serverNow} />
            <SpendCard spend={spend} serverNow={serverNow} />
            <BrainCard agent={agent} serverNow={serverNow} />
          </div>

          <section className="card">
            <h2>Solde USDC</h2>
            <BalanceChart history={history} nowMs={serverNow} />
          </section>

          <div className="grid two">
            <section className="card">
              <h2>Objectifs</h2>
              {goals.length === 0 ? (
                <p className="muted">Aucun objectif.</p>
              ) : (
                <ul className="list">
                  {goals.map((g, i) => {
                    const status = str(g.status) ?? "inconnu";
                    const revenue = num(g.revenueUsd);
                    return (
                      <li key={i}>
                        <span className={`badge goal-${Object.hasOwn(GOAL_STATES, status) ? status : "other"}`}>
                          {GOAL_STATES[status] ?? status}
                        </span>
                        <span className="text">{str(g.title) ?? "(sans titre)"}</span>
                        {revenue !== null && revenue > 0 && <span className="muted small"> {fmtUsd(revenue)}</span>}
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
            <section className="card">
              <h2>Tâches planifiées</h2>
              {heartbeats.length === 0 ? (
                <p className="muted">Aucune tâche planifiée.</p>
              ) : (
                <ul className="list">
                  {heartbeats.map((h, i) => (
                    <li key={i}>
                      <span className={`badge ${h.enabled === false ? "goal-paused" : "goal-active"}`}>
                        {h.enabled === false ? "désactivée" : "activée"}
                      </span>
                      <span className="text">{str(h.name) ?? "(sans nom)"}</span>
                      {str(h.schedule) && <code className="small">{str(h.schedule)}</code>}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>

          <ActivityFeed events={arr<AgentEvent>(s.events)} serverNow={serverNow} />
        </>
      )}

      <footer className="muted small footer">
        Source : {SOURCES[data.source] ?? "—"}
        {snap && ` · instantané généré à ${fmtDateTime(parseTime(s.generatedAt))}`}
        {" · "}heures affichées en heure de Paris
      </footer>
    </main>
  );
}

// ---------------------------------------------------------------------------

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="row">
      <span className="muted">{label}</span>
      <span className="value">{children}</span>
    </div>
  );
}

function signed(x: number, unit: string): string {
  return `${x < 0 ? "−" : "+"}${fmtAmount(Math.abs(x))} ${unit}`;
}

function EarningsCard({
  earnings,
  spend,
  serverNow,
}: {
  earnings: Partial<EarningsInfo> | null;
  spend: Partial<SpendInfo>;
  serverNow: number;
}) {
  const e = earnings ?? {};
  const count = num(e.count);

  // Surbrillance passagère quand un nouveau paiement arrive entre deux rafraîchissements.
  const prevCount = useRef<number | null>(null);
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    if (count === null) return;
    const prev = prevCount.current;
    prevCount.current = count;
    if (prev === null || count <= prev) return;
    setFlash(true);
    const t = setTimeout(() => setFlash(false), 2500);
    return () => clearTimeout(t);
  }, [count]);

  if (!earnings) {
    return (
      <section className="card earnings">
        <h2>Gains</h2>
        <p className="muted">Données de gains pas encore disponibles.</p>
      </section>
    );
  }

  const unit = str(e.currency) ?? "USDC";
  const total = num(e.totalUsd);
  const today = num(e.todayUsd);
  const countToday = num(e.countToday);
  const last = isObject(e.last) ? obj<EarningItem>(e.last) : null;
  const lastAmount = last ? num(last.amountUsd) : null;
  const recent = arr<EarningItem>(e.recent)
    .filter(isObject)
    .map((r) => obj<EarningItem>(r))
    .slice(0, 10);
  const empty = count === 0 || (count === null && lastAmount === null && recent.length === 0);

  const spendToday = num(spend.todayUsd);
  const net = num(e.netTodayUsd) ?? (today !== null && spendToday !== null ? today - spendToday : null);

  const deposits = isObject(e.deposits) ? obj<DepositsInfo>(e.deposits) : null;
  const depositItems = deposits ? arr<EarningItem>(deposits.items).filter(isObject).map((d) => obj<EarningItem>(d)) : [];
  const depositCount = (deposits && num(deposits.count)) ?? depositItems.length;
  const lastDeposit = depositItems.reduce<number | null>((max, d) => {
    const t = parseTime(d.t);
    return t !== null && (max === null || t > max) ? t : max;
  }, null);

  const behind = num(e.behindBlocks);

  return (
    <section className={`card earnings${flash ? " flash" : ""}`}>
      <div className="earn-head">
        <h2>Gains</h2>
        <span className="muted small">en temps réel, vérifié toutes les minutes</span>
      </div>
      <div className="earn-grid">
        <div>
          <p className="big">
            {fmtAmount(total ?? (empty ? 0 : null))} <span className="unit">{unit}</span>
          </p>
          <p className="muted small">total gagné</p>
        </div>
        <div>
          <Row label="Gagné aujourd'hui">
            {fmtAmount(today ?? (empty ? 0 : null))} {unit}
          </Row>
          <Row label="Paiements reçus">
            {count !== null ? String(count) : "—"}
            {countToday !== null && ` (dont ${countToday} aujourd'hui)`}
          </Row>
          {!empty && (
            <Row label="Dernier paiement">
              {lastAmount !== null
                ? `${signed(lastAmount, unit)} à ${fmtSmart(parseTime(last?.t), serverNow)}`
                : "—"}
            </Row>
          )}
          <Row label="Résultat net du jour">
            {net !== null ? <span className={net >= 0 ? "pos" : "neg"}>{signed(net, "$")}</span> : "—"}
          </Row>
          <p className="muted small note">
            {e.dayIsUtc === false ? "jour local" : "jour UTC, comme les dépenses"}
          </p>
        </div>
      </div>

      {empty ? (
        <p className="earn-empty">Aucun gain pour l&apos;instant.</p>
      ) : (
        recent.length > 0 && (
          <>
            <h3 className="sub">Derniers paiements</h3>
            <ul className="list">
              {recent.map((r, i) => {
                const amount = num(r.amountUsd);
                return (
                  <li key={i}>
                    <span className="pos">{amount !== null ? signed(amount, unit) : "—"}</span>
                    <span className="time">{fmtSmart(parseTime(r.t), serverNow)}</span>
                    <span className="text muted small">
                      de <code>{shortAddress(str(r.from))}</code>
                    </span>
                  </li>
                );
              })}
            </ul>
          </>
        )
      )}

      {deposits && (
        <p className="muted small deposits">
          Apports du créateur : {fmtAmount(num(deposits.totalUsd))} {unit} ({depositCount}{" "}
          {depositCount > 1 ? "versements" : "versement"}), non comptés comme gains
          {lastDeposit !== null && ` · dernier le ${fmtDateTime(lastDeposit)}`}
        </p>
      )}

      <p className="muted small earn-foot">
        Vérifié {fmtSmart(parseTime(e.checkedAt), serverNow)}
        {e.error === true && (
          <span className="warn-text"> · Lecture on-chain des gains momentanément impossible</span>
        )}
        {behind !== null && behind > 300 && " · rattrapage en cours"}
      </p>
    </section>
  );
}

function StatusCard({ container, serverNow }: { container: Partial<ContainerInfo>; serverNow: number }) {
  const state = str(container.state);
  const started = parseTime(container.startedAt);
  const finished = parseTime(container.finishedAt);
  const running = state === "running";
  const exitCode = num(container.exitCode);
  return (
    <section className="card">
      <h2>Statut</h2>
      <Row label="Conteneur">
        <span className={`badge ${running ? "goal-active" : "goal-failed"}`}>
          {state ? (CONTAINER_STATES[state] ?? state) : "inconnu"}
        </span>
      </Row>
      {running && started !== null && <Row label="En fonctionnement depuis">{fmtDuration(serverNow - started)}</Row>}
      {started !== null && <Row label="Démarré">{fmtDateTime(started)}</Row>}
      {!running && finished !== null && <Row label="Arrêté">{fmtDateTime(finished)}</Row>}
      {!running && exitCode !== null && <Row label="Code de sortie">{String(exitCode)}</Row>}
      {str(container.image) && (
        <Row label="Image">
          <code>{str(container.image)}</code>
        </Row>
      )}
    </section>
  );
}

function WalletCard({ wallet, serverNow }: { wallet: Partial<WalletInfo>; serverNow: number }) {
  const address = str(wallet.address);
  return (
    <section className="card">
      <h2>Portefeuille</h2>
      <p className="big">
        {fmtNum(num(wallet.usdc), 2)} <span className="unit">USDC</span>
      </p>
      <Row label="ETH">{fmtNum(num(wallet.eth), 5)}</Row>
      <Row label="Adresse">
        <code title={address ?? undefined}>{shortAddress(address)}</code>
      </Row>
      <Row label="Vérifié">{fmtSmart(parseTime(wallet.checkedAt), serverNow)}</Row>
    </section>
  );
}

function SpendCard({ spend, serverNow }: { spend: Partial<SpendInfo>; serverNow: number }) {
  const today = num(spend.todayUsd);
  const cap = num(spend.capUsd);
  const pct = today !== null && cap !== null && cap > 0 ? (today / cap) * 100 : null;
  const level = pct === null ? "" : pct > 90 ? "danger" : pct > 70 ? "warn" : "";
  const calls = num(spend.inferenceCallsToday);
  return (
    <section className="card">
      <h2>Dépenses du jour</h2>
      <p className="big">
        {fmtUsd(today)} <span className="unit">/ {fmtUsd(cap)}</span>
      </p>
      <div
        className="bar"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct === null ? undefined : Math.round(pct)}
      >
        <div className={`fill ${level}`} style={{ width: `${Math.min(100, Math.max(0, pct ?? 0))}%` }} />
      </div>
      <p className="muted small">
        {pct !== null ? `${Math.round(pct)} % du plafond · ` : ""}
        {spend.dayIsUtc === false
          ? "jour local"
          : `jour UTC, remise à zéro à ${utcResetHourParis(serverNow)} (heure de Paris)`}
      </p>
      <Row label="Appels d'inférence">{calls !== null ? String(calls) : "—"}</Row>
      <Row label="Inférence aujourd'hui">{fmtUsd(num(spend.inferenceTodayUsd))}</Row>
      <Row label="Dernière heure">{fmtUsd(num(spend.lastHourUsd))}</Row>
    </section>
  );
}

function BrainCard({ agent, serverNow }: { agent: Partial<AgentInfo>; serverNow: number }) {
  const loop = str(agent.loopState);
  const sleepUntil = parseTime(agent.sleepUntil);
  const sleeping = sleepUntil !== null && sleepUntil > serverNow && (loop === null || loop === "sleeping");
  const turns = num(agent.turnsToday);
  return (
    <section className="card">
      <h2>Cerveau</h2>
      <Row label="Palier">{str(agent.tier) ?? "—"}</Row>
      <Row label="Modèle">
        <code>{str(agent.model) ?? "—"}</code>
      </Row>
      <Row label="Boucle">{loop ? (LOOP_STATES[loop] ?? loop) : "—"}</Row>
      {sleeping && (
        <p className="sleep">
          😴 En veille jusqu&apos;à {fmtTime(sleepUntil)} <span className="muted">(dans {fmtDuration(sleepUntil - serverNow)})</span>
        </p>
      )}
      <Row label="Tours aujourd'hui">{turns !== null ? String(turns) : "—"}</Row>
      <Row label="Dernière activité">{fmtSmart(parseTime(agent.lastActivityAt), serverNow)}</Row>
    </section>
  );
}

function ActivityFeed({ events, serverNow }: { events: AgentEvent[]; serverNow: number }) {
  const [filter, setFilter] = useState("all");
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  const items = useMemo(() => {
    const out: { id: string; t: number | null; kind: string; text: string }[] = [];
    const seen = new Map<string, number>();
    for (const raw of events) {
      const e = obj<AgentEvent>(raw);
      const text = (str(e.text) ?? "").slice(0, 20_000);
      const tRaw = str(e.t) ?? "";
      const kind = safeKind(str(e.kind));
      const base = `${tRaw}|${kind}|${text.length}|${text.slice(0, 32)}`;
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      out.push({ id: `${base}#${n}`, t: parseTime(tRaw), kind, text });
    }
    return out.reverse();
  }, [events]);

  const present = useMemo(() => Array.from(new Set(items.map((i) => i.kind))), [items]);
  const shown = filter === "all" ? items : items.filter((i) => i.kind === filter);

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <section className="card">
      <div className="feed-head">
        <h2>Fil d&apos;activité</h2>
        <select value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filtrer par type">
          <option value="all">Tous les types</option>
          {present.map((k) => (
            <option key={k} value={k}>
              {EVENT_KINDS[k].label}
            </option>
          ))}
        </select>
      </div>
      {shown.length === 0 ? (
        <p className="muted">Aucun événement.</p>
      ) : (
        <ul className="feed">
          {shown.map((ev) => {
            const meta = EVENT_KINDS[ev.kind];
            const long = ev.text.length > TRUNCATE;
            const open = expanded.has(ev.id);
            return (
              <li key={ev.id} className={`ev ev-${ev.kind}`}>
                <div className="ev-meta">
                  <span className="ev-kind" title={meta.label}>
                    <span aria-hidden="true">{meta.icon}</span> {meta.label}
                  </span>
                  <span className="time">{fmtSmart(ev.t, serverNow)}</span>
                </div>
                <p className="ev-text">
                  {long && !open ? `${ev.text.slice(0, TRUNCATE)}…` : ev.text || "—"}
                </p>
                {long && (
                  <button type="button" className="link" onClick={() => toggle(ev.id)}>
                    {open ? "voir moins" : "voir plus"}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
