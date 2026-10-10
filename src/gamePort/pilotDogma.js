"use strict";

// The pilot's own ship as dogma has it: the part of the retail client's
// `godma` that the ship's panel reads.
//
// The ship's panel on the retail client (shipHud/activeShipController.py) takes
// its numbers from the godma item for the ship, not from the ballpark:
//
//   capacitor      charge / capacitorCapacity
//   shield         shieldCharge / shieldCapacity
//   armour         (armorHP - armorDamage) / armorHP
//   hull           (hp - damage) / hp
//
// Godma (eve/client/script/environment/godma.py) gets those attributes from
// the dogma location it has bound, in one call, and is then told of each change:
//
//   GetDogmaLM().GetAllInfo(primeCharacter, primeShip, primeStructure)   Prime (2399), ForcePrimeLocation (2369)
//     ProcessAllInfo -> PrimeLocation -> UpdateItem: each item's attributes, and the time they were true at
//   OnModuleAttributeChanges([(tag, ownerID, itemID, attributeID, time, new, old, ...)])   (1342)
//     ApplyAttributeChange (2526)
//   OnMultiEvent([((tag, ...), time), ...])                                              (206)
//     the same changes, bundled with other events of the same moment; the
//     ballpark's updates carry such a bundle too (michelle.DoDestinyUpdate)
//
// Two attributes are not numbers that stay put. The capacitor and the shield
// recharge by themselves, so godma keeps each as (value, when, tau, capacity)
// and works out what it is now whenever it is read (CreateChargedAttribute 1729,
// GetChargeValue 2037).
//
// Which modules are running is godma's too. Each item's row in GetAllInfo
// lists the effects active on it (RefreshItemEffects 1640), and the server
// reports each start and stop:
//
//   OnGodmaShipEffect(itemID, effectID, time, start, active, environment, startTime, duration, repeat, error)   (1441)
//
// A module is running when an effect of the activation, target or area kind is
// active on it; it is overloaded when one of the overload kind is. Being
// online is an effect as well, and is neither.
//
// What is loaded in a module is godma's as well. A charge in a fitted module
// is not an item with an ID of its own: it is a "sublocation", keyed by the
// tuple (shipID, flagID, typeID), and its row in GetAllInfo has no inventory
// row, only attributes, of which `quantity` is how many are loaded. Changes to
// it arrive like any other, under that tuple (godma.py 1351, 1550 on). The scan
// service finds its launcher and the probes in it this way (scanSvc.py 476 to
// 513): the first module of the launcher group that is online, and the
// sublocation at that module's flag.
//
// The ship's own health is read the same way as its capacitor
// (activeShipController.py 92 to 133), and the panel shows each rounded to
// hundredths:
//
//   shield         shieldCharge / shieldCapacity     (it recharges, like the capacitor)
//   armour         (armorHP - armorDamage) / armorHP
//   hull           (hp - damage) / hp
//
// A module's damage is its own `damage` over its `hp` (shipmodulebutton.py
// 192): heat is what does it, and nothing else tells a client.
//
// Which weapons are grouped is dogma's too, though not an attribute. GetAllInfo
// carries the ship's state, (instances, charges by flag, weapon banks, heat),
// and the client makes the third its banks when the ship becomes its own
// (clientDogmaLocation._MakeShipActive, baseDogmaLocation.SetWeaponBanks):
// {masterID: [slaveID, ...]}. After that it is told, or tells itself from the
// answer to its own call:
//
//   OnWeaponBanksChanged(shipID, banks)     the whole set, anew
//   OnWeaponGroupDestroyed(shipID, itemID)  that master's bank is gone
//
// How hot each rack is running is the dogma location's too, and it is the one
// reading the client works out for itself as time passes
// (dogma/attributes/heatAttribute.py). Each of the ship's three heat
// attributes (heatHi, heatMed, heatLow) holds a value and when it was true,
// and at any later moment is
//
//   with nothing heating it    value x e^(-seconds x dissipationRate), and
//                              nothing once that rounds to nothing
//   with heat coming in        cap - cap x k + value x k,
//                              k = e^(-seconds x incomingHeat x heatGenerationMultiplier)
//
// The server sets the value (an attribute change for one of the three,
// clientDogmaLocation.OnModuleAttributeChanges: SetBaseValue, true from the
// moment it arrives). What is coming in is the sum of the
// heatAbsorbtionRateModifier of each module the client has been told is
// heating that rack (OnHeatAdded(heatID, moduleID), OnHeatRemoved). The panel
// shows value / capacity (shipDogmaItem.GetHeatValues). The heat states in
// GetAllInfo's ship state are unpacked by the client and never used.
//
// The heat belongs to the dogma location's ship item, and the client keeps the
// ship item it has for as long as that ship is its current one: asked to make
// it active again after a dock, an undock or a jump, _MakeShipActive sees it
// is the same ship and does nothing. Godma is flushed and primed again each
// time; the racks' heat, and what is heating them, carry on. A change of ship
// unloads the old one and its heat with it.
//
// An item that turns up after the ship was loaded is told of on its own, in
// the same form as its row in GetAllInfo (godma.py 385, 1289):
//
//   OnGodmaPrimeItem(locationID, row)
//
// which is how a charge loaded into an empty module arrives, the probes
// coming back to an empty launcher among them.
//
// A module fitted, moved to another slot or taken out is told of as any item
// that moves is, by its inventory row as it is now:
//
//   OnItemsChanged(items, change, location)   invCache hands each on as
//   OnItemChange(item, change, location)      one item's
//
// Godma takes the ones in a ship it holds and asks the server what dogma has
// of each, ItemGetInfo(itemID), whose answer is the item's row as GetAllInfo
// lists one (godma.OnItemChange 1208, UpdateItem 1629); it does not ask about
// what is in the hold, the drone bay or a fighter tube. The client's dogma
// location then takes the same ones (clientDogmaIM.GodmaItemChanged,
// clientDogmaLocation.OnItemChange): one it did not hold that is now in a slot
// is fitted, one it held that no longer is is unloaded, and one that is in a
// slot still is where its row says. A module newly fitted it puts online
// itself. The asking and the putting online are the transport's (pilots.js).
//
// Only the ship's items are kept here, and only what the panel and the scanner need.

