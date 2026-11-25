"use strict";

// What the web client is shown of space, read from the client's own park.
//
// On the gateway, `/space/snapshot` and `/session/flight-status` are
// projections of the server's scene. A pilot on the game port has no such
// window: it has what the retail client has, a ballpark it steps itself
// (destiny/park.js), the slim item the server sent with each ball, and the
// damage states. This turns those into the same JSON the gateway answers with,
// so the routes and the browser above do not change.
//
// Where the gateway reads something only the server knows, this says so and
// answers null rather than guess. The shape and each field's meaning are
// docs/bridge-wire-contract.md, "POST /_evejs-web/v1/space/snapshot".

const { MODE, MODE_NAME } = require("./destiny/state");

/** inventorycommon/const.py. */
const CATEGORY = { CELESTIAL: 2, STATION: 3, SHIP: 6, CHARGE: 8, ENTITY: 11, DRONE: 18, ASTEROID: 25, ORBITAL: 46, STRUCTURE: 65, FIGHTER: 87 };
const GROUP = {
  SUN: 6, PLANET: 7, MOON: 8, ASTEROID_BELT: 9, STARGATE: 10, CARGO_CONTAINER: 12, SENTRY_GUN: 99, WRECK: 186, BILLBOARD: 323,
  SECURE_CARGO_CONTAINER: 340, ACCELERATION_GATE: 366, AUDIT_LOG_SECURE_CONTAINER: 448, FREIGHT_CONTAINER: 649,
};
/**
 * A ball of the Charge category. The client draws any group its data marks "fittable non-singleton" as a Missile
 * (spaceObject/repository.py, GetGroupDict), unless the table beside it says otherwise: the three bomb groups a
 * Bomb, which is the missile's class with another explosion, and the scanner's, the interdiction's and the
 * burst's probes a ScannerProbe. In the client's own groups table (res:/staticdata/groups.fsdbinary, read with
 * its loader on 2026-10-12) 72 groups are marked so, every one of this category; the seven of the category that
 * are not have no class to be drawn by, and are never a ball: two unpublished groups, the guidance scripts, the
 * exotic plasma charges and the condenser packs.
 *
 * The word is the server's, as the gateway's rows have it: "missile" for a missile and for a bomb
 * (missileEntity.js, bombRuntime.js), "probe" for an interdiction probe and for a survey probe
 * (inventorySpaceEntity.js). A survey probe is the one the client and the server part on: the client draws it as
 * a missile, having no class of its own for group 492.
 */
const PROBE_GROUPS = new Set([479, 492, 548, 4088]);
const CHARGE_GROUPS_NEVER_IN_SPACE = new Set([92, 892, 1400, 1987, 1989, 4061, 4062]);

/**
 * The shield's recharge constant, tau, is in milliseconds: the client divides
 * the difference of two readings of its clock (in 100 ns) by
 * dogmaConst.dgmTauConstant, 10000, and then by tau.
 */
const MS_PER_SECOND = 1000;

const text = (value) => (Buffer.isBuffer(value) ? value.toString("utf8") : typeof value === "string" ? value : null);
const number = (value) => (typeof value === "bigint" ? Number(value) : typeof value === "number" && Number.isFinite(value) ? value : null);
const positive = (value) => {
  const n = number(value);
  return n !== null && n > 0 ? n : null;
};
const vector = (v) => ({ x: v.x, y: v.y, z: v.z });

/**
 * A wreck's or a container's slim `lootRights`, (ownerID, corpID, fleetID, abandoned): the tuple the client's
 * Michelle.HaveLootRight reads (michelle.py 1450) and the server builds from its loot-rights snapshot
 * (destiny/index.js, "lootRights"). Null when the slim item has none.
 */
function lootRightsOf(value) {
  const items = Array.isArray(value) ? value : value && Array.isArray(value.items) ? value.items : null;
  if (items === null || items.length < 4) return null;
  return { ownerID: positive(items[0]), corpID: positive(items[1]), fleetID: positive(items[2]), abandoned: items[3] === true || items[3] === 1 };
}

