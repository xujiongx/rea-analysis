#!/usr/bin/env node
/**
 * Serve mirrored iQIYI frontend from ./frontend; proxy APIs / misses upstream.
 *
 * Same-origin paths (/, /static, /prelw, /pc, …) → www.iqiyi.com when missing locally.
 * Cross-origin API hosts → /__p/<host>/...  (injector rewrites fetch/XHR).
 *
 *   npm start
 *   PORT=8788 npm start
 */
import http from "node:http";
import https from "node:https";
import dnsPromises from "node:dns/promises";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { resolveIp } from "./scripts/http-fetch.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8788);
const HOST = process.env.HOST || "127.0.0.1";
const PRIMARY = (process.env.UPSTREAM || "https://www.iqiyi.com").replace(
  /\/$/,
  "",
);
const PRIMARY_HOST = new URL(PRIMARY).hostname;

const PUBLIC = path.join(__dirname, "public");
const FRONTEND = path.join(__dirname, "frontend");

/** Exact hosts the page injector may rewrite onto /__p/<host>/... */
const PROXY_HOSTS = [
  "mesh.if.iqiyi.com",
  "cache.video.iqiyi.com",
  "pcw-data.video.iqiyi.com",
  "data.video.iqiyi.com",
  "meta.video.iqiyi.com",
  "static.iqiyi.com",
  "static-d.iqiyi.com",
  "static-s.iqiyi.com",
  "security.iqiyi.com",
  "stc.iqiyipic.com",
  "www.iqiyipic.com",
  "pic0.iqiyipic.com",
  "pic1.iqiyipic.com",
  "pic2.iqiyipic.com",
  "pic3.iqiyipic.com",
  "pic6.iqiyipic.com",
  "pic8.iqiyipic.com",
  "t7z.cupid.iqiyi.com",
];

/** Suffix / pattern hosts (play CDN POPs are dynamic: gdctyunct.inter.71edge.com …) */
const PROXY_HOST_SUFFIXES = [
  ".71edge.com",
  ".video.iqiyi.com",
  ".iqiyipic.com",
  ".inter.iqiyi.com",
  ".if.iqiyi.com",
];

function isAllowedProxyHost(hostname) {
  if (!hostname) return false;
  const h = String(hostname).toLowerCase();
  if (h === PRIMARY_HOST || h === "www.iqiyi.com") return false; // pages use same-origin proxy, not /__p
  if (PROXY_HOSTS.includes(h)) return true;
  return PROXY_HOST_SUFFIXES.some((suf) => h.endsWith(suf));
}

const LOCAL_ORIGIN = `http://${HOST}:${PORT}`;

function rewriteCdnUrlsInText(text) {
  // Only for HLS/DASH manifests: segment URLs must go through /__p/.
  // Do NOT rewrite accelerator.js / v.f4v / play JSON — the player validates
  // real CDN hostnames (*.71edge.com etc.) and maps failures to dash_effective
  // (UI:「该视频已被删除」). Browser fetch/XHR/media hooks remap those hosts.
  return text.replace(
    /https?:\/\/([a-z0-9.-]+\.(?:71edge\.com|iqiyi\.com|iqiyipic\.com))(\/[^"'\\\s<>]*)/gi,
    (match, host, urlPath) => {
      if (!isAllowedProxyHost(host)) return match;
      return `${LOCAL_ORIGIN}/__p/${host}${urlPath}`;
    },
  );
}

function shouldRewriteTextBody(contentType = "", pathname = "") {
  // Manifests only — never accelerator / playervideoinfo / v.f4v JSON.
  if (/\.(m3u8|mpd)(\?|$)/i.test(pathname)) return true;
  const ct = String(contentType).toLowerCase();
  if (/mpegurl|x-mpegurl|dash\+xml/.test(ct)) return true;
  return false;
}

/**
 * Lab JS patches:
 * 1) Keep offline/error redirects on localhost (Chrome can't intercept cross-origin location.href).
 * 2) Disable offline→error.html entirely — under the proxy the player SDK often emits
 *    VIDEOERROR type "offline" as a false positive, aborting play before accelerator runs.
 */
function rewriteLabEscapeInJs(text) {
  let out = text
    .replace(
      /https?:\/\/(?:www\.)?iqiyi\.com\/video\/error\.html/gi,
      `http://${HOST}:${PORT}/video/error.html`,
    )
    .replace(
      /\/\/(?:www\.)?iqiyi\.com\/video\/error\.html/gi,
      `//${HOST}:${PORT}/video/error.html`,
    );
  // if("offline"===e)a={errorCode:2}  /  if("offline"===e)n={errorCode:2}
  out = out.replace(
    /if\("offline"===(\w+)\)(\w+)=\{errorCode:2\}/g,
    'if(false&&"offline"===$1)$2={errorCode:2}',
  );
  return out;
}

function shouldRewriteJsEscapes(contentType = "", pathname = "") {
  if (/\.js(\?|$)/i.test(pathname)) return true;
  const ct = String(contentType).toLowerCase();
  return /javascript|ecmascript/.test(ct);
}

/** Cupid / ad mixer / tracking — lab returns empty success, no upstream. */
function isAdEndpoint(hostname, upstreamPath) {
  const host = String(hostname || "").toLowerCase();
  const pathOnly = String(upstreamPath || "").split("?")[0].toLowerCase();
  if (host.includes("cupid.iqiyi.com")) return true;
  if (host.includes("msg.qy.net") || host.includes("amsg.") || /\.qy\.net$/.test(host)) {
    // keep pingback optional; only hard-block cupid + ad APIs for play UX
  }
  if (/\/portal\/lw\/ad\b/.test(pathOnly)) return true;
  if (/\/ad\/mixer\b/.test(pathOnly)) return true;
  if (/\/cupid\b/.test(pathOnly)) return true;
  if (/\/adservice\b/.test(pathOnly)) return true;
  return false;
}

function sendEmptyAd(res) {
  const body = Buffer.from(
    JSON.stringify({
      code: "A00000",
      msg: "success",
      data: { ad: [], ads: [], slots: [], inventory: null },
    }),
    "utf8",
  );
  res.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": `http://${HOST}:${PORT}`,
    "access-control-allow-credentials": "true",
    "cache-control": "no-store",
    "content-length": String(body.length),
  });
  res.end(body);
}

