import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { readFileSync } from "node:fs";
import { miningPreparationDraft, miningPreparationConfig, preparationStateLabel,
  type MiningPreparationConfig, type MiningMemberPreparation } from "../app/miningPreparation.ts";
import { getMiningPreparationOptions, getMiningOperationLaunchPlan } from "../app/api.ts";

register("./svelteSsrHook.ts", import.meta.url);
const { render } = await import("svelte/server");
const Preparation = (await import("./MiningPreparation.svelte")).default;
const member = { characterID: 42, characterName: "Support01", accountName: "Test05", role: "COMMAND" as const, automationID: "" };
const readiness: MiningMemberPreparation = { characterID: 42, role: "COMMAND", state: "DEGRADED", equipment: "VERIFIED", supplies: "LOW",
  fittingName: "Support fit", sourceLabel: "Corporation division 2 at current station", reason: "Core optional — Heavy Water unavailable",
  observedAt: "2026-10-02T10:00:00.000Z", targets: [{ typeID: 16272, name: "Heavy Water", current: 3200, target: 5000, deficit: 1800,
    mode: "TOTAL_ABOARD", state: "LOW", required: false }] };
function markup(value: Partial<MiningMemberPreparation> = {}, over: object = {}): string {
  return render(Preparation, { props: { members: [member], preparation: { state: "PREPARING", members: [{ ...readiness, ...value }] }, ...over } }).body;
}

test("old definitions keep own-provider unique-match, local personal source and optional-supply defaults", () => {
  assert.deepEqual(miningPreparationConfig(miningPreparationDraft()), { source: { kind: "hangar" }, suppliesRequired: false });
  assert.equal(miningPreparationDraft().fittingID, 0); assert.equal(miningPreparationDraft().providerCharacterID, 0);
});

test("operation defaults round-trip strict corporation source and extra supply policy without modifying saved config", () => {
  const config: MiningPreparationConfig = { source: { kind: "corp", corporationID: 98, division: 2 }, providerCharacterID: 44,
    fittingID: 10, suppliesRequired: false, supplies: [{ typeID: 16272, target: 5000, mode: "TOTAL_ABOARD", eligibleFlags: [5, 133], required: true }] };
  const before = structuredClone(config), draft = miningPreparationDraft(config);
  assert.deepEqual(miningPreparationConfig(draft), config);
  draft.supplies[0]!.eligibleFlags.push(143); draft.supplies[0]!.target = 6000;
  assert.deepEqual(config, before, "editing must not mutate the active/saved operation projection");
  assert.equal(miningPreparationConfig(draft).source.kind, "corp", "there is no personal fallback");
});

test("invalid strict division/corporation and unsupported extra targets are refused before save", () => {
  for (const patch of [{ corporationID: 0 }, { division: 0 }, { division: 8 }]) {
    const draft = { ...miningPreparationDraft(), sourceKind: "corp" as const, corporationID: 98, ...patch };
    assert.throws(() => miningPreparationConfig(draft), /exact supply corporation/);
  }
  for (const target of [-1, 0, 1.5]) {
    const draft = miningPreparationDraft(); draft.supplies.push({ typeID: 16272, target, mode: "TOTAL_ABOARD", eligibleFlags: [5], required: false });
    assert.throws(() => miningPreparationConfig(draft), /extra supply/);
  }
});

test("readiness renders inventory facts, exact deficit, criticality, source and observed reason", () => {
  const html = markup();
  for (const word of ["Support01", "COMMAND", "VERIFIED", "LOW", "DEGRADED", "current 3200 / target 5000", "deficit 1800",
    "optional", "Corporation division 2", "Core optional", "Observed:"]) assert.ok(html.includes(word), word);
  assert.doesNotMatch(html, /planHash|reviewHash|equipmentFingerprint|operationRunID/);
});

test("all explicit preparation states remain separate from bot/session hosting and unknown observations", () => {
  for (const state of ["PENDING", "PREPARING", "VERIFIED", "DEGRADED", "BLOCKED", "RECOVERY_REQUIRED"] as const)
    assert.ok(markup({ state }).includes(preparationStateLabel(state)));
  const html = render(Preparation, { props: { members: [{ ...member, hosted: true, runtimeState: "running" }] } }).body;
  assert.match(html, /Preparation barrier: UNKNOWN/); assert.match(html, /has not been reported/);
  assert.doesNotMatch(html, />VERIFIED</);
  assert.match(markup({ current: null } as never, { stale: true }), /Last known server observation/);
});