/**
 * The word the gateway's rows carry for what a thing is. There it is the
 * server's own name for the entity; here it is told from the slim item's
 * category and group, which is all the retail client has to go on.
 *
 * Seen to agree with the server on live grids (a station's, and a gate's on
 * each side of a jump): station, structure, sun, planet, moon, asteroidBelt,
 * stargate, sentryGun, billboard, orbital, ship. The rest follow the same
 * constants and have not been set beside the server's word yet. A missile, a bomb and a probe
 * are told by their group within the Charge category (above). Two things cannot be told
 * this way and are not attempted: the server's "authoredSpaceProp" (scenery it
 * placed itself, an ordinary celestial to a client), and anything in a category
 * not listed, which answers null.
 */
/**
 * The client's containers in space, of whatever category (menu/__init__.py CONTAINERGROUPS; inventorycommon/const.py):
 * cargo, spawn, spew, secure, audit log and freight containers, an overseer's belongings and a mission container,
 * and a wreck. A spawn container and a mission container are of the Entity category, where the ships nobody flies
 * are; taken for a ship, one was called a pirate and counted a hostile.
 */
const CONTAINER_GROUPS_IN_SPACE = new Set([12, 306, 1207, 340, 448, 649, 496, 952]);

function kindOf(categoryID, groupID) {
  if (groupID === GROUP.WRECK) return "wreck";
  if (CONTAINER_GROUPS_IN_SPACE.has(groupID)) return "container";
  switch (categoryID) {
    case CATEGORY.SHIP: return "ship";
    case CATEGORY.STATION: return "station";
    case CATEGORY.STRUCTURE: return "structure";
    case CATEGORY.DRONE: return "drone";
    case CATEGORY.FIGHTER: return "fighter";
    case CATEGORY.ASTEROID: return "asteroid";
    case CATEGORY.ORBITAL: return "orbital";
    case CATEGORY.CHARGE: return PROBE_GROUPS.has(groupID) ? "probe" : CHARGE_GROUPS_NEVER_IN_SPACE.has(groupID) ? null : "missile";
    // Everything nobody flies is in one category: the guns and the billboards at a gate as well as the ships.
    case CATEGORY.ENTITY: return groupID === GROUP.SENTRY_GUN ? "sentryGun" : groupID === GROUP.BILLBOARD ? "billboard" : "ship";
    case CATEGORY.CELESTIAL:
      switch (groupID) {
        case GROUP.SUN: return "sun";
        case GROUP.PLANET: return "planet";
        case GROUP.MOON: return "moon";
        case GROUP.ASTEROID_BELT: return "asteroidBelt";
        case GROUP.STARGATE: return "stargate";
        case GROUP.WRECK: return "wreck";
        case GROUP.CARGO_CONTAINER:
        case GROUP.SECURE_CARGO_CONTAINER:
        case GROUP.AUDIT_LOG_SECURE_CONTAINER:
        case GROUP.FREIGHT_CONTAINER: return "container";
        default: return "celestial";
      }
    default: return null;
  }
}

/**
 * eveInflight.damageStateValue.CalculateCurrentDamageStateValues: what is left
 * of shield, armour and hull, each as a fraction. A damage state is
 * ((shield, tau, when), armour, hull); the shield recharges on its own, so its
 * fraction is brought forward from when the state arrived.
 */
function healthOf(damageState, secondsSince) {
  if (!Array.isArray(damageState) || damageState.length < 3) return { shieldRatio: null, armorRatio: null, hullRatio: null };
  const ratio = (value) => {
    const n = number(value);
    return n === null ? null : Math.min(1, Math.max(0, n));
  };
  let shield = null;
  const shieldValues = damageState[0];
  if (Array.isArray(shieldValues)) {
    shield = number(shieldValues[0]);
    const tau = number(shieldValues[1]);
    if (shield !== null && tau !== null && tau > 0) {
      const eToX = Math.exp((-secondsSince * MS_PER_SECOND) / tau);
      shield = (1.0 + (Math.sqrt(shield) - 1.0) * eToX) ** 2;
    }
  }
  return { shieldRatio: ratio(shield), armorRatio: ratio(damageState[damageState.length - 2]), hullRatio: ratio(damageState[damageState.length - 1]) };
}

