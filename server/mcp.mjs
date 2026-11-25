#!/usr/bin/env node
// BayarSekali MCP server: lets an AI agent (Claude Desktop, Claude Code,
// Cursor, any MCP client) browse the BayarSekali catalog and buy API
// access by itself through x402, paying devnet USDC from its own wallet,
// inside hard spending limits.
//
// Runs locally over stdio. The agent's keypair stays on this machine
// and is never sent anywhere; only signed payment transactions leave.
//
// Environment:
//   BAYARSEKALI_URL               marketplace origin (default: the live deployment)
//   AGENT_KEYPAIR                 path to a Solana JSON keypair file (needed to buy)
//   SOLANA_RPC_URL                devnet RPC (default: public devnet)
//   AGENT_BUDGET_USDC             total the agent may spend per session (default 0.5)
//   AGENT_MAX_PER_PURCHASE_USDC   cap for any single purchase (default 0.1)
//   AGENT_ALLOWED_SELLERS         optional comma separated seller wallets
//
// stdout belongs to the MCP protocol: everything else goes to stderr.
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { payForResource } from "./x402-client.mjs";
import { createSpendGuard } from "./spend-guard.mjs";
import { USDC_MINT, X402_NETWORK } from "./x402.js";

const BASE_URL = (
  process.env.BAYARSEKALI_URL || "https://bayarsekali.indonesiacentral.cloudapp.azure.com"
).replace(/\/+$/, "");
const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const EXPLORER = (sig) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
const log = (...args) => console.error("[bayarsekali-mcp]", ...args);

function loadKeypair() {
  const path = process.env.AGENT_KEYPAIR;
  if (!path) return null;
  const secret = Uint8Array.from(JSON.parse(readFileSync(path, "utf8")));
  return Keypair.fromSecretKey(secret);
}

const keypair = loadKeypair();
const connection = new Connection(RPC_URL, "confirmed");
const guard = createSpendGuard({
  budgetUsdc: process.env.AGENT_BUDGET_USDC || "0.5",
  maxPerPurchaseUsdc: process.env.AGENT_MAX_PER_PURCHASE_USDC || "0.1",
  network: X402_NETWORK,
  asset: USDC_MINT,
  allowedSellers: (process.env.AGENT_ALLOWED_SELLERS || "").split(",").map((s) => s.trim()),
});

async function getJson(path) {
  const res = await fetch(BASE_URL + path, { signal: AbortSignal.timeout(20_000) });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error((body && body.error) || `HTTP ${res.status} for ${path}`);
  return body;
}

const ok = (text, structuredContent) => ({
  content: [{ type: "text", text }],
  ...(structuredContent ? { structuredContent } : {}),
});
const fail = (text) => ({ content: [{ type: "text", text }], isError: true });

const server = new McpServer(
  { name: "bayarsekali", version: "1.0.0" },
  {
    instructions:
      "BayarSekali is a marketplace of paid digital products on Solana devnet. " +
      "Use list_products to browse, get_product for details, and buy_api_access to pay for an API product " +
      "with the agent's own devnet USDC wallet through the x402 protocol; the paid content comes back in the same call. " +
      "Every purchase is capped by a per purchase limit and a session budget; check wallet_status before buying. " +
      "File products are sold to humans in the browser and can not be bought here. " +
      "Devnet funds have no real value.",
  }
);

server.registerTool(
  "list_products",
  {
    title: "List BayarSekali products",
    description:
      "List the products in the BayarSekali catalog with id, title, price and type. " +
      "API products (paid per call in USDC through x402) can be bought with buy_api_access.",
    inputSchema: {
      type: z
        .enum(["api", "file", "all"])
        .optional()
        .describe("Filter by product type. Default: all."),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ type = "all" }) => {
    try {
      const { listings } = await getJson("/api/listings");
      const items = listings
        .filter((l) => type === "all" || l.type === type)
        .map((l) => ({
          id: l.id,
          type: l.type,
          title: l.title,
          price: l.type === "api" ? `${l.priceUsdc} USDC per call` : `${l.priceSol} SOL`,
          buyableByAgent: l.type === "api",
          sellerWallet: l.sellerWallet,
          page: `${BASE_URL}/listing/${l.id}`,
        }));
      const lines = items.map(
        (i) => `- ${i.id} | ${i.title} | ${i.price}${i.buyableByAgent ? "" : " (human checkout only)"}`
      );
      return ok(
        items.length ? `${items.length} product(s):\n${lines.join("\n")}` : "The catalog is empty.",
        { products: items }
      );
    } catch (err) {
      return fail(`Could not load the catalog: ${err.message}`);
    }
  }
);

server.registerTool(
  "get_product",
  {
    title: "Get a BayarSekali product",
    description: "Get the details of one product by its listing id, including what a purchase delivers.",
    inputSchema: { listing_id: z.string().min(1).describe("The listing id from list_products.") },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ listing_id }) => {
    try {
      const l = await getJson("/api/listings/" + encodeURIComponent(listing_id));
      const details = {
        ...l,
        page: `${BASE_URL}/listing/${l.id}`,
        ...(l.resourceUrl ? { resourceUrl: BASE_URL + l.resourceUrl } : {}),
      };
      return ok(JSON.stringify(details, null, 2), details);
    } catch (err) {
      return fail(`Could not load product ${listing_id}: ${err.message}`);
    }
  }
);