/** Strip preroll / midroll payloads from accelerator.js JSON (keep `ev` streams). */
function stripPlayAdsFromAccelerator(text) {
  try {
    const d = JSON.parse(text);
    if (!d || typeof d !== "object") return text;
    let changed = false;
    if (d.a && typeof d.a === "object") {
      if (d.a.data && typeof d.a.data === "object") {
        d.a.data.playUrls = [];
        d.a.data.duration = 0;
        if (d.a.data.showResponse && typeof d.a.data.showResponse === "object") {
          const sr = d.a.data.showResponse;
          sr.slots = [];
          sr.policySlots = [];
          sr.inventory = {};
          sr.midrollPoints = {};
          if (Array.isArray(sr.ims)) sr.ims = [];
        }
        if (d.a.data.originRes && typeof d.a.data.originRes === "object") {
          if ("inv" in d.a.data.originRes) d.a.data.originRes.inv = "";
        }
        changed = true;
      }
      d.a.d = {};
      changed = true;
    }
    if (d.adp && typeof d.adp === "object") {
      d.adp = {};
      changed = true;
    }
    return changed ? JSON.stringify(d) : text;
  } catch {
    return text;
  }
}

const SAME_ORIGIN_API_PREFIXES = [
  "/prelw",
  "/pc",
  "/iqiyiup",
  "/api",
  "/v_",
];

let primaryIp = process.env.UPSTREAM_IP || "";
let resolveVia = process.env.UPSTREAM_IP ? "UPSTREAM_IP" : "pending";
try {
  const hit = await resolveIp(PRIMARY_HOST);
  primaryIp = hit.ip;
  resolveVia = hit.via;
  console.log(`[dns] ${PRIMARY_HOST} → ${primaryIp} (${resolveVia})`);
} catch (err) {
  console.warn(
    `[dns] deferred: ${err.message}. Set UPSTREAM_IP=... if upstream proxy is needed.`,
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
    "content-length",
  ]);
}

const LOCAL_ORIGIN_RE = new RegExp(
  `https?://${HOST.replace(/\./g, "\\.")}(?::${PORT})?`,
  "gi",
);

/** Browser navigates on localhost; upstream play APIs require www.iqiyi.com. */
function toUpstreamPageUrl(raw) {
  if (!raw || typeof raw !== "string") return raw;
  try {
    const u = new URL(raw, `http://${HOST}:${PORT}/`);
    if (
      u.hostname === HOST ||
      u.hostname === "localhost" ||
      u.hostname === "127.0.0.1"
    ) {
      return `https://${PRIMARY_HOST}${u.pathname}${u.search}${u.hash}`;
    }
  } catch {
    /* ignore */
  }
  return String(raw).replace(LOCAL_ORIGIN_RE, `https://${PRIMARY_HOST}`);
}

function looksLikeLocalLab(value) {
  if (!value) return false;
  if (/127\.0\.0\.1|localhost/i.test(value)) return true;
  // rpage etc. often base64(http://127.0.0.1:8788/...)
  if (/^[A-Za-z0-9+/]+=*$/.test(value) && value.length >= 16) {
    try {
      const decoded = Buffer.from(value, "base64").toString("utf8");
      if (/127\.0\.0\.1|localhost/i.test(decoded)) return true;
    } catch {
      /* ignore */
    }
  }
  return false;
}

