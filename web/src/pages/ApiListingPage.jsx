import { useCallback, useEffect, useState } from "react";
import {
  ComputeBudgetProgram,
  PublicKey,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { getConnection, waitForConfirmation } from "../solana.js";
import DemoAgentPanel from "../DemoAgentPanel.jsx";

const MEMO_PROGRAM_ID = new PublicKey(
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"
);
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

function getProvider() {
  if (typeof window === "undefined") return null;
  if (window.phantom && window.phantom.solana) return window.phantom.solana;
  if (window.solana) return window.solana;
  return null;
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function jsonToBase64(value) {
  return bytesToBase64(new TextEncoder().encode(JSON.stringify(value)));
}

function explorerTx(signature) {
  return "https://explorer.solana.com/tx/" + signature + "?cluster=devnet";
}

function shortAddress(value) {
  if (!value || value.length < 12) return value || "";
  return value.slice(0, 6) + "..." + value.slice(-6);
}

// The agent buyer demo. It performs the x402 handshake in the open,
// one logged step at a time: ask for the resource, receive the 402
// payment requirements, build and sign the USDC payment with the
// wallet, retry with the X-PAYMENT header, and receive the resource
// after the facilitator settles the payment on chain.
function AgentBuyer({ listing, onPaid }) {
  const [walletAddress, setWalletAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState([]);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");

  function addLog(line) {
    setLog((prev) => [...prev, line]);
  }

  async function connectWallet() {
    const provider = getProvider();
    if (!provider) {
      setError(
        "No Solana wallet was found in this browser. Install Phantom, set it to Devnet, and open this page again."
      );
      return;
    }
    setError("");
    try {
      const resp = await Promise.race([
        provider.connect(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("wallet-timeout")), 20000)
        ),
      ]);
      setWalletAddress(resp.publicKey.toString());
      setError("");
    } catch (err) {
      if (err && err.message === "wallet-timeout") {
        setError(
          "The wallet did not answer within 20 seconds. Open the Phantom extension yourself and check whether a connection request is waiting there; approve or clear it, then press Connect Wallet again."
        );
      } else {
        setError("Wallet connection was rejected.");
      }
    }
  }

  async function runAgent() {
    const provider = getProvider();
    if (!provider || !walletAddress) {
      setError("Connect your wallet first, then run the agent.");
      return;
    }
    setBusy(true);
    setError("");
    setResult(null);
    setLog([]);
    try {
      const resourceUrl = "/api/resource/" + listing.id;

      addLog("Step 1 of 4: the agent asks for the resource without paying.");
      const probe = await fetch(resourceUrl);
      if (probe.status !== 402) {
        throw new Error("Expected a 402 Payment Required answer, got HTTP " + probe.status + ".");
      }
      const challenge = await probe.json();
      const requirements = challenge.accepts && challenge.accepts[0];
      if (!requirements) throw new Error("The 402 answer carried no payment requirements.");
      addLog(
        "The server demands " +
          requirements.amount +
          " atomic USDC units (" +
          listing.priceUsdc +
          " USDC) to " +
          shortAddress(requirements.payTo) +
          ", fee payer " +
          shortAddress(requirements.extra.feePayer) +
          "."
      );

      addLog("Step 2 of 4: the agent builds the payment and asks the wallet to sign it.");
      const connection = getConnection();
      const buyer = new PublicKey(walletAddress);
      const feePayer = new PublicKey(requirements.extra.feePayer);
      const recipient = new PublicKey(requirements.payTo);
      const mint = new PublicKey(requirements.asset);
      const sourceAta = getAssociatedTokenAddressSync(mint, buyer);
      const destAta = getAssociatedTokenAddressSync(mint, recipient);
      // The facilitator only pays network fees and rejects payment
      // transactions that carry an account creation instruction, so a
      // missing receiving USDC account is created first, in a
      // separate transaction paid by the buyer wallet itself.
      const destInfo = await connection.getAccountInfo(destAta);
      if (!destInfo) {
        addLog(
          "The receiving USDC account does not exist yet. The agent creates it first, in a separate transaction paid by the buyer wallet."
        );
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
        const sentAta = await provider.signAndSendTransaction(ataTx);
        await waitForConfirmation(
          connection,
          sentAta.signature,
          latestAta.lastValidBlockHeight
        );
        addLog("Receiving USDC account created.");
      }
      const sourceInfo = await connection.getAccountInfo(sourceAta);
      if (!sourceInfo) {
        throw new Error(
          "Your wallet holds no devnet USDC yet. Claim free devnet USDC at faucet.circle.com (choose Solana, then Devnet), then run the agent again."
        );
      }
      // The facilitator's static verification path accepts one exact
      // instruction layout, in this relative order: compute unit
      // limit, compute unit price, the TransferChecked, and a Memo
      // carrying a random nonce of at least 16 bytes (hex encoded).
      // Anything else makes the payment fall to the smart wallet
      // path, which rejects standard wallets.
      const nonceBytes = new Uint8Array(16);
      window.crypto.getRandomValues(nonceBytes);
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
      const { blockhash } = await connection.getLatestBlockhash("finalized");
      const message = new TransactionMessage({
        payerKey: feePayer,
        recentBlockhash: blockhash,
        instructions,
      }).compileToV0Message();
      const tx = new VersionedTransaction(message);
      const signed = await provider.signTransaction(tx);
      const header = jsonToBase64({
        x402Version: 2,
        resource: challenge.resource,
        accepted: requirements,
        payload: { transaction: bytesToBase64(signed.serialize()) },
      });
      addLog("Signed. The buyer never pays network fees; the facilitator does.");

      addLog("Step 3 of 4: the agent retries with the X-PAYMENT header attached.");
      const paid = await fetch(resourceUrl, {
        headers: { "X-PAYMENT": header },
      });
      const paidBody = await paid.json().catch(() => null);
      if (!paid.ok) {
        throw new Error(
          (paidBody && paidBody.error) || "The paid request failed with HTTP " + paid.status + "."
        );
      }

      addLog("Step 4 of 4: payment settled on chain, the resource is delivered.");
      setResult(paidBody);
      if (onPaid) onPaid();
    } catch (err) {
      setError(err.message || "The agent run failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h3>Pay from your own wallet</h3>
      <p className="pitch">
        Run the same x402 flow in this browser with Phantom as the agent's wallet. Phantom
        must be on Devnet and hold devnet USDC from faucet.circle.com. Your wallet only
        signs; the facilitator pays the network fee.
      </p>
      {walletAddress ? (
        <p className="wallet">Agent wallet: {walletAddress}</p>
      ) : (
        <button type="button" className="secondary" onClick={connectWallet}>
          Connect Phantom
        </button>
      )}
      {walletAddress ? (
        <button type="button" onClick={runAgent} disabled={busy}>
          {busy ? "Paying…" : "Pay with Phantom"}
        </button>
      ) : null}
      {log.length ? (
        <div className="status log">
          {log.map((line, i) => (
            <div key={i}>{line}</div>
          ))}
        </div>
      ) : null}
      {error ? <div className="status err">{error}</div> : null}
      {result ? (
        <div>
          <div className="status ok">
            Payment settled. Transaction{" "}
            {result.payment && result.payment.transaction ? (
              <a href={explorerTx(result.payment.transaction)} target="_blank" rel="noreferrer">
                {shortAddress(result.payment.transaction)}
              </a>
            ) : (
              "recorded"
            )}
            .
          </div>
          <label>Resource delivered to the agent</label>
          <pre className="payload">{JSON.stringify(result.data, null, 2)}</pre>
        </div>
      ) : null}
    </div>
  );
}

function SalesPanel({ listing, refreshKey }) {
  const [sales, setSales] = useState(null);

  const load = useCallback(async () => {
    try {
      const resp = await fetch("/api/listings/" + listing.id + "/sales");
      const data = await resp.json();
      if (resp.ok) setSales(data.sales || []);
    } catch {
      setSales([]);
    }
  }, [listing.id]);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  // Keep the list live while the page is open, so a sale made by any
  // agent anywhere shows up here within seconds.
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, 5000);
    return () => clearInterval(timer);
  }, [load]);

  if (!sales) return null;
  const total = sales.reduce((sum, s) => sum + Number(s.amountUsdc || 0), 0);
  return (
    <div className="card">
      <h3>
        Sales <span className="live-dot">live</span>
      </h3>
      <p className="pitch">
        {sales.length} settled payment{sales.length === 1 ? "" : "s"}
        {sales.length ? ", " + total.toFixed(6).replace(/\.?0+$/, "") + " USDC in total" : ""}.
      </p>
      {sales.slice().reverse().slice(0, 10).map((sale) => (
        <p className="wallet" key={sale.id}>
          {sale.amountUsdc} USDC from {shortAddress(sale.payer)} at{" "}
          {new Date(sale.createdAt).toLocaleString()}
          {sale.signature ? (
            <>
              {" "}
              <a href={explorerTx(sale.signature)} target="_blank" rel="noreferrer">
                view transaction
              </a>
            </>
          ) : null}
        </p>
      ))}
    </div>
  );
}

