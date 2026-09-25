#!/usr/bin/env node
import { createServer } from "node:http";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { dataDir } from "./store.js";
import { handle } from "./server.js";
import { handleApi, readBody, sendError, sendJson, serveStatic } from "./http-routes.js";

const port = Number(process.env.MCP_SSE_PORT || process.env.PORT || 3100);
const host = process.env.MCP_SSE_HOST || "0.0.0.0";
const authToken = process.env.MCP_AUTH_TOKEN || "";
const corsOrigin = process.env.MCP_CORS_ORIGIN || (authToken ? "*" : "");
const maxBodyBytes = Number(process.env.MCP_MAX_BODY_BYTES || process.env.READING_IMPORT_MAX_BYTES || 25_000_000);
const sessions = new Map();
const authCookieName = "co_reading_token";
const protocolVersion = "2024-11-05";

function sendSse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);
}

function setCors(res) {
  if (!corsOrigin) return;
  res.setHeader("access-control-allow-origin", corsOrigin);
  res.setHeader("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type, authorization, mcp-protocol-version");
  res.setHeader("access-control-expose-headers", "mcp-protocol-version, www-authenticate");
}

function cookieToken(req) {
  const cookie = req.headers.cookie || "";
  const prefix = `${authCookieName}=`;
  return (
    cookie
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(prefix))
      ?.slice(prefix.length) || ""
  );
}

function setAuthCookie(res, token) {
  res.setHeader(
    "set-cookie",
    `${authCookieName}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`,
  );
}

function authorized(req, url) {
  if (!authToken) return true;
  if (req.headers.authorization === `Bearer ${authToken}`) return true;
  if (url.searchParams.get("token") === authToken) return true;
  return decodeURIComponent(cookieToken(req)) === authToken;
}

function externalBaseUrl(req) {
  const forwardedProto = req.headers["x-forwarded-proto"];
  const protocol = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto || "http";
  const hostHeader = req.headers["x-forwarded-host"] || req.headers.host || `${host}:${port}`;
  return `${protocol}://${hostHeader}`;
}

function endpointFor(req, sessionId) {
  return `${externalBaseUrl(req)}/messages?sessionId=${encodeURIComponent(sessionId)}`;
}

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function mcpResourceMetadata(req) {
  const baseUrl = externalBaseUrl(req);
  return {
    resource: `${baseUrl}/mcp`,
    resource_name: "Co-Reading MCP",
    resource_documentation: `${baseUrl}/`,
    bearer_methods_supported: ["header"],
    scopes_supported: [],
    authorization_servers: [],
  };
}

function sendMcpJson(res, status, value) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "mcp-protocol-version": protocolVersion,
  });
  res.end(JSON.stringify(value, null, 2));
}

function sendUnauthorized(req, res) {
  const metadataUrl = `${externalBaseUrl(req)}/.well-known/oauth-protected-resource/mcp`;
  res.writeHead(401, {
    "content-type": "application/json; charset=utf-8",
    "www-authenticate": `Bearer resource_metadata="${metadataUrl}"`,
  });
  res.end(JSON.stringify({ error: "Unauthorized" }, null, 2));
}

