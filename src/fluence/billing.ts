/**
 * Fluence balance top-up via x402 v2.
 *
 * POST https://api.fluence.dev/v2/x402/top-up?amountUsd=N, paid from the
 * agent wallet with the same x402 client as BlockRun (EIP-3009 USDC on Base),
 * through a dedicated `compute` SpendGuard:
 *   - only api.fluence.dev, only if it is in treasuryPolicy.x402AllowedDomains
 *   - amount ≤ maxComputeTopupCents and month total ≤ maxComputeMonthlyCents
 *   - never below minimumReserveCents
 *   - the 402 challenge must ask for exactly the requested amount, in Base
 *     USDC (eip155:8453); anything else is refused before signing.
 * Compute spend is recorded in the ledger but kept out of the daily caps.
 */

import type { PrivateKeyAccount } from "viem";
import type { SpendTrackerInterface, TreasuryPolicy } from "../types.js";
import {
  BASE_NETWORK,
  BASE_USDC_ADDRESS,
  PaymentLedger,
  X402PaymentError,
  isHostAllowed,
  requestFingerprint,
  x402PaidFetch,
  type X402GuardRefusal,
  type X402PaymentInfo,
  type X402SpendGuard,
} from "../conway/x402-v2.js";
import { SpendGuard, COMPUTE_PAYMENT_HOST } from "../survival/spend-guard.js";
import { computeCaps } from "../agent/spend-tracker.js";
import { MIN_TOPUP_CENTS } from "./config.js";
import { createLogger } from "../observability/logger.js";

const logger = createLogger("fluence.billing");

export interface TopupResult {
  ok: boolean;
  /** Human-readable outcome (safe to show to the model). */
  message: string;
  status?: number;
  amountCents?: number;
  transaction?: string;
}

export interface FluenceBillingOptions {
  account: PrivateKeyAccount;
  apiUrl: string;
  policy: TreasuryPolicy;
  spendTracker: SpendTrackerInterface;
  getBalanceCents: () => Promise<number>;
  /** API key headers (Fluence account the top-up is credited to). */
  authHeaders: () => Promise<Record<string, string>>;
  fetchImpl?: typeof fetch;
}

/**
 * Guard that first checks the challenge matches the requested top-up, then
 * delegates to the compute SpendGuard (caps, reserve, atomic reservation).
 */
export class ComputeTopupGuard implements X402SpendGuard {
  constructor(
    private readonly inner: SpendGuard,
    private readonly expectedAtomic: bigint,
  ) {}

  private checkChallenge(payment: X402PaymentInfo): X402GuardRefusal | null {
    if (payment.network !== BASE_NETWORK) {
      return { reason: `Top-up challenge network ${payment.network} is not ${BASE_NETWORK}` };
    }
    if (payment.amountAtomic !== this.expectedAtomic) {
      return {
        reason: `Top-up challenge amount ${payment.amountAtomic} does not match the requested ${this.expectedAtomic} (USDC atomic units)`,
      };
    }
    if (payment.host.toLowerCase() !== COMPUTE_PAYMENT_HOST) {
      return { reason: `Top-up challenge host ${payment.host} is not ${COMPUTE_PAYMENT_HOST}` };
    }
    return null;
  }

  async authorize(payment: X402PaymentInfo): Promise<string | null> {
    const refusal = await this.authorizeDetailed(payment);
    return refusal ? refusal.reason : null;
  }

  async authorizeDetailed(payment: X402PaymentInfo): Promise<X402GuardRefusal | null> {
    return this.checkChallenge(payment) ?? (await this.inner.authorizeDetailed(payment));
  }

  record(payment: X402PaymentInfo & { settled: boolean; transaction?: string }): void {
    this.inner.record(payment);
  }

  release(payment: X402PaymentInfo): void {
    this.inner.release(payment);
  }
}

/** Validate a top-up amount in cents: whole cents, ≥ $10. Returns an error or null. */
export function validateTopupAmount(amountCents: number): string | null {
  if (!Number.isFinite(amountCents) || !Number.isInteger(amountCents)) {
    return "Top-up amount must be a whole number of cents.";
  }
  if (amountCents < MIN_TOPUP_CENTS) {
    return `Fluence's minimum top-up is $${(MIN_TOPUP_CENTS / 100).toFixed(2)}.`;
  }
  return null;
}

export class FluenceBilling {
  private readonly guard: SpendGuard;
  /** Keeps signed-but-unknown authorizations so a retry never signs twice. */
  private readonly ledger = new PaymentLedger();

