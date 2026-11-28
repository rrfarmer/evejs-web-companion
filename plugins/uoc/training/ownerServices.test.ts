import test from "node:test";
import assert from "node:assert/strict";
import { createOwnerTrainingServices } from "./ownerServices.ts";
import { createTrainingRun } from "./host.ts";
import { registerRun, pilotServiceOwner } from "../runControl.ts";
import type { PluginRunContext } from "../../../web/src/plugin-api/backend.ts";
import { hostedFetch, hostedRoute } from "../../../web/src/app/transport.ts";

function fixture(unknownPurchase = false) {
  const calls: string[] = [],
    parentReports: unknown[] = [];
  let bought = false,
    balance = 200,
    queue = [{ typeID: 11, toLevel: 1 }],
    active = true,
    releasePurchase: (() => void) | undefined;
  const purchaseWait = new Promise<void>((r) => {
    releasePurchase = r;
  });
  const ok = (v: object) => Response.json({ ok: true, ...v });
  const run = {
    botID: "physical-miner",
    characterID: 7,
    held: { characterID: 7 },
    setup: { operationID: "mining", operationRunID: "epoch" },
    resumed: false,
    resumeData: null,
    routeSettings: null,
    baseUrl: "http://wc",
    report: (v: unknown) => parentReports.push(v),
    fetch: async (input: any, init: any) => {
      const url = new URL(String(input));
      calls.push(url.pathname);
      if (url.pathname === "/api/plugins/uoc/world") return ok({ worldID: "owner-fixture-world" });
      if (url.pathname === "/api/client-data/type-prices")
        return url.searchParams.get("typeIDs") === "100"
          ? ok({ available: true, categoryID: { 100: 6 }, published: { 100: true } })
          : ok({ available: true, basePrice: { 10: 100 }, published: { 10: true } });
      if (url.pathname === "/api/client-data/required-skills")
        return ok({ available: true, required: { 100: { 10: 1 }, 10: {} } });
      if (url.pathname === "/api/types/type-lists") return ok({ lists: { 10: [93] } });
      if (url.pathname === "/api/bridge/skills")
        return ok({
          skills: {
            characterID: 7,
            skills: [{ typeID: 11, level: 0 }, ...(bought ? [{ typeID: 10, level: 0 }] : [])],
            queue: { active, entries: queue, maxEntries: 50 },
          },
        });
      const b = JSON.parse(init.body);
      calls.push(b.method);
      if (b.method === "GetCashBalance") return ok({ result: balance });
      if (b.method === "GetTransactions")
        return ok({
          result: {
            type: "list",
            items: bought
              ? [
                  {
                    type: "packedrow",
                    fields: {
                      transactionID: 3,
                      description: "Skill purchase",
                      amount: -130,
                      referenceID: 10,
                    },
                  },
                ]
              : [],
          },
        });
      if (b.method === "PurchaseSkills") {
        await purchaseWait;
        if (unknownPurchase) throw Error("Response was lost before a result could be established");
        bought = true;
        balance -= 130;
        return ok({ result: null });
      }
      if (b.method === "SaveNewQueue") {
        queue = b.args[0].entries.map((x: any) => ({ typeID: x[1][0], toLevel: x[1][1] }));
        active = b.kwargs.activate;
        return ok({ result: null });
      }
      throw Error(`Unexpected ${url.pathname} ${b.method}`);
    },
  } as unknown as PluginRunContext;
  const close = registerRun(run, "Trainee", () => {}),
    routes = createOwnerTrainingServices({
      owner: pilotServiceOwner,
      training: createTrainingRun({ reconcileDelayMs: 0 }),
    });
  const request = (username = "Trainee", setup: unknown = { goalTypeID: 100, maxSpendISK: 130 }) =>
    ({
      worldID: "owner-fixture-world",
      params: { characterID: "7" },
      account: { username, accountID: 1 },
      body: { kind: "train", setup },
    }) as any;
  const start = () => routes["POST /training/:characterID/service"](request());
  const status = async () =>
    ((await routes["GET /training/:characterID/service"](request())) as any).body;
  const finish = async () => {
    for (let i = 0; i < 100; i++) {
      const s = await status();
      if (s.task?.endedAt) return s.task;
      await new Promise((r) => setTimeout(r, 1));
    }
    throw Error("Training fixture did not settle");
  };
  return {
    run,
    calls,
    parentReports,
    close,
    request,
    routes,
    start,
    status,
    finish,
    releasePurchase: () => releasePurchase!(),
    get queue() {
      return queue;
    },
  };
}

