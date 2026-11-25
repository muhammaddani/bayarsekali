import { Connection } from "@solana/web3.js";

// The browser talks to Solana through the BayarSekali server at
// /api/rpc, which forwards a small allowlist of read and send methods
// to the server's own RPC (for example a Helius devnet URL). The RPC
// key never ships in this bundle, and demos do not hit the public
// devnet rate limits. VITE_SOLANA_RPC_URL still overrides it.
export function getConnection() {
  const endpoint =
    import.meta.env.VITE_SOLANA_RPC_URL || window.location.origin + "/api/rpc";
  return new Connection(endpoint, "confirmed");
}

export function getProvider() {
  if (typeof window === "undefined") return null;
  if (window.phantom && window.phantom.solana) return window.phantom.solana;
  if (window.solana) return window.solana;
  return null;
}

function bytesToBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

// Sign in with Solana: fetch a one time challenge for `wallet`, have the
// wallet sign it (free, no transaction), and return the fields the
// server expects with a new listing.
export async function signSellerChallenge(provider, wallet) {
  if (typeof provider.signMessage !== "function") {
    throw new Error("This wallet can not sign messages. Use Phantom or Solflare.");
  }
  const resp = await fetch("/api/auth/challenge", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ wallet }),
  });
  const challenge = await resp.json();
  if (!resp.ok) throw new Error(challenge.error || "Could not start the wallet sign in.");
  const signed = await provider.signMessage(new TextEncoder().encode(challenge.message), "utf8");
  const signature = signed && signed.signature ? signed.signature : signed;
  return { authNonce: challenge.nonce, authSignature: bytesToBase64(signature) };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Wait until a transaction is confirmed by polling its status, without
// a websocket subscription (the proxy carries plain HTTP only).
// Throws when the transaction failed or its blockhash expired.
export async function waitForConfirmation(connection, signature, lastValidBlockHeight) {
  for (;;) {
    const { value } = await connection.getSignatureStatuses([signature]);
    const status = value && value[0];
    if (status) {
      if (status.err) throw new Error("The transaction failed on chain.");
      if (
        status.confirmationStatus === "confirmed" ||
        status.confirmationStatus === "finalized"
      ) {
        return;
      }
    }
    if (lastValidBlockHeight) {
      const height = await connection.getBlockHeight("confirmed");
      if (height > lastValidBlockHeight) {
        throw new Error("The transaction expired before it was confirmed. Try again.");
      }
    }
    await sleep(1500);
  }
}
