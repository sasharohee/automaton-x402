/**
 * x402 v2 Payment Client
 *
 * Pays HTTP 402 challenges with a gasless USDC transfer authorization
 * (EIP-3009 `transferWithAuthorization`) on Base, using the official
 * `@x402/fetch` (x402 client) + `@x402/evm` packages for header encoding and
 * signing. The paid round-trip is driven here rather than by
 * `wrapFetchWithPayment` so that caps, the reserve and duplicate-payment
 * protection run before anything is signed.
 *
 * Protocol (v2):
 *   1. Server answers 402 with a base64 JSON `PAYMENT-REQUIRED` header
 *      ({ x402Version: 2, resource, accepts: [{ scheme, network, amount, asset, payTo, ... }] }).
 *   2. Client retries with a base64 JSON `PAYMENT-SIGNATURE` header
 *      ({ x402Version: 2, accepted, payload: { signature, authorization } }).
 *   3. Server settles and returns a `PAYMENT-RESPONSE` header.
 *
 * Safety properties enforced here (before anything is signed):
 *   - only `exact` / Base mainnet / USDC / EIP-3009 requirements are accepted
 *   - optional host allowlist
 *   - per-request cap (`maxPaymentCents`)
 *   - pluggable spend guard (daily caps, wallet reserve)
 *   - no duplicate payments on retry: a signed authorization is cached per
 *     request fingerprint and re-sent as-is if the same request is retried
 *     while the outcome of the first attempt is unknown. EIP-3009 nonces are
 *     single-use on-chain, so the same authorization can settle at most once.
 */

import { createHash } from "crypto";
import { x402Client, x402HTTPClient } from "@x402/fetch";
import type { PaymentRequired, PaymentRequirements } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import type { PrivateKeyAccount } from "viem";
import type { SpendLimitRefusal } from "../types.js";

export const BASE_NETWORK = "eip155:8453";
export const BASE_USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const PAYMENT_REQUIRED_HEADER = "PAYMENT-REQUIRED";
export const PAYMENT_SIGNATURE_HEADER = "PAYMENT-SIGNATURE";
export const PAYMENT_RESPONSE_HEADER = "PAYMENT-RESPONSE";

/** USDC has 6 decimals: 1 cent = 10_000 atomic units. */
const ATOMIC_PER_CENT = 10_000n;

export interface X402PaymentInfo {
  url: string;
  host: string;
  amountAtomic: bigint;
  amountCents: number;
  payTo: string;
  network: string;
}

/** A guard refusal; `limit` is set when a spend cap (not another check) refused. */
export interface X402GuardRefusal {
  reason: string;
  limit?: SpendLimitRefusal;
}

export interface X402SpendGuard {
  /** Return a refusal reason, or null to allow signing the payment. */
  authorize(payment: X402PaymentInfo): Promise<string | null> | string | null;
  /**
   * Same as `authorize()` but with a structured refusal. Used instead of
   * `authorize()` when implemented (never both for the same payment).
   */
  authorizeDetailed?(payment: X402PaymentInfo): Promise<X402GuardRefusal | null> | X402GuardRefusal | null;
  /** Called exactly once per signed authorization that was sent to the server. */
  record(payment: X402PaymentInfo & { settled: boolean; transaction?: string }): void;
  /**
   * Called when an authorized payment ends up not being charged (signing
   * failed, or the server rejected the authorization), so a spend reserved
   * by `authorize()` can be cancelled.
   */
  release?(payment: X402PaymentInfo): void;
}

export interface X402PaymentOptions {
  account: PrivateKeyAccount;
  /** Per-request maximum in cents. */
  maxPaymentCents?: number;
  /** If set, payments are only made to these hosts (or their subdomains). */
  allowedDomains?: string[];
  guard?: X402SpendGuard;
  /** Override for tests. */
  fetchImpl?: typeof fetch;
  /** Shared ledger used to avoid duplicate payments on retry. */
  ledger?: PaymentLedger;
}

export class X402PaymentError extends Error {
  constructor(
    message: string,
    readonly code:
      | "UNPARSEABLE_CHALLENGE"
      | "NO_SUPPORTED_REQUIREMENT"
      | "DOMAIN_NOT_ALLOWED"
      | "AMOUNT_EXCEEDS_MAX"
      | "GUARD_REFUSED"
      | "SIGNING_FAILED",
    /** Set on GUARD_REFUSED when a spend cap refused (hourly, daily, global daily). */
    readonly limit?: SpendLimitRefusal,
  ) {
    super(message);
    this.name = "X402PaymentError";
  }
}

