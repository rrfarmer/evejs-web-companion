#!/usr/bin/env node
// Mirror https://eve-cs.com/ into ./site so it can be served offline by serve.mjs.
//
//   node mirror.mjs [--out site] [--concurrency 6] [--icons] [--urls extra.txt]
//
// Env: EVECS_COOKIE="name=value; ..." uses that session instead of a fresh guest
// cookie (a signed-in member's cookie reaches member-only files too).
//
// How it finds files:
//   * string literals, import specifiers, CSS url(), HTML src/href, import maps
//   * minified template paths: `${X}/close_16px.png` where X="assets/ui/..." elsewhere
//   * data-driven expansions (scenario list, ship-iso ids, hull ids)
//   * optional --urls file of extra URLs (e.g. captured from a browser session)
// Re-running is incremental: files already on disk are re-parsed, not re-fetched
// (use --refresh to fetch everything again).

import fs from "node:fs";
import path from "node:path";

const ORIGIN = "https://eve-cs.com";
const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? def : args[i + 1];
};
const flag = (name) => args.includes(`--${name}`);
const OUT = path.resolve(opt("out", path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "site")));
const CONCURRENCY = Number(opt("concurrency", 6));
const REFRESH = flag("refresh");
const ICONS = flag("icons");
const EXTRA = opt("urls", null);

// Hosts copied alongside the site and rewritten to /__ext/<host>/...
const EXT_HOSTS = ["cdn.jsdelivr.net", "unpkg.com", "esm.sh", "fonts.googleapis.com", "fonts.gstatic.com", "cdnjs.cloudflare.com"];
// Hosts rewritten to /__ext/ but only cached on demand (serve.mjs fills them while online).
const LAZY_HOSTS = ["images.evetech.net", "esi.evetech.net"];
// Never fetched: logout / SSO would end or change the session.
const SKIP = [/^\/auth\/(logout|sso|login|callback)/];

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const TEXT_EXT = /\.(html?|m?js|css|json|svg|txt|xml|webmanifest|map|obj|mtl|gltf)$/i;
const ASSET_EXT = "png|jpe?g|webp|gif|svg|ico|avif|mp4|webm|ogg|mp3|wav|m4a|flac|json|js|mjs|css|html|woff2?|ttf|otf|glb|gltf|bin|obj|mtl|ktx2|dds|basis|wasm|hdr|exr|txt|xml|csv|tsv|fbx|dat|ao|uv|skin|anim|r32";
const PATHISH = new RegExp(`^(\\.{0,2}/)?[\\w@~.\\-]+(/[\\w@~.\\-% ]+)*\\.(${ASSET_EXT})(\\?[^\\s"'\`]*)?(#.*)?$`, "i");

let cookie = process.env.EVECS_COOKIE || "";
const seen = new Set();
const queue = [];
const prefixVars = new Map(); // minified identifier -> string value
const pendingTemplates = new Set(); // template bodies waiting on prefix vars
const importMap = {};
const failures = [];
const stats = { fetched: 0, cached: 0, failed: 0, bytes: 0 };

