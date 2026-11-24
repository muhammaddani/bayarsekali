# BayarSekali

A micropayment paywall with two doors: one for humans, one for AI agents.

**Live:** https://bayarsekali.indonesiacentral.cloudapp.azure.com
**Network:** Solana devnet. Every payment uses test funds with no real value.

## The human door: files for SOL

A creator lists a digital file with a price in SOL and gets a shareable link. A buyer opens the link, connects a Solana wallet, pays the exact amount, the backend verifies the payment on chain, and a one time download unlocks. No accounts. No platform cut. The money goes straight to the seller wallet.

## The agent door: API access through x402

A creator lists API access with a price in USDC and gets a resource URL. Any x402 aware client, human or agent, that asks for the resource receives an HTTP 402 carrying the payment requirements. The client builds and signs a Solana transaction, retries with an `X-PAYMENT` header, a facilitator verifies and settles the payment on chain, and the server delivers the content in the same response. The buyer never pays network fees; the facilitator does.

This door implements the x402 v2 `exact` scheme for Solana against the public facilitator at x402.org, including the parts that only show up when a real facilitator checks your work:

- The payment transaction must follow the static verification layout from section 3.1 of the SVM exact scheme spec, in relative order: `SetComputeUnitLimit`, `SetComputeUnitPrice`, a `TransferChecked`, and a Memo instruction carrying a random nonce of at least 16 bytes, hex encoded. Any other shape falls through to the smart wallet path and is rejected.
- The facilitator pays network fees only. It will not fund account creation, so a missing recipient token account is created first, in a separate transaction paid by the buyer.
- Settlement is confirmed on chain before the resource is served, and every settled payment is recorded as a sale on the listing.

## Proof, not promises

An agent buyer settled a real 0.01 USDC payment for a dataset listing on this deployment. The facilitator paid the network fee; exactly 0.01 USDC moved to the seller token account.

Transaction: https://explorer.solana.com/tx/5wXRwLGHiSMq5MQLZJ34vNxgFdGSPJAEWid1MCgxHwtVk5BxeKWXa4sJVEGMWnVien1ynSr1G9qZXecYbsurbeR3?cluster=devnet

## The autonomous agent buyer

`server/agent-buy.mjs` is a standalone agent client. It holds its own wallet, discovers the price by asking for the resource, signs the payment itself, and receives the content. No browser, no human in the loop.

    cd server
    npm install
    AGENT_KEYPAIR=/path/to/agent-keypair.json node agent-buy.mjs https://bayarsekali.indonesiacentral.cloudapp.azure.com/api/resource/<listing-id>

Fund the agent wallet with devnet USDC from faucet.circle.com (choose Solana, then Devnet). A little devnet SOL is only needed if a receiving token account has to be created first.

The same flow also runs in the browser: every API listing page carries a step by step agent buyer demo that connects Phantom and settles a payment live.

## How the human door verifies payments

1. The buyer clicks Pay. The server creates a payment intent with a unique reference key.
2. The buyer signs a SOL transfer in their browser wallet. The transfer goes straight to the seller wallet and carries the reference key as a read only account key, Solana Pay style.
3. The server looks the reference up on devnet and confirms the recipient balance increased by at least the exact amount. The check reads the recipient balance delta, so it works for any recipient address.
4. The server issues a one time download token, valid for 15 minutes and exactly one download.

Payments are signed only in the buyer's own wallet. This project never asks for, stores, or uses any private key or seed phrase. The agent buyer's keypair lives in a local file owned by whoever runs the agent and is never sent anywhere.

## Project layout

    server/   Node and Express API on port 8787, plus the agent buyer CLI
    web/      Vite and React frontend, served by the API in production

## Run it locally

Terminal 1, the API:

    cd server
    npm install
    npm start

Terminal 2, the frontend:

    cd web
    npm install
    npm run dev

Open the Vite URL (usually http://localhost:5173). The dev server proxies /api to http://localhost:8787. For a production style run, `npm run build` in web/ and the API serves web/dist itself.

## API summary

    POST /api/listings                  create a listing: multipart file product, or JSON { type: "api", priceUsdc, resourceContent, ... }
    GET  /api/listings                  public catalog, display fields only
    GET  /api/listings/:id              public listing info, never the file path or resourceContent
    GET  /api/listings/:id/sales        settled sales recorded for the listing
    POST /api/listings/:id/checkout     create a SOL payment intent with a reference key
    POST /api/payments/verify           body: { intentId } or { reference }
    GET  /api/resource/:id              the x402 door: 402 without payment, content after settlement
    GET  /api/download/:token           one time download, token dies after use or 15 minutes
    GET  /api/health                    { ok: true }

## Notes

Listings, intents, tokens, and sales live in a small JSON file store under server/data, which is gitignored. Uploaded files live in server/uploads and are never served statically. In production the API runs as a systemd service behind Caddy with automatic HTTPS.

Built for the Dev3pack hackathon, November 2026.