export default function ApiListingPage({ listing }) {
  const [refreshKey, setRefreshKey] = useState(0);
  const [copied, setCopied] = useState(false);
  const resourceFull = window.location.origin + "/api/resource/" + listing.id;
  const isProxy = listing.mode === "proxy";
  const paid = () => setRefreshKey((k) => k + 1);

  async function copyEndpoint() {
    try {
      await navigator.clipboard.writeText(resourceFull);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <>
      <div className="crumbs">
        <a href="/#catalog">Catalog</a> / {isProxy ? "Live API" : "x402 API"}
      </div>
      <h1>{listing.title}</h1>
      <div className="listing-layout">
        <div>
          {listing.resourceDescription ? (
            <p className="lede">{listing.resourceDescription}</p>
          ) : null}
          <p className="pitch">
            {isProxy
              ? "Each paid call is forwarded to the seller's own API, query parameters included. You are charged only when that API answers successfully."
              : "Sold per call over x402. A paid request returns the content in the same response, once the USDC payment settles on Solana."}
          </p>

          <div className="card">
            <h3>Endpoint for agents</h3>
            <p className="pitch">Any x402 client can pay this URL directly, no page visit needed.</p>
            <div className="linkrow">
              <code>{resourceFull}</code>
              <button type="button" className="secondary" onClick={copyEndpoint}>
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
          </div>

          <SalesPanel listing={listing} refreshKey={refreshKey} />
          <AgentBuyer listing={listing} onPaid={paid} />
        </div>

        <aside className="buybox">
          <div className="card">
            <div className="price">
              {listing.priceUsdc} USDC <small>per call</small>
            </div>
            <dl className="meta-list">
              <dt>Network</dt>
              <dd>Solana devnet</dd>
              <dt>Seller</dt>
              <dd>
                <a href={`/seller/${listing.sellerWallet}`}>{shortAddress(listing.sellerWallet)}</a>
              </dd>
              <dt>Fee</dt>
              <dd>paid by the facilitator</dd>
            </dl>
          </div>
          <div className="divider-label">watch an agent pay for it</div>
          <DemoAgentPanel listingId={listing.id} onPaid={paid} />
        </aside>
      </div>
    </>
  );
}
