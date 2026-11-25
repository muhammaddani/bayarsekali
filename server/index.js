import "dotenv/config";
import express from "express";
import cors from "cors";
import multer from "multer";
import path from "node:path";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { Keypair, PublicKey } from "@solana/web3.js";
import { nanoid } from "nanoid";
import { store } from "./store.js";
import { rateLimit } from "./ratelimit.js";
import { createChallengeStore } from "./auth.js";
import { createDemoAgent, DemoRefusal } from "./demo.js";
import { atomicToUsdc } from "./spend-guard.mjs";
import dns from "node:dns/promises";
import {
  fetchUpstream,
  isPublicAddress,
  mergeQuery,
  upstreamData,
  validateSecretHeader,
  validateUpstreamUrl,
} from "./upstream.js";
import { readFileSync } from "node:fs";
import { cleanListingMeta, metaOf, buildDiscoveryDocument, buildLlmsTxt } from "./discovery.js";
import { createSampleApi } from "./sample-api.js";
import { verifyPayment, solToLamports, getConnection } from "./verify.js";
import {
  X402_VERSION,
  usdcToAtomic,
  buildRequirements,
  paymentRequiredBody,
  parsePaymentHeader,
  paymentKeyOf,
  localCheckTransaction,
  facilitatorVerify,
  facilitatorSettle,
  paymentResponseHeader,
  findSettlementOnChain,
} from "./x402.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOADS_DIR = path.join(__dirname, "uploads");
const PORT = Number(process.env.PORT || 8787);
const TOKEN_TTL_MS = 15 * 60 * 1000;
// A paid intent may ask for a fresh download link this many times in
// total, so a buyer whose download broke or whose tab closed is not
// locked out, while a leaked intent id can not become a free mirror.
const MAX_TOKENS_PER_INTENT = 5;
// The public origin of this deployment, used in x402 resource URLs.
// When unset, the request's own protocol and host are used.
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");

await fs.mkdir(UPLOADS_DIR, { recursive: true });

const app = express();
// The app sits behind the Caddy reverse proxy in production, which
// terminates HTTPS. Trust its forwarded headers so req.protocol
// reports https and generated resource URLs carry the right scheme.
app.set("trust proxy", true);
app.use(cors());
app.use(express.json());

// Files in uploads/ are private. They are only ever served through
// GET /api/download/:token. No static route is registered for uploads/.

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname || "").slice(0, 20);
      cb(null, nanoid(24) + ext);
    },
  }),
  limits: { fileSize: 200 * 1024 * 1024 },
});

// Well known program addresses. Paying "to" one of these sends funds
// where no seller can ever spend them, so they are refused as sellers.
const PROGRAM_ADDRESSES = new Set([
  "11111111111111111111111111111111",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
  "ComputeBudget111111111111111111111111111111",
  "SysvarRent111111111111111111111111111111111",
]);

function isValidWallet(value) {
  if (typeof value !== "string") return false;
  if (PROGRAM_ADDRESSES.has(value)) return false;
  try {
    const key = new PublicKey(value);
    return key.toBase58() === value;
  } catch {
    return false;
  }
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

// Solana RPC proxy for the browser. The frontend sends its JSON-RPC
// calls here, and the server forwards them to SOLANA_RPC_URL (for
// example a Helius devnet URL), so the RPC key never ships in the
// public bundle and demos do not hit the public devnet rate limits.
// Only the handful of methods the checkout pages use are allowed.
const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const RPC_METHODS = new Set([
  "getAccountInfo",
  "getBalance",
  "getBlockHeight",
  "getLatestBlockhash",
  "getSignatureStatuses",
  "getTokenAccountBalance",
  "sendTransaction",
]);
app.post(
  "/api/rpc",
  rateLimit({ windowMs: 60_000, max: 120, message: "Too many RPC calls, slow down." }),
  async (req, res) => {
    const call = req.body;
    if (!call || Array.isArray(call) || !RPC_METHODS.has(call.method)) {
      return res.status(400).json({
        jsonrpc: "2.0",
        id: (call && call.id) || null,
        error: { code: -32601, message: "Method not allowed through this proxy." },
      });
    }
    try {
      const upstream = await fetch(RPC_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: call.id ?? 1,
          method: call.method,
          params: call.params ?? [],
        }),
        signal: AbortSignal.timeout(20_000),
      });
      res.status(upstream.status).type("application/json").send(await upstream.text());
    } catch (err) {
      console.error("rpc proxy failed:", err.message);
      res.status(502).json({
        jsonrpc: "2.0",
        id: call.id ?? null,
        error: { code: -32000, message: "RPC upstream unavailable." },
      });
    }
  }
);

