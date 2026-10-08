/**
 * x402 v2 Payment Tests
 *
 * All network calls are mocked. The signing key below is a throwaway
 * constant that has never been funded; signatures are only produced and
 * verified locally — nothing is ever broadcast or settled.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { verifyTypedData } from "viem";
import {
  BASE_USDC_ADDRESS,
  PaymentLedger,
  X402PaymentError,
  atomicUsdcToCents,
  createX402Fetch,
  decodePaymentRequiredHeader,
  selectBaseUsdcRequirement,
  x402PaidFetch,
  type X402SpendGuard,
} from "../conway/x402-v2.js";
import { x402Fetch } from "../conway/x402.js";

const TEST_ACCOUNT = privateKeyToAccount(`0x${"ab".repeat(32)}`);
const PAY_TO = "0x1111111111111111111111111111111111111111";
const URL_BLOCKRUN = "https://blockrun.ai/api/v1/chat/completions";

/** Example `PAYMENT-REQUIRED` challenge as sent by an x402 v2 server. */
function makeChallenge(overrides: Record<string, unknown> = {}) {
  return {
    x402Version: 2,
    error: "Payment required",
    resource: {
      url: URL_BLOCKRUN,
      description: "Chat completion",
      mimeType: "application/json",
    },
    accepts: [
      {
        scheme: "exact",
        network: "eip155:8453",
        amount: "2500", // 0.0025 USDC = 0.25 cents
        asset: BASE_USDC_ADDRESS,
        payTo: PAY_TO,
        maxTimeoutSeconds: 300,
        extra: { name: "USD Coin", version: "2" },
        ...overrides,
      },
    ],
  };
}

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64");

function challengeResponse(challenge = makeChallenge()): Response {
  return new Response(JSON.stringify({}), {
    status: 402,
    headers: { "PAYMENT-REQUIRED": b64(challenge), "Content-Type": "application/json" },
  });
}

function paidResponse(body: unknown = { choices: [] }): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "PAYMENT-RESPONSE": b64({ success: true, transaction: "0xfeed", network: "eip155:8453" }),
    },
  });
}

function headerOf(init: RequestInit | undefined, name: string): string | undefined {
  const headers = (init?.headers ?? {}) as Record<string, string>;
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : undefined;
}

function decodeSignatureHeader(value: string) {
  return JSON.parse(Buffer.from(value, "base64").toString("utf-8"));
}

function makeGuard(refusal: string | null = null) {
  return {
    authorize: vi.fn(async () => refusal),
    record: vi.fn(),
  } satisfies X402SpendGuard;
}

const postInit = (body = '{"model":"deepseek-chat"}'): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body,
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("x402 v2 challenge parsing", () => {
  it("decodes a base64 PAYMENT-REQUIRED header", () => {
    const decoded = decodePaymentRequiredHeader(b64(makeChallenge()));
    expect(decoded?.x402Version).toBe(2);
    expect(decoded?.accepts[0].amount).toBe("2500");
    expect(decoded?.accepts[0].payTo).toBe(PAY_TO);
  });

  it("tolerates a plain JSON header", () => {
    const decoded = decodePaymentRequiredHeader(JSON.stringify(makeChallenge()));
    expect(decoded?.accepts).toHaveLength(1);
  });

  it("rejects garbage, empty and v1 challenges", () => {
    expect(decodePaymentRequiredHeader(null)).toBeNull();
    expect(decodePaymentRequiredHeader("not-a-challenge")).toBeNull();
    expect(
      decodePaymentRequiredHeader(b64({ x402Version: 1, accepts: [{ maxAmountRequired: "1" }] })),
    ).toBeNull();
    expect(decodePaymentRequiredHeader(b64({ x402Version: 2, accepts: [] }))).toBeNull();
  });

  it("selects only exact / Base / USDC / EIP-3009 requirements", () => {
    const challenge = makeChallenge();
    const good = challenge.accepts[0];
    const options = {
      ...challenge,
      accepts: [
        { ...good, network: "eip155:1" }, // wrong chain
        { ...good, asset: "0x0000000000000000000000000000000000000001" }, // not USDC
        { ...good, extra: { ...good.extra, assetTransferMethod: "permit2" } }, // needs approval/gas
        { ...good, scheme: "upto" },
        good,
      ],
    };
    expect(selectBaseUsdcRequirement(options as any)).toBe(good);
    expect(selectBaseUsdcRequirement({ ...options, accepts: options.accepts.slice(0, 4) } as any)).toBeNull();
  });

  it("converts atomic USDC amounts to cents", () => {
    expect(atomicUsdcToCents("2500")).toBe(0.25);
    expect(atomicUsdcToCents("100000")).toBe(10);
    expect(atomicUsdcToCents(1_000_000n)).toBe(100);
  });
});

