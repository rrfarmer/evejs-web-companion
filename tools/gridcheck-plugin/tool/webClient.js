"use strict";

// The web client under test: its BFF, built from a checkout into an image and run in a container on
// this tree's port block, on a volume of its own that goes when it stops.
//
// Everything it connects to must be this tree's server. The companion's defaults are the stock
// ports, which on this machine may be a server people play on, so a variable left unset here is a
// connection to that server. containerEnv sets every one, and web up refuses a checkout that reads
// a host, port or URL variable this file doesn't know.

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

// In the tree's block of 20 ports (core/ports.js): the core takes up to +10.
const WEB_OFFSET = 11;
const CONTAINER_PORT = 26500;
const HOST_FROM_CONTAINER = "host.docker.internal";
const BOT_LOGS = "/app/data/bot-logs";

const HANDLED_CONNECTION_VARS = new Set([
  "EVEJS_GATEWAY_URL", "EVEJS_GAME_HOST", "EVEJS_GAME_PORT", "EVEJS_PUBLIC_GATEWAY_URL", "EVEJS_XMPP_HOST", "EVEJS_XMPP_PORT",
]);

function baseDir(io) {
  return path.join(io.e2eDir, "companion");
}

function settingsFile(io) {
  return path.join(baseDir(io), "settings.json");
}

function readSettings(io) {
  try {
    return JSON.parse(fs.readFileSync(settingsFile(io), "utf8"));
  } catch (_error) {
    return {};
  }
}

function writeSettings(io, settings) {
  fs.mkdirSync(baseDir(io), { recursive: true });
  fs.writeFileSync(settingsFile(io), `${JSON.stringify(settings, null, 2)}\n`);
}

// Runs a program to its end, without blocking the run's watch. -> { status, stdout, stderr }
function run(command, args, { cwd, timeoutMs = 120_000, logFile = null } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const log = logFile ? fs.createWriteStream(logFile) : null;
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      if (log) log.write(chunk);
      else stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      if (log) log.write(chunk);
      stderr += chunk;
    });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    const finish = (status, extra = "") => {
      clearTimeout(timer);
      if (log) log.end();
      resolve({ status, stdout, stderr: `${stderr}${extra}` });
    };
    child.on("error", (error) => finish(127, error.message));
    child.on("close", (status) => finish(status === null ? 1 : status));
  });
}

async function docker(args, options) {
  return run("docker", args, options);
}

// This tree's own server, or nothing: the bridge vouches for it, and only a server `gridcheck up`
// started has its whole port block on record.
function serverPorts(io) {
  const handshake = io.requireHandshake();
  const started = io.readRun();
  const ports = started && started.ports;
  if (!ports || !handshake.ports || ports.game !== handshake.ports.game) {
    throw new io.CliError("the web client runs against a server `gridcheck up` started, so every port it needs is known; this one wasn't");
  }
  return ports;
}

const webPort = (ports) => ports.game + WEB_OFFSET;
const webUrl = (ports) => `http://127.0.0.1:${webPort(ports)}`;
const containerName = (ports) => `gridcheck-web-${ports.slot}`;
const volumeName = (ports) => `gridcheck-web-data-${ports.slot}`;

// The container's environment. Every connection it makes goes to `ports`.
function containerEnv(ports, { sdeFolder }) {
  const host = HOST_FROM_CONTAINER;
  return {
    EVEJS_GATEWAY_URL: `http://${host}:${ports.gateway}/_evejs-web/v1`,
    EVEJS_GAME_HOST: host,
    EVEJS_GAME_PORT: String(ports.game),
    EVEJS_PUBLIC_GATEWAY_URL: `https://${host}:${ports.gatewayTls}`,
    EVEJS_XMPP_HOST: host,
    EVEJS_XMPP_PORT: String(ports.xmpp),
    EVEJS_ROOT: "/srv/evejs",
    EVEJS_GAMESTORE_DATA_DIR: "/srv/evejs/_local/gameStore/data",
    EVEJS_SDE_DIR: `/srv/evejs/_local/sde/${sdeFolder}`,
    EVEJS_WEB_POC_DATA_DIR: "/app/data",
    PORT: String(CONTAINER_PORT),
    HOST: "0.0.0.0",
    NODE_ENV: "production",
  };
}

