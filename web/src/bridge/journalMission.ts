import { decodeObjectives, type MissionObjectives } from "./missionObjectives.ts";
import { readDictEntry, unwrapLong } from "./wire.ts";

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
