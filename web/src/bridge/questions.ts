// Questions the SERVER asks the player.
//
// The server calls the client's own services and waits for the answer, and the
// retail client puts a window up for each:
//
//   agents.YesNo               a Yes/No window (before a mission is quit or
//                              declined, before research is cancelled)
//   agents.SingleChoiceBox     radio buttons with OK / Cancel (which field a
//                              research agent should work on)
//   agents.GetQuantity         a number box with OK / Cancel (how many
//                              datacores to buy)
//   XmppChat.AskYesNoQuestion  a Yes/No dialog (customs, over contraband)
//
// (eve/client/script/ui/station/agents/agents.py, xmppchatclient/xmppchatsvc.py.)
// On the game-port transport the BFF holds that call open, sends the question
// here on the pilot's event stream, and gives the server whatever comes back
// through POST /api/bridge/questions/:id/answer (src/gamePort/pilots.js).
//
// The server words a question with localisation labels, (labelID, parameters),
// or a dialog's name with its parameters, which only the retail client's own
// data turns into text. When the BFF has a client to read, the page has that
// text and fills it in. The few the server sends today are also worded here,
// in this client's words, for when it has not; any other label is shown as
// the label, which is at least true.

import type { ClientQuestion, QuestionAnswer, QuestionWords } from "../store/types.ts";
import type { NameKind, NameRef } from "../store/names.ts";
import {
  formatTemplate,
  plainText,
  prepareArguments,
  templateNameRefs,
  typedLabels,
  typedNameRefs,
  type TemplateArguments,
  type TypedContext,
} from "./clientWords.ts";
import type { JsonValue } from "./wire.ts";
import { intervalWriters } from "./timeInterval.ts";
import { fmtDist } from "../space/overview.ts";
import { DISTANCE_WORD_LABELS, distanceSay } from "../space/distanceWords.ts";

/**
 * The retail client's own text, when the page has it: its templates by label
 * (`store.words`), the character being flown (the client's `player` in every
 * message), and whatever else the client adds to this message's arguments
 * (for what an agent says, the agent's own IDs).
 */
export interface ClientWording {
  readonly templates: Readonly<Record<string, string | null>>;
  readonly playerID?: number | null;
  readonly extra?: TemplateArguments;
}

/** How a name is looked up for the words below: the page's name cache, or a stand-in. */
export type NameOf = (kind: NameKind, id: number) => string;

type Wording = string | ((parameters: Readonly<Record<string, JsonValue>>, nameOf: NameOf) => string);

/** A label's parameters, {type: "dict", entries: [[name, value], ...]}, by name. */
function parametersOf(value: unknown): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  const record = (value && typeof value === "object" && !Array.isArray(value) ? value : {}) as Record<string, JsonValue>;
  const entries = Array.isArray(record.entries) ? record.entries : [];
  for (const entry of entries) {
    if (Array.isArray(entry) && typeof entry[0] === "string") {
      out[entry[0]] = entry[1] ?? null;
    }
  }
  return out;
}

const wholeNumber = (value: JsonValue | undefined): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) ? value : null;

const finiteNumber = (value: JsonValue | undefined): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/**
 * The contraband list as customs sends it: (UE_LIST, [(UE_TYPEIDANDQUANTITY,
 * typeID, quantity), ...], separator). eveCfg.__prepdict's codes: 103 and 24.
 * The entries come in a list ({type: "list", items}); a tuple of them is read
 * too.
 */
function contrabandOf(value: JsonValue | undefined): Array<{ typeID: number; quantity: number }> {
  const given = Array.isArray(value) && value[0] === 103 ? value[1] : null;
  const listed = given && typeof given === "object" && !Array.isArray(given) && given.type === "list" ? given.items : given;
  const list = Array.isArray(listed) ? listed : [];
  const out: Array<{ typeID: number; quantity: number }> = [];
  for (const entry of list) {
    if (Array.isArray(entry) && entry[0] === 24) {
      const typeID = wholeNumber(entry[1]);
      const quantity = wholeNumber(entry[2]);
      if (typeID !== null && quantity !== null) {
        out.push({ typeID, quantity });
      }
    }
  }
  return out;
}

/** The faction as customs sends it: (UE_OWNERID, factionID). */
const ownerOf = (value: JsonValue | undefined): number | null =>
  Array.isArray(value) && value[0] === 2 ? wholeNumber(value[1]) : null;

/** This client's own words for a label, written as a template and filled the same way the client's are. */
const own = (template: string): Wording => (parameters, nameOf) => formatTemplate(template, parameters, { nameOf });

