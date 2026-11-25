import Home from "./pages/Home.jsx";
import CreateListing from "./pages/CreateListing.jsx";
import ListingPage from "./pages/ListingPage.jsx";
import SellerPage from "./pages/SellerPage.jsx";

const REPO_URL = "https://github.com/muhammaddani/bayarsekali";

// Simple client side routing by pathname, no router library needed.
export default function App() {
  const path = window.location.pathname;

  let view;
  let narrow = false;
  if (path === "/create") {
    view = <CreateListing />;
    narrow = true;
  } else if (path.startsWith("/listing/")) {
    const id = decodeURIComponent(path.slice("/listing/".length));
    view = <ListingPage id={id} />;
  } else if (path.startsWith("/seller/")) {
    const wallet = decodeURIComponent(path.slice("/seller/".length));
    view = <SellerPage wallet={wallet} />;
  } else {
    view = <Home />;
  }

  return (
    <>
      <header className="site-header">
        <div className="inner">
          <a className="wordmark" href="/">
            BayarSekali <span className="net-tag">devnet</span>
          </a>
          <nav className="site-nav" aria-label="Main">
            <a href="/#catalog">Catalog</a>
            <a href="/#agents" className="hide-sm">For agents</a>
            <a href="/create">Sell</a>
            <a href={REPO_URL} target="_blank" rel="noreferrer">GitHub</a>
          </nav>
        </div>
      </header>
      <main className={"page" + (narrow ? " narrow" : "")}>{view}</main>
      <footer className="site-footer">
        <div className="inner">
          <span>
            <em>Bayar sekali</em> is Indonesian for “pay once”.
          </span>
          <span>Solana devnet, test funds only.</span>
          <a href={REPO_URL} target="_blank" rel="noreferrer">
            Open source, MIT
          </a>
        </div>
      </footer>
    </>
  );
}