test("training reuses exact MCC owner without login, parent reports or release and coalesces resume", async () => {
  const f = fixture();
  try {
    const first: any = await f.start(),
      second: any = await f.start();
    assert.equal(first.status, 202);
    assert.equal(second.body.task.taskID, first.body.task.taskID);
    f.releasePurchase();
    const result = await f.finish();
    assert.equal(result.status, "stopped");
    assert.equal(result.phase, "Training queued");
    assert.equal(f.calls.filter((x) => x === "PurchaseSkills").length, 1);
    assert.equal(f.calls.filter((x) => x === "SaveNewQueue").length, 1);
    assert.deepEqual(f.queue, [
      { typeID: 11, toLevel: 1 },
      { typeID: 10, toLevel: 1 },
    ]);
    assert.deepEqual(f.parentReports, []);
    assert.ok(pilotServiceOwner(7, "Trainee"));
    assert.equal(
      f.calls.some((x) => /login|logout|select|release|GiveCash/.test(x)),
      false,
    );
  } finally {
    f.close();
  }
});
test("foreign account and retired owner cannot borrow or release another operation", async () => {
  const f = fixture();
  try {
    const refused: any = await f.routes["POST /training/:characterID/service"](f.request("Other"));
    assert.equal(refused.status, 409);
    assert.equal(f.calls.length, 0);
    const original = pilotServiceOwner(7, "Trainee")!;
    f.close();
    assert.throws(original.current, /owner has ended/);
    const retired: any = await f.start();
    assert.equal(retired.status, 409);
  } finally {
    f.close();
  }
});
test("a current Training failure returns a result without replay in the held service", async () => {
  const f = fixture(true);
  try {
    await f.start();
    f.releasePurchase();
    const result = await f.finish();
    assert.equal(result.status, "error");
    assert.match(result.why, /not visible/);
    assert.equal(f.calls.filter((x) => x === "PurchaseSkills").length, 1);
    assert.equal(f.calls.includes("SaveNewQueue"), false);
  } finally {
    f.close();
  }
});
test("two compatible task requests cannot change the active fitting goal", async () => {
  const f = fixture();
  try {
    await f.start();
    const changed: any = await f.routes["POST /training/:characterID/service"](
      f.request("Trainee", { goalTypeID: 101, maxSpendISK: 130 }),
    );
    assert.equal(changed.status, 409);
    f.releasePurchase();
    await f.finish();
  } finally {
    f.close();
  }
});

test("read-only Provisioning shares the exact existing owner and cannot authorize equipment mutation", async () => {
  const f = fixture();
  try {
    const routes = createOwnerTrainingServices({
      owner: pilotServiceOwner,
      provisionInspect: {
        check: (setup) => ({
          ok: true,
          setup: setup as any,
          name: "Inspect",
          policy: { riskClasses: [], restartSafe: false },
        }),
        async start(run) {
          assert.equal(run.botID, f.run.botID);
          await run.fetch(new URL("/api/plugins/uoc/world", run.baseUrl));
          run.report({
            status: "stopped",
            phase: "Provisioning inspected",
            readout: { characterID: 7, canApply: true },
          });
          return { stop() {} };
        },
      },
    });
    const req = f.request() as any;
    req.body = { kind: "inspect", setup: {} };
    const started: any = await routes["POST /provisioning/:characterID/service"](req);
    assert.equal(started.status, 202);
    await new Promise((r) => setTimeout(r, 0));
    const result: any = await routes["GET /provisioning/:characterID/service"](req);
    assert.equal(result.body.access, "READ_ONLY_ACTIVE_UOC");
    assert.equal(result.body.task.readout.canApply, false);
    assert.equal(result.body.task.readout.equipmentMutation, "DENIED_ACTIVE_OPERATION");
    for (const kind of ["apply", "recover"]) {
      req.body = { kind, setup: {} };
      assert.equal(
        ((await routes["POST /provisioning/:characterID/service"](req)) as any).status,
        409,
      );
    }
    assert.deepEqual(f.parentReports, []);
    assert.equal(
      f.calls.some((x) => /login|logout|select|release|provision-ship/.test(x)),
      false,
    );
  } finally {
    f.close();
  }
});

