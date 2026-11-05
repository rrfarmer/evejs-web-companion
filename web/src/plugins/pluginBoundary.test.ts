// THE LINE BETWEEN CORE AND PLUGINS, held by reading every import.
//
// A plugin imports the plugin API (web/src/plugin-api) and its own folder, and
// packages; nothing else of core. Core imports no plugin: it reads the build's
// plugin list (plugins/index.ts, plugins/views.ts) and nothing under a plugin's
// folder. Either break is how a plugin system decays back into one codebase:
// a plugin reaching into core breaks when core moves, and core reaching into a
// plugin cannot load without it.

import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const PLUGINS = path.join(ROOT, "plugins");
const API = path.join(ROOT, "web", "src", "plugin-api");
const LISTS = new Set([path.join(PLUGINS, "index.ts"), path.join(PLUGINS, "views.ts")]);

function sources(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries.flatMap((name) => {
    const full = path.join(dir, name);
    if (name === "node_modules") return [];
    if (statSync(full).isDirectory()) return sources(full);
    return /\.(ts|js|svelte)$/.test(name) ? [full] : [];
  });
}

/** Every relative module a file imports or requires, resolved to a path. */
function relativeImports(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const specifiers = [
    ...text.matchAll(/(?:import|export)\s[^"'`;]*?from\s*["']([^"']+)["']/g),
    ...text.matchAll(/import\s*\(\s*["']([^"']+)["']\s*\)/g),
    ...text.matchAll(/import\s*["']([^"']+)["']/g),
    ...text.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g),
  ].map((match) => match[1]!);
  return specifiers.filter((spec) => spec.startsWith(".")).map((spec) => path.resolve(path.dirname(file), spec));
}

const inside = (file: string, dir: string): boolean => file === dir || file.startsWith(dir + path.sep);

// A plugin's tests may drive it through core's own harness: a test is not shipped.
const isTest = (file: string): boolean => /\.test\.ts$/.test(file) || file.split(path.sep).includes("test");

test("a plugin imports only the plugin API and its own folder", () => {
  const strays: string[] = [];
  for (const file of sources(PLUGINS).filter((file) => !isTest(file))) {
    const own = LISTS.has(file) ? PLUGINS : path.join(PLUGINS, path.relative(PLUGINS, file).split(path.sep)[0]!);
    for (const target of relativeImports(file)) {
      if (inside(target, API) || inside(target, own)) continue;
      strays.push(`${path.relative(ROOT, file)} -> ${path.relative(ROOT, target)}`);
    }
  }
  assert.deepEqual(strays, [], "a plugin reaches into core past the plugin API");
});

test("core imports no plugin: only the build's plugin list", () => {
  const strays: string[] = [];
  for (const file of [...sources(path.join(ROOT, "web", "src")), ...sources(path.join(ROOT, "src"))]) {
    for (const target of relativeImports(file)) {
      if (inside(target, PLUGINS) && !LISTS.has(target)) strays.push(`${path.relative(ROOT, file)} -> ${path.relative(ROOT, target)}`);
    }
  }
  assert.deepEqual(strays, [], "core imports a plugin's own files");
});

test("the plugin API itself reaches only into core, never into a plugin", () => {
  for (const file of sources(API)) {
    for (const target of relativeImports(file)) assert.ok(!inside(target, PLUGINS), `${path.relative(ROOT, file)} imports a plugin`);
  }
});