const JOURNAL = "UI/Journal/JournalWindow/Agents/";

const LABEL_WORDS: Readonly<Record<string, Wording>> = Object.freeze({
  // A mission's line in the journal (bridge/journalWords.ts says which the client picks).
  [`${JOURNAL}StateOffered`]: "Offered",
  [`${JOURNAL}StateAccepted`]: "Accepted",
  [`${JOURNAL}StateFailed`]: "Failed",
  [`${JOURNAL}StateOfferExpired`]: "Offer lapsed",
  [`${JOURNAL}StateMissionExpired`]: "Overdue",
  [`${JOURNAL}OfferExpiresAt`]: own("open until {[datetime]expirationTime, time=none}"),
  [`${JOURNAL}OfferExpiresAtExact`]: own("open until {[datetime]expirationTime}"),
  [`${JOURNAL}OfferExpiresIn`]: own("open for another {[timeinterval]expirationTime}"),
  [`${JOURNAL}OfferDoesNotExpire`]: "open with no end",
  [`${JOURNAL}OfferUndefinedExpiration`]: "no end given",
  [`${JOURNAL}OfferExpired`]: "no longer open",
  [`${JOURNAL}MissionExpiresAt`]: own("due by {[datetime]expirationTime, time=none}"),
  [`${JOURNAL}MissionExpiresAtExact`]: own("due by {[datetime]expirationTime}"),
  [`${JOURNAL}MissionExpiresIn`]: own("due in {[timeinterval]expirationTime}"),
  [`${JOURNAL}MissionDoesNotExpire`]: "no deadline",
  [`${JOURNAL}MissionUndefinedExpiration`]: "no deadline given",
  [`${JOURNAL}MissionExpired`]: "past its deadline",
  [`${JOURNAL}ImportantMission`]: own("{missionType} (important)"),
  "UI/Agents/StandardMission/DeclineMissionTitle": "Decline mission",
  "UI/Agents/StandardMission/DeclineMessage":
    "Decline this mission? Declining a second one from the same agent within four hours costs standing with them.",
  "UI/Agents/StandardMission/QuitMissionTitle": "Quit mission",
  "UI/Agents/StandardMission/QuitMissionMessage":
    "Quit this mission? It cannot be taken up again, and it costs standing with this agent and their corporation.",
  "UI/Agents/Research/CancelResearchQuestion": "Cancel research",
  "UI/Agents/Research/SureToCancelResearch":
    "Cancel your research with this agent? The research points gathered with them are lost.",
  "UI/Agents/Research/SureToCancelResearchAndMission":
    "Cancel your research with this agent? The research points gathered with them are lost, and the mission you have open with them counts as failed.",
  "UI/Agents/Research/SelectResearchTypeTitle": "Choose a field of research",
  "UI/Agents/Research/SelectResearchTypeMessage": "Which field should this agent research for you?",
  "UI/Agents/Research/SkillListing": (parameters, nameOf) => {
    const skillID = wholeNumber(parameters.skillID);
    const level = wholeNumber(parameters.skillLevel);
    const name = skillID === null ? "A skill" : nameOf("type", skillID);
    return level === null ? name : `${name} (level ${level})`;
  },
  "UI/Agents/Research/Datacores": "Buy datacores",
  "UI/Agents/Research/DatacorePrice": (parameters, nameOf) => {
    const typeID = wholeNumber(parameters.datacoreTypeID);
    const points = finiteNumber(parameters.rpAmount);
    const isk = finiteNumber(parameters.iskAmount);
    const name = typeID === null ? "A datacore" : nameOf("type", typeID);
    return `${name}: each costs ${points === null ? "?" : points.toLocaleString("en-US")} research points and ${
      isk === null ? "?" : isk.toLocaleString("en-US")
    } ISK. How many?`;
  },
  ChtCustomsConfiscationConfirmation2: (parameters, nameOf) => {
    const goods = contrabandOf(parameters.contraband)
      .map(({ typeID, quantity }) => `${quantity.toLocaleString("en-US")} × ${nameOf("type", typeID)}`)
      .join(", ");
    const factionID = ownerOf(parameters.empire);
    const who = factionID === null ? "Customs" : `${nameOf("faction", factionID)} customs`;
    return `${who} has found contraband in your cargo${goods ? `: ${goods}` : ""}. Hand it over?`;
  },
});

