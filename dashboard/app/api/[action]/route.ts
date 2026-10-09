// Toutes les routes API sont dans ce seul fichier pour que l'ingestion et la
// lecture partagent la même instance (et donc le même état en mémoire).
//   POST /api/ingest   POST /api/login   POST /api/logout   GET /api/state

import { createHash, timingSafeEqual } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { NextResponse, type NextRequest } from "next/server";
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE_SEC,
  createSessionValue,
  dashboardPassword,
  verifySessionValue,
} from "@/lib/session";
import { checkService } from "@/lib/service";
import { isFullSnapshot, readState, storeFull, storeHeartbeat } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const NO_STORE = { "Cache-Control": "no-store" };

type Ctx = { params: Promise<{ action: string }> };

function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

class TooLarge extends Error {}

async function readBody(req: NextRequest, limit: number): Promise<Buffer> {
  if (!req.body) return Buffer.alloc(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      throw new TooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------

async function ingest(req: NextRequest): Promise<NextResponse> {
  const token = process.env.INGEST_TOKEN;
  if (!token) return json({ ok: false, error: "INGEST_TOKEN non configuré" }, 503);

  const auth = req.headers.get("authorization") ?? "";
  const provided = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!safeEqual(provided, token)) return json({ ok: false, error: "non autorisé" }, 401);

  let body: Buffer;
  try {
    body = await readBody(req, MAX_BODY_BYTES);
    const encoding = (req.headers.get("content-encoding") ?? "").toLowerCase();
    // Si la plateforme a déjà décompressé le corps, l'en-tête peut subsister :
    // on vérifie la signature gzip avant de décompresser.
    if (encoding.includes("gzip") && body[0] === 0x1f && body[1] === 0x8b) {
      body = gunzipSync(body, { maxOutputLength: MAX_BODY_BYTES });
    }
  } catch (err) {
    if (err instanceof TooLarge || (err as { code?: string }).code === "ERR_BUFFER_TOO_LARGE") {
      return json({ ok: false, error: "corps trop volumineux (2 Mo max)" }, 413);
    }
    return json({ ok: false, error: "corps illisible" }, 400);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(body.toString("utf8"));
  } catch {
    return json({ ok: false, error: "JSON invalide" }, 400);
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return json({ ok: false, error: "objet JSON attendu" }, 400);
  }
  const p = payload as { v?: unknown; kind?: unknown; hash?: unknown };
  if (p.v !== 1) return json({ ok: false, error: "version non prise en charge (v doit valoir 1)" }, 400);

  if (p.kind === "heartbeat") {
    if (typeof p.hash !== "string" || !p.hash) return json({ ok: false, error: "hash manquant" }, 400);
    const known = await storeHeartbeat(p.hash);
    return known ? json({ ok: true }) : json({ ok: false, needFull: true }, 409);
  }

  if (!isFullSnapshot(payload)) return json({ ok: false, error: "kind doit valoir full ou heartbeat" }, 400);
  const hash =
    typeof payload.hash === "string" && payload.hash
      ? payload.hash
      : createHash("sha256").update(body).digest("hex");
  const storage = await storeFull(payload, hash);
  return json({ ok: true, storage });
}

async function state(req: NextRequest): Promise<NextResponse> {
  if (!dashboardPassword()) return json({ error: "DASHBOARD_PASSWORD non configuré" }, 503);
  if (!(await verifySessionValue(req.cookies.get(SESSION_COOKIE)?.value))) {
    return json({ error: "non authentifié" }, 401);
  }
  const [current, service] = await Promise.all([readState(), checkService()]);
  return json({ ...current, service });
}

async function login(req: NextRequest): Promise<NextResponse> {
  const password = dashboardPassword();
  if (!password) return json({ ok: false, error: "DASHBOARD_PASSWORD non configuré" }, 503);

  let provided = "";
  try {
    const raw = await readBody(req, 4096);
    const data = JSON.parse(raw.toString("utf8")) as { password?: unknown };
    if (typeof data?.password === "string") provided = data.password;
  } catch {
    // corps invalide : traité comme un mauvais mot de passe
  }

  if (!safeEqual(provided, password)) {
    await new Promise((r) => setTimeout(r, 1000));
    return json({ ok: false, error: "Mot de passe incorrect" }, 401);
  }

  const res = json({ ok: true });
  res.cookies.set(SESSION_COOKIE, await createSessionValue(password), {
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    path: "/",
    maxAge: SESSION_MAX_AGE_SEC,
  });
  return res;
}

function logout(): NextResponse {
  const res = json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", {
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    path: "/",
    maxAge: 0,
  });
  return res;
}

// ---------------------------------------------------------------------------

export async function POST(req: NextRequest, { params }: Ctx): Promise<NextResponse> {
  const { action } = await params;
  switch (action) {
    case "ingest":
      return ingest(req);
    case "login":
      return login(req);
    case "logout":
      return logout();
    default:
      return json({ error: "introuvable" }, 404);
  }
}

export async function GET(req: NextRequest, { params }: Ctx): Promise<NextResponse> {
  const { action } = await params;
  if (action === "state") return state(req);
  return json({ error: "introuvable" }, 404);
}
