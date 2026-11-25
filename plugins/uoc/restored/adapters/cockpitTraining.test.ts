import test from "node:test";
import assert from "node:assert/strict";
import { cockpitTraining } from "./cockpitTraining.ts";
import { skillReviewKey, trainingSheetFromProof } from "../../training/queue.ts";
import type { Session } from "../../../../web/src/plugin-api/index.ts";
function fixture(owner = "BROWSER") {
  let skills: any[] = [],
    queue: any[] = [],
    purchases = 0,
    saves = 0;
  const paths: string[] = [],
    options = { token: "real-page-session" },
    flow = {
      requestOptions: () => options,
      sessionToken: () => options.token,
      flying: {
        sessionGeneration: () => 1,
        bridgeAsk: async (service: string, method: string) => {
          if (service === "corpRegistry" && method === "GetCorporation")
            return { type: "packedrow", fields: { corporationID: 9 } };
          assert.equal(service, "account");
          assert.equal(method, "GetCashBalance");
          return 1000;
        },
      },
      loadSavedFittings: async () => {},
      savedFittings: { get: () => [] },
      skillPurchaseOffer: async () => ({ sold: true, price: 130, requirementsTrained: true }),
      buySkillFromOverlay: async (id: number, at: unknown) => {
        assert.equal(at, null);
        purchases++;
        skills.push({ typeID: id, level: 0 });
      },
      saveSkillQueue: async (entries: any[]) => {
        saves++;
        queue = structuredClone(entries);
      },
    };
  const session = {
    id: "page-session",
    store: { get: () => ({ station: { online: { characterID: 7 } } }) },
    flow,
  } as unknown as Session;
  const read = async (path: string, asked: any) => {
    assert.equal(asked, options);
    paths.push(path);
    if (path === "/api/plugins/uoc/world") return { worldID: "cockpit-fixture-world" };
    if (path.includes("/ownership")) return { ownership: { characterID: 7, owner, online: true } };
    if (path === "/api/bridge/skills")
      return {
        skills: {
          characterID: 7,
          skills,
          queue: { active: false, maxEntries: 50, entries: queue },
        },
      };
    if (path.endsWith("/characters")) return { characters: [{ characterID: 7, corporationID: 9 }] };
    if (path.includes("required-skills"))
      return { available: true, required: { 100: { 10: 1 }, 10: {} } };
    throw Error("No login, host Start or extra executor allowed: " + path);
  };
  return {
    session,
    read,
    paths,
    get purchases() {
      return purchases;
    },
    get saves() {
      return saves;
    },
    get skills() {
      return skills;
    },
  };
}
test("a real page-owned Cockpit flow purchases and queues through existing native methods, without a hosted login", async () => {
  const f = fixture();
  const r = await cockpitTraining(
    f.session,
    "training",
    { goalTypeID: 100, maxSpendISK: 130 },
    f.read,
  );
  assert.equal(r.phase, "Training queued");
  assert.equal((r.readout as any).queueVerified, true);
  assert.equal(f.purchases, 1);
  assert.equal(f.saves, 1);
  assert.equal(
    f.paths.some((p) => /login|bots|service/.test(p)),
    false,
  );
  await cockpitTraining(f.session, "training", { goalTypeID: 100, maxSpendISK: 130 }, f.read);
  assert.equal(f.purchases, 1);
  assert.equal(f.saves, 1, "current queued state prevents an unnecessary second queue save");
});
test("the lower skills panel reads only the authorized native sheet", async () => {
  const f = fixture();
  const r = await cockpitTraining(f.session, "training-inspect", { skillSheetOnly: true }, f.read);
  assert.equal(r.phase, "Training skills read");
  assert.deepEqual(f.paths, ["/api/pilot-training/ownership?characterID=7", "/api/bridge/skills"]);
});
test("page-owned independent book purchase does not queue", async () => {
  const f = fixture();
  const r = await cockpitTraining(
    f.session,
    "training",
    { goalTypeID: 100, maxSpendISK: 130, skillAction: "purchase-only" },
    f.read,
  );
  assert.equal((r.readout as any).purchaseVerified, true);
  assert.equal(f.saves, 0);
});

test("Cockpit reuses its verified purchase sheet and rejects a stale independent review before buying", async () => {
  const f = fixture();
  const read = await cockpitTraining(
    f.session,
    "training-inspect",
    { skillSheetOnly: true, skillReview: "purchase" },
    f.read,
  );
  const before = trainingSheetFromProof(read.readout, 7);
  assert.ok(before);
  assert.equal((read.readout as any).corporationID, 9);
  assert.equal((read.readout as any).balanceISK, 1000);
  assert.deepEqual(f.paths, ["/api/pilot-training/ownership?characterID=7", "/api/bridge/skills"]);
  const targets = [{ typeID: 10, toLevel: 1 }];
  const setup = { goalTypeID: 10, maxSpendISK: 130, skillLevel: 1, skillAction: "purchase-only" };
  await assert.rejects(
    cockpitTraining(
      f.session,
      "training",
      { ...setup, skillReviewKey: skillReviewKey(9, targets, before, 12900) },
      f.read,
    ),
    /changed; review again/,
  );
  assert.equal(f.purchases, 0);
  const bought = await cockpitTraining(
    f.session,
    "training",
    { ...setup, skillReviewKey: skillReviewKey(9, targets, before, 13000) },
    f.read,
  );
  assert.deepEqual(trainingSheetFromProof(bought.readout, 7)?.skills, [{ typeID: 10, level: 0 }]);
  assert.equal(f.purchases, 1);
  assert.equal(f.saves, 0);
});
test("a hosted token observed in a page is not a page-owned Cockpit mutation capability", async () => {
  const f = fixture("BOT");
  await assert.rejects(
    cockpitTraining(f.session, "training", { goalTypeID: 100, maxSpendISK: 130 }, f.read),
    /not the page-owned/,
  );
  assert.equal(f.purchases, 0);
  assert.equal(f.saves, 0);
});

