"use strict";

// The companion plugin's tool half: steps, commands and MCP tools for the web client and for
// colonies. Contract: Gridcheck's core/plugins.js. Guide: docs/gridcheck.md.

const fs = require("node:fs");
const path = require("node:path");

const { browserOp, playwrightInstalled, readBrowserState, setupBrowser, startBrowser, stopBrowser } = require("./browser");
const colony = require("./colony");
const { botEvents, newestRun, runFinished } = require("./botLog");
const { NODE_KEYS, nodeFromFlags, nodeProblems } = require("./nodes");
const web = require("./webClient");

const KINDS = {
  WEB: { what: "str", url: "str", commit: "str", dirty: "bool", image: "str", channel: "str" },
  WEB_ERROR: { what: "str", text: "str", url: "str", status: "num" },
  COLONY: {
    characterID: "id", user: "str", planetID: "id", planetName: "str", level: "num", pins: "num", extractors: "num",
    extracting: "num", finished: "num", launchpadUnits: "num", commandUnits: "num", routes: "num",
  },
  BOT: { characterID: "id", run: "str", what: "str", says: "str", phase: "str", status: "str", reason: "str", ok: "bool" },
};

const FORMAT = {
  WEB: (event) => [`web client ${event.what}${event.commit ? ` at ${event.commit}${event.dirty ? " plus uncommitted changes" : ""}` : ""}${event.url ? ` ${event.url}` : ""}`, ""],
  WEB_ERROR: (event) => [`page ${event.what}: ${event.status ? `${event.status} ${event.url}` : event.text}`, ""],
  COLONY: (event) => [`${event.planetName || event.planetID}: ${event.extracting} extracting, ${event.finished} finished, ` +
    `${event.launchpadUnits} on launchpads, ${event.commandUnits} in the command centre`, ""],
  BOT: (event) => [`${event.what === "end" ? `ended ${event.status}: ${event.reason || ""}` : event.what === "phase" ? event.phase
    : `${event.what} ${event.says || ""}${event.ok === false ? " REFUSED" : ""}`}`, ""],
};

// ---------- what steps and commands share ----------

// The page's errors since the last time anyone asked, as timeline events.
let lastErrorSeq = 0;
async function pageEvents(io) {
  if (!readBrowserState(io)) return [];
  const { events, last } = await browserOp(io, "events", { since: lastErrorSeq });
  lastErrorSeq = last;
  return events.map(({ seq: _seq, ...event }) => ({ kind: "WEB_ERROR", ...event }));
}

// A step's result, with the page errors that happened by the time it ended.
async function done(io, text, events = []) {
  return { ok: true, text, events: [...events, ...(await pageEvents(io))] };
}

async function webUp(io, options = {}) {
  const started = await web.startWebClient(io, options);
  const browser = await startBrowser(io);
  lastErrorSeq = 0;
  await browserOp(io, "goto", { url: started.url });
  return { started, browser };
}

function webUrlOf(io, target) {
  return /^https?:/.test(target) ? target : `${web.webUrl(web.serverPorts(io))}${target.startsWith("/") ? "" : "/"}${target}`;
}

// The page's own login: its form, for a new account too. Any password works there.
async function webLogin(io, user, timeoutMs = 30_000) {
  const account = { placeholder: "EveJS account" };
  // A page with no accounts opens the form by itself, a moment after it loads.
  try {
    await browserOp(io, "expect", { node: account, timeoutMs: 4_000 });
  } catch (_error) {
    await browserOp(io, "click", { node: { role: "button", name: "Add account" } });
  }
  await browserOp(io, "fill", { node: account, value: user });
  await browserOp(io, "fill", { node: { placeholder: "anything" }, value: "test" });
  await browserOp(io, "press", { key: "Enter", node: { placeholder: "anything" } });
  const shown = await browserOp(io, "expect", { node: { text: user, index: 0 }, timeoutMs });
  return `signed in as ${user}: ${shown.text}`;
}

let shots = 0;
async function webShot(io, label) {
  const runDir = io.runDir();
  const slug = String(label).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "shot";
  shots += 1;
  const name = `web-${String(shots).padStart(2, "0")}-${slug}.jpg`;
  const out = path.join(runDir || web.baseDir(io), "client", name);
  await browserOp(io, "screenshot", { out });
  return { out, event: { kind: "SCREENSHOT", reason: String(label), username: "web", file: runDir ? `client/${name}` : io.relativePath(out) } };
}

