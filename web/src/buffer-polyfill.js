// The Solana libraries expect Node's Buffer global when they encode
// instructions and serialize transactions. Browsers do not provide
// it, so install the polyfill before anything else runs. This module
// must stay the first import of main.jsx.
import { Buffer } from "buffer";

if (typeof globalThis.Buffer === "undefined") {
  globalThis.Buffer = Buffer;
}