/**
 * What kind of ship nobody is flying, in the gateway's words: the law's ("concord"), a drifter, or anything else
 * ("npc": the pirates, and what a mission sends). The gateway has it from the server's own record of the ship.
 * A client is sent two things it can tell by.
 *
 * The type's group: its overview keeps a table of NPC groups with the police's, CONCORD's, the customs
 * officials' and the faction navies' apart from the pirates' and the missions' (eve/client/script/parklife/
 * state.py, GetNPCGroups; inventorycommon/const.py's groupPoliceDrone, groupConcordDrone, groupCustomsOfficial,
 * groupFactionDrone and groupDrifterBattleship).
 *
 * And the slim item's `hostile_response_threshold`: above nought the ship is hostile whatever the pilot's
 * standing (npcs/client/entitystandings.py, is_npc_hostile). Tranquility sends 11 with a pirate and -11 with
 * the law, and so does this server.
 *
 * The law's word is kept for a ship of the law's groups that is not sent as hostile. The group alone is not
 * enough: this server can put out a ship of a CONCORD type that it calls an NPC and sends as hostile, and the
 * group would call it the law. Told this way the word is the server's own for each of its NPC profiles but a
 * Drifter Battleship's, which the server calls an NPC.
 */
/**
 * Whether a ship is compressing ore for those about it, and how far it reaches. A client is told on the ship's
 * slim item: `compression_facility_typelists` (itemcompression/__init__.py), a dict of the type lists it takes,
 * each with the range it takes them at, there while the ship runs its industrial core and a compressor
 * (itemcompression/client/inSpaceCompression.py reads it for the pilot's own ship and for a fleet member's).
 * The gateway's row gives the widest of the ranges and the lists; so does this.
 */
function compressionFacilityOf(typelists) {
  const entries = typelists && Array.isArray(typelists.entries) ? typelists.entries : [];
  if (entries.length === 0) return null;
  return {
    rangeMeters: Math.max(0, ...entries.map(([, range]) => number(range) ?? 0)) || null,
    typeListIDs: entries.map(([typeListID]) => positive(typeListID)).filter((typeListID) => typeListID !== null).sort((a, b) => a - b),
  };
}

/** idCheckers.IsNPC: an owner above the system's own (inventorycommon/const.py maxSystemItem) and below the players' (minPlayerOwner). */
const MAX_SYSTEM_ITEM = 9999;
const MIN_PLAYER_OWNER = 90000000;
const isNpcOwner = (ownerID) => typeof ownerID === "number" && ownerID > MAX_SYSTEM_ITEM && ownerID < MIN_PLAYER_OWNER;

const LAW_GROUPS = new Set([182, 301, 446, 288]);
const DRIFTER_GROUPS = new Set([1310]);
const npcKindOf = (groupID, hostileThreshold = null) => {
  if (DRIFTER_GROUPS.has(groupID)) return "drifter";
  return LAW_GROUPS.has(groupID) && !(hostileThreshold > 0) ? "concord" : "npc";
};

/**
 * A drone's activity state in the gateway's word for it (appConst.py: entityIdle, entityCombat, entityMining,
 * entityApproaching, entityDeparting, entityPursuit, entitySalvaging). A state with no word is "could not tell",
 * never idle.
 */
// entities.STATE_*: 5 is STATE_DEPARTING_2 (returning too), 7 fleeing, 9 operating, 10 STATE_ENGAGE (a repair drone's)
const DRONE_ACTIVITY = Object.freeze({ 0: "idle", 1: "fighting", 2: "mining", 3: "approaching", 4: "returning", 5: "returning", 6: "chasing", 7: "fleeing", 9: "operating", 10: "repairing", 18: "salvaging" });

/** One overview row: a ball with its slim item. `placed(ball)` says where the ball is shown and how fast: { p, v }. */
/** A stargate's jumps rowset (header + lines): its first line's locationID, null where there is none. */
function gateJumpSystemOf(jumps) {
  const items = (value) => (Array.isArray(value) ? value : value && Array.isArray(value.items) ? value.items : []);
  const text = (value) => (typeof value === "string" ? value : value && typeof value.value === "string" ? value.value : value && typeof value.str === "string" ? value.str : String(value ?? ""));
  const entries = jumps && jumps.type === "object" && jumps.args && Array.isArray(jumps.args.entries) ? jumps.args.entries : [];
  const part = (name) => (entries.find((each) => Array.isArray(each) && text(each[0]) === name) ?? [])[1];
  const at = items(part("header")).map(text).indexOf("locationID");
  const first = items(part("lines")).map(items)[0];
  const id = at === -1 || !first ? null : Number(first[at]);
  return Number.isFinite(id) && id > 0 ? id : null;
}

