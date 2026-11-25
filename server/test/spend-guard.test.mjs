// Agent spending guardrails: limits are enforced before signing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSpendGuard, atomicToUsdc } from "../spend-guard.mjs";
import { USDC_MINT, X402_NETWORK } from "../x402.js";

const SELLER = "BW66pCspdPt8RH4bBGy8NGVSf2xMFNb3mr7FzWji8SML";
const req = (amount, over = {}) => ({
  network: X402_NETWORK,
  asset: USDC_MINT,
  payTo: SELLER,
  amount: String(amount),
  ...over,
});
const guard = (over = {}) =>
  createSpendGuard({
    budgetUsdc: "0.05",
    maxPerPurchaseUsdc: "0.02",
    network: X402_NETWORK,
    asset: USDC_MINT,
    ...over,
  });

test("atomicToUsdc formats without float drift", () => {
  assert.equal(atomicToUsdc(10000n), "0.01");
  assert.equal(atomicToUsdc("1000000"), "1");
  assert.equal(atomicToUsdc(1), "0.000001");
});

test("purchases within limits pass and are counted", () => {
  const g = guard();
  const t = g.reserve(req(20000));
  g.commit(t, { signature: "s" });
  assert.equal(g.status().spentUsdc, "0.02");
  assert.equal(g.status().remainingUsdc, "0.03");
  assert.equal(g.status().purchases.length, 1);
});

test("the per purchase cap and the total budget are enforced", () => {
  const g = guard();
  assert.throws(() => g.reserve(req(20001)), /per purchase limit/);
  g.commit(g.reserve(req(20000)));
  g.commit(g.reserve(req(20000)));
  assert.throws(() => g.reserve(req(20000)), /remaining budget/);
  g.reserve(req(10000)); // exactly the rest still fits
});

test("reservations hold budget for purchases in flight; release gives it back", () => {
  const g = guard();
  const a = g.reserve(req(20000));
  const b = g.reserve(req(20000));
  assert.throws(() => g.reserve(req(20000)), /remaining budget/);
  g.release(b);
  g.reserve(req(20000));
  g.release(a);
  assert.equal(g.status().spentUsdc, "0");
});

test("wrong network, wrong asset, or a seller off the allowlist is refused", () => {
  const g = guard({ allowedSellers: [SELLER] });
  assert.throws(() => g.reserve(req(100, { network: "solana:mainnet" })), /network/);
  assert.throws(() => g.reserve(req(100, { asset: "So11111111111111111111111111111111111111112" })), /not USDC/);
  assert.throws(() => g.reserve(req(100, { payTo: "11111111111111111111111111111111" })), /allowlist/);
  assert.throws(() => g.reserve(req("abc")), /unreadable/);
  assert.throws(() => g.reserve(req(0)), /positive/);
});
