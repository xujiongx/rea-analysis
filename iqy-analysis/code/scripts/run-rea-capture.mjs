#!/usr/bin/env node
/**
 * Run REA capture-browser-scenario against www.iqiyi.com and save Evidence JSON.
 *
 *   npm run capture:rea
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const repoRoot = path.resolve(root, "../..");
const scenario = path.join(__dirname, "rea-home-scenario.json");
const outDir = path.join(root, "capture");
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, "rea-home-capture.json");

const reaBin = path.join(repoRoot, "node_modules", "rea-agents", "scripts", "rea.mjs");
const cmd = [
  reaBin,
  "capture-browser-scenario",
  scenario,
  "--format",
  "json",
];

console.log(`[rea] ${cmd.join(" ")}`);
const result = spawnSync(process.execPath, cmd, {
  cwd: repoRoot,
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
  env: { ...process.env },
});

if (result.stdout) fs.writeFileSync(outFile, result.stdout);
if (result.stderr) {
  fs.writeFileSync(path.join(outDir, "rea-home-capture.stderr.log"), result.stderr);
  console.error(result.stderr.slice(0, 4000));
}
console.log(`[rea] exit=${result.status} wrote ${outFile} (${fs.statSync(outFile).size}b)`);
process.exit(result.status ?? 1);