describe("x402PaidFetch", () => {
  it("passes through non-402 responses without paying", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok", { status: 200 }));
    const guard = makeGuard();
    const { response, payment } = await x402PaidFetch(URL_BLOCKRUN, postInit(), {
      account: TEST_ACCOUNT,
      fetchImpl: fetchImpl as any,
      guard,
    });
    expect(response.status).toBe(200);
    expect(payment).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(guard.authorize).not.toHaveBeenCalled();
  });

  it("signs an EIP-3009 authorization and retries with PAYMENT-SIGNATURE", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(challengeResponse())
      .mockResolvedValueOnce(paidResponse({ ok: true }));
    const guard = makeGuard();

    const { response, payment } = await x402PaidFetch(URL_BLOCKRUN, postInit(), {
      account: TEST_ACCOUNT,
      fetchImpl,
      guard,
      maxPaymentCents: 10,
      allowedDomains: ["blockrun.ai"],
      ledger: new PaymentLedger(),
    });

    expect(response.status).toBe(200);
    expect(payment?.amountCents).toBe(0.25);
    expect(payment?.settled).toBe(true);
    expect(payment?.transaction).toBe("0xfeed");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(guard.authorize).toHaveBeenCalledTimes(1);
    expect(guard.record).toHaveBeenCalledTimes(1);

    const sigHeader = headerOf(fetchImpl.mock.calls[1][1], "PAYMENT-SIGNATURE");
    expect(sigHeader).toBeTruthy();
    const sent = decodeSignatureHeader(sigHeader!);
    expect(sent.x402Version).toBe(2);
    expect(sent.accepted.amount).toBe("2500");
    expect(sent.accepted.network).toBe("eip155:8453");
    const auth = sent.payload.authorization;
    expect(auth.from.toLowerCase()).toBe(TEST_ACCOUNT.address.toLowerCase());
    expect(auth.to.toLowerCase()).toBe(PAY_TO.toLowerCase());
    expect(auth.value).toBe("2500");

    // The signature is a valid EIP-712 TransferWithAuthorization for USDC on Base.
    const valid = await verifyTypedData({
      address: TEST_ACCOUNT.address,
      domain: { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: BASE_USDC_ADDRESS },
      types: {
        TransferWithAuthorization: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "nonce", type: "bytes32" },
        ],
      },
      primaryType: "TransferWithAuthorization",
      message: {
        from: auth.from,
        to: auth.to,
        value: BigInt(auth.value),
        validAfter: BigInt(auth.validAfter),
        validBefore: BigInt(auth.validBefore),
        nonce: auth.nonce,
      },
      signature: sent.payload.signature,
    });
    expect(valid).toBe(true);
  });

  it("refuses payments above the per-request max before signing", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(challengeResponse(makeChallenge({ amount: "200000" })));
    const guard = makeGuard();
    await expect(
      x402PaidFetch(URL_BLOCKRUN, postInit(), {
        account: TEST_ACCOUNT,
        fetchImpl,
        guard,
        maxPaymentCents: 10,
      }),
    ).rejects.toMatchObject({ code: "AMOUNT_EXCEEDS_MAX" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(guard.authorize).not.toHaveBeenCalled();
  });

  it("refuses hosts outside the allowlist", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(challengeResponse());
    await expect(
      x402PaidFetch("https://evil.example/pay", postInit(), {
        account: TEST_ACCOUNT,
        fetchImpl,
        allowedDomains: ["blockrun.ai", "api.fluence.dev"],
      }),
    ).rejects.toMatchObject({ code: "DOMAIN_NOT_ALLOWED" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not sign when the spend guard refuses", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(challengeResponse());
    const guard = makeGuard("daily cap reached");
    await expect(
      x402PaidFetch(URL_BLOCKRUN, postInit(), { account: TEST_ACCOUNT, fetchImpl, guard }),
    ).rejects.toMatchObject({ code: "GUARD_REFUSED", message: "daily cap reached" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(guard.record).not.toHaveBeenCalled();
  });

  it("reuses the same authorization when a paid request is retried (no double payment)", async () => {
    const ledger = new PaymentLedger();
    const guard = makeGuard();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(challengeResponse())
      .mockRejectedValueOnce(new Error("socket hang up")) // outcome unknown
      .mockResolvedValueOnce(paidResponse());

    const opts = { account: TEST_ACCOUNT, fetchImpl, guard, ledger };
    await expect(x402PaidFetch(URL_BLOCKRUN, postInit(), opts)).rejects.toThrow("socket hang up");
    expect(ledger.size).toBe(1);

    const retry = await x402PaidFetch(URL_BLOCKRUN, postInit(), opts);
    expect(retry.response.status).toBe(200);

    // Probe + 2 paid attempts; the retry did not probe again nor re-sign.
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const first = headerOf(fetchImpl.mock.calls[1][1], "PAYMENT-SIGNATURE");
    const second = headerOf(fetchImpl.mock.calls[2][1], "PAYMENT-SIGNATURE");
    expect(second).toBe(first);
    expect(guard.authorize).toHaveBeenCalledTimes(1);
    // Spend counted exactly once.
    expect(guard.record).toHaveBeenCalledTimes(1);
    expect(ledger.size).toBe(0);
  });

  it("signs a fresh payment for a different request body", async () => {
    const ledger = new PaymentLedger();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(challengeResponse())
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValueOnce(challengeResponse())
      .mockResolvedValueOnce(paidResponse());
    const opts = { account: TEST_ACCOUNT, fetchImpl, ledger };
    await expect(x402PaidFetch(URL_BLOCKRUN, postInit("a"), opts)).rejects.toThrow();
    await x402PaidFetch(URL_BLOCKRUN, postInit("b"), opts);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("records nothing when the server rejects the payment", async () => {
    const ledger = new PaymentLedger();
    const guard = makeGuard();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(challengeResponse())
      .mockResolvedValueOnce(challengeResponse());
    const { response } = await x402PaidFetch(URL_BLOCKRUN, postInit(), {
      account: TEST_ACCOUNT,
      fetchImpl,
      guard,
      ledger,
    });
    expect(response.status).toBe(402);
    expect(guard.record).not.toHaveBeenCalled();
    expect(ledger.size).toBe(0);
  });
});

describe("createX402Fetch", () => {
  it("throws on a 402 that carries no payable v2 challenge", async () => {
    const fetchImpl = vi.fn(async () => new Response("pay me", { status: 402 }));
    const paidFetch = createX402Fetch({ account: TEST_ACCOUNT, fetchImpl: fetchImpl as any });
    await expect(paidFetch(URL_BLOCKRUN, postInit())).rejects.toBeInstanceOf(X402PaymentError);
  });

  it("returns the paid response for OpenAI-compatible callers", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(challengeResponse())
      .mockResolvedValueOnce(paidResponse({ id: "cmpl-1" }));
    const paidFetch = createX402Fetch({ account: TEST_ACCOUNT, fetchImpl, ledger: new PaymentLedger() });
    const resp = await paidFetch(new URL(URL_BLOCKRUN), postInit());
    expect(await resp.json()).toEqual({ id: "cmpl-1" });
  });
});

describe("x402Fetch (tool entry point)", () => {
  it("pays v2 challenges and reports the amount paid", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(challengeResponse())
      .mockResolvedValueOnce(paidResponse({ hello: "world" }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await x402Fetch(
      URL_BLOCKRUN,
      TEST_ACCOUNT,
      "POST",
      '{"q":1}',
      undefined,
      10,
      "evm",
      { allowedDomains: ["blockrun.ai"] },
    );
    expect(result.success).toBe(true);
    expect(result.response).toEqual({ hello: "world" });
    expect(result.amountPaidCents).toBe(0.25);
  });

  it("returns an error instead of paying above the cap", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(challengeResponse(makeChallenge({ amount: "500000" }))));
    const result = await x402Fetch(URL_BLOCKRUN, TEST_ACCOUNT, "POST", "{}", undefined, 10);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/exceeds max/);
  });
});
