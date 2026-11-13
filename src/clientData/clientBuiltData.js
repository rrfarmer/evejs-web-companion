"use strict";

// ── The retail client's built data, read by the client's own loaders ─────────
//
// What the retail client knows without asking the server is mostly "cFSD": a
// binary file among its resources (res:/staticdata/missions.fsdbinary) laid
// out by a schema that is compiled into a loader module beside its executable
// (bin64/missionsLoader.pyd). The file does not describe itself, and only that
// loader knows its layout. So the loader is what reads it: in the client's own
// python27.dll, on the player's own disk, when a table is first asked for
// (scripts/client-built-data.py). Nothing of the client is copied into this
// repository, and nothing is kept on disk.
//
// A mission is the first table read this way: the client's job board words a
// mission's page from its record here (evemissions/client/data.py get_mission),
// the message IDs of its briefing and of what its agent says, and never asks
// the server for them.
//
// This needs a 64-bit Python 3 on the machine to host the client's Python
// (EVEJS_PYTHON, "python" when unset). Without one, or without a client, a
// table is not available and its rows are null; nothing here throws for that.

const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { readResourceIndex } = require("./clientWords");

const SCRIPT = path.join(__dirname, "..", "..", "scripts", "client-built-data.py");
const LOAD_TIMEOUT_MS = 60_000;
// A table is a megabyte or two of JSON; the largest of the client's is far below this.
const MAX_OUTPUT_BYTES = 512 * 1024 * 1024;