/** A wreck's slim nameID is the tuple ('UI/Inflight/WreckNameTypeID', {'WreckTypeID': typeID}) - the ship it was;
 * michelle hints it into cfg.evelocations, so GetSlimItemName shows "<that type's name> Wreck". Null otherwise. */
function wreckTypeIDOf(nameID) {
  const parts = Array.isArray(nameID) ? nameID : nameID && Array.isArray(nameID.items) ? nameID.items : null;
  if (!parts || parts.length < 2 || text(parts[0]) !== "UI/Inflight/WreckNameTypeID") return null;
  const dict = parts[1];
  const entries = dict && dict.type === "dict" && Array.isArray(dict.entries) ? dict.entries
    : dict instanceof Map ? [...dict.entries()] : [];
  const found = entries.find((pair) => Array.isArray(pair) && text(pair[0]) === "WreckTypeID");
  return found ? positive(found[1]) : null;
}

function projectEntity(park, ball, slim, ego, placed) {
  const itemID = number(ball.id);
  const categoryID = positive(slim.get("categoryID"));
  const groupID = positive(slim.get("groupID"));
  const kind = kindOf(categoryID, groupID);
  const seen = park.damageSeen ? park.damageSeen.get(ball.id) : undefined;
  const hackingState = slim.get("hackingSecurityState");
  const hostileResponseThreshold = number(slim.get("hostile_response_threshold"));
  const friendlyResponseThreshold = number(slim.get("friendly_response_threshold"));
  const nameMessageID = positive(slim.get("nameID"));
  const wreckTypeID = wreckTypeIDOf(slim.get("nameID"));
  const characterID = positive(slim.get("charID"));
  const objectiveTargetGroup = slim.get("objectiveTargetGroup");
  const row = {
    kind,
    itemID,
    typeID: positive(slim.get("typeID")),
    groupID,
    categoryID,
    name: text(slim.get("name")) || null,
    ...(nameMessageID !== null ? { nameMessageID } : {}),
    ...(wreckTypeID !== null ? { wreckTypeID } : {}),
    ...(typeof objectiveTargetGroup === "string" ? { objectiveTargetGroup } : {}),
    ...(characterID !== null ? { characterID } : {}),
    ownerID: positive(slim.get("ownerID")),
    ...(hostileResponseThreshold !== null ? { hostileResponseThreshold } : {}),
    // (the entity-standings component's other threshold, for the icon colour of entitystandings._get_icon_color_and_hint_from_entity_standing_response)
    ...(friendlyResponseThreshold !== null ? { friendlyResponseThreshold } : {}),
    ...(Number.isSafeInteger(hackingState) && hackingState >= 0 ? { hackingSecurityState: hackingState } : {}),
    // Whose side it is on, as its slim item says: its corporation, alliance and militia, which the client's overview
    // reads of any slim item that has them (overviewWindow.py 951 to 966). None where there is none.
    corporationID: positive(slim.get("corpID")),
    allianceID: positive(slim.get("allianceID")),
    warFactionID: positive(slim.get("warFactionID")),
    radius: ball.radius,
    position: vector(placed(ball).p),
    velocity: vector(placed(ball).v),
    isSelf: ego !== null && ball.id === ego,
    // The ball's own flags the menus read: free (CelestialChecker.IsFree, ball.isFree) and moribund (IsDead).
    ...(ball.isFree ? { isFree: true } : {}),
    ...(ball.isMoribund ? { isMoribund: true } : {}),
    ...healthOf(park.damageState.get(ball.id), seen === undefined ? 0 : park.currentTime - seen),
  };
  // The activate space component's state (slimItem.component_activate = (isActive, activeTimestamp), activate.py
  // OnSlimItemUpdated): a deployable's menu offers its cargo, scoop and fitting service once it is active.
  const activate = slim.get("component_activate");
  if (activate !== undefined && activate !== null) {
    const first = Array.isArray(activate) ? activate[0] : activate && typeof activate === "object" && Array.isArray(activate.items) ? activate.items[0] : activate;
    row.componentActive = first === true || first === 1;
  }
  if (kind === "wreck" || kind === "container") {
    // Whose it is to loot: the loot rights the client judges by.
    row.lootRights = lootRightsOf(slim.get("lootRights"));
    // a wreck's slimItem.isEmpty: its bracket's texturePathEmpty and the overview's EmptyWreck / ContainsLoot hint
    if (kind === "wreck") { const empty = slim.get("isEmpty"); row.isEmpty = empty === true || empty === 1; }
  }
  if (kind === "ship" || kind === "structure") {
    const security = number(slim.get("securityStatus"));
    row.characterID = characterID;
    row.securityStatus = security;
    row.maxVelocity = ball.maxVelocity > 0 ? ball.maxVelocity : null;
    row.mode = MODE_NAME[ball.mode] ?? null;
    // Who it is following or orbiting. The gateway reports the server's target for the ship, which a client is not sent.
    row.targetEntityID = (ball.mode === MODE.FOLLOW || ball.mode === MODE.ORBIT) && ball.followId > 0 ? number(ball.followId) : null;
    // Another ship's capacitor is not sent to a client; the pilot's own comes from dogma (projectSpace's `readings`).
    row.capacitorRatio = null;
    // A ship of the Entity category is one nobody is flying. So is a player's hull that an NPC owns (this server
    // flies the ORE mining fleet's Hulk as one): the client takes a thing for an NPC's by its owner (state.py 778,
    // overviewWindow.py 968).
    row.isNpc = categoryID === CATEGORY.ENTITY || (categoryID === CATEGORY.SHIP && isNpcOwner(row.ownerID));
    row.npcEntityType = row.isNpc ? npcKindOf(groupID, hostileResponseThreshold) : null;
    row.compressionFacility = compressionFacilityOf(slim.get("compression_facility_typelists"));
  }
  // A stargate: the solar system its first jump goes to (the slim item's jumps rowset, column locationID), for the
  // Selected Item's "(security)" after its name (selectedItemWnd._GetStargateSecurityText: jumps[0].locationID).
  if (groupID === 10) row.jumpSystemID = gateJumpSystemOf(slim.get("jumps"));
  // A drone in space: which ship is flying it, whose that ship is, what it is doing, and on what. A client is
  // told these of the pilot's own drones and of those its ship controls, by the park's drone states (michelle,
  // stateByDroneID); of anybody else's drone it is told nothing, and each is null. The gateway reports them of
  // every drone, from the server's own scene.
  if (kind === "drone") {
    const state = park.stateByDroneID ? park.stateByDroneID.get(ball.id) : undefined;
    row.controllerID = state ? positive(state.controllerID) : null;
    row.controllerOwnerID = state ? positive(state.controllerOwnerID) : null;
    row.droneActivity = state ? DRONE_ACTIVITY[state.activityState] ?? null : null;
    row.targetEntityID = state ? positive(state.targetID) : null;
  }
  // What there is to mine. A client knows a rock by its slim item's type, and that type is the ore a laser takes
  // from it: this server stamps an asteroid's slim item with the type it yields (asteroidService.js), whatever it
  // is drawn as. Which belt a rock is of, a client is never sent. How much is left in it, a client learns from a
  // survey scan (miningScanMgr) and not from the ballpark: null is "not known", which the mining bots read as
  // such. The gateway reports all three from the server's own scene, on an asteroid's row and no other.
  if (kind === "asteroid") {
    row.miningYieldTypeID = row.typeID;
    row.beltID = null;
    row.remainingQuantity = null;
  }
  // importExportUI.py 94: which planet a customs office is, from the office's own slim item.
  if (kind === "orbital") row.planetID = positive(slim.get("planetID"));
  // TargetTask.dungeon_object_id uses any authored target's slim ID. Acceleration
  // gates also use it for the Ship Restrictions read after a refusal.
  const dunObjectID = positive(slim.get("dunObjectID"));
  if (dunObjectID !== null || groupID === GROUP.ACCELERATION_GATE) row.dunObjectID = dunObjectID;
  const dunRotation = slim.get("dunRotation");
  if (Array.isArray(dunRotation) && dunRotation.length === 3 && dunRotation.every(Number.isFinite)) {
    row.dunRotation = [...dunRotation];
  }
  const poseID = number(slim.get("poseID"));
  if (poseID !== null) row.poseID = poseID;
  if (groupID === 1408) {
    const chargeTag = number(slim.get("component_jumpBridge"));
    if (chargeTag !== null) row.jumpBridge = {
      targetSystemID: positive(slim.get("targetSolarsystemID")),
      activationState: number(slim.get("activationState")),
      chargeTag,
    };
  }
  // AbyssJumpWindow.py AbyssEntranceWindowController and abyss/client/validator.py is_entrance_gate_open: an Abyssal
  // trace's filament, game mode and whether it is open, off its slim item.
  if (row.typeID === 48964) {
    row.abyssFilamentTypeID = positive(slim.get("abyssFilamentTypeID"));
    row.gameModeID = number(slim.get("gameModeID"));
    row.isAbyssGateOpen = slim.get("isAbyssGateOpen") === true || number(slim.get("isAbyssGateOpen")) === 1;
  }
  return row;
}

