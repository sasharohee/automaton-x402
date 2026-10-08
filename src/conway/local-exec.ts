/**
 * Local Execution
 *
 * Runs commands and file operations directly on the host machine.
 * Used by the Conway client when no sandbox is configured, and by the
 * standalone provider (no Conway) for all VM operations.
 */

import { execSync } from "child_process";
import fs from "fs";
import nodePath from "path";
import type { ExecResult } from "../types.js";

/** Environment variable names that may hold a secret (API keys, tokens, keys, mnemonics). */
const SECRET_ENV_NAME_RE = /KEY|SECRET|TOKEN|PASSW(OR)?D|PRIVATE|MNEMONIC|SEED|CREDENTIAL|AUTH(?!OR)|COOKIE/i;

/**
 * Copy of `env` without variables whose name looks like a secret. Used for
 * commands run by the agent in standalone mode, so that a process it starts
 * (e.g. its public server) does not inherit the API keys the agent loop puts
 * in process.env.
 */
export function scrubSecretEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (!SECRET_ENV_NAME_RE.test(name)) clean[name] = value;
  }
  return clean;
}

export function execLocal(
  command: string,
  timeout?: number,
  options: { env?: NodeJS.ProcessEnv } = {},
): ExecResult {
  try {
    const stdout = execSync(command, {
      timeout: timeout || 30_000,
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
      cwd: process.env.HOME || "/root",
      ...(options.env ? { env: options.env } : {}),
    });
    return { stdout: stdout || "", stderr: "", exitCode: 0 };
  } catch (err: any) {
    return {
      stdout: err.stdout || "",
      stderr: err.stderr || err.message || "",
      exitCode: err.status ?? 1,
    };
  }
}

export function resolveLocalPath(filePath: string): string {
  return filePath.startsWith("~")
    ? nodePath.join(process.env.HOME || "/root", filePath.slice(1))
    : filePath;
}

export function writeFileLocal(filePath: string, content: string): void {
  const resolved = resolveLocalPath(filePath);
  const dir = nodePath.dirname(resolved);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(resolved, content, "utf-8");
}

export function readFileLocal(filePath: string): string {
  return fs.readFileSync(resolveLocalPath(filePath), "utf-8");
}
