import test from "node:test";
import assert from "node:assert/strict";
import { registerRun, runControlRoutes } from "./runControl.ts";
test("current controllers disclose only exact requesting account and unregister on retirement", async () => {
  let stops = 0;
  const close = registerRun(
      { botID: "bot", characterID: 42, setup: { operationID: "op", operationRunID: "epoch" } },
      "Owner",
      () => {
        stops++;
      },
    ),
    legacy = registerRun({ botID: "legacy" }, "Owner", () => {});
  try {
    const request = (name: string) => ({ account: { username: name, accountID: 1 } }) as any;
    const a: any = await runControlRoutes["GET /runs/current"](request("owner")),
      b: any = await runControlRoutes["GET /runs/current"](request("other"));
    assert.deepEqual(a.body.runs, [
      { botID: "bot", characterID: 42, operationID: "op", operationRunID: "epoch", purpose: null },
    ]);
    assert.deepEqual(b.body.runs, []);
    const denied: any = await runControlRoutes["POST /runs/:botID/stop"]({
      ...request("other"),
      params: { botID: "bot" },
    });
    assert.equal(denied.status, 404);
    assert.equal(stops, 0);
    close();
    const retired: any = await runControlRoutes["GET /runs/current"](request("owner"));
    assert.deepEqual(retired.body.runs, []);
  } finally {
    close();
    legacy();
  }
});

test("only the current Hauler owner can check a pending unload, including during Stop", async () => {
  let available = false, checks = 0, stops = 0;
  const close = registerRun(
    { botID: "haul", characterID: 3, setup: { operationID: "op", operationRunID: "run" } },
    "HaulerAccount", () => { stops++; }, undefined,
    () => available ? async () => { checks++; available = false; } : undefined,
  );
  const request = (username: string) => ({ account: { username, accountID: 1 }, params: { botID: "haul" } }) as any;
  const check = (username: string) => runControlRoutes["POST /runs/:botID/check-unload"](request(username));
  try {
    assert.equal((await check("HaulerAccount")).status, 409);
    available = true;
    assert.equal((await check("AnotherAccount")).status, 404);
    assert.equal(checks, 0);
    const current: any = await runControlRoutes["GET /runs/current"](request("HaulerAccount"));
    assert.equal(current.body.runs[0].canCheckUnload, true);
    await runControlRoutes["POST /runs/:botID/stop"](request("HaulerAccount"));
    assert.deepEqual((await check("HaulerAccount")).body, { ok: true });
    assert.equal(checks, 1);
    assert.equal(stops, 1);
    assert.equal((await check("HaulerAccount")).status, 409);
  } finally {
    close();
  }
  assert.equal((await check("HaulerAccount")).status, 404);
});
