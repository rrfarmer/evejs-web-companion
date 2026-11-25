import { mkdtempSync, unlinkSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  createTrainingRun,
  trainingRun,
  trainingInspectRun,
  trainingTargets,
  fitTypes,
} from "./host.ts";
import { expandTrainingInspection, skillReviewKey, trainingSheetFromProof } from "./queue.ts";
import type { PluginRunContext } from "../../../web/src/plugin-api/backend.ts";

function fixture(
  failPurchase = false,
  corp = false,
  wallet?: { corporateBalance?: number; roles?: string },
) {
  let balance = corp ? 30 : 200,
    corpBalance = wallet?.corporateBalance ?? 1000,
    bought = false,
    queue: any[] = [],
    active = false;
  const transfers: { amount: number; reason: string }[] = [];
  const calls: string[] = [],
    reports: any[] = [];
  const response = (value: unknown) => Response.json({ ok: true, ...(value as object) });
  const fetcher: typeof fetch = async (url, init) => {
    const u = new URL(String(url));
    if (u.pathname === "/api/client-data/required-skills")
      return response({ available: true, required: { 100: { 10: 1 }, 10: {} } });
    if (u.pathname === "/api/client-data/type-prices")
      return u.searchParams.get("typeIDs") === "100"
        ? response({ available: true, categoryID: { 100: 6 }, published: { 100: true } })
        : response({ available: true, basePrice: { 10: 100 }, published: { 10: true } });
    if (u.pathname === "/api/types/type-lists") return response({ lists: { 10: [93] } });
    if (u.pathname === "/api/bridge/skills") {
      calls.push("readSkills");
      return response({
        skills: {
          characterID: 7,
          skills: bought ? [{ typeID: 10, level: 0 }] : [],
          queue: { active, entries: queue, maxEntries: 50 },
        },
      });
    }
    const body = JSON.parse(String(init?.body));
    calls.push(body.method);
    if (body.method === "GetCashBalance")
      return response({ result: body.args[0] === 1 ? corpBalance : balance });
    if (body.method === "GetCorporation")
      return response({ result: { type: "packedrow", fields: { corporationID: 98 } } });
    if (body.method === "GetMember")
      return response({
        result: {
          type: "packedrow",
          fields: { characterID: 7, corporationID: 98, roles: wallet?.roles ?? "134217728" },
        },
      });
    if (body.method === "GetTransactions") {
      const corporate = body.args[3] === true;
      const transferred = transfers.map(({ amount, reason }) => ({
        type: "packedrow",
        fields: {
          transactionID: corporate ? 2 : 1,
          description: reason,
          amount: corporate ? -amount : amount,
          ownerID1: 98,
          ownerID2: 7,
        },
      }));
      return response({
        result: {
          type: "list",
          items: [
            ...transferred,
            ...(!corporate && bought
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
              : []),
          ],
        },
      });
    }
    if (body.method === "GiveCashFromCorpAccount") {
      assert.equal(body.of, 98);
      assert.equal(body.args[0], 7);
      assert.equal(body.args[2], 1000);
      const amount = Number(body.args[1]);
      transfers.push({ amount, reason: body.kwargs.reason });
      balance += amount;
      corpBalance -= amount;
      return response({ result: null });
    }
    if (body.method === "PurchaseSkills") {
      if (failPurchase) throw Error("unknown");
      bought = true;
      balance -= 130;
      return response({ result: null });
    }
    if (body.method === "SaveNewQueue") {
      queue = body.args[0].entries.map((x: any) => ({ typeID: x[1][0], toLevel: x[1][1] }));
      active = body.kwargs.activate;
      return response({ result: null });
    }
    throw Error(`Unexpected ${body.method}`);
  };
  const run = {
    botID: "run",
    accountID: 1,
    characterID: 7,
    held: { characterID: 7 },
    resumed: false,
    setup: {
      goalTypeID: 100,
      maxSpendISK: 150,
      ...(corp ? { corporateFunding: true, corporationID: 98 } : {}),
    },
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    baseUrl: "http://local",
    fetch: fetcher,
    report: (v: unknown) => reports.push(v),
  } as unknown as PluginRunContext;
  let funding: unknown = null;
  const fundingDocument = () => ({
    read: () => structuredClone(funding),
    write(value: unknown) {
      funding = structuredClone(value);
    },
  });
  const worker = () => createTrainingRun({ reconcileDelayMs: 1, fundingDocument });
  return {
    run,
    worker,
    calls,
    reports,
    transfers,
    deposit: (isk: number) => {
      corpBalance += isk;
    },
    balances: () => ({ personal: balance, corporate: corpBalance }),
  };
}
async function finish(reports: any[]) {
  for (let i = 0; i < 100 && !reports.length; i++) await new Promise((r) => setTimeout(r, 1));
  assert.ok(reports.length);
}
test("recursive target order preserves prerequisite levels and rejects unknown graph", () => {
  assert.deepEqual(trainingTargets(100, { 100: { 20: 1 }, 20: { 10: 2 }, 10: {} }), [
    { typeID: 10, toLevel: 1 },
    { typeID: 10, toLevel: 2 },
    { typeID: 20, toLevel: 1 },
  ]);
  assert.throws(() => trainingTargets(100, { 100: { 10: 1 } }), /incomplete/);
});
test("corporation fit uses exact owner, hull and canonical fingerprint", () => {
  const tuples = [
      [20, 27, 1],
      [30, 87, 5],
      [40, 5, 100],
    ],
    canonical = [...tuples].sort((a, b) => a[0]! - b[0]!);
  const fingerprint = createHash("sha256")
    .update(JSON.stringify([100, canonical]))
    .digest("hex");
  const fields = {
    fittingID: 5,
    ownerID: 98,
    shipTypeID: 100,
    fitData: { type: "list", items: tuples },
  };
  const fit = {
    type: "dict",
    entries: [[5, { type: "object", args: { type: "dict", entries: Object.entries(fields) } }]],
  };
  assert.deepEqual(
    fitTypes(fit, {
      goalTypeID: 100,
      maxSpendISK: 0,
      corporationID: 98,
      fittingID: 5,
      fingerprint,
    }),
    [100, 20, 30],
  );
  assert.throws(
    () =>
      fitTypes(fit, {
        goalTypeID: 100,
        maxSpendISK: 0,
        corporationID: 98,
        fittingID: 5,
        fingerprint: "0".repeat(64),
      }),
    /changed/,
  );
});
test("purchase and queue are verified on the current skill sheet", async () => {
  const f = fixture(),
    run = createTrainingRun({ reconcileDelayMs: 1 });
  await run.start(f.run);
  await finish(f.reports);
  assert.equal(f.reports[0].phase, "Training queued");
  assert.equal(f.reports[0].readout.totalCents, 13000);
  assert.equal(f.calls.filter((x) => x === "readSkills").length, 4);
  assert.equal(f.calls.includes("GetTransactions"), false);
  assert.equal(f.calls.filter((x) => x === "PurchaseSkills").length, 1);
  assert.equal(f.calls.filter((x) => x === "SaveNewQueue").length, 1);
  assert.deepEqual(f.balances(), { personal: 70, corporate: 1000 });
});

