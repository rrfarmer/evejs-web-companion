// The agent window's right-hand pane: a mission's objectives, laid out as the retail client lays them out.
//
// agentDialogueUtil.GetMissionObjectiveHTML (282 to 407) writes the pane as HTML, in this order:
//
//   a warning, when the mission matters to standings
//   the heading: the mission's name with "Objectives", "Objectives Complete" or "Objectives Failed"
//   a line of overview
//   each objective (_ProcessObjectiveEntry, 30 to 97): a transport's pickup, dropoff and cargo; where
//     to bring a thing and what; whom to report to and where
//   each dungeon (_ProcessDungeonData, 100 to 154): its heading, the agent's words for it or the stock
//     ones, struck through with what became of it once it is over, and its place
//   granted items, rewards, bonus rewards, collateral, and a heading and text of the mission's own
//
// This lays the same things out in the same order as blocks of plain text, each row with the mark the
// client draws beside it: done (its tick), open (its circle) or failed (its cross). The words are the
// client's, read from its install at run time (the words store). A block whose words are not to hand is
// left out, and the page shows only what it can say.
//
// Not done: the client's warning about low security on the way (it plots the route); the banner about
// reduced payouts in high security; the
// links to a dungeon's fitted-type restrictions; a blueprint's properties after its name; a heraldry agent's
// own loyalty points.

import { formatTemplate, plainText, QUANTITY_AND_ITEM } from "./clientWords.ts";
import { AGENT_MISSION_STATE_FAILED, TYPE_CREDITS, objectivesHeading, type MissionCargo, type MissionItem, type MissionLocation, type MissionMessage, type MissionObjective, type MissionObjectives } from "./missionObjectives.ts";
import { INTERVAL_WORD_LABELS, intervalWriters } from "./timeInterval.ts";
import { LOCATION_WORD_LABELS, wrapLocation, wrapLocationRuns } from "./locationWrapper.ts";
import { labelEscaped } from "./labelMarkup.ts";
import type { NameKind } from "../store/names.ts";

const FOLDER = "UI/Agents/StandardMission/";
const TYPE_LOYALTY_POINTS = 29247;
export const PANE_LABELS = Object.freeze({
  importantStandings: `${FOLDER}ImportantStandingsWarning`,
  /** Each takes missionName. */
  heading: Object.freeze({ open: `${FOLDER}MissionObjectives`, complete: `${FOLDER}MissionObjectivesComplete`, failed: `${FOLDER}MissionObjectivesFailed` }),
  overview: `${FOLDER}OverviewAndObjectivesBlurb`,
  /** Takes agentID. */
  reportToAgent: `${FOLDER}ObjectiveReportToAgent`,
  agentLocation: `${FOLDER}AgentLocation`,
  transportHeader: `${FOLDER}TransportObjectiveHeader`,
  transportBlurb: `${FOLDER}TransportBlurb`,
  transportPickup: `${FOLDER}TransportPickupLocation`,
  transportDropOff: `${FOLDER}TransportDropOffLocation`,
  transportCargo: `${FOLDER}TransportCargo`,
  fetchHeader: `${FOLDER}FetchObjectiveHeader`,
  fetchBlurb: `${FOLDER}FetchObjectiveBlurb`,
  fetchDropOff: `${FOLDER}FetchObjectiveDropOffLocation`,
  fetchItem: `${FOLDER}FetchObjectiveItem`,
  /** Takes cargoDescription and size. */
  cargoWithSize: `${FOLDER}CargoDescriptionWithSize`,
  objectiveHeader: `${FOLDER}ObjectiveHeader`,
  optionalHeader: `${FOLDER}OptionalObjectiveHeader`,
  dungeonBody: `${FOLDER}DungeonObjectiveBody`,
  optionalBody: `${FOLDER}OptionalObjectiveBody`,
  dungeonCompleted: `${FOLDER}DungeonObjectiveCompleted`,
  dungeonFailed: `${FOLDER}DungeonObjectiveFailed`,
  objectiveLocation: `${FOLDER}ObjectiveLocation`,
  normalShipRestrictions: `${FOLDER}DungeonObjectiveNormalRestrictions`,
  specialShipRestrictions: `${FOLDER}DungeonObjectiveSpecialRestrictions`,
  grantedItems: `${FOLDER}GrantedItems`,
  grantedDetail: `${FOLDER}GrantedItemDetail`,
  grantedDetailAccepted: `${FOLDER}AcceptedGrantedItemDetail`,
  /** Takes agentID. */
  referral: `${FOLDER}MissionReferral`,
  rewardsTitle: `${FOLDER}RewardsTitle`,
  rewardsHeader: `${FOLDER}RewardsHeader`,
  /** Takes lpAmount. */
  loyaltyPoints: `${FOLDER}NumLoyaltyPoints`,
  /** Takes rpAmount. */
  researchPoints: `${FOLDER}NumResearchPoints`,
  bonusTitle: `${FOLDER}BonusRewardsTitle`,
  /** Takes timeRemaining, the game's time left. */
  bonusHeader: `${FOLDER}BonusRewardsHeader`,
  bonusPassed: `${FOLDER}BonusTimePassed`,
  collateralTitle: `${FOLDER}CollateralTitle`,
  collateralHeader: `${FOLDER}CollateralHeader`,
  /** FmtISK: takes amount. */
  isk: "UI/Util/FmtIsk",
  /** A ship in space to go to: takes typeID and locationID. */
  itemLocation: "UI/Agents/Items/ItemLocation",
  quantityAndItem: QUANTITY_AND_ITEM,
});

