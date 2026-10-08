/**
 * Secret Access Policy Rules (standalone mode only)
 *
 * In standalone mode the agent's commands run on the same host, as the same
 * uid, as the agent process that holds the wallet key. These rules stop the
 * `exec` and `read_file` tools from reaching the key material:
 *   - ~/.automaton (wallet.json, config, state.db, ...);
 *   - wallet.json anywhere;
 *   - /proc/<pid>/environ, /proc/<pid>/mem and friends (secrets of other
 *     processes, including the agent itself).
 *
 * Best-effort, defense in depth: a determined command can obfuscate a path
 * (variables, base64, ...). The OS cannot help here: a process with the same
 * uid can always read the same files. Internal tools (git_*, skills, soul)
 * do not go through these tool names and are unaffected.
 */

import os from "os";
import path from "path";
import type { PolicyRule, PolicyRequest, PolicyRuleResult } from "../../types.js";
import { isStandalone } from "../../conway/provider.js";

const EXEC_SECRET_PATTERNS: { pattern: RegExp; description: string }[] = [
  { pattern: /\.automaton(?![\w-])/, description: "the ~/.automaton state directory" },
  { pattern: /wallet\.json/i, description: "the wallet file" },
  { pattern: /\/proc\/[^\s/]+\/(environ|mem|maps|cmdline|fd)\b/, description: "another process's environment or memory" },
];

function deny(reasonCode: string, humanMessage: string): PolicyRuleResult {
  return { rule: "secrets.standalone_secret_access", action: "deny", reasonCode, humanMessage };
}

export function getExecSecretAccessMatch(command: string): string | null {
  for (const { pattern, description } of EXEC_SECRET_PATTERNS) {
    if (pattern.test(command)) return description;
  }
  return null;
}

/** Resolve `~`, `$HOME` and `${HOME}` the same way local file tools do. */
function resolveUserPath(filePath: string, home: string): string {
  const expanded = filePath
    .replace(/^~(?=$|\/)/, home)
    .replace(/^\$\{HOME\}(?=$|\/)/, home)
    .replace(/^\$HOME(?=$|\/)/, home);
  return path.resolve(expanded);
}

export function isSecretPath(filePath: string, home: string = process.env.HOME || os.homedir()): boolean {
  const resolved = resolveUserPath(filePath, home);
  const automatonDir = path.join(home, ".automaton");
  if (resolved === automatonDir || resolved.startsWith(automatonDir + path.sep)) return true;
  if (path.basename(resolved).toLowerCase() === "wallet.json") return true;
  return /^\/proc\/[^/]+\/(environ|mem|maps|cmdline|fd)(\/|$)/.test(resolved);
}

function createStandaloneSecretAccessRule(): PolicyRule {
  return {
    id: "secrets.standalone_secret_access",
    description: "Deny exec/read_file access to ~/.automaton, wallet.json and /proc secrets in standalone mode",
    priority: 200,
    appliesTo: { by: "name", names: ["exec", "read_file"] },
    evaluate(request: PolicyRequest): PolicyRuleResult | null {
      if (!isStandalone(request.context?.config)) return null;

      if (request.tool.name === "exec") {
        const command = request.args.command;
        if (typeof command !== "string") return null;
        const match = getExecSecretAccessMatch(command);
        if (!match) return null;
        return deny(
          "SECRET_ACCESS",
          `exec denied: commands may not reference ${match}. Your wallet key and agent state are off limits; work in ~/work.`,
        );
      }

      const filePath = request.args.path;
      if (typeof filePath !== "string" || !isSecretPath(filePath)) return null;
      return deny(
        "SECRET_ACCESS",
        `read_file denied: ${filePath} is inside ~/.automaton or holds secrets. Your wallet key and agent state are off limits.`,
      );
    },
  };
}

export function createSecretAccessRules(): PolicyRule[] {
  return [createStandaloneSecretAccessRule()];
}