// Waits for a new bot run of the character to end or pause. seen: runs an earlier wait took.
const seenRuns = new Set();
async function botWait(io, user, timeoutMs) {
  const characterID = await colony.characterOf(io, user);
  const deadline = Date.now() + timeoutMs;
  let lines = [];
  let run = null;
  for (;;) {
    lines = await web.botLog(io, characterID);
    run = newestRun(lines);
    if (run && !seenRuns.has(`${characterID}:${run}`) && runFinished(lines, run)) break;
    if (Date.now() >= deadline) {
      const fresh = run && !seenRuns.has(`${characterID}:${run}`);
      const latest = fresh ? lines.filter((line) => line.run === run).at(-1) : null;
      throw new io.CliError(`no bot run of ${user} finished in ${Math.round(timeoutMs / 1000)} s; ` +
        (latest ? `it is at: ${latest.phase || latest.says || latest.kind}` : "none started"));
    }
    await io.sleep(1_000);
  }
  seenRuns.add(`${characterID}:${run}`);
  return { run, events: botEvents(lines, run, characterID) };
}

// ---------- steps ----------

const number = (value, fallback) => (value === undefined ? fallback : value);

function timeoutOf(raw, ctx, fallback) {
  if (raw.timeout === undefined) return fallback * 1000;
  if (!(typeof raw.timeout === "number" && raw.timeout > 0)) ctx.problem("timeout", "seconds, above 0");
  return Number(raw.timeout) * 1000;
}

function nodeField(raw, key, ctx) {
  for (const problem of nodeProblems(raw[key])) ctx.problem(key, problem);
  return raw[key];
}

function textField(raw, key, ctx, what) {
  if (typeof raw[key] !== "string" || !raw[key]) ctx.problem(key, what);
  return raw[key];
}

