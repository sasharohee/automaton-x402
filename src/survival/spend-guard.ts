/**
 * Spend Guard
 *
 * Enforces treasury limits on real USDC payments *before* they are signed:
 *   - per-payment maximum (maxX402PaymentCents)
 *   - hourly / daily caps per category (inference: maxInferenceDailyCents)
 *   - global daily cap, all categories combined (maxTotalDailySpendCents)
 *   - atomic check + record (reservation) so parallel callers cannot
 *     overshoot a cap
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

type GuardedPayment = Pick<X402PaymentInfo, "amountCents" | "host"> & Partial<Pick<X402PaymentInfo, "payTo">>;

interface PendingSpend {
  /** spend_tracking row id when reserved through reserveSpend(). */
  id?: string;
  amountCents: number;
  at: number;
}

function reservationKey(payment: GuardedPayment): string {
  return `${payment.host}\n${payment.payTo ?? ""}\n${payment.amountCents}`;
}

export class SpendGuard implements X402SpendGuard {
  private cachedBalance: { cents: number; at: number } | null = null;
  /** Authorized (reserved) payments awaiting record() or release(). */
  private readonly reservations = new Map<string, PendingSpend[]>();
  /** Spend recorded since the last balance read (not yet visible on-chain). */
  private pending: PendingSpend[] = [];
  private readonly ttl: number;
  private readonly now: () => number;

  constructor(private readonly options: SpendGuardOptions) {
    this.ttl = options.balanceTtlMs ?? 60_000;
    this.now = options.now ?? Date.now;
  }

  /**
   * Check every limit and, if the payment is allowed, reserve it: the spend
   * is recorded in the ledger in the same synchronous step as the cap check
   * (one IMMEDIATE SQLite transaction), so parallel workers cannot all pass
   * the check before any of them records. Call `release()` if the payment
   * is then not sent / not charged; `record()` confirms it.
   */
  async authorize(payment: GuardedPayment): Promise<string | null> {
    const { policy, category, spendTracker } = this.options;
    const amount = payment.amountCents;

    if (!Number.isFinite(amount) || amount < 0) {
      return `Invalid payment amount: ${amount}`;
    }

    if (amount > policy.maxX402PaymentCents) {
      return `Payment of ${amount.toFixed(4)}¢ exceeds per-request max of ${policy.maxX402PaymentCents}¢`;
    }

    // Cheap pre-check so we don't hit the RPC when a cap is already reached.
    const precheck = spendTracker.checkLimit(amount, category, policy);
    if (!precheck.allowed) {
      return `${category} spend cap reached: ${precheck.reason}`;
    }

    let balance: number;
    try {
      balance = await this.getBalance();
    } catch (err: any) {
      return `Wallet balance unavailable, refusing to pay (${err?.message || String(err)})`;
    }

    // ── Critical section: no `await` below, so in-process callers are
    // serialized, and reserveSpend() is a DB transaction for other processes.
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

    const entry = this.spendEntry(payment);
    let reservationId: string | undefined;
    try {
      if (spendTracker.reserveSpend) {
        const reserved = spendTracker.reserveSpend(entry, policy);
        if (!reserved.allowed) return `${category} spend cap reached: ${reserved.reason}`;
        reservationId = reserved.reservationId;
      } else {
        const limit = spendTracker.checkLimit(amount, category, policy);
        if (!limit.allowed) return `${category} spend cap reached: ${limit.reason}`;
        spendTracker.recordSpend(entry);
      }
    } catch (err: any) {
      return `Spend ledger unavailable, refusing to pay (${err?.message || String(err)})`;
    }

    const reservation: PendingSpend = { id: reservationId, amountCents: amount, at: this.now() };
    this.pending.push(reservation);
    const key = reservationKey(payment);
    const list = this.reservations.get(key) ?? [];
    list.push(reservation);
    this.reservations.set(key, list);
    return null;
  }

  /**
   * Confirm a payment that was sent. Authorized payments were already
   * recorded by `authorize()`; a payment that was not reserved is recorded now.
   */
  record(payment: GuardedPayment & { settled: boolean }): void {
    if (this.takeReservation(payment)) return;
    this.pending.push({ amountCents: payment.amountCents, at: this.now() });
    try {
      this.options.spendTracker.recordSpend(this.spendEntry(payment));
    } catch (err) {
      logger.error("Failed to record spend", err instanceof Error ? err : undefined);
    }
  }

  /** Cancel the reservation of an authorized payment that was not charged. */
  release(payment: GuardedPayment): void {
    const reservation = this.takeReservation(payment);
    if (!reservation) return;
    this.pending = this.pending.filter((p) => p !== reservation);
    if (reservation.id && this.options.spendTracker.releaseSpend) {
      try {
        this.options.spendTracker.releaseSpend(reservation.id);
      } catch (err) {
        logger.error("Failed to release spend reservation", err instanceof Error ? err : undefined);
      }
    }
  }

  private get pendingCents(): number {
    return this.pending.reduce((sum, p) => sum + p.amountCents, 0);
  }

  private takeReservation(payment: GuardedPayment): PendingSpend | undefined {
    const key = reservationKey(payment);
    const list = this.reservations.get(key);
    const reservation = list?.shift();
    if (list && list.length === 0) this.reservations.delete(key);
    return reservation;
  }

  private spendEntry(payment: GuardedPayment) {
    return {
      toolName: this.options.toolName ?? `x402:${this.options.category}`,
      amountCents: payment.amountCents,
      domain: payment.host,
      category: this.options.category,
    };
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
    // A fresh on-chain read reflects payments made before it started; keep
    // the ones reserved meanwhile (e.g. by a concurrent caller).
    this.pending = this.pending.filter((p) => p.at >= now);
    return cents;
  }
}