test("pilot wallet only refuses insufficient personal funds before any transfer or purchase", async () => {
  const f = fixture(false, true);
  await createTrainingRun({ reconcileDelayMs: 1 }).start({
    ...f.run,
    setup: {
      goalTypeID: 100,
      maxSpendISK: 130,
      fundingPolicy: "CHARACTER_WALLET_ONLY",
    },
  });
  await finish(f.reports);
  assert.match(f.reports[0].why, /INSUFFICIENT_PERSONAL_FUNDS/);
  assert.equal(f.calls.includes("GetMember"), false);
  assert.equal(f.calls.includes("PurchaseSkills"), false);
  assert.deepEqual(f.balances(), { personal: 30, corporate: 1000 });
});

const corporateOnlySetup = {
  goalTypeID: 100,
  maxSpendISK: 130,
  corporationID: 98,
  fundingPolicy: "CORPORATION_WALLET_ONLY",
};

test("unrelated corporation income does not fund the same skillbooks twice on Start", async () => {
  const f = fixture();
  const fetch: typeof f.run.fetch = async (url, init) => {
    const response = await f.run.fetch(url, init);
    if (init?.body && JSON.parse(String(init.body)).method === "GiveCashFromCorpAccount")
      f.deposit(1);
    return response;
  };
  for (const botID of ["first", "second"]) {
    f.reports.length = 0;
    await f.worker().start({ ...f.run, botID, setup: corporateOnlySetup, fetch });
    await finish(f.reports);
    assert.equal(f.reports[0].phase, "Training queued", f.reports[0].why);
  }
  assert.deepEqual(
    f.transfers.map((t) => t.amount),
    [130],
  );
  assert.equal(f.calls.filter((c) => c === "PurchaseSkills").length, 1);
  assert.deepEqual(f.balances(), { personal: 200, corporate: 871 });
});