const STEPS = {
  webUp: {
    keys: () => [],
    parse: (raw, ctx) => {
      const value = raw.webUp;
      if (value !== true && (value === null || typeof value !== "object")) ctx.problem("webUp", 'true, or { "build": false, "image": "<tag>" }');
      return { options: value === true ? {} : value };
    },
    describe: () => "start the web client and a browser",
    async run(step, io) {
      const { started, browser } = await webUp(io, step.options);
      const text = `web client at ${started.commit || "?"}${started.dirty ? " plus uncommitted changes" : ""} on ${started.url}, browser ${browser.channel}`;
      return done(io, text, [{ kind: "WEB", what: "up", url: started.url, commit: started.commit, dirty: started.dirty, image: started.image, channel: browser.channel }]);
    },
  },
  webLogin: {
    keys: () => ["timeout"],
    parse: (raw, ctx) => ({ user: textField(raw, "webLogin", ctx, "the account name"), timeoutMs: timeoutOf(raw, ctx, 30) }),
    describe: (step) => `sign the page in as ${step.user}`,
    async run(step, io) {
      return done(io, await webLogin(io, step.user, step.timeoutMs));
    },
  },
  webOpen: {
    keys: () => [],
    parse: (raw, ctx) => ({ target: textField(raw, "webOpen", ctx, "a path on the web client, or a URL") }),
    describe: (step) => `open ${step.target}`,
    async run(step, io) {
      const { url } = await browserOp(io, "goto", { url: webUrlOf(io, step.target) });
      return done(io, `at ${url}`);
    },
  },
  webClick: {
    keys: () => ["timeout"],
    parse: (raw, ctx) => ({ locator: nodeField(raw, "webClick", ctx), timeoutMs: timeoutOf(raw, ctx, 15) }),
    describe: (step) => `click ${JSON.stringify(step.locator)}`,
    async run(step, io) {
      await browserOp(io, "click", { node: step.locator, timeoutMs: step.timeoutMs });
      return done(io, "clicked");
    },
  },
  webFill: {
    keys: () => ["value", "timeout"],
    parse: (raw, ctx) => {
      if (raw.value === undefined) ctx.problem("value", "what to type");
      return { locator: nodeField(raw, "webFill", ctx), value: raw.value, timeoutMs: timeoutOf(raw, ctx, 15) };
    },
    describe: (step) => `fill ${JSON.stringify(step.locator)}`,
    async run(step, io) {
      await browserOp(io, "fill", { node: step.locator, value: step.value, timeoutMs: step.timeoutMs });
      return done(io, `typed ${step.value}`);
    },
  },
  webSelect: {
    keys: () => ["option", "timeout"],
    parse: (raw, ctx) => ({ locator: nodeField(raw, "webSelect", ctx), option: textField(raw, "option", ctx, "the option's words"), timeoutMs: timeoutOf(raw, ctx, 15) }),
    describe: (step) => `choose ${step.option} in ${JSON.stringify(step.locator)}`,
    async run(step, io) {
      await browserOp(io, "select", { node: step.locator, option: step.option, timeoutMs: step.timeoutMs });
      return done(io, `chose ${step.option}`);
    },
  },
  webPress: {
    keys: () => ["node"],
    parse: (raw, ctx) => ({ key: textField(raw, "webPress", ctx, "a key: Enter, Escape, Tab ..."), locator: raw.node === undefined ? null : nodeField(raw, "node", ctx) }),
    describe: (step) => `press ${step.key}`,
    async run(step, io) {
      await browserOp(io, "press", { key: step.key, node: step.locator || undefined });
      return done(io, `pressed ${step.key}`);
    },
  },
  webExpect: {
    keys: () => ["text", "count", "hidden", "timeout"],
    parse: (raw, ctx) => {
      if (raw.count !== undefined && !(Number.isInteger(raw.count) && raw.count >= 0)) ctx.problem("count", "how many must show");
      if (raw.hidden !== undefined && typeof raw.hidden !== "boolean") ctx.problem("hidden", "true: it must not show");
      return { locator: nodeField(raw, "webExpect", ctx), contains: raw.text, count: raw.count, hidden: raw.hidden === true, timeoutMs: timeoutOf(raw, ctx, 15) };
    },
    describe: (step) => `the page shows ${JSON.stringify(step.locator)}${step.contains !== undefined ? ` with "${step.contains}"` : ""}`,
    async run(step, io) {
      const shown = await browserOp(io, "expect", {
        node: step.locator, timeoutMs: step.timeoutMs, hidden: step.hidden,
        ...(step.contains === undefined ? {} : { text: step.contains }), ...(step.count === undefined ? {} : { count: step.count }),
      });
      return done(io, shown.text ? `shows: ${shown.text}` : "as expected");
    },
  },
  webShot: {
    keys: () => [],
    parse: (raw) => ({ label: raw.webShot === true ? "page" : String(raw.webShot) }),
    describe: (step) => `a picture of the page: ${step.label}`,
    async run(step, io) {
      const { event } = await webShot(io, step.label);
      return done(io, event.file, [event]);
    },
  },
  botWait: {
    keys: () => ["timeout"],
    parse: (raw, ctx) => ({ user: textField(raw, "botWait", ctx, "the account whose bot to wait for"), timeoutMs: timeoutOf(raw, ctx, 600) }),
    describe: (step) => `wait for ${step.user}'s bot run to end`,
    async run(step, io) {
      const { run, events } = await botWait(io, step.user, step.timeoutMs);
      const end = events.at(-1);
      return done(io, `run ${run}: ${end.status}${end.reason ? `, ${end.reason}` : ""}`, events);
    },
  },
  colony: {
    recipe: true,
    keys: () => [],
    parse: (raw) => ({ spec: raw.colony }),
    describe: (step) => `build a colony on planet ${step.spec && step.spec.planetID}`,
    async run(step, io) {
      return { ok: true, text: await colony.buildColony(io, step.spec) };
    },
  },
  colonyAge: {
    recipe: true,
    keys: () => ["user", "planetID"],
    parse: (raw, ctx) => {
      if (!(typeof raw.colonyAge === "number" && raw.colonyAge > 0)) ctx.problem("colonyAge", "days, above 0");
      return { days: raw.colonyAge, user: raw.user, planetID: raw.planetID };
    },
    describe: (step) => `age ${step.user || "the character"}'s colonies by ${step.days} days`,
    async run(step, io) {
      return { ok: true, text: await colony.ageColonies(io, step) };
    },
  },
  colonyStock: {
    recipe: true,
    keys: () => ["user"],
    parse: (raw, ctx) => {
      const value = raw.colonyStock;
      if (value === null || typeof value !== "object") ctx.problem("colonyStock", '{ "planetID", "pin": "launchpad"|"command", "type", "quantity" }');
      const { type: commodity, ...rest } = value || {};
      return { ...rest, commodity, user: raw.user };
    },
    describe: (step) => `${step.quantity} ${step.commodity} in a colony's ${step.pin}`,
    async run(step, io) {
      return { ok: true, text: await colony.stockColony(io, { ...step, type: step.commodity }) };
    },
  },
  colonyRead: {
    recipe: true,
    keys: () => [],
    parse: (raw) => ({ user: raw.colonyRead === true ? null : String(raw.colonyRead) }),
    describe: (step) => `read ${step.user || "the character"}'s colonies`,
    async run(step, io) {
      const events = await colony.readColonies(io, step.user);
      return { ok: true, text: `${events.length} colonies`, events };
    },
  },
  pilotSlash: {
    recipe: true,
    keys: () => ["user"],
    parse: (raw, ctx) => ({ command: textField(raw, "pilotSlash", ctx, "a slash command"), user: textField(raw, "user", ctx, "the account of the online pilot") }),
    describe: (step) => `${step.user}: ${step.command}`,
    async run(step, io) {
      return pilotSlash(io, step.user, step.command);
    },
  },
  pluginSignal: {
    keys: () => ["signal"],
    parse: (raw, ctx) => ({ backend: textField(raw, "pluginSignal", ctx, "the plugin's id"), signal: raw.signal === undefined ? "SIGKILL" : String(raw.signal) }),
    describe: (step) => `${step.signal} to the ${step.backend} plugin's backend`,
    async run(step, io) {
      const count = await web.signalPluginBackend(io, step.backend, step.signal);
      return done(io, `${step.signal} to ${count} process(es)`);
    },
  },
};

