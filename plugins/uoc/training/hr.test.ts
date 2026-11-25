import test from "node:test";
import assert from "node:assert/strict";
import { createTrainingHRRun } from "./hr.ts";
const maskValues = [
  "9222811354509877120",
  "9222811354509877120",
  ...Array(6).fill("558552041119758"),
];
const names = [
  "roles",
  "grantableRoles",
  "rolesAtHQ",
  "grantableRolesAtHQ",
  "rolesAtBase",
  "grantableRolesAtBase",
  "rolesAtOther",
  "grantableRolesAtOther",
];
function fixture(lostInvite = false) {
  let record: any = null,
    invited = false,
    joined = false,
    roles = Array(8).fill("0");
  const calls: any[] = [],
    reports: any[] = [];
  const storage = () => ({ read: () => record, write: (v: any) => (record = structuredClone(v)) });
  const f = async (_url: any, init: any) => {
    const b = JSON.parse(init.body);
    calls.push(b);
    const row = (fields: any) => ({ type: "packedrow", fields });
    let result: any = null;
    switch (b.method) {
      case "GetCorporation":
        result = row({
          corporationID: b.actor ?? (current === 1 ? 98 : joined ? 98 : 50),
          ceoID: 99,
        });
        break;
      case "GetMember":
        result = row({
          characterID: b.args[0],
          corporationID: 98,
          blockRoles: 0,
          ...Object.fromEntries(
            names.map((n, i) => [n, b.args[0] === 1 ? (i === 0 ? "1" : "0") : roles[i]]),
          ),
        });
        break;
      case "GetApplications":
      case "GetMyApplications":
        result = {
          type: "dict",
          entries:
            invited && !joined
              ? [
                  [
                    b.method === "GetApplications" ? 2 : 98,
                    {
                      type: "list",
                      items: [
                        row({
                          characterID: 2,
                          corporationID: 98,
                          applicationID: 77,
                          status: 8,
                          applicationText: { type: "wstring", value: "" },
                        }),
                      ],
                    },
                  ],
                ]
              : [],
        };
        break;
      case "InsertInvitation":
        if (!lostInvite) invited = true;
        else throw Error("lost");
        break;
      case "UpdateApplicationOffer":
        assert.equal(b.args[4], 2);
        assert.equal(b.of, 50);
        joined = true;
        break;
      case "UpdateMember":
        assert.equal(b.args.length, 15);
        assert.deepEqual(
          b.args.slice(4, 12),
          maskValues.map((value) => ({ type: "long", value })),
        );
        roles = maskValues.slice();
        break;
      default:
        throw Error(b.method);
    }
    return Response.json({ ok: true, result });
  };
  let current = 1;
  async function execute(kind: string, stage: string) {
    current = kind === "training-hr" ? 1 : 2;
    reports.length = 0;
    const run: any = {
      characterID: current,
      held: { characterID: current },
      setup: { traineeID: 2, authorityID: 1, corporationID: 98, stage },
      baseUrl: "http://local",
      fetch: f,
      report: (x: any) => reports.push(x),
    };
    await createTrainingHRRun(kind as any, storage, { reconcileDelayMs: 1 }).start(run);
    for (let i = 0; i < 100 && !reports.length; i++) await new Promise((r) => setTimeout(r, 1));
    assert.ok(reports.length);
    return reports[0];
  }
  return {
    execute,
    calls,
    get record() {
      return record;
    },
  };
}
test("native invitation, trainee acceptance and eight typed role masks are independently verified", async () => {
  const f = fixture();
  assert.equal((await f.execute("training-hr", "invite")).phase, "Invitation verified");
  assert.equal((await f.execute("training-join", "join")).phase, "Membership verified");
  assert.equal((await f.execute("training-hr", "grant")).phase, "Onboarding verified");
  assert.equal(f.record.phase, "DONE");
  for (const name of [
    "applicationText",
    "previousCorporationID",
    "membershipMasks",
    "beforeMasks",
    "roleMasks",
  ])
    assert.equal(Object.hasOwn(f.record, name), false);
  assert.deepEqual(
    f.calls
      .filter((x) =>
        ["InsertInvitation", "UpdateApplicationOffer", "UpdateMember"].includes(x.method),
      )
      .map((x) => x.method),
    ["InsertInvitation", "UpdateApplicationOffer", "UpdateMember"],
  );
});
test("uncertain invitation is never resent", async () => {
  const f = fixture(true);
  assert.match((await f.execute("training-hr", "invite")).why, /RECOVERY_REQUIRED/);
  assert.match((await f.execute("training-hr", "invite")).why, /RECOVERY_REQUIRED/);
  assert.equal(f.calls.filter((x) => x.method === "InsertInvitation").length, 1);
});