/** dogma attribute IDs (dogma/const.py). */
const ATTRIBUTE = Object.freeze({
  IS_ONLINE: 2,
  DAMAGE: 3,
  HP: 9,
  CHARGE: 18,
  RECHARGE_RATE: 55,
  SHIELD_CAPACITY: 263,
  SHIELD_CHARGE: 264,
  ARMOR_HP: 265,
  ARMOR_DAMAGE: 266,
  SHIELD_RECHARGE_RATE: 479,
  CAPACITOR_CAPACITY: 482,
  QUANTITY: 805,
});
/** dogma/const.py heatAttributes: each rack's heat, with its capacity and its dissipation rate; and the family the snapshot names it by. */
const HEAT = new Map([
  [1175, { capacity: 1178, dissipation: 1179, family: "high" }],
  [1176, { capacity: 1199, dissipation: 1196, family: "mid" }],
  [1177, { capacity: 1200, dissipation: 1198, family: "low" }],
]);
const ATTRIBUTE_HEAT_ABSORBTION_RATE_MODIFIER = 1180;
const ATTRIBUTE_HEAT_GENERATION_MULTIPLIER = 1224;
/** The attributes a rack's heat is worked out from, besides the heat itself. */
const HEAT_INPUTS = new Set([ATTRIBUTE_HEAT_ABSORBTION_RATE_MODIFIER, ATTRIBUTE_HEAT_GENERATION_MULTIPLIER, ...[...HEAT.values()].flatMap(({ capacity, dissipation }) => [capacity, dissipation])]);

/**
 * heatAttribute.CalculateHeat: a rack's heat after `timeDiff` milliseconds.
 * Held to the client's own compiled function in test/gamePortDogma.test.js.
 */
function calculateHeat(currentHeat, timeDiff, incomingHeat, dissipationRate, heatGenerationMul, heatCap) {
  if (incomingHeat < 5e-8) {
    const cooled = currentHeat * Math.exp((-timeDiff / 1000) * dissipationRate);
    return Math.round(cooled) <= 0 ? 0 : cooled;
  }
  const kept = Math.exp((-timeDiff / 1000) * incomingHeat * heatGenerationMul);
  return heatCap - heatCap * kept + currentHeat * kept;
}

/** inventorycommon/const.py categoryModule and categorySubSystem. */
const CATEGORY_MODULE = 7;
const CATEGORY_SUBSYSTEM = 32;
/**
 * inventorycommon/const.py, each range by its two ends: a ship's slots (fittingFlags and flagHiddenModifers, which
 * is IsShipFittingFlag), and where a drone or a fighter is kept ready (flagDroneBay, the fighter tubes). An item at
 * any of them is fitted, as clientDogmaLocation.IsFitted has it.
 */
const SLOTS = Object.freeze([[11, 34], [92, 94], [125, 128], [164, 171], [156, 156]]);
const KEPT_READY = Object.freeze([[87, 87], [159, 163]]);
const within = (ranges, flagID) => ranges.some(([first, last]) => flagID >= first && flagID <= last);
const isFittedAt = (flagID) => within(SLOTS, flagID) || within(KEPT_READY, flagID);
/** godma.chargedAttributeTauCaps: a recharging attribute, the attribute that is its recharge time, and the one that is its capacity. */
const CHARGED = new Map([
  [ATTRIBUTE.CHARGE, [ATTRIBUTE.RECHARGE_RATE, ATTRIBUTE.CAPACITOR_CAPACITY]],
  [ATTRIBUTE.SHIELD_CHARGE, [ATTRIBUTE.SHIELD_RECHARGE_RATE, ATTRIBUTE.SHIELD_CAPACITY]],
]);
/** dogma/const.py: the kinds of effect. */
const EFFECT_CATEGORY = Object.freeze({ PASSIVE: 0, ACTIVATION: 1, TARGET: 2, AREA: 3, ONLINE: 4, OVERLOAD: 5 });
const RUNNING = new Set([EFFECT_CATEGORY.ACTIVATION, EFFECT_CATEGORY.TARGET, EFFECT_CATEGORY.AREA]);
/**
 * const.effectOnline. Being online is an effect too, and the static data files it under the same kind as an afterburner's;
 * godma leaves it out by name wherever it asks what is running (PurgeInventories 2459, requiredEffects).
 */
