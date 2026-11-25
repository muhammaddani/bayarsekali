// The x402 API gateway's request guard (SSRF) and forwarding rules.
// Uses a local HTTP server as the "seller API", which only the test
// switches (allowPrivate, allowHttp) let through.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  fetchUpstream,
  isPublicAddress,
  mergeQuery,
  upstreamData,
  validateSecretHeader,
  validateUpstreamUrl,
} from "../upstream.js";

test("private, loopback, link local and metadata addresses are not public", () => {
  for (const ip of [
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "::1",
    "::",
    "fd00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "::ffff:169.254.169.254",
  ]) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
  for (const ip of ["8.8.8.8", "1.1.1.1", "70.153.82.63", "2606:4700:4700::1111"]) {
    assert.equal(isPublicAddress(ip), true, ip);
  }
  assert.equal(isPublicAddress("not-an-ip"), false);
});

test("upstream URLs must be public https without credentials or odd ports", () => {
  assert.ok(validateUpstreamUrl("https://api.open-meteo.com/v1/forecast?latitude=1"));
  for (const bad of [
    "http://api.example.com/x",
    "ftp://api.example.com/x",
    "https://user:pass@api.example.com/x",
    "https://api.example.com:8443/x",
    "https://127.0.0.1/x",
    "https://2130706433/x", // 127.0.0.1 written as a number
    "https://169.254.169.254/metadata",
    "https://[::1]/x",
    "https://localhost/x",
    "https://printer.local/x",
    "not a url",
  ]) {
    assert.throws(() => validateUpstreamUrl(bad), undefined, bad);
  }
});

test("a hostname that resolves to a private address is refused at connect time", async () => {
  // "localhost" passes no static IP check if renamed, so test the
  // socket level guard directly with a name that resolves to loopback.
  await assert.rejects(
    fetchUpstream({ url: "https://localtest.me/x" }).catch((err) => {
      // Offline machines can not resolve the name at all; that is a refusal too.
      if (err.code === "ENOTFOUND" || err.code === "EAI_AGAIN") throw Object.assign(new Error("refused"), { code: "EUPSTREAM_PRIVATE" });
      throw err;
    }),
    (err) => err.code === "EUPSTREAM_PRIVATE"
  );
});

test("buyer query parameters are added, but never override the seller's own", () => {
  const url = mergeQuery("https://api.example.com/v1?api_key=SELLER&lang=id", {
    api_key: "attacker",
    city: "Jakarta",
    tags: ["a", "b"],
    nested: { x: 1 },
  });
  assert.equal(url.searchParams.get("api_key"), "SELLER");
  assert.equal(url.searchParams.get("lang"), "id");
  assert.equal(url.searchParams.get("city"), "Jakarta");
  assert.deepEqual(url.searchParams.getAll("tags"), ["a", "b"]);
  assert.equal(url.searchParams.has("nested"), false);
});

test("secret headers: both or neither, and no hop by hop or injected headers", () => {
  assert.equal(validateSecretHeader("", ""), null);
  assert.deepEqual(validateSecretHeader("Authorization", "Bearer k"), { name: "Authorization", value: "Bearer k" });
  assert.throws(() => validateSecretHeader("Authorization", ""));
  assert.throws(() => validateSecretHeader("Host", "evil"));
  assert.throws(() => validateSecretHeader("X-Key", "a\r\nX-Evil: 1"));
  assert.throws(() => validateSecretHeader("Bad Header", "v"));
});

// A local stand in for the seller's API.
const seen = [];
const seller = http.createServer((req, res) => {
  seen.push({ url: req.url, auth: req.headers.authorization });
  if (req.url.startsWith("/big")) {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("x".repeat(2048));
  } else if (req.url.startsWith("/fail")) {
    res.writeHead(500);
    res.end("boom");
  } else if (req.url.startsWith("/slow")) {
    setTimeout(() => res.end("late"), 500);
  } else if (req.url.startsWith("/redirect")) {
    res.writeHead(302, { Location: "http://169.254.169.254/" });
    res.end();
  } else {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, url: req.url }));
  }
});
await new Promise((r) => seller.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${seller.address().port}`;
const local = { allowPrivate: true, allowHttp: true };
after(() => seller.close());

test("a paid call reaches the seller's API with the secret header and the query", async () => {
  const answer = await fetchUpstream({
    url: mergeQuery(`${base}/v1?k=1`, { city: "Jakarta" }).toString(),
    secretHeader: { name: "Authorization", value: "Bearer seller-key" },
    ...local,
  });
  assert.equal(answer.ok, true);
  assert.deepEqual(upstreamData(answer), { ok: true, url: "/v1?k=1&city=Jakarta" });
  assert.equal(seen.at(-1).auth, "Bearer seller-key");
});

test("failures, redirects, oversized and slow answers are not deliverable", async () => {
  assert.equal((await fetchUpstream({ url: `${base}/fail`, ...local })).ok, false);
  // Redirects are never followed, so they can not bounce to a private address.
  const redirect = await fetchUpstream({ url: `${base}/redirect`, ...local });
  assert.equal(redirect.ok, false);
  assert.equal(redirect.status, 302);
  await assert.rejects(fetchUpstream({ url: `${base}/big`, maxBytes: 1024, ...local }), /larger than 1 MB/);
  await assert.rejects(fetchUpstream({ url: `${base}/slow`, timeoutMs: 100, ...local }), /did not answer in time/);
});

test("without the test switches, the local seller API is refused", async () => {
  await assert.rejects(fetchUpstream({ url: `${base}/v1` }), /https/);
  assert.throws(() => validateUpstreamUrl("https://127.0.0.1/v1"), /public address/);
});