/**
 * The gateway's `space` for a pilot in space, from its park. `solarSystemID`
 * and `shipID` are where the session says the pilot is and what it flies.
 * `readings` is what dogma says of the pilot's own ship (pilotDogma.js), which
 * the ballpark does not know; without it those fields are null.
 *
 * `simTime` is the pilot's sim clock's reading, in milliseconds. With it every
 * ball's place and speed are the ones the client draws and measures with at
 * that reading (Ballpark.drawn): an overview row's distance is from
 * ball.GetVectorAt(simTime), its speed and the HUD's from GetVectorDotAt.
 * Without it they are the park's own at its last tick.
 */
/**
 * spaceMgr.CheckWarpDestination: does the thing the pilot asked to warp to lie where the server's warp is
 * pointed? It does if, from the ship, the two are within `angularTolerance` of the same direction, or if they
 * are within `distanceTolerance` of each other.
 */
function checkWarpDestination(warpPoint, destinationPoint, egoPoint, angularTolerance, distanceTolerance) {
  const offset = Math.hypot(destinationPoint.x - warpPoint.x, destinationPoint.y - warpPoint.y, destinationPoint.z - warpPoint.z);
  const toPoint = { x: warpPoint.x - egoPoint.x, y: warpPoint.y - egoPoint.y, z: warpPoint.z - egoPoint.z };
  const toThing = { x: destinationPoint.x - egoPoint.x, y: destinationPoint.y - egoPoint.y, z: destinationPoint.z - egoPoint.z };
  const cosine = (toPoint.x * toThing.x + toPoint.y * toThing.y + toPoint.z * toThing.z) / (Math.hypot(toPoint.x, toPoint.y, toPoint.z) * Math.hypot(toThing.x, toThing.y, toThing.z));
  const angle = Math.acos(Math.min(Math.max(-1.0, cosine), 1.0));
  return Math.abs(angle) < angularTolerance || offset < distanceTolerance;
}