function decodeWords(value: JsonValue | undefined): QuestionWords {
  const record = (value && typeof value === "object" && !Array.isArray(value) ? value : {}) as Record<string, JsonValue>;
  const words = {
    label: typeof record.label === "string" ? record.label : null,
    parameters: record.parameters ?? null,
    text: typeof record.text === "string" ? record.text : null,
  };
  // A dialog's title or body: both the name and which of the two, or neither.
  const part = record.part === "title" || record.part === "body" ? record.part : null;
  return typeof record.dialog === "string" && DIALOG_NAME.test(record.dialog) && part !== null
    ? { ...words, dialog: record.dialog, part }
    : words;
}

/** A `question` event off the pilot's stream, or null when it is not one this client can show. */
export function decodeQuestion(value: JsonValue | undefined): ClientQuestion | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, JsonValue>;
  const kind = record.kind;
  if (typeof record.id !== "string" || record.id === "" || (kind !== "yesNo" && kind !== "choice" && kind !== "quantity")) {
    return null;
  }
  const choices = kind === "choice" && Array.isArray(record.choices) ? record.choices.map(decodeWords) : [];
  const limits = (kind === "quantity" && record.quantity && typeof record.quantity === "object" && !Array.isArray(record.quantity)
    ? record.quantity
    : null) as Record<string, JsonValue> | null;
  // A choice with nothing to choose from, or a number box with no limits, is not something to show.
  if ((kind === "choice" && choices.length === 0) || (kind === "quantity" && limits === null)) {
    return null;
  }
  return {
    id: record.id,
    service: typeof record.service === "string" ? record.service : "",
    method: typeof record.method === "string" ? record.method : "",
    kind,
    title: decodeWords(record.title),
    body: decodeWords(record.body),
    agentID: wholeNumber(record.agentID),
    contentID: wholeNumber(record.contentID),
    suppressID: typeof record.suppressID === "string" ? record.suppressID : null,
    askedAtMs: wholeNumber(record.askedAtMs) ?? 0,
    expiresAtMs: wholeNumber(record.expiresAtMs) ?? 0,
    choices,
    quantity: limits === null
      ? null
      : {
          min: finiteNumber(limits.min) ?? 0,
          max: finiteNumber(limits.max),
          initial: finiteNumber(limits.initial),
          digits: wholeNumber(limits.digits) ?? 0,
        },
  };
}

/** Names with no cache behind them: the ID, said plainly. */
const nameByID: NameOf = (kind, id) => `${kind} ${id}`;

/** A dialog's name as the BFF takes one: letters, digits and underscores. */
const DIALOG_NAME = /^\w{1,100}$/;

/** The dialog and the part a words key names, or null when the key is a label or a message's number. */
export function dialogOfKey(key: string): { name: string; part: "title" | "body" | "suppressable" | "suppress" | "type" | "audio" } | null {
  // "suppressable": whether the install lets the dialog's answer be kept ("1"), for "do not ask again"
  // (dialogSuppression.ts). "suppress": which answer it lets be kept ("any", "yes" or "no"; eveCfg.py
  // GetSuppressValueForMessage). "type": the dialog's type, which says how the client puts it up (ClientDialogs.svelte).
  // "audio": the Wwise event the audio service sends as it is said (urlAudio; AudioMessage), "" where it has none.
  const match = /^dialog:(\w{1,100})\/(title|body|suppressable|suppress|type|audio)$/.exec(key);
  return match ? { name: match[1] as string, part: match[2] as "title" | "body" | "suppressable" | "suppress" | "type" | "audio" } : null;
}

/**
 * What some words are kept under in `store.words`: "dialog:", their dialog's
 * name, a slash and "title" or "body"; or their label; or "#" and their
 * message's number. Null for plain text and for nothing.
 */
export function wordsKey(words: QuestionWords): string | null {
  if (typeof words.dialog === "string" && (words.part === "title" || words.part === "body")) {
    return `dialog:${words.dialog}/${words.part}`;
  }
  if (words.label !== null) {
    return words.label;
  }
  return typeof words.messageID === "number" ? `#${words.messageID}` : null;
}

/** A mission's keywords, or any dict the bridge carried, by name. */
export function argumentsOf(value: unknown): TemplateArguments {
  return parametersOf(value);
}

/**
 * A label's arguments: what the client adds, then what the server sent with
 * it, which wins. A dialog's are prepared first as the client prepares them,
 * its typed values turned to text (cfg.__prepdict).
 */
/**
 * How the client's words are filled for a question or a dialog: names, the pilot, the install's templates, and an
 * interval, a distance and ISK written the client's way where its words for them are to hand.
 */
