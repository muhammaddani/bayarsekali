import { useEffect, useRef, useState } from "react";

// Judge mode: press one button and watch the server's demo AI agent buy
// an API product through the real x402 flow, step by step, settled on
// Solana devnet. No wallet, no faucet, no install.
//
// Props: listings (API listings to choose from) or listingId (fixed),
// and onPaid, called after a settled purchase.

function tagFor(event) {
  const m = event.message || "";
  if (event.step === "start") return "agent";
  if (event.step === "limits") return "limits";
  if (m.startsWith("GET") && m.includes("X-PAYMENT")) return "retry";
  if (m.startsWith("GET")) return "GET";
  if (m.startsWith("402")) return "402";
  if (event.step === "step 2/4") return "sign";
  if (m.startsWith("200")) return "200";
  return event.step;
}

const shortenKeys = (text) =>
  text.replace(/[1-9A-HJ-NP-Za-km-z]{32,90}/g, (k) => `${k.slice(0, 4)}…${k.slice(-4)}`);

async function readEvents(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let cut;
    while ((cut = buffer.indexOf("\n\n")) !== -1) {
      const chunk = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      const line = chunk.split("\n").find((l) => l.startsWith("data: "));
      if (line) onEvent(JSON.parse(line.slice(6)));
    }
  }
}

function preview(content) {
  const text = typeof content === "string" ? content : JSON.stringify(content, null, 2);
  return text.length > 4000 ? text.slice(0, 4000) + "\n…" : text;
}

export default function DemoAgentPanel({ listings = null, listingId = null, onPaid = () => {} }) {
  const [status, setStatus] = useState(null);
  const [chosen, setChosen] = useState(listingId || "");
  const [lines, setLines] = useState([]);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const started = useRef(0);

  const loadStatus = () =>
    fetch("/api/demo/status")
      .then((r) => r.json())
      .then(setStatus)
      .catch(() => setStatus({ enabled: false }));

  useEffect(() => {
    loadStatus();
  }, []);

  useEffect(() => {
    if (!listingId && listings && listings.length && !chosen) {
      const cheapest = listings
        .slice()
        .sort((a, b) => Number(a.priceUsdc) - Number(b.priceUsdc))[0];
      setChosen(cheapest.id);
    }
  }, [listings, listingId, chosen]);

  if (!status || !status.enabled) return null;

  async function run() {
    setBusy(true);
    setLines([]);
    setResult(null);
    started.current = performance.now();
    try {
      const resp = await fetch("/api/demo/agent-buy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ listingId: chosen }),
      });
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        throw new Error(body.error || "The demo agent could not start.");
      }
      await readEvents(resp, (event) => {
        if (event.type === "step") {
          const tag = tagFor(event);
          let msg = shortenKeys(event.message);
          // "GET …", "402 …", "200 …": the tag already says it.
          if (msg.startsWith(tag + " ")) msg = msg.slice(tag.length + 1);
          setLines((l) => [...l, { tag, msg }]);
        } else if (event.type === "done") {
          setResult({ ...event, seconds: (performance.now() - started.current) / 1000 });
          if (event.paid) onPaid();
        } else if (event.type === "error") {
          setLines((l) => [...l, { tag: "error", msg: event.message, err: true }]);
        }
      });
    } catch (err) {
      setLines((l) => [...l, { tag: "error", msg: err.message, err: true }]);
    } finally {
      setBusy(false);
      loadStatus();
    }
  }

  const wallet = status.wallet;
  return (
    <div className="console">
      <div className="console-bar">
        <span>
          <strong>demo agent</strong> {wallet.slice(0, 4)}…{wallet.slice(-4)}
        </span>
        <span>{status.usdcBalance} USDC</span>
      </div>
      <div className="console-body">
        {listings && !listingId ? (
          <>
            <label htmlFor="demo-listing">Product to buy</label>
            <select
              id="demo-listing"
              value={chosen}
              onChange={(e) => setChosen(e.target.value)}
              disabled={busy}
            >
              {listings.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.priceUsdc} USDC · {l.title}
                </option>
              ))}
            </select>
          </>
        ) : null}

        <button type="button" className="block" onClick={run} disabled={busy || !chosen}>
          {busy ? "Buying…" : listingId ? "Let the demo agent buy this" : "Let the AI agent buy it"}
        </button>

        <div className="console-log" aria-live="polite">
          {lines.length === 0 ? (
            <span className="idle">
              The agent asks for the product, gets HTTP 402 with a price, checks its limits,
              signs a USDC payment and receives the content once it settles on Solana. Real
              transactions, devnet funds.
            </span>
          ) : (
            lines.map((line, i) => (
              <div className={"log-line" + (line.err ? " err" : "")} key={i}>
                <span className="tag">{line.tag}</span>
                <span className="msg">{line.msg}</span>
              </div>
            ))
          )}
        </div>

        {result && result.paid ? (
          <>
            <div className="result-head">
              <span>
                Paid <strong className="mono">{result.amountUsdc} USDC</strong>, settled in{" "}
                {result.seconds.toFixed(1)}s
              </span>
              {result.explorer ? (
                <a href={result.explorer} target="_blank" rel="noreferrer">
                  View on Solana Explorer ↗
                </a>
              ) : null}
            </div>
            <details>
              <summary className="fineprint">Content the agent received</summary>
              <pre className="payload">{preview(result.content)}</pre>
            </details>
          </>
        ) : null}

        <p className="console-meta">
          limit {status.maxPerPurchaseUsdc} USDC per purchase · {status.remainingTodayUsdc} of{" "}
          {status.dailyBudgetUsdc} USDC left today
        </p>
      </div>
    </div>
  );
}
