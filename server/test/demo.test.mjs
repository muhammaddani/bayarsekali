// Judge mode demo agent: limits hold before anything is signed, the
// daily budget is counted from recorded runs, and one run at a time.
// The payment itself is a stub: no network, no keys.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { Keypair } from "@solana/web3.js";

process.env.DATA_DIR = mkdtempSync(path.join(os.tmpdir(), "bayarsekali-demo-"));
let store, createDemoAgent, DemoRefusal, USDC_MINT, X402_NETWORK;
before(async () => {
  ({ store } = await import("../store.js"));
  ({ createDemoAgent, DemoRefusal } = await import("../demo.js"));
  ({ USDC_MINT, X402_NETWORK } = await import("../x402.js"));
});

const SELLER = "BW66pCspdPt8RH4bBGy8NGVSf2xMFNb3mr7FzWji8SML";
const connection = {
  getTokenAccountBalance: async () => ({ value: { uiAmountString: "1" } }),
};

// A stub of payForResource: the server asks `amount` atomic USDC; the
// stub runs approve, then (optionally) "sends" and settles or fails.
function stubPay({ amount, payTo = SELLER, failAfterSend = false, delayMs = 0 }) {
  return async ({ approve, onSend, log }) => {
    log("step 1/4", "402");
    await approve({ network: X402_NETWORK, asset: USDC_MINT, payTo, amount: String(amount) });
    onSend();
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    if (failAfterSend) throw new Error("answer lost");
    return { paid: true, data: { data: { ok: true } }, receipt: { transaction: "sig-" + Math.random() } };
  };
}

function agent(pay, over = {}) {
  return createDemoAgent({
    keypair: Keypair.generate(),
    connection,
    store,
    resourceBase: "http://127.0.0.1:1",
    maxPerPurchaseUsdc: "0.05",
    dailyBudgetUsdc: "0.1",
    pay,
    ...over,
  });
}

test("a purchase within limits settles, is recorded, and lowers today's budget", async () => {
  const events = [];
  const a = agent(stubPay({ amount: 50000 }));
  const result = await a.run("l1", (e) => events.push(e));
  assert.equal(result.paid, true);
  assert.equal(result.amountUsdc, "0.05");
  assert.match(result.explorer, /cluster=devnet/);
  assert.deepEqual(result.content, { ok: true });
  assert.ok(events.some((e) => e.step === "limits"));
  assert.equal((await a.status()).remainingTodayUsdc, "0.05");
});

test("over the per purchase cap is refused before signing and costs nothing", async () => {
  let sent = false;
  const pay = async ({ approve, onSend }) => {
    await approve({ network: X402_NETWORK, asset: USDC_MINT, payTo: SELLER, amount: "60000" });
    onSend();
    sent = true;
  };
  const before = (await store.listDemoRuns()).length;
  await assert.rejects(agent(pay).run("l1"), (err) => err instanceof DemoRefusal && /per purchase limit/.test(err.message));
  assert.equal(sent, false);
  assert.equal((await store.listDemoRuns()).length, before);
});

test("the daily budget, counted from recorded runs, stops the agent", async () => {
  // 0.05 already spent today by the first test; one more 0.05 fits, then none.
  const a = agent(stubPay({ amount: 50000 }));
  await a.run("l1");
  await assert.rejects(a.run("l1"), (err) => err instanceof DemoRefusal && /today's budget/.test(err.message));
});

test("a payment that left but lost its answer still counts against the budget", async () => {
  const a = agent(stubPay({ amount: 10000, failAfterSend: true }), { dailyBudgetUsdc: "10" });
  const before = (await store.listDemoRuns()).length;
  await assert.rejects(a.run("l1"), /answer lost/);
  const runs = await store.listDemoRuns();
  assert.equal(runs.length, before + 1);
  assert.equal(runs.at(-1).outcome, "unknown");
});

test("one run at a time", async () => {
  const a = agent(stubPay({ amount: 10000, delayMs: 50 }), { dailyBudgetUsdc: "10" });
  const results = await Promise.allSettled([a.run("l1"), a.run("l1")]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.ok(results.some((r) => r.status === "rejected" && r.reason instanceof DemoRefusal));
});

test("a seller off the allowlist is refused", async () => {
  const a = agent(stubPay({ amount: 10000, payTo: "11111111111111111111111111111111" }), {
    dailyBudgetUsdc: "10",
    allowedSellers: [SELLER],
  });
  await assert.rejects(a.run("l1"), (err) => err instanceof DemoRefusal && /allowlist/.test(err.message));
});
