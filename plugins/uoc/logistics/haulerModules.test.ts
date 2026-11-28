import assert from "node:assert/strict";
import test from "node:test";
import { decodeSpaceSnapshot } from "../../../web/src/plugin-api/flying.ts";
import type { PilotSession } from "../../../web/src/plugin-api/pilotSession.ts";
import { closingToDockOrGate, createHaulerModules } from "./haulerModules.ts";

test("carrier defenses use live health and capacitor while propulsion follows a distant dock approach", async () => {
  const calls: unknown[][] = [];
  let releaseFit!: () => void;
  const fitReady = new Promise<void>(resolve => { releaseFit = resolve; });
  const session = { store: {
    station: { get: () => ({ online: { characterID: 1 } }) },
    fitting: { get: () => ({ activeShipID: 11, slots: [] }) },
    targeting: { get: () => ({ lockedByIDs: [] }) }, space: { get: () => ({ jams: [] }) },
  }, flow: { flying: {
    isSessionClosing: () => false,
    readFit: async () => { await fitReady; return true; },
    resolveDefenseModuleIDs: () => ({ shield: [21], armor: [22], hull: [], ancillary: [], hardeners: [23], weapons: [30],
      propulsion: [{ itemID: 24, typeID: 24, kind: "afterburner" }] }),
    bridgeDo: async (service: string, method: string, args: unknown[]) => { calls.push([service, method, ...args]); },
  } } } as unknown as PilotSession;
  const at = (sampledAtMs: number, hp: number, cap: number, meters: number, activeModuleIDs: number[]) => decodeSpaceSnapshot({
    stateValid: true, inSpace: true, shipID: 11, solarSystemID: 300, sampledAtMs,
    ship: { itemID: 11, characterID: 1, position: { x: 0, y: 0, z: 0 }, radius: 10, mode: "FOLLOW",
      shieldRatio: hp, armorRatio: .6, capacitorRatio: cap, activeModuleIDs },
    entities: [
      { itemID: 11, kind: "ship", targetEntityID: 32 },
      { itemID: 32, kind: "station", position: { x: meters, y: 0, z: 0 }, radius: 100 },
      ...(meters > 10000 ? [{ itemID: 33, kind: "ship", isNpc: true, npcEntityType: "npc", targetEntityID: 11 }] : []),
    ],
  });
  const observe = createHaulerModules(session, 1);
  const settle = () => new Promise<void>(resolve => setImmediate(resolve));
  const first = at(1, .5, .8, 20_000, []);
  assert.equal(closingToDockOrGate(first), true);
  assert.equal(observe(first, true, () => {}), undefined);
  assert.equal(calls.length, 0);
  releaseFit();
  await settle();
  assert.deepEqual(calls.map(call => call.slice(1, 3)), [["Activate", 21], ["Activate", 22], ["Activate", 23], ["Activate", 24]]);
  const second = at(2, 1, .8, 3000, [21, 22, 23, 24]);
  assert.equal(closingToDockOrGate(second), false);
  observe(second, false, () => {});
  await settle();
  assert.deepEqual(calls.slice(4).map(call => call.slice(1)), [
    ["Deactivate", 21, null], ["Deactivate", 23, null], ["Deactivate", 24, "moduleBonusAfterburner"],
  ]);
  const third = at(3, 1, .18, 3000, [22]);
  observe(third, false, () => {});
  await settle();
  assert.deepEqual(calls.at(-1), ["dogmaIM", "Deactivate", 22, null]);
  observe(third, false, () => {});
  await settle();
  assert.equal(calls.length, 8);
});
