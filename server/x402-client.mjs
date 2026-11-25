// A reusable x402 buyer library for Solana (devnet, USDC, exact
// scheme, x402 v2). Any agent that holds a keypair can pay for an
// x402 resource in a few lines:
//
//   import { Connection, Keypair } from "@solana/web3.js";
//   import { payForResource } from "./x402-client.mjs";
//
//   const { data, receipt } = await payForResource({
//     resourceUrl: "https://example.com/api/resource/<id>",
//     keypair: agentKeypair,
//     connection: new Connection("https://api.devnet.solana.com"),
//   });
//
// The buyer never pays network fees; the facilitator named in the
// payment requirements does. If the receiving token account does not
// exist yet, it is created first in a separate transaction paid by
// the buyer, because the facilitator will not fund account creation.
import {
  ComputeBudgetProgram,
  PublicKey,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

export const MEMO_PROGRAM_ID = new PublicKey(
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"
);

// Build the unsigned payment transaction for one set of payment
// requirements, with the facilitator as fee payer. The layout is the
// one the facilitator's static verification path accepts, in relative
// order: compute unit limit, compute unit price, TransferChecked, and
// a Memo instruction carrying a random nonce of at least 16 bytes,
// hex encoded (x402 SVM exact scheme spec, section 3.1).
export function buildPaymentTransaction({ requirements, buyer, blockhash }) {
  const feePayer = new PublicKey(requirements.extra.feePayer);
  const mint = new PublicKey(requirements.asset);
  const recipient = new PublicKey(requirements.payTo);
  const sourceAta = getAssociatedTokenAddressSync(mint, buyer);
  const destAta = getAssociatedTokenAddressSync(mint, recipient);
  const nonceBytes = new Uint8Array(16);
  crypto.getRandomValues(nonceBytes);
  const nonce = Array.from(nonceBytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const instructions = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
    createTransferCheckedInstruction(
      sourceAta,
      mint,
      destAta,
      buyer,
      BigInt(requirements.amount),
      6,
      [],
      TOKEN_PROGRAM_ID
    ),
    new TransactionInstruction({
      programId: MEMO_PROGRAM_ID,
      keys: [],
      data: new TextEncoder().encode(nonce),
    }),
  ];
  const message = new TransactionMessage({
    payerKey: feePayer,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();
  return new VersionedTransaction(message);
}

// Ask for a resource and, when the server demands payment, pay and
// return the delivered content. Throws with the server's or the
// facilitator's reason when the payment is rejected.
// log(step, message) is an optional progress callback.
// approve(requirements, challenge) is an optional guard called after
// the server names its price and before anything is signed; throw from
// it to refuse the payment (budgets, allowlists, asset checks).
export async function payForResource({
  resourceUrl,
  keypair,
  connection,
  log = () => {},
  approve = async () => {},
  onSend = () => {},
}) {
  const buyer = keypair.publicKey;
  log("step 1/4", `asking for ${resourceUrl} without paying`);
  const first = await fetch(resourceUrl);
  if (first.status === 200) {
    return { data: await first.text(), receipt: null, paid: false };
  }
  if (first.status !== 402) {
    throw new Error(`unexpected status ${first.status}: ${await first.text()}`);
  }
  const required = await first.json();
  const requirements = required.accepts && required.accepts[0];
  if (!requirements) throw new Error("the 402 answer carried no payment requirements");
  await approve(requirements, required);
  const mint = new PublicKey(requirements.asset);
  const recipient = new PublicKey(requirements.payTo);
  log(
    "step 1/4",
    `server demands ${requirements.amount} atomic units to ${requirements.payTo}, fee payer ${requirements.extra.feePayer}`
  );

  log("step 2/4", "building the payment and signing it");
  const sourceAta = getAssociatedTokenAddressSync(mint, buyer);
  const destAta = getAssociatedTokenAddressSync(mint, recipient);
  const sourceInfo = await connection.getAccountInfo(sourceAta);
  if (!sourceInfo) {
    throw new Error(
      "buyer wallet holds no token account for this mint. Fund it with devnet USDC from faucet.circle.com first."
    );
  }
  const destInfo = await connection.getAccountInfo(destAta);
  if (!destInfo) {
    log("step 2/4", "receiving token account does not exist yet, creating it in a separate transaction paid by the buyer");
    const latestAta = await connection.getLatestBlockhash("confirmed");
    const ataTx = new Transaction({
      feePayer: buyer,
      blockhash: latestAta.blockhash,
      lastValidBlockHeight: latestAta.lastValidBlockHeight,
    });
    ataTx.add(
      createAssociatedTokenAccountIdempotentInstruction(
        buyer,
        destAta,
        recipient,
        mint,
        TOKEN_PROGRAM_ID
      )
    );
    const ataSignature = await connection.sendTransaction(ataTx, [keypair]);
    await connection.confirmTransaction(
      {
        signature: ataSignature,
        blockhash: latestAta.blockhash,
        lastValidBlockHeight: latestAta.lastValidBlockHeight,
      },
      "confirmed"
    );
    log("step 2/4", `receiving account created in ${ataSignature}`);
  }
  const { blockhash } = await connection.getLatestBlockhash("finalized");
  const tx = buildPaymentTransaction({ requirements, buyer, blockhash });
  tx.sign([keypair]);
  const transaction = Buffer.from(tx.serialize()).toString("base64");
  log("step 2/4", "signed. The buyer never pays network fees; the facilitator does.");

  log("step 3/4", "retrying with the X-PAYMENT header attached");
  const paymentPayload = {
    x402Version: 2,
    resource: required.resource,
    accepted: requirements,
    payload: { transaction },
  };
  // From here on the signed payment leaves this process and may settle
  // even if the answer is lost.
  onSend();
  const paidResponse = await fetch(resourceUrl, {
    headers: {
      "X-PAYMENT": Buffer.from(JSON.stringify(paymentPayload)).toString("base64"),
    },
  });
  const bodyText = await paidResponse.text();
  if (paidResponse.status !== 200) {
    throw new Error(`payment rejected with status ${paidResponse.status}: ${bodyText}`);
  }
  let receipt = null;
  const receiptHeader = paidResponse.headers.get("x-payment-response");
  if (receiptHeader) {
    try {
      receipt = JSON.parse(Buffer.from(receiptHeader, "base64").toString("utf8"));
    } catch {
      receipt = null;
    }
  }
  log("step 4/4", `payment settled on chain${receipt && receipt.transaction ? `, transaction ${receipt.transaction}` : ""}`);
  let data;
  try {
    data = JSON.parse(bodyText);
  } catch {
    data = bodyText;
  }
  return { data, receipt, paid: true };
}
