import {
  CONCORD_LAYOUT, EDENCOM_LAYOUT, EMPIRE_LAYOUT, ORE_LAYOUT, SOCT_LAYOUT, TRIGLAVIAN_LAYOUT, type LayoutEdge,
} from "./shipTreeLayouts.ts";

export const AIR_FACTION = 500028;
export const SHIP_TREE_CAPTION = "UI/ShipTree/ShipTree";

interface Faction {
  readonly id: number;
  readonly name: string;
  readonly image: string;
  readonly background?: string;
  readonly parents?: readonly [number, number];
  readonly layout?: readonly LayoutEdge[];
}

export const SHIP_TREE_FACTIONS: readonly Faction[] = [
  { id: 500003, name: "Amarr Empire", image: "amarr", layout: EMPIRE_LAYOUT },
  { id: 500001, name: "Caldari State", image: "caldari", layout: EMPIRE_LAYOUT },
  { id: 500004, name: "Gallente Federation", image: "gallente", layout: EMPIRE_LAYOUT },
  { id: 500002, name: "Minmatar Republic", image: "minmatar", layout: EMPIRE_LAYOUT },
  { id: 500014, name: "ORE", image: "ore", layout: ORE_LAYOUT },
  { id: 500010, name: "Guristas Pirates", image: "guristas", parents: [500001, 500004] },
  { id: 500019, name: "Sansha's Nation", image: "sansha", background: "sanshasnation", parents: [500003, 500001] },
  { id: 500012, name: "Blood Raider Covenant", image: "bloodraiders", parents: [500003, 500002] },
  { id: 500011, name: "Angel Cartel", image: "angel", background: "angelcartel", parents: [500004, 500002] },
  { id: 500020, name: "Serpentis", image: "serpentis", parents: [500004, 500002] },
  { id: 500016, name: "Sisters of EVE", image: "soe", parents: [500003, 500004] },
  { id: 500018, name: "Mordu's Legion", image: "mordus", parents: [500001, 500004] },
  { id: 500026, name: "Triglavian Collective", image: "triglaviancollective", layout: TRIGLAVIAN_LAYOUT },
  { id: 500027, name: "EDENCOM", image: "edencom", layout: EDENCOM_LAYOUT },
  { id: 500006, name: "CONCORD Assembly", image: "concord", layout: CONCORD_LAYOUT },
  { id: 500017, name: "Society of Conscious Thought", image: "soct", layout: SOCT_LAYOUT },
  { id: 500029, name: "Deathless", image: "deathless", parents: [500001, 500002] },
];
export const AIR_TREE_FACTION: Faction = { id: AIR_FACTION, name: "AIR Academy Ships", image: "air" };
export const shipTreeFaction = (id: number) => id === AIR_FACTION ? AIR_TREE_FACTION : SHIP_TREE_FACTIONS.find(faction => faction.id === id);
const FACTION_BY_RACE: Readonly<Record<number, number>> = { 1: 500001, 2: 500002, 4: 500003, 8: 500004 };
export const raceShipTree = (raceID?: number | null) => FACTION_BY_RACE[raceID ?? 0] ?? 500001;

export interface ShipTreeIcon {
  readonly nameID: number | null;
  readonly descriptionID: number | null;
  readonly holoIcon: string | null;
  readonly rigSize: number;
}
export interface ShipTreeHull extends ShipTreeIcon {
  readonly typeID: number;
  readonly factionID: number;
  readonly shipGroupID: number;
  readonly academy: boolean;
}
export interface ShipTreeCatalogue {
  readonly ships: readonly ShipTreeHull[];
  readonly classes: Readonly<Record<number, { readonly nameID: number | null; readonly iconSmall: string | null }>>;
  readonly capsule: ShipTreeIcon;
}

export interface ShipTreeNode {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly factionID: number;
  readonly groupID: number | null;
  readonly kind: "root" | "connector" | "group" | "faction";
  readonly ships: readonly ShipTreeHull[];
  readonly columns: number;
  readonly iconSize: number;
  readonly chrome: boolean;
}

