#!/usr/bin/env node
/** Append one base64 chunk: node import-browser-chunk.mjs <relpath> <b64> [reset] */
import fs from "node:fs";
import path from "node:path";

const [, , rel, b64, reset] = process.argv;
if (!rel || b64 === undefined) {
  console.error("usage: import-browser-chunk.mjs <relpath> <b64> [reset]");
  process.exit(1);
}
const abs = path.join("frontend", rel.replace(/^\/+/, ""));
fs.mkdirSync(path.dirname(abs), { recursive: true });
const buf = Buffer.from(b64, "base64");
if (reset === "reset" || !fs.existsSync(abs)) fs.writeFileSync(abs, buf);
else fs.appendFileSync(abs, buf);
console.log(abs, fs.statSync(abs).size);