const warpDestinations = new WeakMap();

/**
 * What the client's HUD words a warp from (spaceMgr.StartWarpIndication, IndicateWarp): whether the ship is
 * still lining up (the ball's effect stamp is negative until the warp proper begins), the point in the
 * server's WarpTo, and the thing the pilot asked to warp to, if it is in the park and lies where the warp
 * points (within pi/32 of the direction, or 20,000 km). Keep the measured position for that WarpTo order.
 */
function warpOf(park, egoBall, destinationID, bookmark = null) {
  const point = park.warpPoint ?? null;
  // The ball's effect stamp goes with it: while the ship lines up it is minus one less the ticks spent so (WarpTo
  // sets -1, each tick of lining up takes one off), and the bar the client fills meanwhile is partly made of it.
  const base = { preparing: egoBall.effectStamp < 0, effectStamp: egoBall.effectStamp, point: point ? { ...point } : null };
  const cached = point && warpDestinations.get(point);
  if (cached) return { ...base, ...cached };
  const source = park.warpOrigin ?? egoBall.newPos;
  let destination;
  if (bookmark) {
    destination = { destinationID: null, ...bookmarkWarpWords(park, source, point, bookmark) };
  } else {
    const id = destinationID === null || destinationID === undefined ? null : number(destinationID);
    const thing = id === null ? null : park.ballpark.ball(id);
    const lies = point && thing && checkWarpDestination(point, thing.newPos, source, Math.PI / 32, 20000000);
    destination = { destinationID: lies ? id : null, destinationName: null, actualPoint: lies ? { ...thing.newPos } : null };
  }
  if (point && destination.actualPoint) warpDestinations.set(point, destination);
  return { ...base, ...destination };
}

