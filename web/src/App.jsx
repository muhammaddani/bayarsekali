import Home from "./pages/Home.jsx";
import CreateListing from "./pages/CreateListing.jsx";
import ListingPage from "./pages/ListingPage.jsx";

// Simple client side routing by pathname, no router library needed.
export default function App() {
  const path = window.location.pathname;

  let view;
  if (path === "/create") {
    view = <CreateListing />;
  } else if (path.startsWith("/listing/")) {
    const id = decodeURIComponent(path.slice("/listing/".length));
    view = <ListingPage id={id} />;
  } else {
    view = <Home />;
  }

  return (
    <div className="page">
      <a className="brand" href="/">
        BayarSekali
      </a>
      {view}
    </div>
  );
}