// A slash command on a pilot someone else holds (the web client, a bot): the bridge finds its
// session by character. A login here would close theirs.
async function pilotSlash(io, user, command) {
  const characterID = await colony.characterOf(io, user);
  const reply = await io.bridge("POST", "/slash", { characterID, command });
  const refused = reply.handled && reply.success === false;
  const text = `${command} -> ${!reply.handled ? "not a command" : refused ? "refused" : "ok"}${reply.message ? `: ${reply.message}` : ""}`;
  return { ok: Boolean(reply.handled && !refused), text };
}

// ---------- commands ----------

function nodeArg(io, flags) {
  const node = nodeFromFlags(flags);
  if (!node) throw new io.CliError(`name a node: ${NODE_KEYS.filter((key) => key !== "within").map((key) => `--${key}`).join(", ")}`);
  return node;
}

function say(io, text) {
  io.print(text);
  return text;
}

const WEB_COMMANDS = {
  setup: async (_args, flags, io) => say(io, await setupBrowser(io, { bundled: Boolean(flags.bundled) })),
  use: async ([dir], flags, io) => {
    const chosen = web.chooseCheckout(io, { dir, reference: flags.reference });
    return say(io, `web client ${chosen.checkout}, reference data from ${chosen.reference}`);
  },
  up: async (_args, flags, io) => {
    const { started, browser } = await webUp(io, { dir: flags.dir, reference: flags.reference, build: !flags["no-build"], image: flags.image });
    say(io, `web client up at ${started.url}, ${started.commit || "?"}${started.dirty ? " plus uncommitted changes" : ""}, image ${started.image}; browser ${browser.channel}`);
  },
  down: async (_args, _flags, io) => {
    await web.stopWebClient(io);
    await stopBrowser(io);
    say(io, "web client and browser stopped");
  },
  status: async (_args, _flags, io) => {
    const settings = web.readSettings(io);
    const status = await web.webClientStatus(io);
    const browser = readBrowserState(io);
    say(io, `checkout   ${settings.dir || "none: gridcheck web use <checkout>"}\nreference  ${settings.reference || "this tree"}\n` +
      `playwright ${playwrightInstalled(io) ? "installed" : "not installed: gridcheck web setup"}\n` +
      `web client ${status.up ? `up at ${status.url}` : "down"}\nbrowser    ${browser ? `up, pid ${browser.pid}` : "down"}`);
  },
  open: async ([target = "/"], _flags, io) => say(io, (await browserOp(io, "goto", { url: webUrlOf(io, target) })).url),
  login: async ([user], _flags, io) => say(io, await webLogin(io, String(user))),
  click: async (_args, flags, io) => {
    await browserOp(io, "click", { node: nodeArg(io, flags) });
    say(io, "clicked");
  },
  fill: async ([value], flags, io) => {
    await browserOp(io, "fill", { node: nodeArg(io, flags), value });
    say(io, "typed");
  },
  select: async ([option], flags, io) => {
    await browserOp(io, "select", { node: nodeArg(io, flags), option });
    say(io, `chose ${option}`);
  },
  press: async ([key], flags, io) => {
    await browserOp(io, "press", { key, node: nodeFromFlags(flags) || undefined });
    say(io, `pressed ${key}`);
  },
  text: async (_args, flags, io) => say(io, (await browserOp(io, "text", { node: nodeArg(io, flags) })).text),
  snapshot: async (_args, flags, io) => say(io, (await browserOp(io, "snapshot", { node: nodeFromFlags(flags) || undefined })).snapshot),
  expect: async (_args, flags, io) => {
    const shown = await browserOp(io, "expect", { node: nodeArg(io, flags), hidden: Boolean(flags.hidden),
      ...(flags.contains === undefined ? {} : { text: flags.contains }), ...(flags.count === undefined ? {} : { count: Number(flags.count) }),
      timeoutMs: Number(number(flags.timeout, 15)) * 1000 });
    say(io, shown.text || "as expected");
  },
  shot: async ([label = "page"], _flags, io) => say(io, (await webShot(io, label)).out),
  errors: async (_args, _flags, io) => {
    const events = await pageEvents(io);
    say(io, events.length ? events.map((event) => JSON.stringify(event)).join("\n") : "no page errors since the last time");
  },
  viewport: async ([width, height], _flags, io) => {
    await browserOp(io, "viewport", { width, height });
    say(io, `${width}x${height}`);
  },
  bot: async ([user], flags, io) => {
    const characterID = await colony.characterOf(io, user);
    const lines = await web.botLog(io, characterID);
    const run = newestRun(lines);
    if (!run) return say(io, "no bot run yet");
    const events = botEvents(lines, run, characterID);
    if (flags.json) return say(io, JSON.stringify(events, null, 2));
    return say(io, events.map((event) => `${new Date(event.atMs).toISOString().slice(11, 19)} ${FORMAT.BOT(event)[0]}`).join("\n"));
  },
  "plugin-signal": async ([plugin, signal = "SIGKILL"], _flags, io) => {
    say(io, `${signal} to ${await web.signalPluginBackend(io, plugin, signal)} process(es)`);
  },
};

