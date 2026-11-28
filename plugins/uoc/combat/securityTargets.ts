import type { Identity } from "./security.ts";
/**
 * Frozen 261028.1-test, `_local/gameStore/data/dungeonAuthority/data.json`,
 * templatesByID client-dungeon:{209,875,1940,3030}, explicit entityKind=npc entries;
 * SHA-256 042b537f3b0b3536e55169cbfb24476f7ece1cef93b036b4104d50012bd1c25b.
 * Group/category cross-checked against stock SDE build 3396210 itemTypes/data.json,
 * SHA-256 90c913521b08ba1887dfd16e2f874f3c0d268325c9b8313eaacc65f4e6287b7a.
 * These are public static content identities, not per-world actor IDs.
 */
const QUALIFIED: Readonly<
  Record<number, { dungeon: number; groups: ReadonlyMap<number, ReadonlySet<number>> }>
> = {
  2504: { dungeon: 875, groups: new Map([[818, new Set([16087, 16088, 16089])]]) },
  2925: {
    dungeon: 1940,
    groups: new Map([[615, new Set([16981, 16987, 16994, 16997, 17001, 17006])]]),
  },
  13735: {
    dungeon: 3030,
    groups: new Map([
      [
        806,
        new Set([
          10986, 10987, 10988, 10989, 10990, 10991, 10992, 10993, 10994, 10995, 18113, 18114,
        ]),
      ],
    ]),
  },
  909: {
    dungeon: 209,
    groups: new Map([
      [818, new Set([18574, 18575])],
      [817, new Set([12251, 18573])],
      [383, new Set([18028])],
    ]),
  },
};
export interface TargetRow {
  readonly kind: string | null;
  readonly itemID: number;
  readonly typeID: number | null;
  readonly groupID: number | null;
  readonly categoryID: number | null;
  readonly isNpc: boolean;
  readonly isSelf: boolean;
  readonly npcEntityType?: string | null;
  readonly geometryAvailable?: boolean;
}
/** Exact mission tuple + static type/group + freshly projected hostile NPC identity. */
export function isSecurityTarget(
  identity: Pick<Identity, "missionID" | "contentID" | "dungeonID"> | null,
  row: TargetRow,
): boolean {
  if (!identity || identity.missionID !== identity.contentID) return false;
  const spec = QUALIFIED[identity.missionID];
  return (
    !!spec &&
    identity.dungeonID === spec.dungeon &&
    row.kind === "ship" &&
    Number.isSafeInteger(row.itemID) &&
    row.itemID > 0 &&
    row.isNpc === true &&
    row.npcEntityType !== "concord" &&
    !row.isSelf &&
    row.geometryAvailable === true &&
    row.categoryID === 11 &&
    row.groupID !== null &&
    row.typeID !== null &&
    spec.groups.get(row.groupID)?.has(row.typeID) === true
  );
}