function wordingContext(client: ClientWording, nameOf: NameOf): TypedContext {
  return {
    nameOf,
    playerID: client.playerID ?? null,
    templates: client.templates,
    ...intervalWriters(client.templates),
    // A distance in the client's units and its words for them, where they are to hand (DISTANCE_WORD_LABELS).
    writeDistance: (meters, decimalPlaces) => fmtDist(meters, decimalPlaces, distanceSay(client.templates)),
    writeIsk: (amount, decimalPlaces) => iskWords(amount, decimalPlaces, client.templates, nameOf),
  };
}

function argumentsFor(words: QuestionWords, client: ClientWording, nameOf: NameOf): TemplateArguments {
  const given = parametersOf(words.parameters);
  // A dialog's typed values worded as the client prepares them (cfg.__prepdict), with the same writers.
  const sent = typeof words.dialog === "string" ? prepareArguments(given, wordingContext(client, nameOf)) : given;
  return { ...(client.extra ?? {}), ...sent };
}

/**
 * The retail client's own text for some words, filled in, with the client's markup still in it (`<br>`,
 * `<b>` and the like); null when the page does not have the client's text for them. For text the client
 * tidies before drawing it. Plain text has no markup and is not answered here.
 */
export function questionMarkup(words: QuestionWords, nameOf: NameOf, client: ClientWording): string | null {
  const key = wordsKey(words);
  const template = key !== null ? client.templates[key] : null;
  return typeof template === "string" ? formatTemplate(template, argumentsFor(words, client, nameOf), wordingContext(client, nameOf)) : null;
}

/** The labels a dialog's numeric values are written with: a distance's units, and ISK's (ISK_LABELS). */
export const NUMERIC_WORD_LABELS: readonly string[] = [...DISTANCE_WORD_LABELS, "UI/Util/FmtIsk", "UI/Util/FmtIskNoDecimal"];

/**
 * eveFormat.FmtISK(value, showFractionsAlways) by FmtCurrency: the label of ISK with fractions or without
 * (UI/Util/FmtIsk, UI/Util/FmtIskNoDecimal), the amount rounded half away from nought where without; null where the
 * label is not to hand.
 */
export function iskWords(amount: number, decimalPlaces: number, templates: ClientWording["templates"], nameOf: NameOf): string | null {
  const fractions = decimalPlaces > 0;
  const template = templates[fractions ? "UI/Util/FmtIsk" : "UI/Util/FmtIskNoDecimal"];
  if (typeof template !== "string") return null;
  const shown = fractions ? amount : Math.sign(amount) * Math.round(Math.abs(amount));
  return plainText(formatTemplate(template, { amount: shown }, { nameOf }));
}

/**
 * What to show for a title, a body, a choice or an agent's line: its text;
 * the retail client's own text for its label, filled in, when the page has
 * it; failing that this client's words for the label; failing that the label
 * itself.
 */
export function questionText(words: QuestionWords, nameOf: NameOf = nameByID, client: ClientWording | null = null): string {
  if (words.text !== null) {
    return words.text;
  }
  const marked = client === null ? null : questionMarkup(words, nameOf, client);
  if (marked !== null) {
    return plainText(marked);
  }
  if (words.label === null && typeof words.messageID === "number") {
    // A mission's own text that the page does not have: its number, which is what the server sent.
    return String(words.messageID);
  }
  if (words.label !== null) {
    const wording = LABEL_WORDS[words.label];
    if (wording === undefined) {
      return words.label;
    }
    return typeof wording === "string" ? wording : wording(parametersOf(words.parameters), nameOf);
  }
  return "";
}

/**
 * The labels, message numbers and dialogs among some words, as their keys,
 * for the page to ask the client's text of; and with a dialog, the labels its
 * typed values are worded with.
 */
export function wordsLabels(all: ReadonlyArray<QuestionWords | null | undefined>): string[] {
  const keys: string[] = [];
  for (const words of all) {
    const key = words ? wordsKey(words) : null;
    const more = words && typeof words.dialog === "string" ? typedLabels(parametersOf(words.parameters)) : [];
    for (const each of key === null ? more : [key, ...more]) {
      if (!keys.includes(each)) {
        keys.push(each);
      }
    }
  }
  return keys;
}

