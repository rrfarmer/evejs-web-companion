// The plugin's two controls in the Pilot Hangar, drawn. Each name a control forgot to import, and
// each condition on showing itself, only shows when it is.

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("../../../web/src/ui/svelteSsrHook.ts", import.meta.url);

const { render } = await import("svelte/server");
const SquadFly = (await import("../ui/SquadFly.svelte")).default;
const MemberFlies = (await import("../ui/MemberFlies.svelte")).default;
const { companionSetups, withSetup } = await import("../lib/companionSettings.ts");
const { DEFAULT_COMPANION_SETUP } = await import("../lib/fleetCompanionLoop.ts");

const SQUAD = { id: "squad-1", name: "Wing", color: "#52d9a3" };
const PILOT = 90000001;

function fly(memberIDs: readonly number[]): string {
  return render(SquadFly as never, {
    props: {
      squad: SQUAD,
      memberIDs,
      pilotNameFor: () => "Ore Farmer",
      optionsFor: () => null,
      accountNameFor: () => "Test Account",
      onHandedOver: async () => {},
      onChanged: () => {},
      say: () => {},
    },
  } as never).body;
}

const tick = (): string => render(MemberFlies as never, { props: { squad: SQUAD, characterID: PILOT } } as never).body;

test("a squad with nobody set up offers no FLY", () => {
  companionSetups.set({});
  assert.doesNotMatch(fly([PILOT]), /FLY/);
});

test("a squad with a pilot set up offers FLY, and says how it differs from ALL", () => {
  companionSetups.set(withSetup({}, SQUAD.id, PILOT, DEFAULT_COMPANION_SETUP));
  const body = fly([PILOT]);
  assert.match(body, />FLY</);
  assert.match(body, /keep flying when this tab closes/);
  assert.match(body, /Wing/);
});

test("a pilot set up but no longer in the squad does not count", () => {
  companionSetups.set(withSetup({}, SQUAD.id, PILOT, DEFAULT_COMPANION_SETUP));
  assert.doesNotMatch(fly([90000002]), /FLY/);
});

test("the tick shows whether this pilot flies in this squad", () => {
  companionSetups.set({});
  assert.match(tick(), /Flies as companion/);
  assert.doesNotMatch(tick(), /checked/);
  companionSetups.set(withSetup({}, SQUAD.id, PILOT, DEFAULT_COMPANION_SETUP));
  assert.match(tick(), /checked/);
});
