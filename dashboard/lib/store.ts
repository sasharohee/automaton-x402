// Stockage du dernier instantané, pensé pour rester dans les quotas gratuits :
//  1. mémoire du module (Fluid compute réutilise l'instance entre requêtes) ;
//  2. Redis Upstash via son API REST, si configuré (1 commande par écriture/lecture) ;
//  3. sinon Vercel Blob privé, écrit au plus une fois par heure et relu une seule
//     fois au démarrage d'une instance vide. Jamais de list().
//
// Ce module ne doit être importé que par app/api/[action]/route.ts afin que
// l'ingestion et la lecture partagent la même variable en mémoire.

import { get, put } from "@vercel/blob";
import type { Snapshot, StateResponse, StateSource } from "./types";

const KV_LATEST = "automaton:latest";
const KV_RECEIVED = "automaton:received";
const KV_HASH = "automaton:hash";
const BLOB_PATH = "automaton/latest.json";
const BLOB_MIN_INTERVAL_MS = 60 * 60 * 1000;

// Met à jour automaton:received seulement si le hash stocké correspond.
const HEARTBEAT_SCRIPT =
  "if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('SET', KEYS[2], ARGV[2]) return 1 else return 0 end";

interface MemoryState {
  snapshot: Snapshot | null;
  hash: string | null;
  receivedAt: number | null;
  origin: "ingest" | "blob" | null;
  blobLoaded: boolean;
  lastBlobWrite: number;
}

const mem: MemoryState = {
  snapshot: null,
  hash: null,
  receivedAt: null,
  origin: null,
  blobLoaded: false,
  lastBlobWrite: 0,
};

// ---------------------------------------------------------------------------
// Configuration

function kvConfig(): { url: string; token: string } | null {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url: url.replace(/\/+$/, ""), token } : null;
}

function blobConfigured(): boolean {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
}

async function kv(command: (string | number)[]): Promise<unknown> {
  const cfg = kvConfig();
  if (!cfg) throw new Error("Redis non configuré");
  const res = await fetch(cfg.url, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(command),
    cache: "no-store",
    signal: AbortSignal.timeout(5000),
  });
  const data = (await res.json().catch(() => null)) as { result?: unknown; error?: string } | null;
  if (!res.ok || !data || data.error) {
    throw new Error(`Redis ${command[0]} : ${data?.error ?? res.status}`);
  }
  return data.result;
}

// ---------------------------------------------------------------------------
// Blob (point de sauvegarde)

async function loadBlobOnce(): Promise<void> {
  if (mem.blobLoaded || mem.snapshot || !blobConfigured()) return;
  mem.blobLoaded = true;
  try {
    const res = await get(BLOB_PATH, { access: "private", useCache: false });
    if (!res || res.statusCode !== 200) return;
    const stored = (await new Response(res.stream).json()) as {
      receivedAt?: unknown;
      snapshot?: unknown;
    };
    const snapshot = stored?.snapshot;
    // Un envoi arrivé pendant la lecture est prioritaire.
    if (mem.snapshot || !isFullSnapshot(snapshot)) return;
    const receivedAt = typeof stored.receivedAt === "string" ? Date.parse(stored.receivedAt) : NaN;
    mem.snapshot = snapshot;
    mem.hash = typeof snapshot.hash === "string" ? snapshot.hash : null;
    mem.receivedAt = Number.isFinite(receivedAt) ? receivedAt : null;
    mem.origin = "blob";
    mem.lastBlobWrite = res.blob.uploadedAt.getTime();
  } catch (err) {
    console.error("Lecture Blob impossible", err);
  }
}

async function maybeWriteBlob(now: number): Promise<void> {
  if (!blobConfigured() || now - mem.lastBlobWrite < BLOB_MIN_INTERVAL_MS) return;
  mem.lastBlobWrite = now;
  try {
    await put(
      BLOB_PATH,
      JSON.stringify({ receivedAt: new Date(now).toISOString(), snapshot: mem.snapshot }),
      {
        access: "private",
        addRandomSuffix: false,
        allowOverwrite: true,
        contentType: "application/json",
      },
    );
  } catch (err) {
    console.error("Écriture Blob impossible", err);
  }
}

// ---------------------------------------------------------------------------
// API publique

export function isFullSnapshot(x: unknown): x is Snapshot {
  return (
    typeof x === "object" &&
    x !== null &&
    !Array.isArray(x) &&
    (x as { v?: unknown }).v === 1 &&
    (x as { kind?: unknown }).kind === "full"
  );
}

export type StorageLabel = "memory+kv" | "memory+blob" | "memory";

export async function storeFull(snapshot: Snapshot, hash: string): Promise<StorageLabel> {
  const now = Date.now();
  mem.snapshot = snapshot;
  mem.hash = hash;
  mem.receivedAt = now;
  mem.origin = "ingest";
  mem.blobLoaded = true;

  if (kvConfig()) {
    try {
      await kv(["MSET", KV_LATEST, JSON.stringify(snapshot), KV_HASH, hash, KV_RECEIVED, new Date(now).toISOString()]);
      return "memory+kv";
    } catch (err) {
      console.error("Écriture Redis impossible", err);
      return "memory";
    }
  }
  if (blobConfigured()) {
    await maybeWriteBlob(now);
    return "memory+blob";
  }
  return "memory";
}

/** Retourne true si l'instantané correspondant au hash est connu (receivedAt mis à jour). */
export async function storeHeartbeat(hash: string): Promise<boolean> {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const memMatches = mem.snapshot !== null && mem.hash === hash;
  if (memMatches) mem.receivedAt = now;

  if (kvConfig()) {
    try {
      if (memMatches) {
        await kv(["SET", KV_RECEIVED, nowIso]);
        return true;
      }
      return (await kv(["EVAL", HEARTBEAT_SCRIPT, 2, KV_HASH, KV_RECEIVED, hash, nowIso])) === 1;
    } catch (err) {
      console.error("Battement Redis impossible", err);
      return memMatches;
    }
  }
  if (memMatches) return true;

  await loadBlobOnce();
  if (mem.snapshot !== null && mem.hash === hash) {
    mem.receivedAt = now;
    mem.origin = "ingest";
    return true;
  }
  return false;
}

export async function readState(): Promise<StateResponse> {
  const serverNow = new Date().toISOString();
  const fromMemory = (): StateResponse => {
    const source: StateSource = !mem.snapshot ? "none" : mem.origin === "blob" ? "blob" : "memory";
    return {
      snapshot: mem.snapshot,
      receivedAt: mem.receivedAt !== null ? new Date(mem.receivedAt).toISOString() : null,
      serverNow,
      source,
    };
  };

  if (kvConfig()) {
    try {
      const result = await kv(["MGET", KV_LATEST, KV_RECEIVED]);
      const [raw, received] = Array.isArray(result) ? result : [];
      const snapshot = typeof raw === "string" ? (JSON.parse(raw) as unknown) : null;
      if (isFullSnapshot(snapshot)) {
        return {
          snapshot,
          receivedAt: typeof received === "string" ? received : null,
          serverNow,
          source: "kv",
        };
      }
    } catch (err) {
      console.error("Lecture Redis impossible", err);
    }
    return fromMemory();
  }

  await loadBlobOnce();
  return fromMemory();
}