/** The names some words need, whichever way they end up worded, for the page's name cache to fetch. */
export function wordsNameRefs(all: ReadonlyArray<QuestionWords | null | undefined>, client: ClientWording | null = null): NameRef[] {
  const refs: NameRef[] = [];
  for (const words of all) {
    if (!words) {
      continue;
    }
    const key = wordsKey(words);
    const template = client && key !== null ? client.templates[key] : null;
    if (typeof template === "string") {
      refs.push(...templateNameRefs(template, argumentsFor(words, client as ClientWording, nameByID), { playerID: client?.playerID ?? null }));
      if (typeof words.dialog === "string") {
        // What the dialog's typed values name: they are text by the time the template is filled.
        refs.push(...typedNameRefs(parametersOf(words.parameters), client?.templates));
      }
      continue;
    }
    const parameters = parametersOf(words.parameters);
    for (const name of ["skillID", "datacoreTypeID"]) {
      const typeID = wholeNumber(parameters[name]);
      if (typeID !== null) {
        refs.push({ kind: "type", id: typeID });
      }
    }
    for (const { typeID } of contrabandOf(parameters.contraband)) {
      refs.push({ kind: "type", id: typeID });
    }
    const factionID = ownerOf(parameters.empire);
    if (factionID !== null) {
      refs.push({ kind: "faction", id: factionID });
    }
  }
  return refs;
}

/** The names a question's words need, for the page's name cache to fetch. */
export function questionNameRefs(question: ClientQuestion, client: ClientWording | null = null): NameRef[] {
  return wordsNameRefs([question.title, question.body, ...question.choices], client);
}

/**
 * Whether an answer is one the question's own window could have given: the
 * BFF refuses any other, so the page does not offer one.
 */
export function answerFits(question: ClientQuestion, answer: QuestionAnswer): boolean {
  switch (question.kind) {
    case "yesNo":
      return typeof answer === "boolean";
    case "choice":
      return typeof answer === "object" && answer !== null && Number.isSafeInteger(answer.index) &&
        answer.index >= 0 && answer.index < question.choices.length;
    case "quantity": {
      if (answer === null) {
        return true;
      }
      const limits = question.quantity;
      return typeof answer === "number" && Number.isFinite(answer) && limits !== null &&
        (limits.digits > 0 || Number.isInteger(answer)) && answer >= limits.min &&
        (limits.max === null || answer <= limits.max);
    }
  }
}

/**
 * Which agents' buttons a bot of this page is pressing right now.
 *
 * A bot that presses Decline has decided; the server's "are you sure" about
 * that press is answered Yes without being put to the user, who did not press
 * anything. A press by the user is not tracked here, and its question is shown.
 */
export interface BotPresses {
  /** Run one press; the agent counts as being pressed by a bot until it settles, however it settles. */
  during<T>(agentID: number, press: () => Promise<T>): Promise<T>;
  /** Whether a question is the server asking about a press that is in flight. */
  answers(question: ClientQuestion): boolean;
}

export function createBotPresses(): BotPresses {
  const inFlight = new Map<number, number>();
  return {
    async during(agentID, press) {
      inFlight.set(agentID, (inFlight.get(agentID) ?? 0) + 1);
      try {
        return await press();
      } finally {
        const left = (inFlight.get(agentID) ?? 1) - 1;
        if (left > 0) {
          inFlight.set(agentID, left);
        } else {
          inFlight.delete(agentID);
        }
      }
    },
    answers(question) {
      return question.kind === "yesNo" && question.agentID !== null && inFlight.has(question.agentID);
    },
  };
}

// ── a question's title, and its answer kept ("do not ask again") ─────────────
//
// What a question is put up as, by what asks it:
//
//   XmppChat.AskYesNoQuestion   a dialog of the install's by its name (prompt_player_fsd_dialog, YESNO; dialog_handler
//                               _handle_player_fsd_dialog and _prompt_player): titled with the dialog's title, else
//                               its type's own word (TITLE_BY_DIALOG_TYPE, 24 to 29; Information for any other); a
//                               dialog the install marks suppressable has the box "/Carbon/UI/Common/DoNotAskAgain"
//                               (messagebox.py prompt_player, 164 to 168); ticked, the answer is kept where the dialog
//                               lets it be (_persist_prompt_suppress_choice, 126 to 132).
//   agents.YesNo with a suppressID   the agent's box (agents.py ShowMessageWindow, 432 to 437; ui_message.py
//                               prompt_player, 21 to 42), with the box "UI/Common/SuppressionShowMessage"; ticked, any
//                               answer but No, Close or Cancel is kept.
//   agents.SingleChoiceBox with a suppressID   its radio box (agents.py 439 to 468), with the box
//                               "UI/Common/SuppressionShowMessageRemember"; ticked, the answer is kept whatever it is,
//                               the button and the choice.
//
// An answer kept is the answer: the question is not put up (dialog_handler 59 to 64; prompt_player 22 to 25;
// SingleChoiceBox 460 to 462). The client keeps them all in one place, settings.user.suppress, under 'suppress.' and
// the dialog's name or the suppressID; so does the page (AppFlow.keepQuestionAnswer).

