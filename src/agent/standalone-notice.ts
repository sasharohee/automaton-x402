/**
 * Standalone-mode (no Conway) instructions shared by every prompt that
 * drives inference: the parent agent, local worker harnesses, the planner
 * and the replanner. Kept dependency-free so any module can import it.
 *
 * Two variants:
 *  - default: the runtime has NO inbound connectivity;
 *  - public service: an operator-managed tunnel publishes ONE local port
 *    (`publicService.servicePort`) at `publicService.publicUrl`.
 */

/** Same shape as AutomatonConfig.publicService (kept local: no type imports). */
export interface PublicServiceNoticeConfig {
  publicUrl: string;
  servicePort: number;
}

/** Base USDC (the asset of the x402 paywall). */
export const BASE_USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
/** x402 facilitator used by the agent's own paywall (no API key). */
export const PAYAI_FACILITATOR_URL = "https://facilitator.payai.network";

const NOTICE_HEADER = `--- PROVIDER: STANDALONE (no Conway) ---
This runtime does NOT use Conway Cloud. Statements above about Conway sandboxes,
Conway credits, domains or child agents do not apply here:
- Commands and files run directly on your host machine.
- Your thinking (inference) is bought per call from BlockRun with USDC from your own
  wallet on Base, via x402 payments. Every call costs real money.
- "Credits" means your spendable USDC: on-chain balance minus a protected reserve.
- Spending is capped per request and per day; the reserve can never be spent.
- Sandboxes, ports, domains, credit transfers and replication are unavailable.
- To get more funds, ask your creator to send USDC on Base to your address.`;

const NO_INBOUND_LINES = `- You have NO inbound connectivity: no public IP, no open port, no domain. A server
  you start is only reachable from localhost on your own machine. Nobody can call it
  or pay you through it. Do not build one to earn money, and never claim that a
  service is "live" or "online".
- Earn money only through OUTBOUND requests: find paid bounties or tasks on the web
  that you can complete and deliver over outbound HTTP requests, and use the tools
  you already have. You have no ETH: do not attempt on-chain transactions that need
  gas (e.g. register_erc8004).`;

const NOTICE_FOOTER = `- Every turn costs real money. Your balance is already in this prompt: do not check
  it again and again. If you have nothing concrete to do, call sleep with a long
  duration (30 minutes or more).
- File writes (write_file, workers) are confined to ~/work. ~/.automaton and the
  application directory are off limits.
--- END PROVIDER ---`;

function publicServiceLines(ps: PublicServiceNoticeConfig, walletAddress?: string): string {
  const payTo = walletAddress ? `your own address ${walletAddress}` : "your own wallet address";
  return `- PUBLIC SERVICE: an HTTP server listening on 0.0.0.0:${ps.servicePort} is publicly reachable at
  ${ps.publicUrl} (an operator-managed tunnel you cannot see or control). Port ${ps.servicePort}
  is the ONLY exposed port: every other port stays internal, and you have no domain.
- To get paid, put an x402 v2 paywall in front of it: @x402/express + @x402/evm, scheme
  "exact", network "eip155:8453", asset USDC ${BASE_USDC_ADDRESS},
  payTo = ${payTo}, facilitator ${PAYAI_FACILITATOR_URL} (no API key, limited
  free quota). Receiving a payment needs NO private key: the server must NEVER read
  ~/.automaton or the wallet key.
- The paywall must run BEFORE any inference call or costly work. No free route may
  trigger inference. Price each route above its estimated BlockRun cost, with a margin.
- Keep the service code in ~/work/<service>. Start it with
  \`nohup ... > ~/work/<service>/server.log 2>&1 &\`, check it with a local request to
  http://127.0.0.1:${ps.servicePort}/, and START IT AGAIN after every restart of your agent
  process (on wake-up, check whether it answers; the port status is in this prompt).
- A free \`GET /health\` route without inference is recommended. Never claim a service is
  "live" or "online" before checking it through ${ps.publicUrl}.
- Earning through OUTBOUND requests (paid bounties, tasks delivered over outbound HTTP)
  is still possible. You have no ETH: do not attempt on-chain transactions that need
  gas (e.g. register_erc8004).`;
}

/** Provider notice for the parent agent's system prompt. */
export function buildStandaloneModeNotice(
  publicService?: PublicServiceNoticeConfig,
  walletAddress?: string,
): string {
  const middle = publicService ? publicServiceLines(publicService, walletAddress) : NO_INBOUND_LINES;
  return `${NOTICE_HEADER}\n${middle}\n${NOTICE_FOOTER}`;
}

/** Default (no inbound connectivity) notice. */
export const STANDALONE_MODE_NOTICE = buildStandaloneModeNotice();

