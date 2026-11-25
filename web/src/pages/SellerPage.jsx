import { useEffect, useState } from "react";

function explorerTx(signature) {
  return `https://explorer.solana.com/tx/${signature}?cluster=devnet`;
}

function shortAddress(address) {
  if (!address || address.length < 12) return address || "";
  return address.slice(0, 6) + "…" + address.slice(-6);
}

// Public seller dashboard: every listing owned by one wallet, with
// the settled x402 sales per listing and the totals. There are no
// accounts in BayarSekali; the wallet address is the identity.
export default function SellerPage({ wallet }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/listings");
        if (!res.ok) throw new Error(String(res.status));
        const data = await res.json();
        const mine = (data.listings || []).filter((l) => l.sellerWallet === wallet);
        const withSales = await Promise.all(
          mine.map(async (listing) => {
            let sales = [];
            try {
              const sres = await fetch(`/api/listings/${listing.id}/sales`);
              if (sres.ok) sales = (await sres.json()).sales || [];
            } catch {
              sales = [];
            }
            return { listing, sales };
          })
        );
        if (!cancelled) setRows(withSales);
      } catch {
        if (!cancelled) setError("The dashboard could not be loaded right now.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [wallet]);

  const totalUsdc = (rows || []).reduce(
    (sum, row) =>
      sum +
      row.sales.reduce((s, sale) => s + (parseFloat(sale.amountUsdc) || 0), 0),
    0
  );
  const totalSales = (rows || []).reduce((sum, row) => sum + row.sales.length, 0);

  return (
    <div>
      <h1>Seller dashboard</h1>
      <p className="wallet">{wallet}</p>
      {error && <div className="status err">{error}</div>}
      {rows === null && !error && <p className="pitch">Loading…</p>}
      {rows !== null && rows.length === 0 && (
        <p className="pitch">This wallet has no listings yet.</p>
      )}
      {rows !== null && rows.length > 0 && (
        <>
          <div className="card">
            <div className="price">{totalUsdc.toFixed(2)} USDC</div>
            <p className="pitch">
              settled through the x402 door across {totalSales} sale
              {totalSales === 1 ? "" : "s"} and {rows.length} listing
              {rows.length === 1 ? "" : "s"}. File sales in SOL settle
              straight to the wallet and are visible on chain.
            </p>
          </div>
          {rows.map(({ listing, sales }) => (
            <div className="card" key={listing.id}>
              <span className={`badge ${listing.type === "api" ? "badge-api" : "badge-file"}`}>
                {listing.type === "api" ? "API access, x402" : "File download"}
              </span>
              <h2>
                <a href={`/listing/${listing.id}`}>{listing.title}</a>
              </h2>
              <p className="pitch">
                Price{" "}
                {listing.type === "api"
                  ? `${listing.priceUsdc} USDC`
                  : `${listing.priceSol} SOL`}
                {" · "}
                {sales.length} settled sale{sales.length === 1 ? "" : "s"}
              </p>
              {sales.map((sale) => (
                <p className="wallet" key={sale.id}>
                  {sale.amountUsdc} USDC from {shortAddress(sale.payer)} ·{" "}
                  {new Date(sale.createdAt).toLocaleString()}{" "}
                  {sale.signature && (
                    <a href={explorerTx(sale.signature)} target="_blank" rel="noreferrer">
                      view transaction
                    </a>
                  )}
                </p>
              ))}
            </div>
          ))}
        </>
      )}
      <p style={{ marginTop: 20 }}>
        <a href="/">Back to the catalog</a>
      </p>
    </div>
  );
}
