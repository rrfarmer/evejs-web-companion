"use strict";

// The CLI's side of the browser: installing Playwright, starting and stopping the browser host
// (browserHost.js), and asking it things.

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const { WEB_OFFSET, baseDir, run, serverPorts } = require("./webClient");

const PLAYWRIGHT_VERSION = "1.64.1";
const BROWSER_OFFSET = WEB_OFFSET + 1;

const stateFile = (io) => path.join(baseDir(io), "browser.json");
const modulesDir = (io) => path.join(baseDir(io), "playwright");

function playwrightInstalled(io) {
  return fs.existsSync(path.join(modulesDir(io), "node_modules", "playwright-core", "package.json"));
}

// Playwright goes in this tree's tool state, not in any repository: the tool has no dependencies,
// and the web client's package.json is its upstream's. It drives the Edge or Chrome this machine
// has; --bundled downloads a Chromium for one that has neither.
async function setupBrowser(io, { bundled = false } = {}) {
  const dir = modulesDir(io);
  fs.mkdirSync(dir, { recursive: true });
  const manifest = path.join(dir, "package.json");
  if (!fs.existsSync(manifest)) fs.writeFileSync(manifest, '{ "name": "gridcheck-web-browser", "private": true }\n');
  const shell = process.platform === "win32";
  const installed = await new Promise((resolve) => {
    const child = spawn("npm", ["install", "--no-audit", "--no-fund", `playwright-core@${PLAYWRIGHT_VERSION}`],
      { cwd: dir, shell, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("close", (status) => resolve({ status, output }));
    child.on("error", (error) => resolve({ status: 127, output: error.message }));
  });
  if (installed.status !== 0) throw new io.CliError(`npm couldn't install Playwright: ${installed.output.trim().slice(-400)}`);
  if (bundled) {
    const got = await run(process.execPath, [path.join(dir, "node_modules", "playwright-core", "cli.js"), "install", "chromium"], { cwd: dir, timeoutMs: 600_000 });
    if (got.status !== 0) throw new io.CliError(`Playwright couldn't download Chromium: ${got.stderr.trim().slice(-400)}`);
  }
  return `playwright-core ${PLAYWRIGHT_VERSION} in ${io.relativePath(dir)}${bundled ? ", with its Chromium" : ""}`;
}

function browserPort(io) {
  return serverPorts(io).game + BROWSER_OFFSET;
}

async function ask(port, body, timeoutMs) {
  const reply = await fetch(`http://127.0.0.1:${port}/`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  return reply.json();
}

function readBrowserState(io) {
  try {
    return JSON.parse(fs.readFileSync(stateFile(io), "utf8"));
  } catch (_error) {
    return null;
  }
}

// Starts a new browser host with an empty profile: a test always starts signed out.
async function startBrowser(io) {
  if (!playwrightInstalled(io)) throw new io.CliError("no Playwright yet: `gridcheck web setup` installs it");
  await stopBrowser(io);
  const port = browserPort(io);
  const profile = path.join(baseDir(io), "browser-profile");
  fs.rmSync(profile, { recursive: true, force: true });
  const logFile = path.join(baseDir(io), "browser.log");
  const log = fs.openSync(logFile, "w");
  const child = spawn(process.execPath, [path.join(__dirname, "browserHost.js")], {
    detached: true,
    windowsHide: true,
    stdio: ["ignore", log, log],
    env: { ...process.env, NODE_OPTIONS: "", GRIDCHECK_WEB_HOST: JSON.stringify({ port, profile, modulesDir: modulesDir(io) }) },
  });
  child.unref();
  fs.closeSync(log);
  fs.writeFileSync(stateFile(io), `${JSON.stringify({ pid: child.pid, port })}\n`);
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const status = await ask(port, { op: "status" }, 2_000);
      if (status.ok) return status;
    } catch (_error) {
      // Not listening yet.
    }
    if (!io.pidAlive(child.pid) || Date.now() > deadline) {
      throw new io.CliError(`the browser didn't start: ${fs.readFileSync(logFile, "utf8").trim().slice(-600)}`);
    }
    await io.sleep(250);
  }
}

async function stopBrowser(io) {
  const state = readBrowserState(io);
  if (!state) return false;
  fs.rmSync(stateFile(io), { force: true });
  try {
    await ask(state.port, { op: "stop" }, 5_000);
  } catch (_error) {
    // It was gone already, or didn't answer.
  }
  if (io.pidAlive(state.pid)) {
    try {
      process.kill(state.pid);
    } catch (_error) {
      // Gone between the check and the kill.
    }
  }
  return true;
}

// One browser op. A refusal is a CliError in Playwright's words, which name what it found.
async function browserOp(io, op, args = {}) {
  const state = readBrowserState(io);
  if (!state) throw new io.CliError("no browser is up: `gridcheck web up` starts one");
  let reply;
  try {
    reply = await ask(state.port, { op, ...args }, Math.max(60_000, (args.timeoutMs || 0) + 10_000));
  } catch (error) {
    throw new io.CliError(`the browser host didn't answer: ${error.message}`);
  }
  if (!reply.ok) throw new io.CliError(`web ${op}: ${reply.error}`);
  return reply;
}

module.exports = { PLAYWRIGHT_VERSION, browserOp, playwrightInstalled, readBrowserState, setupBrowser, startBrowser, stopBrowser };
