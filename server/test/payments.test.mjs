// Payment-critical unit tests for BayarSekali.
// Run with: npm test   (from the server directory)
// These tests need no network and no keys. They pin down the money
// math, the payment header parsing, the local transaction check that
// mirrors the facilitator, and the replay registry semantics.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ComputeBudgetProgram,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  usdcToAtomic,
  parsePaymentHeader,
  paymentKeyOf,
  localCheckTransaction,
  USDC_MINT,
} from "../x402.js";
import { store } from "../store.js";

const BUYER = new PublicKey("BW66pCspdPt8RH4bBGy8NGVSf2xMFNb3mr7FzWji8SML");
const OTHER = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const FEE_PAYER = new PublicKey("CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5");
const MINT = new PublicKey(USDC_MINT);
const MEMO_PROGRAM = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const BLOCKHASH = "4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM";

function requirements(overrides = {}) {
  return {
    scheme: "exact",
    network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
    amount: "10000",
    asset: USDC_MINT,
    payTo: BUYER.toBase58(),
    maxTimeoutSeconds: 120,
    extra: { feePayer: FEE_PAYER.toBase58() },
    ...overrides,
  };
}

function buildPaymentTx({ amount = 10000n, dest = null, payerKey = FEE_PAYER } = {}) {
  const ata = getAssociatedTokenAddressSync(MINT, BUYER);
  const instructions = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
    createTransferCheckedInstruction(
      ata,
      MINT,
      dest || ata,
      BUYER,
      amount,
      6,
      [],
      TOKEN_PROGRAM_ID
    ),
    new TransactionInstruction({
      programId: MEMO_PROGRAM,
      keys: [],
      data: Buffer.from("0123456789abcdeffedcba9876543210", "utf8"),
    }),
  ];
  const message = new TransactionMessage({
    payerKey,
    recentBlockhash: BLOCKHASH,
    instructions,
  }).compileToV0Message();
  return Buffer.from(new VersionedTransaction(message).serialize()).toString("base64");
}

test("usdcToAtomic converts exact decimal strings", () => {
  assert.equal(usdcToAtomic("0.01"), "10000");
  assert.equal(usdcToAtomic("1"), "1000000");
  assert.equal(usdcToAtomic("0.000001"), "1");
  assert.equal(usdcToAtomic("12.5"), "12500000");
  assert.equal(usdcToAtomic(0.02), "20000");
});

test("usdcToAtomic rejects invalid or non positive amounts", () => {
  for (const bad of ["0", "0.0", "-1", "0.0000001", "1.1234567", "abc", "", "  ", null, undefined, NaN]) {
    assert.equal(usdcToAtomic(bad), null, `expected null for ${String(bad)}`);
  }
});

test("parsePaymentHeader accepts a well formed payload", () => {
  const payload = {
    x402Version: 2,
    accepted: requirements(),
    payload: { transaction: buildPaymentTx() },
  };
  const header = Buffer.from(JSON.stringify(payload)).toString("base64");
  const parsed = parsePaymentHeader(header);
  assert.equal(parsed.x402Version, 2);
  assert.equal(parsed.payload.transaction, payload.payload.transaction);
});

test("parsePaymentHeader rejects wrong versions and broken shapes", () => {
  const wrong = Buffer.from(JSON.stringify({ x402Version: 1, payload: { transaction: "x" } })).toString("base64");
  assert.equal(parsePaymentHeader(wrong), null);
  const noTx = Buffer.from(JSON.stringify({ x402Version: 2, payload: {} })).toString("base64");
  assert.equal(parsePaymentHeader(noTx), null);
  assert.equal(parsePaymentHeader("not base64 at all!!!"), null);
  assert.equal(parsePaymentHeader(""), null);
  assert.equal(parsePaymentHeader(null), null);
});

test("paymentKeyOf is stable per transaction and unique across transactions", () => {
  const a = buildPaymentTx();
  const b = buildPaymentTx({ amount: 20000n });
  assert.equal(paymentKeyOf(a), paymentKeyOf(a));
  assert.notEqual(paymentKeyOf(a), paymentKeyOf(b));
  assert.match(paymentKeyOf(a), /^[0-9a-f]{64}$/);
});

test("localCheckTransaction accepts the spec payment layout", () => {
  const result = localCheckTransaction(buildPaymentTx(), requirements());
  assert.deepEqual(result, { ok: true });
});

test("localCheckTransaction rejects amount, fee payer, and destination mismatches", () => {
  assert.equal(localCheckTransaction(buildPaymentTx({ amount: 9999n }), requirements()).ok, false);
  assert.equal(localCheckTransaction(buildPaymentTx(), requirements({ amount: "20000" })).ok, false);
  assert.equal(localCheckTransaction(buildPaymentTx({ payerKey: OTHER }), requirements()).ok, false);
  const wrongDest = getAssociatedTokenAddressSync(MINT, OTHER);
  assert.equal(localCheckTransaction(buildPaymentTx({ dest: wrongDest }), requirements()).ok, false);
});

test("replay registry: a payment can be claimed only once", async () => {
  const paymentKey = "test-" + Date.now() + "-" + Math.random().toString(16).slice(2);
  const first = await store.claimPayment({
    paymentKey,
    listingId: "listing-a",
    status: "pending",
    signature: null,
    createdAt: new Date().toISOString(),
  });
  assert.equal(first.claimed, true);
  const second = await store.claimPayment({
    paymentKey,
    listingId: "listing-a",
    status: "pending",
    signature: null,
    createdAt: new Date().toISOString(),
  });
  assert.equal(second.claimed, false);
  assert.equal(second.record.listingId, "listing-a");
  await store.updatePayment(paymentKey, { status: "settled", signature: "sig123" });
  const after = await store.getPayment(paymentKey);
  assert.equal(after.status, "settled");
  assert.equal(after.signature, "sig123");
});