test("optional Core shortage is DEGRADED while required shortage and ambiguous custody remain blocked", () => {
  assert.match(markup(), /DEGRADED/);
  assert.match(markup({ state: "BLOCKED", reason: "Core required — Heavy Water missing", supplies: "MISSING" }), /Core required/);
  assert.match(markup({ state: "RECOVERY_REQUIRED", reason: "Transfer outcome unproven", equipment: "UNKNOWN", supplies: "UNKNOWN" }), /RECOVERY REQUIRED/);
  assert.match(markup({}, { planning: true }), /Read-only member review/);
});

test("supply details render server effective criticality for global requirements and Core overrides", () => {
  for (const [required, state, reason] of [
    [true, "BLOCKED", "Global supply target required"],
    [false, "DEGRADED", "Heavy Water short; Core optional."],
    [true, "BLOCKED", "Required Core target is not FULL."],
  ] as const) {
    const html=markup({state,reason,targets:[{...readiness.targets[0]!,required}]});
    assert.match(html,new RegExp(` · ${required ? "required" : "optional"}`));
    assert.doesNotMatch(html,new RegExp(` · ${required ? "optional" : "required"}`));assert.ok(html.includes(reason));
  }
  const panel=readFileSync(new URL("./MiningOperations.svelte",import.meta.url),"utf8");
  assert.match(panel,/Require consumable targets before productive work \(Heavy Water follows Core fuel policy\)/);
  assert.doesNotMatch(panel,/Require saved-fitting consumable targets/);
});

test("aggregate barrier state renders independently from unsupported Defender observation", () => {
  const defender={...member,characterID:43,characterName:"Guard01",role:"DEFENDER" as const};
  const html=render(Preparation,{props:{members:[member,defender],preparation:{state:"VERIFIED",members:[{...readiness,state:"VERIFIED"}]}}}).body;
  assert.match(html,/Preparation barrier: VERIFIED/);assert.match(html,/Guard01/);assert.match(html,/UNKNOWN/);
  const preparing=render(Preparation,{props:{members:[member],preparation:{state:"PREPARING",members:[{...readiness,state:"PREPARING"}]}}}).body;
  assert.match(preparing,/Preparation barrier: PREPARING/);assert.doesNotMatch(preparing,/Preparation barrier: VERIFIED/);
});

test("preparation-options is an authenticated read-only MCC call without acquiring or selecting a pilot", async () => {
  const calls: { path: string; method: string; auth: string | null }[] = [];
  const value = { ok: true, definitions: { status: "READY", corporationID: 98, providerCharacterID: 44, contracts: [] }, pilot: { characterID: 42, name: "Support01" }, candidateSource: { kind: "hangar" } };
  const result = await getMiningPreparationOptions("Test05", 42, 44, { token: "fixture", fetch: async (input, init) => {
    calls.push({ path: String(input), method: init?.method ?? "GET", auth: new Headers(init?.headers).get("authorization") });
    return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
  } });
  assert.equal(result.definitions.providerCharacterID, 44); assert.equal(calls.length, 1);
  assert.equal(calls[0]?.method, "GET"); assert.equal(calls[0]?.auth, "Bearer fixture");
  assert.equal(calls[0]?.path, "/api/mining-operations/preparation-options?accountName=Test05&characterID=42&providerCharacterID=44");
});

test("fresh launch-plan preserves preparation member projection and combined pin without another engine", async () => {
  const result = await getMiningOperationLaunchPlan("OP", { token: "fixture", fetch: async () => new Response(JSON.stringify({
    ok: true, planHash: "server-pin", warnings: [], members: [], preparation: { state: "READY", members: [readiness] },
  }), { headers: { "content-type": "application/json" } }) });
  assert.equal(result.planHash, "server-pin"); assert.equal(result.preparation?.state, "READY");
  assert.deepEqual(result.preparation?.members?.[0], readiness);
});

test("MCC wiring keeps fresh review before Start, rejects unknown/blocked plan and owns no inventory loader", () => {
  const panel = readFileSync(new URL("./MiningOperations.svelte", import.meta.url), "utf8");
  const start = panel.slice(panel.indexOf("async function start("), panel.indexOf("async function stop("));
  assert.ok(start.indexOf("await getMiningOperationLaunchPlan") < start.indexOf("window.confirm"));
  assert.ok(start.indexOf('plan.preparation?.state !== "READY"') < start.indexOf("await startMiningOperation"));
  assert.match(start, /plan\.planHash/);
  assert.match(panel, /Default fitting definition provider/); assert.match(panel, /Physical supply source/);
  assert.match(panel, /row\.accountName === member\.accountName/);
  assert.match(panel, /generation !== editorGeneration/);
  assert.match(panel, /miningPreparationDraft\(definition\.preparation\)/);
  assert.match(panel, /preparation: preparationConfig/);
  assert.match(panel, /row\.runtime\.preparation/);
  assert.doesNotMatch(panel, /provisionShip|replenishProvisioning|centerApply|Factory|createAppFlow|readSpaceSnapshot/);
});
