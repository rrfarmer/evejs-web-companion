import assert from "node:assert/strict";
import test from "node:test";
import { DISTANCE } from "./agencyAgents.ts";
import { agencyFactionWarfareSystems, agencyFactionWarfareUpgrade, DEFAULT_AGENCY_FW_FILTERS } from "./agencySites.ts";
import type { MilitiaSystem } from "./militiaEnlistment.ts";
import type { JsonValue } from "./wire.ts";

const HEYDIELES = 30004979;
const FLIET = 30004980;
const CALDARI = 500001;
const GALLENTE = 500004;

function complex(id: number, faction: number, targetID: string): JsonValue {
  return { type: "object", name: "util.KeyVal", args: { type: "dict", entries: [
    ["instanceID", id], ["factionID", faction], ["targetID", targetID],
  ] } };
}

test("Agency factional warfare shows only an occupier's complexes and applies the native filters", () => {
  const sites: JsonValue = { type: "dict", entries: [
    [HEYDIELES, { type: "list", items: [complex(1, CALDARI, "CST-123"), complex(2, GALLENTE, "CCM-456")] }],
    [FLIET, { type: "list", items: [complex(3, GALLENTE, "FSX-789")] }],
    [30000142, { type: "list", items: [complex(4, CALDARI, "JTA-023")] }],
  ] };
  const zones = new Map<number, MilitiaSystem[]>([[1, [
    { systemID: HEYDIELES, occupierID: CALDARI, attackerID: GALLENTE, adjacency: "SL", dateTaken: null },
    { systemID: FLIET, occupierID: GALLENTE, attackerID: CALDARI, adjacency: "FL", dateTaken: null },
  ]]]);
  const victory = new Map([[HEYDIELES, { score: 37500, threshold: 75000 }]]);
  const get = (filters = DEFAULT_AGENCY_FW_FILTERS) => agencyFactionWarfareSystems(sites, zones, victory, FLIET, () => 1, () => 0.3, filters);

  const all = get();
  assert.deepEqual(all.map((row) => row.solarSystemID), [FLIET, HEYDIELES]);
  assert.deepEqual(all[1]?.sites.map((site) => [site.instanceID, site.targetID]), [[1, "CST-123"]]);
  assert.deepEqual(all[1]?.victory, { score: 37500, threshold: 75000 });
  assert.deepEqual(get({ ...DEFAULT_AGENCY_FW_FILTERS, faction: GALLENTE }).map((row) => row.solarSystemID), [FLIET]);
  assert.deepEqual(get({ ...DEFAULT_AGENCY_FW_FILTERS, adjacency: "SL" }).map((row) => row.solarSystemID), [HEYDIELES]);
  assert.deepEqual(get({ ...DEFAULT_AGENCY_FW_FILTERS, distance: DISTANCE.currentSystem }).map((row) => row.solarSystemID), [FLIET]);
});

test("factional warfare upgrade progress uses the LP thresholds and maximum level from the client", () => {
  assert.deepEqual(agencyFactionWarfareUpgrade(0), { level: 0, next: 40000, progress: 0 });
  assert.deepEqual(agencyFactionWarfareUpgrade(50000), { level: 1, next: 60000, progress: 0.5 });
  assert.deepEqual(agencyFactionWarfareUpgrade(300000), { level: 5, next: 300000, progress: 1 });
});

test("Agency keeps the most contested systems in a bucket before ordering the selected cards by distance", () => {
  const systems: MilitiaSystem[] = Array.from({ length: 31 }, (_, i) => ({
    systemID: HEYDIELES + i,
    occupierID: CALDARI,
    attackerID: GALLENTE,
    adjacency: "SL",
    dateTaken: null,
  }));
  const sites: JsonValue = { type: "dict", entries: systems.map(({ systemID }) => [
    systemID, { type: "list", items: [complex(systemID, CALDARI, "CST-123")] },
  ]) };
  const farthest = HEYDIELES + 30;
  const victory = new Map([[farthest, { score: 37500, threshold: 75000 }]]);
  const rows = agencyFactionWarfareSystems(sites, new Map([[1, systems]]), victory, null,
    (id) => id - HEYDIELES, () => 0.3, DEFAULT_AGENCY_FW_FILTERS);
  assert.equal(rows.length, 30);
  assert.equal(rows.some((row) => row.solarSystemID === farthest - 1), false);
  assert.equal(rows.at(-1)?.solarSystemID, farthest);
});
