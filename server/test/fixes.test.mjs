// Regression tests for the payment fixes: signature reuse across SOL
// intents, atomic intent and token handling, the x402 claim registry,
// and the on chain lookup for a settle call that broke off.
// No network and no keys: the Solana connection is a stub.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import bs58 from "bs58";
import {
  ComputeBudgetProgram,
  Keypair,
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

// The store reads DATA_DIR at import time, so it is imported only after
// pointing it at a fresh temporary directory.
process.env.DATA_DIR = mkdtempSync(path.join(os.tmpdir(), "bayarsekali-test-"));
let store, verifyPayment, findSettlementOnChain, paymentFingerprint, USDC_MINT;
before(async () => {
  ({ store } = await import("../store.js"));
  ({ verifyPayment } = await import("../verify.js"));
  ({ findSettlementOnChain, paymentFingerprint, USDC_MINT } = await import("../x402.js"));
});

const SELLER = Keypair.generate().publicKey.toBase58();
const BUYER = Keypair.generate().publicKey.toBase58();

// A stub connection holding one System transfer of `lamports` from
// `source` to SELLER that carries every reference in `references`.
function solConnection({ signature, references, lamports, source = BUYER, destination = SELLER }) {
  const keys = [source, destination, ...references, "11111111111111111111111111111111"];
  return {
    getSignaturesForAddress: async (key) =>
      references.includes(key.toBase58())
        ? [{ signature, err: null, confirmationStatus: "confirmed" }]
        : [],
    getParsedTransaction: async () => ({
      transaction: {
        message: {
          accountKeys: keys.map((k) => ({ pubkey: new PublicKey(k) })),
          instructions: [
            { programId: "ComputeBudget111111111111111111111111111111", data: "x" },
            {
              program: "system",
              parsed: { type: "transfer", info: { source, destination, lamports } },
            },
          ],
        },
      },
      meta: { err: null, innerInstructions: [] },
    }),
  };
}

test("a seller buying from their own listing is verified (fee does not count against the price)", async () => {
  const reference = Keypair.generate().publicKey.toBase58();
  const result = await verifyPayment({
    reference,
    recipient: SELLER,
    amountSol: 0.01,
    connection: solConnection({
      signature: "sig-self",
      references: [reference],
      lamports: 10_000_000,
      source: SELLER,
    }),
  });
  assert.deepEqual(result, { paid: true, signature: "sig-self" });
});

test("a transfer below the price, or to someone else, does not pay", async () => {
  const reference = Keypair.generate().publicKey.toBase58();
  const small = await verifyPayment({
    reference,
    recipient: SELLER,
    amountSol: 0.01,
    connection: solConnection({ signature: "s1", references: [reference], lamports: 9_999_999 }),
  });
  assert.equal(small.reason, "insufficient");
  const elsewhere = await verifyPayment({
    reference,
    recipient: SELLER,
    amountSol: 0.01,
    connection: solConnection({
      signature: "s2",
      references: [reference],
      lamports: 10_000_000,
      destination: Keypair.generate().publicKey.toBase58(),
    }),
  });
  assert.equal(elsewhere.paid, false);
});

test("one transfer carrying two references pays for only one intent", async () => {
  const refA = Keypair.generate().publicKey.toBase58();
  const refB = Keypair.generate().publicKey.toBase58();
  const connection = solConnection({
    signature: "sig-multi-ref",
    references: [refA, refB],
    lamports: 10_000_000,
  });
  for (const [id, reference] of [["intent-a", refA], ["intent-b", refB]]) {
    await store.insertIntent({
      id,
      listingId: "l1",
      reference,
      amountSol: 0.01,
      recipient: SELLER,
      status: "pending",
      signature: null,
    });
  }

  const first = await verifyPayment({
    reference: refA,
    recipient: SELLER,
    amountSol: 0.01,
    usedSignatures: await store.usedSignatures(),
    connection,
  });
  assert.equal(first.paid, true);
  const markedA = await store.markIntentPaid("intent-a", first.signature);
  assert.equal(markedA.ok, true);

  // The second intent sees the same transaction, but its signature is spent.
  const second = await verifyPayment({
    reference: refB,
    recipient: SELLER,
    amountSol: 0.01,
    usedSignatures: await store.usedSignatures(),
    connection,
  });
  assert.equal(second.paid, false);
  assert.equal(second.reason, "not_found");

  // Even if the verify step were skipped, binding the signature twice fails.
  const markedB = await store.markIntentPaid("intent-b", "sig-multi-ref");
  assert.deepEqual(markedB, { ok: false, reason: "signature_used" });
});

test("racing intents can not both claim one signature", async () => {
  for (const id of ["race-1", "race-2"]) {
    await store.insertIntent({ id, listingId: "l1", status: "pending", signature: null });
  }
  const results = await Promise.all([
    store.markIntentPaid("race-1", "sig-race"),
    store.markIntentPaid("race-2", "sig-race"),
  ]);
  assert.equal(results.filter((r) => r.ok).length, 1);
});

test("a download token is consumed exactly once, even under a race", async () => {
  const token = {
    token: "tok-race",
    listingId: "l1",
    intentId: "intent-tok",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    used: false,
  };
  assert.ok(await store.issueToken(token, 5));
  const results = await Promise.all([
    store.consumeToken("tok-race"),
    store.consumeToken("tok-race"),
  ]);
  assert.equal(results.filter((r) => r.token).length, 1);

  // A failed transfer gives the token back.
  await store.restoreToken("tok-race");
  assert.ok((await store.consumeToken("tok-race")).token);
});

test("an expired token is refused and burned", async () => {
  await store.issueToken(
    {
      token: "tok-old",
      intentId: "intent-old",
      expiresAt: new Date(Date.now() - 1).toISOString(),
      used: false,
    },
    5
  );
  assert.deepEqual(await store.consumeToken("tok-old"), { error: "expired" });
  assert.deepEqual(await store.consumeToken("tok-old"), { error: "invalid" });
});

test("download tokens per intent are capped", async () => {
  for (let i = 0; i < 3; i++) {
    assert.ok(await store.issueToken({ token: "cap-" + i, intentId: "intent-cap" }, 3));
  }
  assert.equal(await store.issueToken({ token: "cap-3", intentId: "intent-cap" }, 3), null);
});

test("x402 registry: failed claims are retaken, settled ones never", async () => {
  const fresh = () => ({
    paymentKey: "pk-1",
    listingId: "l1",
    status: "pending",
    createdAt: new Date().toISOString(),
  });
  assert.equal((await store.claimPayment(fresh())).claimed, true);
  // A fresh pending claim blocks a racing second request.
  assert.equal((await store.claimPayment(fresh())).claimed, false);

  await store.finishPayment("pk-1", { status: "unknown" });
  const retaken = await store.claimPayment(fresh());
  assert.equal(retaken.claimed, true);
  assert.equal(retaken.previous.status, "unknown");

  await store.finishPayment("pk-1", { status: "settled", signature: "s" });
  // A late failure must not overwrite the settlement.
  await store.finishPayment("pk-1", { status: "failed" });
  assert.equal((await store.getPayment("pk-1")).status, "settled");
  assert.equal((await store.claimPayment(fresh())).claimed, false);
});

test("concurrent claims of one new payment: exactly one wins", async () => {
  const record = () => ({
    paymentKey: "pk-race",
    listingId: "l1",
    status: "pending",
    createdAt: new Date().toISOString(),
  });
  const results = await Promise.all([store.claimPayment(record()), store.claimPayment(record())]);
  assert.equal(results.filter((r) => r.claimed).length, 1);
});

// x402 on chain lookup after a settle call that broke off.
const FEE_PAYER = Keypair.generate();
const PAYER = Keypair.generate();
const SELLER_KEY = Keypair.generate().publicKey;
const MEMO_PROGRAM = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

function signedPayment(buyer, nonce) {
  const mint = new PublicKey(USDC_MINT);
  const message = new TransactionMessage({
    payerKey: FEE_PAYER.publicKey,
    recentBlockhash: "4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM",
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
      createTransferCheckedInstruction(
        getAssociatedTokenAddressSync(mint, buyer.publicKey),
        mint,
        getAssociatedTokenAddressSync(mint, SELLER_KEY),
        buyer.publicKey,
        10000n,
        6,
        [],
        TOKEN_PROGRAM_ID
      ),
      new TransactionInstruction({
        programId: MEMO_PROGRAM,
        keys: [],
        data: Buffer.from(nonce, "utf8"),
      }),
    ],
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  tx.sign([buyer]);
  return tx;
}

function chainWith(landedTx) {
  const signatures = landedTx.signatures.map((s) => bs58.encode(Buffer.from(s)));
  return {
    getSignaturesForAddress: async () => [
      { signature: "landed-sig", err: null, memo: "[32] " + paymentNonce },
    ],
    getTransaction: async () => ({ transaction: { signatures }, meta: { err: null } }),
  };
}

const paymentNonce = "00112233445566778899aabbccddeeff";
const requirementsFor = () => ({
  asset: USDC_MINT,
  payTo: SELLER_KEY.toBase58(),
  extra: { feePayer: FEE_PAYER.publicKey.toBase58() },
});

test("paymentFingerprint reads the memo nonce and the buyer signature", () => {
  const tx = signedPayment(PAYER, paymentNonce);
  const fp = paymentFingerprint(
    Buffer.from(tx.serialize()).toString("base64"),
    FEE_PAYER.publicKey.toBase58()
  );
  assert.equal(fp.memo, paymentNonce);
  assert.equal(fp.buyerSignature, bs58.encode(Buffer.from(tx.signatures[1])));
});

test("a payment that landed despite a broken settle call is found on chain", async () => {
  const tx = signedPayment(PAYER, paymentNonce);
  const found = await findSettlementOnChain({
    connection: chainWith(tx),
    transactionBase64: Buffer.from(tx.serialize()).toString("base64"),
    requirements: requirementsFor(),
  });
  assert.equal(found, "landed-sig");
});

test("a forged payment that copies someone else's nonce is not matched", async () => {
  const victim = signedPayment(PAYER, paymentNonce);
  const forged = signedPayment(Keypair.generate(), paymentNonce);
  const found = await findSettlementOnChain({
    connection: chainWith(victim),
    transactionBase64: Buffer.from(forged.serialize()).toString("base64"),
    requirements: requirementsFor(),
  });
  assert.equal(found, null);
});
