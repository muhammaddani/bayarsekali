import { useEffect, useState } from "react";
import {
  PublicKey,
  SystemProgram,
  Transaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import ApiListingPage from "./ApiListingPage.jsx";
import { getConnection } from "../solana.js";
import { ListingSubline } from "../lang.jsx";

// The intent id is the buyer's proof of purchase for this browser. It
// is kept so the buyer can fetch a fresh download link later, after a
// broken download or a closed tab.
const intentKey = (listingId) => "bayarsekali:intent:" + listingId;

function loadSavedIntent(listingId) {
  try {
    return window.localStorage.getItem(intentKey(listingId)) || "";
  } catch {
    return "";
  }
}

function saveIntent(listingId, intentId) {
  try {
    window.localStorage.setItem(intentKey(listingId), intentId);
  } catch {
    // Storage blocked: the purchase still works, only recovery is lost.
  }
}

function getProvider() {
  if (typeof window === "undefined") return null;
  if (window.phantom && window.phantom.solana) return window.phantom.solana;
  if (window.solana) return window.solana;
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
  const [savedIntent, setSavedIntent] = useState(() => loadSavedIntent(id));

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
      const resp = await Promise.race([
        provider.connect(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("wallet-timeout")), 20000)
        ),
      ]);
      setWalletAddress(resp.publicKey.toString());
      say("Wallet connected: " + resp.publicKey.toString());
    } catch (err) {
      if (err && err.message === "wallet-timeout") {
        say(
          "The wallet did not answer within 20 seconds. Open the Phantom extension yourself and check whether a connection request is waiting there; approve or clear it, then press Connect Wallet again.",
          "err"
        );
      } else {
        say("Wallet connection was rejected.", "err");
      }
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
      saveIntent(id, intent.intentId);
      setSavedIntent(intent.intentId);

      const connection = getConnection();
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
        if (verifyResp.status === 429) {
          throw new Error(verifyData.error);
        }
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

  // Ask the server for a fresh download link for an earlier purchase
  // made in this browser.
  async function recoverDownload() {
    setBusy(true);
    try {
      say("Checking your earlier payment on chain.");
      const resp = await fetch("/api/payments/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ intentId: savedIntent }),
      });
      const data = await resp.json();
      if (resp.ok && data.paid) {
        setDownload(data);
        say("Payment found. Here is a fresh download link.", "ok");
      } else if (data.error) {
        say(data.error, "err");
      } else {
        say(
          "No completed payment was found for your earlier checkout in this browser.",
          "err"
        );
      }
    } catch {
      say("Could not reach the server, try again.", "err");
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

  const shortSeller = listing.sellerWallet.slice(0, 4) + "…" + listing.sellerWallet.slice(-4);
  return (
    <>
      <div className="crumbs">
        <a href="/#catalog">Catalog</a> / File
      </div>
      <h1>{listing.title}</h1>
      <ListingSubline listing={listing} className="subline subline-head" />
      <div className="listing-layout">
        <div>
          <p className="lede">
            A digital file, sold for SOL with one link. Pay from your Solana wallet and the
            download unlocks as soon as the payment is verified on chain.
          </p>
          <div className="card">
            <h3>How this checkout works</h3>
            <ol className="steps">
              <li>Connect a Solana wallet set to Devnet, with a little test SOL.</li>
              <li>Approve one transfer straight to the seller. Nothing passes through us.</li>
              <li>We find the payment on chain by its reference key and unlock a one time download.</li>
            </ol>
          </div>
        </div>

        <aside className="buybox">
          <div className="card">
            <div className="price">{listing.priceSol} SOL</div>
            <dl className="meta-list">
              <dt>Network</dt>
              <dd>Solana devnet</dd>
              <dt>Seller</dt>
              <dd>
                <a href={`/seller/${listing.sellerWallet}`}>{shortSeller}</a>
              </dd>
              {walletAddress ? (
                <>
                  <dt>You</dt>
                  <dd>{walletAddress.slice(0, 4) + "…" + walletAddress.slice(-4)}</dd>
                </>
              ) : null}
            </dl>

            {walletAddress ? (
              <button type="button" className="block" onClick={pay} disabled={busy}>
                {busy ? "Processing…" : "Pay " + listing.priceSol + " SOL"}
              </button>
            ) : (
              <button type="button" className="block" onClick={connectWallet}>
                Connect wallet
              </button>
            )}

            {savedIntent && !download ? (
              <button type="button" className="secondary block" onClick={recoverDownload} disabled={busy}>
                Already paid? Get the link again
              </button>
            ) : null}

            {status ? <div className={"status " + statusKind}>{status}</div> : null}

            {download ? (
              <>
                <a className="button block" href={download.downloadUrl}>
                  Download the file
                </a>
                <p className="fineprint">
                  One time link, valid for 15 minutes. If the download breaks off, the link
                  keeps working. Lost it? Use “Already paid?” in this browser.
                </p>
              </>
            ) : null}
          </div>
        </aside>
      </div>
    </>
  );
}
