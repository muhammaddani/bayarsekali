// How agents find what is for sale without a human in the loop, and the
// listing fields that make a catalog readable for global buyers.
//
// - /.well-known/x402 lists every paid x402 resource with its payment
//   requirements, in the shape of an x402 discovery list, so a client
//   can price a resource before it ever asks for it.
// - /llms.txt explains the marketplace and how to pay, in plain text
//   for language model agents.
import { X402_VERSION } from "./x402.js";

const LANGUAGE_CODE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/;
export const SUMMARY_MAX = 200;

// Optional listing fields: a one line English summary (so a buyer who
// does not read the content's language still knows what it is) and the
// language the content itself is written in. Returns only the fields
// that were given; throws with a reason a seller can act on.
export function cleanListingMeta({ summaryEn, contentLanguage } = {}) {
  const meta = {};
  if (summaryEn !== undefined && summaryEn !== null && String(summaryEn).trim() !== "") {
    if (typeof summaryEn !== "string") throw new Error("summaryEn must be text.");
    const clean = summaryEn.replace(/\s+/g, " ").trim();
    if (clean.length > SUMMARY_MAX) {
      throw new Error(`The English summary can be at most ${SUMMARY_MAX} characters.`);
    }
    meta.summaryEn = clean;
  }
  if (contentLanguage !== undefined && contentLanguage !== null && String(contentLanguage).trim() !== "") {
    const code = String(contentLanguage).trim();
    if (!LANGUAGE_CODE.test(code)) {
      throw new Error("contentLanguage must be a language code such as en or id.");
    }
    meta.contentLanguage = code;
  }
  return meta;
}

// The display fields shared by every public view of a listing.
export function metaOf(listing) {
  return {
    summaryEn: listing.summaryEn || "",
    contentLanguage: listing.contentLanguage || "",
  };
}

const LANGUAGE_NAMES = { en: "English", id: "Bahasa Indonesia" };
export function languageName(code) {
  if (!code) return "";
  return LANGUAGE_NAMES[code] || LANGUAGE_NAMES[code.split("-")[0]] || code;
}

function apiListings(listings) {
  return listings
    .filter((l) => l.type === "api")
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

// requirementsFor(listing, resourceUrl) resolves the same payment
// requirements the resource itself answers with in its 402.
export async function buildDiscoveryDocument({ listings, origin, requirementsFor }) {
  const items = [];
  for (const l of apiListings(listings)) {
    const resource = origin + "/api/resource/" + l.id;
    items.push({
      resource,
      type: "http",
      x402Version: X402_VERSION,
      accepts: [await requirementsFor(l, resource)],
      lastUpdated: l.createdAt,
      metadata: {
        title: l.title,
        description: l.resourceDescription || "",
        ...metaOf(l),
        delivery: l.mode === "proxy" ? "live seller API, charged only on a successful answer" : "fixed content",
        mimeType: "application/json",
        priceUsdc: l.priceUsdc,
        listingPage: origin + "/listing/" + l.id,
        sellerDashboard: origin + "/seller/" + l.sellerWallet,
      },
    });
  }
  return {
    x402Version: X402_VERSION,
    items,
    pagination: { limit: items.length, offset: 0, total: items.length },
  };
}

export function buildLlmsTxt({ listings, origin }) {
  const api = apiListings(listings);
  const files = listings.filter((l) => l.type !== "api");
  const line = (l) => {
    let text = `- [${l.title}](${origin}/listing/${l.id})`;
    if (l.summaryEn) text += ": " + l.summaryEn.replace(/\.$/, "");
    if (l.contentLanguage && !/^en\b/.test(l.contentLanguage)) {
      text += ` (content in ${languageName(l.contentLanguage)})`;
    }
    return text;
  };
  const out = [
    "# BayarSekali",
    "",
    "> The paywall AI agents can pay. Data, APIs and digital products sold per use in USDC on Solana through x402. This deployment runs on Solana devnet with test funds that have no real value.",
    "",
    "## How an agent buys",
    "",
    `1. GET a resource URL below. Without payment it answers HTTP 402 with x402 v${X402_VERSION} payment requirements (scheme exact, network Solana devnet, asset USDC, price, payTo, fee payer).`,
    "2. Build and sign a USDC TransferChecked transaction to payTo for that amount, in the x402 SVM exact layout, and retry the same request with it in the X-PAYMENT header.",
    "3. The server verifies and settles through the x402 facilitator and returns the content in the same response, with the settlement receipt in X-PAYMENT-RESPONSE. One payment buys one delivery.",
    "",
    "Machine readable catalog with payment requirements: " + origin + "/.well-known/x402",
    "MCP server for Claude, Cursor and other MCP clients: https://github.com/muhammaddani/bayarsekali#the-agent-door-as-an-mcp-server",
    "Buyer library: https://github.com/muhammaddani/bayarsekali/blob/main/server/x402-client.mjs",
    "",
    "## Paid API resources (x402, USDC per call)",
    "",
  ];
  if (!api.length) out.push("None listed yet.");
  for (const l of api) {
    out.push(
      `${line(l)}. ${l.priceUsdc} USDC per call${l.mode === "proxy" ? ", live seller API" : ""}. Resource: ${origin}/api/resource/${l.id}`
    );
  }
  out.push("", "## Files for people (SOL, browser wallet checkout, not buyable by agents)", "");
  if (!files.length) out.push("None listed yet.");
  for (const l of files) out.push(`${line(l)}. ${l.priceSol} SOL`);
  out.push("");
  return out.join("\n");
}
