#!/usr/bin/env node
/**
 * Mirror /digital-viewer frontend assets into ./frontend for local serving.
 * Backend (/aicc-api and related) is NOT downloaded — use the proxy for those.
 *
 *   UPSTREAM_IP=81.71.197.85 node mirror-frontend.mjs
 */
import https from "node:https";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dnsPromises from "node:dns/promises";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPSTREAM = (process.env.UPSTREAM || "https://sclt-ai.qnzsai.com").replace(
  /\/$/,
  "",
);
const DOH_URL = process.env.DOH_URL || "https://dns.google/resolve";
const OUT = path.join(__dirname, "frontend");
const PREFIX = "/digital-viewer";

const GUIDE_TOKEN =
  process.env.GUIDE_TOKEN ||
  "xypCEMFFrR2Lh%2BQ8qdNGmnILijqLxITu3kG9wbNGbLvj2pg2JeOx2Mhjpm65bD2Cd0Vi4yvguDFFtBk5hIDeOw%3D%3D";

const upstreamUrl = new URL(UPSTREAM);
const hostname = upstreamUrl.hostname;

async function resolveIp() {
  if (process.env.UPSTREAM_IP) return process.env.UPSTREAM_IP;
  try {
    return (await dnsPromises.lookup(hostname, { family: 4 })).address;
  } catch {
    const res = await fetch(
      `${DOH_URL}?name=${encodeURIComponent(hostname)}&type=A`,
      { headers: { accept: "application/dns-json" } },
    );
    const data = await res.json();
    const a = (data.Answer || []).find((x) => x.type === 1);
    if (!a) throw new Error("cannot resolve upstream");
    return a.data;
  }
}

const ip = await resolveIp();
console.log(`[mirror] ${hostname} → ${ip}`);

function fetchBuffer(urlPath) {
  const u = new URL(urlPath, UPSTREAM);
  if (u.hostname !== hostname) {
    return Promise.reject(new Error(`skip external host ${u.hostname}`));
  }
  const transport = u.protocol === "https:" ? https : http;
  const port = u.port || (u.protocol === "https:" ? 443 : 80);
  return new Promise((resolve, reject) => {
    const req = transport.request(
      {
        hostname: ip,
        port,
        path: u.pathname + u.search,
        method: "GET",
        headers: {
          host: hostname,
          "user-agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
          accept: "*/*",
          "accept-language": "zh-CN,zh;q=0.9",
        },
        servername: hostname,
        timeout: 60_000,
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const next = new URL(res.headers.location, u).pathname + new URL(res.headers.location, u).search;
          res.resume();
          fetchBuffer(next).then(resolve, reject);
          return;
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          if ((res.statusCode || 500) >= 400) {
            reject(
              new Error(`HTTP ${res.statusCode} ${u.pathname} (${buf.length}b)`),
            );
            return;
          }
          resolve({
            buf,
            contentType: res.headers["content-type"] || "",
            status: res.statusCode,
            path: u.pathname,
          });
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.end();
  });
}

function localPathFor(urlPathname) {
  let p = decodeURIComponent(urlPathname.split("?")[0]);
  if (!p.startsWith(PREFIX)) {
    throw new Error(`not under ${PREFIX}: ${p}`);
  }
  // SPA routes like /digital-viewer/guideAgent/xxx → save as guideAgent entry helper
  const rel = p.slice(1); // digital-viewer/...
  return path.join(OUT, rel);
}

function writeFile(abs, buf) {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, buf);
}

const seen = new Set();
const queue = [];
const failed = [];

function enqueue(urlPath) {
  let pathname;
  try {
    const u = urlPath.startsWith("http")
      ? new URL(urlPath)
      : new URL(urlPath, UPSTREAM);
    if (u.hostname !== hostname) return;
    pathname = u.pathname;
  } catch {
    return;
  }
  if (!pathname.startsWith(PREFIX)) return;
  // skip obvious API
  if (pathname.includes("/aicc-api")) return;
  const key = pathname;
  if (seen.has(key)) return;
  seen.add(key);
  queue.push(pathname);
}

function discoverFromHtml(text, basePath) {
  const base = new URL(basePath, UPSTREAM);
  const re =
    /(?:src|href)=["']([^"']+)["']|url\(\s*["']?([^"')]+)["']?\s*\)|"(\/digital-viewer\/[^"]+)"|'(\/digital-viewer\/[^']+)'/g;
  let m;
  while ((m = re.exec(text))) {
    const raw = m[1] || m[2] || m[3] || m[4];
    if (!raw || raw.startsWith("data:") || raw.startsWith("blob:")) continue;
    try {
      const abs = new URL(raw, base);
      enqueue(abs.pathname + abs.search);
    } catch {
      /* ignore */
    }
  }
}

