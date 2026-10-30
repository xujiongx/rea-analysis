#!/usr/bin/env node
/**
 * Serve mirrored frontend from ./frontend, proxy backend APIs upstream.
 *
 *   UPSTREAM_IP=81.71.197.85 node mirror-frontend.mjs
 *   UPSTREAM_IP=81.71.197.85 npm start
 */
import http from "node:http";
import https from "node:https";
import dnsPromises from "node:dns/promises";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "127.0.0.1";
const UPSTREAM = (process.env.UPSTREAM || "https://sclt-ai.qnzsai.com").replace(
  /\/$/,
  "",
);
const DOH_URL = process.env.DOH_URL || "https://dns.google/resolve";

const DEFAULT_TOKEN =
  process.env.GUIDE_TOKEN ||
  "xypCEMFFrR2Lh%2BQ8qdNGmnILijqLxITu3kG9wbNGbLvj2pg2JeOx2Mhjpm65bD2Cd0Vi4yvguDFFtBk5hIDeOw%3D%3D";

const PUBLIC = path.join(__dirname, "public");
const FRONTEND = path.join(__dirname, "frontend");
const VIEWER_ROOT = path.join(FRONTEND, "digital-viewer");

const API_PREFIXES = [
  "/aicc-api",
  "/aicc-sdm-",
  "/aicc-sra-",
  "/aicc-scb-",
  "/aicc-shm-",
  "/aicp-",
  "/minio",
  "/sx-api",
  "/agent-api",
  "/im-api",
  "/smart-assist-api",
  "/smartqc",
];

const upstreamUrl = new URL(UPSTREAM);
const upstreamHostname = upstreamUrl.hostname;
const upstreamPort = upstreamUrl.port
  ? Number(upstreamUrl.port)
  : upstreamUrl.protocol === "http:"
    ? 80
    : 443;
const upstreamIsHttps = upstreamUrl.protocol === "https:";

async function resolveViaDoh(hostname) {
  const url = `${DOH_URL}?name=${encodeURIComponent(hostname)}&type=A`;
  const res = await fetch(url, {
    headers: { accept: "application/dns-json" },
  });
  if (!res.ok) throw new Error(`DoH HTTP ${res.status}`);
  const data = await res.json();
  const a = (data.Answer || []).find((row) => row.type === 1);
  if (!a?.data) throw new Error(`DoH returned no A record for ${hostname}`);
  return a.data;
}

async function resolveUpstreamIp() {
  if (process.env.UPSTREAM_IP) {
    return { ip: process.env.UPSTREAM_IP, via: "UPSTREAM_IP" };
  }
  try {
    const { address } = await dnsPromises.lookup(upstreamHostname, {
      family: 4,
    });
    return { ip: address, via: "system-dns" };
  } catch (err) {
    console.warn(
      `[dns] system lookup failed for ${upstreamHostname}: ${err.message}`,
    );
  }
  try {
    return { ip: await resolveViaDoh(upstreamHostname), via: `doh:${DOH_URL}` };
  } catch (err) {
    throw new Error(
      `Cannot resolve ${upstreamHostname} (${err.message}). Try: UPSTREAM_IP=81.71.197.85 npm start`,
    );
  }
}

const { ip: upstreamIp, via: resolveVia } = await resolveUpstreamIp();
console.log(`[dns] ${upstreamHostname} → ${upstreamIp} (${resolveVia})`);

function isApiPath(pathname) {
  return API_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(prefix),
  );
}

function hopByHop() {
  return new Set([
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailers",
    "transfer-encoding",
    "upgrade",
    "host",
  ]);
}

function buildUpstreamHeaders(req) {
  const skip = hopByHop();
  /** @type {Record<string, string | string[] | undefined>} */
  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (skip.has(key.toLowerCase())) continue;
    headers[key] = value;
  }
  headers.host = upstreamHostname;
  if (!headers["accept-encoding"]) {
    headers["accept-encoding"] = "gzip, deflate";
  }
  return headers;
}

function sendProxyError(res, err) {
  console.error("[proxy]", err.message);
  if (!res.headersSent) {
    res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
  }
  res.end(
    [
      `Upstream proxy error: ${err.message}`,
      `Resolved ${upstreamHostname} → ${upstreamIp} via ${resolveVia}`,
      "Fix: UPSTREAM_IP=81.71.197.85 npm start",
      "",
    ].join("\n"),
  );
}

function proxyHttp(req, res) {
  const transport = upstreamIsHttps ? https : http;
  const upstreamReq = transport.request(
    {
      protocol: upstreamUrl.protocol,
      hostname: upstreamIp,
      port: upstreamPort,
      path: req.url,
      method: req.method,
      headers: buildUpstreamHeaders(req),
      servername: upstreamHostname,
      timeout: 60_000,
    },
    (upstreamRes) => {
      const outHeaders = { ...upstreamRes.headers };
      delete outHeaders["strict-transport-security"];
      res.writeHead(upstreamRes.statusCode || 502, outHeaders);
      upstreamRes.pipe(res);
    },
  );
  upstreamReq.on("timeout", () => {
    upstreamReq.destroy(new Error("upstream timeout"));
  });
  upstreamReq.on("error", (err) => sendProxyError(res, err));
  req.on("error", (err) => {
    upstreamReq.destroy();
    sendProxyError(res, err);
  });
  req.pipe(upstreamReq);
}

