// Add or change the English summary and content language of listings
// that already exist, for example ones created before these fields.
// Run on the server, from server/, while the service is stopped or idle:
//
//   node tools/set-listing-meta.mjs <listing-id> --summary-en "..." --lang id
//   node tools/set-listing-meta.mjs --file meta.json
//
// meta.json: { "<listing-id>": { "summaryEn": "...", "contentLanguage": "id" } }
import { readFileSync } from "node:fs";
import { store } from "../store.js";
import { cleanListingMeta } from "../discovery.js";

function parseArgs(argv) {
  if (argv[0] === "--file") return JSON.parse(readFileSync(argv[1], "utf8"));
  const [id, ...rest] = argv;
  const entry = {};
  for (let i = 0; i < rest.length; i += 2) {
    if (rest[i] === "--summary-en") entry.summaryEn = rest[i + 1];
    else if (rest[i] === "--lang") entry.contentLanguage = rest[i + 1];
    else throw new Error("Unknown option " + rest[i]);
  }
  if (!id) throw new Error("Give a listing id or --file meta.json");
  return { [id]: entry };
}

const wanted = parseArgs(process.argv.slice(2));
let failed = false;
for (const [id, entry] of Object.entries(wanted)) {
  try {
    const meta = cleanListingMeta(entry);
    const updated = await store.updateListing(id, meta);
    if (!updated) throw new Error("listing not found");
    console.log("updated", id, JSON.stringify(meta));
  } catch (err) {
    failed = true;
    console.error("skipped", id + ":", err.message);
  }
}
process.exit(failed ? 1 : 0);
