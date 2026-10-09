/**
 * sandbox_upload guard: which local files may be copied to the Fluence VM.
 *
 * Only real paths (symlinks followed) under ~/work are allowed. Refused:
 * anything under ~/.automaton (wallet, state, keys, fluence.json), /proc,
 * wallet*.json, *.key, *.pem, .env*, and any file whose content looks like a
 * private key (PEM block or a 0x-prefixed 64-hex key). Directories are
 * checked file by file; symlinks inside node_modules that point outside
 * ~/work are skipped, any other escaping symlink refuses the upload.
 */

import fs from "fs";
import path from "path";

export const MAX_UPLOAD_FILES = 2000;
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
/** Files above this size are not scanned for keys; they are refused. */
export const MAX_SCANNED_FILE_BYTES = 10 * 1024 * 1024;

export interface UploadGuardOptions {
  home: string;
  /** ~/work */
  workRoot: string;
}

export interface UploadFile {
  /** Real absolute path. */
  absPath: string;
  /** Path relative to the upload source (a single file: its basename). */
  relPath: string;
  size: number;
}

export type UploadPlan = { ok: true; isDirectory: boolean; files: UploadFile[]; skipped: string[] } | { ok: false; error: string };

const PRIVATE_KEY_PATTERNS = [/-----BEGIN [A-Z0-9 ]*-----/, /(?<![0-9a-fA-F])0x[0-9a-fA-F]{64}(?![0-9a-fA-F])/];

export function isForbiddenFileName(name: string): boolean {
  const n = name.toLowerCase();
  return (
    /^wallet.*\.json$/.test(n) ||
    n === "fluence.json" ||
    n.endsWith(".key") ||
    n.endsWith(".pem") ||
    n.startsWith(".env") ||
    /^id_(rsa|ecdsa|ed25519|dsa)/.test(n) ||
    n.includes("fluence_ed25519")
  );
}

export function looksLikePrivateKey(content: string): boolean {
  return PRIVATE_KEY_PATTERNS.some((p) => p.test(content));
}

function within(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent + path.sep);
}

function realOrNull(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

function expandHome(p: string, home: string): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return path.join(home, p.slice(2));
  return p;
}

/** Refusal reason for one real path, or null. */
function checkRealPath(real: string, opts: { automatonDir: string; workReal: string }): string | null {
  if (within(real, opts.automatonDir)) return "is inside ~/.automaton (wallet, state, keys)";
  if (within(real, "/proc")) return "is inside /proc";
  if (!within(real, opts.workReal)) return "is outside ~/work";
  if (real.split(path.sep).some((seg) => isForbiddenFileName(seg))) return "has a secret-looking name (wallet*.json, *.key, *.pem, .env*)";
  return null;
}

function checkContent(real: string, size: number): string | null {
  if (size > MAX_SCANNED_FILE_BYTES) return `is larger than ${MAX_SCANNED_FILE_BYTES} bytes`;
  try {
    const content = fs.readFileSync(real, "latin1");
    if (looksLikePrivateKey(content)) return "looks like it contains a private key";
  } catch {
    return "cannot be read";
  }
  return null;
}

/**
 * Build the list of files to upload, or refuse. Pure filesystem checks,
 * no network.
 */
export function planUpload(localPath: string, opts: UploadGuardOptions): UploadPlan {
  if (typeof localPath !== "string" || !localPath.trim()) return { ok: false, error: "local_path is required" };
  const home = path.resolve(opts.home);
  const automatonDir = realOrNull(path.join(home, ".automaton")) ?? path.join(home, ".automaton");
  const workReal = realOrNull(opts.workRoot);
  if (!workReal) return { ok: false, error: "~/work does not exist" };

  const expanded = path.resolve(opts.workRoot, expandHome(localPath.trim(), home));
  // Lexical check first (catches ~/.automaton even if it does not exist).
  if (within(expanded, path.join(home, ".automaton")) || within(expanded, "/proc")) {
    return { ok: false, error: `Refused: ${localPath} is inside ~/.automaton or /proc` };
  }
  const real = realOrNull(expanded);
  if (!real) return { ok: false, error: `Refused: ${localPath} does not exist` };
  const ctx = { automatonDir, workReal };
  const rootRefusal = checkRealPath(real, ctx);
  if (rootRefusal) return { ok: false, error: `Refused: ${localPath} ${rootRefusal}` };

  const stat = fs.statSync(real);
  if (stat.isFile()) {
    const contentRefusal = checkContent(real, stat.size);
    if (contentRefusal) return { ok: false, error: `Refused: ${localPath} ${contentRefusal}` };
    return { ok: true, isDirectory: false, files: [{ absPath: real, relPath: path.basename(real), size: stat.size }], skipped: [] };
  }
  if (!stat.isDirectory()) return { ok: false, error: `Refused: ${localPath} is not a regular file or directory` };

  const files: UploadFile[] = [];
  const skipped: string[] = [];
  let total = 0;
  const walk = (dirReal: string, rel: string): string | null => {
    for (const entry of fs.readdirSync(dirReal, { withFileTypes: true })) {
      const entryRel = rel ? path.join(rel, entry.name) : entry.name;
      const entryPath = path.join(dirReal, entry.name);
      const inNodeModules = entryRel.split(path.sep).includes("node_modules");
      let entryReal = entryPath;
      if (entry.isSymbolicLink()) {
        const target = realOrNull(entryPath);
        const escapes = !target || checkRealPath(target, ctx) !== null;
        if (escapes && inNodeModules) {
          skipped.push(entryRel);
          continue;
        }
        if (!target) return `${entryRel} is a broken symlink`;
        entryReal = target;
      }
      const refusal = checkRealPath(entryReal, ctx);
      if (refusal) return `${entryRel} ${refusal}`;
      if (isForbiddenFileName(entry.name)) return `${entryRel} has a secret-looking name`;
      const st = fs.statSync(entryReal);
      if (st.isDirectory()) {
        if (entry.isSymbolicLink()) {
          // Do not follow directory symlinks (loops); upload them as nothing.
          skipped.push(entryRel);
          continue;
        }
        const err = walk(entryReal, entryRel);
        if (err) return err;
      } else if (st.isFile()) {
        const contentRefusal = checkContent(entryReal, st.size);
        if (contentRefusal) return `${entryRel} ${contentRefusal}`;
        total += st.size;
        files.push({ absPath: entryReal, relPath: entryRel, size: st.size });
        if (files.length > MAX_UPLOAD_FILES) return `more than ${MAX_UPLOAD_FILES} files`;
        if (total > MAX_UPLOAD_BYTES) return `more than ${MAX_UPLOAD_BYTES} bytes`;
      }
    }
    return null;
  };
  const err = walk(real, "");
  if (err) return { ok: false, error: `Refused: ${err}` };
  return { ok: true, isDirectory: true, files, skipped };
}

/** Remote paths are restricted to a safe charset (scp/ssh remote side). */
export function isSafeRemotePath(p: string): boolean {
  return typeof p === "string" && /^[A-Za-z0-9._~/@+-]+$/.test(p) && !p.split("/").includes("..") && p.length <= 512;
}
