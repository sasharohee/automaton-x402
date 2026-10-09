/**
 * SSH access to the Fluence VM.
 *
 * - Dedicated ed25519 key in ~/.automaton/ssh/fluence_ed25519 (0600), never
 *   shown to the model.
 * - `ssh` / `scp` run through execFile with an argument array (no local
 *   shell), with a timeout and a scrubbed environment.
 * - Host key pinned per VM on first connect (UserKnownHostsFile under
 *   ~/.automaton/ssh/), then StrictHostKeyChecking=yes, BatchMode=yes, no
 *   agent / X11 / port forwarding.
 */

import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { getAutomatonDir } from "../identity/wallet.js";
import { scrubSecretEnv } from "../conway/local-exec.js";
import { isSafeRemotePath, type UploadFile } from "./upload-guard.js";
import { SSH_USER_PATTERN } from "./config.js";

export const FLUENCE_SSH_KEY_NAME = "fluence_ed25519";
const MAX_OUTPUT = 64 * 1024;

export interface SshRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Injectable process runner (tests mock it; production uses execFile). */
export interface SshTransport {
  run(file: string, args: string[], options: { timeoutMs: number }): Promise<SshRunResult>;
}

export const execFileTransport: SshTransport = {
  run(file, args, { timeoutMs }) {
    return new Promise((resolve) => {
      execFile(
        file,
        args,
        { timeout: timeoutMs, maxBuffer: 4 * MAX_OUTPUT, env: scrubSecretEnv(), shell: false },
        (error: any, stdout, stderr) => {
          const exitCode = error ? (typeof error.code === "number" ? error.code : 1) : 0;
          resolve({
            stdout: String(stdout ?? "").slice(0, MAX_OUTPUT),
            stderr: String(stderr ?? (error?.message || "")).slice(0, MAX_OUTPUT),
            exitCode,
          });
        },
      );
    });
  },
};

export interface SshTarget {
  vmId: string;
  host: string;
  user: string;
}

export interface FluenceSshOptions {
  transport?: SshTransport;
  /** Default ~/.automaton/ssh */
  sshDir?: string;
}

function safeId(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80);
}

/** Only a plain IPv4 address ever reaches ssh / scp / ssh-keyscan. */
export function isValidHost(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) && host.split(".").every((o) => Number(o) <= 255);
}

export class FluenceSsh {
  private readonly transport: SshTransport;
  readonly sshDir: string;

  constructor(options: FluenceSshOptions = {}) {
    this.transport = options.transport ?? execFileTransport;
    this.sshDir = options.sshDir ?? path.join(getAutomatonDir(), "ssh");
  }

  get keyPath(): string {
    return path.join(this.sshDir, FLUENCE_SSH_KEY_NAME);
  }

  knownHostsPath(vmId: string): string {
    return path.join(this.sshDir, `known_hosts_${safeId(vmId)}`);
  }

  private ensureDir(): void {
    if (!fs.existsSync(this.sshDir)) fs.mkdirSync(this.sshDir, { recursive: true, mode: 0o700 });
  }

  /** Generate the key pair if needed; returns the PUBLIC key only. */
  async ensureKey(): Promise<string> {
    this.ensureDir();
    if (!fs.existsSync(this.keyPath)) {
      const res = await this.transport.run(
        "ssh-keygen",
        ["-q", "-t", "ed25519", "-N", "", "-C", "automaton-fluence", "-f", this.keyPath],
        { timeoutMs: 20_000 },
      );
      if (res.exitCode !== 0 || !fs.existsSync(`${this.keyPath}.pub`)) {
        throw new Error(`ssh-keygen failed (exit ${res.exitCode})`);
      }
    }
    fs.chmodSync(this.keyPath, 0o600);
    return fs.readFileSync(`${this.keyPath}.pub`, "utf-8").trim();
  }