const EFFECT_ONLINE = 16;
/** godma.py 1009-1016: where things are in an effect's environment. */
const ENV_IDX_TARGET = 3;

/** dogma/const.py dgmTauConstant: the clock's units (100 ns) in a millisecond. Recharge times are in milliseconds. */
const DGM_TAU_CONSTANT = 10000;
/** The clock's zero (1601) in the Unix epoch's milliseconds. */
const FILETIME_EPOCH_MS = 11644473600000n;

const text = (value) => (Buffer.isBuffer(value) ? value.toString("utf8") : typeof value === "string" ? value : null);
const number = (value) => (typeof value === "bigint" ? Number(value) : typeof value === "number" ? value : null);
/** An item's ID as a key: a number when a number holds it; for a charge in a module, its tuple (ship, flag, type) as "ship/flag/type". */
const key = (value) => {
  if (Array.isArray(value)) return value.map(String).join("/");
  return typeof value === "bigint" && value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= 0n ? Number(value) : value;
};
/** An inventory row's fields by name, however the codec spells the row; null when it is not a row. */
const rowFields = (row) => {
  if (!row || typeof row !== "object") return null;
  if (row.fields && typeof row.fields === "object") return row.fields;
  if (Array.isArray(row.columns) && Array.isArray(row.values)) return Object.fromEntries(row.columns.map((column, index) => [text(column[0]) ?? column[0], row.values[index]]));
  return null;
};
const clock = (value) => (typeof value === "bigint" ? value : typeof value === "number" && Number.isFinite(value) ? BigInt(Math.trunc(value)) : null);
const fieldsOf = (value) => {
  const dict = value && value.type === "object" ? value.args : value;
  return new Map((dict && Array.isArray(dict.entries) ? dict.entries : []).map(([name, entry]) => [text(name) ?? name, entry]));
};
const items = (value) => (Array.isArray(value) ? value : value && Array.isArray(value.items) ? value.items : []);

/** A reading of the server's clock (100 ns since 1601) from this machine's. */
const filetimeNow = (nowMs = Date.now()) => (BigInt(Math.trunc(nowMs)) + FILETIME_EPOCH_MS) * BigInt(DGM_TAU_CONSTANT);

/**
 * godma.GetChargeValue: what a recharging attribute is at `newTime`, given
 * that it was `oldVal` at `oldTime`. `tau` is the recharge time over five, in
 * milliseconds, and `Ec` the capacity. Times are the clock's (100 ns).
 */
function chargeValue(oldVal, oldTime, tau, Ec, newTime) {
  if (Ec === 0) return 0;
  const sq = Math.sqrt(Math.max(oldVal / Ec, 0));
  const timePassed = Math.min(Number(oldTime - newTime), 0) / DGM_TAU_CONSTANT;
  const exp = Math.exp(timePassed / tau);
  return (1.0 + (sq - 1.0) * exp) ** 2 * Ec;
}

/**
 * `characterID` is whose items these are: a change for anyone else's is
 * refused, as godma refuses it. `now()` reads the clock. `effectCategory(effectID)`
 * says what kind an effect is, from the game's static data; without it no
 * module can be told to be running. Of an item the server says has moved, while
 * its ship is held: `onSlotted({ itemID, typeID, flagID, locationID })` is told
 * of each module in a slot, which godma asks the server about, and `onFitted`
 * of each item newly fitted, after it.
 */
