import test from "node:test";
import assert from "node:assert/strict";
import {
  runHosted,
  installPageContext,
  farmerAccounts,
  cockpitRequestOptions,
} from "./context.ts";
import { listServerBots } from "../../../../web/src/plugin-api/index.ts";
test("compatible training uses the held owner service and never starts another pilot login", async () => {
  const paths: string[] = [];
  const result = await runHosted(
    701,
    "training-inspect",
    {},
    {
      token: "held-owner",
      fetch: async (input, init) => {
        const p = String(input);
        paths.push(`${init?.method ?? "GET"} ${p}`);
        assert.equal(new Headers(init?.headers).get("authorization"), "Bearer held-owner");
        assert.equal(p, "/api/plugins/uoc/training/701/service");
        return new Response(
          JSON.stringify(
            init?.method === "POST"
              ? {
                  task: {
                    taskID: "held-task",
                    characterID: 701,
                    domain: "training",
                    kind: "inspect",
                    ownerBotID: "owner",
                    endedAt: "now",
                    status: "stopped",
                    phase: "Training inspected",
                    readout: { characterID: 701 },
                  },
                }
              : { available: true, ownerBotID: "owner" },
          ),
          { status: 200 },
        );
      },
    },
  );
  assert.equal(result.botID, "held-task");
  assert.equal(paths.length, 2);
});
test("offline Training coalesces Start and reads ownership and Bot Host once per attempt", async () => {
  const id = 702;
  let starts = 0,
    rosterReads = 0,
    ownershipReads = 0;
  const fetcher: typeof fetch = async (input) => {
    const path = String(input);
    if (path === `/api/plugins/uoc/training/${id}/service`)
      return Response.json({ ok: true, available: false });
    if (path === `/api/pilot-training/ownership?characterID=${id}`) {
      ownershipReads++;
      return Response.json({
        ok: true,
        ownership: { characterID: id, owner: "OFF", online: false },
      });
    }
    if (path === "/api/bots") {
      rosterReads++;
      return Response.json({ ok: true, bots: [], hostedRunPolicy: { maxRuntimeMinutes: 60 } });
    }
    if (path.endsWith("/check"))
      return Response.json({
        ok: true,
        setup: {},
        name: "Inspect",
        policy: { riskClasses: [], restartSafe: false },
      });
    if (path === "/api/bots/start") {
      starts++;
      throw Error("lost response");
    }
    throw Error(path);
  };
  const options = { token: "fixture-owner", fetch: fetcher };
  const current = runHosted(id, "training-inspect", {}, options);
  assert.equal(current, runHosted(id, "training-inspect", {}, options));
  await assert.rejects(current, /lost response/);
  assert.equal(rosterReads, 1);
  assert.equal(ownershipReads, 1);
  await assert.rejects(runHosted(id, "training-inspect", {}, options), /lost response/);
  assert.equal(starts, 2);
  assert.equal(rosterReads, 2);
  assert.equal(ownershipReads, 2);
});

test("Training overlaps the offline ownership and roster checks, then uses the exact terminal Start reply", async () => {
  const characterID = 719;
  let rosterReads = 0,
    ownershipReads = 0,
    enterRoster!: () => void,
    releaseRoster!: () => void;
  const rosterEntered = new Promise<void>((resolve) => {
    enterRoster = resolve;
  });
  const rosterCanReturn = new Promise<void>((resolve) => {
    releaseRoster = resolve;
  });
  const run = runHosted(
    characterID,
    "training-inspect",
    { skillSheetOnly: true },
    {
      token: "training-terminal",
      fetch: async (input) => {
        const path = String(input);
        if (path.endsWith("/service")) return Response.json({ ok: true, available: false });
        if (path === "/api/bots") {
          rosterReads++;
          enterRoster();
          await rosterCanReturn;
          return Response.json({ ok: true, bots: [], hostedRunPolicy: { maxRuntimeMinutes: 60 } });
        }
        if (path.includes("/ownership")) {
          ownershipReads++;
          return Response.json({
            ok: true,
            ownership: { characterID, owner: "OFF", online: false },
          });
        }
        if (path.endsWith("/check"))
          return Response.json({
            ok: true,
            setup: { skillSheetOnly: true },
            name: "Inspect",
            policy: { riskClasses: [], restartSafe: false },
          });
        if (path === "/api/bots/start")
          return Response.json({
            ok: true,
            bot: {
              botID: "early-training",
              kind: "plugin",
              characterID,
              status: "stopped",
              phase: "Training skills read",
              endedAt: "2026-11-21T12:00:00Z",
              plugin: { pluginID: "uoc", run: "training-inspect", readout: { characterID } },
            },
          });
        throw Error(path);
      },
    },
  );
  await rosterEntered;
  try {
    assert.equal(ownershipReads, 1);
  } finally {
    releaseRoster();
  }
  assert.equal((await run).botID, "early-training");
  assert.equal(rosterReads, 1);
});

