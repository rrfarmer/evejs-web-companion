import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isShipProvisioningPath, isMiningCommandCenterPath, isPilotTrainingPath } from "../app/pageRoute.ts";
import { matchLabel } from "./centerClient.ts";
test("standalone path is exact and leaves MCC/Training ownership intact",()=>{for(const p of ["/ship-provisioning","/ship-provisioning/"])assert.ok(isShipProvisioningPath(p));for(const p of ["/","/ship-provisioning/x","/pilot-training","/mining-command-center"])assert.equal(isShipProvisioningPath(p),false);assert.ok(isMiningCommandCenterPath("/mining-command-center"));assert.ok(isPilotTrainingPath("/pilot-training"));});
test("entry lazy mounts Center before App and exposes explicit bounded Apply without cockpit acquisition",()=>{const main=readFileSync(new URL("../main.ts",import.meta.url),"utf8"),page=readFileSync(new URL("../ui/ProvisioningCenter.svelte",import.meta.url),"utf8"),client=readFileSync(new URL("./centerClient.ts",import.meta.url),"utf8");assert.ok(main.indexOf('import("./ui/ProvisioningCenter.svelte")')<main.indexOf('import("./ui/App.svelte")'));assert.doesNotMatch(main,/import App from/);assert.doesNotMatch(page,/AppFlow|createClientStore|restoreSessions|setInterval|selectCharacter|applyShip/);assert.doesNotMatch(client,/api\/bridge|sessionToken\.ts/);assert.match(client,/credentials: "omit"/);assert.match(page,/Opening this Center selects nobody/);assert.ok(page.includes('disabled={busy || !detail.applyReview.canApply}'));assert.match(page,/PENDING SELECTED REVIEW/);assert.match(page,/centerRoster\(token\)/);assert.doesNotMatch(readFileSync(new URL("../ui/Neocom.svelte",import.meta.url),"utf8"),/href="\/ship-provisioning"/);});
test("cockpit and global navigation omit the standalone Provisioning Center link", () => {
  const panel = readFileSync(new URL("../ui/ProvisioningPanel.svelte", import.meta.url), "utf8");
  const launchers = readFileSync(new URL("../ui/GlobalLaunchers.svelte", import.meta.url), "utf8");
  assert.doesNotMatch(panel, /href="\/ship-provisioning"|centerApply|centerLogin|centerRoster/);
  assert.doesNotMatch(launchers, /href="\/ship-provisioning"/);
});
test("match words never infer a fitting name from a hull",()=>{assert.equal(matchLabel({state:"MODIFIED",alternatives:[]}),"Modified / no exact equipment match");assert.equal(matchLabel({state:"UNKNOWN",alternatives:[]}),"Fit unknown");assert.match(matchLabel({state:"AMBIGUOUS",alternatives:[{name:"First",definition:{} as any},{name:"Second",definition:{} as any}]}),/First.*Second/);});