test("restarted Training rechecks an ambiguous transfer before spending or funding again", async (t) => {
  const f = fixture();
  const dir = mkdtempSync(path.join(tmpdir(), "uoc-training-funding-"));
  const file = path.join(dir, "training-onboarding.sqlite");
  const { createDocumentStore } = createRequire(import.meta.url)("../documentStore.cjs");
  t.after(() => {
    unlinkSync(file);
    rmdirSync(dir);
  });
  let evidence: "duplicate" | "wrong recipient" | "wrong amount" | "visible" = "duplicate";
  const fetch: typeof f.run.fetch = async (url, init) => {
    const response = await f.run.fetch(url, init);
    const call = init?.body && JSON.parse(String(init.body));
    if (
      evidence !== "visible" &&
      call?.method === "GetTransactions" &&
      call.args[3] &&
      f.transfers.length
    ) {
      const body = await response.json(),
        row = body.result.items[0];
      if (evidence === "duplicate")
        body.result.items.push({ ...row, fields: { ...row.fields, transactionID: 99 } });
      if (evidence === "wrong recipient") row.fields.ownerID2 = 8;
      if (evidence === "wrong amount") row.fields.amount = -129;
      return Response.json(body);
    }
    return response;
  };
  for (const botID of ["duplicate", "wrong recipient", "wrong amount", "visible"] as const) {
    evidence = botID;
    f.reports.length = 0;
    const sqlite = createDocumentStore(file);
    try {
      const worker = createTrainingRun({
        reconcileDelayMs: 1,
        fundingDocument: (id) => sqlite.document("funding:" + id),
      });
      await worker.start({ ...f.run, botID, setup: corporateOnlySetup, fetch });
      await finish(f.reports);
    } finally {
      sqlite.close();
    }
    assert.equal(
      f.reports[0].status,
      evidence === "visible" ? "stopped" : "error",
      f.reports[0].why,
    );
    assert.equal(
      f.calls.filter((c) => c === "PurchaseSkills").length,
      evidence === "visible" ? 1 : 0,
    );
    assert.equal(f.transfers.length, 1, "only the original transfer may be sent");
  }
  assert.deepEqual(f.balances(), { personal: 200, corporate: 870 });
});

test("learning earlier books elsewhere does not release an unverified transfer for another purchase", async () => {
  const f = fixture(),
    pending = {
      books: [77],
      total: 13000,
      policy: "CORPORATION_WALLET_ONLY",
      transfer: {
        corporationID: 98,
        shortfall: 13000,
        balance: 20000,
        reason: "UOC Training 12aaade3-5b8a-4370-b067-0bf856764055",
      },
    };
  const worker = createTrainingRun({
    reconcileDelayMs: 1,
    fundingDocument: () => ({
      read: () => pending,
      write() {
        assert.fail("unverified funding was cleared");
      },
    }),
  });
  const fetch: typeof f.run.fetch = async (url, init) => {
    const response = await f.run.fetch(url, init);
    if (new URL(String(url)).pathname !== "/api/bridge/skills") return response;
    const body = await response.json();
    body.skills.skills.push({ typeID: 77, level: 1 });
    return Response.json(body);
  };
  await worker.start({ ...f.run, setup: corporateOnlySetup, fetch });
  await finish(f.reports);
  assert.match(f.reports[0].why, /earlier corporation transfer could not be verified/);
  assert.equal(f.transfers.length, 0);
  assert.equal(f.calls.includes("PurchaseSkills"), false);
});

test("corporation wallet only verifies a transfer of the entire cost and preserves an ample personal balance", async () => {
  const f = fixture();
  await f.worker().start({ ...f.run, setup: corporateOnlySetup });
  await finish(f.reports);
  assert.equal(f.reports[0].phase, "Training queued", f.reports[0].why);
  assert.deepEqual(
    f.transfers.map((transfer) => transfer.amount),
    [130],
  );
  const transferAt = f.calls.indexOf("GiveCashFromCorpAccount");
  const proofAt = f.calls.indexOf("GetTransactions", transferAt);
  assert.ok(transferAt >= 0 && proofAt > transferAt && proofAt < f.calls.indexOf("PurchaseSkills"));
  assert.equal(f.reports[0].readout.transferReceipt.shortfall, 13000);
  assert.equal(f.reports[0].readout.totalCents, 13000);
  assert.deepEqual(f.balances(), { personal: 200, corporate: 870 });
});

test("corporation wallet only refuses insufficient funds or authority even with a funded trainee", async () => {
  for (const [wallet, reason] of [
    [{ corporateBalance: 129 }, /INSUFFICIENT_CORPORATION_FUNDS/],
    [{ roles: "0" }, /CORPORATION_WALLET_TAKE_DENIED/],
  ] as const) {
    const f = fixture(false, false, wallet);
    await f.worker().start({ ...f.run, setup: corporateOnlySetup });
    await finish(f.reports);
    assert.match(f.reports[0].why, reason);
    assert.deepEqual(f.transfers, []);
    assert.equal(f.calls.includes("PurchaseSkills"), false);
    assert.equal(f.balances().personal, 200);
  }
});