function createPilotDogma({ characterID = null, now = filetimeNow, effectCategory = () => null, onSlotted = () => {}, onFitted = () => {} } = {}) {
  /** itemID -> Map(attributeID -> value). */
  const attributes = new Map();
  /** itemID -> Map(attributeID -> [value, time, tau, capacity]). */
  const charged = new Map();
  /** "itemID:attributeID" -> the time of the last change taken for it. */
  const lastChange = new Map();
  /** itemID -> Map(effectID -> { isActive, startTime, duration, repeat, targetID }). */
  const effects = new Map();
  /** item key -> { typeID, groupID, categoryID, flagID, locationID }: what each held item is and where. A charge in a module has no group. */
  const identity = new Map();
  /** ship key -> Map(masterID -> Set(slaveID)): baseDogmaLocation.slaveModulesByMasterModule. */
  const banks = new Map();
  /** item key -> Map(heatID -> { value, at, sources: Set(moduleID) }): the item's HeatAttributes. */
  const heat = new Map();

  /** godma.GetAttribute. */
  function attribute(itemID, attributeID, at = now()) {
    const id = key(itemID);
    const recharging = charged.get(id)?.get(attributeID);
    if (recharging) return chargeValue(...recharging, at);
    return attributes.get(id)?.get(attributeID) ?? null;
  }

  /** Every attribute held of an item, each as it is now (godma.GetAttribute of each), in the order the item's row gave them. */
  function attributesOf(itemID, at = now()) {
    const held = attributes.get(key(itemID));
    return held ? [...held.keys()].map((attributeID) => [attributeID, attribute(itemID, attributeID, at)]) : [];
  }

  /** godma.CreateChargedAttribute. */
  function createCharged(id, attributeID, value, time) {
    const [tau, cap] = CHARGED.get(attributeID);
    if (!charged.has(id)) charged.set(id, new Map());
    charged.get(id).set(attributeID, [value, time, attribute(id, tau, time) / 5.0, attribute(id, cap, time)]);
  }

  /** godma.UpdateAttribute: an item's attributes, all at once, true at `time`. */
  function updateAttributes(itemID, values, time) {
    const id = key(itemID);
    attributes.set(id, values);
    charged.delete(id);
    for (const attributeID of values.keys()) {
      if (!CHARGED.has(attributeID)) continue;
      const [tau, cap] = CHARGED.get(attributeID);
      if (values.get(tau) && values.get(cap)) createCharged(id, attributeID, values.get(attributeID), time);
    }
  }

  /**
   * godma.ProcessAllInfo, for the ship's items: what GetAllInfo answered.
   * Answers the IDs it now holds.
   */
  function loadAllInfo(allInfo) {
    const shipInfo = fieldsOf(allInfo).get("shipInfo");
    const held = [];
    for (const [itemID, row] of shipInfo && Array.isArray(shipInfo.entries) ? shipInfo.entries : []) {
      loadRow(itemID, row);
      held.push(key(itemID));
    }
    // The ship item the client has is kept when that ship is loaded again; any other was unloaded, and its
    // heat with it. A module that is no longer among the ship's items heats nothing.
    for (const [id, racks] of [...heat]) {
      if (!held.includes(id)) heat.delete(id);
      else for (const state of racks.values()) for (const moduleID of [...state.sources]) if (!held.includes(moduleID)) state.sources.delete(moduleID);
    }
    // clientDogmaLocation._MakeShipActive: the ship's state is (instances, charges by flag, weapon banks, heat),
    // and the third is the active ship's banks.
    const all = fieldsOf(allInfo);
    const shipState = all.get("shipState");
    const activeShip = all.get("activeShipID");
    if (Array.isArray(shipState) && shipState.length >= 3 && activeShip !== undefined && activeShip !== null) setWeaponBanks(activeShip, shipState[2]);
    return held;
  }

  /** baseDogmaLocation.SetWeaponBanks: a ship's banks, replacing what was held. {masterID: [slaveID, ...]}, or nothing. */
  function setWeaponBanks(shipID, data) {
    const held = new Map();
    for (const [masterID, slaves] of data && Array.isArray(data.entries) ? data.entries : []) {
      const master = key(masterID);
      if (!held.has(master)) held.set(master, new Set());
      for (const slaveID of items(slaves)) held.get(master).add(key(slaveID));
    }
    banks.set(key(shipID), held);
  }

  /** clientDogmaLocation.UngroupModule, once the server has answered with the slave it took out: a bank left empty is gone. */
  function unlinkModule(shipID, masterID, slaveID) {
    const held = banks.get(key(shipID));
    const slaves = held ? held.get(key(masterID)) : null;
    if (!slaves) return;
    slaves.delete(key(slaveID));
    if (slaves.size === 0) held.delete(key(masterID));
  }

  /** What is heating one of an item's racks: the sum of its sources' heatAbsorbtionRateModifier. */
  const incomingHeat = (state, at) => [...state.sources].reduce((sum, moduleID) => sum + (attribute(moduleID, ATTRIBUTE_HEAT_ABSORBTION_RATE_MODIFIER, at) ?? 0), 0);

  /** HeatAttribute.Update: bring a rack's heat to the moment `at`. */
  function updateHeat(id, heatID, at) {
    const state = heat.get(id)?.get(heatID);
    if (!state) return null;
    const { capacity, dissipation } = HEAT.get(heatID);
    const elapsed = Number(at - state.at) / DGM_TAU_CONSTANT;
    state.value = calculateHeat(state.value, elapsed, incomingHeat(state, at), attribute(id, dissipation, at) ?? 0, attribute(id, ATTRIBUTE_HEAT_GENERATION_MULTIPLIER, at) ?? 0, attribute(id, capacity, at) ?? 0);
    state.at = at;
    return state;
  }

  /**
   * Something a rack's heat is worked out from is about to change on this item: bring to `at` the racks it
   * enters, a ship's own three or the ones a module is heating. The client's gauges have them there already,
   * so what went before the change is reckoned by what was true before it.
   */
  function settleHeat(id, at) {
    const shipID = heat.has(id) ? id : identity.get(id)?.locationID;
    for (const [heatID, state] of heat.get(shipID) ?? []) if (shipID === id || state.sources.has(id)) updateHeat(shipID, heatID, at);
  }

  /** godma.UpdateItem: one item's row, as GetAllInfo lists it and as OnGodmaPrimeItem sends it. */
  function loadRow(itemID, row) {
    const fields = fieldsOf(row);
    const values = new Map();
    const given = fields.get("attributes");
    for (const [attributeID, value] of given && Array.isArray(given.entries) ? given.entries : []) values.set(number(attributeID), number(value));
    updateAttributes(itemID, values, clock(fields.get("time")) ?? now());
    // HeatAttribute.__init__, for an item that has racks to heat and is not held already: what the row says of
    // each, no more than its capacity, true from now, with nothing coming in.
    if (!heat.has(key(itemID)) && [...HEAT.values()].some(({ capacity }) => values.has(capacity))) {
      const racks = new Map();
      for (const [heatID, { capacity }] of HEAT) racks.set(heatID, { value: Math.min(values.get(capacity) ?? 0, values.get(heatID) ?? 0), at: now(), sources: new Set() });
      heat.set(key(itemID), racks);
    }
    // What the item is: its inventory row, or for a charge in a module the tuple it is keyed by.
    const inventory = rowFields(fields.get("invItem"));
    if (Array.isArray(itemID)) {
      identity.set(key(itemID), { typeID: number(itemID[2]), groupID: null, categoryID: null, flagID: number(itemID[1]), locationID: key(itemID[0]) });
    } else if (inventory) {
      identity.set(key(itemID), { typeID: number(inventory.typeID), groupID: number(inventory.groupID), categoryID: number(inventory.categoryID), flagID: number(inventory.flagID), locationID: key(inventory.locationID) });
    }
    // godma.RefreshItemEffects: the effects active on the item, each with when it began, how long a cycle is and how many are left.
    const active = new Map();
    const listed = fields.get("activeEffects");
    for (const [effectID, line] of listed && Array.isArray(listed.entries) ? listed.entries : []) {
      if (!Array.isArray(line)) continue;
      active.set(number(effectID), { isActive: true, startTime: clock(line[7]), duration: number(line[8]), repeat: number(line[9]), targetID: line[ENV_IDX_TARGET] ?? null });
    }
    effects.set(key(itemID), active);
  }

  /**
   * godma.OnGodmaPrimeItem(locationID, row): an item in a location that is
   * held. One for a ship that is not held is left alone.
   */
  function primeItem(args) {
    const [locationID, row] = args;
    if (!attributes.has(key(locationID))) return false;
    const itemID = fieldsOf(row).get("itemID");
    if (itemID === undefined || itemID === null) return false;
    loadRow(itemID, row);
    return true;
  }

  /**
   * clientDogmaLocation.OnItemChange, for one item by its inventory row as it is now. Fitted is in one of the
   * places above, in something that is held, with something in the stack; the only things held that anything
   * is in are ships. The ship's own row is neither: what it is in is not held.
   */
  function itemChanged(row) {
    const item = rowFields(row);
    const id = item ? key(item.itemID) : null;
    if (typeof id !== "number") return;
    const location = key(item.locationID);
    const known = identity.get(id);
    const was = known !== undefined && attributes.has(known.locationID);
    const is = attributes.has(location) && isFittedAt(number(item.flagID)) && number(item.stacksize) > 0;
    if (was && !is) {
      // UnfitItem: unloaded, and nothing the server says of it after is about anything held.
      identity.delete(id);
      attributes.delete(id);
      effects.delete(id);
      return;
    }
    if (!is) return;
    const [flagID, categoryID] = [number(item.flagID), number(item.categoryID)];
    const here = { itemID: id, typeID: number(item.typeID), flagID, locationID: location };
    identity.set(id, { typeID: here.typeID, groupID: number(item.groupID), categoryID, flagID, locationID: location });
    if (!was) {
      // Held from here on, with nothing known of it until the server says.
      attributes.set(id, new Map());
      effects.set(id, new Map());
    }
    // godma.UpdateItem: a module or a subsystem in one of the ship's slots is asked about.
    if (within(SLOTS, flagID) && (categoryID === CATEGORY_MODULE || categoryID === CATEGORY_SUBSYSTEM)) onSlotted(here);
    // FitItem.
    if (!was) onFitted(here);
  }

  /** godma.UpdateItem with what the server answered ItemGetInfo: the row of an item that is still held, in place of what was known of it. */
  function updateItem(itemID, row) {
    if (!row || !attributes.has(key(itemID))) return false;
    loadRow(itemID, row);
    return true;
  }

  /** clientDogmaLocation.Activate and StopEffect: an effect the client starts or stops itself, on an item that is held. */
  function setEffect(itemID, effectID, isActive) {
    const held = effects.get(key(itemID));
    if (!held) return false;
    held.set(effectID, { isActive, startTime: now(), duration: null, repeat: null, targetID: null });
    return true;
  }

  /** godma.ApplyAttributeChange. */
  function applyAttributeChange(itemID, attributeID, time, newValue) {
    const id = key(itemID);
    const values = attributes.get(id);
    if (!values) return false; // "item not found"
    const oldValue = attribute(id, attributeID);
    if (oldValue === newValue) return false; // "Reduntant update"
    values.set(attributeID, newValue);
    if (CHARGED.has(attributeID)) {
      createCharged(id, attributeID, newValue, time);
      return true;
    }
    for (const [chargeID, [tau, cap]] of CHARGED) {
      const held = charged.get(id)?.has(chargeID);
      if (attributeID === cap) {
        // The capacity changed: a charge that was full stays full, and none is ever over.
        if (held) {
          let charge = attribute(id, chargeID);
          if (charge === oldValue) charge *= newValue / oldValue;
          if (charge > newValue) charge = newValue;
          createCharged(id, chargeID, charge, time);
        } else if (values.get(tau) && values.get(cap)) {
          createCharged(id, chargeID, values.get(chargeID), time);
        }
      } else if (attributeID === tau && held) {
        // The recharge time changed: carry on from what the charge is now.
        createCharged(id, chargeID, attribute(id, chargeID), time);
      }
    }
    return true;
  }

  /**
   * godma.OnModuleAttributeChange_: one change, as it arrives inside
   * OnModuleAttributeChanges: (tag, ownerID, itemID, attributeID, time, new, old[, wallclockTime]).
   */
  function change(each) {
    const [, ownerID, itemKey, attributeID, time, newValue, , wallclock] = each;
    // A charge loaded in a module is keyed by a tuple, and is changed like anything else that is held.
    const id = key(itemKey);
    const attribute_ = number(attributeID);
    const stamp = clock(wallclock);
    // godma._IsAttributeChangeRelevant: an older change than the last one taken is dropped.
    const last = lastChange.get(`${id}:${attribute_}`);
    if (stamp && last !== undefined && last > stamp) return false;
    if (stamp) lastChange.set(`${id}:${attribute_}`, stamp);
    if (characterID !== null && number(ownerID) !== characterID && id !== characterID) return false; // not mine
    // clientDogmaLocation.OnModuleAttributeChanges: a rack's heat is set to what the server says, as of now
    // (HeatAttribute.SetBaseValue). The client leaves it alone when it is that already, going by the value its
    // gauges last worked out; here that is the heat as of now, which in space is the same to within a gauge's
    // refresh. So the same number sent again later is news: the rack had cooled, or climbed, since.
    if (HEAT.has(attribute_) && number(newValue) !== null) {
      const rack = updateHeat(id, attribute_, now());
      if (rack) rack.value = number(newValue);
    }
    if (HEAT_INPUTS.has(attribute_)) settleHeat(id, now());
    return applyAttributeChange(id, attribute_, clock(time) ?? now(), number(newValue));
  }

  /**
   * godma.OnGodmaShipEffect: an effect on one of the pilot's items has started
   * or stopped. One for an item that is not held is nothing, as on the client.
   */
  function shipEffect(args) {
    const [itemID, effectID, , , active, environment, startTime, duration, repeat] = args;
    const held = effects.get(key(itemID));
    if (!held) return false;
    held.set(number(effectID), {
      isActive: Boolean(active),
      startTime: clock(startTime),
      duration: number(duration),
      repeat: typeof repeat === "boolean" ? Number(repeat) : number(repeat),
      targetID: Array.isArray(environment) ? environment[ENV_IDX_TARGET] ?? null : null,
    });
    return true;
  }

  /**
   * godma.OnMultiEvent: events of several kinds, each paired with its moment.
   * They are taken a moment at a time, in order; of the attribute changes in
   * one moment only the last for each item's attribute counts
   * (BroadcastFilteredMAC), and those are applied oldest first. The same goes
   * for the effects' starts and stops (BroadcastFilteredGSF).
   */
  function multiEvent(events) {
    const moments = new Map();
    for (const pair of items(events)) {
      if (!Array.isArray(pair) || pair.length < 2) continue;
      const moment = clock(pair[pair.length - 1]) ?? 0n;
      if (!moments.has(moment)) moments.set(moment, []);
      moments.get(moment).push(pair[0]);
    }
    for (const moment of [...moments.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
      const byTime = (a, b) => {
        const [x, y] = [clock(a[4]) ?? 0n, clock(b[4]) ?? 0n];
        return x < y ? -1 : x > y ? 1 : 0;
      };
      const changes = moments.get(moment).filter((event) => Array.isArray(event) && text(event[0]) === "OnModuleAttributeChange").sort(byTime);
      const last = new Map();
      for (const each of changes) last.set(`${each[1]}:${Array.isArray(each[2]) ? each[2].join("/") : each[2]}:${each[3]}`, each);
      for (const each of [...last.values()].sort(byTime)) {
        try {
          change(each);
        } catch {
          // As below: one bad change does not lose the rest.
        }
      }
      // BroadcastFilteredGSF: sorted by time, and the last one for each item's effect is the one that is told.
      const byEffectTime = (a, b) => {
        const [x, y] = [clock(a[3]) ?? 0n, clock(b[3]) ?? 0n];
        return x < y ? -1 : x > y ? 1 : 0;
      };
      const lastEffect = new Map();
      for (const event of moments.get(moment).filter((each) => Array.isArray(each) && text(each[0]) === "OnGodmaShipEffect").sort(byEffectTime)) {
        lastEffect.set(`${event[1]}:${event[2]}`, event);
      }
      for (const event of lastEffect.values()) shipEffect(event.slice(1));
    }
  }

  /** A notification from the session. True when it was dogma's. */
  function feed(notification) {
    if (notification.method === "OnMultiEvent") {
      multiEvent(notification.args[0]);
      return true;
    }
    if (notification.method === "OnModuleAttributeChanges") {
      for (const each of items(notification.args[0])) {
        try {
          change(each);
        } catch {
          // godma's ExceptionEater: one bad change does not lose the rest.
        }
      }
      return true;
    }
    if (notification.method === "OnModuleAttributeChange") {
      change(["OnModuleAttributeChange", ...notification.args]);
      return true;
    }
    if (notification.method === "OnGodmaShipEffect") {
      shipEffect(notification.args);
      return true;
    }
    if (notification.method === "OnHeatAdded" || notification.method === "OnHeatRemoved") {
      // clientDogmaLocation.OnHeatAdded, OnHeatRemoved(heatID, moduleID). The client's ship is its current one;
      // here it is the ship the module is fitted to, which for a module that can heat a rack is the same ship.
      const [heatID, moduleID] = Array.isArray(notification.args) ? notification.args : [];
      const module = identity.get(key(moduleID));
      const state = module ? updateHeat(module.locationID, number(heatID), now()) : null;
      if (state && notification.method === "OnHeatAdded") state.sources.add(key(moduleID));
      else if (state) state.sources.delete(key(moduleID));
      return true;
    }
    if (notification.method === "OnWeaponBanksChanged") {
      if (Array.isArray(notification.args) && notification.args.length >= 1) setWeaponBanks(notification.args[0], notification.args[1]);
      return true;
    }
    if (notification.method === "OnWeaponGroupDestroyed") {
      const [shipID, masterID] = Array.isArray(notification.args) ? notification.args : [];
      const held = banks.get(key(shipID));
      if (held) held.delete(key(masterID));
      return true;
    }
    if (notification.method === "OnGodmaPrimeItem") {
      primeItem(Array.isArray(notification.args) ? notification.args : []);
      return true;
    }
    if (notification.method === "OnItemsChanged" || notification.method === "OnItemChange") {
      const first = Array.isArray(notification.args) ? notification.args[0] : null;
      for (const row of notification.method === "OnItemsChanged" ? items(first) : [first]) itemChanged(row);
      return true;
    }
    return false;
  }

  /** The held items, other than `shipID` itself, with an active effect of one of `kinds`: in ascending order. */
  function modulesWith(shipID, kinds) {
    const ship = key(shipID);
    const found = [];
    for (const [itemID, held] of effects) {
      if (itemID === ship || typeof itemID !== "number") continue;
      for (const [effectID, effect] of held) {
        if (effect.isActive && effectID !== EFFECT_ONLINE && kinds.has(effectCategory(effectID))) {
          found.push(itemID);
          break;
        }
      }
    }
    return found.sort((a, b) => a - b);
  }

  /** What is left of something as a fraction of its whole, or null when either is not known or there is no whole. */
  const fraction = (left, whole) => (left === null || whole === null || !(whole > 0) ? null : Math.min(1, Math.max(0, left / whole)));

  /**
   * How damaged each of the ship's fitted modules is, {itemID: 0..1}: its
   * damage over its hp, and only the ones that are damaged at all, so an empty
   * answer means every module is whole.
   */
  function moduleDamage(shipID, at = now()) {
    const ship = key(shipID);
    const damaged = {};
    for (const [itemID, item] of identity) {
      if (typeof itemID !== "number" || item.locationID !== ship || item.categoryID !== CATEGORY_MODULE) continue;
      const ratio = fraction(attribute(itemID, ATTRIBUTE.DAMAGE, at), attribute(itemID, ATTRIBUTE.HP, at));
      if (ratio !== null && ratio > 0) damaged[String(itemID)] = ratio;
    }
    return damaged;
  }

  /** The ship's weapon banks, {masterID: [slaveID, ...]} with the slaves in order, or null when its state was never loaded. */
  function weaponBanks(shipID) {
    const held = banks.get(key(shipID));
    if (!held) return null;
    const out = {};
    for (const [masterID, slaves] of held) {
      if (typeof masterID !== "number") continue;
      out[String(masterID)] = [...slaves].filter((slaveID) => typeof slaveID === "number" && slaveID !== masterID).sort((a, b) => a - b);
    }
    return out;
  }

  /**
   * shipDogmaItem.GetHeatValues: how hot each rack is at `at`, as a fraction of its capacity,
   * { high, mid, low }; null for an item that has no racks or was never loaded.
   */
  function rackHeat(shipID, at = now()) {
    const id = key(shipID);
    const racks = attributes.has(id) ? heat.get(id) : null;
    if (!racks) return null;
    const out = {};
    for (const [heatID, { capacity, dissipation, family }] of HEAT) {
      const state = racks.get(heatID);
      const maxHeat = attribute(id, capacity, at) ?? 0;
      const incoming = incomingHeat(state, at);
      if (maxHeat === 0 || (state.value === 0 && incoming === 0)) {
        out[family] = 0;
        continue;
      }
      const elapsed = Number(at - state.at) / DGM_TAU_CONSTANT;
      out[family] = calculateHeat(state.value, elapsed, incoming, attribute(id, dissipation, at) ?? 0, attribute(id, ATTRIBUTE_HEAT_GENERATION_MULTIPLIER, at) ?? 0, maxHeat) / maxHeat;
    }
    return out;
  }

  /**
   * What the ship's panel shows that the ballpark does not know: the capacitor
   * and the three kinds of health as fractions, the three capacities, and what
   * its modules are doing. Null until the ship is loaded.
   */
  function shipReadings(shipID, at = now()) {
    const id = key(shipID);
    if (!attributes.has(id)) return null;
    const capacity = attribute(id, ATTRIBUTE.CAPACITOR_CAPACITY, at);
    const charge = attribute(id, ATTRIBUTE.CHARGE, at);
    const armor = attribute(id, ATTRIBUTE.ARMOR_HP, at);
    const armorDamage = attribute(id, ATTRIBUTE.ARMOR_DAMAGE, at);
    const hull = attribute(id, ATTRIBUTE.HP, at);
    const hullDamage = attribute(id, ATTRIBUTE.DAMAGE, at);
    return {
      capacitorRatio: capacity > 0 && charge !== null ? Math.min(1, Math.max(0, charge / capacity)) : null,
      // activeShipController: what is left of each, of its whole.
      shieldRatio: fraction(attribute(id, ATTRIBUTE.SHIELD_CHARGE, at), attribute(id, ATTRIBUTE.SHIELD_CAPACITY, at)),
      armorRatio: fraction(armor === null || armorDamage === null ? null : armor - armorDamage, armor),
      hullRatio: fraction(hull === null || hullDamage === null ? null : hull - hullDamage, hull),
      shieldCapacity: attribute(id, ATTRIBUTE.SHIELD_CAPACITY, at),
      armorCapacity: attribute(id, ATTRIBUTE.ARMOR_HP, at),
      hullCapacity: attribute(id, ATTRIBUTE.HP, at),
      // Which of its modules are running, and which are overloaded.
      activeModuleIDs: modulesWith(id, RUNNING),
      overloadedModuleIDs: modulesWith(id, new Set([EFFECT_CATEGORY.OVERLOAD])),
      moduleDamage: moduleDamage(id, at),
      weaponBanks: weaponBanks(id),
      rackHeat: rackHeat(id, at),
    };
  }

  /**
   * scanSvc.GetProbeLauncher and GetChargesInProbeLauncher: the ship's first
   * module of `groupID` that is online (godma's module.isOnline is the
   * attribute), in the order the server listed them, and what is loaded at its
   * flag. Null when the ship has none.
   */
  function onlineModule(shipID, groupID) {
    const ship = key(shipID);
    for (const [itemID, item] of identity) {
      if (typeof itemID !== "number" || item.locationID !== ship || item.groupID !== groupID) continue;
      if (!attribute(itemID, ATTRIBUTE.IS_ONLINE)) continue;
      return { moduleID: itemID, typeID: item.typeID, flagID: item.flagID, charge: chargeAt(ship, item.flagID) };
    }
    return null;
  }

  /** What is loaded at a flag of a ship: { typeID, quantity }, or null when nothing is. */
  function chargeAt(ship, flagID) {
    let charge = null;
    for (const [chargeKey, loaded] of identity) {
      if (typeof chargeKey !== "string" || loaded.locationID !== ship || loaded.flagID !== flagID) continue;
      const quantity = attribute(chargeKey, ATTRIBUTE.QUANTITY);
      // One that has run out is still listed until the server takes it away; it is not a charge any more.
      if (quantity > 0) charge = { typeID: loaded.typeID, quantity };
    }
    return charge;
  }

  /** shipmodulebutton's self.charge: what is loaded in a fitted module, { typeID, quantity }, or null. */
  function chargeIn(moduleID) {
    const item = identity.get(key(moduleID));
    return item ? chargeAt(item.locationID, item.flagID) : null;
  }

  /**
   * clientDogmaLocation.GetOnlineModules(shipID): the ship's fitted modules
   * whose online effect is running, as [flagID, moduleID] in the order the
   * server listed them. The client hands this over when it undocks.
   */
  function onlineModules(shipID) {
    const ship = key(shipID);
    const found = [];
    for (const [itemID, item] of identity) {
      if (typeof itemID !== "number" || item.locationID !== ship) continue;
      if (effects.get(itemID)?.get(EFFECT_ONLINE)?.isActive) found.push([item.flagID, itemID]);
    }
    return found;
  }

  return {
    attribute,
    applyAttributeChange,
    onlineModule,
    onlineModules,
    chargeIn,
    /** What a held item is: its type, or null for one godma was not told of. */
    typeOf: (itemID) => identity.get(key(itemID))?.typeID ?? null,
    /** What a held item is and where: { typeID, groupID, categoryID, flagID, locationID }, or null for one godma was not told of. */
    item: (itemID) => identity.get(key(itemID)) ?? null,
    attributesOf,
    setEffect,
    updateItem,
    setWeaponBanks,
    unlinkModule,
    weaponBanks,
    rackHeat,
    /** What is known of one effect on one item, or null. */
    effect: (itemID, effectID) => effects.get(key(itemID))?.get(effectID) ?? null,
    feed,
    loadAllInfo,
    multiEvent,
    shipReadings,
    has: (itemID) => attributes.has(key(itemID)),
    clear() {
      // Not the racks' heat: that is the ship item's, which outlives godma's flush (see the top of the file).
      // It is brought to now first, so what went before is reckoned by what was known before; loadAllInfo
      // lets go of it if the ship is not among what it loads.
      for (const [id, racks] of heat) for (const heatID of racks.keys()) updateHeat(id, heatID, now());
      attributes.clear();
      charged.clear();
      lastChange.clear();
      effects.clear();
      identity.clear();
      banks.clear();
    },
  };
}

module.exports = { ATTRIBUTE, CHARGED, DGM_TAU_CONSTANT, EFFECT_CATEGORY, EFFECT_ONLINE, HEAT, calculateHeat, chargeValue, createPilotDogma, filetimeNow, rowFields };
