import { decodeObjectives, type MissionObjectives } from "./missionObjectives.ts";
import { argumentsOf, questionMarkup, type ClientWording, type NameOf } from "./questions.ts";
import { readDictEntry, unwrapLong, type JsonValue } from "./wire.ts";
import type { QuestionWords } from "../store/types.ts";

/** Mission HTML uses RGB font colors. LabelText expects ARGB. */
export function missionMarkup(text: string): string {
  return text.replace(/(<font\b[^<>]*?\bcolor\s*=\s*["']?)#([\da-f]{6})(?=["'\s>])/gi,
    (_, attr: string, color: string) => `${attr}0xff${color}`);
}

export interface JournalMissionDetails {
  readonly contentID: number | null;
  readonly state: number | null;
  readonly name: string | number | null;
  readonly briefing: string | number | null;
  readonly expiration: string | null;
  readonly image: string | null;
  readonly objectives: MissionObjectives;
}

/** GetMissionJournalInfo contains the briefing and the same objective dictionary as the agent dialogue. */
export function decodeJournalMissionDetails(raw: unknown): JournalMissionDetails | null {
  const read = (key: string) => readDictEntry(raw, key);
  const number = (key: string) => {
    const value = unwrapLong(read(key));
    return value !== null && Number.isSafeInteger(Number(value)) ? Number(value) : null;
  };
  const message = (key: string) => {
    const value = read(key);
    return typeof value === "string" ? value : number(key);
  };
  const objectives = decodeObjectives(read("objectives"));
  if (objectives === null) return null;
  const markup = read("missionImage");
  // The wire carries an EVE image tag. Only use resource paths in the mission art directory.
  const image = typeof markup === "string"
    ? markup.match(/<img\b[^<>]*?\bsrc=["']?(res:\/ui\/netres\/mission_content\/[a-z0-9_]+\.(?:png|jpg|dds))(?=["'\s>])/i)?.[1] ?? null
    : null;
  return {
    contentID: number("contentID"),
    state: number("missionState"),
    name: message("missionNameID"),
    briefing: message("briefingTextID"),
    expiration: unwrapLong(read("expirationTime"))?.toString() ?? null,
    image,
    objectives,
  };
}

/** Agent ProcessMessage resolves tuple-valued arguments before filling the outer label. */
function nestedPhrase(value: JsonValue | undefined): QuestionWords | null {
  if (value == null || typeof value !== "object") return null;
  const tuple = Array.isArray(value) ? value : "type" in value && value.type === "tuple" ? value.items : null;
  if (!Array.isArray(tuple) || tuple.length !== 2) return null;
  const [key, args] = tuple;
  if (args == null || typeof args !== "object" || Array.isArray(args) || args.type !== "dict") return null;
  if (typeof key === "string") return { label: key, parameters: args, text: null };
  const id = unwrapLong(key);
  if (id === null || id <= 0n || id > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return { label: null, messageID: Number(id), parameters: args, text: null };
}

export function journalMessagePhrases(phrase: QuestionWords): QuestionWords[] {
  return [phrase, ...Object.values(argumentsOf(phrase.parameters)).flatMap(value => {
    const child = nestedPhrase(value);
    return child ? journalMessagePhrases(child) : [];
  })];
}

export function journalMessageMarkup(phrase: QuestionWords, nameOf: NameOf, client: ClientWording): string | null {
  const parameters = Object.entries(argumentsOf(phrase.parameters)).map(([key, value]) => {
    const child = nestedPhrase(value);
    return [key, child ? journalMessageMarkup(child, nameOf, client) ?? "" : value];
  });
  return questionMarkup({ ...phrase, parameters: { type: "dict", entries: parameters } }, nameOf, client);
}
