"use strict";

// The browser, held by a small process of its own so it outlives each CLI command and hears every
// console error between them. `gridcheck web` starts it (tool/browser.js) and asks it things over
// HTTP on 127.0.0.1. Playwright comes from the folder `gridcheck web setup` installed it in; the
// tool itself has no dependencies.

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { createRequire } = require("node:module");

const config = JSON.parse(process.env.GRIDCHECK_WEB_HOST || "{}");
const { chromium } = createRequire(path.join(config.modulesDir, "package.json"))("playwright-core");

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_EVENTS = 500;

let page = null;
let context = null;
let seq = 0;
const events = [];

function record(event) {
  events.push({ seq: ++seq, atMs: Date.now(), ...event });
  if (events.length > MAX_EVENTS) events.shift();
}

function watchPage(target) {
  target.on("pageerror", (error) => record({ what: "exception", text: String(error && error.message || error).slice(0, 500) }));
  target.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    // Each failed request also logs this; a failure that matters is its own response line.
    if (/^Failed to load resource/.test(text)) return;
    record({ what: "console", text: text.slice(0, 500) });
  });
  target.on("response", (response) => {
    if (response.status() >= 500 && /\/api\//.test(response.url())) record({ what: "response", status: response.status(), url: response.url() });
  });
  target.on("dialog", (dialog) => {
    record({ what: "dialog", text: dialog.message().slice(0, 300) });
    dialog.accept().catch(() => {});
  });
}

// A node, as a scenario names it, to a Playwright locator. Strict: two matches are an error that
// lists them, unless index picks one.
function locate(node, root = page) {
  const named = typeof node === "string" ? { text: node } : node;
  let scope = root;
  if (named.within) scope = locate(named.within, root);
  const exact = named.exact === true;
  let found;
  if (named.css) found = scope.locator(named.css);
  else if (named.role) found = scope.getByRole(named.role, { ...(named.name ? { name: named.name } : {}), exact });
  else if (named.label) found = scope.getByLabel(named.label, { exact });
  else if (named.placeholder) found = scope.getByPlaceholder(named.placeholder, { exact });
  else if (named.text) found = scope.getByText(named.text, { exact });
  else throw new Error("a node needs role, css, label, placeholder or text");
  return Number.isInteger(named.index) ? found.nth(named.index) : found;
}