// Judge mode: a server side demo agent buys an API product through the
// real x402 flow and streams every step to the page, so visitors can
// watch an agent pay on chain without a wallet. Enabled only when
// DEMO_AGENT_KEYPAIR points at a funded devnet keypair file.
function loadDemoAgent() {
  const keypairPath = process.env.DEMO_AGENT_KEYPAIR;
  if (!keypairPath) return null;
  try {
    const secret = Uint8Array.from(JSON.parse(readFileSync(keypairPath, "utf8")));
    return createDemoAgent({
      keypair: Keypair.fromSecretKey(secret),
      connection: getConnection(),
      store,
      // The agent buys from this very server over loopback.
      resourceBase: "http://127.0.0.1:" + PORT,
      displayBase: PUBLIC_BASE_URL || "http://127.0.0.1:" + PORT,
      maxPerPurchaseUsdc: process.env.DEMO_MAX_PER_PURCHASE_USDC || "0.05",
      dailyBudgetUsdc: process.env.DEMO_DAILY_BUDGET_USDC || "1",
      allowedSellers: (process.env.DEMO_ALLOWED_SELLERS || "").split(",").map((s) => s.trim()),
    });
  } catch (err) {
    console.error("demo agent disabled:", err.message);
    return null;
  }
}
const demoAgent = loadDemoAgent();

app.get("/api/demo/status", async (_req, res) => {
  if (!demoAgent) return res.json({ enabled: false });
  return res.json(await demoAgent.status());
});

// Streams Server-Sent Events (read with fetch, not EventSource, since
// this is a POST): step events while the agent works, then one "done"
// or "error" event.
app.post(
  "/api/demo/agent-buy",
  rateLimit({
    windowMs: 60 * 60_000,
    max: 6,
    message: "You have run the demo agent several times this hour. Try again later.",
  }),
  async (req, res) => {
    if (!demoAgent) return res.status(404).json({ error: "The demo agent is not enabled here." });
    const { listingId } = req.body || {};
    const listing = typeof listingId === "string" ? await store.getListing(listingId) : null;
    if (!listing || listing.type !== "api") {
      return res.status(400).json({ error: "Pick an API listing for the demo agent to buy." });
    }
    res.status(200).set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });
    res.flushHeaders();
    const send = (event) => res.write("data: " + JSON.stringify(event) + "\n\n");
    try {
      send({ type: "step", step: "start", message: `wants "${listing.title}"` });
      const result = await demoAgent.run(listing.id, send);
      send({ type: "done", ...result });
    } catch (err) {
      if (!(err instanceof DemoRefusal)) console.error("demo agent run failed:", err.message);
      send({ type: "error", message: err.message });
    }
    res.end();
  }
);

// Seller sign in. The seller's wallet signs this one time message
// (free, no transaction) and the signature goes along with the new
// listing, proving the wallet that will receive the money is theirs.
const challenges = createChallengeStore();
const publicDomain = (req) =>
  PUBLIC_BASE_URL ? new URL(PUBLIC_BASE_URL).host : req.get("host");

app.post(
  "/api/auth/challenge",
  rateLimit({ windowMs: 60_000, max: 30 }),
  (req, res) => {
    const { wallet } = req.body || {};
    if (!isValidWallet(wallet)) {
      return res.status(400).json({ error: "wallet must be a valid Solana address." });
    }
    return res.json(challenges.issue({ domain: publicDomain(req), wallet }));
  }
);

