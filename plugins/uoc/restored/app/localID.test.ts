import test from "node:test";
import assert from "node:assert/strict";
import { nextLocalID } from "./localID.ts";

test("MCC, Training and Provisioning can allocate distinct review IDs on LAN HTTP and HTTPS", (t) => {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const secure = nextLocalID();
  assert.match(secure, uuid);
  t.mock.getter(globalThis, "crypto", () => ({ getRandomValues: cryptoValues }) as Crypto);
  const ids = Array.from({ length: 20 }, () => nextLocalID());
  assert.ok(ids.every((id) => uuid.test(id)));
  assert.equal(new Set([secure, ...ids]).size, ids.length + 1);
});

const cryptoValues = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
