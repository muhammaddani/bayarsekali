import { Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";

const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";

export function getConnection() {
  return new Connection(RPC_URL, "confirmed");
}

// Convert a SOL amount to lamports without floating point drift.
// Prices are accepted with at most 9 decimal places.
export function solToLamports(amountSol) {
  const lamports = Math.round(Number(amountSol) * LAMPORTS_PER_SOL);
  if (!Number.isFinite(lamports) || lamports <= 0) return null;
  return lamports;
}

// Account keys of a parsed transaction, across legacy and versioned shapes.
function accountKeysOf(tx) {
  const message = tx.transaction.message;
  const keys = [];
  if (Array.isArray(message.accountKeys)) {
    for (const k of message.accountKeys) {
      if (typeof k === "string") keys.push(k);
      else if (k && k.pubkey) keys.push(k.pubkey.toString());
      else if (k) keys.push(k.toString());
    }
  }
  if (Array.isArray(message.staticAccountKeys)) {
    for (const k of message.staticAccountKeys) keys.push(k.toString());
  }
  const loaded = tx.meta && tx.meta.loadedAddresses;
  if (loaded) {
    for (const k of loaded.writable || []) keys.push(k.toString());
    for (const k of loaded.readonly || []) keys.push(k.toString());
  }
  return keys;
}

// Poll devnet for a payment that carries the intent reference key and
// delivers at least the exact lamports to the recipient wallet.
//
// Returns one of:
//   { paid: true, signature }
//   { paid: false, reason: "not_found" }   nothing seen yet, caller may retry
//   { paid: false, reason: "insufficient", signature }  transfer too small
export async function verifyPayment({ reference, recipient, amountSol }) {
  const connection = getConnection();
  const referenceKey = new PublicKey(reference);
  const expectedLamports = solToLamports(amountSol);
  if (expectedLamports === null) {
    return { paid: false, reason: "bad_amount" };
  }

  const signatures = await connection.getSignaturesForAddress(referenceKey, {
    limit: 25,
  });

  for (const sigInfo of signatures) {
    if (sigInfo.err) continue;
    // Only accept confirmed or finalized transactions.
    if (
      sigInfo.confirmationStatus !== "confirmed" &&
      sigInfo.confirmationStatus !== "finalized"
    ) {
      continue;
    }

    const tx = await connection.getTransaction(sigInfo.signature, {
      commitment: "finalized",
      maxSupportedTransactionVersion: 0,
    });
    if (!tx || !tx.meta || tx.meta.err) continue;

    const keys = accountKeysOf(tx);
    const recipientIndex = keys.indexOf(recipient);
    if (recipientIndex === -1) continue;

    // The reference key must be part of this transaction, which the
    // signature lookup already implies, but we check it explicitly so a
    // coincidental signature entry cannot pass.
    if (!keys.includes(reference)) continue;

    const pre = tx.meta.preBalances[recipientIndex] || 0;
    const post = tx.meta.postBalances[recipientIndex] || 0;
    const received = post - pre;

    if (received >= expectedLamports) {
      return { paid: true, signature: sigInfo.signature };
    }
    return {
      paid: false,
      reason: "insufficient",
      signature: sigInfo.signature,
      receivedLamports: received,
      expectedLamports,
    };
  }

  return { paid: false, reason: "not_found" };
}
