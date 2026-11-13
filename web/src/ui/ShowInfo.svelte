<script lang="ts">
  // THE SHOW INFO WINDOW (goal R76) — what this thing is, from everything the
  // client already knows about it.
  //
  // ⚠ IT NEVER INVENTS A SECTION. Each block below is drawn only when its source
  // actually answered: a rock that has left the grid loses its distance rather
  // than keeping a stale one, a module we have no dogma read for shows no
  // attribute table rather than an empty one, and a type the name cache has not
  // resolved says so instead of printing an id (R7d).
  //
  // That discipline is why the window is worth having. EVE's Show Info is
  // trusted precisely because every figure in it is real; one fabricated zero
  // would make a player check every other number by hand.
  import { onMount } from "svelte";
  import TypeIcon from "./TypeIcon.svelte";
  import CorpLogo from "./CorpLogo.svelte";
  import InfoFreelanceProjects from "./InfoFreelanceProjects.svelte";
  import BookmarkWindow from "./BookmarkWindow.svelte";
  import type { BookmarkPlace } from "../bridge/locationsList.ts";
  import type { MapRouteStep } from "../app/flow.ts";
  import type { ContactStandings, NpcNpcStanding } from "../bridge/standingsReads.ts";
  import { applyStandingBonus, standingBonusSkill } from "../bridge/effectiveStanding.ts";
  import { showInfo, subjectTypeID, type InfoSubject } from "./showInfo.ts";
  import { createSignal, type ReadableSignal } from "../store/signals.ts";
  import { LINK_WORDS, linkFollowerOf, startLinkDrag } from "./linkFollowers.ts";
  import { formatIsk } from "./isk.ts";
  import { clientTexture } from "./skillGroupIcons.ts";
  import { allianceLogoUrl, portraitDefaultPath, portraitUrl } from "./ownerImages.ts";
  import OwnerPicture from "./OwnerPicture.svelte";
  import { DATE_LABELS, formatTemplate, plainText, type FormatContext } from "../bridge/clientWords.ts";
  import { INTERVAL_WORD_LABELS, dateTimeIntervalWritten } from "../bridge/timeInterval.ts";
  import type { CharacterInfoHeader } from "../bridge/characterInfo.ts";
  import { mailBodyLines } from "../bridge/mailMarkup.ts";
  import {
    OWNER_INFO_WORDS,
    friendlyFireAt,
    friendlyFireLabel,
    isCharacterOwner,
    isNpcCorporation,
    warPermitLabel,
    type CorporationInfoRead,
  } from "../bridge/ownerInfo.ts";
  import type { AllianceInfoExtra } from "../bridge/allianceInfo.ts";
  import type { JsonValue } from "../bridge/wire.ts";
  import { moduleEffectiveStats } from "../bridge/moduleAttributes.ts";
  import { securityStatusColor, shownSecurity } from "../bridge/systemSecurity.ts";
  import type { FactionInfo, FactionPlaceRow, MapLocationInfo, MapPlaceRow, SystemObjectRow } from "../app/api.ts";
  import { fmtDist, hostileLabel, isHostile, ratioPercent, surfaceDistanceMeters } from "../space/overview.ts";
  import { distanceSay } from "../space/distanceWords.ts";
  import { spaceSelection } from "../space/selection.ts";
  import { resolvedName, type NameKind, type NameRef } from "../store/names.ts";
  import { abbreviate } from "./fittingIcons.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";
  import type { AgentRow, SpaceEntity } from "../store/types.ts";

  let { store: pilotStore, flow: pilotFlow, subject: windowSubject, corporationResult: windowCorporationResult }: { store: ClientStore; flow: AppFlow; subject: ReadableSignal<InfoSubject | null>; corporationResult?: ReadableSignal<CorporationInfoRead | null | undefined> | null } = $props();
  // A component belongs to one native window for its lifetime. Capture these
  // handles so chrome/focus changes cannot become dependencies of its reads.
  // The captured subject signal itself changes only on reconstruction.
  // svelte-ignore state_referenced_locally
  const store = pilotStore;
  // svelte-ignore state_referenced_locally
  const flow = pilotFlow;
  // svelte-ignore state_referenced_locally
  const subject = windowSubject;
  // svelte-ignore state_referenced_locally
  const corporationResult = windowCorporationResult ?? createSignal<CorporationInfoRead | null | undefined>(undefined);

  // svelte-ignore state_referenced_locally
  const space = store.space;
  // svelte-ignore state_referenced_locally
  const fitting = store.fitting;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  // svelte-ignore state_referenced_locally
  const standings = store.standings;
  // svelte-ignore state_referenced_locally
  const corporationFactions = flow.corporationFactions;
  // svelte-ignore state_referenced_locally
  const ownerLogos = flow.ownerLogos;
  // svelte-ignore state_referenced_locally
  const corpLogoLibrary = flow.corpLogoLibrary;
  // svelte-ignore state_referenced_locally
  const imageServer = flow.imageServer;
  // svelte-ignore state_referenced_locally
  const corpLogos = flow.corpLogos;
  /** A player corporation's logo (eveIcon.CorpIcon), where it has any shape and the library is had; else null. */
  const playerCorpLogo = $derived.by(() => {
    const current = $subject;
    if (current?.kind !== "corporation" || isNpcCorporation(current.corporationID) || $corpLogoLibrary === null) return null;
    const logo = $corpLogos[String(current.corporationID)] ?? null;
    return logo !== null && logo.shapes.some((shape) => shape !== null) ? { library: $corpLogoLibrary, logo } : null;
  });
  $effect(() => {
    const current = $subject;
    if (current?.kind === "corporation" && !isNpcCorporation(current.corporationID)) flow.requestCorpLogos([current.corporationID]);
  });
  /**
   * eveIcon.GetLogoIcon for an owner the client's own tables draw (LogoIcon): a faction's (GetFactionIconID) or an NPC
   * corporation's (CORP_ICONS), as its texture's address; null for any other.
   */
  /** characterInfoWindow.update_window_icon: photo.GetPortrait(item_id, 256), the client's silhouette behind it. */
  const characterPortraitUrls = $derived.by<readonly string[]>(() => {
    const current = $subject;
    if (current?.kind !== "character") return [];
    const portrait = portraitUrl($imageServer, current.characterID, 256);
    return portrait === null ? [] : [portrait, clientTexture(portraitDefaultPath(256))];
  });
  function ownerLogoUrl(id: number | null): string | null {
    if (id === null) return null;
    // GetLogoIcon and GetOwnerLogo for an alliance: photo.GetAllianceLogo, the image server's picture.
    if (ownerKindOf(id) === "alliance") return allianceLogoUrl($imageServer, id);
    const resPath = $ownerLogos?.factions[String(id)] ?? $ownerLogos?.corporations[String(id)];
    return resPath ? clientTexture(resPath) : null;
  }
  // svelte-ignore state_referenced_locally
  const station = store.station;
  // svelte-ignore state_referenced_locally
  const skills = store.skills;

  const typeID = $derived(subjectTypeID($subject));

  /** The live snapshot row for a space subject, or null once it has left grid. */
  const entity = $derived.by<SpaceEntity | null>(() => {
    const current = $subject;
    if (current === null || current.kind !== "spaceObject") {
      return null;
    }
    return (
      ($space.snapshot?.entities ?? []).find((row) => row.itemID === current.itemID) ?? null
    );
  });

  /** The fitted module for a module subject, from the same fit the window shows. */
  const fittedModule = $derived.by(() => {
    const current = $subject;
    if (current === null || current.kind !== "module") {
      return null;
    }
    for (const slot of $fitting.slots) {
      if (slot.module && slot.module.itemID === current.itemID) {
        return slot.module;
      }
    }
    return null;
  });

  /**
   * The SERVER's post-dogma attributes for that module — skills, hull bonuses
   * and in-space effects already applied. This is the only place in the client
   * where a module's real numbers exist; the static SDE values would be a
   * different (and wrong) claim.
   *
   * The snapshot keeps the ship and its fitted items in `ships`, each item's ID
   * as the wire gave it (a number or a string), and a loaded charge beside its
   * module under the same slot with a `sublocation`, so the module is the entry
   * with this ID and no sublocation. (This read `dogma.items`, which the
   * snapshot never had, so the section always said there was no reading.)
   */
  const moduleStats = $derived.by(() => {
    const current = $subject;
    if (current === null || current.kind !== "module") {
      return [];
    }
    const entry = $fitting.dogma?.ships.find(
      (item) => Number(item.itemID) === current.itemID && item.sublocation == null,
    );
    return moduleEffectiveStats(entry?.attributes);
  });

  /**
   * The kind a character's name is kept under: an agent's (the NPC characters' numbers, 3000000 to 3999999) as an
   * agent's, as the People & Places window asks for it, and a pilot's as a character's.
   */
  const characterNameKind = (characterID: number): "agent" | "character" =>
    (characterID >= 3_000_000 && characterID < 4_000_000 ? "agent" : "character");

  const title = $derived.by(() => {
    const current = $subject;
    if (current === null) {
      return "Show Info";
    }
    if (current.kind === "character") {
      // Its own kind's name, else the owner table's (cfg.eveowners: an NPC character that is no agent, a CEO).
      const own = resolvedName($names.resolved, characterNameKind(current.characterID), current.characterID, "");
      return own !== "" ? own : resolvedName($names.resolved, "owner", current.characterID, "Unknown pilot");
    }
    // A map place's own name (cfg.evelocations), its type's while it is not read.
    if (current.kind === "mapLocation") {
      return mapLocationRead?.name || mapTypeName(current.typeID);
    }
    // A faction's name (cfg.eveowners).
    if (current.kind === "faction") {
      return factionRead?.name || resolvedName($names.resolved, "faction", current.factionID, "Unknown faction");
    }
    // update_description_caption_and_sub_caption: the owner's name, "[Closed]" before it where it is no more.
    if (current.kind === "corporation" || current.kind === "alliance") {
      const name = current.kind === "corporation"
        ? resolvedName($names.resolved, "corporation", current.corporationID, "Unknown corporation")
        : resolvedName($names.resolved, "alliance", current.allianceID, "Unknown alliance");
      const deleted = current.kind === "corporation" ? corporationRead?.info.deleted === true : allianceRead?.deleted === true;
      return deleted ? word("UI/InfoWindow/ClosedCorpOrAllianceCaption", { corpOrAllianceName: name }) : name;
    }
    // A space object's own name beats its type name — "Asteroid Belt 1" is more
    // use than "Asteroid Belt".
    const own = entity?.name;
    if (typeof own === "string" && own.length > 0) {
      return own;
    }
    return resolvedName($names.resolved, "type", typeID, "Unknown object");
  });

  const groupName = $derived(
    entity?.groupID != null
      ? resolvedName($names.resolved, "typeGroup", entity.groupID, "")
      : "",
  );
  const categoryName = $derived(
    entity?.categoryID != null
      ? resolvedName($names.resolved, "typeCategory", entity.categoryID, "")
      : "",
  );
  /** The type's own name, shown under a space object that has its own name. */
  const typeName = $derived(resolvedName($names.resolved, "type", typeID, ""));

  const shipPosition = $derived($space.snapshot?.ship?.position ?? null);
  // Hull to hull, as the client's selected item gives it, and worded as it words it (FmtDist, one decimal).
  const distance = $derived(
    entity && shipPosition
      ? surfaceDistanceMeters(shipPosition, $space.snapshot?.ship?.radius ?? 0, entity.position, entity.radius)
      : null,
  );
  // svelte-ignore state_referenced_locally
  const words = store.words;
  const say = $derived(distanceSay($words.templates));
  const speed = $derived.by(() => {
    if (!entity) {
      return null;
    }
    const { x, y, z } = entity.velocity;
    const value = Math.sqrt(x * x + y * y + z * z);
    return Number.isFinite(value) ? value : null;
  });

  const condition = $derived(
    entity
      ? [
          { label: "Shield", pct: ratioPercent(entity.shieldRatio) },
          { label: "Armor", pct: ratioPercent(entity.armorRatio) },
          { label: "Hull", pct: ratioPercent(entity.hullRatio) },
        ].filter((row) => row.pct !== null)
      : [],
  );


  // ---- A corporation and an alliance (bridge/ownerInfo.ts) ---------------------------------------------------------
  //
  // What the client's window reads of the owner, read again each time the subject changes (reconstruct_info_window
  // reads it on every opening). Nothing is shown of a record not had.

  let corporationRead = $state<CorporationInfoRead | null>(null);
  /** A map place's read (infosvc.UpdateDataCelestial for a region, a constellation or a solar system). */
  let mapLocationRead = $state<MapLocationInfo | null>(null);
  /** A faction's read (infosvc.UpdateDataFaction). */
  let factionRead = $state<FactionInfo | null>(null);
  let allianceRead = $state<AllianceInfoExtra | null>(null);
  /** Whether the owner's read has answered, so a record not had is said rather than waited for. */
  let ownerReadDone = $state(false);
  /** The latest read asked; an older one's answer is dropped. Not reactive. */
  let ownerReads = 0;

  $effect(() => {
    const current = $subject;
    const ticket = ++ownerReads;
    corporationRead = null;
    allianceRead = null;
    mapLocationRead = null;
    npcNpcStandingsRead = null;
    systemObjectsRead = null;
    mapRouteRead = null;
    bookmarking = null;
    factionRead = null;
    ownerReadDone = false;
    if (current?.kind === "corporation") {
      // construct_header's faction (get_corporation_faction_id), from the client's table of NPC corporations.
      flow.loadCorporationFactions();
    } else if (current?.kind === "alliance") {
      void flow.allianceShowInfo(current.allianceID).then((read) => {
        if (ticket !== ownerReads) return;
        allianceRead = read;
        ownerReadDone = true;
      });
    } else if (current?.kind === "mapLocation") {
      void flow.mapLocationShowInfo(current.itemID).then((read) => {
        if (ticket !== ownerReads) return;
        mapLocationRead = read;
        ownerReadDone = true;
      });
      // A solar system's Orbital Bodies and Stations (GetOrbitalBodies, GetStationTab), from the client's own map.
      if (current.typeID === 5) {
        void flow.mapSystemObjects(current.itemID).then(
          (read) => {
            if (ticket === ownerReads) systemObjectsRead = read.available ? read.objects : null;
          },
          () => {},
        );
      }
      // A constellation's or a solar system's Route (ShortestGeneralPath from where the pilot is).
      if (current.typeID === 4 || current.typeID === 5) {
        void flow.mapLocationRoute(current.itemID).then(
          (route) => {
            if (ticket === ownerReads) mapRouteRead = route;
          },
          () => {},
        );
      }
    } else if (current?.kind === "faction") {
      // The Standings tab (panelStandings): the faction's standings with the others, kept by the standing service.
      void flow.npcNpcStandings().then(
        (rows) => {
          if (ticket === ownerReads) npcNpcStandingsRead = rows;
        },
        () => {},
      );
      void flow.factionShowInfo(current.factionID).then((read) => {
        if (ticket !== ownerReads) return;
        factionRead = read;
        ownerReadDone = true;
      });
    }
  });

  $effect(() => {
    if ($subject?.kind !== "corporation") return;
    const result = $corporationResult;
    corporationRead = result ?? null;
    ownerReadDone = result !== undefined;
  });

  onMount(() => {
    // eveIcon.LogoIcon's tables, for the owners' logos.
    flow.loadOwnerLogos();
    flow.loadImageServer();
    // A character's header: its labels, and the written interval's for Member For.
    flow.requestWords([...Object.keys(CHARACTER_HEADER_WORDS), ...INTERVAL_WORD_LABELS]);
    flow.requestWords([...Object.keys(OWNER_INFO_WORDS), DATE_LABELS.ls!, DATE_LABELS.ns!, DATE_LABELS.xn!, ...Object.keys(LINK_WORDS), ...Object.keys(MAP_INFO_WORDS), ...Object.keys(FACTION_INFO_WORDS)]);
    // The map places' type names (evetypes.GetName of typeRegion, typeConstellation, typeSolarSystem).
    flow.requestNames([3, 4, 5].map((id) => ({ kind: "type" as const, id })));
  });

  /** The map places' labels the window uses, with the page's own words where the install's are not had. */
  const MAP_INFO_WORDS: Readonly<Record<string, string>> = {
    "UI/InfoWindow/AdjacentConstellations": "Constellations next to it",
    "UI/InfoWindow/AdjacentRegions": "Regions next to it",
    "UI/InfoWindow/AdjacentSolarSystem": "Systems next to it",
    "UI/InfoWindow/RelatedConstellation": "Its constellations",
    "UI/InfoWindow/RelatedSolarSystem": "Its systems",
    "UI/Neocom/SecurityLevel": "Security",
    "UI/InfoWindow/TabNames/OrbitalBodies": "What orbits here",
    "UI/Common/LocationTypes/Stations": "Stations",
    "UI/InfoWindow/TabNames/Route": "The way there",
    "UI/Market/MarketQuote/NumberOfJumps": "{[numeric]num} {[numeric]num -> \"jump\", \"jumps\"}",
    "UI/InfoWindow/RegularJump": "{[numeric]numJumps, decimalPlaces=0}.",
    "UI/InfoWindow/RegionJump": "{[numeric]numJumps, decimalPlaces=0}. into a new region",
    "UI/InfoWindow/ConstellationJump": "{[numeric]numJumps, decimalPlaces=0}. into a new constellation",
    "UI/Inflight/BookmarkLocation": "Save this place",
    "UI/PeopleAndPlaces/NewBookmarkLocationLabel": "{[location] loc.name} ( {group} )",
    "UI/Locations/LocationAsteroidBeltFormatter": "{[location]solarSystemID.rawName} {romanCelestialIndex}, {[item]typeID.rawName} {orbitIndex}",
    "UI/Locations/LocationMoonFormatter": "{[location]solarSystemID.rawName} {romanCelestialIndex}, moon {orbitIndex}",
    "UI/Locations/LocationPlanetFormatter": "{[location]solarSystemID.rawName} {romanCelestialIndex}",
    "UI/Locations/LocationStargateFormatter": "Gate to {[location]destinationSystemID.rawName}",
    "UI/Locations/LocationStarFormatter": "{[location]solarSystemID.rawName}'s star",
  };
  /** infosvc's neighborGrouping and childGrouping: the two lists' names, by the place's type. */
  const NEIGHBOUR_LABELS: Readonly<Record<number, string>> = {
    3: "UI/InfoWindow/AdjacentRegions",
    4: "UI/InfoWindow/AdjacentConstellations",
    5: "UI/InfoWindow/AdjacentSolarSystem",
  };
  const CHILD_LABELS: Readonly<Record<number, string>> = {
    3: "UI/InfoWindow/RelatedConstellation",
    4: "UI/InfoWindow/RelatedSolarSystem",
  };
  const MAP_TYPE_NAMES: Readonly<Record<number, string>> = { 3: "Region", 4: "Constellation", 5: "Solar system" };
  /** A map place's type name (evetypes.GetName), the page's own while it is not read. */
  const mapTypeName = (typeID: number): string => resolvedName($names.resolved, "type", typeID, MAP_TYPE_NAMES[typeID] ?? "");
  // SortListOfTuples (carbonui sortUtil, as infosvc imports it): Python's sort on the keys as they are, a string by its
  // code points and a list by its first unequal part.
  const byCodePoints = (a: readonly string[], b: readonly string[]): number => {
    for (let at = 0; at < Math.min(a.length, b.length); at += 1) {
      if (a[at]! !== b[at]!) return a[at]! < b[at]! ? -1 : 1;
    }
    return a.length - b.length;
  };
  const byPlaceName = (a: MapPlaceRow, b: MapPlaceRow): number => byCodePoints([a.name], [b.name]);
  const placeSubject = (place: MapPlaceRow): InfoSubject => ({ kind: "mapLocation", typeID: place.typeID, itemID: place.itemID });

  /** The NPCs' standings with each other (the standing service's npcnpcstandingsfrom), once read. */
  let npcNpcStandingsRead = $state<readonly NpcNpcStanding[] | null>(null);
  /** The owner kinds by number (idCheckers): a faction, a corporation (an NPC's or a player's), an alliance, an agent, else a character. */
  function ownerKindOf(id: number): NameKind {
    if (id >= 500_000 && id < 600_000) return "faction";
    if ((id >= 1_000_000 && id < 2_000_000) || (id >= 98_000_000 && id < 99_000_000)) return "corporation";
    if (id >= 99_000_000 && id < 100_000_000) return "alliance";
    if (id >= 3_000_000 && id < 4_000_000) return "agent";
    return "owner";
  }
  /** idCheckers.IsNPC: an owner of the game's own (above the system's items, below the players'). */
  const isNpcOwner = (id: number): boolean => id > 10_000 && id < 90_000_000;
  /** An owner's name as the Standings tab names it (cfg.eveowners; the pilot by the name it came online with). */
  function ownerName(id: number): string {
    const online = $station.online;
    return resolvedName($names.resolved, ownerKindOf(id), id, online?.characterID === id ? online.characterName : "");
  }

  /** An NPC corporation's headquarters (get_corporation_headquarters), once read. */
  let npcHeadquartersRead = $state<{ readonly itemID: number; readonly typeID: number } | null>(null);
  /** The latest headquarters reading asked; an older one's answer is dropped. Not reactive. */
  let headquartersReads = 0;
  $effect(() => {
    const current = $subject;
    const ticket = ++headquartersReads;
    npcHeadquartersRead = null;
    if (current?.kind !== "corporation" || !isNpcCorporation(current.corporationID)) return;
    void flow.npcCorporationHeadquarters(current.corporationID).then((hq) => {
      if (ticket === headquartersReads) npcHeadquartersRead = hq;
    });
  });
  /** The headquarters' name: a station's, else a system's. */
  const npcHeadquartersName = $derived(
    npcHeadquartersRead === null
      ? ""
      : resolvedName($names.resolved, npcHeadquartersRead.typeID === 5 ? "system" : "station", npcHeadquartersRead.itemID, ""),
  );
  $effect(() => {
    const hq = npcHeadquartersRead;
    if (hq !== null) flow.requestNames([{ kind: hq.typeID === 5 ? "system" : "station", id: hq.itemID }]);
  });

  /** A character's header (construct_header_character), for one that is no NPC; once read. */
  let characterHeaderRead = $state<CharacterInfoHeader | null>(null);
  /** The latest header reading asked; an older one's answer is dropped. Not reactive. */
  let characterHeaderReads = 0;
  $effect(() => {
    const current = $subject;
    const ticket = ++characterHeaderReads;
    characterHeaderRead = null;
    if (current?.kind !== "character" || isNpcOwner(current.characterID)) return;
    void flow.characterInfoHeader(current.characterID).then(
      (read) => {
        if (ticket === characterHeaderReads) characterHeaderRead = read;
      },
      () => {},
    );
  });
  /** The header's corporation: a pilot's (GetInfoWindowDataForChar's corpID), an agent's (its row's), another NPC's (its own). */
  const characterCorporationID = $derived.by<number | null>(() => {
    const current = $subject;
    if (current?.kind !== "character") return null;
    if (!isNpcOwner(current.characterID)) return characterHeaderRead?.corporationID ?? null;
    return agentRead?.agent ? agentRead.agent.corporationID : npcCorporationRead;
  });
  $effect(() => {
    const corporationID = characterCorporationID;
    if (corporationID === null) return;
    flow.requestNames([{ kind: "corporation", id: corporationID }]);
    if (!isNpcCorporation(corporationID)) flow.requestCorpLogos([corporationID]);
  });
  $effect(() => {
    const read = characterHeaderRead;
    if (read === null) return;
    const refs: NameRef[] = [];
    if (read.allianceID !== null) refs.push({ kind: "alliance", id: read.allianceID });
    if (read.militiaFactionID !== null) refs.push({ kind: "faction", id: read.militiaFactionID });
    if (refs.length > 0) flow.requestNames(refs);
  });
  /**
   * An NPC character that is no agent (a CEO): its bloodline by GetPublicInfo3 (update_description_caption_and_sub_caption
   * 194) and its corporation by corpmgr.GetCorporationIDForCharacter (construct_header_character 111); once read.
   */
  let npcBloodlineRead = $state<{ readonly bloodlineID: number | null } | null>(null);
  let npcCorporationRead = $state<number | null>(null);
  /** The latest such reading asked; an older one's answers are dropped. Not reactive. */
  let npcBloodlineReads = 0;
  $effect(() => {
    const current = $subject;
    const read = agentRead;
    const ticket = ++npcBloodlineReads;
    npcBloodlineRead = null;
    npcCorporationRead = null;
    if (current?.kind !== "character" || !isNpcOwner(current.characterID) || read === null || read.agent !== null) return;
    void flow.characterBloodline(current.characterID).then(
      (bloodlineID) => {
        if (ticket === npcBloodlineReads) npcBloodlineRead = { bloodlineID };
      },
      () => {
        if (ticket === npcBloodlineReads) npcBloodlineRead = { bloodlineID: null };
      },
    );
    void flow.npcCharacterCorporation(current.characterID).then(
      (corporationID) => {
        if (ticket === npcBloodlineReads) npcCorporationRead = corporationID;
      },
      () => {},
    );
  });
  /**
   * The bloodline the window's Description is (update_description_caption_and_sub_caption, 185 to 199): an agent's by
   * its row of the agents' table, any other character's by GetPublicInfo3's; null while that is not read.
   */
  const characterBloodline = $derived.by<{ readonly bloodlineID: number | null } | null>(() => {
    const current = $subject;
    if (current?.kind !== "character") return null;
    if (!isNpcOwner(current.characterID)) return characterHeaderRead === null ? null : { bloodlineID: characterHeaderRead.bloodlineID };
    const read = agentRead;
    if (read === null) return null;
    return read.agent !== null ? { bloodlineID: read.agent.bloodlineID ?? null } : npcBloodlineRead;
  });
  /** The bloodline's description message (get_bloodline_description), once known; its number null where it has none. */
  let bloodlineDescriptionRead = $state<{ readonly messageID: number | null } | null>(null);
  /** The latest description reading asked; an older one's answer is dropped. Not reactive. */
  let bloodlineDescriptionReads = 0;
  $effect(() => {
    const known = characterBloodline;
    const ticket = ++bloodlineDescriptionReads;
    bloodlineDescriptionRead = null;
    if (known === null) return;
    if (known.bloodlineID === null) {
      bloodlineDescriptionRead = { messageID: null };
      return;
    }
    void flow.bloodlineDescriptionID(known.bloodlineID).then(
      (messageID) => {
        if (ticket !== bloodlineDescriptionReads) return;
        bloodlineDescriptionRead = { messageID };
        if (messageID !== null) flow.requestWords([`#${messageID}`]);
      },
      () => {
        if (ticket === bloodlineDescriptionReads) bloodlineDescriptionRead = { messageID: null };
      },
    );
  });
  /**
   * The Description tab's text (apply_description_caption_and_sub_caption: desc or capt): the bloodline's description,
   * else the window's caption; null while either is being read.
   */
  const characterDescription = $derived.by<string | null>(() => {
    const read = bloodlineDescriptionRead;
    if (read === null) return null;
    if (read.messageID !== null) {
      const text = $words.templates[`#${read.messageID}`];
      if (text === undefined) return null;
      if (typeof text === "string" && text !== "") return text;
    }
    return title;
  });

  /** MemberFor's time: FmtDateTimeInterval(startDateTime, now, 'day'), the calendar's years, months and days. */
  const memberForText = $derived.by(() => {
    const started = characterHeaderRead?.startDateTime ?? null;
    if (started === null) return null;
    const now = BigInt(Date.now()) * 10_000n + 116_444_736_000_000_000n;
    const written = dateTimeIntervalWritten(started, now, "day", $words.templates);
    return written === null ? null : word("UI/InfoWindow/MemberFor", { timePeriod: written });
  });
  /** CorpStandingOfCharacter: standingsvc.GetStanding(session.corpid, the character): a player corporation's contact's, else neutral. */
  const corporationStandingOfCharacter = $derived.by(() => {
    const current = $subject;
    if (current?.kind !== "character" || isNpcOwner(current.characterID) || contactStandingsRead === null) return null;
    const myCorporationID = $station.online?.corporationID ?? null;
    return myCorporationID !== null && !isNpcOwner(myCorporationID) ? (contactStandingsRead.corporate.get(current.characterID) ?? 0) : 0;
  });

  /** A player owner's Standings tab: the address book's standings, and the owners the tab's sections are toward. */
  let contactStandingsRead = $state<ContactStandings | null>(null);
  let standingTargetsRead = $state<readonly number[] | null>(null);
  /** An NPC character's row in the table of agents ({ agent: null } for one that is no agent), once read. */
  let agentRead = $state<{ readonly agent: AgentRow | null } | null>(null);
  /** The latest Standings tab reading asked; an older one's answers are dropped. Not reactive. */
  let standingReads = 0;
  // The Standings tab's reads (PanelStandings.GetStandingsDataSections), each where the tab is the owner's: an NPC
  // owner's the pilot's standings and the three standing skills (and an NPC character's agent row); a player
  // owner's the address book's contacts and the owners its sections are toward (GetToIDsForPlayerOwner).
  $effect(() => {
    const current = $subject;
    const ticket = ++standingReads;
    contactStandingsRead = null;
    standingTargetsRead = null;
    agentRead = null;
    if (current === null || current.kind === "type" || current.kind === "module" || current.kind === "spaceObject" || current.kind === "mapLocation") return;
    const npcOwner = current.kind === "faction" || (current.kind === "corporation" && isNpcCorporation(current.corporationID)) || (current.kind === "character" && isNpcOwner(current.characterID));
    if (npcOwner) {
      if (store.standings.get().char === null && store.standings.get().charError === null) void flow.loadStandings().catch(() => {});
      if (store.skills.get().skills === null) void flow.loadSkills().catch(() => {});
      if (current.kind === "character") {
        void flow.agentRecord(current.characterID).then(
          (agent) => {
            if (ticket === standingReads) agentRead = { agent };
          },
          () => {
            if (ticket === standingReads) agentRead = { agent: null };
          },
        );
      }
      return;
    }
    // The address book's standings, which the header's corporation standing reads too (the pilot's own window's as
    // well, which has no Standings tab: infosvc 1143).
    void flow.contactStandings().then(
      (read) => {
        if (ticket === standingReads) contactStandingsRead = read;
      },
      () => {},
    );
    if (current.kind === "character" && current.characterID === store.station.get().online?.characterID) return;
    const allianceOf = (corporationID: number): Promise<number | null> => flow.corporationAlliance(corporationID).catch(() => null);
    void (async (): Promise<readonly number[]> => {
      if (current.kind === "alliance") return [current.allianceID];
      if (current.kind === "corporation") {
        const allianceID = await allianceOf(current.corporationID);
        return allianceID === null ? [current.corporationID] : [current.corporationID, allianceID];
      }
      // A character: it, its corporation where that is a player's, and that corporation's alliance.
      const characterID = current.kind === "character" ? current.characterID : 0;
      const corporationID = await flow.characterCorporation(characterID).catch(() => null);
      if (corporationID === null || isNpcOwner(corporationID)) return [characterID];
      const allianceID = await allianceOf(corporationID);
      return allianceID === null ? [characterID, corporationID] : [characterID, corporationID, allianceID];
    })().then((targets) => {
      if (ticket === standingReads) standingTargetsRead = targets;
    });
  });

  /** StandingData._GetStandingFormatted: 10 from 9.995, else rounded to two places, written as Python writes a float. */
  function standingText(value: number): string {
    const rounded = value >= 9.995 ? 10 : (Math.sign(value) * Math.round(Math.abs(value) * 100)) / 100;
    return Number.isInteger(rounded) ? rounded.toFixed(1) : String(rounded);
  }
  /**
   * standingsvc.GetStanding toward the pilot (npccharstandings, else contactNeutralStanding), with the skill's bonus
   * StandingData._GetStandingWithBonus gives one toward the pilot (standingUtil.GetStandingBonus: the owner's faction's
   * skill, 0.4 a level).
   */
  function standingTowardMe(fromID: number, factionOf: number | null): number {
    const raw = ($standings.char ?? []).find((row) => row.fromID === fromID)?.standing ?? 0;
    const skill = standingBonusSkill(factionOf, raw);
    const level = skill === null ? 0 : ($skills.skills ?? []).find((each) => each.typeID === skill)?.level ?? 0;
    return applyStandingBonus(level * 0.4, raw);
  }
  /** standingsvc.GetStanding between two NPCs (npcnpcstandingsfrom), else contactNeutralStanding. */
  const npcStanding = (fromID: number, toID: number): number =>
    (npcNpcStandingsRead ?? []).find((row) => row.fromID === fromID && row.toID === toID)?.standing ?? 0;
  interface StandingSection {
    readonly key: string;
    readonly owner: string;
    readonly rows: readonly { readonly key: number; readonly name: string; readonly values: readonly string[] }[];
  }
  /**
   * PanelStandings.GetStandingsDataSections. An NPC owner's (GetStandingsDataSectionsNPC): the owner's standings
   * toward the pilot, with its corporation's and faction's for a corporation or an agent; a faction's also with every
   * other faction, both ways (Unknown left out). A player owner's (GetStandingsDataSectionsPlayerOwner): the pilot's,
   * its player corporation's and its alliance's standings (their contacts') toward the owner, and toward a
   * character's corporation and alliance. Each section's header is a bar with no words (StandingsSection.
   * ConstructHeader); the owner the section shares is named where the client shows its picture.
   */
  const ownerStandingSections = $derived.by<readonly StandingSection[]>(() => {
    const current = $subject;
    const online = $station.online;
    const myID = online?.characterID ?? null;
    if (current === null || myID === null) return [];
    const towardMe = (fromIDs: readonly number[], factionID: number | null): StandingSection => ({
      key: "me",
      owner: ownerName(myID),
      rows: fromIDs.map((id) => ({ key: id, name: ownerName(id), values: [standingText(standingTowardMe(id, factionID))] })),
    });
    if (current.kind === "faction") {
      const read = factionRead;
      if (read === null || $standings.char === null) return [];
      const sections: StandingSection[] = [towardMe([read.factionID], read.factionID)];
      if (npcNpcStandingsRead !== null) {
        sections.push({
          key: "factions",
          owner: read.name,
          rows: read.factions
            .filter((other) => other.factionID !== 500021 && other.factionID !== read.factionID)
            .map((other) => ({
              key: other.factionID,
              name: other.name,
              values: [standingText(npcStanding(read.factionID, other.factionID)), standingText(npcStanding(other.factionID, read.factionID))],
            })),
        });
      }
      return sections;
    }
    if (current.kind === "corporation" && isNpcCorporation(current.corporationID)) {
      if ($standings.char === null) return [];
      const factionID = corporationFactionID;
      return [towardMe(factionID === null ? [current.corporationID] : [current.corporationID, factionID], factionID)];
    }
    if (current.kind === "character" && isNpcOwner(current.characterID)) {
      // GetFromIDsForNPCOwner: an agent, its corporation and its faction (agent.factionID, its corporation's); any
      // other NPC character alone.
      const read = agentRead;
      if (read === null || $standings.char === null) return [];
      if (read.agent === null) return [towardMe([current.characterID], null)];
      const corporationID = read.agent.corporationID;
      const factionID = corporationID === null ? null : ($corporationFactions?.[String(corporationID)] ?? null);
      return [towardMe([current.characterID, corporationID, factionID].filter((id): id is number => id !== null), factionID)];
    }
    const contacts = contactStandingsRead;
    const targets = standingTargetsRead;
    // The pilot's own window has no Standings tab (infosvc 1143).
    if (contacts === null || targets === null || (current.kind === "character" && current.characterID === myID)) return [];
    const myCorporationID = online?.corporationID ?? null;
    const myAllianceID = online?.allianceID ?? null;
    const fromIDs = [
      myID,
      ...(myCorporationID !== null && !isNpcOwner(myCorporationID) ? [myCorporationID] : []),
      ...(myAllianceID !== null && myAllianceID !== undefined && myAllianceID > 0 ? [myAllianceID] : []),
    ];
    // standingsvc.GetStanding from the pilot, its corporation or its alliance: that one's contact's relationship.
    const contactStanding = (fromID: number, toID: number): number =>
      (fromID === myID ? contacts.personal : fromID === myCorporationID ? contacts.corporate : contacts.alliance).get(toID) ?? 0;
    return targets.map((toID) => ({
      key: `to${toID}`,
      owner: ownerName(toID),
      rows: fromIDs.map((fromID) => ({ key: fromID, name: ownerName(fromID), values: [standingText(contactStanding(fromID, toID))] })),
    }));
  });
  /** The names the Standings tab shows: each section's owner and each row's. */
  $effect(() => {
    const refs: NameRef[] = [];
    for (const section of ownerStandingSections) {
      for (const row of section.rows) refs.push({ kind: ownerKindOf(row.key), id: row.key });
    }
    for (const id of standingTargetsRead ?? []) refs.push({ kind: ownerKindOf(id), id });
    const online = store.station.get().online;
    for (const id of [online?.corporationID ?? null, online?.allianceID ?? null]) if (id !== null && id !== undefined && id > 0) refs.push({ kind: ownerKindOf(id), id });
    if (refs.length > 0) flow.requestNames(refs);
  });

  /** A solar system's celestials and NPC stations (mapSvc.GetSolarsystemItems), once read; null while not, or not had. */
  let systemObjectsRead = $state<readonly SystemObjectRow[] | null>(null);
  /** The route to a constellation or a solar system (TAB_ROUTE), once found. */
  let mapRouteRead = $state<readonly MapRouteStep[] | null>(null);
  /** The bookmark window, open for the place (the Save Location button: infosvc.Bookmark), or none. */
  let bookmarking = $state<BookmarkPlace | null>(null);

  /** The page's names, by the formatters' kinds. */
  const namedAs: FormatContext["nameOf"] = (kind, id) => resolvedName($names.resolved, kind, id, "");
  /** format.IntToRoman (1 to 39): the client's numerals for a celestial's index. */
  function intToRoman(value: number | null): string {
    let left = value ?? 0;
    if (!(left > 0 && left < 40)) return "";
    let out = "";
    for (const [numeral, amount] of [["X", 10], ["IX", 9], ["V", 5], ["IV", 4], ["I", 1]] as const) {
      while (left >= amount) {
        out += numeral;
        left -= amount;
      }
    }
    return out;
  }
  /** eveCfg._GetCelestialNameDataFromLocalRow: a celestial's own name where it has one, else its formatter's. */
  function celestialName(row: SystemObjectRow, solarSystemID: number): string {
    if (row.name != null && row.groupID !== 10) return row.name;
    const roman = intToRoman(row.celestialIndex);
    switch (row.groupID) {
      case 9:
        return word("UI/Locations/LocationAsteroidBeltFormatter", { solarSystemID, romanCelestialIndex: roman, typeID: row.typeID, orbitIndex: row.orbitIndex ?? 0 }, namedAs);
      case 8:
        return word("UI/Locations/LocationMoonFormatter", { solarSystemID, romanCelestialIndex: roman, orbitIndex: row.orbitIndex ?? 0 }, namedAs);
      case 7:
        return word("UI/Locations/LocationPlanetFormatter", { solarSystemID, romanCelestialIndex: roman }, namedAs);
      case 10:
        return word("UI/Locations/LocationStargateFormatter", { destinationSystemID: row.destinationID ?? 0 }, namedAs);
      case 6:
        return word("UI/Locations/LocationStarFormatter", { solarSystemID }, namedAs);
      default:
        return "";
    }
  }
  /**
   * GetOrbitalBodies' DrawOrbitItems: from the star down, what orbits each thing, a stargate first, then the rest, a
   * belt, a moon, a planet, each by its celestial and orbit index (none before any); a station left out, with what
   * orbits it.
   */
  const orbitalBodies = $derived.by(() => {
    const objects = systemObjectsRead;
    if (objects === null) return [];
    const sun = objects.find((row) => row.groupID === 6);
    if (sun === undefined) return [];
    const GROUP_SORT: Readonly<Record<number, number>> = { 10: -1, 9: 1, 8: 2, 7: 3 };
    const byIndex = (a: number | null, b: number | null): number => (a === b ? 0 : a === null ? -1 : b === null ? 1 : a - b);
    const out: { readonly row: SystemObjectRow; readonly indent: number }[] = [];
    const draw = (rootID: number, indent: number): void => {
      const orbiting = objects
        .filter((row) => row.orbitID === rootID)
        .sort((a, b) => (GROUP_SORT[a.groupID ?? 0] ?? 0) - (GROUP_SORT[b.groupID ?? 0] ?? 0) || byIndex(a.celestialIndex, b.celestialIndex) || byIndex(a.orbitIndex, b.orbitIndex));
      for (const row of orbiting) {
        if (row.itemID >= 60_000_000 && row.itemID < 64_000_000) continue;
        out.push({ row, indent });
        draw(row.itemID, indent + 1);
      }
    };
    draw(sun.itemID, 0);
    return out;
  });
  /** GetStationTab: the system's stations by their celestial and orbit index. */
  const systemStations = $derived.by(() => {
    const objects = systemObjectsRead;
    if (objects === null) return [];
    const byIndex = (a: number | null, b: number | null): number => (a === b ? 0 : a === null ? -1 : b === null ? 1 : a - b);
    return objects.filter((row) => row.groupID === 15).sort((a, b) => byIndex(a.celestialIndex, b.celestialIndex) || byIndex(a.orbitIndex, b.orbitIndex));
  });
  /** The route's lines: each jump's words (a region's or a constellation's jump where it crosses into one), the system. */
  const mapRouteLines = $derived.by(() => {
    const route = mapRouteRead ?? [];
    let wasRegion: number | null = null;
    let wasConstellation: number | null = null;
    return route.map((step, at) => {
      let label = "UI/InfoWindow/RegularJump";
      if (at > 0) {
        if (wasRegion !== step.regionID) label = "UI/InfoWindow/RegionJump";
        else if (wasConstellation !== step.constellationID) label = "UI/InfoWindow/ConstellationJump";
      }
      wasRegion = step.regionID;
      wasConstellation = step.constellationID;
      return { step, jump: word(label, { numJumps: at + 1 }) };
    });
  });
  /** Save Location (infosvc.Bookmark, BookmarkLocationPopup): the place, by its default name (NewBookmarkLocationLabel). */
  function savePlace(typeID: number, itemID: number): void {
    const inThisSystem = $space.snapshot?.inSpace === true && $space.snapshot.solarSystemID === itemID;
    bookmarking = {
      itemID,
      askIfKnown: !inThisSystem,
      typeName: () => mapTypeName(typeID),
      name: () => word("UI/PeopleAndPlaces/NewBookmarkLocationLabel", { loc: itemID, group: mapTypeName(typeID) }, namedAs),
    };
  }

  /** A character's header's labels, with the page's own words where the install's are not had. */
  const CHARACTER_HEADER_WORDS: Readonly<Record<string, string>> = {
    "UI/InfoWindow/CorpTitle": "Holds {title}",
    "UI/InfoWindow/SecurityStatusOfCharacter": "Security {[numeric]secStatus, decimalPlaces=1}",
    "UI/InfoWindow/CorpStandingOfCharacter": "Your corporation's standing {[numeric]corpStanding, decimalPlaces=1}",
    "UI/InfoWindow/MemberOf": "In the corporation",
    "UI/InfoWindow/MemberFor": "for {timePeriod}",
    "UI/InfoWindow/ClickForCorpInfo": "The corporation's information",
    "UI/InfoWindow/TabNames/Bio": "In their own words",
  };
  /** A faction's labels the window uses, with the page's own words where the install's are not had. */
  const FACTION_INFO_WORDS: Readonly<Record<string, string>> = {
    "UI/InfoWindow/HeadquartersLocation": "Based in {hqLink}",
    "UI/InfoWindow/ClickForFactionInfo": "The faction's information",
    "UI/InfoWindow/TabNames/Statistics": "Figures",
    "UI/InfoWindow/MemberRaces": "Its peoples",
    "UI/Common/Formatting/ListGenericDelimiter": ", ",
    "UI/InfoWindow/SettledSystems": "Systems with its stations",
    "UI/Common/Stations": "Its stations",
    "UI/InfoWindow/TabNames/Legality": "Law",
    "UI/InfoWindow/IllegalTypes": "Goods it bans",
    "UI/InfoWindow/StandingLoss": "Costs {[numeric]standingLoss, decimalPlaces=2} standing",
    "UI/InfoWindow/ConfiscationInSec": "Taken where security is {[numeric]confiscateMinSec, decimalPlaces=2} or more",
    "UI/InfoWindow/FineOfEstimatedMarketValue": "Fined {[numeric]fine, decimalPlaces=2}% of its market worth",
    "UI/InfoWindow/AttackInSec": "Fired on where security is {[numeric]attackMinSec, decimalPlaces=2} or more",
    "UI/InfoWindow/ControlledTerritory": "Space it holds",
    "UI/Common/Regions": "Regions",
    "UI/Common/Constellations": "Constellations",
    "UI/Common/SolarSystems": "Systems",
    "UI/InfoWindow/ConstellationLocation": "{[location]constellation.name}, {[location]region.name}",
    "UI/InfoWindow/SolarsystemLocation": "{[location]solarsystem.name}, {[location]constellation.name}, {[location]region.name}",
    "UI/InfoWindow/TabNames/MemberCorps": "Its corporations",
    "UI/InfoWindow/TabNames/Standings": "Standing",
  };
  const factionSubject = (factionID: number): InfoSubject => ({ kind: "faction", factionID });
  /** A place a faction holds, named with the places it lies in (ConstellationLocation, SolarsystemLocation). */
  function factionPlaceLabel(place: FactionPlaceRow, typeID: 3 | 4 | 5): string {
    if (typeID === 3) return place.name;
    const placeNames = new Map<number, string>([[place.itemID, place.name]]);
    if (place.constellationID !== undefined) placeNames.set(place.constellationID, place.constellationName ?? "");
    if (place.regionID !== undefined) placeNames.set(place.regionID, place.regionName ?? "");
    const nameOf = (_kind: unknown, id: number): string => placeNames.get(id) ?? "";
    return typeID === 4
      ? word("UI/InfoWindow/ConstellationLocation", { region: place.regionID ?? 0, constellation: place.itemID }, nameOf)
      : word("UI/InfoWindow/SolarsystemLocation", { region: place.regionID ?? 0, constellation: place.constellationID ?? 0, solarsystem: place.itemID }, nameOf);
  }
  /** UpdateDataFaction's Controlled Territory: the regions by name, the constellations by region and name, the systems by region, constellation and name. */
  const factionTerritory = $derived.by(() => {
    const read = factionRead;
    if (read === null) return [];
    const keyed = (rows: readonly FactionPlaceRow[], key: (row: FactionPlaceRow) => string[]) =>
      [...rows].sort((a, b) => byCodePoints(key(a), key(b)));
    return [
      { label: "UI/Common/Regions", typeID: 3 as const, rows: keyed(read.regions, (row) => [row.name]) },
      { label: "UI/Common/Constellations", typeID: 4 as const, rows: keyed(read.constellations, (row) => [row.regionName ?? "", row.name]) },
      { label: "UI/Common/SolarSystems", typeID: 5 as const, rows: keyed(read.systems, (row) => [row.regionName ?? "", row.constellationName ?? "", row.name]) },
    ].filter((group) => group.rows.length > 0);
  });
  /** __GetIllegalityStringList: what carrying a banned type costs, each where it applies. */
  function illegalityLines(type: FactionInfo["illegalTypes"][number]): string[] {
    const lines: string[] = [];
    if (type.standingLoss > 0) lines.push(word("UI/InfoWindow/StandingLoss", { standingLoss: type.standingLoss }));
    if (type.confiscateMinSec <= 1) lines.push(word("UI/InfoWindow/ConfiscationInSec", { confiscateMinSec: Math.max(type.confiscateMinSec, 0) }));
    if (type.fineByValue > 0) lines.push(word("UI/InfoWindow/FineOfEstimatedMarketValue", { fine: type.fineByValue * 100 }));
    if (type.attackMinSec <= 1) lines.push(word("UI/InfoWindow/AttackInSec", { attackMinSec: Math.max(type.attackMinSec, 0) }));
    return lines;
  }
  /** construct_header: an NPC corporation's faction, by its logo (ClickForFactionInfo); null where it has none. */
  const corporationFactionID = $derived.by<number | null>(() => {
    const current = $subject;
    if (current?.kind !== "corporation") return null;
    const factionID = $corporationFactions?.[String(current.corporationID)];
    return typeof factionID === "number" && factionID > 0 ? factionID : null;
  });

  /** The client's words for a label, filled; the page's own (OWNER_INFO_WORDS) where the install's are not had. */
  function word(label: string, args: Readonly<Record<string, JsonValue>> = {}, nameOf: FormatContext["nameOf"] = () => ""): string {
    const template = $words.templates[label];
    return formatTemplate(
      typeof template === "string" ? template : OWNER_INFO_WORDS[label] ?? LINK_WORDS[label] ?? MAP_INFO_WORDS[label] ?? FACTION_INFO_WORDS[label] ?? CHARACTER_HEADER_WORDS[label] ?? "",
      args,
      { nameOf },
    );
  }

  /** FmtDate(ticks, fmt): the moment as its format's label words it (carbon format.py 71 to 114). */
  function fmtDate(ticks: bigint, fmt: "ls" | "ns" | "xn"): string {
    return word(DATE_LABELS[fmt] ?? "", { datetime: { type: "long", value: ticks.toString() } });
  }

  /** A link in the owner's words (its description, its URL), followed as the client's link registry follows it. */
  function followerOf(url: string, text: string) {
    return linkFollowerOf(url, flow, null, (label) => word(label), text);
  }

  /** One of the Attributes tab's rows: its words, and an owner it opens (LabelTextSidesAttributes' typeID and itemID). */
  interface OwnerRow {
    readonly key: string;
    readonly label: string;
    /** Plain words, or the client's markup (bold, a link) where it is "markup". */
    readonly text: string;
    readonly markup?: boolean;
    readonly opens?: InfoSubject;
    /** LabelTextSidesMoreInfo's hint. */
    readonly hint?: string;
  }

  // A character named as the window names it: cfg.eveowners (the page's "owner" kind), an NPC CEO as a pilot.
  const characterName = (id: number): string => resolvedName($names.resolved, "owner", id, "Unknown pilot");
  const corporationName = (id: number): string => resolvedName($names.resolved, "corporation", id, "Unknown corporation");
  const allianceName = (id: number): string => resolvedName($names.resolved, "alliance", id, "Unknown alliance");
  const percentage = (rate: number): string => word("UI/Common/Percentage", { percentage: rate * 100 });

  /** infosvc.UpdateDataCorp: the Attributes tab of a corporation. */
  const corporationRows = $derived.by<readonly OwnerRow[]>(() => {
    const read = corporationRead;
    if (read === null || read.stage !== "complete") return [];
    const { info } = read;
    const npc = isNpcCorporation(info.corporationID);
    const rows: OwnerRow[] = [];
    let founderDone = false;
    if (info.ceoID !== null && isCharacterOwner(info.ceoID)) {
      founderDone = info.creatorID === info.ceoID;
      rows.push({
        key: "ceo",
        label: word(founderDone ? "UI/Corporations/CorpUIHome/CeoAndFounder" : "UI/Corporations/Common/CEO"),
        text: characterName(info.ceoID),
        opens: { kind: "character", characterID: info.ceoID },
      });
    }
    if (!founderDone && info.creatorID !== null && isCharacterOwner(info.creatorID)) {
      rows.push({ key: "founder", label: word("UI/Corporations/Common/Founder"), text: characterName(info.creatorID), opens: { kind: "character", characterID: info.creatorID } });
    }
    if (info.allianceID !== null && info.allianceID > 0) {
      rows.push({ key: "alliance", label: word("UI/Common/Alliance"), text: allianceName(info.allianceID), opens: { kind: "alliance", allianceID: info.allianceID } });
    }
    rows.push({ key: "ticker", label: word("UI/Corporations/CorpUIHome/TickerName"), text: info.tickerName });
    // An int is written grouped (FormatNumeric, useGrouping); anything else (Tranquility's shares, a string) as it is.
    const grouped = (value: number | string | null): string =>
      (typeof value === "number" && Number.isInteger(value) ? value.toLocaleString("en-US") : value === null ? "0.0" : String(value));
    rows.push({ key: "shares", label: word("UI/Corporations/CorpUIHome/Shares"), text: grouped(info.shares) });
    if (!npc) {
      rows.push({ key: "members", label: word("UI/Corporations/CorpUIHome/MemberCount"), text: grouped(info.memberCount) });
    }
    rows.push({
      key: "tax",
      label: word("UI/Corporations/CorpUIHome/ISKTaxRate"),
      text: percentage(info.taxRate),
      hint: word("UI/Corporations/BaseCorporationUI/ISKTaxRateDescription", { min_isk_amount: formatIsk("100000") }),
    });
    rows.push({
      key: "lpTax",
      label: word("UI/Corporations/CorpUIHome/LPTaxRate"),
      text: percentage(info.loyaltyPointTaxRate),
      hint: word("UI/Corporations/BaseCorporationUI/LPTaxRateDescription"),
    });
    if (read.aggression !== null) {
      const { legal, changeAt } = friendlyFireAt(read.aggression, read.readAt);
      const tomorrow = changeAt !== null && fmtDate(changeAt, "xn") !== fmtDate(read.readAt, "xn");
      rows.push({
        key: "friendlyFire",
        label: word("UI/Corporations/CorpUIHome/FriendlyFire"),
        text: word(friendlyFireLabel(legal, changeAt, tomorrow), changeAt === null ? {} : { time: fmtDate(changeAt, "ns") }),
        markup: true,
        hint: plainText(word("UI/Corporations/FriendlyFire/Description")),
      });
    }
    if (!npc) {
      if (read.enlistmentFactionNames !== null) {
        const factionNames = read.enlistmentFactionNames;
        rows.push({
          key: "factions",
          label: word("UI/Corporations/CorpUIHome/PermittedFwFactions"),
          text: factionNames.length > 0 ? factionNames.map(name => name ?? "").join("\n") : word("UI/Corporations/CorpUIHome/NoFwFactionsPermitted"),
        });
      }
      rows.push({ key: "war", label: word("UI/WarPermit/WarPermitStatus"), text: word(warPermitLabel(info.allowWar)), hint: plainText(word("UI/WarPermit/WarPermitExplanation")) });
    }
    if (info.url !== "") {
      rows.push({
        key: "url",
        label: word("UI/Corporations/CorpUIHome/URL"),
        text: word("UI/Corporations/CorpUIHome/URLPlaceholder", { linkTag: `<url=${info.url}>`, url: info.url }),
        markup: true,
      });
    }
    return rows;
  });

  /** infosvc.UpdateDataAlliance: the Attributes tab of an alliance. */
  const allianceRows = $derived.by<readonly OwnerRow[]>(() => {
    const read = allianceRead;
    if (read === null) return [];
    const rows: OwnerRow[] = [];
    if (read.executorCorpID !== null) {
      rows.push({ key: "executor", label: word("UI/Corporations/CorporationWindow/Alliances/Home/Executor"), text: corporationName(read.executorCorpID), opens: { kind: "corporation", corporationID: read.executorCorpID } });
    }
    rows.push({ key: "shortName", label: word("UI/Corporations/CorporationWindow/Alliances/Home/ShortName"), text: read.shortName });
    if (read.creatorCorpID !== null) {
      rows.push({ key: "creatorCorp", label: word("UI/InfoWindow/CreatedByCorp"), text: corporationName(read.creatorCorpID), opens: { kind: "corporation", corporationID: read.creatorCorpID } });
    }
    if (read.creatorCharID !== null) {
      rows.push({ key: "creator", label: word("UI/Corporations/CorporationWindow/Alliances/Home/CreatedBy"), text: characterName(read.creatorCharID), opens: { kind: "character", characterID: read.creatorCharID } });
    }
    rows.push({ key: "start", label: word("UI/InfoWindow/StartDate"), text: read.startDate === null ? "" : fmtDate(BigInt(read.startDate), "ls") });
    // PrimeTimeHourEntryHorizontal: the hour, and the hour it becomes and when, while a change is pending.
    const now = BigInt(Date.now()) * 10000n + 116444736000000000n;
    const pending = read.newPrimeHour !== 0 && read.newPrimeHourValidAfter !== null && now < BigInt(read.newPrimeHourValidAfter);
    rows.push({
      key: "primeHour",
      label: word("UI/Sovereignty/DefaultVulnerabilityTime"),
      text: pending
        ? `${word("UI/Sovereignty/VulnerabilityTimerChangesTime", { hour: read.currentPrimeHour, newHour: read.newPrimeHour })} · ${word("UI/Sovereignty/VulnerabilityTimerChangesInfo", { validAfterDate: { type: "long", value: read.newPrimeHourValidAfter! } })}`
        : word("UI/Sovereignty/VulnerabilityTime", { hour: read.currentPrimeHour }),
    });
    rows.push({ key: "war", label: word("UI/WarPermit/WarPermitStatus"), text: word(warPermitLabel(read.allowWar)), hint: plainText(word("UI/WarPermit/WarPermitExplanation")) });
    // The capital's link (GetShowInfoLink(typeSolarSystem, ...)): the solar system's window.
    if (read.currentCapital !== null && read.currentCapital > 0) {
      rows.push({
        key: "capital",
        label: word("UI/Sovereignty/CurrentCapital"),
        text: resolvedName($names.resolved, "system", read.currentCapital, ""),
        opens: { kind: "mapLocation", typeID: 5, itemID: read.currentCapital },
      });
    }
    if (read.url !== null && read.url !== "") {
      rows.push({
        key: "url",
        label: word("UI/Common/URL"),
        text: word("UI/Corporations/CorpUIHome/URLPlaceholder", { linkTag: `<url=${read.url}>`, url: read.url }),
        markup: true,
      });
    }
    return rows;
  });

  /** The owner's description (the Description tab, there only where it has words: ConstructTabs' `if text`). */
  const ownerDescription = $derived(corporationRead?.info.description ?? allianceRead?.description ?? "");

  /** Ask for the names this window needs. Batched, cached, never throws. */
  $effect(() => {
    const refs: NameRef[] = [];
    if (typeID !== null) {
      refs.push({ kind: "type", id: typeID });
    }
    const current = $subject;
    if (current?.kind === "character") {
      refs.push({ kind: characterNameKind(current.characterID), id: current.characterID });
      refs.push({ kind: "owner", id: current.characterID });
    }
    if (current?.kind === "corporation") {
      refs.push({ kind: "corporation", id: current.corporationID });
    }
    if (current?.kind === "alliance") {
      refs.push({ kind: "alliance", id: current.allianceID });
    }
    if (current?.kind === "faction") {
      refs.push({ kind: "faction", id: current.factionID });
    }
    if (current?.kind === "mapLocation") {
      refs.push({ kind: current.typeID === 3 ? "region" : current.typeID === 4 ? "constellation" : "system", id: current.itemID });
    }
    for (const row of systemObjectsRead ?? []) {
      refs.push({ kind: "type", id: row.typeID });
      if (row.destinationID != null && row.destinationID > 0) refs.push({ kind: "system", id: row.destinationID });
      if (row.groupID === 15) refs.push({ kind: "station", id: row.itemID });
    }
    for (const step of mapRouteRead ?? []) {
      refs.push({ kind: "system", id: step.systemID });
      if (step.constellationID !== null) refs.push({ kind: "constellation", id: step.constellationID });
      if (step.regionID !== null) refs.push({ kind: "region", id: step.regionID });
    }
    if (corporationFactionID !== null) {
      refs.push({ kind: "faction", id: corporationFactionID });
    }
    const corporation = corporationRead?.info ?? null;
    if (corporation !== null) {
      for (const id of [corporation.ceoID, corporation.creatorID]) {
        if (id !== null && isCharacterOwner(id)) refs.push({ kind: "owner", id });
      }
      if (corporation.allianceID !== null && corporation.allianceID > 0) refs.push({ kind: "alliance", id: corporation.allianceID });
      if (corporation.stationID !== null && corporation.stationID > 0) refs.push({ kind: "station", id: corporation.stationID });
    }
    const alliance = allianceRead;
    if (alliance !== null) {
      for (const id of [alliance.executorCorpID, alliance.creatorCorpID]) {
        if (id !== null) refs.push({ kind: "corporation", id });
      }
      if (alliance.creatorCharID !== null) refs.push({ kind: "owner", id: alliance.creatorCharID });
      if (alliance.currentCapital !== null && alliance.currentCapital > 0) refs.push({ kind: "system", id: alliance.currentCapital });
      if (alliance.warFactionID !== null) refs.push({ kind: "faction", id: alliance.warFactionID });
    }
    if (entity?.groupID != null) {
      refs.push({ kind: "typeGroup", id: entity.groupID });
    }
    if (entity?.categoryID != null) {
      refs.push({ kind: "typeCategory", id: entity.categoryID });
    }
    if (refs.length > 0) {
      flow.requestNames(refs);
    }
  });

  function subjectKindLabel(current: InfoSubject): string {
    switch (current.kind) {
      case "spaceObject":
        return "On this grid";
      case "module":
        return "Fitted to your ship";
      case "character":
        return "Pilot";
      case "corporation":
        return "Corporation";
      case "alliance":
        return "Alliance";
      case "type":
        return "Item";
      case "medal":
        return "Medal";
      case "mapLocation":
        return mapTypeName(current.typeID);
      case "faction":
        return "Faction";
    }
  }