test("Training reads its terminal result independently of the cached overview roster", async (t) => {
  const characterID = 720,
    options = { baseUrl: "http://training-fixture", token: "training-fresh-result" };
  let started = false,
    finished = false,
    postStartReads = 0,
    resolveStart!: () => void;
  const startedReply = new Promise<void>((resolve) => {
    resolveStart = resolve;
  });
  const row = () => ({
    botID: "training-readback",
    characterID,
    kind: "plugin",
    status: finished ? "stopped" : "running",
    phase: finished ? "Training skills read" : "Reading current pilot",
    endedAt: finished ? "2026-11-21T12:00:00Z" : null,
    plugin: {
      pluginID: "uoc",
      run: "training-inspect",
      readout: finished ? { characterID } : null,
    },
  });
  const fake: typeof fetch = async (input) => {
    const path = new URL(String(input), options.baseUrl).pathname;
    if (path.endsWith("/service")) return Response.json({ ok: true, available: false });
    if (path.endsWith("/ownership"))
      return Response.json({ ok: true, ownership: { characterID, owner: "OFF", online: false } });
    if (path.endsWith("/check"))
      return Response.json({
        ok: true,
        setup: { skillSheetOnly: true },
        name: "Inspect",
        policy: { riskClasses: [], restartSafe: false },
      });
    if (path === "/api/bots/start") {
      started = true;
      resolveStart();
      return Response.json({ ok: true, bot: row() });
    }
    if (path === "/api/bots") {
      if (started) postStartReads++;
      return Response.json({
        ok: true,
        bots: started ? [row()] : [],
        hostedRunPolicy: { maxRuntimeMinutes: 60 },
      });
    }
    throw Error(path);
  };
  t.mock.method(globalThis, "fetch", fake);
  const result = runHosted(characterID, "training-inspect", { skillSheetOnly: true }, options);
  await startedReply;
  // Let Start clear WC's old roster, then publish an overview snapshot.
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal((await listServerBots(options))[0]?.phase, "Reading current pilot");
  finished = true;
  assert.equal((await listServerBots(options))[0]?.phase, "Reading current pilot");
  assert.equal((await result).phase, "Training skills read");
  assert.equal(postStartReads, 2, "one overview read and one fresh read of the action result");
});
test("MCC inspection keeps the original Start while Farmer owns or is acquiring the pilot", async () => {
  const characterID = 718;
  const first = { systemID: 300 },
    second = { systemID: 301 };
  let owner = "TRANSITION",
    roster: any[] = [];
  let starts = 0,
    ownerReads = 0,
    releaseStart: () => void = () => {};
  const waiting = new Promise<void>((resolve) => {
    releaseStart = resolve;
  });
  let dispatched: () => void = () => {};
  const inFlight = new Promise<void>((resolve) => {
    dispatched = resolve;
  });
  const fetcher: typeof fetch = async (input) => {
    const p = String(input);
    if (p === "/api/plugins/uoc/world")
      return Response.json({ ok: true, worldID: "mcc-inspect-owners" });
    if (p === "/api/bots")
      return Response.json({ ok: true, bots: roster, hostedRunPolicy: { maxRuntimeMinutes: 60 } });
    if (p === `/api/pilot-training/ownership?characterID=${characterID}`) {
      ownerReads++;
      return Response.json({ ok: true, ownership: { characterID, owner, online: false } });
    }
    if (p.endsWith("/check"))
      return Response.json({
        ok: true,
        setup: first,
        name: "Inspect",
        policy: { riskClasses: [], restartSafe: false },
      });
    if (p === "/api/bots/start") {
      starts++;
      dispatched();
      await waiting;
      throw Error("lost Start response");
    }
    throw Error(p);
  };
  const options = { token: "mcc-inspection-owner-fixture", fetch: fetcher };
  const original = runHosted(characterID, "mcc-inspect", first, options);
  await inFlight;
  try {
    assert.equal(runHosted(characterID, "mcc-inspect", first, options), original);
    await assert.rejects(runHosted(characterID, "mcc-inspect", second, options), /in flight/);
    assert.equal(ownerReads, 0);
    assert.equal(starts, 1);
  } finally {
    releaseStart();
  }
  await assert.rejects(original, /lost Start response/);
  await assert.rejects(runHosted(characterID, "mcc-inspect", second, options), /TRANSITION/);
  owner = "BOT";
  await assert.rejects(runHosted(characterID, "mcc-inspect", second, options), /BOT/);
  owner = "OFF";
  roster = [{ botID: "active-during-read", characterID, endedAt: null }];
  await assert.rejects(runHosted(characterID, "mcc-inspect", second, options), /active hosted run/);
  roster = [{ characterID, endedAt: null }];
  await assert.rejects(
    runHosted(characterID, "mcc-inspect", second, options),
    /roster is unreadable/,
  );
  assert.equal(starts, 1);
});

