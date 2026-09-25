#!/usr/bin/env node
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dataDir } from "./store.js";
import { startStdioServer } from "./server.js";
import { handleApi, sendError, serveStatic } from "./http-routes.js";

const port = Number(process.env.READING_HTTP_PORT || process.env.PORT || 8787);
const host = process.env.READING_HTTP_HOST || "127.0.0.1";

export function startHttpServer() {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${req.headers.host || `${host}:${port}`}`);
      // Also check the raw path: URL parsing folds "/api/books/x/asset/../.." out of /api/.
      if (url.pathname.startsWith("/api/") || String(req.url || "").startsWith("/api/")) {
        await handleApi(req, res, url);
      } else {
        await serveStatic(req, res, url);
      }
    } catch (error) {
      sendError(res, 500, error.message || String(error));
    }
  });

  server.listen(port, host, () => {
    process.stderr.write(
      `Co-Reading HTTP reader: http://${host}:${port}\nData dir: ${dataDir}\nMCP stdio: ready on this process\n`,
    );
  });

  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startHttpServer();
  if (process.env.READING_HTTP_STDIO !== "0") {
    startStdioServer();
  }
}