// Create a listing. Two product types share this route:
// A file product arrives as multipart form fields title, priceSol,
// sellerWallet, plus the product file in the "file" field.
// An API product arrives as JSON: type "api", title, priceUsdc,
// sellerWallet, and resourceContent, the payload served after an x402
// payment. API products are paid in devnet USDC through the x402 flow.
// Every listing needs a fresh signed challenge from sellerWallet:
// fields authNonce and authSignature (base64 or base58).
const listingLimiter = rateLimit({
  windowMs: 60 * 60_000,
  max: 20,
  message: "Too many new listings from this address, try again later.",
});
app.post("/api/listings", listingLimiter, upload.single("file"), async (req, res) => {
  const cleanup = async () => {
    if (req.file) await fs.unlink(req.file.path).catch(() => {});
  };
  try {
    const { title, priceSol, sellerWallet, type, authNonce, authSignature } =
      req.body || {};

    if (!isValidWallet(sellerWallet)) {
      await cleanup();
      return res
        .status(400)
        .json({ error: "sellerWallet must be a valid Solana address." });
    }
    const auth = challenges.consume({
      nonce: authNonce,
      wallet: sellerWallet,
      signature: authSignature,
    });
    if (!auth.ok) {
      await cleanup();
      return res.status(401).json({ error: auth.reason });
    }

    if (type === "api") {
      const {
        priceUsdc,
        resourceContent,
        resourceDescription,
        upstreamUrl,
        secretHeaderName,
        secretHeaderValue,
      } = req.body || {};
      if (!title || typeof title !== "string" || !title.trim()) {
        return res.status(400).json({ error: "Title is required." });
      }
      let meta;
      try {
        meta = cleanListingMeta(req.body);
      } catch (err) {
        return res.status(400).json({ error: err.message });
      }
      if (usdcToAtomic(priceUsdc) === null) {
        return res
          .status(400)
          .json({ error: "priceUsdc must be a positive USDC amount with at most 6 decimals." });
      }
      if (!isValidWallet(sellerWallet)) {
        return res
          .status(400)
          .json({ error: "sellerWallet must be a valid Solana address." });
      }
      // Two ways to deliver: fixed content stored here, or the gateway
      // mode, where every paid call is forwarded to the seller's own API.
      let delivery;
      if (typeof upstreamUrl === "string" && upstreamUrl.trim()) {
        try {
          const url = validateUpstreamUrl(upstreamUrl.trim());
          const addresses = await dns.lookup(url.hostname.replace(/^\[|\]$/g, ""), { all: true });
          if (!addresses.length || addresses.some((a) => !isPublicAddress(a.address))) {
            throw new Error("The API URL must point to a public address.");
          }
          delivery = {
            mode: "proxy",
            upstreamUrl: url.toString(),
            secretHeader: validateSecretHeader(secretHeaderName, secretHeaderValue),
          };
        } catch (err) {
          const reason = err.code === "ENOTFOUND" ? "The API host could not be found." : err.message;
          return res.status(400).json({ error: reason });
        }
      } else {
        if (
          typeof resourceContent !== "string" ||
          !resourceContent.trim() ||
          resourceContent.length > 64 * 1024
        ) {
          return res.status(400).json({
            error: "Give resourceContent (a non-empty string of at most 64 KB) or an upstreamUrl.",
          });
        }
        delivery = { mode: "static", resourceContent };
      }
      const listing = {
        id: nanoid(12),
        type: "api",
        title: title.trim(),
        priceUsdc: String(priceUsdc).trim(),
        sellerWallet,
        ...meta,
        ...delivery,
        resourceDescription:
          typeof resourceDescription === "string" ? resourceDescription : "",
        createdAt: new Date().toISOString(),
      };
      await store.insertListing(listing);
      return res.status(201).json({
        id: listing.id,
        url: "/listing/" + listing.id,
        resourceUrl: "/api/resource/" + listing.id,
      });
    }

    if (!req.file) {
      return res.status(400).json({ error: "A product file is required." });
    }
    if (!title || typeof title !== "string" || !title.trim()) {
      await cleanup();
      return res.status(400).json({ error: "Title is required." });
    }
    let meta;
    try {
      meta = cleanListingMeta(req.body);
    } catch (err) {
      await cleanup();
      return res.status(400).json({ error: err.message });
    }
    const price = Number(priceSol);
    if (solToLamports(price) === null) {
      await cleanup();
      return res
        .status(400)
        .json({ error: "priceSol must be a positive number of SOL." });
    }
    if (!isValidWallet(sellerWallet)) {
      await cleanup();
      return res
        .status(400)
        .json({ error: "sellerWallet must be a valid Solana address." });
    }

    const listing = {
      id: nanoid(12),
      title: title.trim(),
      priceSol: price,
      sellerWallet,
      ...meta,
      fileName: req.file.filename,
      originalName: req.file.originalname,
      createdAt: new Date().toISOString(),
    };
    await store.insertListing(listing);

    return res.status(201).json({
      id: listing.id,
      url: "/listing/" + listing.id,
    });
  } catch (err) {
    await cleanup();
    console.error("create listing failed:", err);
    return res.status(500).json({ error: "Could not create the listing." });
  }
});

