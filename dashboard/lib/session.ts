// Session signée (cookie « <expiration>.<HMAC-SHA256 hex> »).
// Uniquement Web Crypto : utilisable dans le proxy, les routes et les pages.

export const SESSION_COOKIE = "automaton_session";
export const SESSION_MAX_AGE_SEC = 30 * 24 * 60 * 60;

const encoder = new TextEncoder();

export function dashboardPassword(): string | null {
  const p = process.env.DASHBOARD_PASSWORD;
  return p ? p : null;
}

// La clé dépend du mot de passe et du jeton d'ingestion : changer l'un ou
// l'autre invalide toutes les sessions existantes.
async function sessionKey(password: string): Promise<CryptoKey> {
  const material = `automaton-dashboard-session:v1\n${password}\n${process.env.INGEST_TOKEN ?? ""}`;
  const raw = await crypto.subtle.digest("SHA-256", encoder.encode(material));
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex: string): Uint8Array<ArrayBuffer> | null {
  if (hex.length !== 64 || !/^[0-9a-f]+$/.test(hex)) return null;
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export async function createSessionValue(password: string, nowMs = Date.now()): Promise<string> {
  const exp = String(Math.floor(nowMs / 1000) + SESSION_MAX_AGE_SEC);
  const sig = await crypto.subtle.sign("HMAC", await sessionKey(password), encoder.encode(exp));
  return `${exp}.${toHex(sig)}`;
}

export async function verifySessionValue(
  value: string | undefined | null,
  nowMs = Date.now(),
): Promise<boolean> {
  const password = dashboardPassword();
  if (!password || !value || value.length > 200) return false;
  const dot = value.indexOf(".");
  if (dot <= 0) return false;
  const exp = value.slice(0, dot);
  if (!/^\d{1,12}$/.test(exp) || Number(exp) * 1000 <= nowMs) return false;
  const sig = fromHex(value.slice(dot + 1));
  if (!sig) return false;
  // subtle.verify compare la signature à temps constant.
  return crypto.subtle.verify("HMAC", await sessionKey(password), sig, encoder.encode(exp));
}
