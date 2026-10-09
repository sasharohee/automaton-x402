// Vérification, côté serveur, du service public de l'agent (sa VM), indépendante
// du pusher. Le corps de la réponse n'est jamais lu : il vient d'un service
// contrôlé par l'agent et est traité comme non fiable.

import type { ServiceStatus } from "./types";

const DEFAULT_URL = "http://81.15.150.181:8787/health";
const TIMEOUT_MS = 4000;
const CACHE_MS = 30_000;

let cached: { at: number; status: ServiceStatus } | null = null;
let inFlight: Promise<ServiceStatus> | null = null;

function healthUrl(): string {
  return process.env.SERVICE_HEALTH_URL?.trim() || DEFAULT_URL;
}

/** `host:port` seulement, sans chemin ni paramètres. */
function targetOf(url: URL): string {
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  return `${url.hostname}:${port}`;
}

async function runCheck(): Promise<ServiceStatus> {
  const checkedAt = () => new Date().toISOString();

  let url: URL;
  try {
    url = new URL(healthUrl());
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error();
  } catch {
    return { ok: false, httpStatus: null, latencyMs: null, checkedAt: checkedAt(), target: "—", error: "URL invalide" };
  }
  const target = targetOf(url);

  const started = Date.now();
  try {
    const res = await fetch(url, {
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const latencyMs = Date.now() - started;
    await res.body?.cancel().catch(() => {});
    const ok = res.status >= 200 && res.status < 300;
    return {
      ok,
      httpStatus: res.status,
      latencyMs,
      checkedAt: checkedAt(),
      target,
      ...(ok ? {} : { error: `HTTP ${res.status}` }),
    };
  } catch (err) {
    const name = (err as { name?: unknown } | null)?.name;
    const timedOut = name === "TimeoutError" || name === "AbortError";
    return {
      ok: false,
      httpStatus: null,
      latencyMs: null,
      checkedAt: checkedAt(),
      target,
      error: timedOut ? "délai dépassé" : "injoignable",
    };
  }
}

/** Résultat mis en cache 30 s ; les vérifications simultanées partagent la même promesse. Ne lève jamais. */
export async function checkService(): Promise<ServiceStatus> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.status;
  if (!inFlight) {
    inFlight = runCheck()
      .catch(
        (): ServiceStatus => ({
          ok: false,
          httpStatus: null,
          latencyMs: null,
          checkedAt: new Date().toISOString(),
          target: "—",
          error: "vérification impossible",
        }),
      )
      .then((status) => {
        cached = { at: Date.now(), status };
        return status;
      })
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}