// Public catalog. Only display fields leave the server: never the
// stored file name, never an API product's resourceContent.
function publicListing(listing) {
  return listing.type === "api"
    ? {
        id: listing.id,
        type: "api",
        title: listing.title,
        ...metaOf(listing),
        priceUsdc: listing.priceUsdc,
        sellerWallet: listing.sellerWallet,
        mode: listing.mode === "proxy" ? "proxy" : "static",
        createdAt: listing.createdAt,
      }
    : {
        id: listing.id,
        type: "file",
        title: listing.title,
        ...metaOf(listing),
        priceSol: listing.priceSol,
        sellerWallet: listing.sellerWallet,
        createdAt: listing.createdAt,
      };
}

app.get("/api/listings", async (_req, res) => {
  const listings = await store.listListings();
  const sold = new Map();
  for (const sale of await store.listSales()) {
    sold.set(sale.listingId, (sold.get(sale.listingId) || 0) + 1);
  }
  const publicListings = listings
    .slice()
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .map((l) => ({ ...publicListing(l), salesCount: sold.get(l.id) || 0 }));
  return res.json({ listings: publicListings });
});

// Recent settled x402 sales across the whole marketplace, newest first:
// real on chain proof for the home page. Everything here is already
// public on chain.
app.get("/api/activity", async (_req, res) => {
  const titles = new Map((await store.listListings()).map((l) => [l.id, l.title]));
  const sales = (await store.listSales())
    .filter((s) => titles.has(s.listingId))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, 8)
    .map((s) => ({
      id: s.id,
      listingId: s.listingId,
      title: titles.get(s.listingId),
      amountUsdc: s.amountUsdc,
      payer: s.payer,
      signature: s.signature,
      createdAt: s.createdAt,
    }));
  return res.json({ sales });
});

// Public seller dashboard data in one call, cheap enough to poll: the
// wallet's listings, every settled x402 sale newest first, and the
// exact USDC total (summed in atomic units, never floats).
app.get("/api/sellers/:wallet", async (req, res) => {
  const wallet = req.params.wallet;
  if (!isValidWallet(wallet)) {
    return res.status(400).json({ error: "Not a valid Solana address." });
  }
  const listings = (await store.listListings())
    .filter((l) => l.sellerWallet === wallet)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const byId = new Map(listings.map((l) => [l.id, l]));
  const sales = (await store.listSales())
    .filter((s) => byId.has(s.listingId))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .map((s) => ({ ...s, listingTitle: byId.get(s.listingId).title }));
  const totalAtomic = sales.reduce(
    (sum, s) => sum + BigInt(usdcToAtomic(String(s.amountUsdc)) || "0"),
    0n
  );
  return res.json({
    wallet,
    listings: listings.map((l) => ({
      ...publicListing(l),
      salesCount: sales.filter((s) => s.listingId === l.id).length,
    })),
    sales,
    totals: { usdc: atomicToUsdc(totalAtomic), salesCount: sales.length },
  });
});

