import http from "node:http";
import { randomUUID } from "node:crypto";

const PORT = Number(process.env.PORT || 3000);

/** Fixed seed IDs so recordings can use absolute request paths. */
const SEED = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    title: "Inbox",
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    title: "Archive",
  },
];

/** @type {Map<string, { id: string, title: string, createdAt: string, updatedAt: string }>} */
const folders = new Map();

function seed() {
  const now = new Date().toISOString();
  for (const item of SEED) {
    folders.set(item.id, {
      id: item.id,
      title: item.title,
      createdAt: now,
      updatedAt: now,
    });
  }
}

function send(res, status, body) {
  const json = body === undefined ? "" : JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "access-control-allow-headers": "content-type",
  });
  res.end(json);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function listFolders() {
  return [...folders.values()].sort((a, b) => a.title.localeCompare(b.title));
}

const uuidRe =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>Folders Demo</title>
  <style>
    :root { color-scheme: light; font-family: "IBM Plex Sans", system-ui, sans-serif; }
    body { margin: 2rem; max-width: 40rem; background: #f7f3ea; color: #1c1917; }
    h1 { font-size: 1.5rem; }
    ul { list-style: none; padding: 0; }
    li { display: flex; gap: .5rem; align-items: center; margin: .4rem 0; }
    input, button { font: inherit; padding: .4rem .7rem; }
    button { cursor: pointer; }
  </style>
</head>
<body>
  <h1>Folders</h1>
  <form id="create">
    <input name="title" placeholder="New folder title" required />
    <button type="submit">Create</button>
  </form>
  <ul id="list"></ul>
  <script>
    const listEl = document.getElementById("list");
    async function refresh() {
      const res = await fetch("/api/folders");
      const folders = await res.json();
      listEl.innerHTML = "";
      for (const f of folders) {
        const li = document.createElement("li");
        li.dataset.id = f.id;
        const title = document.createElement("input");
        title.value = f.title;
        title.setAttribute("aria-label", "Rename " + f.title);
        const rename = document.createElement("button");
        rename.textContent = "Rename";
        rename.type = "button";
        rename.addEventListener("click", async () => {
          await fetch("/api/folders/" + f.id, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ title: title.value }),
          });
          await refresh();
        });
        const del = document.createElement("button");
        del.textContent = "Delete";
        del.type = "button";
        del.addEventListener("click", async () => {
          await fetch("/api/folders/" + f.id, { method: "DELETE" });
          await refresh();
        });
        li.append(title, rename, del);
        listEl.append(li);
      }
    }
    document.getElementById("create").addEventListener("submit", async (e) => {
      e.preventDefault();
      const title = new FormData(e.target).get("title");
      await fetch("/api/folders", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title }),
      });
      e.target.reset();
      await refresh();
    });
    refresh();
  </script>
</body>
</html>`;

seed();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);
  if (req.method === "OPTIONS") {
    return send(res, 204);
  }
  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(html);
  }
  if (req.method === "GET" && url.pathname === "/api/folders") {
    return send(res, 200, listFolders());
  }
  const one = url.pathname.match(/^\/api\/folders\/([^/]+)$/);
  if (req.method === "GET" && one) {
    const folder = folders.get(one[1]);
    if (!folder) return send(res, 404, { error: "not_found" });
    return send(res, 200, folder);
  }
  if (req.method === "POST" && url.pathname === "/api/folders") {
    try {
      const body = await readBody(req);
      const title = String(body.title || "").trim();
      if (!title) return send(res, 400, { error: "title_required" });
      let id = body.id ? String(body.id) : randomUUID();
      if (!uuidRe.test(id)) return send(res, 400, { error: "invalid_id" });
      if (folders.has(id)) return send(res, 409, { error: "id_exists" });
      const now = new Date().toISOString();
      const folder = { id, title, createdAt: now, updatedAt: now };
      folders.set(folder.id, folder);
      return send(res, 201, folder);
    } catch {
      return send(res, 400, { error: "invalid_json" });
    }
  }
  if (req.method === "PATCH" && one) {
    const folder = folders.get(one[1]);
    if (!folder) return send(res, 404, { error: "not_found" });
    try {
      const body = await readBody(req);
      const title = String(body.title || "").trim();
      if (!title) return send(res, 400, { error: "title_required" });
      folder.title = title;
      folder.updatedAt = new Date().toISOString();
      folders.set(folder.id, folder);
      return send(res, 200, folder);
    } catch {
      return send(res, 400, { error: "invalid_json" });
    }
  }
  if (req.method === "DELETE" && one) {
    if (!folders.has(one[1])) return send(res, 404, { error: "not_found" });
    folders.delete(one[1]);
    return send(res, 204);
  }
  send(res, 404, { error: "not_found" });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`demo folders app listening on http://127.0.0.1:${PORT}`);
});