// ─── Per-request payment accessor ────────────────────────────────

type SentPayment = X402PaymentInfo & { settled: boolean; transaction?: string };

/**
 * Payment sent for a given response (or for the error thrown while waiting
 * for it, e.g. a client-side timeout). Keyed by the object itself, so
 * concurrent requests can never read each other's payment.
 */
const paymentsByResult = new WeakMap<object, SentPayment>();

export function attachX402Payment(target: unknown, payment: SentPayment): void {
  if (target && typeof target === "object") paymentsByResult.set(target, payment);
}

/**
 * The x402 payment signed and sent for this response — or for this error,
 * when the paid request failed client-side (abort/timeout, network error):
 * such a payment may still settle, and its spend stays reserved.
 */
export function getX402Payment(responseOrError: unknown): SentPayment | undefined {
  if (!responseOrError || typeof responseOrError !== "object") return undefined;
  return paymentsByResult.get(responseOrError);
}

export interface X402FetchResult {
  response: Response;
  payment?: X402PaymentInfo & { settled: boolean; transaction?: string };
}

// ─── Challenge parsing ───────────────────────────────────────────

/**
 * Decode a `PAYMENT-REQUIRED` header (base64 JSON, plain JSON tolerated).
 * Returns null when the header is not a valid x402 v2 challenge.
 */
export function decodePaymentRequiredHeader(header: string | null | undefined): PaymentRequired | null {
  if (!header) return null;
  const candidates = [header];
  try {
    candidates.unshift(Buffer.from(header, "base64").toString("utf-8"));
  } catch {
    // not base64
  }
  for (const raw of candidates) {
    try {
      const parsed = JSON.parse(raw);
      if (isPaymentRequired(parsed)) return parsed;
    } catch {
      // try next candidate
    }
  }
  return null;
}

function isPaymentRequired(value: unknown): value is PaymentRequired {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.x402Version === "number" &&
    v.x402Version >= 2 &&
    Array.isArray(v.accepts) &&
    v.accepts.length > 0
  );
}

/**
 * Pick the requirement we are willing to pay: exact scheme, Base mainnet,
 * native USDC, EIP-3009 transfer (no Permit2 → no on-chain approval / gas).
 */
export function selectBaseUsdcRequirement(
  paymentRequired: PaymentRequired,
): PaymentRequirements | null {
  for (const req of paymentRequired.accepts) {
    if (req.scheme !== "exact") continue;
    if (req.network !== BASE_NETWORK) continue;
    if (typeof req.asset !== "string" || req.asset.toLowerCase() !== BASE_USDC_ADDRESS.toLowerCase()) continue;
    if (typeof req.amount !== "string" || !/^\d+$/.test(req.amount)) continue;
    if (typeof req.payTo !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(req.payTo)) continue;
    const method = (req.extra as Record<string, unknown> | undefined)?.assetTransferMethod;
    if (method !== undefined && method !== "eip3009") continue;
    return req;
  }
  return null;
}

/** Convert USDC atomic units (6 decimals) to cents (fractional allowed). */
export function atomicUsdcToCents(amountAtomic: bigint | string): number {
  const atomic = typeof amountAtomic === "bigint" ? amountAtomic : BigInt(amountAtomic);
  const whole = atomic / ATOMIC_PER_CENT;
  const rest = atomic % ATOMIC_PER_CENT;
  return Number(whole) + Number(rest) / Number(ATOMIC_PER_CENT);
}

export function isHostAllowed(host: string, allowedDomains: string[]): boolean {
  const h = host.toLowerCase();
  return allowedDomains.some((d) => {
    const domain = d.toLowerCase();
    return h === domain || h.endsWith(`.${domain}`);
  });
}

// ─── Duplicate-payment protection ────────────────────────────────

interface LedgerEntry {
  headers: Record<string, string>;
  payment: X402PaymentInfo;
  expiresAt: number;
  recorded: boolean;
}

