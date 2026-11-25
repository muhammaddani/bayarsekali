// BayarSekali autonomous agent buyer, command line edition.
//
// A standalone AI agent client for the x402 door, built on the
// reusable library in x402-client.mjs. It holds its own wallet,
// discovers the price by asking for the resource, signs the payment
// itself, and receives the resource. No browser, no human in the
// loop.
//
// Usage:
//   AGENT_KEYPAIR=/path/to/agent-keypair.json node agent-buy.mjs <resource-url>
//
// The keypair file is a standard Solana JSON secret key file owned
// by whoever runs the agent. Fund the agent wallet with devnet SOL
// (only needed if a receiving token account must be created first)
// and devnet USDC from faucet.circle.com.
import { readFileSync } from "node:fs";
import { Connection, Keypair } from "@solana/web3.js";
import { payForResource } from "./x402-client.mjs";

const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";

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
  const keypair = Keypair.fromSecretKey(secret);
  const connection = new Connection(RPC_URL, "confirmed");
  console.log(`[agent] wallet ${keypair.publicKey.toBase58()}`);

  const { data, paid } = await payForResource({
    resourceUrl,
    keypair,
    connection,
    log: (step, message) => console.log(`[agent] ${step} ${message}`),
  });
  if (!paid) {
    console.log("[agent] resource was free, nothing to pay");
  }
  console.log("[agent] resource delivered:");
  console.log(typeof data === "string" ? data : JSON.stringify(data, null, 2));
}

main().catch((error) => {
  console.error("[agent] failed:", error.message);
  process.exit(1);
});