test("corporation wallet only refuses to buy while the transfer is unconfirmed", async () => {
  const f = fixture();
  let transfers = 0;
  const fetcher: typeof fetch = async (url, init) => {
    if (init?.body && JSON.parse(String(init.body)).method === "GiveCashFromCorpAccount") {
      transfers++;
      throw Error("Transfer response lost");
    }
    return f.run.fetch(url, init);
  };
  for (const botID of ["first", "retry"]) {
    f.reports.length = 0;
    await f.worker().start({ ...f.run, botID, setup: corporateOnlySetup, fetch: fetcher });
    await finish(f.reports);
    assert.match(f.reports[0].why, /transfer could not be verified/);
  }
  assert.equal(transfers, 1);
  assert.equal(f.calls.includes("PurchaseSkills"), false);
  assert.deepEqual(f.balances(), { personal: 200, corporate: 1000 });
});

test("corporation wallet only checks the funded balance again before the trainee wallet is charged", async () => {
  const f = fixture();
  let personalReadsAfterTransfer = 0;
  const fetcher: typeof fetch = async (url, init) => {
    const call = init?.body && JSON.parse(String(init.body));
    if (
      f.transfers.length &&
      call?.method === "GetCashBalance" &&
      call.args[0] === 0 &&
      ++personalReadsAfterTransfer === 1
    )
      return Response.json({ ok: true, result: 329 });
    return f.run.fetch(url, init);
  };
  await f.worker().start({ ...f.run, setup: corporateOnlySetup, fetch: fetcher });
  await finish(f.reports);
  assert.match(f.reports[0].why, /funding no longer covers the purchase/);
  assert.match(f.reports[0].why, /Verified corporation transfer: 130 ISK/);
  assert.equal(f.calls.includes("PurchaseSkills"), false);

  f.reports.length = 0;
  await f.worker().start({ ...f.run, botID: "retry", setup: corporateOnlySetup, fetch: fetcher });
  await finish(f.reports);
  assert.equal(f.reports[0].status, "stopped", f.reports[0].why);
  assert.deepEqual(
    f.transfers.map((t) => t.amount),
    [130],
  );
  assert.equal(f.calls.filter((c) => c === "PurchaseSkills").length, 1);
  assert.deepEqual(f.balances(), { personal: 200, corporate: 870 });
});