function rewriteParamValue(value) {
  if (!looksLikeLocalLab(value)) return value;
  if (/^[A-Za-z0-9+/]+=*$/.test(value) && !/127\.0\.0\.1|localhost/i.test(value)) {
    try {
      const decoded = Buffer.from(value, "base64").toString("utf8");
      if (/127\.0\.0\.1|localhost/i.test(decoded)) {
        return Buffer.from(toUpstreamPageUrl(decoded), "utf8").toString("base64");
      }
    } catch {
      /* fall through */
    }
  }
  return toUpstreamPageUrl(value);
}

function rewriteUpstreamPath(upstreamPath) {
  // Rewrite lab host leaks in query (rpage base64, etc.). Keep `origin=` as the
  // client sent it — stream tokens inside `ev` vary by that value.
  // Do NOT flip disableDRM (must match client).
  try {
    const u = new URL(upstreamPath, `https://${PRIMARY_HOST}`);
    let changed = false;
    for (const [k, v] of [...u.searchParams.entries()]) {
      if (k === "origin" || k === "disableDRM") continue;
      const next = rewriteParamValue(v);
      if (next !== v) {
        u.searchParams.set(k, next);
        changed = true;
      }
    }
    return changed ? u.pathname + u.search : upstreamPath;
  } catch {
    return upstreamPath.replace(LOCAL_ORIGIN_RE, `https://${PRIMARY_HOST}`);
  }
}

function buildUpstreamHeaders(req, hostname) {
  const skip = hopByHop();
  /** @type {Record<string, string | string[] | undefined>} */
  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (skip.has(key.toLowerCase())) continue;
    headers[key] = value;
  }
  headers.host = hostname;
  // Play / mesh APIs validate page Origin/Referer against www.iqiyi.com — never leak lab host.
  headers.origin = `https://${PRIMARY_HOST}`;
  const rawRef = String(req.headers.referer || "");
  headers.referer = rawRef
    ? toUpstreamPageUrl(rawRef)
    : `https://${PRIMARY_HOST}/`;
  if (!headers["accept-encoding"]) {
    headers["accept-encoding"] = "gzip, deflate, br";
  }
  return headers;
}

function sendProxyError(res, err, meta = "") {
  console.error("[proxy]", err.message, meta);
  if (!res.headersSent) {
    res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
  }
  res.end(`Upstream proxy error: ${err.message}\n${meta}\n`);
}

/** Map absolute iqiyi page URLs → local lab origin (keep path/query/hash). */
function rewriteIqiyiPageUrl(raw, localOrigin = `http://${HOST}:${PORT}`) {
  if (!raw || typeof raw !== "string") return raw;
  try {
    const u = new URL(raw, `https://${PRIMARY_HOST}/`);
    const host = u.hostname.replace(/^www\./, "");
    if (
      host === "iqiyi.com" ||
      u.hostname === PRIMARY_HOST ||
      u.hostname === "www.iqiyi.com"
    ) {
      return localOrigin + u.pathname + u.search + u.hash;
    }
  } catch {
    /* ignore */
  }
  return raw;
}

function rewriteLocationHeader(value) {
  if (!value) return value;
  if (Array.isArray(value)) return value.map((v) => rewriteIqiyiPageUrl(v));
  return rewriteIqiyiPageUrl(value);
}

function isHtmlContentType(ct = "") {
  return /\btext\/html\b/i.test(ct);
}

function wantsHtmlProxy(pathname) {
  return (
    pathname === "/" ||
    pathname.endsWith(".html") ||
    pathname.endsWith(".htm") ||
    /^\/(v_|a_|w_|dianshiju|dianying|zongyi|dongman|jilupian|ranks)/i.test(
      pathname,
    )
  );
}

/**
 * Prefer real DNS hostname for mesh/CDN (IP+SNI often stalls on some POPs).
 * Fall back to DoH IP + SNI when system DNS fails.
 */
async function upstreamConnectTarget(hostname) {
  try {
    await dnsPromises.lookup(hostname, { family: 4 });
    return { hostname, servername: hostname, via: "system-dns" };
  } catch {
    const { ip, via } = await resolveIp(hostname);
    return { hostname: ip, servername: hostname, via };
  }
}

