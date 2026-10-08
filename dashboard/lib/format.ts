// Petits utilitaires d'affichage, tolérants aux valeurs manquantes.
// Toutes les heures sont affichées dans le fuseau Europe/Paris.

const TZ = "Europe/Paris";

const timeFmt = new Intl.DateTimeFormat("fr-FR", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
const timeSecFmt = new Intl.DateTimeFormat("fr-FR", {
  timeZone: TZ,
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});
const dateTimeFmt = new Intl.DateTimeFormat("fr-FR", {
  timeZone: TZ,
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});
const dayFmt = new Intl.DateTimeFormat("fr-FR", { timeZone: TZ, day: "2-digit", month: "2-digit" });
const dayKeyFmt = new Intl.DateTimeFormat("fr-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });

export function str(x: unknown): string | null {
  return typeof x === "string" && x.length > 0 ? x : null;
}

export function num(x: unknown): number | null {
  return typeof x === "number" && Number.isFinite(x) ? x : null;
}

export function arr<T = unknown>(x: unknown): T[] {
  return Array.isArray(x) ? (x as T[]) : [];
}

export function obj<T extends object>(x: unknown): Partial<T> {
  return typeof x === "object" && x !== null && !Array.isArray(x) ? (x as Partial<T>) : {};
}

export function parseTime(x: unknown): number | null {
  const s = str(x);
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

export function fmtTime(ms: number | null, seconds = false): string {
  if (ms === null) return "—";
  return (seconds ? timeSecFmt : timeFmt).format(ms);
}

export function fmtDateTime(ms: number | null): string {
  return ms === null ? "—" : dateTimeFmt.format(ms);
}

export function fmtDay(ms: number): string {
  return dayFmt.format(ms);
}

/** Heure ou date+heure selon que l'instant est aujourd'hui (à Paris) ou non. */
export function fmtSmart(ms: number | null, nowMs: number): string {
  if (ms === null) return "—";
  return dayKeyFmt.format(ms) === dayKeyFmt.format(nowMs) ? fmtTime(ms, true) : fmtDateTime(ms);
}

export function fmtDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (d > 0) return `${d} j ${h} h`;
  if (h > 0) return `${h} h ${String(m).padStart(2, "0")} min`;
  if (m > 0) return `${m} min ${String(s).padStart(2, "0")} s`;
  return `${s} s`;
}

export function fmtAgo(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return `${sec} s`;
  return fmtDuration(ms);
}

export function fmtNum(x: number | null, digits = 2): string {
  if (x === null) return "—";
  return new Intl.NumberFormat("fr-FR", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(x);
}

export function fmtUsd(x: number | null, digits = 2): string {
  return x === null ? "—" : `${fmtNum(x, digits)} $`;
}

export function shortAddress(x: string | null): string {
  if (!x) return "—";
  return x.length > 14 ? `${x.slice(0, 6)}…${x.slice(-4)}` : x;
}