// The tables read here: the name each goes by, the client's loader for it, and its resource (in lower case, as
// the index is kept).
const TABLES = Object.freeze({
  // evecorporation.roles: the role masks and group membership come from the installed client, never a copied table.
  corporationRoles: Object.freeze({ loader: "corporationRolesLoader", resource: "res:/staticdata/corporationroles.fsdbinary" }),
  corporationRoleGroups: Object.freeze({ loader: "corporationRoleGroupsLoader", resource: "res:/staticdata/corporationrolegroups.fsdbinary", keyOrder: true, longStrings: true }),
  missions: Object.freeze({ loader: "missionsLoader", resource: "res:/staticdata/missions.fsdbinary" }),
  // An NPC corporation's own record: the client takes an agent's faction from its corporation's (npcs/npccorporations.py).
  npcCorporations: Object.freeze({ loader: "npcCorporationsLoader", resource: "res:/staticdata/npccorporations.fsdbinary" }),
  // The divisions agents work in, each with the message its name is (npcs/divisions.py).
  npcCorporationDivisions: Object.freeze({ loader: "npcCorporationDivisionsLoader", resource: "res:/staticdata/npccorporationdivisions.fsdbinary" }),
  // The kinds of a wallet journal's entries, each with the message its line is worded by (eveaccounting/data.py
  // get_entry_format_localization_id: entryJournalMessageID), which the client's FmtWalletEntry words it with.
  accountingEntryTypes: Object.freeze({ loader: "accountingEntryTypesLoader", resource: "res:/staticdata/accountingentrytypes.fsdbinary" }),
  // The recruitment ads' groups and types (evecorporation/recruitment.py): each type's group, its name and description
  // as messages; a type's mask bit is 2 to the power of its number.
  recruitmentGroups: Object.freeze({ loader: "recruitmentGroupsLoader", resource: "res:/staticdata/recruitmentgroups.fsdbinary" }),
  recruitmentTypes: Object.freeze({ loader: "recruitmentTypesLoader", resource: "res:/staticdata/recruitmenttypes.fsdbinary" }),
  // A ship type's group in the client's ship tree (evetypes.GetShipGroupID: the type's isisGroupID), which the Ship
  // Restrictions window groups its hulls by. Only that attribute of the types is read: the table is too big to walk.
  typeShipGroups: Object.freeze({ loader: "typesLoader", resource: "res:/staticdata/types.fsdbinary", attribute: "isisGroupID" }),
  // The objectives the client tracks without asking the server (objectives/common/objectives_data.py): a chain's
  // objectives and its context's parameters, an objective's tasks, a task's own parameters, title and icon. The
  // Abyssal info panel is one chain of them (abyssal_service.py ABYSS_OBJECTIVE_CHAIN_ID).
  objectiveChains: Object.freeze({ loader: "objectiveChainsLoader", resource: "res:/staticdata/objectivechains.fsdbinary" }),
  objectiveTypes: Object.freeze({ loader: "objectiveTypesLoader", resource: "res:/staticdata/objectivetypes.fsdbinary" }),
  objectiveTaskTypes: Object.freeze({ loader: "objectiveTaskTypesLoader", resource: "res:/staticdata/objectivetasktypes.fsdbinary" }),
  // The special effects that are a jump (fsdBuiltData/client/travelEffects.py, by guid): IsTravelEffect.
  travelEffects: Object.freeze({ loader: "travelEffectsLoader", resource: "res:/staticdata/traveleffects.fsdbinary" }),
  // The skills a type needs and at what level, by type (evetypes/skills.py get_dogma_required_skills), which the
  // client's skill service and dogma location walk to say what is missing to fly a ship or use a thing. Each row is
  // [[skill, level], ...] in the order the client's loader iterates it (its requiredSkill1, 2, 3...), which the
  // client's skill plan validation walks in: keepOrder.
  requiredSkillsForTypes: Object.freeze({ loader: "requiredSkillsForTypesLoader", resource: "res:/staticdata/requiredskillsfortypes.fsdbinary", keepOrder: true }),
  // The other way about (evetypes/skills.py get_required_skills_index): by skill, by level, by the market category of
  // what needs it (150, skills), by meta group, the types that need the skill at that level. The skill plan editor's
  // remove lock reads it (skillPlanUtil.GetSkillsRequiring). Read a row at a time.
  requiredSkillsIndex: Object.freeze({ loader: "requiredSkillsIndexLoader", resource: "res:/staticdata/requiredskillsindex.fsdbinary", rowsOnly: true }),
  // The certified skill plans (skills/skillplan/skillPlanFSDLoader.get_skill_plans): each one's name and description
  // messages, career path, faction, NPC corporation division, skill requirements in order and milestones.
  skillPlans: Object.freeze({ loader: "skillPlansLoader", resource: "res:/staticdata/skillplans.fsdbinary" }),
  // The career paths (characterdata/careerpath.get_career_paths), whose buttons the Certified Plans panel lays out in
  // the order the table iterates them: keyOrder.
  careerPaths: Object.freeze({ loader: "careerPathsLoader", resource: "res:/staticdata/careerpaths.fsdbinary", keyOrder: true }),
  // A type's base price and whether it is published (evetypes.GetBasePrice and IsPublished): what a skill book bought
  // directly costs (characterskills/common/purchase.py get_direct_purchase_price) and whether it is sold so at all
  // (evetypes.IsSkillAvailableForPurchase). One attribute of the types each, as typeShipGroups is.
  typeBasePrices: Object.freeze({ loader: "typesLoader", resource: "res:/staticdata/types.fsdbinary", attribute: "basePrice" }),
  typePublished: Object.freeze({ loader: "typesLoader", resource: "res:/staticdata/types.fsdbinary", attribute: "published" }),
  // A type's portion size (evetypes.GetPortionSize), by which the market's average falls back to the base price where
  // nothing traded in the week (marketsvc.GetAveragePrice).
  typePortionSizes: Object.freeze({ loader: "typesLoader", resource: "res:/staticdata/types.fsdbinary", attribute: "portionSize" }),
  // Whether a type is a dynamic one, an item made by a mutaplasmid (evetypes.IsDynamicType: the type's isDynamicType),
  // which a GM's gift of what a fitting lacks passes over (missingItemsPopup.GiveOrLoadAllGM). Only the types that
  // have it are listed.
  typeDynamic: Object.freeze({ loader: "typesLoader", resource: "res:/staticdata/types.fsdbinary", attribute: "isDynamicType" }),
  // A dogma effect's name, the number of its message (dogma.data.get_effect_display_name: the effect's displayNameID),
  // which the fitting display heads each slot kind of a fitting with (fittingSvc.GetFittingInfoForScrollList).
  effectDisplayNames: Object.freeze({ loader: "dogmaEffectsLoader", resource: "res:/staticdata/dogmaeffects.fsdbinary", attribute: "displayNameID" }),
  // A dogma unit's name, the number of its message (dogma/units.py get_display_name: the unit's displayNameID), which a
  // ship's trait is written with (traits.TraitsContainer._GetBonusText).
  unitDisplayNames: Object.freeze({ loader: "dogmaUnitsLoader", resource: "res:/staticdata/dogmaunits.fsdbinary", attribute: "displayNameID" }),
  // What the fitting browser lists its hulls by (fittingBrowser.py GetShipsAndGroups and GetAllShipGroupsAndShipsByGroupID;
  // src/clientData/hullBrowser.js): a market group's parent (marketgroups/data.py get_market_group_parent_id), a
  // type's market group, group, faction and meta group (evetypes.GetMarketGroupID, GetGroupID, GetFactionID,
  // GetMetaGroupID), and a race's name (characterdata/races.py get_race_name: nameID).
  marketGroupParents: Object.freeze({ loader: "marketGroupsLoader", resource: "res:/staticdata/marketgroups.fsdbinary", attribute: "parentGroupID" }),
  typeMarketGroups: Object.freeze({ loader: "typesLoader", resource: "res:/staticdata/types.fsdbinary", attribute: "marketGroupID" }),
  typeGroups: Object.freeze({ loader: "typesLoader", resource: "res:/staticdata/types.fsdbinary", attribute: "groupID" }),
  // evetypes' cached VALUE sets are built in actual outer loader order.
  typesGroupIDsOrdered: Object.freeze({ loader: "typesLoader", resource: "res:/staticdata/types.fsdbinary", attribute: "groupID", keyOrder: true }),
  // Full groups keep category/name-field absence distinct from a projection
  // silently dropping a row. The source caches retain every group, including0.
  groupsOrdered: Object.freeze({ loader: "groupsLoader", resource: "res:/staticdata/groups.fsdbinary", keyOrder: true }),
  categoriesOrdered: Object.freeze({ loader: "categoriesLoader", resource: "res:/staticdata/categories.fsdbinary", keyOrder: true }),
  // evetypes.GetNameID: every installed type, including type0, has this field.
  typeNameIDs: Object.freeze({ loader: "typesLoader", resource: "res:/staticdata/types.fsdbinary", attribute: "typeNameID" }),
  typeFactions: Object.freeze({ loader: "typesLoader", resource: "res:/staticdata/types.fsdbinary", attribute: "factionID" }),
  typeMetaGroups: Object.freeze({ loader: "typesLoader", resource: "res:/staticdata/types.fsdbinary", attribute: "metaGroupID" }),
  raceNameIDs: Object.freeze({ loader: "racesLoader", resource: "res:/staticdata/races.fsdbinary", attribute: "nameID" }),
  // The bloodlines (characterdata/bloodlines.py): each one's name and description messages, its race and its
  // corporation. A character's Show Info words its Description by its bloodline's (get_bloodline_description).
  bloodlines: Object.freeze({ loader: "bloodlinesLoader", resource: "res:/staticdata/bloodlines.fsdbinary" }),
  // The standings an owner's stations ask for each service (evestations/standingsrestriction.py: by owner, its
  // services' required standings), which the standings bar marks (standingsUIUtil._GetStationServiceThresholdIDs).
  stationStandingsRestrictions: Object.freeze({ loader: "stationStandingsRestrictionsLoader", resource: "res:/staticdata/stationstandingsrestrictions.fsdbinary" }),
  // A group's category (evetypes.GetCategoryIDByGroup), by which a structure's fitting's menu has no Fit to Active Ship
  // (fittingBrowser.GetFittingMenu, 513).
  groupCategories: Object.freeze({ loader: "groupsLoader", resource: "res:/staticdata/groups.fsdbinary", attribute: "categoryID" }),
  // The dogma attributes' own records (dogma/data.py get_attribute: dogmaAttributes.fsdbinary), each with its name's
  // and its tooltip's messages, its unit, its icon, whether it is published, shown at nought and better high, and its
  // data type and default: what the compare tool shows an attribute by (comparableAttribute.py).
  // The expert systems (expertSystems/data.py ExpertSystemsDataLoader): each one's days, whether hidden or retired,
  // the skills it gives at what level, the ships it goes with.
  // Its skills are walked in the order the client's dict of them iterates (data.py ExpertSystem.skills, then
  // get_skills_to_train): innerOrder keeps the order the loader printed them in.
  expertSystems: Object.freeze({ loader: "expertSystemsLoader", resource: "res:/staticdata/expertsystems.fsdbinary", innerOrder: true }),
  // A picture's res: path by its icon number (fsdBuiltData/common/iconIDs.py GetIconFile: the icon's iconFile), which
  // an attribute is drawn with (skillsPanelUtil.AttributeCont: get_attribute_icon_id, then GetIconFile).
  iconFiles: Object.freeze({ loader: "iconIDsLoader", resource: "res:/staticdata/iconids.fsdbinary", attribute: "iconFile" }),
  dogmaAttributes: Object.freeze({ loader: "dogmaAttributesLoader", resource: "res:/staticdata/dogmaattributes.fsdbinary" }),
  // Native godma's by-name map overwrites duplicate names in loader order.
  // The walker also retains the actual None getters that dir() omits for
  // charge/cap/floor links; these are needed by the native attribute factory.
  dogmaAttributesOrdered: Object.freeze({ loader: "dogmaAttributesLoader", resource: "res:/staticdata/dogmaattributes.fsdbinary", keyOrder: true }),
  // A type's dogma attributes (dogma/data.py get_type_dogma: typeDogma.fsdbinary, its dogmaAttributes), and a type's
  // own record (evetypes: types.fsdbinary, its mass, capacity, volume and radius among them). Both too big to walk
  // whole, so read by the rows asked for only (rows(), never table()).
  typeDogma: Object.freeze({ loader: "typeDogmaLoader", resource: "res:/staticdata/typedogma.fsdbinary", rowsOnly: true }),
  // Full raw effect vectors in native OUTER loader order for static indexes;
  // preserve empty vectors and their relation order, not only warmed types.
  typeDogmaEffectsOrdered: Object.freeze({ loader: "typeDogmaLoader", resource: "res:/staticdata/typedogma.fsdbinary", attribute: "dogmaEffects", keyOrder: true }),
  // A type's materials (typematerials/data.py get_type_materials_by_id: typeMaterials.fsdbinary, its materials), which
  // inventoryUtil.GetComputedBasePrice prices a type by. Read by the rows asked for only.
  typeMaterials: Object.freeze({ loader: "typeMaterialsLoader", resource: "res:/staticdata/typematerials.fsdbinary", rowsOnly: true }),
  // A meta group's name, the number of its message (metaGroups/data.py get_name: the meta group's nameID), which the
  // assets search's metagroup keyword matches (assetSearchUtil.MatchMetagroup).
  metaGroupNameIDs: Object.freeze({ loader: "metaGroupsLoader", resource: "res:/staticdata/metagroups.fsdbinary", attribute: "nameID" }),
  types: Object.freeze({ loader: "typesLoader", resource: "res:/staticdata/types.fsdbinary", rowsOnly: true }),
  // The dogma effects' own records (dogma/data.py get_effect: dogmaEffects.fsdbinary), each with its category and its
  // modifierInfo: what the client's effect compiler makes a type's passive effects of (baseEffectCompiler
  // SetupDogmaEffects, dogma/effects/modifiers.py). Read by the rows asked for only.
  dogmaEffects: Object.freeze({ loader: "dogmaEffectsLoader", resource: "res:/staticdata/dogmaeffects.fsdbinary", rowsOnly: true }),
  dogmaEffectsOrdered: Object.freeze({ loader: "dogmaEffectsLoader", resource: "res:/staticdata/dogmaeffects.fsdbinary", keyOrder: true }),
});

