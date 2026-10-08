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

export function execLocal(command: string, timeout?: number): ExecResult {
  try {
    const stdout = execSync(command, {
      timeout: timeout || 30_000,
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
      cwd: process.env.HOME || "/root",
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