test("read-only authority inspection reads exact masks and never touches onboarding storage or writes", async () => {
  const calls: string[] = [],
    reports: any[] = [];
  const mask = Object.fromEntries(names.map((n, i) => [n, i === 0 ? "1" : "0"]));
  const run: any = {
    characterID: 1,
    held: { characterID: 1 },
    setup: { stage: "inspect", authorityID: 1 },
    baseUrl: "http://local",
    fetch: async (_: any, init: any) => {
      const b = JSON.parse(init.body);
      calls.push(b.method);
      assert.equal(b.confirm, undefined);
      return Response.json({
        ok: true,
        result: {
          type: "packedrow",
          fields:
            b.method === "GetCorporation"
              ? { corporationID: 98, ceoID: 99, corporationName: "Test Corp" }
              : { characterID: 1, corporationID: 98, ...mask },
        },
      });
    },
    report: (x: any) => reports.push(x),
  };
  const engine = createTrainingHRRun("training-hr", () => {
    throw Error("must not open journal");
  });
  assert.equal((await engine.check(run.setup)).ok, true);
  await engine.start(run);
  for (let i = 0; i < 100 && !reports.length; i++) await new Promise((r) => setTimeout(r, 1));
  assert.deepEqual(calls, ["GetCorporation", "GetMember"]);
  assert.equal(reports[0].readout.eligible, true);
  assert.deepEqual(reports[0].readout.roleMasks, mask);
});

test("existing member grant proves actual membership and records intent without invitation", async () => {
  const f = fixture();
  const outcome = await f.execute("training-hr", "grant-existing");
  assert.equal(outcome.phase, "Onboarding verified");
  assert.equal(f.record.membershipOrigin, "EXISTING_NATIVE_MEMBER");
  assert.deepEqual(
    f.calls
      .filter((x) =>
        ["InsertInvitation", "UpdateApplicationOffer", "UpdateMember"].includes(x.method),
      )
      .map((x) => x.method),
    ["UpdateMember"],
  );
  await f.execute("training-hr", "grant-existing");
  assert.equal(f.calls.filter((x) => x.method === "UpdateMember").length, 1);
});
test("selected member read projects eight native masks and only same-world exact trainee journal, without writes", async () => {
  for (const savedWorld of ["a".repeat(64), "b".repeat(64), null]) {
    const calls: string[] = [],
      reports: any[] = [];
    const mask = Object.fromEntries(names.map((n, i) => [n, maskValues[i]]));
    const journal = {
      version: 1,
      traineeID: 2,
      corporationID: 98,
      authorityID: 1,
      phase: "RIGHTS_PENDING",
      ...(savedWorld ? { worldID: savedWorld } : {}),
    };
    const run: any = {
      characterID: 2,
      held: { characterID: 2 },
      setup: { stage: "member-inspect", authorityID: 2 },
      baseUrl: "http://local",
      fetch: async (url: any, init: any) => {
        if (String(url).endsWith("/api/plugins/uoc/world"))
          return Response.json({ ok: true, worldID: "a".repeat(64) });
        const b = JSON.parse(init.body);
        calls.push(b.method);
        assert.equal(b.confirm, undefined);
        return Response.json({
          ok: true,
          result: {
            type: "packedrow",
            fields:
              b.method === "GetCorporation"
                ? { corporationID: 98, ceoID: 99 }
                : { characterID: 2, corporationID: 98, blockRoles: 0, ...mask },
          },
        });
      },
      report: (x: any) => reports.push(x),
    };
    const engine = createTrainingHRRun("training-hr", () => ({
      read: () => journal,
      write() {
        throw Error("unexpected write");
      },
    }));
    assert.equal((await engine.check(run.setup)).ok, true);
    await engine.start(run);
    for (let i = 0; i < 100 && !reports.length; i++) await new Promise((r) => setTimeout(r, 1));
    assert.deepEqual(calls, ["GetCorporation", "GetMember"]);
    assert.equal(reports[0].readout.rights, "FULL_ACCESS_EXCEPT_CEO");
    assert.equal(
      reports[0].readout.enrollmentState,
      savedWorld === "a".repeat(64) ? "PENDING" : "UNKNOWN",
    );
  }
});
test("missing role-block evidence or CEO identity cannot assert full bot permissions", async () => {
  for (const scenario of ["missing", "ceo"]) {
    const reports: any[] = [],
      roleMasks = Object.fromEntries(names.map((n, i) => [n, maskValues[i]]));
    const run: any = {
      characterID: 2,
      held: { characterID: 2 },
      setup: { stage: "member-inspect", authorityID: 2 },
      baseUrl: "http://local",
      fetch: async (url: any, init: any) => {
        if (String(url).endsWith("/api/plugins/uoc/world"))
          return Response.json({ ok: true, worldID: "world" });
        const b = JSON.parse(init.body);
        return Response.json({
          ok: true,
          result: {
            type: "packedrow",
            fields:
              b.method === "GetCorporation"
                ? { corporationID: 98, ceoID: scenario === "ceo" ? 2 : 99 }
                : {
                    characterID: 2,
                    corporationID: 98,
                    ...roleMasks,
                    ...(scenario === "ceo" ? { blockRoles: 0 } : {}),
                  },
          },
        });
      },
      report: (v: any) => reports.push(v),
    };
    await createTrainingHRRun("training-hr", () => ({
      read: () => null,
      write() {
        throw Error("unexpected");
      },
    })).start(run);
    for (let i = 0; i < 100 && !reports.length; i++) await new Promise((r) => setTimeout(r, 1));
    assert.equal(reports[0].readout.rights, scenario === "ceo" ? "OTHER" : "UNKNOWN");
  }
});
