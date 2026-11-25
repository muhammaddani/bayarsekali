// x402 protocol support for BayarSekali API products.
//
// Implements the resource server side of the x402 standard (version 2,
// scheme "exact", Solana devnet, USDC) against a hosted facilitator:
// the server answers 402 with payment requirements, the buyer retries
// with an X-PAYMENT header carrying a partially signed transaction, and
// the facilitator verifies and settles it on chain. The buyer never
// needs SOL; the facilitator is the transaction fee payer.
//
// Reference shapes follow the x402 specification and the Solana x402
// field guide. Constants verified live on 25 Nov 2026: the facilitator
// at x402.org lists solana devnet (CAIP-2) with its fee payer, and the
// asset mint is Circle's official devnet USDC (6 decimals).

import { createHash } from "node:crypto";
import bs58 from "bs58";
import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

export const X402_VERSION = 2;
export const X402_NETWORK = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
export const USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
export const USDC_DECIMALS = 6;

const FACILITATOR_URL = (
  process.env.X402_FACILITATOR_URL || "https://x402.org/facilitator"
).replace(/\/+$/, "");

// Fallback fee payer, used only if the facilitator /supported call
// fails. Matches the live /supported response read on 25 Nov 2026.
const FALLBACK_FEE_PAYER = "CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5";

const FACILITATOR_TIMEOUT_MS = 30_000;