test("world mismatch is refused before any service dispatch and domains serialize on one pilot", async () => {
  const f = fixture();
  try {
    const wrong = f.request() as any;
    wrong.worldID = "other-world";
    assert.equal(
      ((await f.routes["POST /training/:characterID/service"](wrong)) as any).status,
      409,
    );
    assert.deepEqual(f.calls, ["/api/plugins/uoc/world"]);
    await f.start();
    const req = f.request() as any;
    req.body = {
      kind: "inspect",
      setup: {
        corporationID: 5,
        fittingID: 6,
        goalTypeID: 7,
        fingerprint: "b".repeat(64),
        division: 7,
      },
    };
    assert.equal(
      ((await f.routes["POST /provisioning/:characterID/service"](req)) as any).status,
      409,
    );
    assert.equal(f.calls.includes("provision-ship"), false);
    f.releasePurchase();
    await f.finish();
    assert.equal((await f.status()).task.phase, "Training queued");
  } finally {
    f.close();
  }
});

test("only same-pilot read-only HR inspection is compatible with an active owner", async () => {
  const f = fixture();
  try {
    const req = f.request() as any;
    req.body = { kind: "member-inspect", setup: { stage: "member-inspect", authorityID: 8 } };
    assert.equal(((await f.routes["POST /training/:characterID/service"](req)) as any).status, 400);
    req.body = { kind: "invite", setup: { stage: "invite", authorityID: 7 } };
    assert.equal(((await f.routes["POST /training/:characterID/service"](req)) as any).status, 409);
    assert.deepEqual(f.parentReports, []);
  } finally {
    f.close();
  }
});

test("the borrowed owner remains protected when Farmer dispatches through the hosted route", async () => {
  const f = fixture();
  f.close();
  const priorities: unknown[] = [];
  const fetch = hostedFetch(
    async (input, init, priority) => {
      if (String(input).endsWith("/api/bridge/skills")) priorities.push(priority);
      return f.run.fetch(input, init);
    },
    "7",
    () => true,
  );
  const close = registerRun({ ...f.run, fetch }, "Trainee", () => {});
  let attach!: (fetch: typeof globalThis.fetch) => void;
  const attached = new Promise<typeof globalThis.fetch>((resolve) => {
    attach = resolve;
  });
  const routes = createOwnerTrainingServices({
    owner: pilotServiceOwner,
    provisionInspect: {
      check: () => ({
        ok: true,
        setup: {},
        name: "Inspect",
        policy: { riskClasses: [], restartSafe: false },
      }),
      start(run) {
        attach(run.fetch);
        return { stop() {} };
      },
    },
  });
  try {
    const request = { ...f.request(), body: { kind: "inspect", setup: {} } };
    assert.equal((await routes["POST /provisioning/:characterID/service"](request)).status, 202);
    const url = new URL("/api/bridge/skills", f.run.baseUrl).href;
    const route = hostedRoute(await attached, url, {});
    assert.ok(route);
    assert.equal(route.pilot, "7");
    assert.equal((await route.send(url, {}, "poll")).ok, true);
    close();
    await assert.rejects(route.send(url, {}, "user"), /original pilot owner has ended/);
    assert.deepEqual(priorities, ["poll"]);
  } finally {
    close();
  }
});