/**
 * StartWarpIndication's bookmark (spaceMgr.py 573 to 593), { memo, itemID, point }: what the HUD names (the memo's
 * title, up to its first tab, as UI/Inflight/Messages/WarpDestination) and the place the warp's way and distance are
 * measured to. A thing's bookmark (no x) with a memo is named by it, and measured to the thing where it is in the park
 * and the warp points there; with no memo it says nothing. A place's bookmark, where the warp points there and it has
 * a memo, is named by it and measured to the place; else nothing, the memo's place included.
 */
function bookmarkWarpWords(park, source, point, bookmark) {
  const none = { destinationName: null, actualPoint: null };
  const memo = typeof bookmark.memo === "string" ? bookmark.memo : "";
  const tab = memo.indexOf("\t");
  const title = tab > -1 ? memo.slice(0, tab) : memo;
  if (!bookmark.point) {
    if (!memo) return none;
    const thing = bookmark.itemID === null || bookmark.itemID === undefined ? null : park.ballpark.ball(number(bookmark.itemID));
    const at = point && thing && checkWarpDestination(point, thing.newPos, source, Math.PI / 32, 20000000);
    return { destinationName: title, actualPoint: at ? { x: thing.newPos.x, y: thing.newPos.y, z: thing.newPos.z } : null };
  }
  if (!point || !checkWarpDestination(point, bookmark.point, source, Math.PI / 32, 20000000) || !memo) return none;
  return { destinationName: title, actualPoint: { ...bookmark.point } };
}