/** TITLE_BY_DIALOG_TYPE: a dialog type's own word, for a box whose dialog has no title. */
export const DIALOG_TYPE_TITLES: Readonly<Record<string, string>> = {
  info: "UI/Common/Information",
  infomodal: "UI/Common/Information",
  warning: "UI/Generic/Warning",
  question: "UI/Common/Question",
  error: "UI/Common/Error",
  fatal: "UI/Common/Fatal",
};
/** The title of a box whose dialog has none and whose type has no word of its own. */
export const INFORMATION_TITLE = "UI/Common/Information";
/** The page's own words for those, where the install's are not to hand. */
export const OWN_DIALOG_TITLES: Readonly<Record<string, string>> = {
  "UI/Common/Information": "Information",
  "UI/Generic/Warning": "Warning",
  "UI/Common/Question": "Question",
  "UI/Common/Error": "Error",
  "UI/Common/Fatal": "Fatal",
};
/** The agents' boxes' words (agents.py 435 and 465). */
export const SUPPRESSION_SHOW_MESSAGE = "UI/Common/SuppressionShowMessage";
export const SUPPRESSION_SHOW_MESSAGE_REMEMBER = "UI/Common/SuppressionShowMessageRemember";

/** How a question's answer may be kept: by the dialog it is, or by the agent's suppressID; null where it may not. */
export type QuestionKeeping =
  | { readonly kind: "dialog"; readonly key: string }
  | { readonly kind: "agentYesNo"; readonly key: string }
  | { readonly kind: "agentChoice"; readonly key: string };

/** The dialog a question is, where it is one of the install's (AskYesNoQuestion's), by its name; else null. */
export function questionDialog(question: ClientQuestion): string | null {
  return typeof question.body.dialog === "string" && question.body.dialog !== "" ? question.body.dialog : null;
}

export function questionKeeping(question: ClientQuestion): QuestionKeeping | null {
  const dialog = questionDialog(question);
  if (dialog !== null) return question.kind === "yesNo" ? { kind: "dialog", key: dialog } : null;
  if (question.suppressID === null || question.suppressID === "") return null;
  if (question.kind === "yesNo") return { kind: "agentYesNo", key: question.suppressID };
  if (question.kind === "choice") return { kind: "agentChoice", key: question.suppressID };
  return null;
}

/** The answer a kept one gives a question (`kept` as AppFlow keeps it); undefined where none is kept or it fits not. */
export function keptQuestionAnswer(question: ClientQuestion, kept: string | null): QuestionAnswer | undefined {
  const keeping = questionKeeping(question);
  if (keeping === null || kept === null) return undefined;
  if (keeping.kind === "agentChoice") {
    const match = /^choice:(ok|cancel):(\d+)$/.exec(kept);
    if (match === null) return undefined;
    const answer = { confirmed: match[1] === "ok", index: Number(match[2]) };
    return answerFits(question, answer) ? answer : undefined;
  }
  // A YESNO question's kept Yes or No (an OK kept by another dialog's box answers no Yes either: ID_OK is not ID_YES).
  return kept === "yes" ? true : kept === "no" || kept === "ok" ? false : undefined;
}

/**
 * What to keep of an answer given with the box ticked, or null where it is not kept: a dialog's where the dialog lets
 * that answer be kept (`dialogSuppress`, its "suppress" words: "any", "yes" or "no"); an agent's Yes; an agent's
 * choice whatever it is.
 */
export function keptValueOf(question: ClientQuestion, answer: QuestionAnswer, dialogSuppress: string | null | undefined): string | null {
  const keeping = questionKeeping(question);
  if (keeping === null) return null;
  if (keeping.kind === "agentChoice") {
    return answer !== null && typeof answer === "object" ? `choice:${answer.confirmed ? "ok" : "cancel"}:${answer.index}` : null;
  }
  if (typeof answer !== "boolean") return null;
  if (keeping.kind === "agentYesNo") return answer ? "yes" : null;
  const said = answer ? "yes" : "no";
  return dialogSuppress === "any" || dialogSuppress === said ? said : null;
}
