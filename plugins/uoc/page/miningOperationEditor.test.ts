import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { compile } from "svelte/compiler";
import { render } from "svelte/server";
import type { MiningOperationDefinition, VerifiedOperationPilot } from "../restored/app/apiTypes.ts";
import { validateDefinition } from "../operations/miningStore.ts";

register("../../../web/src/ui/svelteSsrHook.ts", import.meta.url);
const filename = new URL("../restored/ui/MiningOperations.svelte", import.meta.url);
const source = readFileSync(filename, "utf8");
const operations = "/api/plugins/uoc/mining-operations";
const corporationID = 98000001;
const home = { stationID: 60006292, stationName: "Home Factory", systemName: "Kheram" };
const separateHome = { stationID: 60014617, stationName: "Parking Factory", systemName: "Mista" };
const supply = { typeID: 16272, target: 500, mode: "TOTAL_ABOARD" as const, eligibleFlags: [5, 133] as const, required: false };

const definition: MiningOperationDefinition = {
  operationID: "fleet",
  revision: 4,
  name: "Night fleet",
  area: { anchorSystemID: 30003482, anchorSystemName: "Mista", reach: "CURRENT_SYSTEM", targetClasses: ["BELT"] },
  targetPolicy: "ANY_ELIGIBLE",
  policies: {
    version: 1,
    resourcePolicy: { mode: "PREFER_LIST", source: "MANUAL", typeIDs: [1230] },
    travelAssist: { mode: "AUTO" },
    parking: { mode: "RETURN_HOME_UNLOAD_DOCK", destination: home, corporationDivision: 1, corporationID },
  },
  unloadPolicy: "HAULER_SERVICE",
  unloadDestination: { ...home, corporationDivision: 1, corporationID },
  members: Array.from({ length: 15 }, (_, index) => ({
    characterID: index + 1, characterName: "Pilot " + (index + 1), accountName: "account-" + (index + 1),
    role: index < 8 ? "MINER" : index < 11 ? "HAULER" : "DEFENDER", routineMode: "STANDARD", automationID: "",
  })),
  preparation: { source: { kind: "hangar" }, suppliesRequired: false, replenishSupplies: true, supplies: [supply] },
  oreLogistics: { version: 1, remoteCompression: false, compressedJettisonFraction: .5 },
};

type Scenario = {
  definition: MiningOperationDefinition | null;
  pilots: VerifiedOperationPilot[];
  save?: () => Promise<void>;
};
const testContext = globalThis as typeof globalThis & { miningEditorTest?: Scenario };

async function openEditor(saved: MiningOperationDefinition | null, actions: string) {
  const setup = [
    "const scenario = globalThis.miningEditorTest;",
    "roster = scenario.pilots;",
    "if (scenario.definition) {",
    "  payload = { operations: [{ definition: scenario.definition, runtime: { operationID: scenario.definition.operationID,",
    "    state: 'DRAFT', members: [], history: [], logisticsTail: [], stopFailures: [] } }], targetBoard: [], capabilities: {} };",
    "  editOperation(scenario.definition);",
    "} else newOperation();",
    actions,
    "scenario.save = save;",
  ].join("\n");
  // The server renderer exercises the real editor handlers and its template without a browser or live WC.
  const compiled = compile(source.replace("</script>", setup + "\n</script>"), { filename: fileURLToPath(filename), generate: "server" });
  const code = compiled.js.code.replace(/from (['"])([^'"]+)\1/g, (_line, _quote, uri: string) =>
    "from " + JSON.stringify(uri.startsWith(".") ? new URL(uri, filename).href : import.meta.resolve(uri)));
  const { default: Editor } = await import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));
  const pilots = definition.members.map<VerifiedOperationPilot>(member => ({ ...member,
    corporationID, corporationName: "Fixture corporation", shipName: null, availability: "AVAILABLE", reason: "",
  }));
  const entry: Scenario = { definition: saved, pilots };
  let submission: MiningOperationDefinition | undefined;
  const fetcher: typeof fetch = async (input, init) => {
    assert.equal(new URL(String(input)).pathname, operations);
    assert.equal(init?.method, "POST");
    submission = JSON.parse(String(init.body)) as MiningOperationDefinition;
    return Response.json({ ok: true, operations: [], targetBoard: [], capabilities: {} });
  };
  testContext.miningEditorTest = entry;
  try {
    const html = render(Editor, { props: { accountName: "operator", access: { baseUrl: "http://editor.test", fetch: fetcher } } }).body;
    return { html, async submitted() { await entry.save!(); return submission; }, async save() {
      await entry.save!();
      assert.ok(submission, "Save did not submit the operation");
      return submission;
    } };
  } finally {
    delete testContext.miningEditorTest;
  }
}

