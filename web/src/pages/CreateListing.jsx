import { useState } from "react";
import { getProvider, signSellerChallenge } from "../solana.js";

export default function CreateListing() {
  const [mode, setMode] = useState("file");
  const [title, setTitle] = useState("");
  const [priceSol, setPriceSol] = useState("");
  const [priceUsdc, setPriceUsdc] = useState("");
  const [sellerWallet, setSellerWallet] = useState("");
  const [file, setFile] = useState(null);
  const [resourceDescription, setResourceDescription] = useState("");
  const [resourceContent, setResourceContent] = useState("");
  const [delivery, setDelivery] = useState("static");
  const [upstreamUrl, setUpstreamUrl] = useState("");
  const [secretHeaderName, setSecretHeaderName] = useState("");
  const [secretHeaderValue, setSecretHeaderValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);
  const [copied, setCopied] = useState("");

  // The connected wallet is the seller identity: payments go to it, and
  // it signs a free one time message to prove it is yours.
  async function connectWallet() {
    setError("");
    const provider = getProvider();
    if (!provider) {
      setError("No Solana wallet was found in this browser. Install Phantom and open this page again.");
      return;
    }
    try {
      const resp = await provider.connect();
      setSellerWallet(resp.publicKey.toString());
    } catch {
      setError("Wallet connection was rejected.");
    }
  }

  async function onSubmit(e) {
    e.preventDefault();
    setError("");
    setResult(null);
    setCopied("");
    if (!sellerWallet) {
      setError("Connect the wallet that should receive the payments first.");
      return;
    }
    setBusy(true);
    try {
      const auth = await signSellerChallenge(getProvider(), sellerWallet);
      let resp;
      if (mode === "api") {
        resp = await fetch("/api/listings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "api",
            title,
            priceUsdc,
            sellerWallet,
            resourceDescription,
            ...(delivery === "proxy"
              ? { upstreamUrl, secretHeaderName, secretHeaderValue }
              : { resourceContent }),
            ...auth,
          }),
        });
      } else {
        if (!file) {
          setError("Please choose a file to sell.");
          setBusy(false);
          return;
        }
        const form = new FormData();
        form.append("title", title);
        form.append("priceSol", priceSol);
        form.append("sellerWallet", sellerWallet);
        form.append("authNonce", auth.authNonce);
        form.append("authSignature", auth.authSignature);
        form.append("file", file);
        resp = await fetch("/api/listings", { method: "POST", body: form });
      }
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || "Could not create the listing.");
      setResult(data);
    } catch (err) {
      const rejected = err && (err.code === 4001 || /reject/i.test(err.message || ""));
      setError(rejected ? "The wallet signature was declined, so no listing was created." : err.message);
    } finally {
      setBusy(false);
    }
  }

  async function copyText(key, text) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
    } catch {
      setCopied("");
    }
  }

  return (
    <div>
      <div className="crumbs">
        <a href="/">Home</a> / Sell
      </div>
      <h1>Create a listing</h1>
      <p className="pitch">
        Sell a downloadable file for devnet SOL, or sell API access per call
        for devnet USDC through the x402 protocol. Either way the payment goes
        straight to your wallet, with no platform cut.
      </p>

      <div className="segrow">
        <button
          type="button"
          className={mode === "file" ? "" : "secondary"}
          onClick={() => setMode("file")}
        >
          Digital file
        </button>
        <button
          type="button"
          className={mode === "api" ? "" : "secondary"}
          onClick={() => setMode("api")}
        >
          API access (x402)
        </button>
      </div>

      <form className="card" onSubmit={onSubmit}>
        <label htmlFor="title">Product title</label>
        <input
          id="title"
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={
            mode === "api" ? "Example: Premium market report API" : "Example: Notion template pack"
          }
          required
        />
        {mode === "file" ? (
          <>
            <label htmlFor="price">Price in SOL (devnet)</label>
            <input
              id="price"
              type="number"
              step="0.000000001"
              min="0"
              value={priceSol}
              onChange={(e) => setPriceSol(e.target.value)}
              placeholder="0.01"
              required
            />
          </>
        ) : (
          <>
            <label htmlFor="priceUsdc">Price per call in USDC (devnet)</label>
            <input
              id="priceUsdc"
              type="number"
              step="0.000001"
              min="0"
              value={priceUsdc}
              onChange={(e) => setPriceUsdc(e.target.value)}
              placeholder="0.01"
              required
            />
          </>
        )}
        <label>Your wallet (receives the payment)</label>
        {sellerWallet ? (
          <p className="wallet">
            {sellerWallet} · signs a free message on create, no transaction
          </p>
        ) : (
          <button type="button" className="secondary" onClick={connectWallet}>
            Connect wallet
          </button>
        )}
        {mode === "file" ? (
          <>
            <label htmlFor="file">Product file</label>
            <input
              id="file"
              type="file"
              onChange={(e) => setFile(e.target.files[0] || null)}
              required
            />
          </>
        ) : (
          <>
            <label htmlFor="desc">Short description shown to buyers</label>
            <input
              id="desc"
              type="text"
              value={resourceDescription}
              onChange={(e) => setResourceDescription(e.target.value)}
              placeholder="Example: One premium data report, delivered per paid call"
            />
            <label>What a paid call delivers</label>
            <div className="segrow">
              <button
                type="button"
                className={delivery === "static" ? "" : "secondary"}
                onClick={() => setDelivery("static")}
              >
                Fixed content
              </button>
              <button
                type="button"
                className={delivery === "proxy" ? "" : "secondary"}
                onClick={() => setDelivery("proxy")}
              >
                My live API
              </button>
            </div>
            {delivery === "static" ? (
              <>
                <label htmlFor="content">
                  Content delivered after payment (text or JSON, at most 64 KB)
                </label>
                <textarea
                  id="content"
                  value={resourceContent}
                  onChange={(e) => setResourceContent(e.target.value)}
                  placeholder='{"report": "your paid content here"}'
                  rows={8}
                  required
                />
              </>
            ) : (
              <>
                <p className="pitch">
                  Turn an API you already run into a paid x402 API. Every paid call is
                  forwarded to your URL with the buyer's query parameters, and the buyer is
                  only charged when your API answers successfully. Your URL and secret never
                  leave the server.
                </p>
                <label htmlFor="upstream">Your API URL (https)</label>
                <input
                  id="upstream"
                  type="url"
                  value={upstreamUrl}
                  onChange={(e) => setUpstreamUrl(e.target.value)}
                  placeholder="https://api.example.com/v1/prices?region=jakarta"
                  required
                />
                <label htmlFor="hname">Secret header name (optional, for example Authorization)</label>
                <input
                  id="hname"
                  type="text"
                  value={secretHeaderName}
                  onChange={(e) => setSecretHeaderName(e.target.value)}
                  placeholder="Authorization"
                  autoComplete="off"
                />
                <label htmlFor="hvalue">Secret header value (optional)</label>
                <input
                  id="hvalue"
                  type="password"
                  value={secretHeaderValue}
                  onChange={(e) => setSecretHeaderValue(e.target.value)}
                  placeholder="Bearer your-api-key"
                  autoComplete="off"
                />
              </>
            )}
          </>
        )}
        <button type="submit" disabled={busy}>
          {busy ? "Waiting for wallet signature..." : "Sign and create listing"}
        </button>
        {error ? <div className="status err">{error}</div> : null}
      </form>

      {result ? (
        <div className="card">
          <h2>Your listing is live</h2>
          <p className="pitch">Share this buyer page link:</p>
          <div className="linkrow">
            <code>{window.location.origin + result.url}</code>
            <button
              type="button"
              className="secondary"
              onClick={() => copyText("page", window.location.origin + result.url)}
            >
              {copied === "page" ? "Copied" : "Copy link"}
            </button>
          </div>
          {result.resourceUrl ? (
            <>
              <p className="pitch">
                Agents pay at this x402 endpoint directly, no page visit needed:
              </p>
              <div className="linkrow">
                <code>{window.location.origin + result.resourceUrl}</code>
                <button
                  type="button"
                  className="secondary"
                  onClick={() =>
                    copyText("resource", window.location.origin + result.resourceUrl)
                  }
                >
                  {copied === "resource" ? "Copied" : "Copy link"}
                </button>
              </div>
            </>
          ) : null}
          <a className="button" href={result.url}>
            Open the buyer page
          </a>
        </div>
      ) : null}
    </div>
  );
}