/** Appended to the system prompt of every local worker harness in standalone mode. */
export function buildStandaloneWorkerNotice(
  workDir: string,
  publicService?: PublicServiceNoticeConfig,
  walletAddress?: string,
): string {
  const feasibility = publicService
    ? `- Only port ${publicService.servicePort} is public (at ${publicService.publicUrl}). If the task
  needs another exposed port, a domain, a webhook on another URL or on-chain gas, it
  CANNOT be done here: call task_done immediately with success=false and explain why.
- A service you build must listen on 0.0.0.0:${publicService.servicePort}, live in ${workDir}/<service>,
  put its x402 paywall before any inference or costly work, and never read
  ~/.automaton or the wallet key. Verify it locally (http://127.0.0.1:${publicService.servicePort}/)
  before reporting success.`
    : `- If the task needs inbound connectivity (a server, API or webhook that someone else
  must reach, a public URL, a domain, an exposed port) or on-chain gas, it CANNOT be
  done here: call task_done immediately with success=false and explain why. Do not
  build it anyway.`;

  return `${buildStandaloneModeNotice(publicService, walletAddress)}

--- WORKER RULES (standalone) ---
- Your working directory is ${workDir}. Create and edit files ONLY under it, including
  through exec (e.g. \`cd ${workDir}/<project> && ...\`). Never write elsewhere in the
  home directory, in ~/.automaton or in the application directory.
- Before starting, check whether ${workDir} already contains the result of a previous
  attempt and continue from it instead of redoing the same work.
${feasibility}
- Every turn costs real money: finish as soon as the task is done, or as soon as it is
  clear that it cannot be done.
--- END WORKER RULES ---`;
}

/** Injected into the planner/replanner system prompt in standalone mode. */
export function buildStandalonePlannerNotice(publicService?: PublicServiceNoticeConfig): string {
  const connectivityRules = publicService
    ? `- The ONLY inbound connectivity is one public HTTP service: a server listening on
  0.0.0.0:${publicService.servicePort} is reachable at ${publicService.publicUrl}. You MAY plan tasks
  that build, start or verify a paid (x402) service on that port, in ~/work/<service>,
  with the paywall before any inference or costly work.
- NEVER produce a task that assumes another exposed port, a domain, another public
  URL or a deployment elsewhere.`
    : `- NEVER produce a task that assumes inbound connectivity: no server, API, webhook,
  landing page or service that other people or agents must reach, no deployment,
  no exposed port, no domain, no "make it live" or "validate the public endpoint".`;
  const infeasible = publicService
    ? `- If the goal needs connectivity beyond that single public port, it is infeasible
  here: return \`tasks: []\` and explain why in \`analysis\`.`
    : `- If the goal can only be reached through inbound connectivity, it is infeasible
  here: return \`tasks: []\` and explain why in \`analysis\`.`;
  const scope = publicService
    ? `- Only plan work that a single local worker can finish on this machine, writing
  files under ~/work: the public service above and/or OUTBOUND HTTP requests.`
    : `- Only plan work that a single local worker can finish on this machine and deliver
  through OUTBOUND HTTP requests, writing files under ~/work.`;

  return `<standalone_runtime>
${buildStandaloneModeNotice(publicService)}

Planning rules for this runtime (they override anything above):
${connectivityRules}
- NEVER produce a task that needs on-chain gas (ETH), sandboxes, child agents or
  credit transfers.
${scope}
- Tasks run one at a time: keep the plan short (1 to 3 tasks) and cheap.
${infeasible}
- Keep every string short: the whole JSON must stay well under 4000 characters.
</standalone_runtime>`;
}

/** Default (no inbound connectivity) planner notice. */
export const STANDALONE_PLANNER_NOTICE = buildStandalonePlannerNotice();

/** Short earning guidance used in the parent's loop/maintenance sleep notes. */
export function buildStandaloneEarningGuidance(publicService?: PublicServiceNoticeConfig): string {
  const connectivity = publicService
    ? `Your only inbound connectivity is your public service: a server on 0.0.0.0:${publicService.servicePort} ` +
      `is reachable at ${publicService.publicUrl} (no other port, no domain). Sell work through it behind an ` +
      `x402 paywall that runs before any inference, or earn through OUTBOUND requests (paid bounties or tasks ` +
      `delivered over outbound HTTP). Never claim the service is "live" before checking it through ` +
      `${publicService.publicUrl}. `
    : `You have NO inbound connectivity: no public IP, no open port, no domain. A server you start is only ` +
      `reachable from localhost on your own machine — nobody can call it or pay you through it, so do not build ` +
      `one to earn money and never claim a service is "live". Earn only through OUTBOUND requests: find paid ` +
      `bounties or tasks on the web that you can complete and deliver over outbound HTTP, using the tools you ` +
      `already have. `;
  return (
    connectivity +
    `You have no ETH: do not attempt on-chain transactions that need gas (e.g. register_erc8004). ` +
    `Every turn costs real money and your balance is already in your system prompt. If you have nothing ` +
    `concrete to do, call sleep with a long duration (30 minutes or more).`
  );
}

/**
 * One-line status of the public service port for the parent's system prompt.
 * `listening` comes from a local TCP probe (no inference, no network egress).
 */
export function buildPublicServiceStatus(
  publicService: PublicServiceNoticeConfig,
  listening: boolean,
): string {
  return listening
    ? `--- PUBLIC SERVICE STATUS ---
127.0.0.1:${publicService.servicePort} is ANSWERING (TCP connect OK). Public URL: ${publicService.publicUrl}.
Do not restart it. Check it through the public URL before telling anyone it is online.
--- END PUBLIC SERVICE STATUS ---`
    : `--- PUBLIC SERVICE STATUS ---
127.0.0.1:${publicService.servicePort} is NOT answering: no server is listening on the public port.
If you already built a service in ~/work/<service>, start it again now with
\`nohup ... > ~/work/<service>/server.log 2>&1 &\` and check http://127.0.0.1:${publicService.servicePort}/health.
--- END PUBLIC SERVICE STATUS ---`;
}
