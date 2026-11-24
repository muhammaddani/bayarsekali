export default function Home() {
  return (
    <div>
      <h1>BayarSekali</h1>
      <p className="pitch">
        Sell a digital file with one link. Your buyer opens the link, connects
        a Solana wallet, pays the exact price, and the download unlocks the
        moment the payment is verified on chain. No accounts, no platform cut,
        the money goes straight to your wallet. This demo runs on Solana
        devnet, so every payment uses test SOL with no real value.
      </p>
      <p className="pitch">
        Or sell API access per call through the x402 protocol. Any x402 aware
        agent receives an HTTP 402 with the price in USDC, pays on chain, and
        gets the content in the same request, no checkout page and no human in
        the loop. Try the agent buyer demo on any API listing.
      </p>
      <ol className="steps">
        <li>Create a listing: a file priced in SOL, or API access priced in USDC.</li>
        <li>Share the link anywhere, or hand the endpoint URL to an agent.</li>
        <li>The buyer pays, settlement happens on chain, the content unlocks.</li>
      </ol>
      <a className="button" href="/create">
        Create a listing
      </a>
    </div>
  );
}