const SCALE = 350;
export const TREE_CHROME_PAD = 46;
export const AIR_SHIP_TOP = 126;
const AIR_LAYOUT: readonly LayoutEdge[] = [
  [0, 1 / 2, 0, 8, 1],
  [1, (TREE_CHROME_PAD + 99) / SCALE, 0, 8, 1],
  [2, 99 / SCALE, 0, 8, 1],
  [3, 99 / SCALE, 0, 8, 1],
  [4, (99 + 60 + TREE_CHROME_PAD) / SCALE, 0, 41, 1],
];

/** Native ShipTreeSvc selects Academy hulls by faction and class, in type ID order.
 * A regular faction appends the same hulls only in Exordium with the feature enabled. */
export function shipTreeGraph(data: ShipTreeCatalogue, factionID: number, academyVisible: boolean) {
  const faction = shipTreeFaction(factionID);
  const academyTree = factionID === AIR_FACTION;
  const byGroup = new Map<string, { regular: ShipTreeHull[]; academy: ShipTreeHull[] }>();
  for (const ship of data.ships) {
    const key = `${ship.factionID}:${ship.shipGroupID}`;
    const row = byGroup.get(key) ?? { regular: [], academy: [] };
    row[ship.academy ? "academy" : "regular"].push(ship);
    byGroup.set(key, row);
  }
  const shipsOf = (owner: number, group: number | null): ShipTreeHull[] => {
    const row = byGroup.get(`${owner}:${group}`);
    if (!row) return [];
    const academy = [...row.academy].sort((a, b) => a.typeID - b.typeID);
    return academyTree ? academy : [...row.regular, ...(academyVisible ? academy : [])];
  };
  const nodes: ShipTreeNode[] = [
    { id: 0, x: 0, y: 0, factionID, groupID: null, kind: "root", ships: [], columns: 1, iconSize: 32, chrome: true },
  ];
  const edges: { from: number; to: number }[] = [];
  const add = (parent: number, dx: number, dy: number, groupID: number | null, columns: number, owner: number,
    chrome = true, kind: ShipTreeNode["kind"] = groupID === null ? "connector" : "group") => {
    const base = nodes[parent]!;
    const ships = shipsOf(owner, groupID);
    const iconSize = 82 + 16 * (groupID === 37 || groupID === 38 ? 4 : (ships[0]?.rigSize ?? 0));
    const id = nodes.length;
    nodes.push({ id, x: base.x + dx * SCALE, y: base.y + dy * SCALE, factionID: owner, groupID, kind, ships, columns, iconSize, chrome });
    if (kind !== "faction" && chrome) edges.push({ from: parent, to: id });
    return id;
  };

  if (academyTree) {
    AIR_LAYOUT.forEach(([parent, dx, dy, groupID], at) => {
      add(parent, dx, dy, groupID!, 1, SHIP_TREE_FACTIONS[at]!.id, at === 0 || at === 4);
    });
  } else if (faction?.layout) {
    for (const [parent, dx, dy, groupID, columns] of faction.layout) add(parent, dx, dy, groupID ?? null, columns ?? 3, factionID);
  } else if (faction?.parents) {
    const joinFactions = (groupID: number, to: number) => {
      faction.parents!.forEach((owner, at) => {
        const from = add(to, 0, at === 0 ? -0.5 : 0.5, groupID, 3, owner, true, "faction");
        edges.push({ from, to });
      });
    };
    let last = add(0, 0.25, 0, null, 3, factionID);
    const firstConnection = last;
    let smallCount = 0;
    for (const group of [8, 14, 16, 23, 26]) {
      if (!shipsOf(factionID, group).length) continue;
      last = add(last, smallCount++ === 0 ? 0.25 : 0.75, 0, group, 3, factionID);
      joinFactions(group, last);
    }
    let capitalCount = 0;
    for (const group of [32, 33, 34]) {
      if (!shipsOf(factionID, group).length) continue;
      last = add(last, 0.5, capitalCount++ === 0 ? 0 : -0.8, null, 3, factionID);
      joinFactions(group, add(last, 0.5, 0, group, 3, factionID));
    }
    const expeditionCommand = 2109;
    if (factionID === 500016 && shipsOf(factionID, expeditionCommand).length) {
      const branch = add(firstConnection, 0, 1, null, 3, factionID);
      const bend = add(branch, 1, 0, null, 3, factionID);
      joinFactions(expeditionCommand, add(bend, 0.5, 0, expeditionCommand, 3, factionID));
    }
  }
  return { nodes, edges };
}
