// A sample seller API for the x402 gateway: Indonesian earthquake data
// from BMKG (Badan Meteorologi, Klimatologi, dan Geofisika), Indonesia's
// meteorology and geophysics agency, normalized to English JSON.
//
// It plays the part of "an API a seller already runs". It is protected
// by its own API key, which the seller stores as the gateway listing's
// secret header, so the only way to call it without the key is to pay
// through BayarSekali. Mounted only when SAMPLE_API_KEY is set.
//
// Data source: https://data.bmkg.go.id (open data, attribution required).
import express from "express";
import { timingSafeEqual, createHash } from "node:crypto";

const BMKG_BASE = "https://data.bmkg.go.id/DataMKG/TEWS/";
export const FEEDS = {
  // The latest 15 earthquakes of magnitude 5.0 or more.
  significant: "gempaterkini.json",
  // The latest 15 earthquakes people reported feeling.
  felt: "gempadirasakan.json",
};
const CACHE_MS = 60_000;
export const ATTRIBUTION =
  "Source: BMKG (Badan Meteorologi, Klimatologi, dan Geofisika), https://data.bmkg.go.id";

// BMKG writes compass directions in Indonesian, sometimes as one word
// ("BaratDaya") and sometimes as two ("barat daya"). Longest first, so
// "Barat Daya" is not read as "Barat".
const DIRECTIONS = [
  [/timur\s*laut/gi, "northeast"],
  [/barat\s*laut/gi, "northwest"],
  [/barat\s*daya/gi, "southwest"],
  [/tenggara/gi, "southeast"],
  [/utara/gi, "north"],
  [/selatan/gi, "south"],
  [/timur/gi, "east"],
  [/barat/gi, "west"],
];

// "Pusat gempa berada di laut 98 km BaratDaya Melonguane"
//   -> "At sea, 98 km southwest of Melonguane"
// "241 km TimurLaut RAJAAMPAT-PAPUABRTDY"
//   -> "241 km northeast of RAJAAMPAT-PAPUABRTDY"
export function translateLocation(text) {
  let rest = String(text || "").trim();
  let prefix = "";
  const where = /^pusat gempa berada di (laut|darat)\s*/i.exec(rest);
  if (where) {
    prefix = where[1].toLowerCase() === "laut" ? "At sea, " : "On land, ";
    rest = rest.slice(where[0].length);
  }
  const m =
    /^(\d+(?:[.,]\d+)?)\s*km\s+(timur\s*laut|barat\s*laut|barat\s*daya|tenggara|utara|selatan|timur|barat)\s+(\S.*)$/i.exec(
      rest
    );
  if (!m) return prefix + rest;
  let direction = m[2];
  for (const [pattern, english] of DIRECTIONS) direction = direction.replace(pattern, english);
  return `${prefix}${m[1].replace(",", ".")} km ${direction.toLowerCase()} of ${m[3]}`;
}