const WEB_USAGE = [
  "web setup [--bundled] | use <checkout> [--reference <tree with _local/sde>] | status",
  "web up [--dir <checkout>] [--reference <tree>] [--no-build] [--image <tag>] | down",
  "web open [<path>] | login <account> | snapshot [<node>] | text <node> | shot [<label>] | errors | viewport <w> <h>",
  "web click <node> | fill <value> <node> | select <option> <node> | press <key> [<node>] | expect <node> [--contains <text>] [--count N] [--hidden] [--timeout 15]",
  "web bot <account> [--json] | plugin-signal <plugin> [SIGKILL|SIGSTOP]",
  "  <node>: --role <role> [--name <words>] | --text <words> | --label | --placeholder | --css <selector>, with --exact, --index N",
];

async function cmdWeb(positionals, flags, io) {
  const [sub, ...rest] = positionals;
  const command = WEB_COMMANDS[sub];
  if (!command) throw new io.CliError(`usage:\n  gridcheck ${WEB_USAGE.join("\n  gridcheck ")}`);
  await command(rest, flags, io);
}

async function cmdColony(positionals, flags, io) {
  const [sub, ...rest] = positionals;
  if (sub === "build") {
    const spec = flags.file ? JSON.parse(fs.readFileSync(String(flags.file), "utf8")) : JSON.parse(String(flags.spec || "null"));
    say(io, await colony.buildColony(io, spec));
  } else if (sub === "age") {
    say(io, await colony.ageColonies(io, { user: rest[0], days: Number(flags.days), planetID: flags.planet ? Number(flags.planet) : undefined }));
  } else if (sub === "stock") {
    say(io, await colony.stockColony(io, { user: rest[0], planetID: Number(flags.planet), pin: flags.pin, type: flags.type, quantity: Number(flags.quantity) }));
  } else if (sub === "show") {
    const events = await colony.readColonies(io, rest[0]);
    say(io, events.length ? events.map((event) => FORMAT.COLONY(event)[0]).join("\n") : "no colonies");
  } else {
    throw new io.CliError("usage: gridcheck colony build --spec '<json>' | --file <json> | age [<account>] --days N [--planet ID] | " +
      "stock [<account>] --planet ID --pin launchpad|command --type <name> --quantity N | show [<account>]");
  }
}

