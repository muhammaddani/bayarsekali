// Agent discovery (/.well-known/x402, /llms.txt) and the optional
// listing fields behind them. Pure functions, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildDiscoveryDocument,
  buildLlmsTxt,
  cleanListingMeta,
  languageName,
  metaOf,
} from "../discovery.js";

const ORIGIN = "https://bayarsekali.example";
const SELLER = "BW66pCspdPt8RH4bBGy8NGVSf2xMFNb3mr7FzWji8SML";
const listings = [
  {
    id: "old-api",
    type: "api",
    title: "Kalender Konten UMKM",
    summaryEn: "A 30 day content calendar for small businesses.",
    contentLanguage: "id",
    priceUsdc: "0.05",
    sellerWallet: SELLER,
    mode: "static",
    resourceContent: "SECRET CONTENT",
    createdAt: "2026-11-01T00:00:00.000Z",
  },
  {
    id: "new-api",
    type: "api",
    title: "Indonesia earthquakes",
    priceUsdc: "0.01",
    sellerWallet: SELLER,
    mode: "proxy",
    upstreamUrl: "https://seller.example/private",
    secretHeader: { name: "X-Api-Key", value: "SECRET KEY" },
    resourceDescription: "Live BMKG data",
    createdAt: "2026-11-02T00:00:00.000Z",
  },
  {
    id: "a-file",
    title: "Panduan Kreator",
    priceSol: 0.01,
    sellerWallet: SELLER,
    fileName: "secret-name.pdf",
    createdAt: "2026-11-03T00:00:00.000Z",
  },
];

test("listing meta: summary is trimmed and capped, language must be a code", () => {
  assert.deepEqual(cleanListingMeta({}), {});
  assert.deepEqual(cleanListingMeta({ summaryEn: "  ", contentLanguage: "" }), {});
  assert.deepEqual(cleanListingMeta({ summaryEn: " Two\n lines ", contentLanguage: "id" }), {
    summaryEn: "Two lines",
    contentLanguage: "id",
  });
  assert.deepEqual(cleanListingMeta({ contentLanguage: "pt-BR" }), { contentLanguage: "pt-BR" });
  assert.throws(() => cleanListingMeta({ summaryEn: "x".repeat(201) }), /at most 200/);
  assert.throws(() => cleanListingMeta({ contentLanguage: "Indonesian" }), /language code/);
  assert.throws(() => cleanListingMeta({ contentLanguage: "<script>" }), /language code/);
  assert.throws(() => cleanListingMeta({ summaryEn: { a: 1 } }), /text/);
});

test("metaOf and languageName", () => {
  assert.deepEqual(metaOf({}), { summaryEn: "", contentLanguage: "" });
  assert.equal(languageName("id"), "Bahasa Indonesia");
  assert.equal(languageName("en-GB"), "English");
  assert.equal(languageName("fr"), "fr");
  assert.equal(languageName(""), "");
});

test("discovery lists API resources only, newest first, with their 402 requirements", async () => {
  const seen = [];
  const doc = await buildDiscoveryDocument({
    listings,
    origin: ORIGIN,
    requirementsFor: async (l, url) => {
      seen.push(url);
      return { scheme: "exact", amount: l.priceUsdc, payTo: l.sellerWallet };
    },
  });
  assert.equal(doc.x402Version, 2);
  assert.deepEqual(
    doc.items.map((i) => i.resource),
    [ORIGIN + "/api/resource/new-api", ORIGIN + "/api/resource/old-api"]
  );
  assert.deepEqual(seen, doc.items.map((i) => i.resource));
  assert.equal(doc.pagination.total, 2);
  const [proxy, fixed] = doc.items;
  assert.equal(proxy.type, "http");
  assert.equal(proxy.accepts[0].scheme, "exact");
  assert.match(proxy.metadata.delivery, /only on a successful answer/);
  assert.equal(fixed.metadata.summaryEn, "A 30 day content calendar for small businesses.");
  assert.equal(fixed.metadata.contentLanguage, "id");
  // Nothing private leaves the server.
  const text = JSON.stringify(doc);
  for (const secret of ["SECRET CONTENT", "SECRET KEY", "seller.example/private", "secret-name.pdf"]) {
    assert.equal(text.includes(secret), false, secret);
  }
});

test("llms.txt explains how to pay and lists both doors without secrets", () => {
  const text = buildLlmsTxt({ listings, origin: ORIGIN });
  assert.match(text, /^# BayarSekali/);
  assert.match(text, /HTTP 402/);
  assert.match(text, /X-PAYMENT/);
  assert.ok(text.includes(ORIGIN + "/.well-known/x402"));
  assert.ok(text.includes(ORIGIN + "/api/resource/new-api"));
  assert.match(text, /Kalender Konten UMKM\]\([^)]+\): A 30 day content calendar for small businesses \(content in Bahasa Indonesia\)/);
  assert.match(text, /live seller API/);
  assert.match(text, /Panduan Kreator.*0\.01 SOL/);
  for (const secret of ["SECRET CONTENT", "SECRET KEY", "seller.example/private", "secret-name.pdf"]) {
    assert.equal(text.includes(secret), false, secret);
  }
});

test("llms.txt with an empty catalog", () => {
  const text = buildLlmsTxt({ listings: [], origin: ORIGIN });
  assert.equal(text.match(/None listed yet\./g).length, 2);
});