async function proxyToHost(req, res, hostname, upstreamPath, opts = {}) {
  const { rewriteHtml = false } = opts;
  const pathForUpstream = rewriteUpstreamPath(upstreamPath);
  if (pathForUpstream !== upstreamPath) {
    console.log(`[origin-fix] ${upstreamPath.slice(0, 120)}…`);
  }

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": `http://${HOST}:${PORT}`,
      "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
      "access-control-allow-headers":
        req.headers["access-control-request-headers"] || "*",
      "access-control-allow-credentials": "true",
      "access-control-max-age": "86400",
    });
    res.end();
    return;
  }

  if (isAdEndpoint(hostname, pathForUpstream)) {
    console.log(
      `[ad-block] ${hostname}${pathForUpstream.split("?")[0]}`,
    );
    sendEmptyAd(res);
    return;
  }

  // base_info / tvg timeouts → page treats video as "offline" → jumps to
  // https://www.iqiyi.com/video/error.html?errortype=2 (escapes the lab).
  const isPlayCritical =
    hostname === "mesh.if.iqiyi.com" ||
    /accelerator\.js|\/dash\b|playervideoinfo|lwplay|base_info|\/tvg\//i.test(
      pathForUpstream,
    );
  const maxAttempts = isPlayCritical ? 3 : 1;
  let lastErr;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await new Promise((resolve, reject) => {
        upstreamConnectTarget(hostname)
          .then((target) => {
            const headers = buildUpstreamHeaders(req, hostname);
            // Prefer identity for HTML + mesh JSON (avoids br/gzip edge cases).
            if (
              rewriteHtml ||
              hostname === "mesh.if.iqiyi.com" ||
              /accelerator\.js/i.test(pathForUpstream) ||
              /\.js(\?|$)/i.test(pathForUpstream)
            ) {
              headers["accept-encoding"] = "identity";
            }

            const upstreamReq = https.request(
              {
                hostname: target.hostname,
                port: 443,
                path: pathForUpstream,
                method: req.method,
                headers,
                servername: target.servername,
                timeout: isPlayCritical ? 90_000 : 45_000,
              },
              (upstreamRes) => {
                const status = upstreamRes.statusCode || 502;
                if (isPlayCritical) {
                  console.log(
                    `[play] ${status} ${hostname}${pathForUpstream.split("?")[0]} (via ${target.via})`,
                  );
                }

                const outHeaders = { ...upstreamRes.headers };
                delete outHeaders["strict-transport-security"];
                delete outHeaders["content-security-policy"];
                outHeaders["access-control-allow-origin"] =
                  `http://${HOST}:${PORT}`;
                outHeaders["access-control-allow-credentials"] = "true";

                if (outHeaders.location) {
                  const before = outHeaders.location;
                  outHeaders.location = rewriteLocationHeader(outHeaders.location);
                  if (outHeaders.location !== before) {
                    console.log(`[redir] ${before} → ${outHeaders.location}`);
                  }
                }

                const ct = String(outHeaders["content-type"] || "");
                const wantHtml =
                  rewriteHtml &&
                  req.method === "GET" &&
                  isHtmlContentType(ct) &&
                  status < 400;
                const wantCdnRewrite =
                  !wantHtml &&
                  req.method === "GET" &&
                  status < 400 &&
                  shouldRewriteTextBody(ct, pathForUpstream);
                const wantJsEscape =
                  !wantHtml &&
                  req.method === "GET" &&
                  status < 400 &&
                  shouldRewriteJsEscapes(ct, pathForUpstream);
                const wantAdStrip =
                  !wantHtml &&
                  req.method === "GET" &&
                  status < 400 &&
                  /accelerator\.js/i.test(pathForUpstream);

                if (
                  !wantHtml &&
                  !wantCdnRewrite &&
                  !wantJsEscape &&
                  !wantAdStrip
                ) {
                  res.writeHead(status, outHeaders);
                  upstreamRes.pipe(res);
                  upstreamRes.on("end", resolve);
                  upstreamRes.on("error", reject);
                  return;
                }

                const encoding = String(
                  outHeaders["content-encoding"] || "",
                ).toLowerCase();
                const chunks = [];
                upstreamRes.on("data", (c) => chunks.push(c));
                upstreamRes.on("end", () => {
                  let buf = Buffer.concat(chunks);
                  try {
                    if (encoding.includes("gzip")) buf = zlib.gunzipSync(buf);
                    else if (encoding.includes("deflate"))
                      buf = zlib.inflateSync(buf);
                    else if (encoding.includes("br"))
                      buf = zlib.brotliDecompressSync(buf);
                  } catch (err) {
                    console.warn("[body] decompress failed", err.message);
                    res.writeHead(status, outHeaders);
                    res.end(buf);
                    resolve();
                    return;
                  }
                  let text = buf.toString("utf8");
                  if (wantHtml) text = injectHtml(text);
                  if (wantCdnRewrite || wantHtml) {
                    const before = text.length;
                    text = rewriteCdnUrlsInText(text);
                    if (text.length !== before || /__p\//.test(text)) {
                      // log only for accelerator / play manifests
                      if (/accelerator|m3u8|mpd/i.test(pathForUpstream)) {
                        console.log(
                          `[cdn-rewrite] ${hostname}${pathForUpstream.split("?")[0]}`,
                        );
                      }
                    }
                  }
                  if (wantJsEscape || wantHtml) {
                    const before = text;
                    text = rewriteLabEscapeInJs(text);
                    if (text !== before && wantJsEscape) {
                      console.log(
                        `[js-escape] ${hostname}${pathForUpstream.split("?")[0]}`,
                      );
                    }
                  }
                  if (wantAdStrip) {
                    const before = text;
                    text = stripPlayAdsFromAccelerator(text);
                    if (text !== before) {
                      console.log(
                        `[ad-strip] ${hostname}${pathForUpstream.split("?")[0]}`,
                      );
                    }
                  }
                  const out = Buffer.from(text, "utf8");
                  delete outHeaders["content-encoding"];
                  delete outHeaders["content-length"];
                  outHeaders["content-length"] = String(out.length);
                  res.writeHead(status, outHeaders);
                  res.end(out);
                  resolve();
                });
                upstreamRes.on("error", reject);
              },
            );

            upstreamReq.on("timeout", () => {
              upstreamReq.destroy(new Error("upstream timeout"));
            });
            upstreamReq.on("error", reject);

            if (req.method === "GET" || req.method === "HEAD") {
              upstreamReq.end();
            } else if (attempt === 1) {
              req.pipe(upstreamReq);
            } else {
              reject(new Error("cannot retry non-GET after body consumed"));
            }
          })
          .catch(reject);
      });
      return;
    } catch (err) {
      lastErr = err;
      console.warn(
        `[proxy] attempt ${attempt}/${maxAttempts} ${hostname}: ${err.message}`,
      );
      if (res.headersSent) return;
    }
  }
  sendProxyError(res, lastErr || new Error("proxy failed"), hostname);
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
      ".ico": "image/x-icon",
      ".woff": "font/woff",
      ".woff2": "font/woff2",
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

