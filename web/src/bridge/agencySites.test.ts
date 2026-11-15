import assert from "node:assert/strict";
import test from "node:test";
import { DISTANCE } from "./agencyAgents.ts";
import { agencyFactionWarfareBenefits, agencyFactionWarfareSystems, agencyFactionWarfareUpgrade, agencyInsurgencySystems, insurgencySiteCandidates,
  DEFAULT_AGENCY_FW_FILTERS, DEFAULT_AGENCY_INSURGENCY_FILTERS, type InsurgencyStages } from "./agencySites.ts";
import { insurgencyCampaigns, type MilitiaSystem } from "./militiaEnlistment.ts";
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
  assert.deepEqual(agencyFactionWarfareUpgrade(0), { level: 0, previous: 0, next: 40000, progress: 0, capped: false });
  assert.deepEqual(agencyFactionWarfareUpgrade(50000), { level: 1, previous: 40000, next: 60000, progress: 0.5, capped: false });
  assert.deepEqual(agencyFactionWarfareUpgrade(300000), { level: 5, previous: 200000, next: 300000, progress: 1, capped: true });
  assert.deepEqual(agencyFactionWarfareBenefits(0), [{ kind: "industry", value: 0 }, { kind: "market", value: 0 }]);
  assert.deepEqual(agencyFactionWarfareBenefits(4), [{ kind: "industry", value: -40 }, { kind: "market", value: 40 }]);
  assert.deepEqual(agencyFactionWarfareBenefits(5), [{ kind: "industry", value: -50 }, { kind: "market", value: 50 }]);
  assert.deepEqual(agencyFactionWarfareBenefits(6), []);
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

test("Agency insurgency cards join native campaign coverage and filter by site faction and known system stages", () => {
  const roushzar = 30002975;
  const immuri = 30045343;
  const other = 30002976;
  const angels = 500011;
  const guristas = 500010;
  const snapshots: JsonValue = { type: "list", items: [{
    type: "objectex2",
    header: [[{ type: "token", value: "pirateinsurgency.campaignClientSnapshot.CampaignClientSnapshot" }], {
      type: "dict", entries: [
        ["_campaignID", 146], ["_pirateFactionID", angels], ["_fsmState", 3], ["_originSolarsystemID", roushzar],
        ["_structureID", 1054048106597], ["_coveredSolarsystemIDs", {
          type: "objectex1",
          header: [{ type: "token", value: "__builtin__.set" }, [{ type: "list", items: [roushzar, other] }]],
          list: [], dict: [],
        }],
      ],
    }],
    list: [], dict: [],
  }] };
  const rawSites: JsonValue = { type: "dict", entries: [
    [roushzar, { type: "list", items: [complex(1, angels, "ANG-111"), complex(2, guristas, "GUR-222")] }],
    [immuri, { type: "list", items: [complex(3, guristas, "GUR-333")] }],
    [other, { type: "list", items: [complex(4, angels, "ANG-444")] }],
  ] };
  const campaigns = insurgencyCampaigns(snapshots);
  assert.deepEqual(campaigns[0]?.coveredSystemIDs, [roushzar, other]);
  const progress = new Map<number, InsurgencyStages>([
    [roushzar, { corruption: 0, suppression: 2 }],
    [immuri, { corruption: 1, suppression: 0 }],
    [other, { corruption: null, suppression: 2 }],
  ]);
  const distance = (id: number) => id === other ? 1 : 8;
  const get = (filters = DEFAULT_AGENCY_INSURGENCY_FILTERS) => agencyInsurgencySystems(
    insurgencySiteCandidates(rawSites, filters, roushzar, distance), campaigns, new Map([[roushzar, CALDARI]]),
    progress, roushzar, distance, () => 0.4, filters);
  const [fob, neighbor, distant] = get();
  assert.equal(fob?.pirateFactionID, angels);
  assert.equal(fob?.occupierID, CALDARI);
  assert.equal(fob?.isFobSystem, true);
  assert.equal(neighbor?.pirateFactionID, angels);
  assert.equal(neighbor?.isFobSystem, false);
  assert.equal(distant?.pirateFactionID, null);
  assert.deepEqual(get({ ...DEFAULT_AGENCY_INSURGENCY_FILTERS, faction: guristas }).map((row) => [row.solarSystemID, row.sites.length]),
    [[roushzar, 2], [immuri, 1]]);
  assert.deepEqual(get({ ...DEFAULT_AGENCY_INSURGENCY_FILTERS, corruption: 0, suppression: 2 }).map((row) => row.solarSystemID),
    [roushzar, other]);
  assert.deepEqual(get({ ...DEFAULT_AGENCY_INSURGENCY_FILTERS, distance: DISTANCE.currentSystem }).map((row) => row.solarSystemID), [roushzar]);
});
