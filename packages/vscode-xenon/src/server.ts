/** The language server bundled into the extension (`dist/server.js`), run with Bun: `xenon lsp`. */
import { startServer } from "../../../src/lsp.ts";

startServer();