async function cmdPilot(positionals, _flags, io) {
  const [user, sub, ...rest] = positionals;
  if (sub === "slash" && rest.length) {
    const result = await pilotSlash(io, user, rest.join(" "));
    say(io, result.text);
    if (!result.ok) io.setExitCode(2);
  } else if (sub === "grid") {
    const characterID = await colony.characterOf(io, user);
    say(io, JSON.stringify((await io.bridge("GET", `/grid?characterID=${characterID}`)).grid, null, 2));
  } else {
    throw new io.CliError("usage: gridcheck pilot <account> slash <command> | grid: on a pilot someone else holds, without logging it in");
  }
}

const COMMANDS = {
  web: {
    usage: WEB_USAGE,
    summary: "The web client under test and a browser: start them, read the page, click, type, and read the bot's flight recorder.",
    booleanFlags: ["exact", "hidden", "bundled", "no-build"],
    run: cmdWeb,
  },
  colony: {
    usage: ["colony build --spec '<json>' | --file <json>", "colony age [<account>] --days N [--planet ID]",
      "colony stock [<account>] --planet ID --pin launchpad|command --type <name> --quantity N", "colony show [<account>]"],
    summary: "Build a colony through the retail call, age it, put goods in it, and read it as the server settles it.",
    needs: "up",
    run: cmdColony,
  },
  pilot: {
    usage: ["pilot <account> slash <command> | grid"],
    summary: "A slash command or a grid read on a pilot someone else holds, without logging it in.",
    needs: "up",
    run: cmdPilot,
  },
};

// ---------- MCP ----------

const str = (description, extra = {}) => ({ type: "string", description, ...extra });

const NODE_PROPERTIES = {
  role: str("ARIA role, e.g. button, tab, combobox."),
  name: str("With role: the accessible name it contains."),
  text: str("Text it contains."),
  label: str("Its label."),
  placeholder: str("Its placeholder."),
  css: str("A CSS selector."),
  exact: { type: "boolean", description: "Match the words exactly." },
  index: { type: "integer", description: "Which of several matches, from 0." },
};

function nodeArgs(params) {
  const args = [];
  for (const key of ["role", "name", "text", "label", "placeholder", "css", "index"]) {
    if (params[key] !== undefined) args.push(`--${key}=${params[key]}`);
  }
  if (params.exact) args.push("--exact");
  return args;
}

const WEB_TOOL = {
  name: "web",
  description: "The web client under test and its browser. Start with action status. setup installs Playwright; use names the checkout; " +
    "up builds it and starts it against this tree's server with a signed-out browser. Read the page with snapshot (roles and names), " +
    "then click, fill, select, press and expect, naming a node by role and name. errors lists page errors; bot prints a pilot's bot run. A scenario does all of this with web steps.",
  inputSchema: {
    type: "object",
    properties: {
      action: str("What to do.", { enum: Object.keys(WEB_COMMANDS) }),
      value: str("up/use: the checkout; open: the path; login, bot: the account; fill: the text; select: the option; press: the key; shot: the label; plugin-signal: the plugin."),
      reference: str("use, up: a tree with _local/sde."),
      contains: str("expect: text the node must contain."),
      count: { type: "integer", description: "expect: how many must show." },
      hidden: { type: "boolean", description: "expect: it must not show." },
      timeout: { type: "number", description: "expect: seconds to wait." },
      noBuild: { type: "boolean", description: "up: use the image already built." },
      ...NODE_PROPERTIES,
    },
    required: ["action"],
    additionalProperties: false,
  },
  args: (params) => {
    const args = ["web", params.action];
    if (params.action === "up") {
      if (params.value) args.push(`--dir=${params.value}`);
    } else if (params.value !== undefined) {
      args.push(String(params.value));
    }
    if (params.reference) args.push(`--reference=${params.reference}`);
    if (params.contains !== undefined) args.push(`--contains=${params.contains}`);
    if (params.count !== undefined) args.push(`--count=${params.count}`);
    if (params.timeout !== undefined) args.push(`--timeout=${params.timeout}`);
    if (params.hidden) args.push("--hidden");
    if (params.noBuild) args.push("--no-build");
    return [...args, ...nodeArgs(params)];
  },
};