function discoverFromJs(text) {
  // hashed chunk paths used by umi/webpack
  const re =
    /["'`](\/digital-viewer\/[A-Za-z0-9_./@%-]+\.(?:js|css|json|wasm|fmap|theme|png|jpe?g|gif|svg|webp|woff2?|ttf|map|worker\.js))["'`]/g;
  let m;
  while ((m = re.exec(text))) {
    enqueue(m[1]);
  }
  // dynamic import chunk name patterns without leading slash
  const re2 =
    /["'`]((?:p__|shared-|vendors-|framework\.|umi\.|preload_helper\.)[^"'`]+\.(?:js|css))["'`]/g;
  while ((m = re2.exec(text))) {
    enqueue(`${PREFIX}/${m[1]}`);
  }
  // workers
  const re3 = /["'`](\/digital-viewer\/workers\/[^"'`]+)["'`]/g;
  while ((m = re3.exec(text))) enqueue(m[1]);
  // data paths
  const re4 = /["'`](\/digital-viewer\/data\/[^"'`]+)["'`]/g;
  while ((m = re4.exec(text))) enqueue(m[1]);
}

async function downloadOne(pathname) {
  const result = await fetchBuffer(pathname);
  let outPath = localPathFor(result.path);

  // If this looks like an HTML document for a client route, also keep index
  const isHtml =
    result.contentType.includes("text/html") ||
    /\.html?$/i.test(result.path) ||
    (!path.extname(result.path) &&
      result.buf.slice(0, 200).toString("utf8").includes("<html"));

  if (isHtml && result.path !== `${PREFIX}/` && result.path !== `${PREFIX}/index.html`) {
    // Save SPA shell as digital-viewer/index.html if missing; also save path/index.html
    const indexMain = path.join(OUT, "digital-viewer", "index.html");
    if (!fs.existsSync(indexMain)) {
      writeFile(indexMain, result.buf);
      console.log(`[html] seed index.html from ${result.path}`);
    }
    // For directory-like routes, write index.html under that folder for static servers
    if (!path.extname(result.path)) {
      outPath = path.join(localPathFor(result.path), "index.html");
    }
  }

  // Normalize /digital-viewer → digital-viewer/index.html
  if (result.path === PREFIX || result.path === `${PREFIX}/`) {
    outPath = path.join(OUT, "digital-viewer", "index.html");
  }

  writeFile(outPath, result.buf);
  const textProbe = result.buf.slice(0, 8).toString("utf8");
  const asText =
    result.contentType.includes("text") ||
    result.contentType.includes("javascript") ||
    result.contentType.includes("json") ||
    result.contentType.includes("css") ||
    result.path.endsWith(".js") ||
    result.path.endsWith(".css") ||
    result.path.endsWith(".html") ||
    result.path.endsWith(".json") ||
    textProbe.includes("<!");

  if (asText) {
    const text = result.buf.toString("utf8");
    if (result.contentType.includes("html") || result.path.endsWith(".html") || text.includes("<html")) {
      discoverFromHtml(text, result.path);
    }
    if (
      result.path.endsWith(".js") ||
      result.contentType.includes("javascript")
    ) {
      discoverFromJs(text);
    }
    if (result.path.endsWith(".css") || result.contentType.includes("css")) {
      discoverFromHtml(text, result.path);
    }
  }

  console.log(
    `[ok] ${result.path} → ${path.relative(OUT, outPath)} (${result.buf.length}b)`,
  );
}

// Seed URLs
enqueue(`${PREFIX}/`);
enqueue(`${PREFIX}/index.html`);
enqueue(`${PREFIX}/guideAgent/${GUIDE_TOKEN}`);

const seedFile = path.join(__dirname, "seed-urls.json");
if (fs.existsSync(seedFile)) {
  for (const item of JSON.parse(fs.readFileSync(seedFile, "utf8"))) {
    enqueue(item);
  }
}

console.log(`[mirror] writing to ${OUT}`);
fs.mkdirSync(OUT, { recursive: true });

while (queue.length) {
  const batch = queue.splice(0, 6);
  await Promise.all(
    batch.map(async (p) => {
      try {
        await downloadOne(p);
      } catch (err) {
        failed.push({ path: p, error: err.message });
        console.warn(`[fail] ${p}: ${err.message}`);
      }
    }),
  );
}

// Ensure SPA fallback: copy index.html for guideAgent deep links
const mainIndex = path.join(OUT, "digital-viewer", "index.html");
if (fs.existsSync(mainIndex)) {
  const guideDir = path.join(OUT, "digital-viewer", "guideAgent");
  fs.mkdirSync(guideDir, { recursive: true });
  // token folder for static open without rewrite
  const tokenDir = path.join(guideDir, decodeURIComponent(GUIDE_TOKEN));
  fs.mkdirSync(tokenDir, { recursive: true });
  fs.copyFileSync(mainIndex, path.join(tokenDir, "index.html"));
  fs.copyFileSync(mainIndex, path.join(guideDir, "index.html"));
}

const manifest = {
  upstream: UPSTREAM,
  upstreamIp: ip,
  mirroredAt: new Date().toISOString(),
  files: seen.size,
  failed,
};
fs.writeFileSync(
  path.join(OUT, "mirror-manifest.json"),
  JSON.stringify(manifest, null, 2),
);

console.log(
  `[done] queued unique=${seen.size}, failed=${failed.length}. See frontend/mirror-manifest.json`,
);
if (failed.length) {
  console.log(failed.slice(0, 20));
}
