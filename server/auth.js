// Sign in with Solana for sellers. There are no accounts in BayarSekali:
// the wallet is the identity, and this module makes that true. Before a
// listing is created, the seller's wallet signs a one time challenge
// message (free, no transaction). The server checks the ed25519
// signature against the seller wallet, so nobody can create listings in
// someone else's name, and a signature can never be reused.
import { createPublicKey, randomBytes, verify } from "node:crypto";
import bs58 from "bs58";

export const CHALLENGE_TTL_MS = 5 * 60 * 1000;

export function buildChallengeMessage({ domain, wallet, nonce, issuedAt }) {
  return [
    `${domain} wants you to sign in with your Solana account:`,
    wallet,
    "",
    "Create a listing on BayarSekali. Signing is free and sends no transaction.",
    "",
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
  ].join("\n");
}

// DER prefix of an ed25519 SubjectPublicKeyInfo; the raw 32 byte key follows.
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

// Verify an ed25519 signature (base64 or base58) of `message` by the
// Solana address `wallet`. Never throws; returns a boolean.
export function verifyWalletSignature({ wallet, message, signature }) {
  try {
    const raw = Buffer.from(bs58.decode(wallet));
    if (raw.length !== 32) return false;
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
      format: "der",
      type: "spki",
    });
    let sig = Buffer.from(String(signature), "base64");
    if (sig.length !== 64) sig = Buffer.from(bs58.decode(String(signature)));
    if (sig.length !== 64) return false;
    return verify(null, Buffer.from(message, "utf8"), key, sig);
  } catch {
    return false;
  }
}

// One time challenges, kept in memory. A restart simply asks sellers
// to sign again.
export function createChallengeStore({ ttlMs = CHALLENGE_TTL_MS, now = () => Date.now() } = {}) {
  const challenges = new Map();

  function sweep() {
    const t = now();
    for (const [nonce, c] of challenges) if (c.expiresAt <= t) challenges.delete(nonce);
  }

  return {
    issue({ domain, wallet }) {
      sweep();
      const nonce = randomBytes(16).toString("hex");
      const issuedAt = new Date(now()).toISOString();
      const message = buildChallengeMessage({ domain, wallet, nonce, issuedAt });
      challenges.set(nonce, { wallet, message, expiresAt: now() + ttlMs });
      return { nonce, message, expiresAt: new Date(now() + ttlMs).toISOString() };
    },

    // Consume a challenge: valid only once, only for its own wallet,
    // only before it expires, and only with a good signature.
    // Returns { ok: true } or { ok: false, reason }.
    consume({ nonce, wallet, signature }) {
      if (!nonce || !signature) {
        return {
          ok: false,
          reason:
            "A wallet signature is required: POST /api/auth/challenge { wallet }, sign the returned message with that wallet, and send authNonce and authSignature with the listing.",
        };
      }
      const c = typeof nonce === "string" ? challenges.get(nonce) : null;
      if (!c) return { ok: false, reason: "Sign in again: the challenge is unknown or already used." };
      if (c.expiresAt <= now()) {
        challenges.delete(nonce);
        return { ok: false, reason: "Sign in again: the challenge expired." };
      }
      if (c.wallet !== wallet) {
        return { ok: false, reason: "The signature belongs to a different wallet." };
      }
      if (!verifyWalletSignature({ wallet, message: c.message, signature })) {
        return { ok: false, reason: "The wallet signature is not valid." };
      }
      challenges.delete(nonce);
      return { ok: true };
    },
  };
}
