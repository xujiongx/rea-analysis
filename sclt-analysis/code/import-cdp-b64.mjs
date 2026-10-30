#!/usr/bin/env node
/** Import {path,b64} or map of path->{b64} from a CDP Runtime.evaluate JSON log. */
import fs from "node:fs";
import path from "node:path";

const file = process.argv[2];
if (!file) {
  console.error("usage: import-cdp-b64.mjs <cdp-json>");
  process.exit(1);
}

function unwrap(raw) {
  const envelope = JSON.parse(raw);
  let value =
    envelope?.result?.result?.value ??
    envelope?.result?.value ??
    envelope?.value ??
    envelope;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      /* keep */
    }
  }
  return value;
}

function writeOne(urlPath, b64) {
  let rel = urlPath.replace(/^\//, "");
  if (rel.endsWith("/")) rel += "index.html";
  const abs = path.join("frontend", rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, Buffer.from(b64, "base64"));
  console.log("wrote", abs, fs.statSync(abs).size);
}

const value = unwrap(fs.readFileSync(file, "utf8"));
if (value?.b64 && value?.path) {
  writeOne(value.path, value.b64);
} else if (value && typeof value === "object") {
  for (const [p, meta] of Object.entries(value)) {
    if (meta?.b64) writeOne(p, meta.b64);
  }
} else {
  console.error("unrecognized payload", Object.keys(value || {}));
  process.exit(1);
}
