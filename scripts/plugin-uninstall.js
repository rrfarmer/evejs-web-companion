#!/usr/bin/env node
"use strict";

// Remove everything a plugin keeps, before it leaves the build:
//
//   node scripts/plugin-uninstall.js <plugin id>
//
// Run it with the BFF STOPPED and the plugin still listed in plugins/index.ts:
// its backend is started on its own, asked to clean up after itself (its
// manifest's backend `cleanup`), and stopped; then its data directory
// (data/plugins/<id>) is deleted whatever the cleanup left. Only then take the
// plugin out of plugins/index.ts and rebuild.
//
// A plugin without a server part keeps nothing on the server; its per-browser
// settings live in each player's browser and go when the plugin does.

const path = require("node:path");
const { pathToFileURL } = require("node:url");
const config = require("../src/config");
const { createPluginHost } = require("../src/pluginHost");

async function main() {
  const id = process.argv[2];
  if (!id) {
    console.error("Say which plugin: node scripts/plugin-uninstall.js <plugin id>");
    process.exit(2);
  }
  const rootDir = path.resolve(__dirname, "..");
  const list = await import(pathToFileURL(path.join(rootDir, "plugins", "index.ts")).href);
  const listed = (list.PLUGINS || []).find((entry) => entry && entry.id === id);
  if (!listed) {
    console.error(`No plugin called "${id}" is in this build's plugin list (plugins/index.ts).`);
    process.exit(1);
  }
  // A plugin that will not load can run no cleanup of its own; its data still goes.
  let manifests = [];
  try {
    manifests = [(await listed.load()).default];
  } catch (error) {
    console.error(`${id}: it could not be loaded, so its own cleanup cannot run: ${error && error.message}`);
  }
  const host = createPluginHost({ rootDir, dataDir: config.dataDir, manifests, log: (line) => console.log(line) });
  await host.start();
  const outcome = await host.uninstall(id);
  host.stop();
  if (outcome.cleaned) {
    console.log(`${id}: cleaned up, and its data directory removed. Take it out of plugins/index.ts and rebuild.`);
  } else {
    console.log(`${id}: its own cleanup said "${outcome.error}"; its data directory was removed anyway.`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