const OPS = {
  async goto({ url }) {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    return { url: page.url() };
  },
  async click({ node, timeoutMs = DEFAULT_TIMEOUT_MS }) {
    await locate(node).click({ timeout: timeoutMs });
    return {};
  },
  async fill({ node, value, timeoutMs = DEFAULT_TIMEOUT_MS }) {
    await locate(node).fill(String(value), { timeout: timeoutMs });
    return {};
  },
  async select({ node, option, timeoutMs = DEFAULT_TIMEOUT_MS }) {
    const chosen = await locate(node).selectOption({ label: String(option) }, { timeout: timeoutMs });
    return { chosen };
  },
  async press({ key, node }) {
    if (node) await locate(node).press(String(key));
    else await page.keyboard.press(String(key));
    return {};
  },
  async count({ node }) {
    return { count: await locate(node).count() };
  },
  async text({ node, timeoutMs = DEFAULT_TIMEOUT_MS }) {
    return { text: await locate(node).innerText({ timeout: timeoutMs }) };
  },
  // What an agent reads to find its way: roles and names, as the page exposes them.
  async snapshot({ node }) {
    return { snapshot: await (node ? locate(node) : page.locator("body")).ariaSnapshot({ timeout: DEFAULT_TIMEOUT_MS }) };
  },
  // Waits until the node shows (with `text` in it, or `count` of them), or isn't there with
  // hidden: true. A failure says what it found instead.
  async expect({ node, text = null, count = null, hidden = false, timeoutMs = DEFAULT_TIMEOUT_MS }) {
    const found = locate(node);
    const deadline = Date.now() + timeoutMs;
    let last = "";
    for (;;) {
      const visible = await found.filter({ visible: true }).count().catch((error) => {
        last = `couldn't read the page: ${errorWords(error)}`;
        return null;
      });
      if (visible === null) {
        // Tried again until the deadline. Not knowing isn't none showing: a broken selector or a dead
        // page must not pass hidden or count: 0.
      } else if (hidden) {
        if (!visible) return { text: "" };
        last = `${visible} still showing`;
      } else if (count !== null) {
        if (visible === count) return { text: `${count} showing` };
        last = `${visible} showing`;
      } else if (!visible) {
        last = "none showing";
      } else {
        const shown = await found.filter({ visible: true }).first().innerText({ timeout: 1_000 }).catch(() => "");
        if (text === null || shown.toLowerCase().includes(String(text).toLowerCase())) return { text: shown.replace(/\s+/g, " ").slice(0, 300) };
        last = `showing: ${shown.replace(/\s+/g, " ").slice(0, 300)}`;
      }
      if (Date.now() >= deadline) {
        const wanted = hidden ? "to be gone" : count !== null ? `${count} showing` : text !== null ? `to contain "${text}"` : "to show";
        throw new Error(`expected ${JSON.stringify(node)} ${wanted} within ${timeoutMs} ms; ${last}`);
      }
      await new Promise((resolve) => { setTimeout(resolve, 250); });
    }
  },
  async screenshot({ out }) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    await page.screenshot({ path: out, type: path.extname(out).toLowerCase() === ".png" ? "png" : "jpeg" });
    return { file: out };
  },
  async evaluate({ code }) {
    return { value: await page.evaluate(code) };
  },
  async viewport({ width, height }) {
    await page.setViewportSize({ width: Number(width), height: Number(height) });
    return {};
  },
  async events({ since = 0 }) {
    return { events: events.filter((event) => event.seq > since), last: seq };
  },
  async status() {
    return { url: page.url(), channel: config.channel || "bundled", last: seq, pid: process.pid };
  },
};

// Playwright's error with its colours and its retry lines taken out. What blocked a click stays.
function errorWords(error) {
  const lines = String(error && error.message || error).replace(/\u001b\[[0-9;]*m/g, "").split(/\r?\n/);
  const seen = new Set();
  return lines.filter((line) => {
    const key = line.trim().replace(/^[0-9]+ × /, "");
    if (!key || seen.has(key) || /^- (retrying|waiting \d+ms|done scrolling|scrolling into view)/.test(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 12).join("\n").slice(0, 1500);
}

async function launch() {
  const options = { headless: true, viewport: { width: 1600, height: 1000 } };
  const channels = config.channel ? [config.channel] : ["msedge", "chrome", undefined];
  let failure = null;
  for (const channel of channels) {
    try {
      context = await chromium.launchPersistentContext(config.profile, { ...options, ...(channel ? { channel } : {}) });
      config.channel = channel || null;
      return;
    } catch (error) {
      failure = error;
    }
  }
  throw failure;
}

async function main() {
  await launch();
  page = context.pages()[0] || await context.newPage();
  watchPage(page);
  context.on("page", (other) => watchPage(other));
  const server = http.createServer((request, response) => {
    let text = "";
    request.on("data", (chunk) => { text += chunk; });
    request.on("end", async () => {
      const send = (status, body) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
      };
      try {
        const { op, ...args } = text ? JSON.parse(text) : { op: "status" };
        if (op === "stop") {
          send(200, { ok: true, pid: process.pid });
          await context.close().catch(() => {});
          process.exit(0);
        }
        if (!OPS[op]) return send(400, { ok: false, error: `no such browser op: ${op}` });
        return send(200, { ok: true, ...(await OPS[op](args)) });
      } catch (error) {
        return send(200, { ok: false, error: errorWords(error) });
      }
    });
  });
  server.listen(config.port, "127.0.0.1", () => {
    console.log(`browser host on 127.0.0.1:${config.port}, ${config.channel || "bundled chromium"}`);
  });
}

main().catch((error) => {
  console.error(String(error && error.stack || error));
  process.exit(1);
});
