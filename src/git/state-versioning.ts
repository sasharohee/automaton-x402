/**
 * State Versioning
 *
 * Version control the automaton's own state files (~/.automaton/).
 * Every self-modification triggers a git commit with a descriptive message.
 * The automaton's entire identity history is version-controlled and replayable.
 */

import type { ConwayClient, AutomatonDatabase } from "../types.js";
import { gitInit, gitCommit, gitStatus, gitLog } from "./tools.js";

const AUTOMATON_DIR = "~/.automaton";

/**
 * Files that must never be committed to the state repo: the wallet private
 * key, API keys (automaton.json holds conwayApiKey / openaiApiKey /
 * anthropicApiKey), databases and logs. See upstream PR #413.
 */
export const SENSITIVE_STATE_FILES = [
  "wallet.json",
  "wallet*.json",
  "config.json",
  "automaton.json",
  "inference-providers.json",
  ".env",
  ".env.*",
  "*.key",
  "*.pem",
  "state.db",
  "state.db-wal",
  "state.db-shm",
  "logs/",
  "*.log",
  "*.err",
] as const;

export function buildStateGitignore(): string {
  return `# Sensitive files - never commit (private key, API keys, databases)\n${SENSITIVE_STATE_FILES.join("\n")}\n`;
}

/**
 * Make sure .gitignore covers every sensitive file and that none of them is
 * tracked (repos created by older versions committed automaton.json).
 */
export async function ensureSensitiveFilesIgnored(
  conway: ConwayClient,
  dir: string,
): Promise<void> {
  let current = "";
  try {
    current = await conway.readFile(`${dir}/.gitignore`);
  } catch {
    current = "";
  }
  const lines = new Set(current.split("\n").map((l) => l.trim()));
  const missing = SENSITIVE_STATE_FILES.filter((p) => !lines.has(p));
  if (missing.length > 0) {
    const next = current
      ? `${current.replace(/\n?$/, "\n")}${missing.join("\n")}\n`
      : buildStateGitignore();
    await conway.writeFile(`${dir}/.gitignore`, next);
  }

  // Untrack anything sensitive that was committed before (keeps the file on disk).
  const quoted = SENSITIVE_STATE_FILES.map((p) => `'${p.replace(/\/$/, "")}'`).join(" ");
  await conway.exec(
    `cd ${dir} && git rm -r --cached --ignore-unmatch --quiet -- ${quoted} >/dev/null 2>&1 || true`,
    10000,
  );
}

function resolveHome(p: string): string {
  const home = process.env.HOME || "/root";
  if (p.startsWith("~")) {
    return `${home}${p.slice(1)}`;
  }
  return p;
}

/**
 * Initialize git repo for the automaton's state directory.
 * Creates .gitignore to exclude sensitive files.
 */
export async function initStateRepo(
  conway: ConwayClient,
): Promise<void> {
  const dir = resolveHome(AUTOMATON_DIR);

  // Check if already initialized
  const checkResult = await conway.exec(
    `test -d ${dir}/.git && echo "exists" || echo "nope"`,
    5000,
  );

  if (checkResult.stdout.trim() === "exists") {
    // Older repos may lack newer ignore rules or already track secrets.
    await ensureSensitiveFilesIgnored(conway, dir);
    return;
  }

  // Initialize
  await gitInit(conway, dir);

  // Create .gitignore for sensitive files
  await conway.writeFile(`${dir}/.gitignore`, buildStateGitignore());

  // Configure git user
  await conway.exec(
    `cd ${dir} && git config user.name "Automaton" && git config user.email "automaton@conway.tech"`,
    5000,
  );

  // Initial commit
  await gitCommit(conway, dir, "genesis: automaton state repository initialized");
}

/**
 * Commit a state change with a descriptive message.
 * Called after any self-modification.
 */
export async function commitStateChange(
  conway: ConwayClient,
  description: string,
  category: string = "state",
): Promise<string> {
  const dir = resolveHome(AUTOMATON_DIR);

  // `git add -A` below must never pick up secrets.
  await ensureSensitiveFilesIgnored(conway, dir);

  // Check if there are changes
  const status = await gitStatus(conway, dir);
  if (status.clean) {
    return "No changes to commit";
  }

  const message = `${category}: ${description}`;
  const result = await gitCommit(conway, dir, message);
  return result;
}

/**
 * Commit after a SOUL.md update.
 */
export async function commitSoulUpdate(
  conway: ConwayClient,
  description: string,
): Promise<string> {
  return commitStateChange(conway, description, "soul");
}

/**
 * Commit after a skill installation or removal.
 */
export async function commitSkillChange(
  conway: ConwayClient,
  skillName: string,
  action: "install" | "remove" | "update",
): Promise<string> {
  return commitStateChange(
    conway,
    `${action} skill: ${skillName}`,
    "skill",
  );
}

/**
 * Commit after heartbeat config change.
 */
export async function commitHeartbeatChange(
  conway: ConwayClient,
  description: string,
): Promise<string> {
  return commitStateChange(conway, description, "heartbeat");
}

/**
 * Commit after config change.
 */
export async function commitConfigChange(
  conway: ConwayClient,
  description: string,
): Promise<string> {
  return commitStateChange(conway, description, "config");
}

/**
 * Get the state repo history.
 */
export async function getStateHistory(
  conway: ConwayClient,
  limit: number = 20,
) {
  const dir = resolveHome(AUTOMATON_DIR);
  return gitLog(conway, dir, limit);
}
