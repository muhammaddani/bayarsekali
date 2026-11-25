// The x402 API gateway: a seller lists an API they already run, and
// BayarSekali forwards each paid call to it. This module is the only
// place the server makes requests to seller supplied URLs, so it guards
// against server side request forgery:
//
// - https only, standard port only, no credentials in the URL;
// - every address a hostname resolves to must be public, checked inside
//   the socket's own DNS lookup, so a hostname that re-resolves to a
//   private or metadata address (DNS rebinding) is still refused;
// - redirects are not followed;
// - a timeout and a response size limit.
import https from "node:https";
import http from "node:http";
import dns from "node:dns";
import net from "node:net";

export const UPSTREAM_TIMEOUT_MS = 15_000;
export const UPSTREAM_MAX_BYTES = 1024 * 1024;

const blocked = new net.BlockList();
for (const [addr, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link local, including cloud metadata 169.254.169.254
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
]) {
  blocked.addSubnet(addr, prefix, "ipv4");
}
for (const [addr, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96],
  ["100::", 64],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
]) {
  blocked.addSubnet(addr, prefix, "ipv6");
}

// True when an IP address is publicly routable.
export function isPublicAddress(address) {
  const family = net.isIP(address);
  if (!family) return false;
  if (family === 6) {
    // IPv4 mapped IPv6 (::ffff:a.b.c.d) is judged as the IPv4 address.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    if (mapped) return isPublicAddress(mapped[1]);
    return !blocked.check(address, "ipv6");
  }
  return !blocked.check(address, "ipv4");
}

// Static checks of a seller supplied upstream URL. Returns the parsed
// URL or throws with a reason a seller can act on.
export function validateUpstreamUrl(value, { allowHttp = false, allowPrivate = false } = {}) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw new Error("The API URL is not a valid URL.");
  }
  if (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:")) {
    throw new Error("The API URL must use https.");
  }
  if (url.username || url.password) {
    throw new Error("Put credentials in the secret header, not in the URL.");
  }
  if (url.port && url.port !== "443" && !allowHttp) {
    throw new Error("The API URL must use the standard https port.");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (allowPrivate) return url;
  if (net.isIP(host) && !isPublicAddress(host)) {
    throw new Error("The API URL must point to a public address.");
  }
  if (/^localhost$|\.localhost$|\.local$|\.internal$/i.test(host)) {
    throw new Error("The API URL must point to a public address.");
  }
  return url;
}

const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
const FORBIDDEN_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
  "keep-alive",
  "proxy-authorization",
  "proxy-connection",
]);

// Validate the optional secret header a seller attaches to every
// forwarded call (for example their own API key). Returns null when no
// header is set.
export function validateSecretHeader(name, value) {
  const hasName = typeof name === "string" && name.trim() !== "";
  const hasValue = typeof value === "string" && value !== "";
  if (!hasName && !hasValue) return null;
  if (!hasName || !hasValue) throw new Error("Give both the secret header name and its value, or neither.");
  const clean = name.trim();
  if (!HEADER_NAME.test(clean) || FORBIDDEN_HEADERS.has(clean.toLowerCase())) {
    throw new Error("The secret header name is not allowed.");
  }
  if (/[\r\n\0]/.test(value) || value.length > 2048) {
    throw new Error("The secret header value is not allowed.");
  }
  return { name: clean, value };
}

// Add the buyer's query parameters to the upstream URL. Parameters the
// seller fixed in the upstream URL always win, so a buyer can never
// override, say, an api_key the seller put there.
export function mergeQuery(upstreamUrl, buyerQuery) {
  const url = new URL(String(upstreamUrl));
  for (const [key, raw] of Object.entries(buyerQuery || {})) {
    if (url.searchParams.has(key)) continue;
    const values = Array.isArray(raw) ? raw : [raw];
    for (const v of values) {
      if (typeof v === "string" || typeof v === "number") url.searchParams.append(key, String(v));
    }
  }
  return url;
}

// A DNS lookup that refuses non public answers, used by the socket
// itself, so the address checked is the address connected to.
function publicOnlyLookup(hostname, options, callback) {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err);
    const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: options.family }];
    const bad = list.find((a) => !isPublicAddress(a.address));
    if (bad || !list.length) {
      const refusal = new Error("The API host resolves to a non public address.");
      refusal.code = "EUPSTREAM_PRIVATE";
      return callback(refusal);
    }
    if (options.all) return callback(null, list);
    return callback(null, list[0].address, list[0].family);
  });
}

// Call the seller's API once. Resolves { ok, status, contentType, body }
// (body is a string) or rejects on network failure, timeout, size limit
// or a refused address. allowPrivate and allowHttp exist for tests only.
export async function fetchUpstream({
  url,
  secretHeader = null,
  timeoutMs = UPSTREAM_TIMEOUT_MS,
  maxBytes = UPSTREAM_MAX_BYTES,
  allowPrivate = false,
  allowHttp = false,
}) {
  const target = validateUpstreamUrl(url, { allowHttp, allowPrivate });
  const client = target.protocol === "http:" ? http : https;
  const headers = { Accept: "application/json, text/plain;q=0.9, */*;q=0.5", "User-Agent": "BayarSekali-x402-gateway/1.0" };
  if (secretHeader) headers[secretHeader.name] = secretHeader.value;

  return new Promise((resolve, reject) => {
    const req = client.request(
      target,
      {
        method: "GET",
        headers,
        agent: false,
        lookup: allowPrivate ? undefined : publicOnlyLookup,
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        let size = 0;
        let tooBig = false;
        res.on("data", (chunk) => {
          if (tooBig) return;
          size += chunk.length;
          if (size > maxBytes) {
            tooBig = true;
            reject(new Error("The API answer is larger than 1 MB."));
            req.destroy();
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          if (tooBig) return;
          const status = res.statusCode || 0;
          resolve({
            ok: status >= 200 && status < 300,
            status,
            contentType: String(res.headers["content-type"] || ""),
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
        res.on("error", reject);
      }
    );
    req.on("timeout", () => req.destroy(new Error("The API did not answer in time.")));
    req.on("error", reject);
    req.end();
  });
}

// Turn an upstream answer into the delivered data: parsed JSON when it
// is JSON, the text otherwise.
export function upstreamData({ contentType, body }) {
  if (/json/i.test(contentType)) {
    try {
      return JSON.parse(body);
    } catch {
      return body;
    }
  }
  return body;
}
