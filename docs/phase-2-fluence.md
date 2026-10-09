# Phase 2 — Servers on Fluence

Phase 1 (this branch) introduced the **standalone** provider: no Conway, host
execution, BlockRun inference paid with x402 v2, on-chain USDC as the survival
balance. Phase 2 adds real servers again, on
[Fluence CPU Cloud](https://fluence.dev/docs/build/api/cpu_cloud), paid with
[x402](https://fluence.dev/docs/build/api/x402) from the agent's own wallet.

Status: sections 1–4 are implemented in a reduced scope (one VM hosting only
the public x402 service, `src/fluence/`, see the README "Fluence VM" section).
Compute caps are `maxComputeTopupCents` and a UTC-month
`maxComputeMonthlyCents` (not a daily cap), and `api.fluence.dev` must be
added to `x402AllowedDomains` explicitly. Section 5 (replication) is not
implemented.

## Constraints from Fluence

- API: `https://api.fluence.dev`, x402 **v2**, USDC on Base.
- Wallet login with **SIWE** (domain `api.fluence.dev`), no human account.
- Balance top-up via x402, **minimum $10** per top-up.
- VMs created with `POST /v2/vms`.
- Access is **SSH only** (no exec/file HTTP API like Conway sandboxes had).

## 1. SIWE login

New module `src/fluence/auth.ts`:

1. Fetch a nonce from Fluence.
2. Build a `SiweMessage` (package `siwe`, already a dependency) with
   `domain: "api.fluence.dev"`, `chainId: 8453`, the agent address, nonce,
   `issuedAt`, short `expirationTime`.
3. Sign with the agent account (`account.signMessage`), exchange for a session
   token. Keep the token **in memory only**; re-login on 401.
4. Never write the token to `automaton.json` or to the state repo
   (`SENSITIVE_STATE_FILES` already covers the config files).

## 2. Top-up via x402

New module `src/fluence/billing.ts`:

- Reuse `x402PaidFetch` from `src/conway/x402-v2.ts` with a dedicated
  `SpendGuard` (category `"other"` or a new `"compute"` category added to
  `SpendCategory` and the `spend_tracking` CHECK constraint via a migration).
- Because the minimum is $10, the treasury needs explicit compute settings:
  `maxComputeTopupCents` (default 1000) and `maxComputeDailyCents`. The
  per-request `maxX402PaymentCents` ($0.10) must **not** be raised globally;
  pass a separate per-call cap for Fluence top-ups.
- The reserve check applies as for inference: a top-up that would cross
  `minimumReserveCents` is refused.
- `api.fluence.dev` is already in the default `x402AllowedDomains`.
- Top-ups are never automatic in the first iteration: exposed as a
  `fluence_topup` tool with `riskLevel: "dangerous"` and the
  `requireConfirmationAboveCents` quarantine rule.

## 3. VM creation

`src/fluence/client.ts` implements the sandbox part of `ConwayClient`:

| ConwayClient method | Fluence implementation |
|---|---|
| `createSandbox` | `POST /v2/vms` (generate a per-VM ed25519 SSH key locally, upload the public key) |
| `listSandboxes` | `GET /v2/vms` |
| `deleteSandbox` | VM termination endpoint |
| `exposePort` / `removePort` | Fluence networking / firewall settings, if available; otherwise unsupported |
| `getCreditsPricing` | Fluence offers/pricing endpoint |

A new provider mode value (`"fluence"`) or a flag on standalone
(`standalone.servers = "fluence"`) selects it in
`src/conway/provider.ts#createProviderClient`, and the corresponding tools are
removed from `STANDALONE_DISABLED_TOOLS` only when Fluence is configured.

SSH private keys live in `~/.automaton/ssh/` with mode `0600` and must be added
to `SENSITIVE_STATE_FILES` (`ssh/`).

## 4. Execution over SSH

`createScopedClient(vmId)` returns a client whose `exec`, `readFile` and
`writeFile` go over SSH:

- `exec`: `ssh -i <key> -o StrictHostKeyChecking=accept-new root@<ip> -- <cmd>`
  via `execFile` with an argument array (no shell interpolation), with timeout.
  Alternatively the `ssh2` npm package to avoid spawning processes.
- `writeFile` / `readFile`: `scp`/SFTP, or `cat` over the SSH channel.
- Pin the host key on first connection (store fingerprint per VM).
- Keep the existing command-safety policy rules: they run before `exec`
  regardless of the transport.

## 5. Rewrite of `src/replication/spawn.ts`

`spawnChild` currently assumes Conway sandboxes and Conway credit transfers.
For Fluence:

1. Keep replication **off by default** (`maxChildren: 0`) and gated by policy;
   enabling it must be an explicit creator decision.
2. `createSandbox` → Fluence VM (via the client above), with lifecycle states
   unchanged (`requested → sandbox_created → runtime_ready → wallet_verified → funded → starting → healthy`).
3. Runtime install over SSH: clone **this fork** (not `Conway-Research/automaton`),
   pinned to a commit hash, `npm ci && npm run build`.
4. The child generates its own wallet on the VM (`--init`); the parent reads
   only the address back and verifies it (`isValidWalletAddress`).
5. Funding: replace `conway.transferCredits` with an on-chain USDC transfer to
   the child address. This needs ETH for gas on Base (or a paymaster); keep it
   behind `maxSingleTransferCents`, the reserve check and the confirmation
   quarantine. `fund_child` / `transfer_credits` stay denied in standalone mode
   until this is implemented and reviewed.
6. Write `genesis.json` with `providerMode: "standalone"` so children never
   try to reach Conway.
7. Clean up (terminate the VM) on any failure after creation, as today.

## 6. Tests (no real funds)

- Mock Fluence HTTP responses (SIWE nonce/verify, 402 challenge on top-up,
  `POST /v2/vms`) with `fetchImpl` injection, as in `x402-v2.test.ts`.
- Mock SSH with an injectable transport interface.
- Assert: top-up above caps or crossing the reserve is refused before signing;
  no secret ends up in config or state repo; spawn is denied when
  `maxChildren` is 0.