  constructor(private readonly options: FluenceBillingOptions) {
    this.guard = new SpendGuard({
      policy: options.policy,
      category: "compute",
      spendTracker: options.spendTracker,
      getBalanceCents: options.getBalanceCents,
      toolName: "fluence_topup",
    });
  }

  /** Why a top-up of this amount would be refused right now (no network, no signing). */
  precheck(amountCents: number): string | null {
    const invalid = validateTopupAmount(amountCents);
    if (invalid) return invalid;
    const { policy, spendTracker } = this.options;
    const host = new URL(this.options.apiUrl).hostname.toLowerCase();
    if (host !== COMPUTE_PAYMENT_HOST) {
      return `Top-ups are only paid to ${COMPUTE_PAYMENT_HOST} (configured: ${host}).`;
    }
    if (!isHostAllowed(host, policy.x402AllowedDomains)) {
      return `${host} is not in treasuryPolicy.x402AllowedDomains; the creator must add it to allow Fluence top-ups.`;
    }
    if (!computeCaps(policy)) {
      return "Compute spending is disabled: treasuryPolicy.maxComputeTopupCents and maxComputeMonthlyCents are not set.";
    }
    const limit = spendTracker.checkLimit(amountCents, "compute", policy);
    if (!limit.allowed) return limit.reason ?? "Compute cap reached.";
    return null;
  }

  async topUp(amountCents: number): Promise<TopupResult> {
    const amountUsd = (amountCents / 100).toFixed(2);
    const url = `${this.options.apiUrl.replace(/\/$/, "")}/v2/x402/top-up?amountUsd=${amountUsd}`;
    // A retry of a top-up whose outcome is unknown re-sends the SAME signed
    // authorization (already counted in the ledger): skip the cap precheck,
    // which would count it twice. Nothing new is signed in that case.
    const resending = this.ledger.get(requestFingerprint(url, { method: "POST" })) !== undefined;
    const refused = resending ? validateTopupAmount(amountCents) : this.precheck(amountCents);
    if (refused) return { ok: false, message: `Top-up refused: ${refused}` };

    const expectedAtomic = BigInt(amountCents) * 10_000n;
    const guard = new ComputeTopupGuard(this.guard, expectedAtomic);

    let result;
    try {
      result = await x402PaidFetch(
        url,
        { method: "POST", headers: await this.options.authHeaders() },
        {
          account: this.options.account,
          maxPaymentCents: this.options.policy.maxComputeTopupCents,
          allowedDomains: this.options.policy.x402AllowedDomains,
          guard,
          ledger: this.ledger,
          fetchImpl: this.options.fetchImpl,
        },
      );
    } catch (err) {
      if (err instanceof X402PaymentError) {
        return { ok: false, message: `Top-up refused before signing: ${err.message}` };
      }
      // Network error after the payment may have been sent: the spend stays
      // reserved and a retry of the same amount re-sends the same authorization.
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`Fluence top-up request failed: ${msg}`);
      return {
        ok: false,
        message: `Top-up request failed (${msg}). The payment may still settle; check fluence_status before retrying.`,
      };
    }

    const { response, payment } = result;
    const status = response.status;
    if (status === 409) {
      // Conflict (e.g. this authorization was already used / a top-up is in
      // progress): never sign again for it.
      return {
        ok: false,
        status,
        message: "Fluence answered 409 (conflict): the top-up was not re-signed. Check fluence_status before trying again.",
      };
    }
    if (status === 503) {
      return {
        ok: false,
        status,
        message: payment
          ? "Fluence is unavailable (503) after the payment was sent. It is counted as spent; a retry of the same amount reuses the same authorization."
          : "Fluence top-ups are unavailable right now (503). Nothing was paid; try again later.",
      };
    }
    if (status === 402) {
      return { ok: false, status, message: "Fluence rejected the payment (402). Nothing was charged." };
    }
    if (!response.ok) {
      return { ok: false, status, message: `Fluence top-up failed (${status}).` };
    }
    if (!payment) {
      return { ok: false, status, message: "Fluence did not ask for a payment; no top-up was made." };
    }
    this.guard.invalidate();
    logger.info(`Fluence top-up of $${amountUsd} sent (settled=${payment.settled})`);
    return {
      ok: true,
      status,
      amountCents,
      transaction: payment.transaction,
      message: `Fluence balance topped up by $${amountUsd}${payment.transaction ? ` (tx ${payment.transaction})` : ""}.`,
    };
  }
}