test("Edit holds values across all four tabs and reopens the saved operation", async () => {
  const editor = await openEditor(definition, [
    'name = "Revised fleet"; showEditorTab("fleet"); expandedFitting = 1;',
    "patchMember(1, { preparation: { fittingID: 123 } });",
    'showEditorTab("logistics"); unloadDivision = 3;',
    'showEditorTab("advanced"); travelAssist = false;',
    'showEditorTab("basic"); reach = "CURRENT_AND_ADJACENT"; showEditorTab("fleet");',
  ].join("\n"));
  assert.match(editor.html, /8 Miner · 3 Hauler · 4 Defender/);
  assert.equal((editor.html.match(/role="tab"/g) ?? []).length, 4);
  assert.equal((editor.html.match(/role="tabpanel"/g) ?? []).length, 4);
  assert.match(editor.html, /role="tabpanel"[^>]*data-editor-tab="basic" hidden/);
  assert.match(editor.html, /role="tabpanel"[^>]*data-editor-tab="fleet">/);
  assert.equal((editor.html.match(/Fitting options for/g) ?? []).length, 1);
  assert.match(editor.html, /<footer[^>]*>[\s\S]*Cancel[\s\S]*Save operation/);
  const saved = await editor.save();
  assert.equal(saved.name, "Revised fleet");
  assert.equal(saved.revision, 4);
  assert.equal(saved.area.reach, "CURRENT_AND_ADJACENT");
  assert.deepEqual(saved.members[0]?.preparation, { fittingID: 123 });
  assert.equal(saved.policies?.travelAssist?.mode, "DISABLED");
  assert.deepEqual(saved.policies?.resourcePolicy, definition.policies?.resourcePolicy);
  assert.deepEqual(saved.preparation?.supplies, [supply]);
  assert.deepEqual(saved.oreLogistics, definition.oreLogistics);
  assert.equal(saved.unloadDestination?.corporationDivision, 3);
  assert.equal(saved.policies?.parking.corporationDivision, 3);
  const reopened = await openEditor(saved, 'showEditorTab("logistics");');
  assert.match(reopened.html, /Revised fleet/);
  assert.match(reopened.html, /type="checkbox" checked[^>]*>\s*Use delivery destination for parking/);
  assert.doesNotMatch(reopened.html, /Parking destination <input/);
});

test("an open editor follows the running fleet and keeps its Stop actions available", async () => {
  function disabled(html: string, label: string) {
    const buttons = html.replace(/<!--.*?-->/gs,"").matchAll(/<button\b([^>]*)>\s*([^<>]*?)\s*<\/button>/g);
    const button = [...buttons].find(([, , text]) => text === label);
    assert.ok(button, label);
    return /\bdisabled\b/.test(button[1]!);
  }
  const active = 'payload.operations[0].runtime = {...payload.operations[0].runtime, state: "ACTIVE", operationRunID: "shift"};';
  const during = await openEditor(definition, active);
  assert.equal(disabled(during.html, "Save operation"), true);
  assert.equal(disabled(during.html, "Delete operation"), true);
  assert.equal(disabled(during.html, "Stop operation"), false);
  assert.match(during.html, /finish.*before editing or deleting/i);
  assert.equal(await during.submitted(), undefined);
  const card = await openEditor(definition, active + ' editing = false; choosingStop = "fleet";');
  assert.equal(disabled(card.html, "Edit"), true);
  assert.equal(disabled(card.html, "Return home now"), false);
  assert.equal(disabled(card.html, "Collect remaining freight, then return"), false);
  const parking = await openEditor(definition, active + ' editing = false; payload.operations[0].runtime.stopFreight = "RETURN_HOME";');
  assert.equal(disabled(parking.html, "Retry Stop"), false);
  const ended = await openEditor(definition, 'editing = false; payload.operations[0].runtime.state = "STOPPED";');
  assert.equal(disabled(ended.html, "Edit"), false);
  assert.equal(disabled(ended.html, "Delete operation"), false);
});

