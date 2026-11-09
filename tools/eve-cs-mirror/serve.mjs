#!/usr/bin/env node
// Serve the mirrored eve-cs.com copy offline.
//
//   node serve.mjs [--port 8765] [--site site] [--fill]
//
// Open http://localhost:8765/. The in-memory adapter selects guest startup.
//
// --fill: when a file is missing and the machine is online, fetch it from eve-cs.com
// (or the CDN / images.evetech.net), save it into the mirror, and serve it. Browse the
// local copy with --fill on once to pick up anything the crawler could not predict.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { offlineText, EXTERNAL_HOSTS } from "./offline.mjs";

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i < 0 ? d : args[i + 1]; };
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.resolve(opt("site", path.join(HERE, "site")));
const PORT = Number(opt("port", 8765));
const FILL = args.includes("--fill");
const HOST = opt("host", "127.0.0.1");
const ORIGIN = "https://eve-cs.com";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const missLog = path.join(SITE, "__missing.txt");
let guestCookie = "";
let typeIcons;

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".ico": "image/x-icon",
  ".mp4": "video/mp4", ".webm": "video/webm", ".wav": "audio/wav", ".mp3": "audio/mpeg", ".ogg": "audio/ogg",
  ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".glb": "model/gltf-binary", ".gltf": "model/gltf+json",
  ".wasm": "application/wasm", ".bin": "application/octet-stream", ".obj": "text/plain", ".mtl": "text/plain", ".ktx2": "image/ktx2",
};