function projectSpace(park, { solarSystemID, shipID, readings = null, warpDestination = null, warpBookmark = null, alignTarget = null, simTime = null }) {
  const ego = park.ego;
  const entities = [];
  const placed = simTime === null ? (ball) => ({ p: ball.newPos, v: ball.newVel }) : (ball) => park.ballpark.drawn(ball, simTime);
  for (const ball of park.ballpark.balls.values()) {
    if (ball.isMoribund) continue;
    const slim = park.slimItems.get(ball.id);
    if (!slim) continue; // a ball of the client's own, or one whose slim item has not come
    entities.push(projectEntity(park, ball, slim, ego, placed));
  }
  const own = ego === null ? null : entities.find((row) => row.itemID === number(ego)) ?? null;
  if (own && readings) own.capacitorRatio = readings.capacitorRatio;
  const egoBall = ego === null ? null : park.ballpark.ball(ego) ?? null;
  return {
    inSpace: true,
    solarSystemID,
    shipID,
    // The park's tick, as the server's clock in milliseconds: a tick is a whole second of that clock.
    sampledAtMs: park.currentTime * 1000,
    // How far the server's own updates have got into the park: the ticks of them applied, and those received and
    // still queued (Park.appliedUpdates). The tick above runs on through a server that has stopped; these do not.
    serverUpdates: { applied: park.appliedUpdates, queued: park.history.length },
    entities,
    ship: own ? {
      itemID: own.itemID,
      typeID: own.typeID,
      name: own.name,
      // Whose it is: the character flying it and its owner, the ship's own slim item's charID and ownerID. What
      // looks at a pilot's scene before acting for that pilot holds the ship to be that pilot's by these (a hosted
      // miner's jettison, a support pilot's anchoring and stopping, the page's own checks before a write).
      characterID: own.characterID,
      ownerID: own.ownerID,
      mode: own.mode,
      // The range the ship was told to follow or orbit at: with its mode and whom it follows, what the
      // client's HUD says the ship is doing from (spaceMgr.GetHeaderAndSubtextForActionIndication). Null
      // when it follows nothing.
      followRange: own.targetEntityID !== null && egoBall ? egoBall.followRange : null,
      // The point the ship is flying to, when that is what it is doing (the ball's GOTO): with where it is
      // and how it is moving, what the client's HUD tells an approach to a point from a turn towards one.
      gotoPoint: own.mode === "GOTO" && egoBall ? { x: egoBall.goto.x, y: egoBall.goto.y, z: egoBall.goto.z } : null,
      // What the pilot last aligned to, a thing or a bookmark, while the ship flies that course: the client
      // remembers it from its own order (menusvc.StoreAlignTarget) and its HUD names it.
      alignTarget: own.mode === "GOTO" && alignTarget ? { itemID: alignTarget.itemID ?? null, bookmark: Boolean(alignTarget.bookmark) } : null,
      // In warp, or lining up for one: what the client's HUD says of it is made from this. `warpDestination`
      // is the thing the pilot asked to warp to, which the client remembers from its own order.
      warp: own.mode === "WARP" && egoBall ? warpOf(park, egoBall, warpDestination, warpBookmark) : null,
      maxVelocity: own.maxVelocity,
      // The speed the ship was told to make, as a share of its top speed (the ball's speedFraction): what the flight
      // read says of it too, here as fresh as the reading.
      speedFraction: egoBall ? egoBall.speedFraction : null,
      radius: own.radius,
      position: own.position,
      velocity: own.velocity,
      // The ship's panel reads its own health from godma (activeShipController.py); the ballpark's damage state
      // is what everyone else is shown of it, and stands in until dogma has been asked.
      shieldRatio: readings && readings.shieldRatio !== null && readings.shieldRatio !== undefined ? readings.shieldRatio : own.shieldRatio,
      armorRatio: readings && readings.armorRatio !== null && readings.armorRatio !== undefined ? readings.armorRatio : own.armorRatio,
      hullRatio: readings && readings.hullRatio !== null && readings.hullRatio !== undefined ? readings.hullRatio : own.hullRatio,
      // From dogma on the retail client, not from the ballpark.
      capacitorRatio: readings ? readings.capacitorRatio : null,
      shieldCapacity: readings ? readings.shieldCapacity : null,
      armorCapacity: readings ? readings.armorCapacity : null,
      hullCapacity: readings ? readings.hullCapacity : null,
      // Which modules are running or overloaded: godma's effects.
      activeModuleIDs: readings && Array.isArray(readings.activeModuleIDs) ? readings.activeModuleIDs : [],
      // What each running module is cycling on, [moduleID, targetID] pairs. Null where dogma could not be asked.
      activeModuleTargets: readings && Array.isArray(readings.activeModuleTargets) ? readings.activeModuleTargets : null,
      // How far each fitted module reaches, [moduleID, metres] pairs, bonuses applied. Null where dogma was not asked.
      moduleRanges: readings && Array.isArray(readings.moduleRanges) ? readings.moduleRanges : null,
      overloadedModuleIDs: readings && Array.isArray(readings.overloadedModuleIDs) ? readings.overloadedModuleIDs : [],
      // How damaged each module is, {itemID: 0..1}, and which weapons are grouped, {masterID: [slaveID, ...]}:
      // dogma's as well. Null, not empty, when dogma could not be asked: empty means "none".
      moduleDamage: readings && readings.moduleDamage ? readings.moduleDamage : null,
      weaponBanks: readings && readings.weaponBanks ? readings.weaponBanks : null,
      // How hot each rack is running, { high, mid, low } as fractions of its capacity: the dogma location's own
      // reckoning (pilotDogma.js). Null when dogma could not be asked.
      rackHeat: readings && readings.rackHeat ? readings.rackHeat : null,
    } : null,
  };
}

/** The two movement fields of the gateway's flight status, from the pilot's own ball. */
function projectFlight(park) {
  const ball = park.ego === null ? null : park.ballpark.ball(park.ego);
  if (!ball) return { shipMode: null, shipSpeedFraction: null };
  return { shipMode: MODE_NAME[ball.mode] ?? null, shipSpeedFraction: ball.speedFraction };
}

module.exports = { CATEGORY, GROUP, checkWarpDestination, compressionFacilityOf, healthOf, kindOf, npcKindOf, projectEntity, projectFlight, projectSpace };