test("read-only inspection exposes pending receipts without treating the read itself as an unknown mutation", async () => {
  for (const [id, receipts] of [
    [703, []],
    [704, [{ intent: "unknown" }]],
  ] as const) {
    let row: any = null,
      starts = 0;
    const transport: typeof fetch = async (input) => {
      const p = String(input);
      let body: any;
      if (p.includes("/api/pilot-training/ownership"))
        body = {
          ownership: {
            characterID: Number(new URL(p, "http://fixture").searchParams.get("characterID")),
            owner: "OFF",
            online: false,
          },
        };
      else if (p.includes("/api/plugins/uoc/provisioning/") && p.endsWith("/service"))
        body = { available: false };
      else if (p === "/api/plugins/uoc/world") body = { worldID: "context-fixture-world" };
      else if (p === "/api/bots")
        body = { bots: row ? [row] : [], hostedRunPolicy: { maxRuntimeMinutes: 60 } };
      else if (p.endsWith("/check"))
        body = { setup: {}, name: "Inspect", policy: { riskClasses: [], restartSafe: false } };
      else if (p === "/api/bots/start") {
        starts++;
        row = {
          botID: `inspect-${id}`,
          characterID: id,
          kind: "plugin",
          status: "stopped",
          phase: "Provisioning inspected",
          endedAt: "2026-11-08T10:00:00Z",
          plugin: { pluginID: "uoc", run: "provision-inspect", readout: { pending: receipts } },
        };
        body = { bot: row };
      } else throw Error(p);
      return new Response(JSON.stringify({ ok: true, ...body }), { status: 200 });
    };
    const options = { token: `fixture-${id}`, fetch: transport };
    assert.equal(
      (await runHosted(id, "provision-inspect", {}, options)).phase,
      "Provisioning inspected",
    );
    assert.equal(starts, 1);
  }
});

test("Provisioning uses current hosted runs despite old Inspect and Apply intents", async (t) => {
  const characterID = 705,
    world = "old-provisioning-fixture";
  const archive = new Map(
    ["provision-inspect", "provision-apply"].map((kind) => [
      `uoc:restored:hosted:${world}:${characterID}:${kind}`,
      JSON.stringify({
        characterID,
        kind,
        setup: '{"goal":1}',
        beforeIDs: [],
        botID: "old-" + kind,
      }),
    ]),
  );
  const saved = [...archive];
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => archive.get(key) ?? null,
      setItem: (key: string, value: string) => archive.set(key, value),
      removeItem: (key: string) => archive.delete(key),
    },
  });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, "sessionStorage", descriptor);
    else Reflect.deleteProperty(globalThis, "sessionStorage");
  });
  const rows: any[] = [],
    starts: string[] = [];
  for (const kind of ["provision-inspect", "provision-apply"])
    rows.push({
      botID: "old-" + kind,
      characterID,
      kind: "plugin",
      plugin: { pluginID: "uoc", run: kind, readout: { pending: true } },
      endedAt: "2026-11-08T10:00:00Z",
      phase: "Apply unresolved",
    });
  const fetcher: typeof fetch = async (input, init) => {
    const p = String(input);
    let body: any;
    if (p.includes("/ownership"))
      body = { ownership: { characterID, owner: "OFF", online: false } };
    else if (p.endsWith("/service")) body = { available: false };
    else if (p === "/api/plugins/uoc/world")
      throw Error("Provisioning has no archived intent to scope");
    else if (p === "/api/bots") body = { bots: rows, hostedRunPolicy: { maxRuntimeMinutes: 60 } };
    else if (p.endsWith("/check"))
      body = {
        setup: { goal: 2 },
        name: "Provision",
        policy: { riskClasses: [], restartSafe: false },
      };
    else if (p === "/api/bots/start") {
      const kind = JSON.parse(String(init?.body)).run;
      starts.push(kind);
      const row = {
        botID: "new-" + starts.length,
        characterID,
        kind: "plugin",
        status: "stopped",
        phase: kind === "provision-inspect" ? "Provisioning inspected" : "Provisioning verified",
        endedAt: "2026-11-16T10:00:00Z",
        plugin: { pluginID: "uoc", run: kind, readout: { characterID, shipID: 42 } },
      };
      rows.push(row);
      body = { bot: row };
    } else throw Error(p);
    return Response.json({ ok: true, ...body });
  };
  const options = { token: "current-account", fetch: fetcher };
  const inspected = await runHosted(characterID, "provision-inspect", { goal: 2 }, options);
  assert.deepEqual(inspected.readout, { characterID, shipID: 42 });
  assert.equal(
    (await runHosted(characterID, "provision-apply", { goal: 2 }, options)).phase,
    "Provisioning verified",
  );
  assert.deepEqual(starts, ["provision-inspect", "provision-apply"]);
  assert.deepEqual([...archive], saved);
});

