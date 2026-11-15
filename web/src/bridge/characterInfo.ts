// What a character's Show Info header reads (characterInfoWindow.py construct_header_character, 53 to 160), for a
// character that is no NPC, the three asked side by side:
//
//   info.GetPublicInfoForCharacter(charID)                 its Bio (description: TAB_BIO's text), its start in its
//                                                         corporation (startDateTime) and its militia
//                                                         (militiaFactionID): Tranquility's answer is a CRowset of one
//                                                         packed row (bounty, title, startDateTime, description,
//                                                         corporationID, militiaFactionID, bloodlineID)
//   corp.GetInfoWindowDataForChar(charID, 1)              its corporation, its alliance and its titles: title, then
//     (GetCorpRegistry().GetInfoWindowDataForChar)        title1 to title16, each one it holds a name, else None
//   crimewatchSvc.GetCharacterSecurityStatus(charID)      its security status
//     (CharGetCrimewatchLocation().GetCharacterSecurityStatus)
//
// A read that fails leaves its part of the header out, as the client's window has none of it.
//
// The window's Description is its bloodline's (update_description_caption_and_sub_caption, 185 to 199): an agent's
// by its row of the agents' table, any other character's by GetPublicInfo3's bloodlineID, an NPC's too.
import type { Ask } from "./ask.ts";
import { isKeyValValue, isListValue, readKeyVal, readRowField, unwrapLong, type JsonValue } from "./wire.ts";

export interface CharacterInfoHeader {
  /** Its Bio as written ("" where it has none: the window then has no Bio tab). */
  readonly description: string;
  readonly bloodlineID: number | null;
  /** When it joined its corporation (100 ns since 1601), or null. */
  readonly startDateTime: bigint | null;
  readonly militiaFactionID: number | null;
  readonly corporationID: number | null;
  readonly allianceID: number | null;
  /** Its titles as the window lists them: its own title, then each of the sixteen it holds. */
  readonly titles: readonly string[];
  readonly securityStatus: number | null;
}

const idOf = (value: JsonValue | undefined): number | null => {
  const id = Number(unwrapLong(value ?? null) ?? 0);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};
const textOf = (value: JsonValue | undefined): string => {
  if (typeof value === "string") return value;
  if (value !== null && typeof value === "object" && !Array.isArray(value) && typeof (value as { value?: unknown }).value === "string") return (value as { value: string }).value;
  return "";
};

/** GetPublicInfo3's row: the first of its rows (char_info[0]), a CRowset's packed row (a list's or a KeyVal's read too). */
export function publicInfoRow(answer: JsonValue): JsonValue | null {
  if (answer !== null && typeof answer === "object" && !Array.isArray(answer) && (answer as { type?: unknown }).type === "objectex2") {
    const rows = (answer as { list?: unknown }).list;
    return Array.isArray(rows) ? ((rows[0] as JsonValue | undefined) ?? null) : null;
  }
  if (isListValue(answer)) return answer.items[0] ?? null;
  return isKeyValValue(answer) ? answer : null;
}

/** info.GetPublicInfoForCharacter calls charMgr.GetPublicInfo3. Consumers use its first public row. */
export async function readCharacterPublicInfo(ask: Ask, characterID: number): Promise<JsonValue | null> {
  return publicInfoRow(await ask("charMgr", "GetPublicInfo3", [characterID]));
}

/** A non-agent's Description reads the bloodline from the same public row. */
export async function readCharacterBloodline(ask: Ask, characterID: number): Promise<number | null> {
  const row = await readCharacterPublicInfo(ask, characterID);
  return row === null ? null : idOf(readRowField(row, "bloodlineID"));
}

/** An NPC character's corporation, for one that is no agent (construct_header_character 111: corpmgr.GetCorporationIDForCharacter), or null. */
export async function readNpcCharacterCorporation(ask: Ask, characterID: number): Promise<number | null> {
  return idOf(await ask("corpmgr", "GetCorporationIDForCharacter", [characterID]));
}

/** The header's three reads, each failing by itself (to none of its part). */
export async function readCharacterInfoHeader(ask: Ask, characterID: number): Promise<CharacterInfoHeader> {
  const [publicInfo, corporation, security] = await Promise.allSettled([
    readCharacterPublicInfo(ask, characterID),
    ask("corpRegistry", "GetInfoWindowDataForChar", [characterID]),
    ask("crimewatch", "GetCharacterSecurityStatus", [characterID]),
  ]);
  const row = publicInfo.status === "fulfilled" ? publicInfo.value : null;
  const started = row === null ? null : unwrapLong(readRowField(row, "startDateTime") ?? null);
  const corp = corporation.status === "fulfilled" ? corporation.value : null;
  // construct_header_character 79 to 86: its own title, then title1 to title16, each one that is not empty.
  const titles = corp === null ? [] : ["title", ...Array.from({ length: 16 }, (_, at) => `title${at + 1}`)].map((key) => textOf(readKeyVal(corp, key))).filter((title) => title !== "");
  const securityValue = security.status === "fulfilled" ? security.value : null;
  const securityStatus = typeof securityValue === "number" ? securityValue : Number.isFinite(Number((securityValue as { value?: unknown } | null)?.value)) && securityValue !== null ? Number((securityValue as { value: unknown }).value) : null;
  return {
    description: row === null ? "" : textOf(readRowField(row, "description")),
    bloodlineID: row === null ? null : idOf(readRowField(row, "bloodlineID")),
    startDateTime: started === null || started <= 0n ? null : started,
    militiaFactionID: row === null ? null : idOf(readRowField(row, "militiaFactionID")),
    corporationID: corp === null ? null : idOf(readKeyVal(corp, "corpID")),
    allianceID: corp === null ? null : idOf(readKeyVal(corp, "allianceID")),
    titles,
    securityStatus,
  };
}