</script>

<!-- The client's markup (a description, a URL, bold words), its links followed as the link registry follows them. -->
{#snippet markupLines(markup: string)}
  {#each mailBodyLines(markup) as line, place (place)}
    <p class="info-line">{#each line as run, at (at)}{@const follower = run.link === null ? null : followerOf(run.link, run.text)}{#if follower !== null}<button
          type="button"
          class="evelink {follower.kind}"
          title={follower.hint}
          draggable="true"
          ondragstart={(event) => startLinkDrag(event, run.link ?? "", run.text)}
          onclick={follower.follow}>{run.text}</button>{:else}<span
          class:info-bold={run.bold}
          class:info-italic={run.italic}
          class:info-underline={run.underline || run.link !== null}
          title={run.link ?? undefined}>{run.text}</span>{/if}{/each}</p>
  {/each}
{/snippet}

<!-- The Standings tab (PanelStandings): each section's shared owner, then each other owner and the standings, one way
     (toward the pilot) or both ways (a faction with another, its own first). -->
{#snippet standingsTab()}
  {#if ownerStandingSections.length > 0}
    <h3>{word("UI/InfoWindow/TabNames/Standings")}</h3>
    {#each ownerStandingSections as section (section.key)}
      <div class="info-standings-section">
        <div class="info-standings-owner">{section.owner}</div>
        <ul class="info-standings" class:two-way={section.rows[0]?.values.length === 2}>
          {#each section.rows as row (row.key)}
            <li>{#each row.values as value, at (at)}<span class="info-standing-value">{value}</span>{/each}<span class="info-standing-name">{#if ownerLogoUrl(row.key) !== null}<img class="info-owner-logo" src={ownerLogoUrl(row.key)} alt="" width="20" height="20" />{/if}{row.name}</span></li>
          {/each}
        </ul>
      </div>
    {/each}
  {/if}
{/snippet}

<section class="show-info">
  {#if $subject === null}
    <p class="empty">
      Nothing selected. Pick something and choose Show Info — from the overview, a
      target, or a fitting socket.
    </p>
  {:else}
    <header class="info-head">
      {#if playerCorpLogo !== null}
        <!-- GetLogoIcon for a player corporation: its own logo, eveIcon.CorpIcon's three layers. -->
        <span class="type-icon type-icon-lg"><CorpLogo library={playerCorpLogo.library} logo={playerCorpLogo.logo} name={title} /></span>
      {:else if characterPortraitUrls.length > 0}
        <!-- update_window_icon for a character: its portrait. -->
        <span class="type-icon type-icon-lg"><OwnerPicture name={title} urls={characterPortraitUrls} size={72} /></span>
      {:else}
      <TypeIcon
        {typeID}
        name={title}
        size="lg"
        imageUrl={$subject.kind === "faction" ? ownerLogoUrl($subject.factionID) : $subject.kind === "corporation" ? ownerLogoUrl($subject.corporationID) : $subject.kind === "alliance" ? ownerLogoUrl($subject.allianceID) : null}
        fallbackText={corporationRead?.info.tickerName || allianceRead?.shortName || ($subject.kind === "faction" || $subject.kind === "character" ? null : abbreviate(title))} />
      {/if}
      <div class="info-identity">
        <h2>{title}</h2>
        <p class="info-kind">{subjectKindLabel($subject)}</p>
        {#if typeName && typeName !== title}
          <p class="info-type">{typeName}</p>
        {/if}
        {#if groupName || categoryName}
          <p class="info-class">
            {[categoryName, groupName].filter((part) => part.length > 0).join(" · ")}
          </p>
        {/if}
        {#if corporationRead !== null}
          {@const info = corporationRead.info}
          {#if isNpcCorporation(info.corporationID) && npcHeadquartersRead !== null && npcHeadquartersName !== ""}
            <!-- construct_header: an NPC corporation's headquarters, its link (HeadquartersLocation). -->
            <div class="info-class">{@render markupLines(word("UI/InfoWindow/HeadquartersLocation", { hqLink: `<url=showinfo:${npcHeadquartersRead.typeID}//${npcHeadquartersRead.itemID}>${npcHeadquartersName}</url>` }))}</div>
          {/if}
          {#if !isNpcCorporation(info.corporationID) && info.stationID !== null && info.stationID > 0}
            <!-- construct_header: a player's corporation's headquarters, its station, by the house icon. -->
            <p class="info-class">⌂ {resolvedName($names.resolved, "station", info.stationID, "")}</p>
          {/if}
          {#if info.allianceID !== null && info.allianceID > 0}
            {@const allianceID = info.allianceID}
            <!-- MemberOfAlliance beside the alliance's logo, which opens the alliance (ClickForAllianceInfo). -->
            <p class="info-class">
              <button type="button" class="evelink showInfo" title={word("UI/InfoWindow/ClickForAllianceInfo")} onclick={() => showInfo({ kind: "alliance", allianceID })}>
                <TypeIcon typeID={null} name={allianceName(allianceID)} size="md" imageUrl={ownerLogoUrl(allianceID)} fallbackText={null} />
                {word("UI/InfoWindow/MemberOfAlliance", { allianceName: allianceName(allianceID) })}
              </button>
            </p>
          {/if}
          {#if !(info.allianceID !== null && info.allianceID > 0) && corporationFactionID !== null}
            {@const factionID = corporationFactionID}
            <!-- The faction's logo, which opens the faction (ClickForFactionInfo), MemberOfAlliance beside it naming the
                 faction where the corporation is in no alliance. -->
            <p class="info-class">
              <button type="button" class="evelink showInfo" title={word("UI/InfoWindow/ClickForFactionInfo")} onclick={() => showInfo(factionSubject(factionID))}>
                {#if ownerLogoUrl(factionID) !== null}<img class="info-owner-logo" src={ownerLogoUrl(factionID)} alt="" width="32" height="32" />{/if}
                {word("UI/InfoWindow/MemberOfAlliance", { allianceName: resolvedName($names.resolved, "faction", factionID, "Unknown faction") })}
              </button>
            </p>
          {/if}
        {/if}
        {#if factionRead !== null && factionRead.headquarters !== null}
          <!-- ConstructHeaderFaction: its headquarters, the solar system's link. -->
          <div class="info-class">{@render markupLines(word("UI/InfoWindow/HeadquartersLocation", { hqLink: `<url=showinfo:5//${factionRead.headquarters.itemID}>${factionRead.headquarters.name}</url>` }))}</div>
        {/if}
        {#if $subject.kind === "character"}
          {@const header = characterHeaderRead}
          {#if header !== null && header.titles.length > 0}
            <!-- CorpTitle over FormatGenericList: the character's titles. -->
            <p class="info-class">{word("UI/InfoWindow/CorpTitle", { title: header.titles.join(word("UI/Common/Formatting/ListGenericDelimiter")) })}</p>
          {/if}
          {#if characterCorporationID !== null}
            {@const corporationID = characterCorporationID}
            {@const corpLogo = isNpcCorporation(corporationID) ? null : ($corpLogos[String(corporationID)] ?? null)}
            <!-- The corporation's logo, which opens the corporation (ClickForCorpInfo), Member Of and its name beside it,
                 and how long the character has been in it. -->
            <div class="info-corporation">
              <button type="button" class="info-corporation-logo" title={word("UI/InfoWindow/ClickForCorpInfo")} onclick={() => showInfo({ kind: "corporation", corporationID })}>
                {#if corpLogo !== null && $corpLogoLibrary !== null && corpLogo.shapes.some((shape) => shape !== null)}
                  <CorpLogo library={$corpLogoLibrary} logo={corpLogo} name={resolvedName($names.resolved, "corporation", corporationID, "")} />
                {:else if ownerLogoUrl(corporationID) !== null}
                  <img src={ownerLogoUrl(corporationID)} alt="" width="40" height="40" />
                {/if}
              </button>
              <div>
                <p class="info-class">{word("UI/InfoWindow/MemberOf")}</p>
                <p><button type="button" class="evelink showInfo" title={word("UI/InfoWindow/ClickForCorpInfo")} onclick={() => showInfo({ kind: "corporation", corporationID })}>{resolvedName($names.resolved, "corporation", corporationID, "")}</button></p>
                {#if memberForText !== null}<p class="info-class">{memberForText}</p>{/if}
              </div>
            </div>
          {/if}
          {#if header !== null && header.militiaFactionID !== null}
            <p class="info-class">{word("UI/FactionWarfare/MilitiaAndFaction", { factionName: resolvedName($names.resolved, "faction", header.militiaFactionID, "") })}</p>
          {/if}
          {#if header !== null && header.allianceID !== null}
            <p class="info-class">{resolvedName($names.resolved, "alliance", header.allianceID, "")}</p>
          {/if}
          {#if header !== null && header.securityStatus !== null}
            <div class="info-class">{@render markupLines(word("UI/InfoWindow/SecurityStatusOfCharacter", { secStatus: header.securityStatus, text_color: "" }))}</div>
          {/if}
          {#if corporationStandingOfCharacter !== null}
            <div class="info-class">{@render markupLines(word("UI/InfoWindow/CorpStandingOfCharacter", { corpStanding: corporationStandingOfCharacter, text_color: "" }))}</div>
          {/if}
        {/if}
        {#if allianceRead !== null && allianceRead.warFactionID !== null}
          <!-- ConstructHeaderAlliance: the militia it fights for. -->
          <p class="info-class">{word("UI/FactionWarfare/MilitiaAndFaction", { factionName: resolvedName($names.resolved, "faction", allianceRead.warFactionID, "") })}</p>
        {/if}
      </div>
      {#if corporationRead !== null && corporationRead.info.ceoID !== null && !isNpcCorporation(corporationRead.info.corporationID)}
        <!-- construct_ceo_picture_info: a player's corporation's CEO beside the window's picture. -->
        <div class="info-ceo">
          <span class="info-ceo-label">{word("UI/Corporations/Common/CEO")}</span>
          <strong>{characterName(corporationRead.info.ceoID)}</strong>
        </div>
      {/if}
    </header>

    {#if $subject.kind === "spaceObject"}
      {#if entity}
        <h3>Where it is</h3>
        <dl class="kv">
          <dt>Distance</dt>
          <dd>{distance != null ? fmtDist(distance, 1, say) : "—"}</dd>
          <dt>Speed</dt>
          <dd>{speed != null ? `${Math.round(speed)} m/s` : "—"}</dd>
          {#if isHostile(entity)}
            <dt>Threat</dt>
            <dd>{hostileLabel(entity) ?? "Hostile"}</dd>
          {/if}
          {#if entity.remainingQuantity != null}
            <!-- Only a rock the server gave a mining record for. Null stays
                 absent rather than becoming a 0 that reads as mined out. -->
            <dt>Ore left</dt>
            <dd>{entity.remainingQuantity.toLocaleString("en-US")}</dd>
          {/if}
          {#if entity.oreValuePerM3 != null}
            <!-- What the retail client's Mining Surveyor shows as a colour: the
                 ore's reprocessed value per cubic metre. Absent when it could
                 not be priced — never a 0, which would read as worthless. -->
            <dt>Ore value</dt>
            <dd>{Math.round(entity.oreValuePerM3).toLocaleString("en-US")} ISK/m³</dd>
          {/if}
        </dl>

        {#if condition.length > 0}
          <h3>Condition</h3>
          <dl class="kv">
            {#each condition as row (row.label)}
              <dt>{row.label}</dt>
              <dd>{row.pct}%</dd>
            {/each}
          </dl>
        {/if}

        <div class="controls">
          <button type="button" onclick={() => spaceSelection.select($subject.itemID)}>
            Select it
          </button>
        </div>
      {:else}
        <!-- ⚠ Said, not silently blanked. The window keeps the thing's identity
             and reports that it has gone, rather than showing stale numbers. -->
        <p class="note">This is no longer on your grid, so there is nothing live to report about it.</p>
      {/if}
    {:else if $subject.kind === "module"}
      {#if fittedModule}
        <dl class="kv">
          <dt>State</dt>
          <dd>{fittedModule.online ? "Online" : "Offline"}</dd>
          {#if fittedModule.charge}
            <dt>Loaded</dt>
            <dd>
              {resolvedName($names.resolved, "type", fittedModule.charge.typeID, "Unknown charge")}
              × {fittedModule.charge.quantity.toLocaleString("en-US")}
            </dd>
          {/if}
        </dl>
      {/if}
      {#if moduleStats.length > 0}
        <h3>Attributes</h3>
        <!-- The SERVER's effective values, with skills and hull bonuses already
             applied — not the static table's base numbers. -->
        <dl class="kv">
          {#each moduleStats as stat (stat.id)}
            <dt>{stat.label}</dt>
            <dd>{stat.value}</dd>
          {/each}
        </dl>
      {:else}
        <p class="note">
          No attribute reading for this module yet — the fitting window's dogma read is what
          supplies them.
        </p>
      {/if}
    {:else if $subject.kind === "mapLocation"}
      {#if mapLocationRead !== null}
        {@const read = mapLocationRead}
        <!-- The sub caption's location trace (GetLocationTrace): the places it lies in, each a link, a system's security
             level after them. -->
        {#if read.parents.length > 0 || read.securityStatus != null}
          <dl class="kv">
            {#each read.parents as parent (parent.itemID)}
              <dt>{mapTypeName(parent.typeID)}</dt>
              <dd><button type="button" class="evelink showInfo" title={word("UI/Commands/ShowInfo")} onclick={() => showInfo(placeSubject(parent))}>{parent.name}</button></dd>
            {/each}
            {#if read.securityStatus != null}
              <dt>{word("UI/Neocom/SecurityLevel")}</dt>
              <dd><span style:color={securityStatusColor(shownSecurity(read.securityStatus))}>{shownSecurity(read.securityStatus).toFixed(1)}</span></dd>
            {/if}
          </dl>
        {/if}
        <h3>{word("UI/InfoWindow/TabNames/Description")}</h3>
        <div class="info-description">{@render markupLines(read.description ?? mapTypeName(read.typeID))}</div>
        <!-- INFO_TABS' order: the Neighbors tab before the Children tab. -->
        {#each [[NEIGHBOUR_LABELS[read.typeID], read.neighbours], [CHILD_LABELS[read.typeID], read.children]] as const as [label, list] (label ?? "none")}
          {#if label && list.length > 0}
            <h3>{word(label)}</h3>
            <ul class="info-places">
              {#each [...list].sort(byPlaceName) as place (place.itemID)}
                <li>
                  <span class="info-place-type">{mapTypeName(place.typeID)}</span>
                  <span class="info-place-sec" style:color={place.securityStatus != null ? securityStatusColor(shownSecurity(place.securityStatus)) : undefined}>{place.securityStatus != null ? shownSecurity(place.securityStatus).toFixed(1) : ""}</span>
                  <button type="button" class="evelink showInfo" title={word("UI/Commands/ShowInfo")} onclick={() => showInfo(placeSubject(place))}>{place.name}</button>
                </li>
              {/each}
            </ul>
          {/if}
        {/each}
        {#if orbitalBodies.length > 0}
          <h3>{word("UI/InfoWindow/TabNames/OrbitalBodies")}</h3>
          <!-- A planet with its type's name after it; a moon's name and a belt's in the client's dimmer colours. -->
          <ul class="info-orbits">
            {#each orbitalBodies as { row, indent } (row.itemID)}
              <li style:padding-left={`${indent * 1.2}rem`} class:info-orbit-moon={row.groupID === 8} class:info-orbit-belt={row.groupID === 9}>
                <button type="button" class="evelink showInfo" title={word("UI/Commands/ShowInfo")} onclick={() => showInfo({ kind: "type", typeID: row.typeID })}>{celestialName(row, read.itemID)}</button>{#if row.groupID === 7}<span class="info-orbit-kind">{" " + resolvedName($names.resolved, "type", row.typeID, "")}</span>{/if}
              </li>
            {/each}
          </ul>
        {/if}
        {#if systemStations.length > 0}
          <h3>{word("UI/Common/LocationTypes/Stations")}</h3>
          <ul class="info-territory">
            {#each systemStations as row (row.itemID)}
              <li><button type="button" class="evelink showInfo" title={word("UI/Commands/ShowInfo")} onclick={() => showInfo({ kind: "type", typeID: row.typeID })}>{resolvedName($names.resolved, "station", row.itemID, "")}</button></li>
            {/each}
          </ul>
        {/if}
        {#if mapRouteLines.length > 0}
          <h3>{word("UI/InfoWindow/TabNames/Route")}</h3>
          <h4 class="info-subhead">{word("UI/Market/MarketQuote/NumberOfJumps", { num: mapRouteLines.length })}</h4>
          <ul class="info-places info-route">
            {#each mapRouteLines as { step, jump } (step.systemID)}
              <li>
                <span class="info-place-type">{jump}</span>
                <span class="info-place-sec" style:color={step.security != null ? securityStatusColor(shownSecurity(step.security)) : undefined}>{step.security != null ? shownSecurity(step.security).toFixed(1) : ""}</span>
                <button type="button" class="evelink showInfo" title={word("UI/Commands/ShowInfo")} onclick={() => showInfo({ kind: "mapLocation", typeID: 5, itemID: step.systemID })}>{word("UI/InfoWindow/SolarsystemLocation", { solarsystem: step.systemID, constellation: step.constellationID ?? 0, region: step.regionID ?? 0 }, namedAs)}</button>
              </li>
            {/each}
          </ul>
        {/if}
        <!-- The window's buttons (DATA_BUTTONS): Save Location. Show Location on Map waits on a map. -->
        <div class="info-buttons">
          <button type="button" onclick={() => savePlace(read.typeID, read.itemID)}>{word("UI/Inflight/BookmarkLocation")}</button>
        </div>
        {#if bookmarking !== null}
          <BookmarkWindow {store} {flow} place={bookmarking} onDone={() => (bookmarking = null)} />
        {/if}
      {:else if ownerReadDone}
        <p class="note">The page has no record of this place.</p>
      {:else}
        <p class="note">Reading…</p>
      {/if}
    {:else if $subject.kind === "faction"}
      {#if factionRead !== null}
        {@const read = factionRead}
        {#if read.description}
          <h3>{word("UI/InfoWindow/TabNames/Description")}</h3>
          <div class="info-description">{@render markupLines(read.description)}</div>
        {/if}
        <!-- The Attributes tab, named Statistics: the member races (FormatGenericList), its settled systems, its stations. -->
        <h3>{word("UI/InfoWindow/TabNames/Statistics")}</h3>
        <dl class="kv">
          {#if read.memberRaces.length > 0}
            <dt>{word("UI/InfoWindow/MemberRaces")}</dt>
            <dd>{read.memberRaces.map((race) => race.name).join(word("UI/Common/Formatting/ListGenericDelimiter"))}</dd>
          {/if}
          <dt>{word("UI/InfoWindow/SettledSystems")}</dt>
          <dd>{read.settledSystems.toLocaleString("en-US")}</dd>
          <dt>{word("UI/Common/Stations")}</dt>
          <dd>{read.stations.toLocaleString("en-US")}</dd>
        </dl>
        {#if read.illegalTypes.length > 0}
          <h3>{word("UI/InfoWindow/TabNames/Legality")}</h3>
          <h4 class="info-subhead">{word("UI/InfoWindow/IllegalTypes")}</h4>
          <ul class="info-legality">
            {#each read.illegalTypes as type (type.typeID)}
              <li>
                <button type="button" class="evelink showInfo" title={word("UI/Commands/ShowInfo")} onclick={() => showInfo({ kind: "type", typeID: type.typeID })}>{type.name}</button>
                {#each illegalityLines(type) as line, at (at)}<span class="info-legality-line">{line}</span>{/each}
              </li>
            {/each}
          </ul>
        {/if}
        {#if factionTerritory.length > 0}
          <h3>{word("UI/InfoWindow/ControlledTerritory")}</h3>
          {#each factionTerritory as group (group.typeID)}
            <h4 class="info-subhead">{word(group.label)}</h4>
            <ul class="info-territory">
              {#each group.rows as place (place.itemID)}
                <li><button type="button" class="evelink showInfo" title={word("UI/Commands/ShowInfo")} onclick={() => showInfo({ kind: "mapLocation", typeID: group.typeID, itemID: place.itemID })}>{factionPlaceLabel(place, group.typeID)}</button></li>
              {/each}
            </ul>
          {/each}
        {/if}
        {@render standingsTab()}
        {#if read.corporations.length > 0}
          <h3>{word("UI/InfoWindow/TabNames/MemberCorps")}</h3>
          <ul class="info-territory">
            {#each read.corporations as corporation (corporation.corporationID)}
              <li><button type="button" class="evelink showInfo" title={word("UI/Commands/ShowInfo")} onclick={() => showInfo({ kind: "corporation", corporationID: corporation.corporationID })}>{corporation.name}</button></li>
            {/each}
          </ul>
        {/if}
      {:else if ownerReadDone}
        <p class="note">The page has no record of this faction.</p>
      {:else}
        <p class="note">Reading…</p>
      {/if}
    {:else if $subject.kind === "character"}
      <!-- INFO_TABS' order: the Bio, there only where it has words (construct_main_tabs: `if text`), the Description,
           then the Standings. -->
      {#if characterHeaderRead !== null && characterHeaderRead.description !== ""}
        <h3>{word("UI/InfoWindow/TabNames/Bio")}</h3>
        <div class="info-description">{@render markupLines(characterHeaderRead.description)}</div>
      {/if}
      {#if characterDescription !== null && characterDescription !== ""}
        <h3>{word("UI/InfoWindow/TabNames/Description")}</h3>
        <div class="info-description">{@render markupLines(characterDescription)}</div>
      {/if}
      {@render standingsTab()}
    {:else if $subject.kind === "corporation" || $subject.kind === "alliance"}
      {@const rows = $subject.kind === "corporation" ? corporationRows : allianceRows}
      {#if rows.length > 0}
        {#if ownerDescription.trim() !== ""}
          <h3>{word("UI/InfoWindow/TabNames/Description")}</h3>
          <div class="info-description">{@render markupLines(ownerDescription)}</div>
        {/if}
        <h3>{word("UI/InfoWindow/TabNames/Attributes")}</h3>
        <dl class="kv">
          {#each rows as row (row.key)}
            <dt>{row.label}</dt>
            <dd title={row.hint || undefined} class:info-more={!!row.hint}>
              {#if row.opens}
                {@const opens = row.opens}
                <button type="button" class="evelink showInfo" title={word("UI/Commands/ShowInfo")} onclick={() => showInfo(opens)}>{row.text}</button>
              {:else if row.markup}
                {@render markupLines(row.text)}
              {:else}
                {#each row.text.split("\n") as part, at (at)}<span class="info-part">{part}</span>{/each}
              {/if}
            </dd>
          {/each}
        </dl>
        {@render standingsTab()}
        {#if $subject.kind === "corporation" && !isNpcCorporation($subject.corporationID)}
          <!-- TAB_FREELANCE_PROJECTS (infosvc.UpdateDataCorp, a player corporation's), after the Standings in INFO_TABS. -->
          {#key $subject.corporationID}<InfoFreelanceProjects {store} {flow} corporationID={$subject.corporationID} />{/key}
        {/if}
      {:else if ownerReadDone && $subject.kind === "alliance"}
        <!-- Said, not blanked: the server had no record to give. -->
        <p class="note">The server gave no record of this alliance.</p>
      {:else if !ownerReadDone}
        <p class="note">Reading…</p>
      {/if}
    {:else}
      <p class="note">
        Nothing further is loaded about this item. Fit one to your ship to see its effective
        attributes.
      </p>
    {/if}
  {/if}
</section>
