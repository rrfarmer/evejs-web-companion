import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";

register("./svelteSsrHook.ts", import.meta.url);

const { render } = await import("svelte/server");
const MiningOperations = (await import("./MiningOperations.svelte")).default;
const MiningCommandCenter = (await import("./MiningCommandCenter.svelte")).default;
const GlobalLaunchers = (await import("./GlobalLaunchers.svelte")).default;

test("Mining Command Center renders without a selected pilot workspace", () => {
  const output = render(MiningOperations as never, { props: {} } as never);
  const text = output.body.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
  assert.match(text, /Mining Operations/);
  assert.match(text, /one jointly moving industrial fleet/i);
  assert.match(text, /Global target board/i);
});

test("Command Center has a dedicated page entry without mounting a pilot workspace", () => {
  const output = render(MiningCommandCenter as never, { props: {} } as never);
  assert.match(output.body, /Mining Command Center/);
  const globalPanel = readFileSync(new URL("./GlobalPanel.svelte", import.meta.url), "utf8");
  const main = readFileSync(new URL("../main.ts", import.meta.url), "utf8");
  const shell = readFileSync(new URL("./MiningCommandCenter.svelte", import.meta.url), "utf8");
  assert.match(main, /isMiningCommandCenterPath\(window\.location\.pathname\)/);
  assert.match(main, /import\("\.\/ui\/MiningCommandCenter\.svelte"\)/);
  assert.doesNotMatch(globalPanel, /<MiningOperations/);
  assert.doesNotMatch(shell, /createAppFlow|createSession|readSpaceSnapshot|Overview|Workspace/);
  assert.doesNotMatch(readFileSync(new URL("./PanelHost.svelte", import.meta.url), "utf8"), /<MiningOperations/);
});

test("the shared WC header opens the standalone MCC URL instead of a floating window", () => {
  const output = render(GlobalLaunchers as never, {
    props: { openIds: new Set(), companionCount: 0, onOpen: () => {} },
  } as never);
  assert.match(output.body, /<a\b[^>]*data-launch="miningOperations"[^>]*href="\/mining-command-center"/);
  assert.doesNotMatch(output.body, /<button\b[^>]*data-launch="miningOperations"/);
  for (const id of ["botManager", "plugins", "industryManager", "companion"]) {
    assert.match(output.body, new RegExp(`<button\\b[^>]*data-launch="${id}"`));
  }
});

test("supported Defender and unsupported targets describe their actual execution contract", () => {
  const source = readFileSync(new URL("./MiningOperations.svelte", import.meta.url), "utf8");
  assert.match(source, /Ice — online Ice Harvesters required/);
  assert.match(source, /Gas — not supported yet/);
  assert.match(source, /<option value="DEFENDER">Standard Defender<\/option>/);
  assert.match(source, /Standard Defender follows the operation target using shared mobile combat/);
  assert.match(source, /exact saved fitting must pass equipment, skills and ammunition readiness/);
  assert.doesNotMatch(source, /Defender — execution not supported/);
  assert.match(source, /dynamic discovery deferred/);
  assert.match(source, /bind:group=\{targetFamily\} value="ORE_ANOMALY"/);
});

test("MCC duration and extension controls consume server policy, not a local 24h cap", () => {
  const source = readFileSync(new URL("./MiningOperations.svelte", import.meta.url), "utf8");
  assert.match(source, /payload\?\.capabilities.hostedRunPolicy/);
  assert.equal((source.match(/runPolicy\?\.durationChoices/g) ?? []).length, 1);
  assert.match(source, /<MiningOperationRun runtime=\{row.runtime\} policy=\{runPolicy\}/);
  assert.doesNotMatch(source, /cap 24h|capped at 24|> 1440|\[60, 240, 720, 1440\]/);
  assert.doesNotMatch(source, /readSpaceSnapshot/);
});

test("Fleet Parking uses an explicit dockable destination and defaults old definitions to Stay", () => {
  const source = readFileSync(new URL("./MiningOperations.svelte", import.meta.url), "utf8");
  assert.match(source, /On manual Stop \/ Fleet Parking/);
  assert.match(source, /definition\.policies\?\.parking.mode \?\? "STAY_IN_PLACE"/);
  assert.match(source, /Use delivery destination as parking destination/);
  assert.match(source, /parking\.destination\.name : row\.definition\.policies\.parking\.destination\.stationName/);
  assert.match(source, /resolved\.stationID === Number\(value\)/);
  assert.match(source, /stopMode !== "STAY_IN_PLACE" && \(!parkingStation \|\| parkingError\)/);
  assert.match(source, /Retry parking/);
  assert.match(source, /failure\.message/);
  assert.doesNotMatch(source, /createAppFlow|runFleetParking|getScriptObservation/);
});