test("reviewed planner goals add native skill levels through the existing purchase and queue executor", async () => {
  const f = fixture(),
    original = f.run.fetch;
  (f.run as any).setup = { ...(f.run.setup as object), skillGoals: [{ typeID: 10, level: 2 }] };
  (f.run as any).fetch = async (url: any, init: any) => {
    if (
      new URL(String(url)).pathname.endsWith("/type-prices") &&
      new URL(String(url)).searchParams.get("typeIDs") === "10"
    )
      return Response.json({
        ok: true,
        available: true,
        categoryID: { 10: 16 },
        basePrice: { 10: 100 },
        published: { 10: true },
      });
    return original(url, init);
  };
  await createTrainingRun({ reconcileDelayMs: 1 }).start(f.run);
  await finish(f.reports);
  assert.equal(f.reports[0].phase, "Training queued", JSON.stringify(f.reports));
  assert.deepEqual(
    f.reports[0].readout.queue.entries.map((e: any) => [e.typeID, e.toLevel]),
    [
      [10, 1],
      [10, 2],
    ],
  );
  assert.equal(f.calls.filter((x) => x === "PurchaseSkills").length, 1);
  assert.equal(f.calls.filter((x) => x === "SaveNewQueue").length, 1);
});
test("ambiguous purchase is never repeated within the same run", async () => {
  const f = fixture(true),
    run = createTrainingRun({ reconcileDelayMs: 1 });
  await run.start(f.run);
  await finish(f.reports);
  assert.equal(f.reports[0].status, "error");
  assert.match(f.reports[0].why, /not visible/);
  assert.equal(f.calls.filter((x) => x === "PurchaseSkills").length, 1);
  assert.equal(f.calls.includes("SaveNewQueue"), false);
});
test("authorized held pilot uses personal money first and proves corporation shortfall on both wallets", async () => {
  const f = fixture(false, true),
    run = f.worker();
  await run.start(f.run);
  await finish(f.reports);
  assert.equal(f.reports[0].phase, "Training queued");
  assert.equal(f.reports[0].readout.transferReceipt.shortfall, 10000);
  assert.equal(f.calls.filter((x) => x === "GiveCashFromCorpAccount").length, 1);
});
test("unreadable corporate role stops before any monetary dispatch", async () => {
  const f = fixture(false, true),
    original = f.run.fetch;
  (f.run as any).fetch = async (url: unknown, init: any) => {
    if (init?.body && JSON.parse(init.body).method === "GetMember")
      return Response.json({
        ok: true,
        result: { type: "packedrow", fields: { characterID: 7, corporationID: 98, roles: "0" } },
      });
    return original(url as string, init);
  };
  await f.worker().start(f.run);
  await finish(f.reports);
  assert.match(f.reports[0].why, /CORPORATION_WALLET_TAKE_DENIED/);
  assert.equal(
    f.calls.filter((x) => x === "GiveCashFromCorpAccount" || x === "PurchaseSkills").length,
    0,
  );
});
test("ambiguous corporation transfer stops the current run before buying books", async () => {
  const f = fixture(false, true),
    original = f.run.fetch;
  let transfers = 0;
  (f.run as any).fetch = async (url: unknown, init: any) => {
    if (init?.body && JSON.parse(init.body).method === "GiveCashFromCorpAccount") {
      transfers++;
      throw Error("unknown");
    }
    return original(url as string, init);
  };
  const run = f.worker();
  await run.start(f.run);
  await finish(f.reports);
  assert.match(f.reports[0].why, /transfer could not be verified/);
  assert.equal(transfers, 1);
  assert.equal(f.calls.includes("PurchaseSkills"), false);
});
test("lost purchase response is verified from fresh skills without replay", async () => {
  const f = fixture(),
    original = f.run.fetch;
  let bought = false,
    lost = 0;
  (f.run as any).fetch = async (url: unknown, init: any) => {
    const method = init?.body && JSON.parse(init.body).method;
    if (method === "PurchaseSkills") {
      await original(url as string, init);
      bought = true;
      throw Error("response lost");
    }
    if (String(url).endsWith("/api/bridge/skills") && bought && lost++ < 3) {
      throw Error("read unavailable");
    }
    return original(url as string, init);
  };
  const run = createTrainingRun({ reconcileDelayMs: 1 });
  await run.start(f.run);
  await finish(f.reports);
  assert.ok(lost >= 3);
  assert.equal(f.reports[0].phase, "Training queued");
  assert.equal(f.calls.filter((x) => x === "PurchaseSkills").length, 1);
});
test("lost queue read verifies original submission without replay", async () => {
  const f = fixture(),
    original = f.run.fetch;
  let saved = false,
    lost = 0;
  (f.run as any).fetch = async (url: unknown, init: any) => {
    const method = init?.body && JSON.parse(init.body).method;
    if (method === "SaveNewQueue") {
      const result = await original(url as string, init);
      saved = true;
      return result;
    }
    if (String(url).endsWith("/api/bridge/skills") && saved && lost++ < 3) {
      throw Error("read unavailable");
    }
    return original(url as string, init);
  };
  const run = createTrainingRun({ reconcileDelayMs: 1 });
  await run.start(f.run);
  await finish(f.reports);
  assert.ok(lost >= 3);
  assert.equal(f.reports[0].phase, "Training queued");
  assert.equal(f.calls.filter((x) => x === "SaveNewQueue").length, 1);
});
test("inspection reads the real corp fitting and quotes missing books without writes", async () => {
  const reports: any[] = [],
    writes: string[] = [];
  let libraryReads = 0;
  const sheet = {
    characterID: 7,
    skills: Array.from({ length: 420 }, (_, i) => ({
      typeID: 100000 + i,
      level: i % 6,
      skillPoints: 123456 + i,
    })),
    queue: {
      active: true,
      maxEntries: 150,
      endTimeMs: 1791551799996,
      entries: Array.from({ length: 150 }, (_, i) => ({
        typeID: 100000 + i,
        toLevel: 5,
        startTimeMs: 1791550000000 + i * 1000,
        endTimeMs: 1791550001000 + i * 1000,
      })),
    },
  };
  assert.ok(Buffer.byteLength(JSON.stringify(sheet)) > 16 * 1024);
  const fit = {
    type: "dict",
    entries: [
      [
        5,
        {
          type: "object",
          args: {
            type: "dict",
            entries: Object.entries({
              fittingID: 5,
              ownerID: 98,
              shipTypeID: 100,
              name: "Miner",
              fitData: { type: "list", items: [[20, 27, 1]] },
            }),
          },
        },
      ],
    ],
  };
  const fetcher: typeof fetch = async (url, init) => {
    const u = new URL(String(url)),
      body = init?.body ? JSON.parse(String(init.body)) : null;
    const ok = (data: any) => Response.json({ ok: true, ...data });
    if (u.pathname === "/api/bridge/call") {
      if (body.confirm) writes.push(body.method);
      if (body.method === "GetCorporation")
        return ok({ result: { type: "packedrow", fields: { corporationID: 98 } } });
      if (body.method === "GetFittings") {
        libraryReads++;
        return ok({
          result: {
            ...fit,
            entries: [...fit.entries, ...Array.from({ length: 21 }, (_, i) => [6 + i, null])],
          },
        });
      }
      if (body.method === "GetCashBalance") return ok({ result: 200 });
    }
    if (u.pathname === "/api/bridge/skills") return ok({ skills: sheet });
    if (u.pathname === "/api/client-data/type-prices")
      return u.searchParams.get("typeIDs") === "10"
        ? ok({ available: true, basePrice: { 10: 100 }, published: { 10: true } })
        : ok({ available: true, categoryID: { 100: 6, 20: 7 }, published: { 100: true } });
    if (u.pathname === "/api/client-data/required-skills")
      return ok({ available: true, required: { 100: { 10: 1 }, 20: {}, 10: {} } });
    if (u.pathname === "/api/types/type-lists") return ok({ lists: { 10: [93] } });
    throw Error(`Unexpected ${u.pathname}`);
  };
  const run = {
    botID: "inspection",
    characterID: 7,
    held: { characterID: 7 },
    resumed: false,
    setup: {},
    baseUrl: "http://local",
    fetch: fetcher,
    report: (x: unknown) => reports.push(x),
  } as unknown as PluginRunContext;
  await trainingInspectRun.start(run);
  await finish(reports);
  assert.equal(reports[0].phase, "Training inspected");
  assert.deepEqual(reports[0].readout.choices, []);
  assert.equal(libraryReads, 0);
  const fingerprint = createHash("sha256")
    .update(JSON.stringify([100, [[20, 27, 1]]]))
    .digest("hex");
  const checked = await trainingInspectRun.check({
    corporationID: 98,
    fittingID: 5,
    goalTypeID: 100,
    fingerprint,
  });
  assert.equal(checked.ok, true);
  if (!checked.ok) throw Error("Exact inspection refused.");
  reports.length = 0;
  await trainingInspectRun.start({ ...run, setup: checked.setup });
  await finish(reports);
  assert.equal(reports[0].phase, "Training inspected");
  assert.equal(reports[0].readout.choices.length, 1);
  assert.ok(Buffer.byteLength(JSON.stringify(reports[0].readout)) <= 16 * 1024);
  const expanded = expandTrainingInspection(reports[0].readout);
  assert.deepEqual(expanded.skills, sheet.skills);
  assert.deepEqual(expanded.queue.entries, sheet.queue.entries);
  assert.equal(reports[0].readout.choices[0].estimatedCostISK, 130);
  assert.equal(reports[0].readout.choices[0].name, "Miner");
  assert.deepEqual(reports[0].readout.choices[0].prerequisites, [{ typeID: 10, toLevel: 1 }]);
  assert.deepEqual(writes, []);
  assert.equal(libraryReads, 1);
});