/**
 * Remembers signed authorizations whose outcome is unknown (network error,
 * 5xx after payment). Retrying the same request re-sends the same
 * authorization instead of signing a new one.
 */
export class PaymentLedger {
  private readonly entries = new Map<string, LedgerEntry>();

  get(key: string, now = Date.now()): LedgerEntry | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= now) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  set(key: string, entry: LedgerEntry): void {
    this.entries.set(key, entry);
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  get size(): number {
    return this.entries.size;
  }
}

const defaultLedger = new PaymentLedger();

export function requestFingerprint(url: string, init?: RequestInit): string {
  const method = (init?.method || "GET").toUpperCase();
  const body = typeof init?.body === "string" ? init.body : init?.body ? "[binary]" : "";
  return createHash("sha256").update(`${method}\n${url}\n${body}`).digest("hex");
}

// ─── Paid fetch ──────────────────────────────────────────────────

function headersToRecord(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) {
    const out: Record<string, string> = {};
    headers.forEach((v, k) => {
      out[k] = v;
    });
    return out;
  }
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  return { ...(headers as Record<string, string>) };
}

function decodeSettlement(header: string | null): { success: boolean; transaction?: string } | null {
  if (!header) return null;
  try {
    const parsed = JSON.parse(Buffer.from(header, "base64").toString("utf-8"));
    return { success: parsed?.success === true, transaction: parsed?.transaction };
  } catch {
    return null;
  }
}

function buildSigner(account: PrivateKeyAccount, requirement: PaymentRequirements): x402HTTPClient {
  const client = new x402Client();
  client.register(BASE_NETWORK, new ExactEvmScheme(account as any));
  // Pin the requirement we validated so the library cannot pick another one.
  client.registerPolicy((_version, reqs) =>
    reqs.filter(
      (r) =>
        r.network === requirement.network &&
        r.asset === requirement.asset &&
        r.amount === requirement.amount &&
        r.payTo === requirement.payTo,
    ),
  );
  // Our own caps are enforced before this point; lift the library's default
  // $1 cap only up to the validated amount.
  client.setSpendControls({
    maxAmountPerPayment: `$${(Math.ceil(atomicUsdcToCents(requirement.amount)) / 100).toFixed(2)}`,
  });
  return new x402HTTPClient(client);
}

/**
 * Fetch `url`; if the server answers with an x402 v2 challenge, validate it,
 * sign an EIP-3009 authorization and retry exactly once.
 *
 * Non-402 responses and 402 responses without a v2 challenge are returned
 * unchanged (callers may fall back to legacy handling).
 */
export async function x402PaidFetch(
  url: string,
  init: RequestInit | undefined,
  options: X402PaymentOptions,
): Promise<X402FetchResult> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const ledger = options.ledger ?? defaultLedger;
  const key = requestFingerprint(url, init);
  const baseHeaders = headersToRecord(init?.headers);

  // A previous attempt of this exact request was paid but its outcome is
  // unknown: re-send the same authorization rather than paying again.
  const pending = ledger.get(key);
  if (pending) {
    return sendPaid(url, init, baseHeaders, pending, key, ledger, fetchImpl, options);
  }

  // Redirects are never followed: the challenge must come from (and the
  // signed payment header may only ever be sent to) the allowlisted host.
  const initial = await fetchImpl(url, { ...init, headers: baseHeaders, redirect: "manual" });
  if (initial.status !== 402) return { response: initial };

  const paymentRequired = decodePaymentRequiredHeader(initial.headers.get(PAYMENT_REQUIRED_HEADER));
  if (!paymentRequired) {
    // Not an x402 v2 challenge — let the caller decide.
    return { response: initial };
  }

  const requirement = selectBaseUsdcRequirement(paymentRequired);
  if (!requirement) {
    throw new X402PaymentError(
      "No acceptable payment option (need exact/USDC/EIP-3009 on Base eip155:8453)",
      "NO_SUPPORTED_REQUIREMENT",
    );
  }

  const host = new URL(url).hostname;
  if (options.allowedDomains && !isHostAllowed(host, options.allowedDomains)) {
    throw new X402PaymentError(
      `Host "${host}" is not in the x402 allowlist [${options.allowedDomains.join(", ")}]`,
      "DOMAIN_NOT_ALLOWED",
    );
  }

  const amountAtomic = BigInt(requirement.amount);
  const payment: X402PaymentInfo = {
    url,
    host,
    amountAtomic,
    amountCents: atomicUsdcToCents(amountAtomic),
    payTo: requirement.payTo,
    network: requirement.network,
  };

  if (options.maxPaymentCents !== undefined && payment.amountCents > options.maxPaymentCents) {
    throw new X402PaymentError(
      `Payment of ${payment.amountCents.toFixed(4)} cents exceeds max allowed ${options.maxPaymentCents} cents`,
      "AMOUNT_EXCEEDS_MAX",
    );
  }

  if (options.guard?.authorizeDetailed) {
    const refusal = await options.guard.authorizeDetailed(payment);
    if (refusal) throw new X402PaymentError(refusal.reason, "GUARD_REFUSED", refusal.limit);
  } else if (options.guard) {
    const refusal = await options.guard.authorize(payment);
    if (refusal) throw new X402PaymentError(refusal, "GUARD_REFUSED");
  }

  let headers: Record<string, string>;
  try {
    const signer = buildSigner(options.account, requirement);
    const payload = await signer.createPaymentPayload({ ...paymentRequired, accepts: [requirement] });
    headers = signer.encodePaymentSignatureHeader(payload);
  } catch (err: any) {
    options.guard?.release?.(payment);
    throw new X402PaymentError(`Failed to sign payment: ${err?.message || String(err)}`, "SIGNING_FAILED");
  }

  const entry: LedgerEntry = {
    headers,
    payment,
    expiresAt: Date.now() + Math.max(requirement.maxTimeoutSeconds || 60, 1) * 1000,
    recorded: false,
  };
  ledger.set(key, entry);
  return sendPaid(url, init, baseHeaders, entry, key, ledger, fetchImpl, options);
}