// The connection variables a checkout reads and containerEnv doesn't set. -> names
function unhandledConnectionVars(checkout) {
  const found = new Set();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (/\.c?js$/.test(entry.name) && !/\.test\./.test(entry.name)) {
        for (const match of fs.readFileSync(file, "utf8").matchAll(/\bEVEJS_(?:[A-Z0-9]+_)*(?:HOST|PORT|URL)\b/g)) found.add(match[0]);
      }
    }
  };
  walk(path.join(checkout, "src"));
  return [...found].filter((name) => !HANDLED_CONNECTION_VARS.has(name)).sort();
}

function sdeFolderIn(reference) {
  const root = path.join(reference, "_local", "sde");
  let names = [];
  try {
    names = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory() && /-jsonl$/.test(entry.name)).map((entry) => entry.name);
  } catch (_error) {
    return null;
  }
  return names[0] || null;
}

async function checkoutInfo(checkout) {
  const head = await run("git", ["rev-parse", "--short", "HEAD"], { cwd: checkout });
  const status = await run("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: checkout });
  return { commit: head.status === 0 ? head.stdout.trim() : null, dirty: status.status === 0 && status.stdout.trim() !== "" };
}

// Which checkout to test, and which tree's reference data (the static tables and the SDE) it reads.
function chooseCheckout(io, { dir, reference }) {
  const settings = readSettings(io);
  const checkout = path.resolve(String(dir || settings.dir || ""));
  const refTree = path.resolve(String(reference || settings.reference || io.treeRoot));
  if (!dir && !settings.dir) throw new io.CliError("which web client? `gridcheck web use <checkout> [--reference <tree with _local/sde>]`");
  if (!fs.existsSync(path.join(checkout, "src", "server.js")) || !fs.existsSync(path.join(checkout, "Dockerfile"))) {
    throw new io.CliError(`${checkout} is not a web client checkout (no src/server.js and Dockerfile)`);
  }
  if (!sdeFolderIn(refTree)) throw new io.CliError(`${refTree} has no _local/sde/*-jsonl; pass --reference with a tree that has it`);
  writeSettings(io, { ...settings, dir: checkout, reference: refTree });
  return { checkout, reference: refTree, sdeFolder: sdeFolderIn(refTree) };
}

async function imageFor(io, checkout, { build = true, image = null } = {}) {
  if (image) return String(image);
  const tag = `gridcheck-companion:${path.basename(checkout).toLowerCase().replace(/[^a-z0-9_.-]+/g, "-")}`;
  if (!build) return tag;
  const logFile = path.join(baseDir(io), "build.log");
  fs.mkdirSync(baseDir(io), { recursive: true });
  io.print(`web: building ${tag} from ${checkout}; log in ${io.relativePath(logFile)}`);
  const built = await docker(["build", "-t", tag, checkout], { timeoutMs: 1_200_000, logFile });
  if (built.status !== 0) {
    throw new io.CliError(`the web client's image didn't build: ${String(built.stderr).trim().split(/\r?\n/).slice(-6).join(" ")}`);
  }
  return tag;
}

// Starts the BFF, replacing one a previous run left. -> { url, commit, dirty, image, checkout }
async function startWebClient(io, options = {}) {
  const ports = serverPorts(io);
  const { checkout, reference, sdeFolder } = chooseCheckout(io, options);
  const unknown = unhandledConnectionVars(checkout);
  if (unknown.length) {
    throw new io.CliError(`this web client reads ${unknown.join(", ")}, which this plugin doesn't set, so it could reach a server ` +
      "other than this tree's. Add them to containerEnv (tools/gridcheck-plugin/tool/webClient.js in the web client) first.");
  }
  const image = await imageFor(io, checkout, options);
  const name = containerName(ports);
  const volume = volumeName(ports);
  await docker(["rm", "-f", name]);
  await docker(["volume", "rm", "-f", volume]);
  const envArgs = Object.entries(containerEnv(ports, { sdeFolder })).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
  const started = await docker(["run", "-d", "--name", name, "--label", "gridcheck-web=1",
    "--add-host", `${HOST_FROM_CONTAINER}:host-gateway`,
    "-p", `127.0.0.1:${webPort(ports)}:${CONTAINER_PORT}`,
    "-v", `${volume}:/app/data`, "-v", `${reference}:/srv/evejs:ro`,
    ...envArgs, image]);
  if (started.status !== 0) throw new io.CliError(`the web client's container didn't start: ${String(started.stderr).trim()}`);
  const url = webUrl(ports);
  const deadline = Date.now() + 120_000;
  for (;;) {
    let up = false;
    try {
      const reply = await fetch(`${url}/`, { signal: AbortSignal.timeout(3_000) });
      up = reply.status < 500;
    } catch (_error) {
      up = false;
    }
    if (up) break;
    if (Date.now() > deadline) {
      const logs = await docker(["logs", "--tail", "20", name]);
      throw new io.CliError(`the web client didn't answer in 120 s:\n${logs.stdout}${logs.stderr}`);
    }
    await io.sleep(1_000);
  }
  return { url, image, checkout, ...(await checkoutInfo(checkout)) };
}

async function webClientStatus(io) {
  let ports;
  try {
    ports = serverPorts(io);
  } catch (_error) {
    return { up: false };
  }
  const reply = await docker(["inspect", "--format", "{{.State.Status}}", containerName(ports)]);
  return { up: reply.status === 0 && reply.stdout.trim() === "running", url: webUrl(ports), name: containerName(ports) };
}

// Every container of ours. A run may end after the server went, when the block isn't known.
async function ourContainers() {
  const listed = await docker(["ps", "-a", "--filter", "label=gridcheck-web=1", "--format", "{{.Names}}"]);
  return listed.status === 0 ? listed.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) : [];
}

