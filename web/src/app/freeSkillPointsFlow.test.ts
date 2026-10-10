// Spending unallocated skill points, through the page controller.
//
// ⚠ THE RECEIPT IS THE NEW TOTAL, NOT THE REQUEST. The server caps the amount at
// what the skill is still missing and at what the character actually holds, so
// what was asked for and what was spent need not match. Reporting the request
// back would be inventing a number; the difference between the free-SP totals
// before and after is the only honest one.
//
// And a total that did not move means nothing was spent — the same class of
// silent decline that LoadAmmo and Deactivate both turned out to have on this
// server, so it is checked here rather than assumed away.

import test from "node:test";
import assert from "node:assert/strict";

import { createAppFlow } from "./flow.ts";
import { createClientStore } from "../store/clientStore.ts";

const SKILL_TYPE_ID = 3300;

interface Recorded {
  readonly path: string;
  readonly body: Record<string, unknown>;
}

/** A skills read reporting `freeSkillPoints`, in the BFF's own envelope shape. */
function skillsBody(freeSkillPoints: number) {
  return {
    ok: true,
    skills: {
      characterName: "Farmer",
      totalSkillPoints: 641792000,
      freeSkillPoints,
      skills: [],
      queue: null,
      serverNowMs: 1,
    },
  };
}

/**
 * A BFF whose free-SP total follows a scripted sequence of reads, and whose
 * apply call answers `result` — the server's new total.
 */
function makeFakeBff(options: {
  totals: number[];
  applyResult?: unknown;
  applyStatus?: number;
  applyBody?: unknown;
}) {
  const requests: Recorded[] = [];
  let read = 0;
  const fakeFetch = (async (input: unknown, init?: { body?: unknown }) => {
    const path = String(input);
    const body = init && typeof init.body === "string" ? JSON.parse(init.body) : {};
    requests.push({ path, body });
    const respond = (status: number, payload: unknown) => ({
      ok: status >= 200 && status < 300,
      status,
      async json() {
        return payload;
      },
    });
    // The page's own call (bridge/skillWrites.ts): the handler answers the free points left.
    if (path === "/api/bridge/call" && body.service === "skillHandler" && body.method === "ApplyFreeSkillPoints") {
      if (options.applyStatus && options.applyStatus !== 200) {
        return respond(options.applyStatus, options.applyBody);
      }
      return respond(200, { ok: true, service: "skillHandler", method: "ApplyFreeSkillPoints", result: options.applyResult ?? null, notifications: [] });
    }
    if (path.startsWith("/api/bridge/skills")) {
      const total = options.totals[Math.min(read, options.totals.length - 1)] ?? 0;
      read += 1;
      return respond(200, skillsBody(total));
    }
    return respond(200, { ok: true });
  }) as unknown as typeof fetch;
  return { fetch: fakeFetch, requests };
}

test("the page's own call names the skill by TYPE and the points, as a pilot's and as a write it means; its route is not asked", async () => {
  const store = createClientStore();
  const bff = makeFakeBff({ totals: [50000, 44000], applyResult: 44000 });
  const flow = createAppFlow(store, { fetch: bff.fetch });

  await flow.loadSkills();
  await flow.applyFreeSkillPoints(SKILL_TYPE_ID, 6000);

  const write = bff.requests.find((r) => r.path === "/api/bridge/call");
  // skillsvc.ApplyFreeSkillPoints: GetSkillHandler().ApplyFreeSkillPoints(skillTypeID, pointsToApply).
  assert.deepEqual(write?.body, { service: "skillHandler", method: "ApplyFreeSkillPoints", args: [SKILL_TYPE_ID, 6000], kwargs: null, pilot: true, confirm: true });
  assert.deepEqual(bff.requests.filter((r) => r.path === "/api/bridge/skills/apply-free-points"), []);
});

test("what was SPENT is the difference between the totals, not what was asked", async () => {
  const store = createClientStore();
  // Asked for 6000; the server only had room for 1500.
  const bff = makeFakeBff({ totals: [50000, 48500], applyResult: 48500 });
  const flow = createAppFlow(store, { fetch: bff.fetch });

  await flow.loadSkills();
  await flow.applyFreeSkillPoints(SKILL_TYPE_ID, 6000);

  assert.match(store.skills.get().lastAction ?? "", /Applied 1,500 skill points/);
  assert.equal(store.skills.get().actionError, null);
});

test("⚠ a total that did not move is a silent decline, and says so", async () => {
  const store = createClientStore();
  const bff = makeFakeBff({ totals: [50000, 50000], applyResult: 50000 });
  const flow = createAppFlow(store, { fetch: bff.fetch });

  await flow.loadSkills();
  await flow.applyFreeSkillPoints(SKILL_TYPE_ID, 6000);

  assert.match(store.skills.get().actionError ?? "", /spent no points/i);
  assert.match(store.skills.get().actionError ?? "", /gave no reason/i);
});

test("a refusal carries the SERVER's own reason", async () => {
  const store = createClientStore();
  const bff = makeFakeBff({
    totals: [50000, 50000],
    applyStatus: 409,
    applyBody: {
      ok: false,
      error: "CannotApplyFreePointsWhileTrainingSkill",
      message: "You cannot apply free skill points to the skill you are training.",
    },
  });
  const flow = createAppFlow(store, { fetch: bff.fetch });

  await flow.loadSkills();
  await flow.applyFreeSkillPoints(SKILL_TYPE_ID, 6000);

  assert.match(store.skills.get().actionError ?? "", /training/i);
});

test("the sheet is re-read, so the new total is on screen with the message", async () => {
  const store = createClientStore();
  const bff = makeFakeBff({ totals: [50000, 44000], applyResult: 44000 });
  const flow = createAppFlow(store, { fetch: bff.fetch });

  await flow.loadSkills();
  await flow.applyFreeSkillPoints(SKILL_TYPE_ID, 6000);

  assert.equal(store.skills.get().freeSkillPoints, 44000);
  const order = bff.requests.map((r) => r.path);
  const wrote = order.indexOf("/api/bridge/call");
  const reread = order.findIndex((p, i) => i > wrote && p.startsWith("/api/bridge/skills"));
  assert.ok(reread > wrote, "the sheet is re-read after the write");
});

test("what the handler answers is the receipt; where it answers no number, the sheet read after it is", async () => {
  const spentBy = async (applyResult: unknown): Promise<string | null> => {
    const store = createClientStore();
    // The handler says 48,500 are left; the sheet read after it says 44,000.
    const bff = makeFakeBff({ totals: [50000, 44000], applyResult });
    const flow = createAppFlow(store, { fetch: bff.fetch });
    await flow.loadSkills();
    await flow.applyFreeSkillPoints(SKILL_TYPE_ID, 6000);
    return store.skills.get().lastAction;
  };
  assert.equal(await spentBy(48500), "Applied 1,500 skill points");
  for (const none of [null, "48500", { type: "long", value: "48500" }, [48500]]) {
    assert.equal(await spentBy(none), "Applied 6,000 skill points", JSON.stringify(none));
  }
});