async function sendPaid(
  url: string,
  init: RequestInit | undefined,
  baseHeaders: Record<string, string>,
  entry: LedgerEntry,
  key: string,
  ledger: PaymentLedger,
  fetchImpl: typeof fetch,
  options: X402PaymentOptions,
): Promise<X402FetchResult> {
  const record = (settled: boolean, transaction?: string) => {
    if (entry.recorded) return;
    entry.recorded = true;
    options.guard?.record({ ...entry.payment, settled, transaction });
  };

  let response: Response;
  try {
    // `redirect: "manual"`: a 3xx is returned as-is, so the signed
    // PAYMENT-SIGNATURE header can never be forwarded to another host.
    response = await fetchImpl(url, {
      ...init,
      headers: { ...baseHeaders, ...entry.headers },
      redirect: "manual",
    });
  } catch (err) {
    // Outcome unknown: count the spend conservatively and keep the
    // authorization so a retry reuses it (single-use nonce). The reservation
    // is kept: the server may settle the payment even if we aborted.
    record(false);
    attachX402Payment(err, { ...entry.payment, settled: false });
    throw err;
  }

  if (response.status === 402) {
    // Payment rejected (invalid/expired). Nothing was charged — unless an
    // earlier attempt with this authorization already counted as spent.
    ledger.delete(key);
    if (!entry.recorded) options.guard?.release?.(entry.payment);
    return { response };
  }

  const settlement = decodeSettlement(response.headers.get(PAYMENT_RESPONSE_HEADER));
  record(settlement?.success ?? false, settlement?.transaction);

  if (response.status < 500) {
    ledger.delete(key);
  }
  return { response, payment: { ...entry.payment, settled: settlement?.success ?? false, transaction: settlement?.transaction } };
}

/**
 * Build a `fetch`-compatible function that pays x402 v2 challenges.
 * Suitable for the OpenAI SDK (`new OpenAI({ fetch })`) and for raw calls.
 * A 402 that cannot be paid is surfaced as a thrown X402PaymentError.
 */
export function createX402Fetch(options: X402PaymentOptions): typeof fetch {
  const paidFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const { response, payment } = await x402PaidFetch(url, init, options);
    if (payment) attachX402Payment(response, payment);
    if (response.status === 402) {
      throw new X402PaymentError(
        `Payment required by ${new URL(url).hostname} but no x402 v2 challenge could be paid`,
        "UNPARSEABLE_CHALLENGE",
      );
    }
    return response;
  };
  return paidFetch as typeof fetch;
}
