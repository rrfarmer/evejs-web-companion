import assert from "node:assert/strict";
import { test } from "node:test";
import { Object3D } from "three";
import { ControllerRun, type SofController } from "./controllers.ts";
import { setControllerVariable } from "./controllerVariables.ts";

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

test("repeating a controller command rearms it and unrelated inputs preserve its countdown", (t) => {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  const holder = new Object3D(), owner = new Object3D();
  holder.add(owner);
  const controller: SofController = {
    name: "Wormhole",
    variables: [{ name: "_WH_OnUse", value: 0 }, { name: "WH_State", value: 1 }],
    machines: [{
      name: "Wormhole_OnUse",
      start: 0,
      states: [
        { name: "Start", actions: [], transitions: [{ condition: "_WH_OnUse>0", to: 1 }] },
        { name: "OnUse", actions: [
          { k: "spawnParticles", emitter: 131, rate: 1 },
          { k: "setVar", variable: "_WH_OnUse", value: "_WH_OnUse-1" },
        ], transitions: [{ condition: "StateTime()>0.23456", to: 0 }] },
      ],
    }],
  };
  const spawns: number[] = [];
  const run = new ControllerRun(controller, owner, { build: async () => null, spawn: emitter => spawns.push(emitter) });
  const step = () => { now += 250; run.update(); };

  setControllerVariable(holder, "_WH_OnUse", 3, true);
  run.update();
  assert.equal(spawns.length, 1);
  setControllerVariable(holder, "WH_State", 0);
  for (let i = 0; i < 5; i++) step();
  assert.deepEqual(spawns, [131, 131, 131], "closing the portal preserves the remaining use actions");

  setControllerVariable(holder, "_WH_OnUse", 3, true);
  for (let i = 0; i < 5; i++) step();
  assert.deepEqual(spawns, [131, 131, 131, 131, 131, 131], "the same pose can start another use sequence");
});