test("New Operation starts in Basics and saves a new fleet with a linked destination", async () => {
  const blank = await openEditor(null, "");
  assert.match(blank.html, /New operation/);
  assert.match(blank.html, /0 Miner · 0 Hauler · 0 Defender/);
  assert.match(blank.html, /role="tabpanel"[^>]*data-editor-tab="basic">/);
  const editor = await openEditor(null, [
    'name = "New fleet"; chooseSystem({ id: 30003482, name: "Mista" });',
    'showEditorTab("fleet"); addPilot(scenario.pilots[0]);',
    'showEditorTab("logistics"); void chooseStation({ id: 60006292, name: "Home Factory", systemName: "Kheram", kind: "station" });',
    'stopMode = "RETURN_HOME_DOCK"; showEditorTab("advanced");',
  ].join("\n"));
  const saved = await editor.save();
  assert.equal(saved.operationID, undefined);
  assert.equal(saved.name, "New fleet");
  assert.equal(saved.members.length, 1);
  assert.equal(saved.unloadPolicy, "SELF_UNLOAD");
  assert.deepEqual(saved.policies?.parking.destination, home);
  const roles = editor.html.match(/<select[^>]+aria-label="Role for Pilot 1"[^>]*>([\s\S]*?)<\/select>/)?.[1];
  assert.ok(roles);
  assert.deepEqual(Array.from(roles.matchAll(/<option value="([^"]+)"/g), match => match[1]), ["MINER", "HAULER", "DEFENDER"]);
});

test("Unavailable controls are hidden and saved compression, Command and cargo targets round-trip", async () => {
  const commander = { ...definition.members[14]!, role: "COMMAND" as const };
  const legacy: MiningOperationDefinition = {
    ...definition,
    members: [...definition.members.slice(0, 14), commander],
    preparation: { ...definition.preparation!, suppliesRequired: true, supplies: [{ ...supply, required: true }] },
    oreLogistics: { version: 1, remoteCompression: true, compressedJettisonFraction: .65 },
    support: { version: 1, characterID: commander.characterID, fleetPolicy: "MANAGED", maintainBursts: true,
      useIndustrialCore: true, coreRequirement: "requireCore", enableCompression: true, selfMining: false,
      tractor: true, collection: "TRACTOR_AND_COLLECT", compressCollectedOre: true, supportLoss: "PAUSE" },
  };
  const editor = await openEditor(legacy, 'showEditorTab("advanced"); name = "Saved legacy fleet";');
  assert.doesNotMatch(editor.html, /Additional cargo supply targets|Supply type ID|Add cargo target/);
  assert.doesNotMatch(editor.html, /Ore compression and freight|Remote Fleet Compression|Compressed ore jettison threshold/);
  assert.match(editor.html, /Top up supplies for pilots with a selected fitting/);
  assert.equal((editor.html.match(/<option value="COMMAND"/g) ?? []).length, 1);
  assert.match(editor.html, /<option value="COMMAND"[^>]*disabled[^>]*>Command \/ Support \(saved\)/);
  const saved = await editor.save();
  validateDefinition(saved);
  assert.equal(saved.name, "Saved legacy fleet");
  assert.deepEqual(saved.members[14], commander);
  assert.deepEqual(saved.oreLogistics, legacy.oreLogistics);
  assert.deepEqual(saved.support, legacy.support);
  assert.deepEqual(saved.preparation, legacy.preparation);
  const reopened = await openEditor(saved, 'showEditorTab("fleet");');
  assert.match(reopened.html, /<option value="COMMAND"[^>]*selected[^>]*>Command \/ Support \(saved\)/);
});

for (const destination of [home, separateHome]) {
  test("Edit preserves separate parking settings at " + destination.stationName, async () => {
    const parking = { ...definition.policies!.parking, destination, corporationDivision: 7 };
    const editor = await openEditor({ ...definition, policies: { ...definition.policies!, parking } },
      'showEditorTab("logistics"); linkParking(true); showEditorTab("fleet"); showEditorTab("logistics"); linkParking(false);');
    assert.match(editor.html, /Parking destination <input/);
    assert.match(editor.html, /Parking hangar <select/);
    const saved = await editor.save();
    assert.deepEqual(saved.unloadDestination, definition.unloadDestination);
    assert.deepEqual(saved.policies?.parking, parking);
  });
}

test("Linked Upwell parking saves the dock identity and hangar in their existing fields", async () => {
  const structure = { kind: "structure" as const, id: 1030000000001, name: "Ore refinery",
    solarSystemID: 30003482, solarSystemName: "Mista" };
  const editor = await openEditor({
    ...definition,
    unloadDestination: { ...structure, corporationDivision: 1, corporationID },
    policies: { ...definition.policies!, parking: { ...definition.policies!.parking, destination: structure } },
  }, 'showEditorTab("logistics"); unloadDivision = 4;');
  const saved = await editor.save();
  assert.deepEqual(saved.unloadDestination, { ...structure, corporationDivision: 4, corporationID });
  assert.deepEqual(saved.policies?.parking, {
    mode: "RETURN_HOME_UNLOAD_DOCK", destination: structure, corporationDivision: 4, corporationID,
  });
});

test("The supply source can be saved and reopened before the corporation is known", async () => {
  const editor = await openEditor(definition,
    'showEditorTab("advanced"); preparation.sourceKind = "corp"; preparation.division = 7;');
  const selection = editor.html.split("Physical supply source")[1]?.split("</select>")[0];
  assert.ok(selection);
  assert.match(selection, /Each member's local personal hangar/);
  for (let division = 1; division <= 7; division++) {
    assert.match(selection, new RegExp("Corporation Division " + division + "</option>"));
  }
  assert.match(selection, /<option value="7" selected(?:="")?>Corporation Division 7/);
  const saved = await editor.save();
  assert.deepEqual(saved.preparation?.source, { kind: "corp", division: 7 });
  validateDefinition(saved);

  const reopened = await openEditor(saved, 'showEditorTab("advanced");');
  assert.match(reopened.html, /<option value="7" selected(?:="")?>Corporation Division 7/);
  assert.deepEqual((await reopened.save()).preparation?.source, saved.preparation?.source);

  const personal = await openEditor(saved, 'preparation.sourceKind = "hangar";');
  assert.deepEqual((await personal.save()).preparation?.source, { kind: "hangar" });
});
