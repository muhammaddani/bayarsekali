import { useEffect, useState } from "react";
import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import ApiListingPage from "./ApiListingPage.jsx";

const DEVNET_RPC = "https://api.devnet.solana.com";

function getProvider() {
  if (typeof window !== "undefined" && window.solana) return window.solana;
  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default function ListingPage({ id }) {
  const [listing, setListing] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [walletAddress, setWalletAddress] = useState("");
  const [status, setStatus] = useState("");
  const [statusKind, setStatusKind] = useState("");
  const [busy, setBusy] = useState(false);
  const [download, setDownload] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const resp = await fetch("/api/listings/" + id);
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || "Listing not found.");
        if (!cancelled) setListing(data);
      } catch (err) {
        if (!cancelled) setLoadError(err.message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  function say(message, kind = "") {
    setStatus(message);
    setStatusKind(kind);
  }

  async function connectWallet() {
    const provider = getProvider();
    if (!provider) {
      say(
        "No Solana wallet was found in this browser. Install Phantom, open this page again, and use a devnet wallet with test SOL.",
        "err"
      );
      return;
    }
    try {
      const resp = await provider.connect();
      setWalletAddress(resp.publicKey.toString());
      say("Wallet connected: " + resp.publicKey.toString());
    } catch {
      say("Wallet connection was rejected.", "err");
    }
  }

  async function pay() {
    const provider = getProvider();
    if (!provider) {
      say(
        "No Solana wallet was found in this browser. Install Phantom, open this page again, and use a devnet wallet with test SOL.",
        "err"
      );
      return;
    }
    if (!walletAddress) {
      say("Connect your wallet first, then press Pay.", "err");
      return;
    }

    setBusy(true);
    setDownload(null);
    try {
      say("Step 1 of 4: creating the payment intent on the server.");
      const checkoutResp = await fetch("/api/listings/" + id + "/checkout", {
        method: "POST",
      });
      const intent = await checkoutResp.json();
      if (!checkoutResp.ok) {
        throw new Error(intent.error || "Could not start checkout.");
      }

      const connection = new Connection(DEVNET_RPC, "confirmed");
      const buyerKey = new PublicKey(walletAddress);
      const sellerKey = new PublicKey(intent.recipient);
      const referenceKey = new PublicKey(intent.reference);
      const lamports = Math.round(intent.amountSol * LAMPORTS_PER_SOL);

      const transferIx = SystemProgram.transfer({
        fromPubkey: buyerKey,
        toPubkey: sellerKey,
        lamports,
      });
      // Solana Pay style: the reference key rides along as a read only
      // account key so the server can find this exact payment on chain.
      transferIx.keys.push({
        pubkey: referenceKey,
        isSigner: false,
        isWritable: false,
      });

      const latest = await connection.getLatestBlockhash("confirmed");
      const tx = new Transaction({
        feePayer: buyerKey,
        blockhash: latest.blockhash,
        lastValidBlockHeight: latest.lastValidBlockHeight,
      });
      tx.add(transferIx);

      say("Step 2 of 4: waiting for your wallet approval. Check Phantom.");
      let signature;
      if (typeof provider.signAndSendTransaction === "function") {
        const sent = await provider.signAndSendTransaction(tx);
        signature = sent.signature;
      } else if (typeof provider.signTransaction === "function") {
        const signed = await provider.signTransaction(tx);
        signature = await connection.sendRawTransaction(signed.serialize());
      } else {
        throw new Error("This wallet cannot sign transactions.");
      }

      say(
        "Payment sent, signature " + signature + ".\nStep 3 of 4: verifying the payment on chain. This can take up to a minute."
      );

      let verified = null;
      for (let attempt = 0; attempt < 25; attempt++) {
        await sleep(3000);
        const verifyResp = await fetch("/api/payments/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ intentId: intent.intentId }),
        });
        const verifyData = await verifyResp.json();
        if (verifyResp.ok && verifyData.paid) {
          verified = verifyData;
          break;
        }
        if (verifyResp.ok && verifyData.reason === "insufficient") {
          throw new Error(
            "The payment arrived but the amount was too small. The download stays locked."
          );
        }
      }
      if (!verified) {
        throw new Error(
          "Verification timed out. If your payment went through, reload this page and contact the seller with your transaction signature."
        );
      }

      setDownload(verified);
      say(
        "Step 4 of 4: payment verified on chain. Your download is unlocked. The download link works once and expires in 15 minutes.",
        "ok"
      );
    } catch (err) {
      say(err.message || "Something went wrong during payment.", "err");
    } finally {
      setBusy(false);
    }
  }

  if (loadError) {
    return (
      <div>
        <h1>Listing unavailable</h1>
        <div className="status err">{loadError}</div>
      </div>
    );
  }
  if (!listing) {
    return (
      <div>
        <h1>Loading...</h1>
      </div>
    );
  }

  if (listing.type === "api") {
    return <ApiListingPage listing={listing} />;
  }

  return (
    <div>
      <h1>{listing.title}</h1>
      <div className="card">
        <div className="price">{listing.priceSol} SOL</div>
        <p className="pitch">
          Solana devnet price. Devnet SOL has no real value. The payment goes
          directly to the seller wallet below.
        </p>
        <p className="wallet">Seller: {listing.sellerWallet}</p>

        {walletAddress ? (
          <p className="wallet">Your wallet: {walletAddress}</p>
        ) : (
          <button type="button" onClick={connectWallet}>
            Connect Wallet
          </button>
        )}

        <button type="button" onClick={pay} disabled={busy || !walletAddress}>
          {busy ? "Processing..." : "Pay " + listing.priceSol + " SOL"}
        </button>

        {status ? <div className={"status " + statusKind}>{status}</div> : null}

        {download ? (
          <div>
            <a className="button" href={download.downloadUrl}>
              Download your file
            </a>
            <p className="pitch">
              One time link. If it expires or was already used, pay again or
              ask the seller for help.
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