  /** Pin the host key on first connect (ed25519 via ssh-keyscan). */
  async ensureHostKey(target: SshTarget): Promise<void> {
    const file = this.knownHostsPath(target.vmId);
    if (fs.existsSync(file) && fs.readFileSync(file, "utf-8").trim()) return;
    if (!isValidHost(target.host)) throw new Error(`Invalid VM host: ${target.host}`);
    this.ensureDir();
    const res = await this.transport.run("ssh-keyscan", ["-T", "10", "-t", "ed25519", target.host], { timeoutMs: 20_000 });
    const lines = res.stdout.split("\n").filter((l) => l.trim() && !l.startsWith("#"));
    if (res.exitCode !== 0 || lines.length === 0) {
      throw new Error(`Could not read the VM host key (is the VM up?)`);
    }
    fs.writeFileSync(file, `${lines.join("\n")}\n`, { mode: 0o600 });
  }

  forgetHost(vmId: string): void {
    try {
      fs.rmSync(this.knownHostsPath(vmId), { force: true });
    } catch {
      // ignore
    }
  }

  private commonOptions(vmId: string): string[] {
    return [
      "-i", this.keyPath,
      "-o", "BatchMode=yes",
      "-o", "StrictHostKeyChecking=yes",
      "-o", `UserKnownHostsFile=${this.knownHostsPath(vmId)}`,
      "-o", "GlobalKnownHostsFile=/dev/null",
      "-o", "IdentitiesOnly=yes",
      "-o", "IdentityAgent=none",
      "-o", "ForwardAgent=no",
      "-o", "ForwardX11=no",
      "-o", "ClearAllForwardings=yes",
      "-o", "PermitLocalCommand=no",
      "-o", "ConnectTimeout=15",
      "-F", "/dev/null",
    ];
  }

  /** Run a command on the VM (the remote shell interprets `command`). */
  async exec(target: SshTarget, command: string, timeoutMs = 60_000): Promise<SshRunResult> {
    if (!isValidHost(target.host)) throw new Error(`Invalid VM host: ${target.host}`);
    if (!SSH_USER_PATTERN.test(target.user)) throw new Error(`Invalid VM user: ${target.user}`);
    await this.ensureKey();
    await this.ensureHostKey(target);
    const args = [...this.commonOptions(target.vmId), "-T", `${target.user}@${target.host}`, "--", command];
    return this.transport.run("ssh", args, { timeoutMs: Math.min(Math.max(timeoutMs, 1000), 600_000) });
  }

  /** Copy already-validated files (see planUpload) to the VM. */
  async upload(target: SshTarget, files: UploadFile[], remotePath: string, isDirectory: boolean): Promise<SshRunResult> {
    if (!isValidHost(target.host)) throw new Error(`Invalid VM host: ${target.host}`);
    if (!SSH_USER_PATTERN.test(target.user)) throw new Error(`Invalid VM user: ${target.user}`);
    if (!isSafeRemotePath(remotePath)) throw new Error(`Invalid remote_path: ${remotePath}`);
    const dests = files.map((f) => (isDirectory ? path.posix.join(remotePath, f.relPath.split(path.sep).join("/")) : remotePath));
    for (const d of dests) {
      if (!isSafeRemotePath(d)) throw new Error(`Unsafe remote file name: ${d}`);
    }
    await this.ensureKey();
    await this.ensureHostKey(target);

    const dirs = new Set(dests.map((d) => path.posix.dirname(d)).filter((d) => d && d !== "." && d !== "/" && d !== "~"));
    if (dirs.size > 0) {
      const mk = await this.exec(target, `mkdir -p -- ${[...dirs].map((d) => `'${d}'`).join(" ")}`, 30_000);
      if (mk.exitCode !== 0) return mk;
    }
    let out = "";
    for (let i = 0; i < files.length; i++) {
      const res = await this.transport.run(
        "scp",
        [...this.commonOptions(target.vmId), "-q", "-p", "--", files[i].absPath, `${target.user}@${target.host}:${dests[i]}`],
        { timeoutMs: 120_000 },
      );
      if (res.exitCode !== 0) {
        return { stdout: out, stderr: `scp failed for ${files[i].relPath}: ${res.stderr}`, exitCode: res.exitCode };
      }
      out += `${files[i].relPath} -> ${dests[i]}\n`;
    }
    return { stdout: out, stderr: "", exitCode: 0 };
  }
}
