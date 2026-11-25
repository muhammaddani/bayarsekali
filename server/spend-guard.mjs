// Spending guardrails for an autonomous buyer agent. Every payment is
// checked against the server's own 402 requirements before anything is
// signed: the right network and asset, a per purchase cap, a total
// budget, and an optional seller allowlist. Amounts are kept as atomic
// integers (BigInt), never floats.
import { USDC_DECIMALS, usdcToAtomic } from "./x402.js";

export function atomicToUsdc(atomic) {
  const value = BigInt(atomic);
  const unit = 10n ** BigInt(USDC_DECIMALS);
  const whole = value / unit;
  const frac = (value % unit).toString().padStart(USDC_DECIMALS, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

function toAtomic(usdc, name) {
  const atomic = usdcToAtomic(String(usdc));
  if (atomic === null) throw new Error(`${name} must be a positive USDC amount, got "${usdc}"`);
  return BigInt(atomic);
}

export function createSpendGuard({
  budgetUsdc,
  maxPerPurchaseUsdc,
  network,
  asset,
  allowedSellers = [],
}) {
  const budget = toAtomic(budgetUsdc, "budget");
  const maxPerPurchase = toAtomic(maxPerPurchaseUsdc, "max per purchase");
  const allowed = new Set(allowedSellers.filter(Boolean));
  let spent = 0n;
  let reserved = 0n;
  const purchases = [];

  return {
    // Check a payment and hold its amount against the budget. Throws a
    // readable reason when the payment is refused. Returns a ticket for
    // commit or release.
    reserve(requirements) {
      if (requirements.network !== network) {
        throw new Error(`refused: payment network ${requirements.network} is not ${network}`);
      }
      if (requirements.asset !== asset) {
        throw new Error(`refused: payment asset ${requirements.asset} is not USDC`);
      }
      if (allowed.size && !allowed.has(requirements.payTo)) {
        throw new Error(`refused: seller ${requirements.payTo} is not on the allowlist`);
      }
      let amount;
      try {
        amount = BigInt(requirements.amount);
      } catch {
        throw new Error("refused: unreadable payment amount");
      }
      if (amount <= 0n) throw new Error("refused: payment amount must be positive");
      if (amount > maxPerPurchase) {
        throw new Error(
          `refused: price ${atomicToUsdc(amount)} USDC is above the per purchase limit of ${atomicToUsdc(maxPerPurchase)} USDC`
        );
      }
      if (spent + reserved + amount > budget) {
        throw new Error(
          `refused: price ${atomicToUsdc(amount)} USDC exceeds the remaining budget of ${atomicToUsdc(budget - spent - reserved)} USDC`
        );
      }
      reserved += amount;
      return { amount, payTo: requirements.payTo };
    },

    // The payment settled (or may have: it left the process).
    commit(ticket, details = {}) {
      reserved -= ticket.amount;
      spent += ticket.amount;
      purchases.push({
        amountUsdc: atomicToUsdc(ticket.amount),
        payTo: ticket.payTo,
        at: new Date().toISOString(),
        ...details,
      });
    },

    // The payment never left the process; give the amount back.
    release(ticket) {
      reserved -= ticket.amount;
    },

    status() {
      return {
        budgetUsdc: atomicToUsdc(budget),
        spentUsdc: atomicToUsdc(spent),
        remainingUsdc: atomicToUsdc(budget - spent - reserved),
        maxPerPurchaseUsdc: atomicToUsdc(maxPerPurchase),
        allowedSellers: [...allowed],
        purchases: purchases.slice(),
      };
    },
  };
}
