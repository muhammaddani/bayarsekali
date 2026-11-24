import { useEffect, useState } from "react";

const PROOF_TX =
  "5wXRwLGHiSMq5MQLZJ34vNxgFdGSPJAEWid1MCgxHwtVk5BxeKWXa4sJVEGMWnVien1ynSr1G9qZXecYbsurbeR3";
const PROOF_URL = `https://explorer.solana.com/tx/${PROOF_TX}?cluster=devnet`;

export default function Home() {
  const [listings, setListings] = useState(null);
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetch("/api/listings")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((data) => {
        if (!cancelled) setListings(data.listings || []);
      })
      .catch(() => {
        if (!cancelled) setLoadError("The catalog could not be loaded right now.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div>
      <h1>BayarSekali</h1>
      <p className="pitch">
        One paywall, two doors. Humans buy a digital file with one link and a
        Solana wallet. AI agents buy API access per call through the x402
        protocol, paying USDC on chain inside the same HTTP request. No
        accounts, no platform cut, settlement is verified on chain before
        anything unlocks. This deployment runs on Solana devnet, so every
        payment uses test funds with no real value.
      </p>
      <a className="button" href="/create">
        Create a listing
      </a>

      <h2 className="section-title">Catalog</h2>
      {loadError && <div className="status err">{loadError}</div>}
      {listings === null && !loadError && <p className="pitch">Loading the catalog…</p>}
      {listings !== null && listings.length === 0 && (
        <p className="pitch">No listings yet. Create the first one.</p>
      )}
      {listings !== null && listings.length > 0 && (
        <div className="grid">
          {listings.map((listing) => (
            <a className="listing-card" key={listing.id} href={`/listing/${listing.id}`}>
              <span className={`badge ${listing.type === "api" ? "badge-api" : "badge-file"}`}>
                {listing.type === "api" ? "API access, x402" : "File download"}
              </span>
              <span className="listing-title">{listing.title}</span>
              <span className="listing-price">
                {listing.type === "api"
                  ? `${listing.priceUsdc} USDC`
                  : `${listing.priceSol} SOL`}
              </span>
            </a>
          ))}
        </div>
      )}

      <div className="card">
        <h2>Settled on chain, not promised</h2>
        <p className="pitch">
          An agent buyer asked for a dataset, received an HTTP 402, signed a
          0.01 USDC payment, and the facilitator settled it on Solana devnet.
          The network fee was paid by the facilitator, not by the buyer. Read
          the transaction yourself:
        </p>
        <p>
          <a href={PROOF_URL} target="_blank" rel="noreferrer">
            {PROOF_TX.slice(0, 20)}…{PROOF_TX.slice(-8)} on Solana Explorer
          </a>
        </p>
      </div>

      <div className="card">
        <h2>For agents</h2>
        <ol className="steps">
          <li>GET the resource URL of any API listing. The server answers 402 with the price, the USDC mint, and the fee payer.</li>
          <li>Build the payment transaction: compute budget, a TransferChecked of the exact amount to the seller, and a memo nonce.</li>
          <li>Sign it with the agent wallet and retry the request with the X-PAYMENT header.</li>
          <li>The facilitator verifies and settles on chain. The server delivers the content in the same response.</li>
        </ol>
        <p className="pitch">
          A ready made autonomous buyer ships in the repository as
          server/agent-buy.mjs. It holds its own wallet and runs this whole
          flow from the command line, no browser involved.
        </p>
      </div>
    </div>
  );
}
