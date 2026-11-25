// The sample seller API (BMKG earthquakes in English) that a gateway
// listing wraps: its key check, translation and caching. BMKG itself is
// a stub here: no network.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { buildQuakeAnswer, createSampleApi, normalizeQuake, translateLocation } from "../sample-api.js";

const SIGNIFICANT = {
  Infogempa: {
    gempa: [
      {
        Tanggal: "23 Nov 2026",
        Jam: "18:24:32 WIB",
        DateTime: "2026-11-23T11:24:32+00:00",
        Coordinates: "1.44,131.96",
        Magnitude: "5.3",
        Kedalaman: "10 km",
        Wilayah: "241 km TimurLaut RAJAAMPAT-PAPUABRTDY",
        Potensi: "Tidak berpotensi tsunami",
      },
      {
        Tanggal: "21 Nov 2026",
        Jam: "16:42:11 WIB",
        DateTime: "2026-11-21T09:42:11+00:00",
        Coordinates: "-7.88,127.51",
        Magnitude: "7.2",
        Kedalaman: "125 km",
        Wilayah: "43 km BaratLaut MALUKUBRTDAYA",
        Potensi: "Tidak berpotensi tsunami",
      },
    ],
  },
};
const FELT_ONE = {
  Infogempa: {
    gempa: {
      DateTime: "2026-11-22T07:54:39+00:00",
      Coordinates: "3.12,126.57",
      Magnitude: "5.4",
      Kedalaman: "10 km",
      Wilayah: "Pusat gempa berada di laut 98 km BaratDaya Melonguane",
      Dirasakan: "II - III Kota Padang, I - II Solok",
    },
  },
};

test("locations are translated to English, unknown shapes kept as they are", () => {
  assert.equal(translateLocation("241 km TimurLaut RAJAAMPAT-PAPUABRTDY"), "241 km northeast of RAJAAMPAT-PAPUABRTDY");
  assert.equal(
    translateLocation("Pusat gempa berada di laut 98 km BaratDaya Melonguane"),
    "At sea, 98 km southwest of Melonguane"
  );
  assert.equal(
    translateLocation("Pusat gempa berada di darat 12 km barat laut Kota Bandung"),
    "On land, 12 km northwest of Kota Bandung"
  );
  assert.equal(translateLocation("34 km Barat Pesisir Selatan"), "34 km west of Pesisir Selatan");
  assert.equal(translateLocation("Laut Banda"), "Laut Banda");
  assert.equal(translateLocation(""), "");
});

test("a BMKG record becomes typed English fields", () => {
  const q = normalizeQuake(SIGNIFICANT.Infogempa.gempa[1]);
  assert.equal(q.time, "2026-11-21T09:42:11.000Z");
  assert.equal(q.magnitude, 7.2);
  assert.equal(q.depthKm, 125);
  assert.equal(q.latitude, -7.88);
  assert.equal(q.longitude, 127.51);
  assert.equal(q.tsunamiPotential, false);
  assert.deepEqual(q.feltReports, []);
  const felt = normalizeQuake(FELT_ONE.Infogempa.gempa);
  assert.deepEqual(felt.feltReports, ["II - III Kota Padang", "I - II Solok"]);
  assert.equal(felt.tsunamiPotential, null);
  assert.equal(normalizeQuake({ Potensi: "Berpotensi tsunami" }).tsunamiPotential, true);
});

test("answers filter, limit, name the strongest quake and credit BMKG", () => {
  const a = buildQuakeAnswer({
    feed: "significant",
    rawRecords: SIGNIFICANT.Infogempa.gempa,
    minMagnitude: 6,
    limit: 15,
    fetchedAt: "t",
  });
  assert.equal(a.count, 1);
  assert.equal(a.strongest.magnitude, 7.2);
  assert.match(a.attribution, /BMKG/);
  const b = buildQuakeAnswer({ feed: "significant", rawRecords: SIGNIFICANT.Infogempa.gempa, limit: 1, fetchedAt: "t" });
  assert.equal(b.count, 1);
  assert.equal(b.quakes[0].magnitude, 5.3);
});

// A real HTTP round trip through the router, with BMKG stubbed.
let calls = 0;
let clock = 1_000_000;
const stubFetch = async (url) => {
  calls++;
  const body = url.endsWith("gempadirasakan.json") ? FELT_ONE : SIGNIFICANT;
  return { ok: true, status: 200, json: async () => body };
};
const app = express();
app.use("/sample-api", createSampleApi({ apiKey: "k-123", fetchImpl: stubFetch, now: () => clock }));
const server = app.listen(0);
after(() => server.close());
const base = () => `http://127.0.0.1:${server.address().port}/sample-api`;

test("the sample API refuses calls without its key", async () => {
  for (const headers of [{}, { "X-Api-Key": "wrong" }, { "X-Api-Key": "k-1234" }]) {
    const r = await fetch(base() + "/indonesia/earthquakes", { headers });
    assert.equal(r.status, 401);
  }
  assert.equal(calls, 0);
});

test("the sample API serves, validates and caches", async () => {
  const headers = { "X-Api-Key": "k-123" };
  let r = await fetch(base() + "/indonesia/earthquakes?limit=1", { headers });
  assert.equal(r.status, 200);
  let body = await r.json();
  assert.equal(body.feed, "significant");
  assert.equal(body.quakes.length, 1);
  assert.equal(calls, 1);

  r = await fetch(base() + "/indonesia/earthquakes", { headers });
  assert.equal((await r.json()).count, 2);
  assert.equal(calls, 1, "served from cache");

  clock += 61_000;
  await fetch(base() + "/indonesia/earthquakes", { headers });
  assert.equal(calls, 2, "cache expired after a minute");

  r = await fetch(base() + "/indonesia/earthquakes?feed=felt", { headers });
  body = await r.json();
  assert.equal(body.feed, "felt");
  assert.equal(body.quakes[0].location, "At sea, 98 km southwest of Melonguane");

  for (const q of ["feed=all", "limit=0", "limit=99", "limit=1.5", "min_magnitude=abc", "min_magnitude=11"]) {
    r = await fetch(base() + "/indonesia/earthquakes?" + q, { headers });
    assert.equal(r.status, 400, q);
  }
  r = await fetch(base() + "/nope", { headers });
  assert.equal(r.status, 404);
});

test("a BMKG failure is a non 2xx answer, so the gateway does not charge", async () => {
  const failing = express();
  failing.use(
    "/s",
    createSampleApi({ apiKey: "k", fetchImpl: async () => ({ ok: false, status: 503 }) })
  );
  const srv = failing.listen(0);
  try {
    const r = await fetch(`http://127.0.0.1:${srv.address().port}/s/indonesia/earthquakes`, {
      headers: { "X-Api-Key": "k" },
    });
    assert.equal(r.status, 502);
  } finally {
    srv.close();
  }
});