/** Every label the pane may need, for asking the words store: its own, and those a bonus's time left is written with. */
export const PANE_WORD_LABELS: readonly string[] = [
  ...Object.values(PANE_LABELS).flatMap((label) => (typeof label === "string" ? [label] : Object.values(label))),
  ...INTERVAL_WORD_LABELS,
  ...LOCATION_WORD_LABELS,
];

/** The mark the client draws beside a row: its tick, its circle, or its cross. */
export type PaneMark = "done" | "open" | "failed";

export interface PaneRow {
  readonly mark: PaneMark | null;
  readonly label: string | null;
  readonly text: string;
  readonly info?: { readonly typeID: number; readonly itemID?: number };
}

export interface PaneBlock {
  readonly kind: "warning" | "heading" | "overview" | "objective" | "items";
  /** The heading's state, for its colour. */
  readonly state?: "open" | "complete" | "failed";
  /** A mission a game master finished by hand (the client says so above the heading). */
  readonly cheated?: boolean;
  readonly title: string | null;
  readonly text: string | null;
  /** A dungeon that is over: its words are struck through, and this says what became of it. */
  readonly outcome?: string | null;
  readonly rows: readonly PaneRow[];
  readonly shipRestrictions?: { readonly dungeonID: number; readonly special: boolean };
  /** The objective a block is for, so the page can put its own controls beside it. */
  readonly objective?: MissionObjective;
}

export interface PaneContext {
  readonly templates: Readonly<Record<string, string | null | undefined>>;
  /** Keep formatted mission labels and add links for the Journal article. */
  readonly rich?: boolean;
  readonly nameOf: (kind: NameKind, id: number) => string;
  /** session.locationid: the station the pilot is docked in, or the solar system it is flying in. */
  readonly locationID: number | null;
  /** A mission's name from its message's number, as the client's GetByMessageID gives it; null when it cannot be had. */
  readonly messageText: (messageID: number) => string | null;
  /** What an agent says of a dungeon, as agents.py ProcessMessage fills it; null when it cannot be had. */
  readonly say: (message: MissionMessage) => string | null;
  /** The security a solar system was made with; null when it is not known. */
  readonly securityOf: (solarSystemID: number) => number | null;
  /** The pilot's own security status as crimewatchSvc keeps it, asked only where a warning turns on it; null while not known. */
  readonly ownSecurityStatus?: () => number | null;
}

/** The names the pane will ask for, so the page can fetch them before it is drawn. */
export function paneNameRefs(objectives: MissionObjectives): Array<{ kind: NameKind; id: number }> {
  const refs: Array<{ kind: NameKind; id: number }> = [];
  const place = (location: MissionLocation | null): void => {
    if (location?.locationID) refs.push({ kind: placeKind(location.locationID), id: location.locationID });
    if (location?.shipTypeID) refs.push({ kind: "type", id: location.shipTypeID });
  };
  const owner = (id: number | null): void => {
    if (id) refs.push({ kind: "owner", id });
  };
  const thing = (typeID: number | null): void => {
    if (typeID && typeID !== TYPE_CREDITS) refs.push(isCharacter(typeID) ? { kind: "owner", id: typeID } : { kind: "type", id: typeID });
  };
  for (const objective of objectives.objectives) {
    if (objective.kind === "agent") {
      owner(objective.agentID);
      place(objective.location);
    } else if (objective.kind === "transport") {
      place(objective.pickup);
      place(objective.dropoff);
      owner(objective.pickupOwnerID);
      owner(objective.dropoffOwnerID);
      thing(objective.cargo?.typeID ?? null);
    } else {
      place(objective.dropoff);
      owner(objective.dropoffOwnerID);
      thing(objective.cargo?.typeID ?? null);
    }
  }
  for (const dungeon of objectives.dungeons) {
    place(dungeon.location);
    owner(dungeon.ownerID);
  }
  for (const item of [...objectives.agentGift, ...objectives.normalRewards, ...objectives.bonusRewards, ...objectives.collateral]) thing(item.typeID);
  if (objectives.loyaltyPoints > 0) thing(TYPE_LOYALTY_POINTS);
  return refs;
}

