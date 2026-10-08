/**
 * Spend Guard
 *
 * Enforces treasury limits on real USDC payments *before* they are signed:
 *   - per-payment maximum (maxX402PaymentCents)
 *   - hourly / daily caps per category (inference: maxInferenceDailyCents)
 *   - wallet reserve: a payment is refused if it would bring the spendable
 *     balance below minimumReserveCents (fixes upstream #396, where the
 *     reserve rule was declarative only)
 *
 * Fails closed: if the wallet balance cannot be read, payments are refused.
 */

import type {
  SpendCategory,
  SpendTrackerInterface,
  TreasuryPolicy,
} from "../types.js";
import type { X402PaymentInfo, X402SpendGuard } from "../conway/x402-v2.js";
import { createLogger } from "../observability/logger.js";

const logger = createLogger("spend-guard");

export interface SpendGuardOptions {
  policy: TreasuryPolicy;
  category: SpendCategory;
  /** Persistent spend ledger (DB-backed SpendTracker). */
  spendTracker: SpendTrackerInterface;
  /** Current wallet balance in cents (e.g. on-chain USDC). Should throw on failure. */
  getBalanceCents: () => Promise<number>;
  /** How long a balance read is trusted. Default 60s. */
  balanceTtlMs?: number;
  /** Tool name recorded in spend_tracking. */
  toolName?: string;
  now?: () => number;
}

export interface ReserveCheckInput {
  balanceCents: number;
  pendingCents: number;
  amountCents: number;
  minimumReserveCents: number;
}

/**
 * Pure reserve check: true when the payment keeps the wallet at or above
 * the reserve.
 */
export function keepsReserve(input: ReserveCheckInput): boolean {
  const after = input.balanceCents - input.pendingCents - input.amountCents;
  return after >= input.minimumReserveCents;
}

export class SpendGuard implements X402SpendGuard {
  private cachedBalance: { cents: number; at: number } | null = null;
  /** Spend recorded since the last balance read (not yet visible on-chain). */
  private pendingCents = 0;
  private readonly ttl: number;
  private readonly now: () => number;

  constructor(private readonly options: SpendGuardOptions) {
    this.ttl = options.balanceTtlMs ?? 60_000;
    this.now = options.now ?? Date.now;
  }

  async authorize(payment: Pick<X402PaymentInfo, "amountCents" | "host">): Promise<string | null> {
    const { policy, category, spendTracker } = this.options;
    const amount = payment.amountCents;

    if (!Number.isFinite(amount) || amount < 0) {
      return `Invalid payment amount: ${amount}`;
    }

    if (amount > policy.maxX402PaymentCents) {
      return `Payment of ${amount.toFixed(4)}¢ exceeds per-request max of ${policy.maxX402PaymentCents}¢`;
    }

    const limit = spendTracker.checkLimit(amount, category, policy);
    if (!limit.allowed) {
      return `${category} spend cap reached: ${limit.reason}`;
    }

    let balance: number;
    try {
      balance = await this.getBalance();
    } catch (err: any) {
      return `Wallet balance unavailable, refusing to pay (${err?.message || String(err)})`;
    }

    if (
      !keepsReserve({
        balanceCents: balance,
        pendingCents: this.pendingCents,
        amountCents: amount,
        minimumReserveCents: policy.minimumReserveCents,
      })
    ) {
      return `Payment would breach the wallet reserve: balance ${(balance - this.pendingCents).toFixed(2)}¢ - ${amount.toFixed(4)}¢ < reserve ${policy.minimumReserveCents}¢`;
    }

    return null;
  }

  record(payment: Pick<X402PaymentInfo, "amountCents" | "host"> & { settled: boolean }): void {
    this.pendingCents += payment.amountCents;
    try {
      this.options.spendTracker.recordSpend({
        toolName: this.options.toolName ?? `x402:${this.options.category}`,
        amountCents: payment.amountCents,
        domain: payment.host,
        category: this.options.category,
      });
    } catch (err) {
      logger.error("Failed to record spend", err instanceof Error ? err : undefined);
    }
  }

  /** Drop the cached balance (e.g. after an external top-up). */
  invalidate(): void {
    this.cachedBalance = null;
  }

  private async getBalance(): Promise<number> {
    const now = this.now();
    if (this.cachedBalance && now - this.cachedBalance.at < this.ttl) {
      return this.cachedBalance.cents;
    }
    const cents = await this.options.getBalanceCents();
    if (!Number.isFinite(cents)) throw new Error(`invalid balance: ${cents}`);
    this.cachedBalance = { cents, at: now };
    // Fresh on-chain read already reflects settled payments.
    this.pendingCents = 0;
    return cents;
  }
}
