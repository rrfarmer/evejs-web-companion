import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, sep } from "node:path";
import { nextLocalID } from "./localID.ts";

test("local identities use native UUIDs when available", (t) => {
  const uuid = "01234567-89ab-4cde-8012-3456789abcde";
  t.mock.method(globalThis.crypto, "randomUUID", () => uuid);
  assert.equal(nextLocalID(), uuid);
});

test("local identities stay distinct without randomUUID or crypto, even when the page loaded with a fixed clock and random source", async (t) => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto")!;
  t.after(() => Object.defineProperty(globalThis, "crypto", descriptor));
  t.mock.method(Date, "now", () => 1000);
  t.mock.method(Math, "random", () => 0.5);
  // The prefix is taken when the module loads, so load a fresh copy under the
  // fixed clock and random source: only the counter can keep these apart.
  const fresh: typeof import("./localID.ts") = await import(new URL("./localID.ts?fixed-clock", import.meta.url).href);
  const ids = new Set<string>();
  for (const crypto of [{}, undefined]) {
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: crypto });
    for (let i = 0; i < 100; i++) ids.add(fresh.nextLocalID());
  }
  assert.equal(ids.size, 200);
  assert.ok([...ids].every(id => id.startsWith("local-")));
});

test("browser code takes its ids from nextLocalID, never from crypto.randomUUID directly", () => {
  // randomUUID is missing on a LAN page served over plain HTTP, so a direct call
  // works on localhost and throws for every other machine. Plugin backends run
  // in Node, where it always exists.
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const offenders: string[] = [];
  for (const dir of ["web/src", "plugins"]) {
    for (const entry of readdirSync(join(root, dir), { recursive: true, encoding: "utf8" })) {
      const path = join(dir, entry);
      if (!/\.(ts|svelte)$/.test(path) || /\.test\.ts$/.test(path)) continue;
      if (path.split(sep).some(part => part === "backend" || part === "backend.ts" || part === "test")) continue;
      if (path === join("web/src/app/localID.ts")) continue;
      if (/\brandomUUID\b/.test(readFileSync(join(root, path), "utf8"))) offenders.push(path);
    }
  }
  assert.deepEqual(offenders, []);
});
