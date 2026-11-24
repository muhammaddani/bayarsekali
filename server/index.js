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
import { verifyPayment, solToLamports } from "./verify.js";
import {
  X402_VERSION,
  usdcToAtomic,
  buildRequirements,
  paymentRequiredBody,
  parsePaymentHeader,
  localCheckTransaction,
  facilitatorVerify,
  facilitatorSettle,
  paymentResponseHeader,
} from "./x402.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOADS_DIR = path.join(__dirname, "uploads");
const PORT = Number(process.env.PORT || 8787);
const TOKEN_TTL_MS = 15 * 60 * 1000;

await fs.mkdir(UPLOADS_DIR, { recursive: true });

const app = express();
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

function isValidWallet(value) {
  if (typeof value !== "string") return false;
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

// Create a listing. Two product types share this route:
// A file product arrives as multipart form fields title, priceSol,
// sellerWallet, plus the product file in the "file" field.
// An API product arrives as JSON: type "api", title, priceUsdc,
// sellerWallet, and resourceContent, the payload served after an x402
// payment. API products are paid in devnet USDC through the x402 flow.
app.post("/api/listings", upload.single("file"), async (req, res) => {
  const cleanup = async () => {
    if (req.file) await fs.unlink(req.file.path).catch(() => {});
  };
  try {
    const { title, priceSol, sellerWallet, type } = req.body || {};

    if (type === "api") {
      const { priceUsdc, resourceContent, resourceDescription } = req.body || {};
      if (!title || typeof title !== "string" || !title.trim()) {
        return res.status(400).json({ error: "Title is required." });
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
      if (
        typeof resourceContent !== "string" ||
        !resourceContent.trim() ||
        resourceContent.length > 64 * 1024
      ) {
        return res
          .status(400)
          .json({ error: "resourceContent must be a non-empty string of at most 64 KB." });
      }
      const listing = {
        id: nanoid(12),
        type: "api",
        title: title.trim(),
        priceUsdc: String(priceUsdc).trim(),
        sellerWallet,
        resourceContent,
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
      priceUsdc: listing.priceUsdc,
      sellerWallet: listing.sellerWallet,
      resourceUrl: "/api/resource/" + listing.id,
      resourceDescription: listing.resourceDescription || "",
      createdAt: listing.createdAt,
    });
  }
  return res.json({
    id: listing.id,
    type: "file",
    title: listing.title,
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
  const resourceUrl =
    req.protocol + "://" + req.get("host") + "/api/resource/" + listing.id;
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

  let verification;
  try {
    verification = await facilitatorVerify(payment, requirements);
  } catch (err) {
    console.error("facilitator verify failed:", err);
    return res.status(502).json({ error: "Payment verification is unavailable." });
  }
  if (!verification.isValid) {
    return res
      .status(402)
      .json({ error: "Payment invalid: " + (verification.invalidReason || "unknown") });
  }

  let settlement;
  try {
    settlement = await facilitatorSettle(payment, requirements);
  } catch (err) {
    console.error("facilitator settle failed:", err);
    return res.status(502).json({ error: "Payment settlement is unavailable." });
  }
  if (!settlement.success) {
    return res
      .status(502)
      .json({ error: "Payment settlement failed: " + (settlement.errorReason || "unknown") });
  }

  await store.insertSale({
    id: nanoid(16),
    listingId: listing.id,
    kind: "x402",
    amountUsdc: listing.priceUsdc,
    payer: settlement.payer || verification.payer || null,
    signature: settlement.transaction || null,
    createdAt: new Date().toISOString(),
  });

  res.set("X-PAYMENT-RESPONSE", paymentResponseHeader(settlement));
  let data;
  try {
    data = JSON.parse(listing.resourceContent);
  } catch {
    data = listing.resourceContent;
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

// Verify a payment intent on chain. Body: { intentId } or { reference }.
// On success the intent is marked paid and a one time download token is
// issued. Calling verify again on a paid intent returns the same status
// without issuing a second token.
app.post("/api/payments/verify", async (req, res) => {
  const { intentId, reference } = req.body || {};
  let intent = null;
  if (intentId) intent = await store.getIntentById(intentId);
  if (!intent && reference) intent = await store.getIntentByReference(reference);
  if (!intent) return res.status(404).json({ error: "Payment intent not found." });

  if (intent.status === "paid") {
    return res.json({ paid: true, status: "paid", alreadyVerified: true });
  }

  let result;
  try {
    result = await verifyPayment({
      reference: intent.reference,
      recipient: intent.recipient,
      amountSol: intent.amountSol,
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

  await store.updateIntent(intent.id, {
    status: "paid",
    signature: result.signature,
    paidAt: new Date().toISOString(),
  });

  const tokenValue = randomBytes(24).toString("hex");
  const token = {
    token: tokenValue,
    listingId: intent.listingId,
    intentId: intent.id,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + TOKEN_TTL_MS).toISOString(),
    used: false,
  };
  await store.insertToken(token);

  return res.json({
    paid: true,
    status: "paid",
    signature: result.signature,
    downloadToken: tokenValue,
    downloadUrl: "/api/download/" + tokenValue,
    expiresAt: token.expiresAt,
  });
});

// One time download. The token is invalidated before the file is sent,
// so it can never be replayed, and it dies 15 minutes after issue.
app.get("/api/download/:token", async (req, res) => {
  const token = await store.getToken(req.params.token);
  if (!token || token.used) {
    return res.status(404).json({ error: "Download link is invalid or already used." });
  }
  if (Date.now() > new Date(token.expiresAt).getTime()) {
    await store.updateToken(token.token, { used: true });
    return res.status(410).json({ error: "Download link has expired." });
  }
  const listing = await store.getListing(token.listingId);
  if (!listing) {
    return res.status(404).json({ error: "Listing not found." });
  }

  await store.updateToken(token.token, { used: true });
  const filePath = path.join(UPLOADS_DIR, listing.fileName);
  return res.download(filePath, listing.originalName, (err) => {
    if (err && !res.headersSent) {
      res.status(500).json({ error: "Could not send the file." });
    }
  });
});

// Anything under /uploads is refused outright, token or not.
app.use("/uploads", (_req, res) => {
  res.status(404).json({ error: "Not found." });
});

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
