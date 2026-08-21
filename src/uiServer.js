/**
 * Serves the bundled office UI and its live data feed on a single port: a
 * plain static file server for ui-dist/, with a WebSocketServer attached to
 * the same underlying http.Server. One process, one port -- nothing else to
 * run or remember.
 */

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { read } from "./store.js";
import { computeAgents, diffAgents, toEvents } from "./ui/bridgeState.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI_DIST = path.join(HERE, "..", "ui-dist");
export const DEFAULT_UI_PORT = 49321;
const POLL_MS = 1000;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

function serveStatic(req, res) {
  // Malformed percent-encoding (e.g. GET /%) makes decodeURIComponent throw,
  // and a throw out of an http request listener is an uncaughtException that
  // kills the process -- treat it as just another unresolvable path instead.
  let urlPath;
  try {
    urlPath = decodeURIComponent(req.url.split("?")[0]);
  } catch {
    urlPath = "/";
  }
  let filePath = path.join(UI_DIST, urlPath === "/" ? "index.html" : urlPath);
  const inUiDist = filePath === UI_DIST || filePath.startsWith(UI_DIST + path.sep);

  // Path-traversal guard, then SPA fallback for anything that isn't a real file.
  if (!inUiDist) filePath = path.join(UI_DIST, "index.html");
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(UI_DIST, "index.html");
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
    res.end(data);
  });
}

export function startUiServer({ port = DEFAULT_UI_PORT } = {}) {
  if (!fs.existsSync(UI_DIST)) {
    throw new Error(
      `UI build not found at ${UI_DIST}. This is a packaging problem -- ui-dist/ should ship with ` +
        `the published package. If you're running from a source checkout, build it: cd ui && npm install && npm run build`
    );
  }

  const server = http.createServer(serveStatic);
  const wss = new WebSocketServer({ server });
  // `wss` re-emits the underlying http server's errors (e.g. EADDRINUSE) on
  // itself too, separately from `server`'s own 'error' event below -- an
  // EventEmitter's unhandled 'error' event is a hard crash by default, and
  // the reject() below only covers `server`'s copy of it, not this one.
  wss.on("error", () => {});

  let known = new Map(); // id -> last-broadcast agent row, for both diffing and hydrating new clients

  wss.on("connection", (ws) => {
    for (const [id, agent] of known) {
      for (const e of toEvents(id, agent)) {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(e));
      }
    }
  });

  function broadcast(events) {
    if (!events.length) return;
    const frames = events.map((e) => JSON.stringify(e));
    for (const client of wss.clients) {
      if (client.readyState === client.OPEN) for (const f of frames) client.send(f);
    }
  }

  function poll() {
    if (wss.clients.size === 0) return;
    const board = read();
    const { events, nextMap } = diffAgents(known, computeAgents(board));
    known = nextMap;
    broadcast(events);
  }

  poll();
  const timer = setInterval(poll, POLL_MS);
  server.on("close", () => clearInterval(timer));

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}