// The ship tree's groups (eveCfg.LoadCfgData: fsdlite.EveStorage(data='infoBubbleElements', cache='infoBubbles.static'),
// its infoBubbleGroups), each with its name's message, its icons and more. The cache is an SQLite file of fsdlite's,
// a row of JSON for each of its tables; it is read where it is, as it is.
const INFO_BUBBLES = "res:/staticdata/infobubbles.static";

// The client's own map of each solar system's celestials and NPC stations (eveCfg.LoadSqliteDB('mapObjects'): a
// packaged client's bin:/staticdata/mapObjects.db), which GetLocationsLocalBySystem reads a system's items from.
const MAP_OBJECTS = ["tq", "bin64", "staticdata", "mapObjects.db"];

// An alpha clone's skills and their highest levels, by race (clonegrade/storage.py CloneGradeStorage:
// fsdlite.EveStorage(data='clonegrades', cache='clonegrades.static')): the same kind of cache, a record by race.
const CLONE_GRADES = "res:/staticdata/clonegrades.static";

// Each fighter type's three ability slots (fighters/storages.py TypeStorage: fsdlite.EveStorage(data=
// 'fighters/abilitiesByType', cache='fighterAbilitiesByType.static')): the same kind of cache, a record by type, each
// slot {abilityID, cooldownSeconds, charges: {chargeCount, rearmTimeSeconds}}.
const FIGHTER_ABILITIES_BY_TYPE = "res:/staticdata/fighterabilitiesbytype.static";

