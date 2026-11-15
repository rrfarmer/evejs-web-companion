// EditMemberDialog.LoadChar and OnTabGeneral: the registry member and charMgr's private row.
import { isListValue, readDictEntry, readRowField, unwrapLong, type JsonValue } from "./wire.ts";
import type { CorporationRoleGroup, GrantMasks } from "./corporationRoles.ts";

export const MEMBER_ROLE_FIELDS = ["roles", "grantableRoles", "rolesAtHQ", "grantableRolesAtHQ", "rolesAtBase", "grantableRolesAtBase", "rolesAtOther", "grantableRolesAtOther"] as const;
export type MemberDetailsTabID = "general" | "roles" | "titles" | "roles_summary";
export interface MemberDetailsRequest {
  readonly characterID: number;
  readonly n: number;
  readonly tabID?: MemberDetailsTabID;
}

/** TabGroup.AutoSelect falls back to General. Accept the companion's earlier saved summary ID. */
export function memberDetailsSavedTab(value: string | null | undefined): MemberDetailsTabID {
  if (value === "summary") return "roles_summary";
  if (value === "roles" || value === "titles" || value === "roles_summary") return value;
  return "general";
}

export interface CorporationMember {
  readonly characterID: number;
  readonly corporationID: number;
  readonly title: string;
  readonly baseID: number | null;
  readonly divisionID: number | null;
  readonly squadronID: number | null;
  readonly titleMask: number;
  readonly startDateTime: bigint;
  readonly masks: Readonly<Record<typeof MEMBER_ROLE_FIELDS[number], bigint>>;
}
export interface CorporationMemberDetails {
  /** Page owner/window lifetime, retained by local drafts; never sent to the server. */
  readonly assertCurrent?: () => void;
  readonly member: CorporationMember;
  readonly name: string;
  readonly viewerIsCEO: boolean;
  readonly targetIsCEO: boolean;
  readonly canEditBase: boolean;
  readonly canEditTitle: boolean;
  readonly viewerIsDirector: boolean;
  readonly myBaseID: number | null;
  readonly grants: GrantMasks;
  readonly roleGroups: readonly CorporationRoleGroup[];
  readonly raceNameID: number;
  readonly gender: number;
  readonly createDateTime: bigint;
  readonly security: number;
  readonly bases: readonly { readonly stationID: number; readonly name: string }[];
}
export function memberField(row: JsonValue, key: string): JsonValue | undefined {
  const value = readRowField(row, key);
  if (value !== undefined) return value;
  if (row && typeof row === "object" && !Array.isArray(row)) {
    const record = row as Readonly<Record<string, JsonValue>>;
    // charMgr.GetPrivateInfo is util.Row(header,line), alongside the registry's packed DBRow.
    const header = readDictEntry(record.args, "header"), line = readDictEntry(record.args, "line");
    if (isListValue(header) && isListValue(line)) return line.items[header.items.indexOf(key)];
    return record[key];
  }
  return undefined;
}
export function memberInteger(row: JsonValue, key: string): bigint | null {
  const value = memberField(row, key);
  return typeof value === "string" && /^-?\d+$/.test(value) ? BigInt(value) : unwrapLong(value);
}
export function corporationMemberOf(row: JsonValue): CorporationMember {
  const number = (key: string) => Number(memberInteger(row, key) ?? 0n);
  if (!number("characterID")) throw new Error("That corporation member could not be read.");
  const value = memberField(row, "title");
  const title = typeof value === "string" ? value : value && typeof value === "object" && "value" in value && typeof value.value === "string" ? value.value : "";
  return { characterID: number("characterID"), corporationID: number("corporationID"), title, baseID: number("baseID") || null,
    divisionID: memberInteger(row, "divisionID") === null ? null : number("divisionID"), squadronID: memberInteger(row, "squadronID") === null ? null : number("squadronID"), titleMask: number("titleMask"), startDateTime: memberInteger(row, "startDateTime") ?? 0n,
    masks: Object.fromEntries(MEMBER_ROLE_FIELDS.map(key => [key, memberInteger(row, key) ?? 0n])) as CorporationMember["masks"] };
}

/** DDXTabGeneral: StripTags(..., stripOnly=['font','fontsize','br']), with the client's case-sensitive patterns. */
export function memberTitleOf(text: string): string {
  return text.replace(/<\/(?:font|fontsize|br)>|<(?:font|fontsize|br)>|<(?:font|fontsize|br) .*?>|<(?:font|fontsize|br) *=.*?>|<(?:font|fontsize|br)\/>/g, "");
}