server.registerTool(
  "wallet_status",
  {
    title: "Agent wallet and budget",
    description:
      "Show the agent wallet address, its devnet SOL and USDC balances, the spending limits, and the purchases made in this session.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async () => {
    const budget = guard.status();
    if (!keypair) {
      return ok(
        "No agent wallet configured (set AGENT_KEYPAIR to a Solana keypair file). Browsing works; buying does not.\n" +
          JSON.stringify(budget, null, 2),
        { wallet: null, ...budget }
      );
    }
    const wallet = keypair.publicKey;
    let sol = null;
    let usdc = null;
    try {
      sol = (await connection.getBalance(wallet)) / LAMPORTS_PER_SOL;
      const ata = getAssociatedTokenAddressSync(new PublicKey(USDC_MINT), wallet);
      const info = await connection.getTokenAccountBalance(ata).catch(() => null);
      usdc = info ? info.value.uiAmountString : "0";
    } catch (err) {
      log("balance lookup failed:", err.message);
    }
    const status = { wallet: wallet.toBase58(), solBalance: sol, usdcBalance: usdc, ...budget };
    return ok(JSON.stringify(status, null, 2), status);
  }
);

server.registerTool(
  "buy_api_access",
  {
    title: "Buy API access with x402",
    description:
      "Pay for one call of an x402 API product with the agent's devnet USDC wallet and return the delivered content. " +
      "The price comes from the server's HTTP 402 answer and is checked against the per purchase limit and the remaining budget before anything is signed. " +
      "The network fee is paid by the x402 facilitator. Give listing_id for a BayarSekali product, or resource_url for any x402 Solana devnet resource. " +
      "Gateway products (mode proxy in get_product) forward each paid call to the seller's live API; pass its parameters in query. " +
      "A gateway call is only charged when the seller's API answers successfully.",
    inputSchema: {
      listing_id: z.string().min(1).optional().describe("A BayarSekali API listing id."),
      resource_url: z
        .string()
        .url()
        .optional()
        .describe("Any x402 resource URL (Solana devnet, USDC, exact scheme)."),
      query: z
        .record(z.string(), z.string())
        .optional()
        .describe("Query parameters for a gateway API product, for example {\"city\": \"Jakarta\"}."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ listing_id, resource_url, query }) => {
    if (!keypair) {
      return fail("No agent wallet configured. Set AGENT_KEYPAIR to a Solana keypair file to buy.");
    }
    if (!!listing_id === !!resource_url) {
      return fail("Give exactly one of listing_id or resource_url.");
    }
    let url = resource_url || `${BASE_URL}/api/resource/${encodeURIComponent(listing_id)}`;
    if (!/^https?:\/\//.test(url)) return fail("resource_url must be an http(s) URL.");
    if (query && Object.keys(query).length) {
      const withQuery = new URL(url);
      for (const [k, v] of Object.entries(query)) withQuery.searchParams.set(k, v);
      url = withQuery.toString();
    }

    let ticket = null;
    let sent = false;
    try {
      const result = await payForResource({
        resourceUrl: url,
        keypair,
        connection,
        log: (step, message) => log(step, message),
        approve: async (requirements) => {
          ticket = guard.reserve(requirements);
        },
        onSend: () => {
          sent = true;
        },
      });
      if (!result.paid) {
        return ok("The resource was free; nothing was paid.\n" + JSON.stringify(result.data, null, 2), {
          paid: false,
          data: result.data,
        });
      }
      const signature = (result.receipt && result.receipt.transaction) || null;
      guard.commit(ticket, { resource: url, signature });
      const content = result.data && result.data.data !== undefined ? result.data.data : result.data;
      const summary = {
        paid: true,
        amountUsdc: guard.status().purchases.at(-1).amountUsdc,
        transaction: signature,
        explorer: signature ? EXPLORER(signature) : null,
        remainingBudgetUsdc: guard.status().remainingUsdc,
        content,
      };
      return ok(
        `Paid ${summary.amountUsdc} USDC` +
          (signature ? `, settled on chain: ${summary.explorer}` : "") +
          `. Remaining budget ${summary.remainingBudgetUsdc} USDC.\n\nDelivered content:\n` +
          (typeof content === "string" ? content : JSON.stringify(content, null, 2)),
        summary
      );
    } catch (err) {
      if (ticket) {
        // A payment that left this process may have settled: count it.
        if (sent) guard.commit(ticket, { resource: url, signature: null, outcome: "unknown" });
        else guard.release(ticket);
      }
      return fail(
        `Purchase failed: ${err.message}` +
          (sent ? " (the payment was sent; it is counted against the budget to stay safe)" : "")
      );
    }
  }
);

await server.connect(new StdioServerTransport());
log(
  `ready: ${BASE_URL}, wallet ${keypair ? keypair.publicKey.toBase58() : "none"}, budget ${guard.status().budgetUsdc} USDC`
);