async function fetchJson(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FACILITATOR_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const text = await res.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    return { status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

let feePayerCache = null;

// The fee payer is published by the facilitator itself. Read it from
// /supported and cache it; fall back to the last verified value.
export async function getFeePayer() {
  if (feePayerCache) return feePayerCache;
  try {
    const { body } = await fetchJson(FACILITATOR_URL + "/supported", {
      method: "GET",
    });
    const kinds = (body && body.kinds) || [];
    const kind = kinds.find(
      (k) =>
        k.x402Version === X402_VERSION &&
        k.scheme === "exact" &&
        k.network === X402_NETWORK &&
        k.extra &&
        k.extra.feePayer
    );
    feePayerCache = kind ? kind.extra.feePayer : FALLBACK_FEE_PAYER;
  } catch {
    feePayerCache = FALLBACK_FEE_PAYER;
  }
  return feePayerCache;
}

// Convert a USDC amount (number or decimal string, at most 6 decimal
// places) to its atomic integer string without floating point drift.
// Returns null for anything invalid or not positive.
export function usdcToAtomic(value) {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    value = String(value);
  }
  if (typeof value !== "string") return null;
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(value.trim());
  if (!match) return null;
  const whole = match[1].replace(/^0+(?=\d)/, "");
  const frac = (match[2] || "").padEnd(USDC_DECIMALS, "0");
  const atomic = BigInt(whole) * 1_000_000n + BigInt(frac || "0");
  if (atomic <= 0n) return null;
  return atomic.toString();
}

export async function buildRequirements({ resourceUrl, description, payTo, amountAtomic }) {
  const feePayer = await getFeePayer();
  return {
    scheme: "exact",
    network: X402_NETWORK,
    amount: amountAtomic,
    asset: USDC_MINT,
    payTo,
    maxTimeoutSeconds: 120,
    extra: { feePayer },
  };
}

export function paymentRequiredBody({ resourceUrl, description, requirements }) {
  return {
    x402Version: X402_VERSION,
    resource: {
      url: resourceUrl,
      description: description || "Access to a paid resource",
      mimeType: "application/json",
    },
    accepts: [requirements],
  };
}

// A stable identity for one payment transaction: the SHA-256 of its
// serialized bytes. The same signed payment always produces the same
// key and any different payment produces a different one, which is
// what the server's replay registry is keyed on.
export function paymentKeyOf(transactionBase64) {
  try {
    return createHash("sha256")
      .update(Buffer.from(transactionBase64, "base64"))
      .digest("hex");
  } catch {
    return null;
  }
}

// Parse and shape check the X-PAYMENT header. Returns the payload
// object or null when the header is not a well formed x402 payload.
export function parsePaymentHeader(header) {
  if (!header || typeof header !== "string") return null;
  try {
    const payload = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
    if (!payload || payload.x402Version !== X402_VERSION) return null;
    if (!payload.payload || typeof payload.payload.transaction !== "string") {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

// Local structural check of the payment transaction. This mirrors the
// facilitator's own checks and fails fast on obvious mismatches; the
// facilitator stays authoritative and rechecks everything at settle.
// Returns { ok: true } or { ok: false, reason }.
export function localCheckTransaction(transactionBase64, requirements) {
  let tx;
  try {
    tx = VersionedTransaction.deserialize(
      Buffer.from(transactionBase64, "base64")
    );
  } catch {
    return { ok: false, reason: "transaction could not be deserialized" };
  }
  const keys = tx.message.staticAccountKeys;
  if (!keys.length || keys[0].toBase58() !== requirements.extra.feePayer) {
    return { ok: false, reason: "fee payer mismatch" };
  }
  // Scan every instruction: wallets may prepend their own compute
  // budget instructions, so TransferChecked is not at a fixed index.
  const transferIx = tx.message.compiledInstructions.find((ix) => {
    const program = keys[ix.programIdIndex];
    return (
      program &&
      program.equals(TOKEN_PROGRAM_ID) &&
      ix.data &&
      ix.data[0] === 12 // TransferChecked discriminator
    );
  });
  if (!transferIx) return { ok: false, reason: "no TransferChecked instruction" };

  const data = Buffer.from(transferIx.data);
  const amount = data.readBigUInt64LE(1);
  if (amount !== BigInt(requirements.amount)) {
    return { ok: false, reason: "amount mismatch" };
  }
  // TransferChecked accounts: [source, mint, destination, owner].
  const mint = keys[transferIx.accountKeyIndexes[1]];
  if (!mint || mint.toBase58() !== requirements.asset) {
    return { ok: false, reason: "mint mismatch" };
  }
  const destination = keys[transferIx.accountKeyIndexes[2]];
  const expectedDestination = getAssociatedTokenAddressSync(
    new PublicKey(requirements.asset),
    new PublicKey(requirements.payTo)
  );
  if (!destination || !destination.equals(expectedDestination)) {
    return { ok: false, reason: "destination mismatch" };
  }
  return { ok: true };
}

const MEMO_PROGRAM_ID = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

// The memo text and the buyer's signature of a payment transaction.
// The memo carries the random nonce; the buyer's signature is fixed
// the moment the buyer signs and survives the facilitator adding its
// own fee payer signature, so it identifies this exact payment on
// chain. Returns null when either is missing.
export function paymentFingerprint(transactionBase64, feePayer) {
  let tx;
  try {
    tx = VersionedTransaction.deserialize(Buffer.from(transactionBase64, "base64"));
  } catch {
    return null;
  }
  const keys = tx.message.staticAccountKeys;
  const memoIx = tx.message.compiledInstructions.find(
    (ix) => keys[ix.programIdIndex] && keys[ix.programIdIndex].toBase58() === MEMO_PROGRAM_ID
  );
  if (!memoIx) return null;
  const memo = Buffer.from(memoIx.data).toString("utf8");
  // Signers come first in the account keys, signatures in the same order.
  let buyerSignature = null;
  for (let i = 0; i < tx.message.header.numRequiredSignatures; i++) {
    if (keys[i].toBase58() === feePayer) continue;
    const sig = tx.signatures[i];
    if (sig && sig.some((b) => b !== 0)) {
      buyerSignature = bs58.encode(Buffer.from(sig));
      break;
    }
  }
  if (!buyerSignature) return null;
  return { memo, buyerSignature };
}

// Look for this exact payment among the recent transactions of the
// seller's token account. Used when a facilitator settle call broke off
// without an answer: the payment may have landed anyway, and a buyer
// who paid must not be refused. A match needs the same memo nonce AND
// the buyer's own signature, so a forged transaction that copies
// someone else's nonce can never match.
// Returns the on chain signature or null.
export async function findSettlementOnChain({ connection, transactionBase64, requirements }) {
  const fingerprint = paymentFingerprint(transactionBase64, requirements.extra.feePayer);
  if (!fingerprint) return null;
  const destination = getAssociatedTokenAddressSync(
    new PublicKey(requirements.asset),
    new PublicKey(requirements.payTo)
  );
  const recent = await connection.getSignaturesForAddress(destination, { limit: 50 }, "confirmed");
  for (const info of recent) {
    if (info.err || !info.memo || !info.memo.includes(fingerprint.memo)) continue;
    const tx = await connection.getTransaction(info.signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    if (!tx || !tx.meta || tx.meta.err) continue;
    if (tx.transaction.signatures.includes(fingerprint.buyerSignature)) {
      return info.signature;
    }
  }
  return null;
}

async function facilitatorPost(path, paymentPayload, paymentRequirements) {
  const { status, body } = await fetchJson(FACILITATOR_URL + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      x402Version: X402_VERSION,
      paymentPayload,
      paymentRequirements,
    }),
  });
  if (!body) {
    throw new Error("Facilitator " + path + " returned HTTP " + status + " without JSON.");
  }
  return body;
}

export function facilitatorVerify(paymentPayload, paymentRequirements) {
  return facilitatorPost("/verify", paymentPayload, paymentRequirements);
}

export function facilitatorSettle(paymentPayload, paymentRequirements) {
  return facilitatorPost("/settle", paymentPayload, paymentRequirements);
}

export function paymentResponseHeader(settleResult) {
  return Buffer.from(JSON.stringify(settleResult), "utf8").toString("base64");
}
