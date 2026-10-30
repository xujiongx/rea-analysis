#!/usr/bin/env python3
"""Mirror www.iqiyi.com homepage + /static into ./frontend (DoH + SNI-by-IP)."""
from __future__ import annotations

import json
import os
import re
import socket
import ssl
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from urllib.parse import urljoin, urlparse, unquote

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "frontend"
SEED = ROOT / "seed-urls.json"
PRIMARY = os.environ.get("UPSTREAM", "https://www.iqiyi.com").rstrip("/")
PRIMARY_HOST = urlparse(PRIMARY).hostname or "www.iqiyi.com"
DOH_IP = os.environ.get("DOH_IP", "8.8.8.8")
DOH_HOST = os.environ.get("DOH_HOST", "dns.google")

for k in list(os.environ):
    if "proxy" in k.lower():
        os.environ.pop(k, None)

ip_cache: dict[str, str] = {}
seen: set[str] = set()
queue: list[str] = []
failed: list[dict] = []
mirrored: list[dict] = []


def resolve_ip(hostname: str) -> str:
    env_key = "IP_" + hostname.replace(".", "_").upper()
    if os.environ.get(env_key):
        return os.environ[env_key]
    if hostname == PRIMARY_HOST and os.environ.get("UPSTREAM_IP"):
        return os.environ["UPSTREAM_IP"]
    if hostname in ip_cache:
        return ip_cache[hostname]
    # system DNS
    try:
        ip = socket.getaddrinfo(hostname, 443, socket.AF_INET)[0][4][0]
        ip_cache[hostname] = ip
        return ip
    except OSError:
        pass
    # DoH via literal IP
    path = f"/resolve?name={hostname}&type=A"
    raw = https_exchange(DOH_IP, DOH_HOST, path, accept="application/dns-json")
    data = json.loads(raw)
    for ans in data.get("Answer") or []:
        if ans.get("type") == 1 and ans.get("data"):
            ip_cache[hostname] = ans["data"]
            return ans["data"]
    raise RuntimeError(f"cannot resolve {hostname}")


def https_exchange(
    ip: str,
    server_hostname: str,
    path: str,
    *,
    accept: str = "*/*",
    referer: str = "https://www.iqiyi.com/",
) -> bytes:
    ctx = ssl.create_default_context()
    sock = socket.create_connection((ip, 443), timeout=45)
    ssock = ctx.wrap_socket(sock, server_hostname=server_hostname)
    req = (
        f"GET {path} HTTP/1.1\r\n"
        f"Host: {server_hostname}\r\n"
        "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36\r\n"
        f"Accept: {accept}\r\n"
        "Accept-Language: zh-CN,zh;q=0.9\r\n"
        f"Referer: {referer}\r\n"
        "Connection: close\r\n\r\n"
    ).encode()
    ssock.sendall(req)
    buf = b""
    while True:
        chunk = ssock.recv(65536)
        if not chunk:
            break
        buf += chunk
    ssock.close()
    sep = buf.find(b"\r\n\r\n")
    if sep < 0:
        raise RuntimeError("bad HTTP response")
    head = buf[:sep].decode("latin1", "replace")
    body = buf[sep + 4 :]
    status = int(head.split(" ", 2)[1])
    headers = {}
    for line in head.split("\r\n")[1:]:
        if ":" in line:
            k, v = line.split(":", 1)
            headers[k.lower().strip()] = v.strip()
    if 300 <= status < 400 and "location" in headers:
        loc = urljoin(f"https://{server_hostname}{path}", headers["location"])
        return fetch_url(loc)
    if "transfer-encoding" in headers and "chunked" in headers["transfer-encoding"].lower():
        body = dechunk(body)
    if "content-encoding" in headers and "gzip" in headers["content-encoding"].lower():
        import gzip

        body = gzip.decompress(body)
    if status >= 400:
        raise RuntimeError(f"HTTP {status} https://{server_hostname}{path} ({len(body)}b)")
    return body


def dechunk(body: bytes) -> bytes:
    out = b""
    i = 0
    while i < len(body):
        j = body.find(b"\r\n", i)
        if j < 0:
            break
        size = int(body[i:j], 16)
        if size == 0:
            break
        out += body[j + 2 : j + 2 + size]
        i = j + 2 + size + 2
    return out


def fetch_url(url: str) -> bytes:
    u = urlparse(url)
    ip = resolve_ip(u.hostname)
    path = u.path or "/"
    if u.query:
        path += "?" + u.query
    return https_exchange(ip, u.hostname, path)


