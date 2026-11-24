import { useState } from "react";

export default function CreateListing() {
  const [mode, setMode] = useState("file");
  const [title, setTitle] = useState("");
  const [priceSol, setPriceSol] = useState("");
  const [priceUsdc, setPriceUsdc] = useState("");
  const [sellerWallet, setSellerWallet] = useState("");
  const [file, setFile] = useState(null);
  const [resourceDescription, setResourceDescription] = useState("");
  const [resourceContent, setResourceContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);
  const [copied, setCopied] = useState("");

  async function onSubmit(e) {
    e.preventDefault();
    setError("");
    setResult(null);
    setCopied("");
    setBusy(true);
    try {
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
            resourceContent,
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
        form.append("file", file);
        resp = await fetch("/api/listings", { method: "POST", body: form });
      }
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || "Could not create the listing.");
      setResult(data);
    } catch (err) {
      setError(err.message);
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
        <label htmlFor="wallet">Your Solana wallet address (receives the payment)</label>
        <input
          id="wallet"
          type="text"
          value={sellerWallet}
          onChange={(e) => setSellerWallet(e.target.value)}
          placeholder="Paste your devnet wallet address"
          required
        />
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
        )}
        <button type="submit" disabled={busy}>
          {busy ? "Creating..." : "Create listing"}
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