/** Runs the client's loader on a data file and answers what it printed. */
function runLoader({ python, binFolder, loader, dataFile, attribute = null, keys = null, timeoutMs = LOAD_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    childProcess.execFile(
      python,
      [SCRIPT, binFolder, loader, dataFile, ...(attribute ? [attribute] : []), ...(keys ? [`keys=${keys.join(",")}`] : [])],
      { timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error) {
          const said = String(stderr || "").trim().split(/\r?\n/).pop() || error.message;
          reject(new Error(`The client's ${loader} could not be run: ${said}`));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

/**
 * The client's built data, read from `clientRoot` (the folder holding `tq` and
 * `ResFiles`) a table at a time, each when first asked for.
 *
 *   available()         whether there is a client to read at all
 *   table(name)         Promise of the whole table, an object by key; or null when it cannot be read
 *   rows(name, keys)    Promise of those rows of the table, an object by key (a key it has not: null); or null when
 *                       they cannot be read. Each row read once, whoever asks; for a table too big to read whole
 *   lookup(name, key)   Promise of {available, row}: whether the table could be read, and its row or null
 *   status()            {available, python, tables: {name: {loaded, rows, error}}}
 */
// A table printed as dicts of whole-number keys, its rows each as [[key, value], ...] in the order the loader
// printed them: JSON.parse would put whole-number keys in rising order. The keys are marked so they are not whole
// numbers to it, then read back. Only for a table of numbers (no text in which such a mark could be read).
function orderedRows(printed) {
  const marked = JSON.parse(printed.replace(/"(\d+)":/g, '"#$1":'));
  const table = {};
  for (const [key, row] of Object.entries(marked)) {
    table[key.slice(1)] = row && typeof row === "object" && !Array.isArray(row)
      ? Object.entries(row).map(([inner, value]) => [Number(inner.slice(1)), value])
      : row;
  }
  return table;
}

// A table printed as a dict of whole-number keys, its rows as they are, with the order the loader printed its keys in
// kept beside them as "#order" (a key no whole number, so not moved): JSON.parse would put whole-number keys in rising
// order. Only for a table whose rows hold no whole-number keys of their own.
function keyOrdered(printed, parse = JSON.parse) {
  const marked = parse(printed.replace(/"(\d+)":/g, '"#$1":'));
  const table = {};
  const order = [];
  for (const [key, row] of Object.entries(marked)) {
    table[key.slice(1)] = row;
    order.push(Number(key.slice(1)));
  }
  table["#order"] = order;
  return table;
}

// A table printed as a dict of whole-number keys whose rows hold dicts of whole-number keys of their own: each row as
// it is, but each such dict in it as [[key, value], ...] in the order the loader printed it (JSON.parse would put
// whole-number keys in rising order). Only for a table whose text holds no "<digits>": of its own.
function innerOrdered(printed) {
  const marked = JSON.parse(printed.replace(/"(\d+)":/g, '"#$1":'));
  const unmark = (value) => {
    if (Array.isArray(value)) return value.map(unmark);
    if (!value || typeof value !== "object") return value;
    const entries = Object.entries(value);
    if (entries.length > 0 && entries.every(([key]) => /^#\d+$/.test(key))) return entries.map(([key, inner]) => [Number(key.slice(1)), unmark(inner)]);
    return Object.fromEntries(entries.map(([key, inner]) => [key, unmark(inner)]));
  };
  const table = {};
  for (const [key, row] of Object.entries(marked)) table[key.slice(1)] = unmark(row);
  return table;
}

function createClientBuiltData({
  clientRoot = null,
  python = "python",
  tables = TABLES,
  readFile = fs.readFileSync,
  run = runLoader,
  onError = () => {},
} = {}) {
  // name -> Promise of the table or null. One read for each table, whoever asks and however many at once.
  const reads = new Map();
  const state = new Map();

  const available = () => Boolean(clientRoot);

  async function read(name, keys = null) {
    const described = tables[name];
    const index = readResourceIndex(readFile(path.join(clientRoot, "tq", "resfileindex.txt"), "utf8"));
    const relative = index.get(described.resource);
    if (!relative) throw new Error(`The client's index has no ${described.resource}.`);
    const printed = await run({
      python,
      binFolder: path.join(clientRoot, "tq", "bin64"),
      loader: described.loader,
      dataFile: path.join(clientRoot, "ResFiles", relative),
      ...(described.attribute ? { attribute: described.attribute } : {}),
      ...(keys ? { keys } : {}),
    });
    // JSON.parse's source text preserves 64-bit role masks before a JS number can round them.
    const parse = described.longStrings ? (text) => JSON.parse(text, (key, value, context) => (
      typeof value === "number" && Number.isInteger(value) && !Number.isSafeInteger(value) ? context.source : value
    )) : JSON.parse;
    const table = described.keepOrder ? orderedRows(printed) : described.keyOrder ? keyOrdered(printed, parse) : described.innerOrder ? innerOrdered(printed) : parse(printed);
    if (!table || typeof table !== "object" || Array.isArray(table)) {
      throw new Error(`The client's ${described.loader} did not print a table.`);
    }
    return table;
  }

  // name -> Map of key -> Promise of the row (null where the table has no such row), or of undefined where it could
  // not be read (and the key is then let go, to be asked again).
  const rowReads = new Map();
  function rows(name, keys) {
    if (!available() || !Object.hasOwn(tables, name)) return Promise.resolve(null);
    const wanted = [...new Set(keys.map(Number))].filter((key) => Number.isSafeInteger(key) && key >= 0);
    if (!rowReads.has(name)) rowReads.set(name, new Map());
    const kept = rowReads.get(name);
    const missing = wanted.filter((key) => !kept.has(key));
    if (missing.length > 0) {
      const reading = read(name, missing).catch((error) => {
        onError(error);
        return null;
      });
      for (const key of missing) {
        kept.set(key, reading.then((found) => {
          if (!found) {
            kept.delete(key);
            return undefined;
          }
          return Object.hasOwn(found, String(key)) ? found[String(key)] : null;
        }));
      }
    }
    return Promise.all(wanted.map((key) => kept.get(key))).then((found) => (
      found.some((row) => row === undefined) ? null : Object.fromEntries(wanted.map((key, at) => [String(key), found[at]]))
    ));
  }

  function table(name) {
    if (!available() || !Object.hasOwn(tables, name) || tables[name].rowsOnly) return Promise.resolve(null);
    if (!reads.has(name)) {
      reads.set(name, read(name).then(
        (loaded) => {
          state.set(name, { loaded: true, rows: Object.keys(loaded).length, error: null });
          return loaded;
        },
        (error) => {
          // Kept: a client or a Python that is not there will not be there on the next request either.
          state.set(name, { loaded: false, rows: 0, error: String((error && error.message) || error) });
          onError(error);
          return null;
        },
      ));
    }
    return reads.get(name);
  }

  // The ship tree's groups, once (INFO_BUBBLES): {groupID: {nameID, iconSmall}}, or null where they cannot be read.
  let infoBubbleGroupsRead = null;
  function infoBubbleGroups() {
    if (!available()) return Promise.resolve(null);
    if (!infoBubbleGroupsRead) {
      infoBubbleGroupsRead = Promise.resolve().then(() => {
        const index = readResourceIndex(readFile(path.join(clientRoot, "tq", "resfileindex.txt"), "utf8"));
        const relative = index.get(INFO_BUBBLES);
        if (!relative) throw new Error(`The client's index has no ${INFO_BUBBLES}.`);
        const { DatabaseSync } = require("node:sqlite");
        const database = new DatabaseSync(path.join(clientRoot, "ResFiles", relative), { readOnly: true });
        try {
          const row = database.prepare("SELECT value FROM cache WHERE key = ?").get("infoBubbleGroups");
          const groups = row ? JSON.parse(String(row.value)) : null;
          if (!groups || typeof groups !== "object") throw new Error("The client's ship tree has no groups.");
          const out = {};
          for (const [key, value] of Object.entries(groups)) {
            if (Number(key) > 0 && value && typeof value === "object") {
              out[key] = { nameID: Number(value.nameID) || null, iconSmall: typeof value.iconSmall === "string" ? value.iconSmall : null };
            }
          }
          return out;
        } finally {
          database.close();
        }
      }).catch((error) => {
        onError(error);
        return null;
      });
    }
    return infoBubbleGroupsRead;
  }

  // The ships' traits, once (INFO_BUBBLES, its infoBubbleTypeBonuses: infobubbles.get_info_bubble_type_bonuses): by
  // ship type, its bonuses per skill ("types": {skillTypeID: [bonus]}), its role bonuses and its other bonuses, each
  // bonus {bonus, importance, nameID, unitID}; null where they cannot be read.
  let infoBubbleTypeBonusesRead = null;
  function infoBubbleTypeBonuses() {
    if (!available()) return Promise.resolve(null);
    if (!infoBubbleTypeBonusesRead) {
      infoBubbleTypeBonusesRead = Promise.resolve().then(() => {
        const index = readResourceIndex(readFile(path.join(clientRoot, "tq", "resfileindex.txt"), "utf8"));
        const relative = index.get(INFO_BUBBLES);
        if (!relative) throw new Error(`The client's index has no ${INFO_BUBBLES}.`);
        const { DatabaseSync } = require("node:sqlite");
        const database = new DatabaseSync(path.join(clientRoot, "ResFiles", relative), { readOnly: true });
        try {
          const row = database.prepare("SELECT value FROM cache WHERE key = ?").get("infoBubbleTypeBonuses");
          const bonuses = row ? JSON.parse(String(row.value)) : null;
          if (!bonuses || typeof bonuses !== "object") throw new Error("The client's ship tree has no traits.");
          return bonuses;
        } finally {
          database.close();
        }
      }).catch((error) => {
        onError(error);
        return null;
      });
    }
    return infoBubbleTypeBonusesRead;
  }

  // The ships' info bubble elements, once (INFO_BUBBLES, its infoBubbleTypeElements: eveCfg.LoadCfgData's
  // cfg.infoBubbleTypeElements, each type's 'elements'): by ship type, the element of each of its slots, in their order;
  // null where they cannot be read.
  let infoBubbleTypeElementsRead = null;
  function infoBubbleTypeElements() {
    if (!available()) return Promise.resolve(null);
    if (!infoBubbleTypeElementsRead) {
      infoBubbleTypeElementsRead = Promise.resolve().then(() => {
        const index = readResourceIndex(readFile(path.join(clientRoot, "tq", "resfileindex.txt"), "utf8"));
        const relative = index.get(INFO_BUBBLES);
        if (!relative) throw new Error(`The client's index has no ${INFO_BUBBLES}.`);
        const { DatabaseSync } = require("node:sqlite");
        const database = new DatabaseSync(path.join(clientRoot, "ResFiles", relative), { readOnly: true });
        try {
          const row = database.prepare("SELECT value FROM cache WHERE key = ?").get("infoBubbleTypeElements");
          const types = row ? JSON.parse(String(row.value)) : null;
          if (!types || typeof types !== "object") throw new Error("The client's ship tree has no type elements.");
          const out = {};
          for (const [key, value] of Object.entries(types)) {
            const elements = value && typeof value === "object" ? value.elements : null;
            if (Number(key) > 0 && elements && typeof elements === "object") {
              out[key] = Object.keys(elements).sort((a, b) => Number(a) - Number(b)).map((slot) => Number(elements[slot])).filter((id) => Number.isFinite(id));
            }
          }
          return out;
        } finally {
          database.close();
        }
      }).catch((error) => {
        onError(error);
        return null;
      });
    }
    return infoBubbleTypeElementsRead;
  }

  // The alpha clone's skills, once (CLONE_GRADES): {raceID: {skillTypeID: level}}, or null where they cannot be read.
  let cloneGradesRead = null;
  function cloneGrades() {
    if (!available()) return Promise.resolve(null);
    if (!cloneGradesRead) {
      cloneGradesRead = Promise.resolve().then(() => {
        const index = readResourceIndex(readFile(path.join(clientRoot, "tq", "resfileindex.txt"), "utf8"));
        const relative = index.get(CLONE_GRADES);
        if (!relative) throw new Error(`The client's index has no ${CLONE_GRADES}.`);
        const { DatabaseSync } = require("node:sqlite");
        const database = new DatabaseSync(path.join(clientRoot, "ResFiles", relative), { readOnly: true });
        try {
          const out = {};
          for (const row of database.prepare("SELECT key, value FROM cache").all()) {
            const grade = JSON.parse(String(row.value));
            const levels = {};
            for (const skill of Array.isArray(grade && grade.skills) ? grade.skills : []) {
              if (Number(skill.typeID) > 0) levels[String(skill.typeID)] = Number(skill.level) || 0;
            }
            if (Number(row.key) > 0) out[String(row.key)] = levels;
          }
          return out;
        } finally {
          database.close();
        }
      }).catch((error) => {
        onError(error);
        return null;
      });
    }
    return cloneGradesRead;
  }

  // The fighters' ability slots, once (FIGHTER_ABILITIES_BY_TYPE): {typeID: [slot0, slot1, slot2]}, each slot
  // {abilityID, cooldownSeconds, chargeCount, rearmTimeSeconds} or null; null where they cannot be read.
  let fighterAbilitiesRead = null;
  function fighterAbilitiesByType() {
    if (!available()) return Promise.resolve(null);
    if (!fighterAbilitiesRead) {
      fighterAbilitiesRead = Promise.resolve().then(() => {
        const index = readResourceIndex(readFile(path.join(clientRoot, "tq", "resfileindex.txt"), "utf8"));
        const relative = index.get(FIGHTER_ABILITIES_BY_TYPE);
        if (!relative) throw new Error(`The client's index has no ${FIGHTER_ABILITIES_BY_TYPE}.`);
        const { DatabaseSync } = require("node:sqlite");
        const database = new DatabaseSync(path.join(clientRoot, "ResFiles", relative), { readOnly: true });
        try {
          const number = (value) => (Number.isFinite(Number(value)) && value !== null && value !== undefined ? Number(value) : null);
          const slot = (value) => (value && typeof value === "object" && Number(value.abilityID) > 0
            ? {
                abilityID: Number(value.abilityID),
                cooldownSeconds: number(value.cooldownSeconds),
                chargeCount: number(value.charges && value.charges.chargeCount),
                rearmTimeSeconds: number(value.charges && value.charges.rearmTimeSeconds),
              }
            : null);
          const out = {};
          for (const row of database.prepare("SELECT key, value FROM cache").all()) {
            const record = JSON.parse(String(row.value));
            if (Number(row.key) > 0 && record && typeof record === "object") {
              out[String(row.key)] = [slot(record.abilitySlot0), slot(record.abilitySlot1), slot(record.abilitySlot2)];
            }
          }
          return out;
        } finally {
          database.close();
        }
      }).catch((error) => {
        onError(error);
        return null;
      });
    }
    return fighterAbilitiesRead;
  }

  /**
   * A solar system's items as eveCfg.GetLocationsLocalBySystem reads them (778 to 860): each celestial's row (its
   * celestialID, celestialNameID, typeID, groupID, orbitID, celestialIndex, orbitIndex) and each NPC station's (its
   * stationID, typeID, orbitID, celestialIndex, orbitIndex), from the client's own map database. Null where the
   * client cannot be read.
   */
  function systemObjects(solarSystemID) {
    if (!available()) return null;
    const { DatabaseSync } = require("node:sqlite");
    const database = new DatabaseSync(path.join(clientRoot, ...MAP_OBJECTS), { readOnly: true });
    try {
      const plain = (row) => ({ ...row });
      return {
        celestials: database
          .prepare("SELECT celestialID, celestialNameID, typeID, groupID, orbitID, orbitIndex, celestialIndex FROM celestials WHERE solarSystemID = ?")
          .all(solarSystemID)
          .map(plain),
        stations: database
          .prepare("SELECT stationID, typeID, orbitID, orbitIndex, celestialIndex FROM npcStations WHERE solarSystemID = ?")
          .all(solarSystemID)
          .map(plain),
      };
    } finally {
      database.close();
    }
  }

  return {
    available,
    table,
    rows,
    systemObjects,
    infoBubbleGroups,
    infoBubbleTypeBonuses,
    infoBubbleTypeElements,
    cloneGrades,
    fighterAbilitiesByType,
    async lookup(name, key) {
      const loaded = await table(name);
      if (!loaded) return { available: false, row: null };
      const row = Object.hasOwn(loaded, String(key)) ? loaded[String(key)] : null;
      return { available: true, row };
    },
    status() {
      const out = {};
      for (const name of Object.keys(tables)) {
        out[name] = state.get(name) || { loaded: false, rows: 0, error: null };
      }
      return { available: available(), python, tables: out };
    },
  };
}

module.exports = { createClientBuiltData, runLoader, TABLES };
