#!/usr/bin/env node
/**
 * Record a HAR of folder list/create/rename/delete against the demo app.
 * Starts from seeded state; creates/deletes only scratch folders.
 */
import { writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const BASE = process.env.DEMO_BASE || "http://127.0.0.1:3001";
const OUT = process.argv[2] || "scripts/session.har";

const F1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const F2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const INBOX = "11111111-1111-4111-8111-111111111111";
const ARCHIVE = "22222222-2222-4222-8222-222222222222";

/** @type {any[]} */
const entries = [];

async function call(method, path, body) {
  const url = BASE + path;
  const headers = {};
  let postData;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    postData = JSON.stringify(body);
  }
  const started = Date.now();
  const res = await fetch(url, { method, headers, body: postData });
  const text = await res.text();
  const ended = Date.now();
  const responseHeaders = [...res.headers.entries()].map(([name, value]) => ({
    name,
    value,
  }));
  entries.push({
    startedDateTime: new Date(started).toISOString(),
    time: ended - started,
    request: {
      method,
      url,
      httpVersion: "HTTP/1.1",
      cookies: [],
      headers: Object.entries(headers).map(([name, value]) => ({ name, value })),
      queryString: [],
      headersSize: -1,
      bodySize: postData ? Buffer.byteLength(postData) : 0,
      ...(postData
        ? {
            postData: {
              mimeType: "application/json",
              text: postData,
            },
          }
        : {}),
    },
    response: {
      status: res.status,
      statusText: res.statusText,
      httpVersion: "HTTP/1.1",
      cookies: [],
      headers: responseHeaders,
      content: {
        size: Buffer.byteLength(text),
        mimeType: res.headers.get("content-type") || "application/json",
        text,
      },
      redirectURL: "",
      headersSize: -1,
      bodySize: Buffer.byteLength(text),
    },
    cache: {},
    timings: {
      send: 0,
      wait: ended - started,
      receive: 0,
    },
  });
  return { status: res.status, text };
}

async function main() {
  // Seed reads (twice) + detail reads
  await call("GET", "/api/folders");
  await call("GET", "/api/folders");
  await call("GET", `/api/folders/${INBOX}`);
  await call("GET", `/api/folders/${ARCHIVE}`);

  // Create 1 → read → list
  await call("POST", "/api/folders", {
    id: F1,
    title: "Scratch folder 1 full",
  });
  await call("GET", `/api/folders/${F1}`);
  await call("GET", "/api/folders");

  // Create 2 → read → list
  await call("POST", "/api/folders", {
    id: F2,
    title: "Scratch folder 2",
  });
  await call("GET", `/api/folders/${F2}`);
  await call("GET", "/api/folders");

  await sleep(1100);

  // Rename 1 → read → list
  await call("PATCH", `/api/folders/${F1}`, {
    title: "Scratch folder 1 renamed",
  });
  await call("GET", `/api/folders/${F1}`);
  await call("GET", "/api/folders");

  // Rename 2 → read → list
  await call("PATCH", `/api/folders/${F2}`, {
    title: "Scratch folder 2 renamed",
  });
  await call("GET", `/api/folders/${F2}`);
  await call("GET", "/api/folders");

  // Delete 1 → read 404 → list
  await call("DELETE", `/api/folders/${F1}`);
  await call("GET", `/api/folders/${F1}`);
  await call("GET", "/api/folders");

  // Delete 2 → read 404 → list
  await call("DELETE", `/api/folders/${F2}`);
  await call("GET", `/api/folders/${F2}`);
  await call("GET", "/api/folders");

  const har = {
    log: {
      version: "1.2",
      creator: { name: "rea-demo-record-folders-har", version: "1.0" },
      entries,
    },
  };
  writeFileSync(OUT, JSON.stringify(har, null, 2));
  console.log(`wrote ${entries.length} entries to ${OUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