async function route(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url || "/", `http://${req.headers.host || `${host}:${port}`}`);
  if (authToken && url.searchParams.get("token") === authToken) {
    setAuthCookie(res, authToken);
    url.searchParams.delete("token");
    res.writeHead(302, { location: url.pathname + url.search });
    res.end();
    return;
  }

  if (
    req.method === "GET" &&
    (url.pathname === "/.well-known/oauth-protected-resource" ||
      url.pathname === "/.well-known/oauth-protected-resource/mcp")
  ) {
    sendJson(res, 200, mcpResourceMetadata(req));
    return;
  }

  const protectedRoute =
    Boolean(authToken) ||
    url.pathname.startsWith("/api/") ||
    url.pathname === "/mcp" ||
    url.pathname === "/sse" ||
    url.pathname === "/messages" ||
    url.pathname === "/health";

  if (protectedRoute && !authorized(req, url)) {
    sendUnauthorized(req, res);
    return;
  }

  // Also check the raw path: URL parsing folds "/api/books/x/asset/../.." out of /api/.
  if (url.pathname.startsWith("/api/") || String(req.url || "").startsWith("/api/")) {
    return handleApi(req, res, url, { maxBodyBytes });
  }

  if (req.method === "POST" && url.pathname === "/mcp") {
    let message;
    try {
      message = await readBody(req, { maxBytes: maxBodyBytes, allowEmpty: false });
    } catch (error) {
      sendMcpJson(res, 400, { error: error.message || "Invalid JSON body" });
      return;
    }

    try {
      const response = await handle(message);
      sendMcpJson(res, 200, response || { accepted: true });
    } catch (error) {
      sendMcpJson(res, 200, rpcError(message?.id ?? null, -32000, error.message || String(error)));
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/mcp") {
    res.writeHead(405, {
      allow: "POST",
      "content-type": "application/json; charset=utf-8",
      "mcp-protocol-version": protocolVersion,
    });
    res.end(JSON.stringify({ error: "Method Not Allowed", expected: "POST JSON-RPC" }, null, 2));
    return;
  }

  if (req.method === "GET" && url.pathname === "/sse") {
    const sessionId = crypto.randomUUID();

    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write(": connected\n\n");

    sessions.set(sessionId, { res });
    sendSse(res, "endpoint", endpointFor(req, sessionId));

    const keepAlive = setInterval(() => {
      if (!sessions.has(sessionId)) {
        clearInterval(keepAlive);
        return;
      }
      try {
        const ok = res.write(": ping\n\n");
        if (!ok && res.destroyed) {
          clearInterval(keepAlive);
          sessions.delete(sessionId);
        }
      } catch {
        clearInterval(keepAlive);
        sessions.delete(sessionId);
      }
    }, 30_000);

    req.on("close", () => {
      clearInterval(keepAlive);
      sessions.delete(sessionId);
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/messages") {
    const sessionId = url.searchParams.get("sessionId") || "";
    const session = sessions.get(sessionId);
    if (!session) {
      sendJson(res, 404, { error: "Unknown or expired SSE session" });
      return;
    }

    let message;
    try {
      message = await readBody(req, { maxBytes: maxBodyBytes, allowEmpty: false });
    } catch (error) {
      sendJson(res, 400, { error: error.message || "Invalid JSON body" });
      return;
    }

    sendJson(res, 202, { accepted: true });

    try {
      const response = await handle(message);
      if (response && sessions.has(sessionId)) sendSse(session.res, "message", response);
    } catch (error) {
      const response = rpcError(message?.id ?? null, -32000, error.message || String(error));
      if (sessions.has(sessionId)) sendSse(session.res, "message", response);
    }
    return;
  }

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
    if (url.pathname === "/") return serveStatic(req, res, url);
    sendJson(res, 200, {
      status: "ok",
      transport: "sse+http",
      dataDir,
      sessions: sessions.size,
      auth: authToken ? "enabled" : "disabled",
      endpoints: {
        reader: "/",
        api: "/api/*",
        sse: "/sse",
        messages: "/messages?sessionId=<id>",
        mcp: "/mcp",
      },
    });
    return;
  }

  if (req.method === "GET") {
    return serveStatic(req, res, url);
  }

  sendError(res, 404, "Not found");
}

export function startSseServer() {
  const server = createServer((req, res) => {
    route(req, res).catch((error) => {
      const status = error.statusCode || 500;
      sendJson(res, status, { error: error.message || String(error) });
    });
  });

  server.listen(port, host, () => {
    process.stderr.write(
      `Co-Reading remote server: http://${host}:${port}\nReader: /\nREST API: /api/*\nMCP SSE: /sse\nMCP POST: /mcp\nData dir: ${dataDir}\nAuth: ${
        authToken ? "enabled" : "disabled; set MCP_AUTH_TOKEN before exposing this server"
      }\n`,
    );
  });

  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startSseServer();
}
