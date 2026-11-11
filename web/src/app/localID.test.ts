import test from "node:test";
import assert from "node:assert/strict";
import { nextLocalID } from "./localID.ts";

test("local identities use native UUIDs when available", (t) => {
  const uuid = "01234567-89ab-4cde-8012-3456789abcde";
  t.mock.method(globalThis.crypto, "randomUUID", () => uuid);
  assert.equal(nextLocalID(), uuid);
});

test("local identities stay distinct without randomUUID or crypto, even with a fixed clock and random source", (t) => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto")!;
  t.after(() => Object.defineProperty(globalThis, "crypto", descriptor));
  t.mock.method(Date, "now", () => 1000);
  t.mock.method(Math, "random", () => 0.5);
  const ids = new Set<string>();
  for (const crypto of [{}, undefined]) {
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: crypto });
    for (let i = 0; i < 100; i++) ids.add(nextLocalID());
  }
  assert.equal(ids.size, 200);
  assert.ok([...ids].every(id => id.length > 0));
});