// Public listing info. The stored file name and path are never
// returned, and neither is an API product's resourceContent.
app.get("/api/listings/:id", async (req, res) => {
  const listing = await store.getListing(req.params.id);
  if (!listing) return res.status(404).json({ error: "Listing not found." });
  if (listing.type === "api") {
    return res.json({
      id: listing.id,
      type: "api",
      title: listing.title,
      ...metaOf(listing),
      priceUsdc: listing.priceUsdc,
      sellerWallet: listing.sellerWallet,
      resourceUrl: "/api/resource/" + listing.id,
      resourceDescription: listing.resourceDescription || "",
      // Gateway listings forward each paid call to the seller's API; the
      // URL and any secret header never leave the server.
      mode: listing.mode === "proxy" ? "proxy" : "static",
      createdAt: listing.createdAt,
    });
  }
  return res.json({
    id: listing.id,
    type: "file",
    title: listing.title,
    ...metaOf(listing),
    priceSol: listing.priceSol,
    sellerWallet: listing.sellerWallet,
    createdAt: listing.createdAt,
  });
});

// Sales recorded for one listing. The x402 flow appends a sale for
// every settled API payment. The current app has no seller accounts,
// so this is public like the rest of the demo surface.
app.get("/api/listings/:id/sales", async (req, res) => {
  const listing = await store.getListing(req.params.id);
  if (!listing) return res.status(404).json({ error: "Listing not found." });
  const sales = await store.getSalesByListing(listing.id);
  return res.json({ listingId: listing.id, sales });
});

