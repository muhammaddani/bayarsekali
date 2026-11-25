// Judge mode: a demo AI agent that lives on the server and buys an API
// product through the real x402 flow when a visitor presses a button,
// so anyone can watch an agent pay on chain without installing a wallet
// or claiming devnet USDC first.
//
// The demo agent spends its own devnet USDC under hard limits:
// a per purchase cap, a daily budget (counted from the recorded demo
// runs, so it survives restarts), an optional seller allowlist, and one
// run at a time. Visitors are also rate limited by the route.
import { payForResource } from "./x402-client.mjs";
import { atomicToUsdc, createSpendGuard } from "./spend-guard.mjs";
import { USDC_MINT, X402_NETWORK, usdcToAtomic } from "./x402.js";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";

export class DemoRefusal extends Error {}

const today = () => new Date().toISOString().slice(0, 10);

export function createDemoAgent({
  keypair,
  connection,
  store,
  resourceBase,
  // What visitors see in the step log instead of the loopback address.
  displayBase = resourceBase,
  maxPerPurchaseUsdc = "0.05",
  dailyBudgetUsdc = "1",
  allowedSellers = [],
  pay = payForResource,
}) {
  const dailyBudget = BigInt(usdcToAtomic(String(dailyBudgetUsdc)) || "0");
  const sellers = allowedSellers.filter(Boolean);
  let busy = false;

  async function spentTodayAtomic() {
    const runs = await store.listDemoRuns();
    return runs
      .filter((r) => String(r.createdAt).startsWith(today()))
      .reduce((sum, r) => sum + BigInt(r.amountAtomic), 0n);
  }

  async function status() {
    const remaining = dailyBudget - (await spentTodayAtomic());
    let usdcBalance = null;
    try {
      const ata = getAssociatedTokenAddressSync(new PublicKey(USDC_MINT), keypair.publicKey);
      const info = await connection.getTokenAccountBalance(ata);
      usdcBalance = info.value.uiAmountString;
    } catch {
      usdcBalance = "0";
    }
    return {
      enabled: true,
      wallet: keypair.publicKey.toBase58(),
      usdcBalance,
      maxPerPurchaseUsdc: atomicToUsdc(BigInt(usdcToAtomic(String(maxPerPurchaseUsdc)))),
      dailyBudgetUsdc: atomicToUsdc(dailyBudget),
      remainingTodayUsdc: atomicToUsdc(remaining > 0n ? remaining : 0n),
      allowedSellers: sellers,
      busy,
    };
  }

  // Buy one API listing. emit(event) receives progress events:
  //   { type: "step", step, message }
  // Resolves with the result, or throws DemoRefusal (a limit said no)
  // or another Error (the purchase failed).
  async function run(listingId, emit = () => {}) {
    if (busy) throw new DemoRefusal("The demo agent is busy with another visitor. Try again in a few seconds.");
    busy = true;
    try {
      const remaining = dailyBudget - (await spentTodayAtomic());
      if (remaining <= 0n) {
        throw new DemoRefusal("The demo agent has spent today's budget. Try again tomorrow, or run your own agent with the MCP server.");
      }
      const guard = createSpendGuard({
        budgetUsdc: atomicToUsdc(remaining),
        maxPerPurchaseUsdc,
        network: X402_NETWORK,
        asset: USDC_MINT,
        allowedSellers: sellers,
      });

      let ticket = null;
      let sent = false;
      let result;
      try {
        result = await pay({
          resourceUrl: `${resourceBase}/api/resource/${encodeURIComponent(listingId)}`,
          keypair,
          connection,
          log: (step, message) =>
            emit({ type: "step", step, message: message.split(resourceBase).join(displayBase) }),
          approve: async (requirements) => {
            try {
              ticket = guard.reserve(requirements);
            } catch (err) {
              throw new DemoRefusal(err.message.replace(/^refused: /, "The demo agent refused: "));
            }
            emit({
              type: "step",
              step: "limits",
              message: `${atomicToUsdc(BigInt(requirements.amount))} USDC is within limits: max ${guard.status().maxPerPurchaseUsdc} per purchase, ${guard.status().remainingUsdc} left today after this`,
            });
          },
          onSend: () => {
            sent = true;
          },
        });
      } catch (err) {
        // A payment that left the process may have settled: count it.
        if (ticket && sent) {
          await store.insertDemoRun({
            listingId,
            amountAtomic: ticket.amount.toString(),
            signature: null,
            outcome: "unknown",
            createdAt: new Date().toISOString(),
          });
        }
        throw err;
      }

      if (!result.paid) {
        return { paid: false, content: result.data };
      }
      const signature = (result.receipt && result.receipt.transaction) || null;
      await store.insertDemoRun({
        listingId,
        amountAtomic: ticket.amount.toString(),
        signature,
        outcome: "settled",
        createdAt: new Date().toISOString(),
      });
      const body = result.data;
      return {
        paid: true,
        amountUsdc: atomicToUsdc(ticket.amount),
        transaction: signature,
        explorer: signature ? `https://explorer.solana.com/tx/${signature}?cluster=devnet` : null,
        content: body && body.data !== undefined ? body.data : body,
      };
    } finally {
      busy = false;
    }
  }

  return { run, status };
}
