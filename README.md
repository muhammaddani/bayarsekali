# BayarSekali

A paywall humans and AI agents can both pay. Files for people, API
access for agents, settled on Solana through the x402 protocol. No
accounts, no checkout forms, no platform cut.

Live app: http://bayarsekali.indonesiacentral.cloudapp.azure.com:8787

Built for Dev3pack 2026 by Muhammad Dani Noar.

## Two doors, one paywall

### The human door

A creator uploads a digital file, sets a price in SOL, and shares one
link. The buyer connects a Solana wallet, pays the exact amount, and
the download unlocks as soon as the payment is verified on chain.

Checkout creates a payment intent with a fresh reference key (the
Solana Pay pattern). The server finds the transaction by its
reference, confirms it is finalized, and checks that the seller
received at least the exact amount. Verification issues a one time
download token, valid for 15 minutes and invalidated after a single
use. The file is never exposed at a public URL.

### The agent door (x402 version 2, exact scheme)

A creator sells API access per call: title, price per call in USDC,
payout wallet, and the content to deliver. The app returns a paid
endpoint URL.

1. An agent requests the endpoint and receives HTTP 402 with the
   standard payment requirements: scheme exact, network Solana
   devnet (CAIP-2), asset the official devnet USDC mint, amount in
   atomic units, payTo the seller, and the facilitator fee payer.
2. The agent builds a USDC TransferChecked transaction whose fee
   payer is the facilitator, signs it, and retries with the payment
   in the X-PAYMENT header.
3. The server checks the transaction structure locally, then the
   x402 facilitator (x402.org) verifies it and settles it on chain,
   co-signing as fee payer.
4. Only after settlement is the content delivered, with the
   settlement receipt in the X-PAYMENT-RESPONSE header. Every
   settled call is recorded as a sale.

The listing page includes a working agent buyer demo that performs
this handshake in the open, step by step.

## Repository layout

    server/   Express API: listings, SOL payment verification,
              the x402 resource server (x402.js), JSON store
    web/      React and Vite frontend: storefront, listing pages,
              the agent buyer demo

## Run it locally

    cd web && npm install && npm run build
    cd ../server && npm install && PORT=8787 npm start

Then open http://localhost:8787. Payments run on Solana devnet:
file listings take devnet SOL, API listings take devnet USDC from
faucet.circle.com, and wallets must be set to devnet (in Phantom:
Settings, Developer Settings, Testnet Mode).

## What is next

Mainnet deployment with real USDC, an on chain receipt program,
seller accounts, metered pricing for API products, and an SDK so
any agent framework can pay a BayarSekali endpoint in two lines.
