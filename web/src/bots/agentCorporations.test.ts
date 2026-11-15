// The agent finder's corporation list (agentCorporations.ts): which
// corporations it offers, what it calls them, and what a failed read looks like.
// Ids and names here are invented, not observed.

import test from "node:test";
import assert from "node:assert/strict";
import type { ApiOptions } from "../app/api.ts";
import { agentCorporations, createAgentCorporationsReader, readAgentCorporations, type AgentCorporation } from "./agentCorporations.ts";

test("each corporation is offered once, by name, in name order", () => {
  const agents = [
    { corporationID: 1000002 },
    { corporationID: 1000001 },
    { corporationID: 1000002 },
    { corporationID: null },
  ];
  const names: Record<number, string> = { 1000001: "Zeta Couriers", 1000002: "Alpha Freight" };
  assert.deepEqual(agentCorporations(agents, (id) => names[id] ?? null), [
    { id: 1000002, name: "Alpha Freight" },
    { id: 1000001, name: "Zeta Couriers" },
  ]);
});

test("a corporation whose name has not resolved is still offered", () => {
  assert.deepEqual(agentCorporations([{ corporationID: 1000003 }], () => null), [
    { id: 1000003, name: "Corporation 1000003" },
  ]);
});

interface Seen {
  readonly url: string;
}

function options(answer: (url: string) => unknown, seen: Seen[]): ApiOptions {
  const fetchStub = (async (input: RequestInfo | URL) => {
    const url = String(input);
    seen.push({ url });
    return new Response(JSON.stringify(answer(url)), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetch: fetchStub, token: "test-token" };
}

test("the list is read per level for the step's kind, and named in one batch", async () => {
  const seen: Seen[] = [];
  const corporations = await readAgentCorporations("courier", options((url) => {
    if (url.includes("/api/agents/find")) {
      const level = Number(new URL(url, "http://x").searchParams.get("level"));
      return { ok: true, agents: [{ agentID: level, name: `Agent ${level}`, corporationID: level === 4 ? 1000002 : 1000001 }] };
    }
    return { ok: true, names: { "corporation:1000001": "Zeta Couriers", "corporation:1000002": "Alpha Freight" } };
  }, seen));
  assert.deepEqual(corporations, [
    { id: 1000002, name: "Alpha Freight" },
    { id: 1000001, name: "Zeta Couriers" },
  ]);
  const finds = seen.filter((s) => s.url.includes("/api/agents/find"));
  assert.deepEqual(finds.map((s) => new URL(s.url, "http://x").searchParams.get("level")).sort(), ["1", "2", "3", "4"]);
  assert.ok(finds.every((s) => /kind=courier/.test(s.url)));
  assert.equal(seen.filter((s) => s.url.includes("/api/names")).length, 1);
});

test("the combat finder's list is read from security agents, levels 1 to 5", async () => {
  const seen: Seen[] = [];
  await readAgentCorporations("encounter", options(() => ({ ok: true, agents: [] }), seen));
  assert.equal(seen.length, 5, "an empty agent list still asked for names, or skipped a level");
  assert.ok(seen.every((s) => /kind=encounter/.test(s.url)));
});

test("a failed read throws, and is never an empty list", async () => {
  const failing: ApiOptions = {
    fetch: (async () => new Response("{}", { status: 500 })) as typeof fetch,
    token: "test-token",
  };
  await assert.rejects(readAgentCorporations("courier", failing));
});

test("the reader keeps each kind's answer, and asks again after a failure", async () => {
  const asked: string[] = [];
  let fail = true;
  const read = createAgentCorporationsReader(async (kind): Promise<AgentCorporation[]> => {
    asked.push(kind);
    if (fail) throw new Error("down");
    return [{ id: 1000001, name: kind }];
  });
  await assert.rejects(read("courier"));
  fail = false;
  assert.deepEqual(await read("courier"), [{ id: 1000001, name: "courier" }]);
  await read("courier");
  assert.deepEqual(await read("encounter"), [{ id: 1000001, name: "encounter" }]);
  assert.deepEqual(asked, ["courier", "courier", "encounter"]);
});