// Stops it and throws its data away, first keeping its log and bot logs in the run's folder.
async function stopWebClient(io, { runDir = null } = {}) {
  const started = io.readRun();
  const slot = started && started.ports ? started.ports.slot : null;
  for (const name of await ourContainers()) {
    // Another tree's web client is that tree's.
    if (slot !== null && name !== `gridcheck-web-${slot}`) continue;
    if (runDir) {
      const out = path.join(runDir, "web");
      fs.mkdirSync(out, { recursive: true });
      const logs = await docker(["logs", name]);
      fs.writeFileSync(path.join(out, "bff.log"), `${logs.stdout}${logs.stderr}`);
      await docker(["cp", `${name}:${BOT_LOGS}`, path.join(out, "bot-logs")]);
    }
    await docker(["rm", "-f", name]);
    await docker(["volume", "rm", "-f", name.replace("gridcheck-web-", "gridcheck-web-data-")]);
    io.print(`web: stopped ${name}`);
  }
}

// The bot's flight recorder for one character: [line] (empty before its first run).
async function botLog(io, characterID) {
  const ports = serverPorts(io);
  const reply = await docker(["exec", containerName(ports), "sh", "-c", `cat ${BOT_LOGS}/${Number(characterID)}.jsonl 2>/dev/null || true`], { timeoutMs: 20_000 });
  const lines = [];
  for (const text of reply.stdout.split(/\r?\n/)) {
    if (!text.trim()) continue;
    try {
      lines.push(JSON.parse(text));
    } catch (_error) {
      // A line still being written.
    }
  }
  return lines;
}

// A plugin's backend process in the container, signalled. Its process is the one whose environment
// names the plugin. The image has no kill, so node sends it.
async function signalPluginBackend(io, pluginID, signal) {
  const ports = serverPorts(io);
  const script = `const fs=require("fs");let n=0;for(const d of fs.readdirSync("/proc")){if(!/^[0-9]+$/.test(d))continue;` +
    `let e="";try{e=fs.readFileSync("/proc/"+d+"/environ","latin1")}catch{continue}` +
    `if(e.includes("EVEJS_PLUGIN_ID="+process.argv[1])&&Number(d)!==process.pid){process.kill(Number(d),process.argv[2]);n++}}console.log(n)`;
  const reply = await docker(["exec", containerName(ports), "node", "-e", script, pluginID, signal], { timeoutMs: 20_000 });
  if (reply.status !== 0) throw new io.CliError(`couldn't signal the ${pluginID} backend: ${reply.stderr.trim()}`);
  const count = Number(reply.stdout.trim()) || 0;
  if (!count) throw new io.CliError(`no running backend for plugin ${pluginID}`);
  return count;
}

module.exports = {
  HANDLED_CONNECTION_VARS,
  WEB_OFFSET,
  baseDir,
  botLog,
  chooseCheckout,
  containerEnv,
  containerName,
  readSettings,
  run,
  serverPorts,
  signalPluginBackend,
  startWebClient,
  stopWebClient,
  unhandledConnectionVars,
  webClientStatus,
  webUrl,
  writeSettings,
};