function fileFor(urlPath, search) {
  let p = decodeURIComponent(urlPath);
  let upstream = ORIGIN + urlPath + search;
  const ext = /^\/__ext\/([^/]+)(\/.*)$/.exec(p);
  if (p.split(/[\\/]/).some((s) => s === "..") || p.includes("\0") || p.includes("\\")) throw new Error("Invalid path");
  if (ext && !EXTERNAL_HOSTS.includes(ext[1])) throw new Error("Unknown external host");
  if (ext) upstream = `https://${ext[1]}${urlPath.slice(6 + ext[1].length)}${search}`;
  else if (!/\.[A-Za-z0-9]{1,6}$/.test(p)) p = `/__routes${p.replace(/\/+$/, "")}/__page`;
  if (p.endsWith("/")) p += "__index";
  if (ext && ext[1] === "fonts.googleapis.com" && search) p += "__" + Buffer.from(search).toString("base64url") + ".css";
  // images.evetech.net/types/1/icon?size=64 — keep the size apart
  if (ext && ext[1] === "images.evetech.net" && search) p += "__" + search.slice(1).replace(/[^\w=]/g, "_");
  const f = path.join(SITE, ...p.split("/").filter(Boolean).map((s) => s.replace(/[<>:"|?*]/g, "_")));
  if (!f.startsWith(SITE + path.sep)) throw new Error("Invalid path");
  return { f, upstream, ext: !!ext, route: p.startsWith("/__routes") };
}

function typeOf(f, route) {
  if (route) return f.includes(`${path.sep}auth${path.sep}`) ? "application/json" : "text/html; charset=utf-8";
  return TYPES[path.extname(f).toLowerCase()] || "application/octet-stream";
}

async function fill(upstream, f) {
  if (!guestCookie && upstream.startsWith(ORIGIN)) {
    const r = await fetch(`${ORIGIN}/auth/login?next=/`, { redirect: "manual", headers: { "user-agent": UA } });
    guestCookie = (r.headers.getSetCookie?.() || []).map((c) => c.split(";")[0]).join("; ");
  }
  const r = await fetch(upstream, { redirect: upstream.startsWith(ORIGIN) ? "manual" : "follow", headers: { "user-agent": UA, ...(upstream.startsWith(ORIGIN) ? { cookie: guestCookie } : {}) } });
  if (r.status !== 200) return null;
  let buf = Buffer.from(await r.arrayBuffer());
  const ct = r.headers.get("content-type") || "";
  if (/text\/html/.test(ct) && /\.[a-z0-9]+$/i.test(new URL(upstream).pathname) && !/\.html?$/.test(new URL(upstream).pathname)) return null;
  if (/text|javascript|json|css/.test(ct)) {
    buf = Buffer.from(buf.toString("utf8")
      .replace(/(https?:)?\/\/(cdn\.jsdelivr\.net|unpkg\.com|esm\.sh|fonts\.googleapis\.com|fonts\.gstatic\.com|cdnjs\.cloudflare\.com|images\.evetech\.net|esi\.evetech\.net)\//g, "/__ext/$2/")
      .replace(/https?:\/\/eve-cs\.com\//g, "/"));
  }
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, buf);
  console.log("filled", upstream);
  return buf;
}

http.createServer(async (req, res) => {
 try {
  const u = new URL(req.url, "http://x");
  res.setHeader("Content-Security-Policy", "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self'; worker-src 'self' blob:; frame-src 'none'");
  if (!["GET", "HEAD"].includes(req.method)) { res.writeHead(405); return res.end(); }
  if (u.pathname === "/__offline/status") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ app: "eve-cs-offline", offline: !FILL, site: SITE, pid: process.pid })); }
  // The page asks who is signed in; offline there is no account, so it is a guest.
  if (u.pathname === "/auth/me") { res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }); return res.end('{"level":"guest"}'); }
  if (/^\/auth\//.test(u.pathname)) { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end('<h1>Offline mode</h1><p>EVE account services require the live site.</p><a href="/">Back to simulator</a>'); }
  if (u.pathname === "/scenario-editor.html") { res.writeHead(503, { "content-type": "text/html; charset=utf-8" }); return res.end('<h1>Editor unavailable</h1><p>The member-only editor was not included in this mirror.</p><a href="/">Back to simulator</a>'); }
  if (u.pathname === "/landing.html") u.pathname = "/";
  if (u.pathname === "/favicon.ico") u.pathname = "/assets/ui/favicon.svg";
  if (/^\/data\/scenarios\/(active|hidden)(\/[^.]*)?\/$/.test(u.pathname)) {
    const dir = path.join(SITE, ...u.pathname.split("/").filter(Boolean));
    if (fs.existsSync(dir) || u.pathname === "/data/scenarios/hidden/") {
      const entries = fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : [];
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(entries.map(e => `<a href="${encodeURIComponent(e.name)}${e.isDirectory() ? "/" : ""}">${e.name.replaceAll("&", "&amp;").replaceAll("<", "&lt;")}</a>`).join("\n"));
    }
  }
  // Prefer the canonical shells: guessed route downloads can contain redirects/errors.
  if (u.pathname.startsWith("/play/")) u.pathname = "/index.html";
  let { f, upstream, ext, route } = fileFor(u.pathname, u.search);
  let buf = null;
  if (fs.existsSync(f) && fs.statSync(f).isFile()) buf = fs.readFileSync(f);
  // Image size changes do not require another network-backed resource offline.
  if (!buf && /^\/__ext\/images\.evetech\.net\/types\/\d+\/(icon|render)$/.test(u.pathname)) {
    for (const size of [64, 128, 256, 512, 32]) {
      const candidate = fileFor(u.pathname, `?size=${size}`).f;
      if (fs.existsSync(candidate)) { buf = fs.readFileSync(candidate); f = candidate; break; }
    }
    if (!buf) {
      const [, id, kind] = /\/types\/(\d+)\/(icon|render)$/.exec(u.pathname);
      typeIcons ??= JSON.parse(fs.readFileSync(path.join(SITE, "data/sde/meta.json"), "utf8")).icons ?? {};
      const local = kind === "render" ? `assets/ui/ship-iso/${id}.png` : typeIcons[id];
      if (local) {
        const candidate = fileFor(new URL(local, "http://offline/").pathname, "").f;
        if (fs.existsSync(candidate)) { buf = fs.readFileSync(candidate); f = candidate; }
      }
    }
  }
  if (!buf && FILL) { try { buf = await fill(upstream, f); } catch (e) { console.log("fill failed", upstream, e.message); } }
  // Unknown SPA route: hand back the app shell so client-side routing takes over.
  if (!buf && route && !u.pathname.startsWith("/data/") && !ext) {
    const shell = path.join(SITE, "__routes", "__page");
    if (fs.existsSync(shell)) { buf = fs.readFileSync(shell); f = shell; }
  }
  if (!buf) {
    fs.appendFileSync(missLog, `${req.url}\n`);
    console.log("missing", req.url);
    res.writeHead(404, { "content-type": "text/plain" });
    return res.end("not in mirror");
  }
  const type = /^\/__ext\/images\.evetech\.net\//.test(u.pathname) ? "image/png" : typeOf(f, route);
  if (/text\/html/.test(type)) buf = Buffer.from(offlineText(buf.toString("utf8"), "html"));
  else if (/javascript|css|json/.test(type)) buf = Buffer.from(offlineText(buf.toString("utf8"), u.pathname === "/src/main.js" ? "main" : "text"));
  if (/^(video|audio)\//.test(type)) {
    res.setHeader("accept-ranges", "bytes");
    if (req.headers.range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      const start = match?.[1] ? Number(match[1]) : match?.[2] ? Math.max(0, buf.length - Number(match[2])) : NaN;
      const end = match?.[1] && match?.[2] ? Math.min(buf.length - 1, Number(match[2])) : buf.length - 1;
      if (!Number.isSafeInteger(start) || start > end || start >= buf.length) { res.writeHead(416, { "content-range": `bytes */${buf.length}` }); return res.end(); }
      const part = buf.subarray(start, end + 1);
      res.writeHead(206, { "content-type": type, "content-range": `bytes ${start}-${end}/${buf.length}`, "content-length": part.length });
      return res.end(req.method === "HEAD" ? undefined : part);
    }
  }
  res.writeHead(200, { "content-type": type, "content-length": buf.length, "cache-control": "no-cache" });
  res.end(req.method === "HEAD" ? undefined : buf);
 } catch (e) {
  console.error(e.message);
  res.writeHead(e.message.startsWith("Unrecognized") ? 503 : 400, { "content-type": "text/plain" }); res.end(e.message);
 }
}).listen(PORT, HOST, function () { console.log(`eve-cs mirror: http://localhost:${this.address().port}/  (site: ${SITE})${FILL ? "  [fill on: network enabled]" : "  [offline: no upstream requests]"}`); });