function resolveLocal(pathname) {
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
  if (decoded === "/" || decoded === "") {
    const idx = path.join(FRONTEND, "index.html");
    if (tryStat(idx)?.isFile()) return idx;
  }
  return null;
}

function sendFile(res, filePath, extraHeaders = {}) {
  let body = fs.readFileSync(filePath);
  if (filePath.endsWith(".js")) {
    body = Buffer.from(rewriteLabEscapeInJs(body.toString("utf8")), "utf8");
  }
  res.writeHead(200, {
    "content-type": contentTypeFor(filePath),
    "cache-control": "no-cache",
    ...extraHeaders,
  });
  res.end(body);
}

function injectorScript() {
  const hosts = JSON.stringify(PROXY_HOSTS);
  const suffixes = JSON.stringify(PROXY_HOST_SUFFIXES);
  const primaryHost = JSON.stringify(PRIMARY_HOST);
  return `<script data-iqy-lab="1">
(function () {
  var HOSTS = ${hosts};
  var SUFFIXES = ${suffixes};
  var PRIMARY = ${primaryHost};
  var set = Object.create(null);
  HOSTS.forEach(function (h) { set[h] = true; });
  function isProxyHost(h) {
    if (!h) return false;
    h = String(h).toLowerCase();
    if (h === PRIMARY || h === "www.iqiyi.com") return false;
    if (set[h]) return true;
    for (var i = 0; i < SUFFIXES.length; i++) {
      if (h.length > SUFFIXES[i].length && h.slice(-SUFFIXES[i].length) === SUFFIXES[i]) return true;
    }
    return false;
  }
  function isIqiyiPageHost(h) {
    if (!h) return false;
    var n = String(h).replace(/^www\\./, "");
    return n === "iqiyi.com" || h === PRIMARY || h === "www.iqiyi.com";
  }
  function mapNavUrl(u) {
    try {
      var url = new URL(u, location.href);
      if (isIqiyiPageHost(url.hostname)) {
        return location.origin + url.pathname + url.search + url.hash;
      }
    } catch (e) {}
    return u;
  }
  function mapUrl(u) {
    try {
      var url = new URL(u, location.href);
      if (isProxyHost(url.hostname)) {
        return location.origin + "/__p/" + url.hostname + url.pathname + url.search;
      }
      if (isIqiyiPageHost(url.hostname)) {
        return location.origin + url.pathname + url.search + url.hash;
      }
    } catch (e) {}
    return u;
  }
  var _fetch = window.fetch;
  window.fetch = function (input, init) {
    if (typeof input === "string") input = mapUrl(input);
    else if (input && typeof input.url === "string") {
      input = new Request(mapUrl(input.url), input);
    }
    return _fetch.call(this, input, init);
  };
  var xhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    var args = Array.prototype.slice.call(arguments);
    args[1] = mapUrl(url);
    return xhrOpen.apply(this, args);
  };
  // Native media / MSE helpers often set src without going through fetch/XHR.
  function patchMediaSrc(proto) {
    try {
      var desc = Object.getOwnPropertyDescriptor(proto, "src");
      if (!desc || !desc.set) return;
      var rawSet = desc.set;
      var rawGet = desc.get;
      Object.defineProperty(proto, "src", {
        configurable: true,
        enumerable: true,
        get: function () { return rawGet.call(this); },
        set: function (v) { return rawSet.call(this, mapUrl(String(v))); }
      });
    } catch (e) {}
  }
  if (window.HTMLMediaElement) patchMediaSrc(window.HTMLMediaElement.prototype);
  if (window.HTMLSourceElement) patchMediaSrc(window.HTMLSourceElement.prototype);
  var _setAttr = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name, value) {
    if (String(name).toLowerCase() === "src" && value != null) {
      value = mapUrl(String(value));
    }
    return _setAttr.call(this, name, value);
  };
  var _open = window.open;
  window.open = function (url) {
    var args = Array.prototype.slice.call(arguments);
    if (typeof args[0] === "string") args[0] = mapNavUrl(args[0]);
    return _open.apply(this, args);
  };
  function patchLocation(loc) {
    try {
      var desc = Object.getOwnPropertyDescriptor(loc, "href") ||
        Object.getOwnPropertyDescriptor(Object.getPrototypeOf(loc), "href");
      if (!desc || !desc.set) return;
      var rawSet = desc.set;
      var rawGet = desc.get;
      Object.defineProperty(loc, "href", {
        configurable: true,
        enumerable: true,
        get: function () { return rawGet.call(this); },
        set: function (v) { return rawSet.call(this, mapNavUrl(String(v))); }
      });
      ["assign", "replace"].forEach(function (fn) {
        var orig = loc[fn];
        if (typeof orig !== "function") return;
        loc[fn] = function (v) { return orig.call(this, mapNavUrl(String(v))); };
      });
    } catch (e) {}
  }
  patchLocation(window.location);
  // Chrome often blocks Location.href redefine; Navigation API still sees escapes
  // like window.location.href = "https://www.iqiyi.com/video/error.html?errortype=2".
  if (window.navigation && typeof navigation.addEventListener === "function") {
    navigation.addEventListener("navigate", function (e) {
      try {
        if (!e.canIntercept || e.hashChange || e.downloadRequest != null) return;
        var dest = e.destination && e.destination.url;
        if (!dest) return;
        var mapped = mapNavUrl(dest);
        if (mapped === dest) return;
        e.intercept({
          handler: function () {
            window.location.replace(mapped);
          }
        });
      } catch (err) {}
    });
  }
  document.addEventListener("click", function (ev) {
    var t = ev.target;
    if (!t || !t.closest) return;
    var a = t.closest("a[href]");
    if (!a) return;
    var href = a.getAttribute("href");
    if (!href || href.charAt(0) === "#" || href.indexOf("javascript:") === 0) return;
    var mapped = mapNavUrl(href);
    if (mapped === href) return;
    // Keep SPA / modifier clicks intact; only rewrite absolute iqiyi navigations.
    a.setAttribute("href", mapped);
  }, true);

  // Lab: kill auto login modal (QyLoginInst.openLoginByJs / Popup.showLogin).
  (function suppressLoginModal() {
    function noop() {}
    function neuterInst(inst) {
      if (!inst || typeof inst !== "object") return;
      try {
        Object.defineProperty(inst, "openLoginByJs", {
          configurable: true,
          enumerable: true,
          get: function () { return noop; },
          set: function () {},
        });
      } catch (e) {
        try { inst.openLoginByJs = noop; } catch (e2) {}
      }
      try {
        if ("openLogin" in inst) inst.openLogin = noop;
        if ("showLogin" in inst) inst.showLogin = noop;
      } catch (e) {}
    }
    var cur = window.QyLoginInst;
    try {
      Object.defineProperty(window, "QyLoginInst", {
        configurable: true,
        enumerable: true,
        get: function () { return cur; },
        set: function (v) {
          cur = v;
          neuterInst(cur);
        },
      });
    } catch (e) {}
    neuterInst(cur);
    setInterval(function () { neuterInst(window.QyLoginInst); }, 800);

    var style = document.createElement("style");
    style.setAttribute("data-iqy-lab-login", "1");
    style.textContent =
      '[data-login-suc-overlay-root]{display:none!important}' +
      'iframe[src*="passport.iqiyi.com"]{display:none!important}';
    (document.documentElement || document.head).appendChild(style);

    var MARKERS = ["扫码登录", "微信快捷登录", "新朋友登录享专属特惠"];
    function looksLikeLoginModal(el) {
      if (!el || el.nodeType !== 1) return false;
      var text = (el.innerText || el.textContent || "").slice(0, 800);
      if (!text) return false;
      for (var i = 0; i < MARKERS.length; i++) {
        if (text.indexOf(MARKERS[i]) !== -1) return true;
      }
      return false;
    }
    function hideLoginTree(node) {
      if (!node || node.nodeType !== 1) return;
      if (node.getAttribute && node.getAttribute("data-iqy-lab") != null) return;
      if (looksLikeLoginModal(node)) {
        node.style.setProperty("display", "none", "important");
        node.setAttribute("data-iqy-lab-login-hidden", "1");
        return;
      }
      var kids = node.children;
      if (!kids) return;
      for (var i = 0; i < kids.length; i++) hideLoginTree(kids[i]);
    }
    function sweep() {
      try { hideLoginTree(document.body); } catch (e) {}
    }
    if (document.body) sweep();
    else document.addEventListener("DOMContentLoaded", sweep);
    try {
      new MutationObserver(function (muts) {
        for (var i = 0; i < muts.length; i++) {
          var nodes = muts[i].addedNodes;
          for (var j = 0; j < nodes.length; j++) hideLoginTree(nodes[j]);
        }
      }).observe(document.documentElement, { childList: true, subtree: true });
    } catch (e) {}
  })();

  // Lab: hide residual ad chrome (preroll UI / sidebar 广告 banners).
  (function suppressAdsUi() {
    var style = document.createElement("style");
    style.setAttribute("data-iqy-lab-ads", "1");
    style.textContent =
      'iframe[src*="cupid.iqiyi.com"],iframe[src*="/ad/"],' +
      '[class*="iqp-ad"],[class*="iqp-player-ads"],[class*="PlayerAds"],' +
      '[class*="ad-banner"],[class*="AdBanner"],[data-ad-zone],' +
      '[data-iqy-lab-ad-hidden]{display:none!important;pointer-events:none!important}';
    (document.documentElement || document.head).appendChild(style);

    var AD_MARKERS = [
      "后可跳过广告",
      "跳过广告",
      "黄金关闭此广告",
      "了解详情",
    ];
    function textOf(el) {
      return (el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim();
    }
    function hide(el) {
      if (!el || el.nodeType !== 1) return;
      if (el.getAttribute && el.getAttribute("data-iqy-lab") != null) return;
      el.style.setProperty("display", "none", "important");
      el.setAttribute("data-iqy-lab-ad-hidden", "1");
    }
    function looksLikeAdChrome(el) {
      if (!el || el.nodeType !== 1) return false;
      var t = textOf(el).slice(0, 400);
      if (!t) return false;
      for (var i = 0; i < AD_MARKERS.length; i++) {
        if (t.indexOf(AD_MARKERS[i]) !== -1) return true;
      }
      // Sidebar / card with a lone 「广告」badge and short copy.
      if (t.indexOf("广告") !== -1 && t.length < 120) return true;
      return false;
    }
    function sweepNode(node) {
      if (!node || node.nodeType !== 1) return;
      if (looksLikeAdChrome(node)) {
        // Prefer hiding a positioned overlay / card ancestor when possible.
        var target = node;
        var p = node.parentElement;
        for (var i = 0; i < 4 && p && p !== document.body; i++) {
          var st = window.getComputedStyle(p);
          if (
            st &&
            (st.position === "absolute" ||
              st.position === "fixed" ||
              st.position === "sticky")
          ) {
            target = p;
            break;
          }
          p = p.parentElement;
        }
        hide(target);
        return;
      }
      var kids = node.children;
      if (!kids) return;
      for (var j = 0; j < kids.length; j++) sweepNode(kids[j]);
    }
    function sweep() {
      try { if (document.body) sweepNode(document.body); } catch (e) {}
    }
    if (document.body) sweep();
    else document.addEventListener("DOMContentLoaded", sweep);
    setInterval(sweep, 1500);
    try {
      new MutationObserver(function (muts) {
        for (var i = 0; i < muts.length; i++) {
          var nodes = muts[i].addedNodes;
          for (var j = 0; j < nodes.length; j++) sweepNode(nodes[j]);
        }
      }).observe(document.documentElement, { childList: true, subtree: true });
    } catch (e) {}
  })();
})();
</script>`;
}

