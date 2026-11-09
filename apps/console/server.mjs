/**
 * Production server for the console (TanStack Start fetch handler).
 *
 * Development uses `vite dev`; the build emits `dist/server/server.js` with a
 * web-standard `fetch` export, which srvx adapts to Node HTTP. Client assets
 * live in `dist/client` and must be served before the SSR handler, otherwise
 * `/assets/*` requests fall through to the app and return HTML.
 */
import { fileURLToPath } from "node:url";

import { serve } from "srvx/node";
import { staticMiddleware } from "srvx/static";

import handler from "./dist/server/server.js";

const port = Number(process.env.PORT ?? 3000);
const hostname = process.env.HOST ?? "0.0.0.0";
const clientDir = fileURLToPath(new URL("./dist/client/", import.meta.url));

serve({
  fetch: handler.fetch,
  port,
  hostname,
  // Fly terminates TLS and forwards the client address; the auth layer needs
  // the real IP for rate limiting and cookies need the https origin.
  trustProxy: true,
  gracefulShutdown: { gracefulTimeout: 20_000 },
  middleware: [staticMiddleware({ dir: clientDir })],
});

console.log(JSON.stringify({ level: "info", msg: "console listening", port, hostname, clientDir }));