// The x402 gated resource of an API product. Without an X-PAYMENT
// header the server answers 402 with the standard payment
// requirements. With one, the payment is checked locally, verified
// and settled through the facilitator, and only then is the resource
// served, with the settlement receipt in X-PAYMENT-RESPONSE.
async function handleResource(req, res) {
  const listing = await store.getListing(req.params.id);
  if (!listing || listing.type !== "api") {
    return res.status(404).json({ error: "Resource not found." });
  }
  const origin = PUBLIC_BASE_URL || req.protocol + "://" + req.get("host");
  const resourceUrl = origin + "/api/resource/" + listing.id;
  const requirements = await buildRequirements({
    resourceUrl,
    description: listing.resourceDescription || listing.title,
    payTo: listing.sellerWallet,
    amountAtomic: usdcToAtomic(listing.priceUsdc),
  });
  const required = () =>
    res
      .status(402)
      .json(
        paymentRequiredBody({
          resourceUrl,
          description: listing.resourceDescription || listing.title,
          requirements,
        })
      );

  const payment = parsePaymentHeader(req.get("x-payment"));
  if (!payment) return required();

  const local = localCheckTransaction(payment.payload.transaction, requirements);
  if (!local.ok) {
    return res.status(402).json({ error: "Payment rejected: " + local.reason });
  }

  // Replay protection. One signed payment buys exactly one delivery
  // of exactly one resource. The payment is claimed in the registry
  // before the facilitator is called, so a captured X-PAYMENT header
  // can never be spent twice, not even by two requests racing each
  // other. A claim left pending by a crashed attempt goes stale after
  // three minutes and may be claimed again; a failed attempt never
  // spends the payment.
  const paymentKey = paymentKeyOf(payment.payload.transaction);
  if (!paymentKey) {
    return res.status(402).json({ error: "Payment rejected: unreadable transaction" });
  }
  const claim = await store.claimPayment({
    paymentKey,
    listingId: listing.id,
    status: "pending",
    signature: null,
    createdAt: new Date().toISOString(),
  });
  if (!claim.claimed) {
    const record = claim.record;
    if (record.status === "settled") {
      return res.status(402).json({
        error:
          record.listingId === listing.id
            ? "This payment has already been settled. Each payment unlocks exactly one delivery."
            : "This payment has already been settled for a different resource.",
      });
    }
    return res
      .status(409)
      .json({ error: "This payment is already being settled. Retry shortly." });
  }
  const finish = (patch) => store.finishPayment(paymentKey, patch).catch(() => {});
  const markFailed = () => finish({ status: "failed" });

  // When an earlier attempt with this very payment broke off mid
  // settlement, or the settle call below breaks off, the payment may
  // already be on chain. Look for it there before giving up, so a buyer
  // who paid is never refused and never asked to pay twice.
  const lookOnChain = () =>
    findSettlementOnChain({
      connection: getConnection(),
      transactionBase64: payment.payload.transaction,
      requirements,
    }).catch((err) => {
      console.error("on chain settlement lookup failed:", err);
      return null;
    });

  // Gateway listings: call the seller's API after the payment is
  // verified and before it is settled, so a buyer is charged only for a
  // call that the seller's API answered successfully.
  const isProxy = listing.mode === "proxy";
  let upstream = null;
  const callUpstream = async () => {
    try {
      const answer = await fetchUpstream({
        url: mergeQuery(listing.upstreamUrl, req.query).toString(),
        secretHeader: listing.secretHeader || null,
      });
      return answer.ok ? { ok: true, answer } : { ok: false, reason: "it answered HTTP " + answer.status };
    } catch (err) {
      console.error("upstream call failed for", listing.id + ":", err.message);
      return { ok: false, reason: err.code === "EUPSTREAM_PRIVATE" ? "its address is not public" : "it did not answer" };
    }
  };

  let verification = null;
  let settlement = null;
  // Any earlier attempt (broken off, crashed, or refused after it may
  // have raced a landing) means the chain is checked first.
  if (claim.previous) {
    const landed = await lookOnChain();
    if (landed) {
      settlement = { success: true, transaction: landed, network: requirements.network };
    }
  }

  if (!settlement) {
    try {
      verification = await facilitatorVerify(payment, requirements);
    } catch (err) {
      console.error("facilitator verify failed:", err);
      await markFailed();
      return res.status(502).json({ error: "Payment verification is unavailable." });
    }
    if (!verification.isValid) {
      await markFailed();
      return res
        .status(402)
        .json({ error: "Payment invalid: " + (verification.invalidReason || "unknown") });
    }

    if (isProxy) {
      upstream = await callUpstream();
      if (!upstream.ok) {
        await markFailed();
        return res.status(502).json({
          error: `The seller's API could not deliver (${upstream.reason}). Your payment was not settled, so you were not charged.`,
        });
      }
    }

    try {
      settlement = await facilitatorSettle(payment, requirements);
    } catch (err) {
      console.error("facilitator settle failed:", err);
      const landed = await lookOnChain();
      if (landed) {
        settlement = { success: true, transaction: landed, network: requirements.network };
      } else {
        // Not "failed": the facilitator may still land it. A retry with
        // the same X-PAYMENT header checks the chain first.
        await finish({ status: "unknown" });
        return res.status(502).json({
          error:
            "Payment settlement did not answer. Retry the same request in a minute; the same payment is never charged twice.",
        });
      }
    }
    if (!settlement.success) {
      await markFailed();
      return res
        .status(502)
        .json({ error: "Payment settlement failed: " + (settlement.errorReason || "unknown") });
    }
  }

  await finish({
    status: "settled",
    signature: settlement.transaction || null,
  });

  await store.insertSale({
    id: nanoid(16),
    listingId: listing.id,
    kind: "x402",
    amountUsdc: listing.priceUsdc,
    payer: settlement.payer || (verification && verification.payer) || null,
    signature: settlement.transaction || null,
    createdAt: new Date().toISOString(),
  });

  res.set("X-PAYMENT-RESPONSE", paymentResponseHeader(settlement));
  let data;
  if (isProxy) {
    // A payment found already settled from an earlier attempt has not
    // called the API yet in this request.
    if (!upstream) upstream = await callUpstream();
    if (!upstream.ok) {
      return res.status(502).json({
        error: `Your payment had already settled, but the seller's API could not deliver (${upstream.reason}). Contact the seller with transaction ${settlement.transaction || "unknown"}.`,
        payment: { transaction: settlement.transaction || null },
      });
    }
    data = upstreamData(upstream.answer);
  } else {
    try {
      data = JSON.parse(listing.resourceContent);
    } catch {
      data = listing.resourceContent;
    }
  }
  return res.json({
    data,
    payment: {
      transaction: settlement.transaction || null,
      payer: settlement.payer || null,
      network: settlement.network || requirements.network,
    },
  });
}
app.get("/api/resource/:id", handleResource);
app.post("/api/resource/:id", handleResource);