function injectHtml(html) {
  let out = html;
  // Only rewrite navigational href/src — avoid mangling embedded play JSON / origin fields.
  out = out.replace(
    /(\b(?:href|src)=["'])https?:\/\/(?:www\.)?iqiyi\.com/gi,
    `$1http://${HOST}:${PORT}`,
  );
  out = out.replace(
    /(\b(?:href|src)=["'])\/\/(?:www\.)?iqiyi\.com/gi,
    `$1//${HOST}:${PORT}`,
  );
  if (out.includes("data-iqy-lab=")) return out;
  const tag = injectorScript();
  if (out.includes("<head>")) return out.replace("<head>", `<head>${tag}`);
  if (out.includes("<head ")) {
    return out.replace(/<head([^>]*)>/, `<head$1>${tag}`);
  }
  return tag + out;
}

function renderLabIndex() {
  let html = fs.readFileSync(path.join(PUBLIC, "index.html"), "utf8");
  const hasMirror = Boolean(tryStat(path.join(FRONTEND, "index.html")));
  return html
    .replaceAll("{{UPSTREAM}}", PRIMARY)
    .replaceAll("{{PORT}}", String(PORT))
    .replaceAll("{{UPSTREAM_IP}}", primaryIp)
    .replaceAll("{{RESOLVE_VIA}}", resolveVia)
    .replaceAll(
      "{{MIRROR_STATUS}}",
      hasMirror ? "本地 frontend/" : "未镜像（请先 npm run mirror）",
    )
    .replaceAll("{{PROXY_HOSTS}}", PROXY_HOSTS.join(", "));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);
  const p = url.pathname;

  if (p === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        upstream: PRIMARY,
        upstreamIp: primaryIp,
        resolveVia,
        frontendRoot: FRONTEND,
        hasIndex: Boolean(tryStat(path.join(FRONTEND, "index.html"))),
        proxyHosts: PROXY_HOSTS,
      }),
    );
    return;
  }

  if (p === "/lab" || p === "/lab/") {
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

  // Production uses /prelw/... as same-origin gateway → mesh.if.iqiyi.com.
  // Do NOT send these to www.iqiyi.com (wrong host → empty/offline → error.html).
  if (p === "/prelw" || p.startsWith("/prelw/")) {
    let upstreamPath = p.slice("/prelw".length) || "/";
    if (!upstreamPath.startsWith("/")) upstreamPath = `/${upstreamPath}`;
    upstreamPath += url.search;
    console.log(`[prelw→mesh] ${req.method} ${upstreamPath}`);
    await proxyToHost(req, res, "mesh.if.iqiyi.com", upstreamPath);
    return;
  }

  // Multi-host proxy: /__p/<host>/<path>
  if (p.startsWith("/__p/")) {
    const rest = p.slice("/__p/".length);
    const slash = rest.indexOf("/");
    const hostname = slash === -1 ? rest : rest.slice(0, slash);
    const upstreamPath =
      (slash === -1 ? "/" : rest.slice(slash)) + url.search;
    if (!isAllowedProxyHost(hostname)) {
      res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      res.end(`Host not allowed for /__p/: ${hostname}\n`);
      return;
    }
    console.log(`[api] ${req.method} ${hostname}${upstreamPath}`);
    await proxyToHost(req, res, hostname, upstreamPath);
    return;
  }

  // Local mirror hit
  const local = resolveLocal(p);
  if (local) {
    if (local.endsWith(".html") || p === "/" || p === "/index.html") {
      const html = injectHtml(fs.readFileSync(local, "utf8"));
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-cache",
      });
      res.end(html);
      return;
    }
    sendFile(res, local);
    return;
  }

  // Same-origin API / missing static / play pages → www.iqiyi.com
  const isApi = SAME_ORIGIN_API_PREFIXES.some(
    (prefix) => p === prefix || p.startsWith(prefix + "/") || p.startsWith(prefix),
  );
  const isPlayOrChannel =
    wantsHtmlProxy(p) ||
    p.startsWith("/static/") ||
    /^\/(v_|a_|w_)/i.test(p);

  if (isApi || isPlayOrChannel || !path.extname(p)) {
    const rewriteHtml = wantsHtmlProxy(p);
    console.log(
      `[miss→${PRIMARY_HOST}${rewriteHtml ? "+html" : ""}] ${req.method} ${req.url}`,
    );
    await proxyToHost(req, res, PRIMARY_HOST, url.pathname + url.search, {
      rewriteHtml,
    });
    return;
  }

  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("Not found\n");
});

server.listen(PORT, HOST, () => {
  const hasMirror = Boolean(tryStat(path.join(FRONTEND, "index.html")));
  console.log(`listening on http://${HOST}:${PORT}/`);
  console.log(`lab      http://${HOST}:${PORT}/lab`);
  console.log(`upstream ${PRIMARY} (${primaryIp} via ${resolveVia})`);
  console.log(
    hasMirror
      ? `frontend: LOCAL ${FRONTEND}`
      : `frontend: missing — run: npm run mirror`,
  );
});
