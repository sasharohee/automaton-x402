/**
 * Coding Heuristic
 *
 * Decides whether a turn was non-trivial coding work, so the next agent
 * turn can be escalated to the stronger model. Deterministic and cheap:
 *   - a successful write_file / edit_own_file on a source file
 *     (not notes or markdown), or
 *   - a build/test/run command (npm, node, tsc, python, ...) that exited
 *     non-zero (the agent is debugging).
 */

import path from "path";
import type { ToolCallResult } from "../types.js";

export const SOURCE_FILE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".ts", ".tsx", ".mts", ".cts",
  ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".sh", ".bash",
  ".json", ".sql",
  ".go", ".rs", ".rb", ".java", ".c", ".h", ".cpp",
  ".html", ".css",
  ".yaml", ".yml", ".toml",
]);

const FILE_WRITE_TOOLS: ReadonlySet<string> = new Set(["write_file", "edit_own_file"]);

/** Build, test and run commands whose failure means the agent is debugging. */
const BUILD_COMMAND =
  /(^|[\s;&|(])(npm|npx|pnpm|yarn|node|tsc|tsx|ts-node|python3?|pip3?|pytest|jest|vitest|make|cargo|go|bun|deno)(\s|$)/;

export function isSourceFilePath(filePath: unknown): boolean {
  if (typeof filePath !== "string" || filePath.trim() === "") return false;
  return SOURCE_FILE_EXTENSIONS.has(path.extname(filePath.trim()).toLowerCase());
}

/** Exit code from the exec tool's result (`exit_code: N`), if any. */
export function parseExitCode(result: string | undefined): number | undefined {
  const match = /^exit_code:\s*(-?\d+)/m.exec(result ?? "");
  return match ? Number(match[1]) : undefined;
}

export function isBuildCommand(command: unknown): boolean {
  return typeof command === "string" && BUILD_COMMAND.test(command);
}

/** True when one of the turn's tool calls was non-trivial coding work. */
export function isCodingTurn(
  toolCalls: readonly Pick<ToolCallResult, "name" | "arguments" | "result" | "error">[],
): boolean {
  return toolCalls.some((tc) => {
    if (FILE_WRITE_TOOLS.has(tc.name)) {
      return !tc.error && isSourceFilePath(tc.arguments?.path);
    }
    if (tc.name === "exec") {
      const exitCode = parseExitCode(tc.result);
      return exitCode !== undefined && exitCode !== 0 && isBuildCommand(tc.arguments?.command);
    }
    return false;
  });
}