/** The numbers of the messages the pane will ask for: the mission's name. */
export function paneMessageIDs(objectives: MissionObjectives): number[] {
  return [objectives.missionTitleID, objectives.missionExtra?.headerID, objectives.missionExtra?.bodyID]
    .filter((id): id is number => id != null && id > 0);
}

function placeKind(id: number): NameKind {
  if (id >= 30_000_000 && id < 40_000_000) return "system";
  if (id >= 60_000_000 && id < 64_000_000) return "station";
  return "structure";
}

/** idCheckers.IsCharacter, for what the server sends here: an agent, or a capsuleer. */
const isCharacter = (id: number): boolean => (id >= 3_000_000 && id < 4_000_000) || (id >= 90_000_000 && id < 98_000_000) || (id >= 2_100_000_000 && id < 2_147_483_647);

/**
 * The pane for these objectives, or [] when its heading cannot be said (the client's words are not to
 * hand): a pane with no heading would be rows about nothing.
 */
export function objectivePane(objectives: MissionObjectives, context: PaneContext): PaneBlock[] {
  const words = (label: string, args: Record<string, string | number> = {}): string | null => {
    const template = context.templates[label];
    if (typeof template !== "string") return null;
    const formatted = formatTemplate(template, args, { nameOf: context.nameOf, ...writers });
    return context.rich ? formatted : plainText(formatted);
  };
  const writers = intervalWriters(context.templates);
  const blocks: PaneBlock[] = [];

  const state = objectivesHeading(objectives);
  const missionName = objectives.missionTitle ?? (objectives.missionTitleID === null ? null : context.messageText(objectives.missionTitleID));
  const heading = missionName === null ? null : words(PANE_LABELS.heading[state], { missionName });
  if (heading === null) {
    return [];
  }
  if (objectives.importantStandings) {
    const warning = words(PANE_LABELS.importantStandings);
    if (warning !== null) blocks.push({ kind: "warning", title: null, text: warning, rows: [] });
  }
  blocks.push({ kind: "heading", state, cheated: objectives.completionStatus === 2, title: heading, text: null, rows: [] });
  const overview = words(PANE_LABELS.overview);
  if (overview !== null) blocks.push({ kind: "overview", title: null, text: overview, rows: [] });

  // LocationWrapper: a ship in space to go to is worded by its type; anything else by its own name. Either
  // way with its system's security rating before it, and a warning after it where that is low.
  const placeText = (location: MissionLocation | null): string | null => {
    if (location === null || location.locationID === null) return null;
    const ship = location.shipTypeID === null ? null : words(PANE_LABELS.itemLocation, { typeID: location.shipTypeID, locationID: location.locationID });
    const name = ship ?? context.nameOf(placeKind(location.locationID), location.locationID);
    if (!context.rich) return wrapLocation(name, location.solarsystemID, context.templates, context.securityOf, context.ownSecurityStatus);
    const typeID = location.typeID;
    const link = typeID === null || !name ? null : { typeID, itemID: location.locationID };
    const runs = wrapLocationRuns(name, location.solarsystemID, context.templates, context.securityOf, context.ownSecurityStatus, link);
    const bookmark = location.bookmark;
    const agents = bookmark && [bookmark.agentID, bookmark.referringAgentID].filter(id => id !== null).join(",");
    const suffix = bookmark && location.locationType && /^[a-z.]+$/i.test(location.locationType)
      ? `//${[...bookmark.coordinates, agents, 0, location.locationType].join("//")}` : "";
    return (runs ?? [{ text: name, link: link ?? undefined }]).map(run => {
      const text = labelEscaped(run.text);
      if (run.link) return `<url=showinfo:${run.link.typeID}//${run.link.itemID}${suffix}>${text}</url>`;
      const rgb = run.color?.match(/^rgb\((\d+), (\d+), (\d+)\)$/)?.slice(1);
      const hex = rgb?.map(byte => Number(byte).toString(16).padStart(2, "0")).join("") ?? run.color?.slice(1);
      if (hex) return `<color=0xff${hex}>${text}</color>`;
      return text;
    }).join("");
  };
  const cargoText = (cargo: MissionCargo | null): string | null => {
    if (cargo === null || cargo.typeID === null) return null;
    const text = words(PANE_LABELS.quantityAndItem, { quantity: cargo.quantity ?? 0, item: cargo.typeID });
    if (text === null) return null;
    return cargo.volume !== null && cargo.volume > 0 ? words(PANE_LABELS.cargoWithSize, { cargoDescription: text, size: cargo.volume }) ?? text : text;
  };
  const ownerInfo = (id: number | null): PaneRow["info"] => {
    if (!context.rich || !id) return undefined;
    if (isCharacter(id)) return { typeID: 1377, itemID: id };
    if (id >= 500_000 && id < 1_000_000) return { typeID: 30, itemID: id };
    if ((id >= 1_000_000 && id < 2_000_000) || (id >= 98_000_000 && id < 99_000_000)) return { typeID: 2, itemID: id };
    return undefined;
  };
  const itemInfo = (typeID: number | null | undefined): PaneRow["info"] =>
    !context.rich || !typeID || typeID === TYPE_CREDITS ? undefined
      : isCharacter(typeID) ? ownerInfo(typeID) : { typeID };
  const row = (mark: PaneMark | null, label: string, text: string | null, info?: PaneRow["info"]): PaneRow[] =>
    text === null ? [] : [{ mark, label: words(label), text, ...(info ? { info } : {}) }];
  const at = (location: MissionLocation | null): boolean => location !== null && location.locationID !== null && location.locationID === context.locationID;
  const marked = (done: boolean): PaneMark => (done ? "done" : "open");

  for (const objective of objectives.objectives) {
    if (objective.kind === "agent") {
      const title = objective.agentID === null ? null : words(PANE_LABELS.reportToAgent, { agentID: objective.agentID });
      if (title !== null) blocks.push({ kind: "objective", title, text: null, rows: row(null, PANE_LABELS.agentLocation, placeText(objective.location), ownerInfo(objective.agentID)), objective });
    } else if (objective.kind === "transport") {
      const hasCargo = objective.cargo?.hasCargo === true;
      const atPickup = at(objective.pickup);
      blocks.push({
        kind: "objective",
        title: words(PANE_LABELS.transportHeader),
        text: words(PANE_LABELS.transportBlurb),
        rows: [
          ...row(marked(atPickup || hasCargo), PANE_LABELS.transportPickup, placeText(objective.pickup), ownerInfo(objective.pickupOwnerID)),
          ...row(marked(at(objective.dropoff) && (atPickup || hasCargo)), PANE_LABELS.transportDropOff, placeText(objective.dropoff), ownerInfo(objective.dropoffOwnerID)),
          ...row(marked(hasCargo), PANE_LABELS.transportCargo, cargoText(objective.cargo), itemInfo(objective.cargo?.typeID)),
        ],
        objective,
      });
    } else {
      // With nowhere named, the client shows whom to bring it to.
      const where = placeText(objective.dropoff) ?? (objective.dropoffOwnerID === null ? null : context.nameOf("owner", objective.dropoffOwnerID));
      blocks.push({
        kind: "objective",
        title: words(PANE_LABELS.fetchHeader),
        text: words(PANE_LABELS.fetchBlurb),
        rows: [
          ...row(marked(at(objective.dropoff)), PANE_LABELS.fetchDropOff, where, ownerInfo(objective.dropoffOwnerID)),
          ...row(marked(objective.cargo?.hasCargo === true), PANE_LABELS.fetchItem, cargoText(objective.cargo), itemInfo(objective.cargo?.typeID)),
        ],
        objective,
      });
    }
  }

  const failed = objectives.missionState === AGENT_MISSION_STATE_FAILED;
  for (const dungeon of objectives.dungeons) {
    // A failed mission's dungeons are failed, whatever they say of themselves.
    const completionStatus = failed ? 0 : dungeon.completionStatus;
    const objectiveCompleted = failed ? 0 : dungeon.objectiveCompleted;
    const stock = words(dungeon.optional ? PANE_LABELS.optionalBody : PANE_LABELS.dungeonBody);
    const body = dungeon.briefingMessage === null ? stock : context.say(dungeon.briefingMessage) ?? stock;
    const shipRestrictions = context.rich && dungeon.shipRestrictions !== null && dungeon.dungeonID !== null && dungeon.dungeonID > 0
      ? { dungeonID: dungeon.dungeonID, special: dungeon.shipRestrictions === 1 } : null;
    blocks.push({
      kind: "objective",
      title: words(dungeon.optional ? PANE_LABELS.optionalHeader : PANE_LABELS.objectiveHeader),
      text: body,
      outcome: completionStatus === null ? null : words(completionStatus === 1 ? PANE_LABELS.dungeonCompleted : PANE_LABELS.dungeonFailed),
      rows: row(objectiveCompleted === null ? "open" : objectiveCompleted === 1 ? "done" : "failed", PANE_LABELS.objectiveLocation, placeText(dungeon.location), ownerInfo(dungeon.ownerID)),
      ...(shipRestrictions ? { shipRestrictions } : {}),
    });
  }

  // _ProcessTypeAndQuantity: ISK as the client writes an amount of it; anything else as so many of an item.
  const itemText = (item: MissionItem): string | null => {
    if (item.typeID === null) return null;
    if (item.typeID === TYPE_CREDITS) return words(PANE_LABELS.isk, { amount: item.quantity });
    if (isCharacter(item.typeID)) return words(PANE_LABELS.referral, { agentID: item.typeID });
    return words(PANE_LABELS.quantityAndItem, { quantity: item.quantity, item: item.typeID });
  };
  const reward = (item: MissionItem, label: string | null = null): PaneRow[] => {
    const text = itemText(item);
    const info = itemInfo(item.typeID);
    return text === null ? [] : [{ mark: null, label, text, ...(info ? { info } : {}) }];
  };
  const entries = (items: readonly MissionItem[]): PaneRow[] => items.flatMap(item => reward(item));
  const section = (title: string, detail: string | null, rows: PaneRow[]): void => {
    const said = words(title);
    if (said !== null && rows.length > 0) blocks.push({ kind: "items", title: said, text: detail, rows });
  };

  const accepted = objectives.missionState === 2 || failed;
  section(PANE_LABELS.grantedItems, words(accepted ? PANE_LABELS.grantedDetailAccepted : PANE_LABELS.grantedDetail), entries(objectives.agentGift));

  const rewards = entries(objectives.normalRewards);
  if (objectives.loyaltyPoints > 0) {
    const text = words(PANE_LABELS.loyaltyPoints, { lpAmount: objectives.loyaltyPoints });
    if (text !== null) {
      const info = itemInfo(TYPE_LOYALTY_POINTS);
      rewards.push({ mark: null, label: null, text, ...(info ? { info } : {}) });
    }
  }
  if (objectives.researchPoints > 0) {
    const text = words(PANE_LABELS.researchPoints, { rpAmount: Math.round(objectives.researchPoints) });
    if (text !== null) rewards.push({ mark: null, label: null, text });
  }
  section(PANE_LABELS.rewardsTitle, words(PANE_LABELS.rewardsHeader), rewards);

  // Each bonus under its own line: how long is left to earn it, or that the time has passed.
  const bonuses = objectives.bonusRewards.flatMap((bonus) => {
    const header = bonus.timeRemaining > 0n ? words(PANE_LABELS.bonusHeader, { timeRemaining: bonus.timeRemaining.toString() }) : words(PANE_LABELS.bonusPassed);
    return reward(bonus, header);
  });
  section(PANE_LABELS.bonusTitle, null, bonuses);

  section(PANE_LABELS.collateralTitle, words(PANE_LABELS.collateralHeader), entries(objectives.collateral));

  if (objectives.missionExtra !== null && objectives.missionExtra.headerID !== null && objectives.missionExtra.bodyID !== null) {
    const none = { label: null, parameters: null, text: null, contentID: objectives.contentID };
    const title = context.say({ ...none, messageID: objectives.missionExtra.headerID });
    const text = context.say({ ...none, messageID: objectives.missionExtra.bodyID });
    if (title !== null && text !== null) blocks.push({ kind: "items", title, text, rows: [] });
  }
  return blocks;
}