test("online core ownership never falls back to a new hosted login", async () => {
  let starts = 0;
  const transport: typeof fetch = async (input) => {
    const p = String(input);
    let data: any;
    if (p.endsWith("/service")) data = { available: false };
    else if (p === "/api/plugins/uoc/world") data = { worldID: "online-core-world" };
    else if (p === "/api/bots") data = { bots: [] };
    else if (p.startsWith("/api/pilot-training/ownership"))
      data = { ownership: { characterID: 709, owner: "BROWSER", online: true } };
    else {
      starts++;
      throw Error("Unexpected acquisition " + p);
    }
    return Response.json({ ok: true, ...data });
  };
  for (const kind of ["training-inspect", "training", "provision-inspect", "provision-apply"])
    await assert.rejects(
      runHosted(709, kind, {}, { token: "core-owner-fixture", fetch: transport }),
      /BROWSER \(online\)/,
    );
  assert.equal(starts, 0);
});

test("active UOC Provisioning uses only the read service and rejects Apply before dispatch", async () => {
  const paths: string[] = [];
  const transport: typeof fetch = async (input, init) => {
    const p = String(input);
    paths.push(p);
    assert.equal(p, "/api/plugins/uoc/provisioning/710/service");
    return Response.json({
      ok: true,
      ...(init?.method === "POST"
        ? {
            task: {
              taskID: "inspection",
              characterID: 710,
              domain: "provisioning",
              kind: "inspect",
              ownerBotID: "native-owner",
              endedAt: 1,
              status: "stopped",
              phase: "Provisioning inspected",
              readout: { canApply: false },
            },
          }
        : { available: true, ownerBotID: "native-owner" }),
    });
  };
  const opts = { token: "active-provision-fixture", fetch: transport };
  assert.equal(
    (await runHosted(710, "provision-inspect", {}, opts)).phase,
    "Provisioning inspected",
  );
  await assert.rejects(runHosted(710, "provision-apply", {}, opts), /existing operation owner/);
  assert.equal(paths.length, 3);
});

test("a replaced owner task cannot be accepted as the original result or trigger a second request", async () => {
  let posts = 0,
    gets = 0;
  const transport: typeof fetch = async (_input, init) => {
    if (init?.method === "POST") {
      posts++;
      return Response.json({
        task: {
          taskID: "original",
          characterID: 711,
          domain: "training",
          kind: "inspect",
          ownerBotID: "owner",
          setup: {},
          endedAt: null,
        },
      });
    }
    gets++;
    return Response.json(
      gets === 1
        ? { available: true, ownerBotID: "owner" }
        : {
            task: {
              taskID: "replacement",
              characterID: 711,
              domain: "training",
              kind: "inspect",
              ownerBotID: "owner",
              setup: {},
              endedAt: 1,
            },
          },
    );
  };
  await assert.rejects(
    runHosted(711, "training-inspect", {}, { token: "task-drift-fixture", fetch: transport }),
    /current pilot service changed/,
  );
  assert.equal(posts, 1);
});

test("existing Cockpit authorization is discoverable with its actual request options and no login", () => {
  const options = {
    token: "actual-token",
    baseUrl: "http://same-bff",
    fetch: async () => {
      throw Error("No request should occur");
    },
  };
  const session: any = {
    id: "existing",
    store: {
      get: () => ({ session: { username: "Pilot" }, station: { online: { characterID: 7 } } }),
    },
    flow: { sessionToken: () => options.token, requestOptions: () => options },
  };
  installPageContext({ sessions: [session] });
  try {
    assert.deepEqual(farmerAccounts(), ["Pilot"]);
    assert.equal(cockpitRequestOptions("actual-token"), options);
    assert.equal(cockpitRequestOptions("unknown"), null);
  } finally {
    installPageContext({});
  }
});