test("the hosted skills panel reads the held native queue without funding or fitting RPCs", async () => {
  const reports: any[] = [],
    setup = { skillSheetOnly: true };
  const checked = await trainingInspectRun.check(setup);
  assert.equal(checked.ok, true);
  const run = {
    botID: "skills",
    characterID: 7,
    held: { characterID: 7 },
    setup,
    baseUrl: "http://local",
    fetch: async (url: string) => {
      assert.equal(new URL(url).pathname, "/api/bridge/skills");
      return Response.json({
        skills: {
          characterID: 7,
          skills: [{ typeID: 10, level: 1 }],
          queue: { active: false, entries: [], maxEntries: 50 },
        },
      });
    },
    report: (r: any) => reports.push(r),
  } as unknown as PluginRunContext;
  await trainingInspectRun.start(run);
  await finish(reports);
  assert.equal(reports[0].phase, "Training skills read");
  assert.deepEqual(reports[0].readout.trained, [[10, 1]]);
});

test("independent Review reads the held queue, corporation and only the wallet needed for purchase", async () => {
  for (const skillReview of ["queue", "purchase"]) {
    const f = fixture(),
      setup = { skillSheetOnly: true, skillReview };
    assert.equal((await trainingInspectRun.check(setup)).ok, true);
    await trainingInspectRun.start({ ...f.run, setup });
    await finish(f.reports);
    assert.equal(f.reports[0].phase, "Training skills read");
    assert.equal(f.reports[0].readout.corporationID, 98);
    assert.equal(f.reports[0].readout.balanceISK, skillReview === "purchase" ? 200 : undefined);
    assert.deepEqual(
      f.calls,
      skillReview === "purchase"
        ? ["readSkills", "GetCorporation", "GetCashBalance"]
        : ["readSkills", "GetCorporation"],
    );
  }
});

