// Which containers on a grid a pilot may take from WITHOUT a theft (suspect) flag.
//
// Mirrors the server's rule, spaceLootEntitlement.js `sessionHasSpaceLootRight`
// (eve.js server, services/_shared). A take is free when ANY of:
//   1. the container's ownerID is the pilot's character;
//   2. it is abandoned (lootInfo.abandoned, projected on the entity as
//      `lootAbandoned`);
//   3. it is corporation PROPERTY (protectedPropertyCorporationID marker): only
//      that player corporation's members;
//   4. its owner is not a player character (ownerID 0, an NPC corporation,
//      faction or agent) - free-for-all debris;
//   5. the owner's PLAYER corporation at creation (lootRightCorpID, else
//      corporationID) is the pilot's corporation (NPC corps never grant);
//   6. the same fleet right (lootRightFleetID / the owner being in the pilot's
//      fleet); the server also needs the same solar system, which a container
//      on this grid always is.
// There is NO alliance right on the server, so allianceID grants nothing here.
// Anything else is theft: a suspect timer in high/low sec, a refusal under
// green safety.
//
// FAIL CLOSED. The snapshot cannot tell "ownerless" (0, free) from "owner not
// reported" (null) - both decode to null - so a null owner is NOT lootable,
// unless the row says it is abandoned. A row whose rights were not supplied is
// never opened on a guess.

import type { SpaceEntity, SpaceSnapshot } from "../store/types.ts";
import { isNpcCorporation } from "../bridge/standingsReads.ts";

export interface LootWho {
  readonly characterID: number | null;
  readonly corporationID: number | null;
  /** The server grants no alliance loot right; carried only so callers can pass what they have. */
  readonly allianceID?: number | null;
  /** Characters currently in the pilot's fleet (not including the pilot necessarily). */
  readonly fleetMemberIDs?: readonly number[] | null;
}

/**
 * The loot-right fields the server projects on a container entity
 * (inventoryLootRights.js applyInventoryLootInfoToEntity). decodeEntity does not
 * keep them today, so they are read loosely and are absent on a decoded row
 * until it does; absent means "not abandoned / no fleet right / unmarked".
 */
interface LootRightFields {
  readonly lootAbandoned?: boolean | null;
  readonly lootRightCorpID?: number | null;
  readonly lootRightFleetID?: number | null;
  readonly protectedPropertyCorporationID?: number | null;
  readonly protectedPropertyCorporationMarkerPresent?: boolean | null;
}

/** Container group ids the overview classes as "container" (hideCategory.ts). */
export const CONTAINER_GROUP_IDS: ReadonlySet<number> = new Set([12, 340, 448, 649]);

function positive(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function isPlayerCorporation(id: number | null): boolean {
  return id !== null && id > 0 && !isNpcCorporation(id);
}

/**
 * True when the id is something the server would not find a character record for
 * (spaceLootEntitlement.isPlayerCharacterOwner), by the client's own ranges: every
 * owner below idCheckers' minPlayerOwner (90,000,000) is the system's or an NPC's.
 * That takes in the system owner (1) that a site's own containers are owned by
 * (dungeonUniverseSiteService SITE_CONTENT_OWNER_ID), NPC corporations, factions
 * and agents. A player corporation id is NOT free here: the server only frees it
 * through the protected-property marker, which is handled above.
 */
const MIN_PLAYER_OWNER = 90_000_000;
function isNonPlayerOwner(ownerID: number): boolean {
  return ownerID < MIN_PLAYER_OWNER;
}

/**
 * The client's own loot right over a wreck or a can, from its slim item's
 * `lootRights` (Michelle.HaveLootRight, michelle.py 1450): abandoned; the pilot
 * named its owner; the pilot's PLAYER corporation named as its owner or its
 * corporation; or the pilot's fleet named. A corp-mate's wreck is ours this way
 * with no fleet at all. Null tuple: no verdict from it (false).
 */
export function lootRightsGrant(entity: SpaceEntity, who: LootWho & { readonly fleetID?: number | null }): boolean {
  const rights = entity.lootRights ?? null;
  if (rights === null) return false;
  const me = positive(who.characterID);
  const corp = positive(who.corporationID);
  if (rights.abandoned) return true;
  if (me !== null && rights.ownerID === me) return true;
  if (corp !== null && isPlayerCorporation(corp) && (rights.ownerID === corp || rights.corpID === corp)) return true;
  const fleet = positive(who.fleetID ?? null);
  return fleet !== null && rights.fleetID === fleet;
}

export function isLootableContainer(entity: SpaceEntity, who: LootWho): boolean {
  if (entity.kind !== "container") {
    return false;
  }
  const rights = entity as SpaceEntity & LootRightFields;
  const me = positive(who.characterID);
  const corp = positive(who.corporationID);
  const ownerID = positive(entity.ownerID);

  // 1. Abandonment always wins, over any corporation-property marker too.
  if (rights.lootAbandoned === true) {
    return true;
  }

  // 3. Corporation property: only that player corporation's own members.
  const marked = positive(rights.protectedPropertyCorporationID);
  if (rights.protectedPropertyCorporationMarkerPresent === true || marked !== null) {
    return marked !== null && isPlayerCorporation(marked) && corp !== null && marked === corp;
  }

  if (ownerID === null) {
    return false; // unknown or genuinely ownerless: the snapshot cannot say, so never open it
  }
  if (me !== null && ownerID === me) {
    return true;
  }
  // The pilot's own corporation as the owner (corporation-owned, not a character).
  if (corp !== null && ownerID === corp && isPlayerCorporation(corp)) {
    return true;
  }
  // 4. Not a player character: NPC-owned debris is free.
  if (isNonPlayerOwner(ownerID)) {
    return true;
  }
  // 5. The owner's player corporation is the pilot's. The server prefers the
  // persisted lootRightCorpID, then the owner's corporation at creation.
  const grantCorp = positive(rights.lootRightCorpID) ?? positive(entity.corporationID);
  if (corp !== null && grantCorp !== null && grantCorp === corp && isPlayerCorporation(corp)) {
    return true;
  }
  // 5b. The slim item's own loot rights, as the client judges them.
  if (lootRightsGrant(entity, who)) {
    return true;
  }
  // 6. Fleet right.
  const members = who.fleetMemberIDs ?? [];
  if (members.length > 0 && (members.includes(ownerID) || members.includes(positive(entity.characterID) ?? -1))) {
    return true;
  }
  return false;
}

export type SetAside = ReadonlySet<number> | ((itemID: number) => boolean) | null | undefined;

function isSetAside(setAside: SetAside, itemID: number): boolean {
  if (!setAside) return false;
  return typeof setAside === "function" ? setAside(itemID) : setAside.has(itemID);
}

/** Every container on the grid this pilot may take from, minus those set aside. Order is the snapshot's. */
export function lootableContainersOnGrid(
  snapshot: SpaceSnapshot | null | undefined,
  who: LootWho,
  setAside?: SetAside,
): readonly SpaceEntity[] {
  return (snapshot?.entities ?? []).filter(
    (e) => e.kind === "container" && !e.isSelf && isLootableContainer(e, who) && !isSetAside(setAside, e.itemID),
  );
}
