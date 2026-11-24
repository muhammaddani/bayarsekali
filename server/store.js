import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");

// One JSON file per collection. The data directory is created at runtime
// and is gitignored, so a fresh clone starts with an empty store.
const FILES = {
  listings: path.join(DATA_DIR, "listings.json"),
  intents: path.join(DATA_DIR, "intents.json"),
  tokens: path.join(DATA_DIR, "tokens.json"),
  sales: path.join(DATA_DIR, "sales.json"),
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
  getIntentByReference: (reference) =>
    find("intents", (i) => i.reference === reference),
  updateIntent: (id, patch) => update("intents", (i) => i.id === id, patch),

  insertToken: (token) => insert("tokens", token),
  getToken: (value) => find("tokens", (t) => t.token === value),
  updateToken: (value, patch) =>
    update("tokens", (t) => t.token === value, patch),

  insertSale: (sale) => insert("sales", sale),
  getSalesByListing: async (listingId) => {
    const rows = await readCollection("sales");
    return rows.filter((s) => s.listingId === listingId);
  },
};