test("opening and viewing Command Center adds zero readSpaceSnapshot polling", () => {
  const panel = readFileSync(new URL("./MiningOperations.svelte", import.meta.url), "utf8");
  const shell = readFileSync(new URL("./MiningCommandCenter.svelte", import.meta.url), "utf8");
  const api = readFileSync(new URL("../app/api.ts", import.meta.url), "utf8");
  const managementSlice = api.slice(
    api.indexOf("export interface MiningOperationMemberDefinition"),
    api.indexOf("/** Atomic acquisition", api.indexOf("export interface MiningOperationMemberDefinition")),
  );
  assert.doesNotMatch(panel, /readSpaceSnapshot|getSpaceSnapshot|loadSpaceSnapshot/);
  assert.doesNotMatch(shell, /readSpaceSnapshot|getSpaceSnapshot|loadSpaceSnapshot/);
  assert.doesNotMatch(managementSlice, /readSpaceSnapshot|getSpaceSnapshot|loadSpaceSnapshot/);
  assert.match(panel, /loadMiningOperations/);
});

test("new drafts offer Auto travel assist without reinterpreting old definitions", () => {
  const source = readFileSync(new URL("./MiningOperations.svelte", import.meta.url), "utf8");
  assert.match(source, /let travelAssist = \$state\(true\)/);
  assert.match(source, /travelAssist = definition\.policies\?\.travelAssist\?\.mode === "AUTO"/);
  assert.match(source, /Use fitted AB\/MWD/);
});

test("system editor resolves either side and only offers operation-compatible routines", () => {
  const source = readFileSync(new URL("./MiningOperations.svelte", import.meta.url), "utf8");
  assert.match(source, /findMapLocations\(value\.trim\(\), "system"/);
  assert.match(source, /resolveDestination\(anchorSystemID/);
  assert.match(source, /script\.roles\[member\.role\]\?\.compatible/);
  assert.match(source, /disabled=\{busy !== null \|\| !anchorValid\}/);
});

test("the dashboard explains a split main body and logistics tail", () => {
  const source = readFileSync(new URL("./MiningOperations.svelte", import.meta.url), "utf8");
  assert.match(source, /Logistics tail/);
  assert.match(source, /main body may relocate/);
  assert.match(source, /DRAINING/);
});

test("Edit reveals and focuses the populated editor; Self-Unload has explicit delivery and profile display", () => {
  const source = readFileSync(new URL("./MiningOperations.svelte", import.meta.url), "utf8");
  const edit = source.slice(source.indexOf("function editOperation"), source.indexOf("function addPilot"));
  assert.match(edit, /name = definition.name/);
  assert.match(edit, /editing = true;\s+void revealEditor\(\)/);
  assert.match(source, /await tick\(\);\s+editor\?\.scrollIntoView/);
  assert.match(source, /focus\(\{ preventScroll: true \}\)/);
  assert.match(source, /bind:this=\{editor\}/);
  assert.match(source, /Editing \$\{name\}/);
  assert.match(source, /Miner \/ Self Unload · v1/);
  assert.match(source, /Miner delivery destination/);
  assert.match(source, /row.definition.area.targetClasses\[0\], row.definition.unloadPolicy/);
});

test("normal BELT setup defaults to Standard profiles and keeps Custom as Advanced", () => {
  const source = readFileSync(new URL("./MiningOperations.svelte", import.meta.url), "utf8");
  assert.match(source, /routineMode: "STANDARD"/);
  assert.match(source, /Standard \/ Automatic/);
  assert.match(source, /Custom \/ Advanced/);
  assert.match(source, /\$\{label\} Miner \/ Hauler Service/);
  assert.match(source, /\$\{label\} Hauler/);
  assert.match(source, /family === "BELT" \? "Belt"/);
  assert.match(source, /getMiningOperationLaunchPlan/);
  assert.match(source, /findMapLocations\(value\.trim\(\), "station"/);
  assert.match(source, /Corporation division/);
  assert.match(source, /Start readiness/);
  assert.doesNotMatch(source, /getBotScript\(/);
});