function proxyUpgrade(req, socket, head) {
  const transport = upstreamIsHttps ? https : http;
  const headers = buildUpstreamHeaders(req);
  headers.connection = "Upgrade";
  headers.upgrade = req.headers.upgrade || "websocket";
  for (const key of [
    "sec-websocket-key",
    "sec-websocket-version",
    "sec-websocket-protocol",
    "sec-websocket-extensions",
  ]) {
    if (req.headers[key]) headers[key] = req.headers[key];
  }

  const upstreamReq = transport.request({
    protocol: upstreamUrl.protocol,
    hostname: upstreamIp,
    port: upstreamPort,
    path: req.url,
    method: "GET",
    headers,
    servername: upstreamHostname,
    timeout: 60_000,
  });

  upstreamReq.on("upgrade", (upstreamRes, upstreamSocket, upstreamHead) => {
    const lines = [
      "HTTP/1.1 101 Switching Protocols",
      ...Object.entries(upstreamRes.headers).flatMap(([k, v]) => {
        if (v === undefined) return [];
        if (Array.isArray(v)) return v.map((item) => `${k}: ${item}`);
        return [`${k}: ${v}`];
      }),
      "",
      "",
    ];
    socket.write(lines.join("\r\n"));
    if (upstreamHead?.length) upstreamSocket.write(upstreamHead);
    if (head?.length) socket.write(head);
    upstreamSocket.pipe(socket);
    socket.pipe(upstreamSocket);
  });
  upstreamReq.on("error", (err) => {
    console.error("[ws]", err.message);
    socket.destroy();
  });
  upstreamReq.end();
}

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return (
    {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".svg": "image/svg+xml",
      ".webp": "image/webp",
      ".woff": "font/woff",
      ".woff2": "font/woff2",
      ".fmap": "application/octet-stream",
      ".theme": "application/octet-stream",
      ".wasm": "application/wasm",
      ".map": "application/json",
    }[ext] || "application/octet-stream"
  );
}

function tryStat(filePath) {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

/** Resolve /digital-viewer/... to a file under frontend/, with SPA fallback. */
function resolveViewerFile(pathname) {
  const decoded = decodeURIComponent(pathname);
  const rel = decoded.replace(/^\/+/, "");
  const abs = path.normalize(path.join(FRONTEND, rel));
  if (!abs.startsWith(FRONTEND)) return null;

  const st = tryStat(abs);
  if (st?.isFile()) return abs;
  if (st?.isDirectory()) {
    const idx = path.join(abs, "index.html");
    if (tryStat(idx)?.isFile()) return idx;
  }

  // extensionless SPA routes → digital-viewer/index.html
  if (!path.extname(decoded) || decoded.includes("/guideAgent/")) {
    const spa = path.join(VIEWER_ROOT, "index.html");
    if (tryStat(spa)?.isFile()) return spa;
  }
  return null;
}

function sendFile(res, filePath) {
  const body = fs.readFileSync(filePath);
  res.writeHead(200, {
    "content-type": contentTypeFor(filePath),
    "cache-control": "no-cache",
  });
  res.end(body);
}

function renderLabIndex() {
  const guidePath = `/digital-viewer/guideAgent/${DEFAULT_TOKEN}`;
  let html = fs.readFileSync(path.join(PUBLIC, "index.html"), "utf8");
  const hasMirror = Boolean(tryStat(path.join(VIEWER_ROOT, "index.html")));
  return html
    .replaceAll("{{UPSTREAM}}", UPSTREAM)
    .replaceAll("{{GUIDE_PATH}}", guidePath)
    .replaceAll("{{PORT}}", String(PORT))
    .replaceAll("{{UPSTREAM_IP}}", upstreamIp)
    .replaceAll("{{RESOLVE_VIA}}", resolveVia)
    .replaceAll("{{MIRROR_STATUS}}", hasMirror ? "本地 frontend/" : "未镜像（请先 npm run mirror）");
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);
  const p = url.pathname;

  if (p === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        upstream: UPSTREAM,
        upstreamIp,
        resolveVia,
        frontendRoot: FRONTEND,
        hasViewerIndex: Boolean(tryStat(path.join(VIEWER_ROOT, "index.html"))),
        guide: `/digital-viewer/guideAgent/${DEFAULT_TOKEN}`,
      }),
    );
    return;
  }

  if (p === "/" || p === "/index.html" || p === "/lab") {
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(renderLabIndex());
    return;
  }

  if (p.startsWith("/lab/")) {
    const file = path.normalize(path.join(PUBLIC, p.slice("/lab/".length)));
    if (!file.startsWith(PUBLIC) || !tryStat(file)?.isFile()) {
      res.writeHead(404).end("Not found");
      return;
    }
    sendFile(res, file);
    return;
  }

  // Backend → upstream
  if (isApiPath(p)) {
    console.log(`[api] ${req.method} ${req.url}`);
    proxyHttp(req, res);
    return;
  }

  // Frontend → local mirror
  if (p === "/digital-viewer" || p.startsWith("/digital-viewer/")) {
    const file = resolveViewerFile(p);
    if (file) {
      sendFile(res, file);
      return;
    }
    // missing asset: fall back to upstream so mirror can be incomplete
    console.log(`[miss→proxy] ${p}`);
    proxyHttp(req, res);
    return;
  }

  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("Not found\n");
});

server.on("upgrade", (req, socket, head) => {
  console.log(`[ws] upgrade ${req.url}`);
  proxyUpgrade(req, socket, head);
});

server.listen(PORT, HOST, () => {
  const hasMirror = Boolean(tryStat(path.join(VIEWER_ROOT, "index.html")));
  console.log(`listening on http://${HOST}:${PORT}`);
  console.log(`upstream ${UPSTREAM} (${upstreamIp} via ${resolveVia})`);
  console.log(
    hasMirror
      ? `frontend: LOCAL ${VIEWER_ROOT}`
      : `frontend: missing — run: UPSTREAM_IP=${upstreamIp} npm run mirror`,
  );
  console.log(
    `guide: http://${HOST}:${PORT}/digital-viewer/guideAgent/${DEFAULT_TOKEN}`,
  );
});