function independentBookPrice(fetcher: typeof fetch, price = 100): typeof fetch {
  return (input, init) => {
    const url = new URL(String(input));
    return url.pathname.endsWith("/type-prices") && url.searchParams.get("typeIDs") === "10"
      ? Promise.resolve(
          Response.json({
            ok: true,
            available: true,
            categoryID: { 10: 16 },
            basePrice: { 10: price },
            published: { 10: true },
          }),
        )
      : fetcher(input, init);
  };
}

test("the held Apply compares the reviewed skill plan and returns the purchased sheet and verified queue", async () => {
  const f = fixture(),
    worker = createTrainingRun({ reconcileDelayMs: 1 }),
    fetch = independentBookPrice(f.run.fetch);
  const target = [{ typeID: 10, toLevel: 1 }],
    queue = { active: false, maxEntries: 50, entries: [] };
  const start = { ...f.run, fetch };
  const reviewed = skillReviewKey(98, target, { skills: [], queue }, 13000);
  await worker.start({
    ...start,
    setup: {
      goalTypeID: 10,
      maxSpendISK: 130,
      skillLevel: 1,
      skillAction: "purchase-only",
      skillReviewKey: reviewed,
    },
  });
  await finish(f.reports);
  assert.equal(f.reports[0].phase, "Skillbooks verified");
  const purchased = trainingSheetFromProof(f.reports[0].readout, 7);
  assert.deepEqual(purchased?.skills, [{ typeID: 10, level: 0 }]);
  assert.equal(f.calls.filter((call) => call === "readSkills").length, 2);
  assert.equal(f.calls.filter((call) => call === "PurchaseSkills").length, 1);
  assert.equal(f.calls.includes("SaveNewQueue"), false);

  f.calls.length = 0;
  f.reports.length = 0;
  const queueReview = skillReviewKey(98, target, purchased!, 0);
  await worker.start({
    ...start,
    setup: {
      goalTypeID: 10,
      maxSpendISK: 0,
      skillLevel: 1,
      skillAction: "queue-only",
      skillReviewKey: queueReview,
    },
  });
  await finish(f.reports);
  assert.equal(f.reports[0].phase, "Training queued");
  assert.deepEqual(
    f.reports[0].readout.queue.entries.map((e: any) => [e.typeID, e.toLevel]),
    [[10, 1]],
  );
  assert.equal(f.calls.filter((call) => call === "readSkills").length, 3);
  assert.equal(f.calls.filter((call) => call === "SaveNewQueue").length, 1);
  assert.equal(f.calls.includes("PurchaseSkills"), false);
});

test("a different reviewed queue or book cost blocks a held Apply before any write", async () => {
  for (const [entries, price] of [
    [[{ typeID: 11, toLevel: 1 }], 100],
    [[], 90],
  ] as const) {
    const f = fixture();
    const skillKey = skillReviewKey(
      98,
      [{ typeID: 10, toLevel: 1 }],
      { skills: [], queue: { active: false, maxEntries: 50, entries } },
      13000,
    );
    const setup = {
      goalTypeID: 10,
      maxSpendISK: 130,
      skillLevel: 1,
      skillAction: "purchase-only",
      skillReviewKey: skillKey,
    };
    await createTrainingRun({ reconcileDelayMs: 1 }).start({
      ...f.run,
      setup,
      fetch: independentBookPrice(f.run.fetch, price),
    });
    await finish(f.reports);
    assert.equal(f.reports[0].status, "error");
    assert.match(f.reports[0].why, /changed; review again/);
    assert.equal(
      f.calls.some((method) =>
        ["PurchaseSkills", "SaveNewQueue", "GiveCashFromCorpAccount"].includes(method),
      ),
      false,
    );
  }
});

test("a proven pre-dispatch refusal is reported directly", async () => {
  const f = fixture(),
    original = f.run.fetch;
  (f.run as any).fetch = async (url: unknown, init: any) =>
    init?.body && JSON.parse(init.body).method === "PurchaseSkills"
      ? Response.json(
          { ok: false, error: "INVALID_REQUEST", message: "Invalid purchase arguments" },
          { status: 400 },
        )
      : original(url as string, init);
  await createTrainingRun({ reconcileDelayMs: 1 }).start(f.run);
  await finish(f.reports);
  assert.equal(f.reports[0].why, "Invalid purchase arguments");
});

