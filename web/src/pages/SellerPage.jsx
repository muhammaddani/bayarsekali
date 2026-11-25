import { useEffect, useRef, useState } from "react";
import { ListingSubline } from "../lang.jsx";

const POLL_MS = 4000;

function explorerTx(signature) {
  return `https://explorer.solana.com/tx/${signature}?cluster=devnet`;
}

function shortAddress(address) {
  if (!address || address.length < 12) return address || "";
  return address.slice(0, 6) + "…" + address.slice(-6);
}

function timeAgo(iso) {
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}

// Public seller dashboard, live: every listing owned by one wallet and
// every settled x402 sale, refreshed every few seconds while the tab is
// visible. A sale that lands while the page is open is highlighted.
// There are no accounts in BayarSekali; the wallet is the identity.
export default function SellerPage({ wallet }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [fresh, setFresh] = useState(() => new Set());
  const known = useRef(null);

  useEffect(() => {
    let cancelled = false;
    let timer = null;

    async function load() {
      try {
        const res = await fetch(`/api/sellers/${encodeURIComponent(wallet)}`);
        const body = await res.json();
        if (!res.ok) throw new Error(body.error || String(res.status));
        if (cancelled) return;
        const ids = body.sales.map((s) => s.id);
        if (known.current) {
          const arrived = ids.filter((id) => !known.current.has(id));
          if (arrived.length) {
            setFresh(new Set(arrived));
            setTimeout(() => !cancelled && setFresh(new Set()), 6000);
          }
        }
        known.current = new Set(ids);
        setData(body);
        setError("");
      } catch (err) {
        if (!cancelled) setError("The dashboard could not be loaded right now.");
      }
    }

    function schedule() {
      timer = setTimeout(async () => {
        if (document.visibilityState === "visible") await load();
        if (!cancelled) schedule();
      }, POLL_MS);
    }

    load().then(schedule);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [wallet]);

  return (
    <div>
      <div className="crumbs">
        <a href="/#catalog">Catalog</a> / Seller
      </div>
      <h1>Seller dashboard</h1>
      <p className="wallet">{wallet}</p>
      {error && <div className="status err">{error}</div>}
      {data === null && !error && <p className="pitch">Loading…</p>}
      {data !== null && data.listings.length === 0 && (
        <p className="pitch">This wallet has no listings yet.</p>
      )}
      {data !== null && data.listings.length > 0 && (
        <>
          <div className={"card" + (fresh.size ? " pulse" : "")}>
            <span className="live-dot">live</span>
            <div className="price">{data.totals.usdc} USDC</div>
            <p className="pitch">
              settled through x402 across {data.totals.salesCount} sale
              {data.totals.salesCount === 1 ? "" : "s"} and {data.listings.length} listing
              {data.listings.length === 1 ? "" : "s"}, straight to this wallet. File sales in
              SOL settle directly on chain as well.
            </p>
          </div>

          <div className="card">
            <h2>Sales feed</h2>
            {data.sales.length === 0 ? (
              <p className="pitch">
                No x402 sales yet. Open any API listing and let the demo agent buy it, then
                watch it land here.
              </p>
            ) : (
              data.sales.slice(0, 25).map((sale) => (
                <div className={"sale-row" + (fresh.has(sale.id) ? " fresh" : "")} key={sale.id}>
                  <strong>{sale.amountUsdc} USDC</strong> for{" "}
                  <a href={`/listing/${sale.listingId}`}>{sale.listingTitle}</a>
                  <span className="wallet">
                    {" "}
                    from {shortAddress(sale.payer)} · {timeAgo(sale.createdAt)}
                    {sale.signature && (
                      <>
                        {" · "}
                        <a href={explorerTx(sale.signature)} target="_blank" rel="noreferrer">
                          transaction
                        </a>
                      </>
                    )}
                  </span>
                </div>
              ))
            )}
          </div>

          <h2 className="section-title">Listings</h2>
          <div className="grid">
            {data.listings.map((listing) => (
              <a className="listing-card" key={listing.id} href={`/listing/${listing.id}`}>
                <span className={`badge ${listing.type === "api" ? "badge-api" : "badge-file"}`}>
                  {listing.type === "api" ? (listing.mode === "proxy" ? "live api" : "x402 api") : "file"}
                </span>
                <span className="listing-title">{listing.title}</span>
                <ListingSubline listing={listing} />
                <span className="listing-price">
                  {listing.type === "api" ? `${listing.priceUsdc} USDC` : `${listing.priceSol} SOL`}
                  {listing.type === "api" ? ` · ${listing.salesCount} sold` : ""}
                </span>
              </a>
            ))}
          </div>
        </>
      )}

    </div>
  );
}