// Start checkout. Creates a payment intent whose reference is a fresh
// public key. The buyer adds this key as a read only account key on the
// transfer, so the payment can be found on chain later, Solana Pay style.
app.post("/api/listings/:id/checkout", async (req, res) => {
  const listing = await store.getListing(req.params.id);
  if (!listing) return res.status(404).json({ error: "Listing not found." });

  const reference = Keypair.generate().publicKey.toBase58();
  const intent = {
    id: nanoid(16),
    listingId: listing.id,
    reference,
    amountSol: listing.priceSol,
    recipient: listing.sellerWallet,
    status: "pending",
    signature: null,
    createdAt: new Date().toISOString(),
    paidAt: null,
  };
  await store.insertIntent(intent);

  return res.status(201).json({
    intentId: intent.id,
    reference: intent.reference,
    amountSol: intent.amountSol,
    recipient: intent.recipient,
  });
});

// Verify a payment intent on chain. Body: { intentId }.
//
// The intent id is the buyer's secret: only the browser that started
// checkout ever sees it. The reference key is not accepted here,
// because it is public on chain the moment the buyer pays, and anyone
// watching the seller's wallet could otherwise claim the download.
//
// On success the intent is marked paid and a one time download token
// is issued. Calling verify again on a paid intent issues a fresh token
// (up to MAX_TOKENS_PER_INTENT in total), so a buyer whose download
// broke off or whose tab closed can still get the file they paid for.
async function issueDownloadToken(intent) {
  const tokenValue = randomBytes(24).toString("hex");
  const token = {
    token: tokenValue,
    listingId: intent.listingId,
    intentId: intent.id,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + TOKEN_TTL_MS).toISOString(),
    used: false,
  };
  return store.issueToken(token, MAX_TOKENS_PER_INTENT);
}

function paidResponse(intent, token) {
  return {
    paid: true,
    status: "paid",
    signature: intent.signature,
    downloadToken: token.token,
    downloadUrl: "/api/download/" + token.token,
    expiresAt: token.expiresAt,
  };
}

app.post("/api/payments/verify", async (req, res) => {
  const { intentId } = req.body || {};
  if (typeof intentId !== "string" || !intentId) {
    return res.status(400).json({ error: "intentId is required." });
  }
  let intent = await store.getIntentById(intentId);
  if (!intent) return res.status(404).json({ error: "Payment intent not found." });

  if (intent.status !== "paid") {
    let result;
    try {
      result = await verifyPayment({
        reference: intent.reference,
        recipient: intent.recipient,
        amountSol: intent.amountSol,
        usedSignatures: await store.usedSignatures(),
      });
    } catch (err) {
      console.error("payment verification error:", err);
      return res
        .status(502)
        .json({ paid: false, status: "pending", error: "RPC check failed, try again." });
    }

    if (!result.paid) {
      return res.json({
        paid: false,
        status: "pending",
        reason: result.reason,
      });
    }

    // Atomic: the signature is bound to this intent only if no other
    // intent claimed it first, even when two verify calls race.
    const marked = await store.markIntentPaid(intent.id, result.signature);
    if (!marked.ok) {
      return res.json({ paid: false, status: "pending", reason: marked.reason });
    }
    intent = marked.intent;
  }

  const token = await issueDownloadToken(intent);
  if (!token) {
    return res.status(429).json({
      paid: true,
      status: "paid",
      signature: intent.signature,
      error: "This purchase has used all of its download links. Contact the seller with your transaction signature.",
    });
  }
  return res.json(paidResponse(intent, token));
});

