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

// Account keys of a parsed transaction (getParsedTransaction shape).
function accountKeysOf(tx) {
  return tx.transaction.message.accountKeys.map((k) =>
    typeof k === "string" ? k : k.pubkey.toString()
  );
}

// Lamports a parsed transaction moves to `recipient` through System
// Program transfers, top level and inner (for wallets that route the
// transfer through a program). Reading the instructions instead of the
// recipient's balance change keeps the check right when the recipient
// also signs and pays the fee, for example a seller buying from their
// own listing in a demo: their balance drops by the fee while the
// transfer itself carries the full price.
export function lamportsTransferredTo(tx, recipient) {
  const instructions = [...tx.transaction.message.instructions];
  for (const inner of (tx.meta && tx.meta.innerInstructions) || []) {
    instructions.push(...inner.instructions);
  }
  let total = 0n;
  for (const ix of instructions) {
    if (ix.program !== "system" || !ix.parsed) continue;
    const { type, info } = ix.parsed;
    if (type !== "transfer" && type !== "transferWithSeed") continue;
    if (!info || String(info.destination) !== recipient) continue;
    total += BigInt(info.lamports);
  }
  return total;
}

// Poll devnet for a payment that carries the intent reference key and
// delivers at least the exact lamports to the recipient wallet.
//
// usedSignatures holds every signature that already paid for some
// intent. Those transactions are skipped, so one transfer that carries
// several reference keys can never unlock more than one purchase.
//
// Returns one of:
//   { paid: true, signature }
//   { paid: false, reason: "not_found" }   nothing seen yet, caller may retry
//   { paid: false, reason: "insufficient", signature }  transfer too small
export async function verifyPayment({
  reference,
  recipient,
  amountSol,
  usedSignatures = new Set(),
  connection = getConnection(),
}) {
  const referenceKey = new PublicKey(reference);
  const expectedLamports = solToLamports(amountSol);
  if (expectedLamports === null) {
    return { paid: false, reason: "bad_amount" };
  }

  const signatures = await connection.getSignaturesForAddress(referenceKey, {
    limit: 25,
  });

  let insufficient = null;
  for (const sigInfo of signatures) {
    if (sigInfo.err) continue;
    if (usedSignatures.has(sigInfo.signature)) continue;
    // Only accept confirmed or finalized transactions.
    if (
      sigInfo.confirmationStatus !== "confirmed" &&
      sigInfo.confirmationStatus !== "finalized"
    ) {
      continue;
    }

    // Fetch at the same commitment the signature was accepted at, so a
    // confirmed but not yet finalized payment is not silently skipped.
    const tx = await connection.getParsedTransaction(sigInfo.signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    if (!tx || !tx.meta || tx.meta.err) continue;

    // The reference key must be part of this transaction, which the
    // signature lookup already implies, but we check it explicitly so a
    // coincidental signature entry cannot pass.
    if (!accountKeysOf(tx).includes(reference)) continue;

    const received = lamportsTransferredTo(tx, recipient);

    if (received >= BigInt(expectedLamports)) {
      return { paid: true, signature: sigInfo.signature };
    }
    if (!insufficient) {
      insufficient = {
        paid: false,
        reason: "insufficient",
        signature: sigInfo.signature,
        receivedLamports: Number(received),
        expectedLamports,
      };
    }
  }

  return insufficient || { paid: false, reason: "not_found" };
}
