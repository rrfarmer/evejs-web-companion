import assert from "node:assert/strict";
import { test } from "node:test";
import { Object3D } from "three";
import { ControllerRun, type SofController } from "./controllers.ts";

test("native sound actions fire once per state entry on that controller's observer", () => {
  const play = "worldobject_wormhole_play";
  const collapse = "worldobject_wormhole_collapse_play";
  const observer = "wormhole_sfx_observer";
  const controller: SofController = {
    name: "Wormhole",
    variables: [{ name: "WH_State", value: 1 }],
    machines: [{
      name: "Wormhole_State",
      start: 0,
      states: [
        { name: "start", actions: [], transitions: [{ condition: "WH_State == 1", to: 1 }] },
        { name: "On", actions: [{ k: "playSound", event: play, observer }], transitions: [{ condition: "WH_State == 0", to: 2 }] },
        { name: "Active2Off", actions: [{ k: "playSound", event: collapse, observer }], transitions: [] },
      ],
    }],
  };
  const events: string[][] = [];
  const run = new ControllerRun(controller, new Object3D(), {
    build: async () => null,
    playSound: (event, target) => events.push([event, target]),
  });
  run.update();
  assert.deepEqual(events, [[play, observer]]);
  run.setVariable("WH_State", 0);
  run.update();
  run.update();
  assert.deepEqual(events, [[play, observer], [collapse, observer]]);
});
