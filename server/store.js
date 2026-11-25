import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// DATA_DIR lets tests (and deployments) point the store somewhere else.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");

// One JSON file per collection. The data directory is created at runtime
// and is gitignored, so a fresh clone starts with an empty store.
const FILES = {
  listings: path.join(DATA_DIR, "listings.json"),
  intents: path.join(DATA_DIR, "intents.json"),
  tokens: path.join(DATA_DIR, "tokens.json"),
  sales: path.join(DATA_DIR, "sales.json"),
  payments: path.join(DATA_DIR, "payments.json"),
};

async function ensureDataDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function readCollection(name) {
  await ensureDataDir();
  try {
    const raw = await fs.readFile(FILES[name], "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    if (err.code === "ENOENT") return [];
    if (err instanceof SyntaxError) return [];
    throw err;
  }
}

async function writeCollection(name, rows) {
  await ensureDataDir();
  const tmp = FILES[name] + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(rows, null, 2), "utf8");
  await fs.rename(tmp, FILES[name]);
}

// Simple promise queue so concurrent requests never interleave a
// read modify write cycle on the same file.
let queue = Promise.resolve();
function serialized(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

async function insert(name, row) {
  return serialized(async () => {
    const rows = await readCollection(name);
    rows.push(row);
    await writeCollection(name, rows);
    return row;
  });
}

async function find(name, predicate) {
  const rows = await readCollection(name);
  return rows.find(predicate) || null;
}

async function update(name, predicate, patch) {
  return serialized(async () => {
    const rows = await readCollection(name);
    const idx = rows.findIndex(predicate);
    if (idx === -1) return null;
    rows[idx] = { ...rows[idx], ...patch };
    await writeCollection(name, rows);
    return rows[idx];
  });
}

export const store = {
  insertListing: (listing) => insert("listings", listing),
  getListing: (id) => find("listings", (l) => l.id === id),
  listListings: () => readCollection("listings"),

  insertIntent: (intent) => insert("intents", intent),
  getIntentById: (id) => find("intents", (i) => i.id === id),
  updateIntent: (id, patch) => update("intents", (i) => i.id === id, patch),

  // Every signature that already paid for an intent. verifyPayment
  // skips these, so one transfer can never pay for two intents.
  usedSignatures: async () => {
    const rows = await readCollection("intents");
    return new Set(rows.filter((i) => i.signature).map((i) => i.signature));
  },

  // Mark an intent paid by one on chain signature, atomically. Fails
  // when the signature already paid for a different intent, even if two
  // verify calls for two intents race each other. An intent that is
  // already paid is returned as is.
  // Returns { ok: true, intent, already } or { ok: false, reason }.
  markIntentPaid: (intentId, signature) =>
    serialized(async () => {
      const rows = await readCollection("intents");
      const idx = rows.findIndex((i) => i.id === intentId);
      if (idx === -1) return { ok: false, reason: "not_found" };
      if (rows[idx].status === "paid") {
        return { ok: true, intent: rows[idx], already: true };
      }
      if (rows.some((i) => i.id !== intentId && i.signature === signature)) {
        return { ok: false, reason: "signature_used" };
      }
      rows[idx] = {
        ...rows[idx],
        status: "paid",
        signature,
        paidAt: new Date().toISOString(),
      };
      await writeCollection("intents", rows);
      return { ok: true, intent: rows[idx], already: false };
    }),

  insertToken: (token) => insert("tokens", token),
  getToken: (value) => find("tokens", (t) => t.token === value),
  updateToken: (value, patch) =>
    update("tokens", (t) => t.token === value, patch),

  // Issue a download token for an intent unless the intent already
  // received maxPerIntent tokens. Returns the token or null.
  issueToken: (token, maxPerIntent) =>
    serialized(async () => {
      const rows = await readCollection("tokens");
      const count = rows.filter((t) => t.intentId === token.intentId).length;
      if (count >= maxPerIntent) return null;
      rows.push(token);
      await writeCollection("tokens", rows);
      return token;
    }),

  // Consume a download token in one serialized step, so two requests
  // racing with the same token can never both get the file.
  // Returns { token } or { error: "invalid" | "expired" }.
  consumeToken: (value) =>
    serialized(async () => {
      const rows = await readCollection("tokens");
      const idx = rows.findIndex((t) => t.token === value);
      if (idx === -1 || rows[idx].used) return { error: "invalid" };
      const expired = Date.now() > Date.parse(rows[idx].expiresAt);
      rows[idx] = { ...rows[idx], used: true };
      await writeCollection("tokens", rows);
      return expired ? { error: "expired" } : { token: rows[idx] };
    }),

  // Give a consumed token back after the file transfer failed, so a
  // dropped connection does not cost the buyer their purchase.
  restoreToken: (value) =>
    update("tokens", (t) => t.token === value, { used: false }),

  insertSale: (sale) => insert("sales", sale),
  getSalesByListing: async (listingId) => {
    const rows = await readCollection("sales");
    return rows.filter((s) => s.listingId === listingId);
  },

  // The x402 replay registry. One record per payment transaction,
  // keyed by the hash of its serialized bytes. A record is claimed as
  // "pending" before the facilitator is called, then lands as
  // "settled", "failed", or "unknown" (the facilitator call broke off,
  // so the payment may or may not be on chain). Only a settled record
  // spends the payment.
  //
  // claimPayment is one serialized check and set: a new key is
  // claimed, a settled key or a fresh pending claim is refused, and a
  // failed, unknown, or stale pending record is taken over. Two
  // requests carrying the same payment can never both hold the claim.
  // Returns { claimed: true, previous } or { claimed: false, record }.
  claimPayment: (record, { staleMs = 180_000 } = {}) =>
    serialized(async () => {
      const rows = await readCollection("payments");
      const idx = rows.findIndex((p) => p.paymentKey === record.paymentKey);
      if (idx === -1) {
        rows.push(record);
        await writeCollection("payments", rows);
        return { claimed: true, previous: null };
      }
      const existing = rows[idx];
      const freshPending =
        existing.status === "pending" &&
        Date.now() - Date.parse(existing.createdAt) < staleMs;
      if (existing.status === "settled" || freshPending) {
        return { claimed: false, record: existing };
      }
      rows[idx] = { ...existing, ...record };
      await writeCollection("payments", rows);
      return { claimed: true, previous: existing };
    }),
  // Move a claimed payment out of "pending". Never touches a record
  // that is no longer pending, so a late failure can not overwrite a
  // settlement.
  finishPayment: (paymentKey, patch) =>
    update(
      "payments",
      (p) => p.paymentKey === paymentKey && p.status === "pending",
      patch
    ),
  getPayment: (paymentKey) =>
    find("payments", (p) => p.paymentKey === paymentKey),
  updatePayment: (paymentKey, patch) =>
    update("payments", (p) => p.paymentKey === paymentKey, patch),
};
