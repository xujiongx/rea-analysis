#!/usr/bin/env node
/**
 * Mirror www.iqiyi.com homepage shell + /static assets into ./frontend.
 * Cross-origin player/security scripts land under frontend/_cdn/<host>/...
 * API JSON (mesh.if.iqiyi.com etc.) is NOT downloaded — use the proxy.
 *
 *   node mirror-frontend.mjs
 *   UPSTREAM_IP=23.52.40.72 node mirror-frontend.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchBuffer, resolveIp } from "./scripts/http-fetch.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PRIMARY = (process.env.UPSTREAM || "https://www.iqiyi.com").replace(
  /\/$/,
  "",
);
const OUT = path.join(__dirname, "frontend");
const PRIMARY_HOST = new URL(PRIMARY).hostname;

const { ip, via } = await resolveIp(PRIMARY_HOST);
console.log(`[mirror] ${PRIMARY_HOST} → ${ip} (${via})`);

const seen = new Set();
const queue = [];
const failed = [];
const mirrored = [];

function enqueue(raw) {
  let abs;
  try {
    abs = raw.startsWith("http") ? new URL(raw) : new URL(raw, PRIMARY);
  } catch {
    return;
  }
  // Skip obvious video segments / analytics
  if (/\.(ts|m4s|mp4|m3u8)(\?|$)/i.test(abs.pathname)) return;
  if (
    /71edge\.com$|qy\.net$|beacon\.qq\.com$|rumt-zh\.com$/i.test(abs.hostname)
  ) {
    return;
  }
  const key = abs.origin + abs.pathname + abs.search;
  if (seen.has(key)) return;
  seen.add(key);
  queue.push(abs.href);
}

function localPathFor(u) {
  if (u.hostname === PRIMARY_HOST) {
    let p = decodeURIComponent(u.pathname);
    if (p.endsWith("/")) p += "index.html";
    if (p === "") p = "/index.html";
    return path.join(OUT, p.replace(/^\/+/, ""));
  }
  // external allowlisted CDN → frontend/_cdn/<host>/<path>
  return path.join(
    OUT,
    "_cdn",
    u.hostname,
    decodeURIComponent(u.pathname).replace(/^\/+/, ""),
  );
}

function writeFile(abs, buf) {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, buf);
}

function discoverFromText(text, baseHref) {
  const base = new URL(baseHref);
  const re =
    /(?:src|href)=["']([^"']+)["']|url\(\s*["']?([^"')]+)["']?\s*\)|["'`](\/static\/[^"'`]+)["'`]/g;
  let m;
  while ((m = re.exec(text))) {
    const raw = m[1] || m[2] || m[3];
    if (!raw || raw.startsWith("data:") || raw.startsWith("blob:")) continue;
    try {
      const abs = new URL(raw, base);
      if (
        abs.hostname === PRIMARY_HOST ||
        abs.hostname.endsWith(".iqiyi.com") ||
        abs.hostname.endsWith(".iqiyipic.com")
      ) {
        enqueue(abs.href);
      }
    } catch {
      /* ignore */
    }
  }
  // webpack-ish chunk names under /static/
  const re2 =
    /["'`](\/static\/(?:js|css|media)\/[^"'`]+\.(?:js|css|png|jpe?g|gif|svg|webp|woff2?))["'`]/g;
  while ((m = re2.exec(text))) enqueue(new URL(m[1], PRIMARY).href);
}

async function downloadOne(href) {
  const result = await fetchBuffer(href);
  const u = result.url;
  let outPath = localPathFor(u);

  const ct = result.headers["content-type"] || "";
  const isHtml =
    ct.includes("text/html") ||
    /\.html?$/i.test(u.pathname) ||
    (u.pathname === "/" &&
      result.buf.slice(0, 200).toString("utf8").includes("<html"));

  if (isHtml && (u.pathname === "/" || u.pathname === "/index.html")) {
    outPath = path.join(OUT, "index.html");
  }

  writeFile(outPath, result.buf);
  mirrored.push({
    url: u.href,
    path: path.relative(OUT, outPath),
    bytes: result.buf.length,
  });

  const asText =
    ct.includes("text") ||
    ct.includes("javascript") ||
    ct.includes("json") ||
    ct.includes("css") ||
    /\.(js|css|html|json|svg)$/i.test(u.pathname);

  if (asText) {
    const text = result.buf.toString("utf8");
    discoverFromText(text, u.href);
  }

  console.log(
    `[ok] ${u.hostname}${u.pathname} → ${path.relative(OUT, outPath)} (${result.buf.length}b)`,
  );
}

const seedFile = path.join(__dirname, "seed-urls.json");
for (const item of JSON.parse(fs.readFileSync(seedFile, "utf8"))) {
  enqueue(item);
}

console.log(`[mirror] writing to ${OUT}`);
fs.mkdirSync(OUT, { recursive: true });

while (queue.length) {
  const batch = queue.splice(0, 6);
  await Promise.all(
    batch.map(async (href) => {
      try {
        await downloadOne(href);
      } catch (err) {
        failed.push({ url: href, error: err.message });
        console.warn(`[fail] ${href}: ${err.message}`);
      }
    }),
  );
}

const manifest = {
  primary: PRIMARY,
  primaryIp: ip,
  resolveVia: via,
  mirroredAt: new Date().toISOString(),
  files: mirrored.length,
  failed,
  mirrored,
};
fs.writeFileSync(
  path.join(OUT, "mirror-manifest.json"),
  JSON.stringify(manifest, null, 2),
);

console.log(
  `[done] mirrored=${mirrored.length} failed=${failed.length}. See frontend/mirror-manifest.json`,
);
if (failed.length) console.log(failed.slice(0, 20));