test("a lost book response stops the current pass and a fresh skill sheet permits queueing", async () => {
  const f = fixture();
  let writes = 0;
  f.session.flow.buySkillFromOverlay = async () => {
    writes++;
    throw Error("RPC response lost");
  };
  const setup = { goalTypeID: 100, maxSpendISK: 130 };
  await assert.rejects(cockpitTraining(f.session, "training", setup, f.read), /response lost/);
  assert.equal(writes, 1);
  f.skills.push({ typeID: 10, level: 0 });
  await cockpitTraining(f.session, "training", { ...setup, skillAction: "queue-only" }, f.read);
  assert.equal(writes, 1);
  assert.equal(f.saves, 1);
});
for (const { name, before, amount, funding } of [
  { name: "uses personal ISK first", before: 30, amount: 100, funding: { corporateFunding: true } },
  {
    name: "preserves personal ISK in corporation-only mode",
    before: 200,
    amount: 130,
    funding: { fundingPolicy: "CORPORATION_WALLET_ONLY" },
  },
])
  test("Cockpit " + name + " and verifies one transfer even if its response is lost", async () => {
    const f = fixture();
    let personal = before,
      corporate = 500,
      writes = 0,
      reason = "",
      batchPurchases = 0;
    const buy = f.session.flow.buySkillFromOverlay;
    const packed = (fields: Record<string, string | number>) =>
      ({ type: "packedrow", fields }) as const;
    const bridgeAsk: Session["flow"]["flying"]["bridgeAsk"] = async (service, method, args) => {
      if (method === "GetCashBalance") return args[0] === 1 ? corporate : personal;
      if (method === "GetCorporation") return packed({ corporationID: 9 });
      if (method === "GetMember")
        return packed({ characterID: 7, corporationID: 9, roles: "134217728" });
      if (method === "GetTransactions") {
        const corp = args[3] === true;
        return {
          type: "list",
          items: reason
            ? [
                packed({
                  transactionID: corp ? 2 : 1,
                  amount: corp ? -amount : amount,
                  description: reason,
                  ownerID1: 9,
                  ownerID2: 7,
                }),
              ]
            : [],
        };
      }
      throw Error(`Unexpected ${service}.${method}`);
    };
    const bridgeDo: Session["flow"]["flying"]["bridgeDo"] = async (
      service,
      method,
      args,
      kwargs,
      of,
    ) => {
      if (service === "skillHandler" && method === "PurchaseSkills") {
        assert.deepEqual(args, [[10]]);
        assert.equal(personal, before + amount);
        batchPurchases++;
        personal -= 130;
        await buy(10, null);
        return null;
      }
      assert.equal(service + "." + method, "account.GiveCashFromCorpAccount");
      assert.deepEqual(args, [7, amount, 1000]);
      assert.equal(of, 9);
      assert.equal(kwargs?.toAccountKey, null);
      reason = String(kwargs?.reason);
      writes++;
      personal += amount;
      corporate -= amount;
      throw Error("Response lost after dispatch");
    };
    Object.assign(f.session.flow.flying, { bridgeAsk, bridgeDo });
    f.session.flow.buySkillFromOverlay = async (id, at) => {
      personal -= 130;
      await buy(id, at);
    };
    const setup = { goalTypeID: 100, maxSpendISK: 130, corporationID: 9 };
    if (before < 130)
      await assert.rejects(
        cockpitTraining(f.session, "training", setup, f.read),
        /personal wallet/,
      );
    assert.equal(writes, 0);
    const result = await cockpitTraining(f.session, "training", { ...setup, ...funding }, f.read);
    assert.equal(result.phase, "Training queued");
    assert.deepEqual((result.readout as any).transferReceipt, {
      personalTransactionID: 1,
      corporateTransactionID: 2,
      shortfall: amount * 100,
      corporationID: 9,
    });
    assert.equal((result.readout as any).totalCents, 13000);
    assert.equal(writes, 1);
    assert.equal(f.purchases, 1);
    assert.equal(batchPurchases, funding.fundingPolicy ? 1 : 0);
    assert.equal(personal, before + amount - 130);
    assert.equal(corporate, 500 - amount);
  });
