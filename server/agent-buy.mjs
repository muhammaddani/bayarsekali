// BayarSekali autonomous agent buyer.
//
// A standalone AI agent client for the x402 door. It holds its own
// wallet, discovers the price by asking for the resource, signs the
// payment itself, and receives the resource. No browser, no human
// in the loop.
//
// Usage:
//   AGENT_KEYPAIR=/path/to/agent-keypair.json node agent-buy.mjs <resource-url>
//
// The keypair file is a standard Solana JSON secret key file owned
// by whoever runs the agent. Fund the agent wallet with devnet SOL
// (only needed if a receiving token account must be created first)
// and devnet USDC from faucet.circle.com.
import { readFileSync } from "node:fs";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
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

const MEMO_PROGRAM_ID = new PublicKey(
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"
);
const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";

function log(step, message) {
  console.log(`[agent] ${step} ${message}`);
}

async function main() {
  const resourceUrl = process.argv[2];
  const keypairPath = process.env.AGENT_KEYPAIR;
  if (!resourceUrl || !keypairPath) {
    console.error(
      "Usage: AGENT_KEYPAIR=/path/to/agent-keypair.json node agent-buy.mjs <resource-url>"
    );
    process.exit(1);
  }
  const secret = Uint8Array.from(JSON.parse(readFileSync(keypairPath, "utf8")));
  const agent = Keypair.fromSecretKey(secret);
  const connection = new Connection(RPC_URL, "confirmed");
  log("wallet", `agent wallet ${agent.publicKey.toBase58()}`);

  log("step 1/4", `asking for ${resourceUrl} without paying`);
  const first = await fetch(resourceUrl);
  if (first.status === 200) {
    log("done", "resource was free, nothing to pay");
    console.log(await first.text());
    return;
  }
  if (first.status !== 402) {
    throw new Error(`unexpected status ${first.status}: ${await first.text()}`);
  }
  const required = await first.json();
  const requirements = required.accepts[0];
  const feePayer = new PublicKey(requirements.extra.feePayer);
  const mint = new PublicKey(requirements.asset);
  const recipient = new PublicKey(requirements.payTo);
  const amount = BigInt(requirements.amount);
  log(
    "step 1/4",
    `server demands ${amount.toString()} atomic units of ${requirements.asset} to ${requirements.payTo}, fee payer ${requirements.extra.feePayer}`
  );

  log("step 2/4", "building the payment and signing it");
  const sourceAta = getAssociatedTokenAddressSync(mint, agent.publicKey);
  const destAta = getAssociatedTokenAddressSync(mint, recipient);
  const sourceInfo = await connection.getAccountInfo(sourceAta);
  if (!sourceInfo) {
    throw new Error(
      "agent wallet holds no USDC for this mint. Claim devnet USDC at faucet.circle.com for the agent address first."
    );
  }
  const destInfo = await connection.getAccountInfo(destAta);
  if (!destInfo) {
    log(
      "step 2/4",
      "receiving USDC account does not exist yet, creating it in a separate transaction paid by the agent"
    );
    const latestAta = await connection.getLatestBlockhash("confirmed");
    const ataTx = new Transaction({
      feePayer: agent.publicKey,
      blockhash: latestAta.blockhash,
      lastValidBlockHeight: latestAta.lastValidBlockHeight,
    });
    ataTx.add(
      createAssociatedTokenAccountIdempotentInstruction(
        agent.publicKey,
        destAta,
        recipient,
        mint,
        TOKEN_PROGRAM_ID
      )
    );
    const ataSignature = await connection.sendTransaction(ataTx, [agent]);
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
  // The facilitator's static verification path accepts exactly one
  // instruction layout, in this relative order: compute unit limit,
  // compute unit price, TransferChecked, and a Memo instruction
  // carrying a random nonce of at least 16 bytes, hex encoded
  // (x402 SVM exact scheme spec, section 3.1).
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
      agent.publicKey,
      amount,
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
  const { blockhash } = await connection.getLatestBlockhash("finalized");
  const message = new TransactionMessage({
    payerKey: feePayer,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  tx.sign([agent]);
  const transaction = Buffer.from(tx.serialize()).toString("base64");
  log("step 2/4", "signed. The agent never pays network fees; the facilitator does.");

  log("step 3/4", "retrying with the X-PAYMENT header attached");
  const paymentPayload = {
    x402Version: 2,
    resource: required.resource,
    accepted: requirements,
    payload: { transaction },
  };
  const paid = await fetch(resourceUrl, {
    headers: {
      "X-PAYMENT": Buffer.from(JSON.stringify(paymentPayload)).toString("base64"),
    },
  });
  const bodyText = await paid.text();
  if (paid.status !== 200) {
    throw new Error(`payment rejected with status ${paid.status}: ${bodyText}`);
  }
  const receiptHeader = paid.headers.get("x-payment-response");
  let signature = "";
  if (receiptHeader) {
    try {
      const receipt = JSON.parse(
        Buffer.from(receiptHeader, "base64").toString("utf8")
      );
      signature = receipt.transaction || "";
    } catch {
      signature = "";
    }
  }
  log("step 4/4", `payment settled on chain${signature ? `, transaction ${signature}` : ""}`);
  log("done", "resource delivered to the agent:");
  console.log(bodyText);
}

main().catch((error) => {
  console.error("[agent] failed:", error.message);
  process.exit(1);
});
