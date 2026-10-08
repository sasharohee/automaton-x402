/**
 * Public service (standalone only): an operator-managed tunnel publishes one
 * local port at a public HTTPS URL. This module only reads the config and
 * probes the local port; it never touches the tunnel.
 */

import net from "node:net";
import type { AutomatonConfig, PublicServiceConfig } from "../types.js";

/** The public service block, only when running standalone. */
export function getPublicService(
  config: Pick<AutomatonConfig, "providerMode" | "publicService"> | undefined | null,
): PublicServiceConfig | undefined {
  if (!config || config.providerMode !== "standalone") return undefined;
  return config.publicService ?? undefined;
}

export const PUBLIC_SERVICE_PROBE_TIMEOUT_MS = 500;

/**
 * True when something accepts a TCP connection on 127.0.0.1:<port> within
 * `timeoutMs`. Local only: no request is sent, no inference, no egress.
 */
export function probeLocalPort(
  port: number,
  timeoutMs: number = PUBLIC_SERVICE_PROBE_TIMEOUT_MS,
  host: string = "127.0.0.1",
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}
