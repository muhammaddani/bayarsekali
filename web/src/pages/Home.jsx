import { useEffect, useState } from "react";
import DemoAgentPanel from "../DemoAgentPanel.jsx";
import { ListingSubline } from "../lang.jsx";

const REPO_URL = "https://github.com/muhammaddani/bayarsekali";

function short(value) {
  if (!value || value.length < 12) return value || "";
  return value.slice(0, 4) + "…" + value.slice(-4);
}

function timeAgo(iso) {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

const explorerTx = (sig) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;

function useJson(url, pollMs = 0) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let cancelled = false;
    let timer = null;
    const load = () =>
      fetch(url)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then((d) => !cancelled && (setData(d), setError(false)))
        .catch(() => !cancelled && setError(true));
    load();
    if (pollMs) {
      timer = setInterval(() => document.visibilityState === "visible" && load(), pollMs);
    }
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [url, pollMs]);
  return [data, error];
}

export default function Home() {
  const [catalog, catalogError] = useJson("/api/listings");
  const [activity] = useJson("/api/activity", 8000);
  const listings = catalog ? catalog.listings : null;
  const apiListings = listings ? listings.filter((l) => l.type === "api") : null;

  return (
    <>
      <section className="hero">
        <div>
          <p className="eyebrow">x402 payments on Solana</p>
          <h1>Get paid by people and AI agents, per use.</h1>
          <p className="lede">
            Turn a file, a piece of content or an API you already run into something anyone
            can buy in one HTTP request. Buyers pay in USDC, it settles on Solana in seconds,
            and the money goes straight to your wallet.
          </p>
          <div className="cta-row">
            <a className="button" href="/create">
              Start selling
            </a>
            <a className="button secondary" href="#how">
              How it works
            </a>
          </div>
          <p className="fineprint">
            No accounts and no platform cut. AI agents pay with the x402 protocol or through
            our MCP server; people pay with one link and a Solana wallet.
          </p>
        </div>
        <div>
          {apiListings && apiListings.length ? (
            <DemoAgentPanel listings={apiListings} />
          ) : null}
        </div>
      </section>

      <section className="section" id="how">
        <div className="section-head">
          <h2>How a paid request works</h2>
          <span className="aside">x402 v2, exact scheme</span>
        </div>
        <ol className="flow">
          <li>
            <span className="n">01</span>
            <h3>Ask</h3>
            <p>The agent requests the resource like any API call.</p>
            <code>GET /api/resource/:id</code>
          </li>
          <li>
            <span className="n">02</span>
            <h3>Get a price</h3>
            <p>The server answers with what to pay, in which token, to whom.</p>
            <code>402 · 0.01 USDC → seller</code>
          </li>
          <li>
            <span className="n">03</span>
            <h3>Pay in the request</h3>
            <p>The agent signs a USDC transfer and retries. The facilitator pays the fee.</p>
            <code>X-PAYMENT: eyJ4NDAy…</code>
          </li>
          <li>
            <span className="n">04</span>
            <h3>Receive</h3>
            <p>Settled on Solana, then delivered. API sellers are paid only when their API answers.</p>
            <code>200 · X-PAYMENT-RESPONSE</code>
          </li>
        </ol>
      </section>

      <section className="section">
        <div className="section-head">
          <h2>Recent settlements</h2>
          <span className="aside">live from Solana devnet</span>
        </div>
        {activity && activity.sales.length ? (
          <table className="activity">
            <tbody>
              {activity.sales.map((sale) => (
                <tr key={sale.id}>
                  <td className="amount">{sale.amountUsdc} USDC</td>
                  <td className="what">
                    <a href={`/listing/${sale.listingId}`}>{sale.title}</a>
                  </td>
                  <td className="who">{short(sale.payer)}</td>
                  <td className="when">
                    {sale.signature ? (
                      <a href={explorerTx(sale.signature)} target="_blank" rel="noreferrer">
                        {timeAgo(sale.createdAt)} ↗
                      </a>
                    ) : (
                      timeAgo(sale.createdAt)
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="pitch">
            {activity ? "No settled sales yet. Run the demo agent above to make the first one." : "Loading…"}
          </p>
        )}
      </section>

      <section className="section" id="catalog">
        <div className="section-head">
          <h2>Catalog</h2>
          <a className="aside" href="/create">
            List something
          </a>
        </div>
        {catalogError && <div className="status err">The catalog could not be loaded right now.</div>}
        {listings === null && !catalogError && <p className="pitch">Loading…</p>}
        {listings && listings.length === 0 && <p className="pitch">No listings yet.</p>}
        {listings && listings.length > 0 && (
          <div className="catalog">
            {listings.map((l) => (
              <a className="catalog-row" key={l.id} href={`/listing/${l.id}`}>
                <span className={`badge ${l.type === "api" ? "badge-api" : "badge-file"}`}>
                  {l.type === "api" ? (l.mode === "proxy" ? "live api" : "x402 api") : "file"}
                </span>
                <span className="title">
                  {l.title}
                  <ListingSubline listing={l} />
                </span>
                <span className="sold">
                  {l.type === "api" ? `${l.salesCount || 0} sold` : "wallet checkout"}
                </span>
                <span className="amount">
                  {l.type === "api" ? `${l.priceUsdc} USDC` : `${l.priceSol} SOL`}
                </span>
              </a>
            ))}
          </div>
        )}
      </section>

      <section className="section" id="agents">
        <div className="section-head">
          <h2>For agents and developers</h2>
          <a className="aside" href={REPO_URL} target="_blank" rel="noreferrer">
            Docs on GitHub
          </a>
        </div>
        <div className="two-col">
          <div className="card">
            <h3>Shop from Claude, Cursor or any MCP client</h3>
            <p className="pitch">
              The MCP server gives an agent its own devnet wallet, a budget and a per purchase
              cap. Limits are checked against the server’s 402 price before anything is signed.
            </p>
            <pre className="snippet">{`claude mcp add bayarsekali \\
  -e AGENT_KEYPAIR=./agent-keypair.json \\
  -- node server/mcp.mjs`}</pre>
          </div>
          <div className="card">
            <h3>Or speak x402 directly</h3>
            <p className="pitch">
              Every API listing is a plain HTTPS endpoint. Any x402 client can pay it; the buyer
              library in the repo does it in one call.
            </p>
            <pre className="snippet">{`const { data } = await payForResource({
  resourceUrl, keypair, connection,
});`}</pre>
            <p className="fineprint">
              Agents can find every paid resource with its price at{" "}
              <a href="/.well-known/x402">/.well-known/x402</a>, with a plain text guide at{" "}
              <a href="/llms.txt">/llms.txt</a>.
            </p>
          </div>
        </div>
        <p className="fineprint">
          Starting in Indonesia, with creators and local data AI agents can’t buy anywhere else
          today. This deployment runs on Solana devnet with test funds that have no real value.
        </p>
      </section>
    </>
  );
}