test("independent skill purchase never queues and queue-only never purchases", async () => {
  const f = fixture(),
    orig = f.run.fetch;
  (f.run as any).setup = {
    goalTypeID: 10,
    maxSpendISK: 150,
    skillLevel: 1,
    skillAction: "purchase-only",
  };
  (f.run as any).fetch = async (url: any, init: any) => {
    const u = new URL(String(url));
    if (u.pathname === "/api/client-data/type-prices" && u.searchParams.get("typeIDs") === "10")
      return Response.json({
        ok: true,
        available: true,
        categoryID: { 10: 16 },
        basePrice: { 10: 100 },
        published: { 10: true },
      });
    return orig(url, init);
  };
  const run = createTrainingRun({ reconcileDelayMs: 1 });
  await run.start(f.run);
  await finish(f.reports);
  assert.equal(f.reports[0].phase, "Skillbooks verified");
  assert.equal(f.calls.filter((x) => x === "PurchaseSkills").length, 1);
  assert.equal(f.calls.includes("SaveNewQueue"), false);
  f.reports.length = 0;
  (f.run as any).setup = {
    goalTypeID: 10,
    maxSpendISK: 0,
    skillLevel: 1,
    skillAction: "queue-only",
  };
  await run.start(f.run);
  await finish(f.reports);
  assert.equal(f.reports[0].phase, "Training queued");
  assert.equal(f.calls.filter((x) => x === "PurchaseSkills").length, 1);
  assert.equal(f.calls.filter((x) => x === "SaveNewQueue").length, 1);
});

test("independent purchase unknown returns an error without a second purchase or queue", async () => {
  const f = fixture(true),
    orig = f.run.fetch;
  (f.run as any).setup = {
    goalTypeID: 10,
    maxSpendISK: 150,
    skillLevel: 1,
    skillAction: "purchase-only",
  };
  (f.run as any).fetch = async (url: any, init: any) => {
    const u = new URL(String(url));
    if (u.pathname === "/api/client-data/type-prices" && u.searchParams.get("typeIDs") === "10")
      return Response.json({
        ok: true,
        available: true,
        categoryID: { 10: 16 },
        basePrice: { 10: 100 },
        published: { 10: true },
      });
    return orig(url, init);
  };
  const run = createTrainingRun({ reconcileDelayMs: 1 });
  await run.start(f.run);
  await finish(f.reports);
  assert.match(f.reports[0].why, /not visible/);
  assert.equal(f.calls.filter((x) => x === "PurchaseSkills").length, 1);
  assert.equal(f.calls.includes("SaveNewQueue"), false);
});

test("FixtureMiner8 learns the selected skills with a foreign legacy Training record left intact", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "uoc-training-test-"));
  const file = path.join(directory, "training.sqlite");
  const { createDocumentStore } = createRequire(import.meta.url)("../documentStore.cjs");
  const archive = createDocumentStore(file);
  const oldDirectory = process.env.EVEJS_PLUGIN_DATA_DIR;
  process.env.EVEJS_PLUGIN_DATA_DIR = directory;
  try {
    const fixtureRun = fixture(),
      doc = archive.document("training:7");
    const prior = {
      version: 1,
      characterID: 71,
      phase: "PURCHASE_PENDING",
      setup: { goalTypeID: 200, maxSpendISK: 50 },
      ownerScope: { worldID: "old-world", owner: "another-account", characterID: 71 },
      missing: [20],
    };
    doc.write(prior);
    await trainingRun.start(fixtureRun.run);
    await finish(fixtureRun.reports);
    assert.equal(fixtureRun.reports[0].phase, "Training queued");
    assert.deepEqual(
      fixtureRun.reports[0].readout.queue.entries.map((e: any) => [e.typeID, e.toLevel]),
      [[10, 1]],
    );
    assert.equal(fixtureRun.calls.filter((call) => call === "PurchaseSkills").length, 1);
    assert.equal(fixtureRun.calls.filter((call) => call === "SaveNewQueue").length, 1);
    assert.deepEqual(doc.read(), prior);
  } finally {
    if (oldDirectory === undefined) delete process.env.EVEJS_PLUGIN_DATA_DIR;
    else process.env.EVEJS_PLUGIN_DATA_DIR = oldDirectory;
    archive.close();
    unlinkSync(file);
    rmdirSync(directory);
  }
});
