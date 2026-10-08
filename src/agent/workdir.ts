/**
 * Writable Work Directory
 *
 * Conway mode: file writes are confined to the sandbox home (/root).
 * Standalone mode: the host HOME is not writable as a whole (it holds
 * ~/.automaton with the wallet and state), so writes are confined to a
 * dedicated ~/work directory created at startup.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AutomatonConfig } from "../types.js";
import { isStandalone } from "../conway/provider.js";

export const CONWAY_SANDBOX_HOME = "/root";

export interface WriteRoots {
  /** Directory that `~` expands to. */
  home: string;
  /** Only directory tree writes may target. */
  root: string;
}

export function getStandaloneWorkDir(): string {
  return path.join(os.homedir(), "work");
}

export function resolveWriteRoots(config: Pick<AutomatonConfig, "providerMode"> | undefined | null): WriteRoots {
  if (isStandalone(config)) {
    return { home: os.homedir(), root: getStandaloneWorkDir() };
  }
  return { home: CONWAY_SANDBOX_HOME, root: CONWAY_SANDBOX_HOME };
}

/** Create ~/work in standalone mode. Returns the directory, or undefined in Conway mode. */
export function ensureStandaloneWorkDir(config: Pick<AutomatonConfig, "providerMode">): string | undefined {
  if (!isStandalone(config)) return undefined;
  const dir = getStandaloneWorkDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}
