/**
 * Fetch over HTTPS by resolving A via DoH then connecting to the IP with SNI.
 * Avoids broken local DNS / HTTP proxies that block iqiyi hosts.
 */
import dnsPromises from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { URL } from "node:url";

const DOH_URL = process.env.DOH_URL || "https://dns.google/resolve";
const ipCache = new Map();

export async function resolveIp(hostname) {
  const envKey = `IP_${hostname.replace(/\./g, "_").toUpperCase()}`;
  if (process.env[envKey]) return { ip: process.env[envKey], via: envKey };
  if (process.env.UPSTREAM_IP && hostname === "www.iqiyi.com") {
    return { ip: process.env.UPSTREAM_IP, via: "UPSTREAM_IP" };
  }
  if (ipCache.has(hostname)) return ipCache.get(hostname);

  try {
    const { address } = await dnsPromises.lookup(hostname, { family: 4 });
    const hit = { ip: address, via: "system-dns" };
    ipCache.set(hostname, hit);
    return hit;
  } catch {
    /* fall through */
  }

  // Prefer DoH over a literal resolver IP so broken local DNS still works.
  const dohTargets = [
    { ip: "8.8.8.8", host: "dns.google", path: "/resolve" },
    { ip: "1.1.1.1", host: "cloudflare-dns.com", path: "/dns-query" },
  ];
  let lastErr;
  for (const target of dohTargets) {
    try {
      const data = await dohQuery(target, hostname);
      const a = (data.Answer || []).find((row) => row.type === 1);
      if (!a?.data) throw new Error(`no A in DoH answer`);
      const hit = { ip: a.data, via: `doh:${target.host}` };
      ipCache.set(hostname, hit);
      return hit;
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(
    `Cannot resolve ${hostname} (${lastErr?.message || "unknown"}). Set IP_${hostname.replace(/\./g, "_").toUpperCase()}=...`,
  );
}

function dohQuery(target, hostname) {
  const path = `${target.path}?name=${encodeURIComponent(hostname)}&type=A`;
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: target.ip,
        port: 443,
        path,
        method: "GET",
        headers: {
          host: target.host,
          accept: "application/dns-json",
        },
        servername: target.host,
        timeout: 15_000,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          try {
            const body = Buffer.concat(chunks).toString("utf8");
            if ((res.statusCode || 500) >= 400) {
              reject(new Error(`DoH HTTP ${res.statusCode}`));
              return;
            }
            resolve(JSON.parse(body));
          } catch (err) {
            reject(err);
          }
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("DoH timeout")));
    req.end();
  });
}

/**
 * @param {string} urlString
 * @param {Record<string, string>} [extraHeaders]
 * @returns {Promise<{ status: number, headers: http.IncomingHttpHeaders, buf: Buffer, url: URL }>}
 */
export async function fetchBuffer(urlString, extraHeaders = {}) {
  const u = new URL(urlString);
  const { ip } = await resolveIp(u.hostname);
  const transport = u.protocol === "https:" ? https : http;
  const port = u.port
    ? Number(u.port)
    : u.protocol === "https:"
      ? 443
      : 80;

  return new Promise((resolve, reject) => {
    const req = transport.request(
      {
        hostname: ip,
        port,
        path: u.pathname + u.search,
        method: "GET",
        headers: {
          host: u.hostname,
          "user-agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          accept: "*/*",
          "accept-language": "zh-CN,zh;q=0.9",
          referer: "https://www.iqiyi.com/",
          ...extraHeaders,
        },
        servername: u.hostname,
        timeout: 60_000,
      },
      (res) => {
        if (
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          const next = new URL(res.headers.location, u).href;
          res.resume();
          fetchBuffer(next, extraHeaders).then(resolve, reject);
          return;
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          if ((res.statusCode || 500) >= 400) {
            reject(
              new Error(
                `HTTP ${res.statusCode} ${u.href} (${buf.length}b)`,
              ),
            );
            return;
          }
          resolve({
            status: res.statusCode || 200,
            headers: res.headers,
            buf,
            url: u,
          });
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.end();
  });
}
