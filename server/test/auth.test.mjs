// Seller sign in: a listing needs a fresh challenge signed by the
// seller wallet. No network, no real keys.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPrivateKey, sign } from "node:crypto";
import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";
import { createChallengeStore, verifyWalletSignature } from "../auth.js";

// Sign a UTF-8 message with a Solana keypair, the way a wallet's
// signMessage does (ed25519 over the raw bytes).
function signWith(keypair, message) {
  const seed = Buffer.from(keypair.secretKey.slice(0, 32));
  const key = createPrivateKey({
    key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]),
    format: "der",
    type: "pkcs8",
  });
  return sign(null, Buffer.from(message, "utf8"), key);
}

const seller = Keypair.generate();
const wallet = seller.publicKey.toBase58();

test("a signed challenge is accepted exactly once", () => {
  const store = createChallengeStore();
  const c = store.issue({ domain: "bayarsekali.test", wallet });
  assert.match(c.message, /bayarsekali\.test wants you to sign in/);
  assert.ok(c.message.includes(wallet) && c.message.includes(c.nonce));
  const signature = signWith(seller, c.message).toString("base64");
  assert.deepEqual(store.consume({ nonce: c.nonce, wallet, signature }), { ok: true });
  assert.equal(store.consume({ nonce: c.nonce, wallet, signature }).ok, false);
});

test("base58 signatures are accepted too", () => {
  const store = createChallengeStore();
  const c = store.issue({ domain: "d", wallet });
  const signature = bs58.encode(signWith(seller, c.message));
  assert.equal(store.consume({ nonce: c.nonce, wallet, signature }).ok, true);
});

test("someone else's wallet can not create listings for a seller", () => {
  const store = createChallengeStore();
  const attacker = Keypair.generate();
  // The attacker asks for a challenge in the seller's name and signs it
  // with their own key.
  const c = store.issue({ domain: "d", wallet });
  const forged = signWith(attacker, c.message).toString("base64");
  assert.equal(store.consume({ nonce: c.nonce, wallet, signature: forged }).ok, false);
  // A challenge issued for one wallet can not be used for another.
  const own = store.issue({ domain: "d", wallet: attacker.publicKey.toBase58() });
  const sig = signWith(attacker, own.message).toString("base64");
  assert.equal(store.consume({ nonce: own.nonce, wallet, signature: sig }).ok, false);
});

test("expired or unknown challenges are refused", () => {
  let t = 1_000_000;
  const store = createChallengeStore({ ttlMs: 1000, now: () => t });
  const c = store.issue({ domain: "d", wallet });
  const signature = signWith(seller, c.message).toString("base64");
  t += 1001;
  assert.equal(store.consume({ nonce: c.nonce, wallet, signature }).ok, false);
  assert.equal(store.consume({ nonce: "nope", wallet, signature }).ok, false);
  assert.equal(store.consume({ nonce: undefined, wallet, signature }).ok, false);
});

test("a signature over a different message is refused", () => {
  const signature = signWith(seller, "something else").toString("base64");
  assert.equal(verifyWalletSignature({ wallet, message: "the challenge", signature }), false);
  assert.equal(verifyWalletSignature({ wallet, message: "x", signature: "garbage" }), false);
  assert.equal(verifyWalletSignature({ wallet: "bad", message: "x", signature }), false);
});