function localPathFor(u) {
  const url = new URL(u);
  let p = decodeURIComponent(url.pathname);
  if (url.origin !== ORIGIN) p = `/__ext/${url.host}${p}`;
  if (p.endsWith("/")) p += "__index";
  // Extensionless same-origin paths are SPA routes or endpoints: keep them apart from files.
  // (stored as <route>/__page so /scenarios and /scenarios/basics/ecm can both exist)
  if (url.origin === ORIGIN && !/\.[A-Za-z0-9]{1,6}$/.test(p)) p = `/__routes${p.replace(/\/+$/, "")}/__page`;
  // fonts.googleapis.com/css2?family=... is keyed on its query.
  if (url.host === "fonts.googleapis.com" && url.search) p += "__" + Buffer.from(url.search).toString("base64url") + ".css";
  if (url.host === "images.evetech.net" && url.search) p += "__" + url.search.slice(1).replace(/[^\w=]/g, "_");
  return path.join(OUT, ...p.split("/").filter(Boolean).map((s) => s.replace(/[<>:"|?*]/g, "_")));
}

function normalize(u) {
  const url = new URL(u);
  url.hash = "";
  // ?v=hash cache busters: the file is the same; keep one copy (fetch with the query anyway).
  return url;
}

function enqueue(raw, base = ORIGIN + "/") {
  if (!raw || typeof raw !== "string") return;
  raw = raw.trim().replace(/&amp;/g, "&");
  if (/^(data:|blob:|javascript:|mailto:|#|about:)/i.test(raw)) return;
  if (raw.includes("${")) return;
  // Already-rewritten references (incremental re-run) point back at their real host.
  const ext = /^\/__ext\/([^/]+)\/(.*)$/.exec(raw);
  if (ext) raw = `https://${ext[1]}/${ext[2]}`;
  // bare module specifiers via the import map
  if (!/^(\.{0,2}\/|https?:|\/\/)/.test(raw) && !/^[\w.-]+\//.test(raw) && !importMap[raw]) return;
  for (const [spec, target] of Object.entries(importMap)) {
    if (raw === spec) { raw = target; break; }
    if (spec.endsWith("/") && raw.startsWith(spec)) { raw = target + raw.slice(spec.length); break; }
  }
  let url;
  try { url = normalize(new URL(raw, base)); } catch { return; }
  if (url.protocol !== "https:" && url.protocol !== "http:") return;
  if (url.origin !== ORIGIN && !EXT_HOSTS.includes(url.host)) return;
  if (url.origin === ORIGIN && SKIP.some((r) => r.test(url.pathname))) return;
  const key = url.href;
  if (seen.has(key)) return;
  seen.add(key);
  queue.push(key);
}

// Resolve a string found in a file. Module-relative ("./", "../") resolves against the
// file; anything else in page context resolves against <base href="/">.
function enqueueFound(s, fileUrl) {
  if (/^(\.\.?\/)/.test(s)) enqueue(s, fileUrl);
  else if (/^(https?:)?\/\//.test(s) || s.startsWith("/")) enqueue(s, fileUrl);
  else {
    enqueue(s, ORIGIN + "/");
    // JSON files sometimes hold paths relative to themselves.
    if (/\.json/.test(new URL(fileUrl).pathname)) enqueue(s, fileUrl);
  }
}

function harvestStrings(text, fileUrl) {
  const lit = /"((?:[^"\\\n]|\\.){1,400})"|'((?:[^'\\\n]|\\.){1,400})'|`([^`]{1,400})`/g;
  let m;
  while ((m = lit.exec(text))) {
    const s = (m[1] ?? m[2] ?? m[3]).replace(/\\\//g, "/");
    if (m[3] !== undefined && s.includes("${")) { pendingTemplates.add(s + "\u0000" + fileUrl); continue; }
    if (PATHISH.test(s) || /^(assets|data|css|src|img|images|audio|sounds?|models?|textures?|fonts)\//.test(s)) enqueueFound(s, fileUrl);
    else if (/^https?:\/\//.test(s)) enqueueFound(s, fileUrl);
    // srcset-style "a.png 1x, b.png 2x"
    else if (/\.(png|webp|jpe?g)\s+\dx/.test(s)) s.split(",").forEach((p) => enqueueFound(p.trim().split(/\s+/)[0], fileUrl));
  }
}

function harvestPrefixVars(text) {
  // Minified: ,Xy="assets/ui/foo" or Xy=`assets/ui/foo`  (no extension -> a directory prefix)
  const re = /(?:^|[,;{(\s])([A-Za-z_$][\w$]{0,5})\s*=\s*(?:"([^"\n$]{1,200})"|`([^`\n$]{1,200})`)/g;
  let m;
  while ((m = re.exec(text))) {
    const v = m[2] ?? m[3];
    if (/^(\.{0,2}\/)?(assets|data|css|src|img|audio|sounds?|models?|textures?)(\/|$)/.test(v) || /^https:\/\/(images|esi)\.evetech/.test(v)) {
      if (!prefixVars.has(m[1])) prefixVars.set(m[1], new Set());
      prefixVars.get(m[1]).add(v.replace(/\/$/, ""));
    }
  }
}

function expandTemplates() {
  for (const entry of pendingTemplates) {
    const [body, fileUrl] = entry.split("\u0000");
    const parts = body.split(/(\$\{[^}]*\})/);
    let candidates = [""];
    let ok = true;
    for (const part of parts) {
      const mm = /^\$\{\s*([A-Za-z_$][\w$]*)\s*\}$/.exec(part);
      if (mm) {
        const vals = prefixVars.get(mm[1]);
        if (!vals) { ok = false; break; }
        candidates = candidates.flatMap((c) => [...vals].map((v) => c + v));
      } else if (part.startsWith("${")) { ok = false; break; }
      else candidates = candidates.map((c) => c + part);
      if (candidates.length > 50) { ok = false; break; }
    }
    if (!ok) continue;
    pendingTemplates.delete(entry);
    for (const c of candidates) c.split(/,\s*/).forEach((s) => { s = s.trim().split(/\s+/)[0]; if (PATHISH.test(s)) enqueueFound(s, fileUrl); });
  }
}

function harvest(text, fileUrl, type) {
  if (/html/.test(type)) {
    for (const m of text.matchAll(/<script type="importmap">([\s\S]*?)<\/script>/g)) {
      try { Object.assign(importMap, JSON.parse(m[1]).imports || {}); } catch {}
      for (const v of Object.values(importMap)) enqueue(v, fileUrl);
    }
    for (const m of text.matchAll(/\s(?:src|href|poster|data-src|content)\s*=\s*"([^"]+)"/g)) enqueueFound(m[1], fileUrl);
    for (const m of text.matchAll(/\ssrcset\s*=\s*"([^"]+)"/g)) m[1].split(",").forEach((p) => enqueueFound(p.trim().split(/\s+/)[0], fileUrl));
  }
  if (/css|html/.test(type)) {
    for (const m of text.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)) enqueue(m[1], fileUrl);
    for (const m of text.matchAll(/@import\s+['"]([^'"]+)['"]/g)) enqueue(m[1], fileUrl);
  }
  if (/javascript|html/.test(type)) {
    for (const m of text.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*["'`]([^"'`$]+)["'`]/g)) enqueue(m[1], fileUrl);
    harvestPrefixVars(text);
  }
  if (/obj|mtl/.test(fileUrl)) for (const m of text.matchAll(/^(?:mtllib|map_\w+|bump|norm)\s+(.+)$/gm)) enqueue(m[1].trim(), fileUrl);
  harvestStrings(text, fileUrl);
  if (/json/.test(type) && /\.gltf/.test(fileUrl)) {
    try { const j = JSON.parse(text); [...(j.buffers || []), ...(j.images || [])].forEach((b) => b.uri && enqueue(b.uri, fileUrl)); } catch {}
  }
  dataExpansions(text, fileUrl);
}

function dataExpansions(text, fileUrl) {
  const p = new URL(fileUrl).pathname;
  let j;
  try { if (/\.json$/.test(p)) j = JSON.parse(text); } catch { return; }
  if (!j) return;
  if (p === "/data/scenarios/index.json" && Array.isArray(j)) {
    for (const n of j) {
      enqueue(`/data/scenarios/${n}.json`);
      enqueue(`/data/scenarios/active/${n}.json`);
      enqueue(`/scenarios/${n}`);
      enqueue(`/play/${encodeURIComponent(n)}`);
      enqueue(`/play/${n}`);
    }
  }
  if (p === "/data/scenarios/playlists.json") {
    const walk = (o) => { if (Array.isArray(o)) o.forEach(walk); else if (o && typeof o === "object") { if (o.key) enqueue(`/scenarios/${o.key}`); Object.values(o).forEach(walk); } };
    walk(j);
  }
  if (p === "/data/ship-iso.json") {
    const ids = Array.isArray(j) ? j : Object.keys(j);
    for (const id of ids) enqueue(`/assets/ui/ship-iso/${typeof id === "object" ? id.id : id}.png`);
  }
}

async function getGuestCookie() {
  if (cookie) return;
  const r = await fetch(`${ORIGIN}/auth/login?next=/`, { redirect: "manual", headers: { "user-agent": UA } });
  const sc = r.headers.getSetCookie?.() || [];
  cookie = sc.map((c) => c.split(";")[0]).join("; ");
  if (!cookie) throw new Error("no guest cookie from /auth/login");
}

async function fetchOne(key) {
  const url = new URL(key);
  const file = localPathFor(key);
  let buf, type;
  if (!REFRESH && fs.existsSync(file)) {
    buf = fs.readFileSync(file);
    type = guessType(file);
    stats.cached++;
  } else {
    const headers = { "user-agent": UA, accept: "*/*" };
    if (url.origin === ORIGIN) headers.cookie = cookie;
    let r;
    for (let attempt = 0; ; attempt++) {
      try {
        r = await fetch(key, { headers, redirect: url.origin === ORIGIN ? "manual" : "follow" });
        if (r.status >= 500 || r.status === 429) throw new Error(`HTTP ${r.status}`);
        break;
      } catch (e) {
        if (attempt >= 3) { failures.push(`${key}\t${e.message}`); stats.failed++; return; }
        await new Promise((res) => setTimeout(res, 1000 * 2 ** attempt));
      }
    }
    if (r.status >= 300) {
      // 302 to /auth/login = member-only; 404 = guessed path that does not exist.
      if (r.status !== 404) failures.push(`${key}\tHTTP ${r.status}${r.headers.get("location") ? " -> " + r.headers.get("location") : ""}`);
      stats.failed++;
      return;
    }
    buf = Buffer.from(await r.arrayBuffer());
    type = r.headers.get("content-type") || guessType(file);
    // A path guessed from a string that the server answers with the SPA shell is not a file.
    if (/text\/html/.test(type) && /\.(png|webp|jpe?g|json|js|css|glb|wav|mp3|ogg|mp4)$/i.test(url.pathname)) { stats.failed++; return; }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, buf);
    stats.fetched++;
    stats.bytes += buf.length;
  }
  // Model geometry: only its material-library lines can name other files; never scan the whole text.
  if (/\.(obj|mtl)$/i.test(url.pathname)) {
    const head = buf.subarray(0, 64 * 1024).toString("utf8");
    for (const m of head.matchAll(/^(?:mtllib|map_\w+|bump|norm)\s+(.+)$/gm)) enqueue(m[1].trim(), key);
    return;
  }
  if (/text|javascript|json|css|svg|xml|html|manifest/.test(type) || TEXT_EXT.test(url.pathname)) {
    if (buf.length < 16 * 1024 * 1024) harvest(buf.toString("utf8"), key, /html/.test(type) ? "html" : /css/.test(type) ? "css" : /json/.test(type) || /\.json$/.test(url.pathname) ? "json" : /javascript/.test(type) || /\.m?js$/.test(url.pathname) ? "javascript" : type);
  }
}

function guessType(file) {
  const e = path.extname(file).toLowerCase();
  if (file.includes(`${path.sep}__routes${path.sep}`) || e === ".html") return "text/html";
  return { ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".obj": "text/plain", ".mtl": "text/plain", ".gltf": "application/json" }[e] || "application/octet-stream";
}

async function drain() {
  let active = 0, idx = 0;
  await new Promise((resolve) => {
    const pump = () => {
      if (idx >= queue.length && active === 0) {
        const before = queue.length;
        expandTemplates();
        if (queue.length === before) return resolve();
      }
      while (active < CONCURRENCY && idx < queue.length) {
        const key = queue[idx++];
        active++;
        fetchOne(key).catch((e) => failures.push(`${key}\t${e.message}`)).finally(() => {
          active--;
          if ((stats.fetched + stats.cached) % 50 === 0) process.stdout.write(`\r${stats.fetched} fetched, ${stats.cached} on disk, ${stats.failed} missing, ${queue.length - idx} queued   `);
          pump();
        });
      }
    };
    pump();
  });
}

// Rewrite absolute CDN / evetech URLs in saved text files to the local /__ext/ tree.
function rewriteExternal() {
  const hosts = [...EXT_HOSTS, ...LAZY_HOSTS].map((h) => h.replace(/\./g, "\\."));
  const re = new RegExp(`(https?:)?//(${hosts.join("|")})/`, "g");
  let n = 0;
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(f);
      else if (/\.(html?|m?js|css|json)$/i.test(ent.name) || f.includes(`${path.sep}__routes${path.sep}`) || f.includes("fonts.googleapis.com")) {
        const t = fs.readFileSync(f, "utf8");
        const r = t.replace(re, (_, _p, h) => `/__ext/${h}/`).replace(/https?:\/\/eve-cs\.com\//g, "/");
        if (r !== t) { fs.writeFileSync(f, r); n++; }
      }
    }
  };
  walk(OUT);
  return n;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  await getGuestCookie();
  const starts = [
    "/", "/scenarios", "/abyssal-deadspace", "/wormhole-space", "/settings", "/sandbox",
    "/index.html", "/scenario-editor.html", "/play/sandbox", "/auth/me",
    "/src/main.js", "/src/member/main.js", "/assets/app/manifest.json", "/favicon.ico",
    "/data/scenarios/index.json", "/data/scenarios/playlists.json", "/data/ship-iso.json",
    "/data/wormhole-map.json", "/data/wormhole-systems.json", "/data/sde/meta.json",
    "/data/abyss/spawns.json",
  ];
  starts.forEach((s) => enqueue(s));
  if (EXTRA && fs.existsSync(EXTRA)) fs.readFileSync(EXTRA, "utf8").split(/\r?\n/).filter(Boolean).forEach((u) => enqueue(u));
  await drain();

  if (ICONS) {
    // Type icons / renders for every type in the SDE file the site ships (large: thousands of files).
    try {
      const types = JSON.parse(fs.readFileSync(path.join(OUT, "data", "sde", "types.json"), "utf8"));
      const ids = Array.isArray(types) ? types.map((t) => t.typeID ?? t.id) : Object.keys(types);
      EXT_HOSTS.push("images.evetech.net");
      for (const id of ids) if (id) enqueue(`https://images.evetech.net/types/${id}/icon?size=64`);
      await drain();
    } catch (e) { console.log("\nicons skipped:", e.message); }
  }

  console.log(`\nrewrote external URLs in ${rewriteExternal()} files`);
  fs.writeFileSync(path.join(OUT, "__mirror-report.txt"),
    `mirrored ${new Date().toISOString()} from ${ORIGIN}\n` +
    `fetched ${stats.fetched} (${(stats.bytes / 1e6).toFixed(1)} MB), already on disk ${stats.cached}, not found ${stats.failed}\n` +
    `unresolved template paths: ${pendingTemplates.size}\n\n# non-404 failures (302 -> /auth/login means member-only)\n${failures.join("\n")}\n\n# unresolved templates\n` +
    [...pendingTemplates].map((e) => e.split("\u0000")[0]).filter((s) => /\.(png|webp|jpe?g|json|glb|gltf|obj|wav|mp3|ogg|mp4|bin)/.test(s)).sort().join("\n") + "\n");
  console.log(`done: ${stats.fetched} fetched (${(stats.bytes / 1e6).toFixed(1)} MB), ${stats.cached} already on disk, ${stats.failed} not found`);
  console.log(`report: ${path.join(OUT, "__mirror-report.txt")}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