ALLOWED_CDN_HOSTS = {
    "static.iqiyi.com",
    "static-d.iqiyi.com",
    "static-s.iqiyi.com",
    "security.iqiyi.com",
    "stc.iqiyipic.com",
}


def enqueue(raw: str, *, force: bool = False) -> None:
    try:
        abs_url = raw if raw.startswith("http") else urljoin(PRIMARY + "/", raw.lstrip("/"))
        if raw.startswith("/"):
            abs_url = PRIMARY + raw
        u = urlparse(abs_url)
    except Exception:
        return
    if not u.hostname:
        return
    if re.search(r"\.(ts|m4s|mp4|m3u8|png|jpe?g|gif|webp|ico)(\?|$)", u.path, re.I) and not force:
        # Images/icons: only via explicit seed / force
        if u.hostname != PRIMARY_HOST or not u.path.startswith("/static/"):
            return
    if re.search(r"71edge\.com$|qy\.net$|beacon\.qq\.com$|rumt-zh\.com$", u.hostname or ""):
        return
    # Discovery: same-origin /static only, or allowlisted CDN JS/CSS
    if not force:
        if u.hostname == PRIMARY_HOST:
            if not (u.path.startswith("/static/") or u.path in ("/", "/index.html", "/favicon.ico", "/manifest.json")):
                return
        elif u.hostname not in ALLOWED_CDN_HOSTS:
            return
        elif not re.search(r"\.(js|css|woff2?)(\?|$)", u.path, re.I):
            return
    key = f"{u.scheme}://{u.hostname}{u.path}"
    if key in seen:
        return
    seen.add(key)
    queue.append(abs_url)


def local_path(url: str) -> Path:
    u = urlparse(url)
    if u.hostname == PRIMARY_HOST:
        p = unquote(u.path or "/")
        if p.endswith("/") or p == "":
            p = "/index.html"
        return OUT / p.lstrip("/")
    return OUT / "_cdn" / u.hostname / unquote(u.path).lstrip("/")


def discover(text: str, base: str) -> None:
    for m in re.finditer(
        r"""(?:src|href)=["']([^"']+)["']|url\(\s*["']?([^"')]+)["']?\s*\)|["'`](/static/[^"'`]+)["'`]""",
        text,
    ):
        raw = m.group(1) or m.group(2) or m.group(3)
        if not raw or raw.startswith(("data:", "blob:")):
            continue
        try:
            abs_url = urljoin(base, raw)
            enqueue(abs_url)
        except Exception:
            pass
    for m in re.finditer(
        r"""["'`](/static/(?:js|css|media)/[^"'`]+\.(?:js|css|svg|woff2?))["'`]""",
        text,
    ):
        enqueue(PRIMARY + m.group(1))


def download_one(url: str) -> None:
    body = fetch_url(url)
    u = urlparse(url)
    out = local_path(url)
    if u.path in ("/", "/index.html") and u.hostname == PRIMARY_HOST:
        out = OUT / "index.html"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(body)
    mirrored.append({"url": url, "path": str(out.relative_to(OUT)), "bytes": len(body)})
    ct_guess = out.suffix.lower()
    if ct_guess in {".html", ".js", ".css", ".json", ".svg", ""} or b"<html" in body[:200].lower():
        try:
            text = body.decode("utf-8", "replace")
            discover(text, url)
        except Exception:
            pass
    print(f"[ok] {u.hostname}{u.path} → {out.relative_to(OUT)} ({len(body)}b)")


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    for item in json.loads(SEED.read_text()):
        enqueue(item, force=True)
    print(f"[mirror] {PRIMARY_HOST} seeds={len(queue)} → {OUT}")
    # sequential batches
    while queue:
        batch = [queue.pop(0) for _ in range(min(6, len(queue)))]
        with ThreadPoolExecutor(max_workers=6) as ex:
            futs = {ex.submit(download_one, u): u for u in batch}
            for fut in as_completed(futs):
                u = futs[fut]
                try:
                    fut.result()
                except Exception as e:
                    failed.append({"url": u, "error": str(e)})
                    print(f"[fail] {u}: {e}")
    manifest = {
        "primary": PRIMARY,
        "mirroredAt": __import__("datetime").datetime.utcnow().isoformat() + "Z",
        "files": len(mirrored),
        "failed": failed,
        "mirrored": mirrored,
    }
    (OUT / "mirror-manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(f"[done] mirrored={len(mirrored)} failed={len(failed)}")
    return 0 if mirrored else 1


if __name__ == "__main__":
    sys.exit(main())