function toNumber(value) {
  const n = Number(String(value ?? "").replace(",", ".").replace(/[^\d.+-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

// One BMKG record -> one English record.
export function normalizeQuake(raw) {
  const [lat, lon] = String(raw.Coordinates || "").split(",").map(toNumber);
  const potential = String(raw.Potensi || "").trim();
  let tsunamiPotential = null;
  if (/^tidak berpotensi tsunami/i.test(potential)) tsunamiPotential = false;
  else if (/berpotensi tsunami/i.test(potential)) tsunamiPotential = true;
  const felt = String(raw.Dirasakan || "").trim();
  return {
    time: raw.DateTime ? new Date(raw.DateTime).toISOString() : null,
    localTime: [raw.Tanggal, raw.Jam].filter(Boolean).join(" ") || null,
    magnitude: toNumber(raw.Magnitude),
    depthKm: toNumber(raw.Kedalaman),
    latitude: lat ?? null,
    longitude: lon ?? null,
    location: translateLocation(raw.Wilayah),
    locationOriginal: raw.Wilayah || null,
    tsunamiPotential,
    // Modified Mercalli intensity by place, as BMKG reports it,
    // for example "II - III Kota Padang".
    feltReports: felt && felt !== "-" ? felt.split(/,\s*/) : [],
  };
}

// The whole answer for one request.
export function buildQuakeAnswer({ feed, rawRecords, minMagnitude = null, limit = 15, fetchedAt }) {
  const quakes = rawRecords
    .map(normalizeQuake)
    .filter((q) => minMagnitude === null || (q.magnitude !== null && q.magnitude >= minMagnitude))
    .slice(0, limit);
  const strongest = quakes.reduce(
    (best, q) => (q.magnitude !== null && (!best || q.magnitude > best.magnitude) ? q : best),
    null
  );
  return {
    feed,
    description:
      feed === "felt"
        ? "Latest earthquakes in Indonesia that people reported feeling, with intensity by place."
        : "Latest earthquakes in Indonesia of magnitude 5.0 or more.",
    count: quakes.length,
    strongest: strongest
      ? { magnitude: strongest.magnitude, location: strongest.location, time: strongest.time }
      : null,
    quakes,
    fetchedAt,
    attribution: ATTRIBUTION,
  };
}

function sameSecret(a, b) {
  // Hash both sides so the comparison is constant time whatever the lengths.
  const ha = createHash("sha256").update(String(a)).digest();
  const hb = createHash("sha256").update(String(b)).digest();
  return timingSafeEqual(ha, hb);
}

export function createSampleApi({ apiKey, fetchImpl = fetch, now = () => Date.now() }) {
  if (!apiKey) throw new Error("createSampleApi needs an apiKey.");
  const router = express.Router();
  const cache = new Map();

  async function loadFeed(feed) {
    const hit = cache.get(feed);
    if (hit && now() - hit.at < CACHE_MS) return hit;
    const resp = await fetchImpl(BMKG_BASE + FEEDS[feed], {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8_000),
    });
    if (!resp.ok) throw new Error("BMKG answered HTTP " + resp.status);
    const body = await resp.json();
    const list = body && body.Infogempa && body.Infogempa.gempa;
    const records = Array.isArray(list) ? list : list ? [list] : [];
    const entry = { at: now(), records, fetchedAt: new Date(now()).toISOString() };
    cache.set(feed, entry);
    return entry;
  }

  router.use((req, res, next) => {
    const given = req.get("x-api-key");
    if (!given || !sameSecret(given, apiKey)) {
      return res.status(401).json({
        error: "Missing or wrong X-Api-Key. Buy access through BayarSekali instead.",
      });
    }
    return next();
  });

  // GET /indonesia/earthquakes?feed=significant|felt&min_magnitude=5&limit=5
  router.get("/indonesia/earthquakes", async (req, res) => {
    const feed = String(req.query.feed || "significant");
    if (!FEEDS[feed]) {
      return res.status(400).json({ error: "feed must be 'significant' or 'felt'." });
    }
    let minMagnitude = null;
    if (req.query.min_magnitude !== undefined) {
      minMagnitude = Number(req.query.min_magnitude);
      if (!Number.isFinite(minMagnitude) || minMagnitude < 0 || minMagnitude > 10) {
        return res.status(400).json({ error: "min_magnitude must be a number from 0 to 10." });
      }
    }
    let limit = 15;
    if (req.query.limit !== undefined) {
      limit = Number(req.query.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 15) {
        return res.status(400).json({ error: "limit must be a whole number from 1 to 15." });
      }
    }
    try {
      const { records, fetchedAt } = await loadFeed(feed);
      res.set("Cache-Control", "no-store");
      return res.json(buildQuakeAnswer({ feed, rawRecords: records, minMagnitude, limit, fetchedAt }));
    } catch (err) {
      console.error("sample api: BMKG fetch failed:", err.message);
      // A non 2xx answer: the gateway then refuses to settle, so the
      // buyer is not charged.
      return res.status(502).json({ error: "BMKG data is unavailable right now." });
    }
  });

  router.use((_req, res) => res.status(404).json({ error: "Not found." }));
  return router;
}