const COLONY_TOOL = {
  name: "colony",
  description: "Colonies: show one account's as the server settles them, age them by days so production and expiry have happened, " +
    "put goods in a pin, or build one for the held character through the retail call.",
  inputSchema: {
    type: "object",
    properties: {
      action: str("What to do.", { enum: ["show", "age", "stock", "build"] }),
      user: str("The account; default the held character."),
      days: { type: "number", description: "age: how many." },
      planet: { type: "integer", description: "age, stock: one planet." },
      pin: str("stock: which pin.", { enum: ["launchpad", "command"] }),
      type: str("stock: the commodity's name."),
      quantity: { type: "integer", description: "stock: how many." },
      spec: { type: "object", description: 'build: { "planetID": 40161463, "level": 5, "extract": [{ "resource": "Base Metals", "make": "...", "into": "launchpad|command" }] }' },
    },
    required: ["action"],
    additionalProperties: false,
  },
  args: (params) => {
    const args = ["colony", params.action];
    if (params.user) args.push(params.user);
    if (params.days !== undefined) args.push(`--days=${params.days}`);
    if (params.planet !== undefined) args.push(`--planet=${params.planet}`);
    if (params.pin) args.push(`--pin=${params.pin}`);
    if (params.type) args.push(`--type=${params.type}`);
    if (params.quantity !== undefined) args.push(`--quantity=${params.quantity}`);
    if (params.spec) args.push(`--spec=${JSON.stringify(params.spec)}`);
    return args;
  },
};

const PRIMER = `Web client (plugin companion). Tests the EVE.js web companion against this tree's server, in a real browser. docs/gridcheck.md in the web client is the guide.
- Once: web setup (Playwright), web use <checkout> --reference <tree with _local/sde>. A worktree of the client is a checkout.
- A scenario starts its pilots from the recipe pi-colonies, or its own, and says "watch": { "pilot": "<account>" } to follow the web client's pilot (it may come and go; PILOT lines say so; no client view). Never login as that account: one login closes the other. The implicit login holds e2eagent, which is fine.
- Steps: webUp (builds the image; docker layer cache makes a rebuild quick), { "webLogin": "<account>" }, { "webOpen": "/path" }, { "webClick": <node> }, { "webFill": <node>, "value": ... }, { "webSelect": <node>, "option": ... }, { "webPress": "Enter" }, { "webExpect": <node>, "text"|"count"|"hidden", "timeout": 15 }, { "webShot": "label" }, { "botWait": "<account>", "timeout": 600 }, { "pluginSignal": "<plugin>", "signal": "SIGKILL" }.
- A node: { "role": "button", "name": "Refresh" } first; or text, label, placeholder, css; with exact and index; { "within": <node> } narrows it. Two matches are an error that lists them. Find names with web snapshot.
- Colonies: { "colony": { "planetID": 40161463, "extract": [{ "resource": "Base Metals" }] } } (held character, in a recipe), { "colonyAge": 8, "user": "<account>" }, { "colonyStock": { "planetID", "pin": "launchpad|command", "type": "Base Metals", "quantity": 1000 }, "user" }, { "colonyRead": "<account>" }, { "pilotSlash": "/setisk 5000000", "user": "<account>" }. Age moves stored times back, so production and expiry have happened at the next read, against the same wall clock the page uses.
- Kinds: WEB, WEB_ERROR (what: exception, console, response, dialog), COLONY (extracting, finished, launchpadUnits, commandUnits), BOT (what: issue, result, phase, end; says, phase, status, reason, ok), from the steps above. "until": { "any": ["COLONY finished=0"], "from": "start", "timeout": 60 } is the usual stop, since the checks happen in setup; put colonyRead last in setup.
- The web client stops with the run unless --keep-up; then web snapshot and web shot look at where it stopped. The run's web/ folder keeps the BFF log and bot logs.`;

module.exports = {
  kinds: KINDS,
  format: FORMAT,
  steps: STEPS,
  commands: COMMANDS,
  mcpTools: [WEB_TOOL, COLONY_TOOL],
  primer: PRIMER,
  async onStop(io, { runDir }) {
    await web.stopWebClient(io, { runDir });
    await stopBrowser(io);
  },
};