// One time download. The token is consumed atomically before the file
// is sent, so it can never be replayed, and it dies 15 minutes after
// issue. If the transfer itself fails, the token is given back, so a
// dropped connection does not cost the buyer the purchase.
app.get("/api/download/:token", async (req, res) => {
  const consumed = await store.consumeToken(req.params.token);
  if (consumed.error === "expired") {
    return res.status(410).json({ error: "Download link has expired." });
  }
  if (!consumed.token) {
    return res.status(404).json({ error: "Download link is invalid or already used." });
  }
  const token = consumed.token;
  const listing = await store.getListing(token.listingId);
  if (!listing) {
    await store.restoreToken(token.token).catch(() => {});
    return res.status(404).json({ error: "Listing not found." });
  }

  const filePath = path.join(UPLOADS_DIR, listing.fileName);
  return res.download(filePath, listing.originalName, async (err) => {
    if (!err) return;
    console.error("download failed:", err.code || err.message);
    await store.restoreToken(token.token).catch(() => {});
    if (!res.headersSent) {
      res.status(500).json({ error: "Could not send the file. The link still works; try again." });
    }
  });
});

// Anything under /uploads is refused outright, token or not.
app.use("/uploads", (_req, res) => {
  res.status(404).json({ error: "Not found." });
});

// Discovery for agents: every paid resource with the exact payment
// requirements its 402 answers with, and a plain text guide for
// language model agents. Both are built from the live catalog.
const originOf = (req) => PUBLIC_BASE_URL || req.protocol + "://" + req.get("host");
app.get("/.well-known/x402", async (req, res) => {
  try {
    const doc = await buildDiscoveryDocument({
      listings: await store.listListings(),
      origin: originOf(req),
      requirementsFor: (listing, resourceUrl) =>
        buildRequirements({
          resourceUrl,
          description: listing.resourceDescription || listing.title,
          payTo: listing.sellerWallet,
          amountAtomic: usdcToAtomic(listing.priceUsdc),
        }),
    });
    res.json(doc);
  } catch (err) {
    console.error("discovery failed:", err);
    res.status(500).json({ error: "Discovery is unavailable right now." });
  }
});
app.get("/llms.txt", async (req, res) => {
  const text = buildLlmsTxt({ listings: await store.listListings(), origin: originOf(req) });
  res.type("text/plain; charset=utf-8").send(text);
});

// A sample seller API (Indonesian earthquake data from BMKG) that a
// gateway listing can wrap. It has its own API key, held only by the
// gateway listing as its secret header. Off unless SAMPLE_API_KEY is set.
if (process.env.SAMPLE_API_KEY) {
  app.use("/sample-api", createSampleApi({ apiKey: process.env.SAMPLE_API_KEY }));
}

// Serve the built frontend (web/dist) on the same origin when present,
// so one deployment hosts both the page and the API. The API routes
// above keep priority; unknown non-API paths return the app shell.
const WEB_DIST = path.join(__dirname, "..", "web", "dist");
app.use(express.static(WEB_DIST));
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/")) return next();
  return res.sendFile(path.join(WEB_DIST, "index.html"));
});

app.use((err, _req, res, _next) => {
  if (err && err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ error: "File is too large." });
  }
  console.error(err);
  return res.status(500).json({ error: "Server error." });
});

app.listen(PORT, () => {
  console.log("BayarSekali API listening on http://localhost:" + PORT);
});
