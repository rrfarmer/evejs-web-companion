// corp_util.CanEditRole, bco_members.GetMyGrantableRoles and EditMemberDialog's role views.
import { MEMBER_ROLE_FIELDS, memberField, memberInteger, type CorporationMember } from "./corporationMemberDetails.ts";
import { readDictPairs, type JsonValue } from "./wire.ts";
import { intDictOrder } from "./py27DictOrder.ts";

export type RoleMasks = CorporationMember["masks"];
export type RoleField = "roles" | "rolesAtHQ" | "rolesAtBase" | "rolesAtOther";
export interface CorporationRoleSpec { readonly nameID: number; readonly descriptionID: number; readonly roleName: string }
export interface CorporationRoleGroupSpec {
  readonly appliesTo: RoleField;
  readonly appliesToGrantable: "grantableRoles" | "grantableRolesAtHQ" | "grantableRolesAtBase" | "grantableRolesAtOther";
  readonly isDivisional: number;
  readonly roleGroupNameID: number;
  readonly roleMask: string | number;
}
export interface CorporationRoleData {
  readonly roles: Readonly<Record<string, CorporationRoleSpec>>;
  readonly groups: Readonly<Record<string, CorporationRoleGroupSpec>>;
  readonly order: readonly number[];
  readonly locationalRoles: readonly string[];
}
export interface CorporationRole extends CorporationRoleSpec { readonly roleID: bigint; readonly summaryName: string }
export interface CorporationRoleGroup extends CorporationRoleGroupSpec { readonly groupID: number; readonly roles: readonly CorporationRole[] }
export type GrantMasks = Readonly<Record<RoleField, bigint>>;
export type CorporationTitle = RoleMasks & { readonly titleID: number; readonly titleName: string };

export function memberRoleGroups(data: CorporationRoleData, name: (id: number) => string, query: string, take: string, divisionName: (division: number) => string, combineName: (role: string, name: string) => string): readonly CorporationRoleGroup[] {
  const roles = Object.entries(data.roles).map(([bit, role]) => ({ ...role, roleID: 1n << BigInt(bit), summaryName: name(role.nameID) }));
  const cmp = (a: string, b: string) => a.toUpperCase() < b.toUpperCase() ? -1 : a.toUpperCase() > b.toUpperCase() ? 1 : 0;
  return intDictOrder(data.order).map(groupID => {
    const group = data.groups[groupID]!;
    const included = roles.filter(role => (role.roleID & BigInt(group.roleMask)) === role.roleID);
    if (group.isDivisional) {
      const division = (role: CorporationRole) => Number(role.roleName.slice(-1));
      const desc = (role: CorporationRole) => role.roleName.startsWith("roleAccount") ? "" : role.roleName.includes("CanTake") ? take : role.roleName.includes("CanQuery") ? query : "";
      included.sort((a, b) => division(a) - division(b) || cmp(desc(a), desc(b)));
      for (let i = 0; i < included.length; i++) {
        const role = included[i]!, column = divisionName(division(role) + (role.roleName.startsWith("roleAccount") ? 7 : 0)), subcolumn = desc(role);
        included[i] = { ...role, summaryName: subcolumn ? combineName(column, subcolumn) : column };
      }
    } else included.sort((a, b) => cmp(name(a.nameID), name(b.nameID)));
    return { ...group, groupID, roles: included };
  });
}

/** base_corporation.Role(roleID, roleName, shortDescription, description): its localized name and description. */
export interface RoleGroupingRole { readonly roleID: bigint; readonly roleName: string; readonly shortDescription: string; readonly description: string }
/** One of a role grouping's columns: its name and its (sub-column name, role) pairs. */
export interface RoleGroupingColumn { readonly name: string; readonly subColumns: readonly { readonly name: string; readonly role: RoleGroupingRole }[] }
export interface RoleGrouping extends CorporationRoleGroupSpec { readonly roleGroupID: number; readonly columns: readonly RoleGroupingColumn[] }

/**
 * base_corporation.GetRoleGroupings(forTitles): per role group (in the groups dict's order), a divisional group's columns
 * are its divisions (rolesByDivisions' keys in dict order), each named from GetDivisionNames - an account group's at
 * division + 7 - with its roles as sub-columns sorted by Take / Query (an account role's is ''); any other group's
 * columns are its roles sorted by their localized names' upper case (the Director role left out for titles), each one
 * sub-column named ''.
 */
export function roleGroupings(data: CorporationRoleData, forTitles: boolean, name: (messageID: number) => string, query: string, take: string, divisionName: (division: number) => string): readonly RoleGrouping[] {
  const roles = intDictOrder(Object.keys(data.roles).map(Number)).map(bit => {
    const spec = data.roles[bit]!;
    return { roleID: 1n << BigInt(bit), roleName: spec.roleName, shortDescription: name(spec.nameID), description: name(spec.descriptionID) };
  });
  const upper = (text: string) => text.toUpperCase();
  return intDictOrder(data.order).map(roleGroupID => {
    const group = data.groups[roleGroupID]!, mask = BigInt(group.roleMask);
    const columns: RoleGroupingColumn[] = [];
    if (group.isDivisional) {
      const byDivision = new Map<number, { name: string; role: RoleGroupingRole }[]>();
      let isAccount = false;
      for (const role of roles) {
        if ((role.roleID & mask) !== role.roleID) continue;
        const division = Number(role.roleName.slice(-1));
        let desc = role.roleName.includes("CanTake") ? take : role.roleName.includes("CanQuery") ? query : "";
        if (role.roleName.startsWith("roleAccount")) { isAccount = true; desc = ""; }
        if (!byDivision.has(division)) byDivision.set(division, []);
        byDivision.get(division)!.push({ name: desc, role });
      }
      for (const division of intDictOrder([...byDivision.keys()])) {
        // sort(lambda a, b: -(a.upper() < b.upper())): list.sort reads only "less than", so a stable ascending sort.
        const subColumns = byDivision.get(division)!.slice().sort((a, b) => upper(a.name) < upper(b.name) ? -1 : upper(b.name) < upper(a.name) ? 1 : 0);
        columns.push({ name: divisionName(division + (isAccount ? 7 : 0)), subColumns });
      }
    } else {
      const sorted = roles.slice().sort((a, b) => upper(a.shortDescription) < upper(b.shortDescription) ? -1 : upper(b.shortDescription) < upper(a.shortDescription) ? 1 : 0);
      for (const role of sorted) {
        if (forTitles && role.roleID === 1n) continue;
        if ((role.roleID & mask) === role.roleID) columns.push({ name: role.shortDescription, subColumns: [{ name: "", role }] });
      }
    }
    return { ...group, roleGroupID, columns };
  });
}

export interface CorporationRoleSummaryRow {
  readonly name: string;
  readonly role: boolean;
  readonly grantable: boolean;
  readonly byTitle: boolean;
  readonly titles: readonly string[];
}
export interface CorporationRoleSummaryGroup { readonly groupID: number; readonly nameID: number; readonly rows: readonly CorporationRoleSummaryRow[] }

/** Compiled OnTabRolesSummary: current direct draft, but the loaded member's titleMask. */
export function memberRolesSummary(groups: readonly CorporationRoleGroup[], draft: RoleMasks, memberTitleMask: number, targetIsCEO: boolean, titles: readonly CorporationTitle[], showTitleNames: boolean): readonly CorporationRoleSummaryGroup[] {
  const director = (draft.roles & 1n) !== 0n;
  return groups.flatMap(group => {
    const selected = titles.filter(title => (memberTitleMask & title.titleID) === title.titleID && (title[group.appliesTo] & BigInt(group.roleMask)) !== 0n);
    const rows = group.roles.flatMap(role => {
      const sources = selected.filter(title => (title[group.appliesTo] & role.roleID) !== 0n);
      const direct = targetIsCEO || director || (draft[group.appliesTo] & role.roleID) === role.roleID;
      const grantable = targetIsCEO || (director ? role.roleID !== 1n : (draft[group.appliesToGrantable] & role.roleID) === role.roleID);
      if (!direct && !grantable && !sources.length) return [];
      return [{ name: role.summaryName, role: direct, grantable, byTitle: sources.length > 0, titles: showTitleNames ? sources.map(title => title.titleName) : [] }];
    });
    rows.sort((a, b) => a.name.toUpperCase() < b.name.toUpperCase() ? -1 : a.name.toUpperCase() > b.name.toUpperCase() ? 1 : 0);
    return rows.length ? [{ groupID: group.groupID, nameID: group.roleGroupNameID, rows }] : [];
  });
}

function titleText(value: JsonValue | undefined): string {
  return typeof value === "string" ? value : value && typeof value === "object" && "value" in value && typeof value.value === "string" ? value.value : "";
}

export function memberTitlesOf(answer: JsonValue, untitled: (index: number) => string): Map<number, CorporationTitle> {
  const indexed = answer && typeof answer === "object" && !Array.isArray(answer) && "dict" in answer && Array.isArray(answer.dict) ? answer.dict as readonly (readonly [JsonValue, JsonValue])[] : readDictPairs(answer);
  return new Map(indexed.map(([key, title]) => {
    const titleID = Number(memberInteger(title, "titleID") ?? key);
    if (!Number.isSafeInteger(titleID) || titleID <= 0) throw new Error("A corporation title could not be read.");
    // bco_titles.GetTitles: blank names are localized once, when the service first reads the rows.
    const titleName = titleText(memberField(title, "titleName")) || untitled(Math.trunc(Math.log2(titleID) + 1));
    return [titleID, { ...Object.fromEntries(MEMBER_ROLE_FIELDS.map(field => [field, memberInteger(title, field) ?? 0n])), titleID, titleName } as CorporationTitle];
  }));
}

/** bco_titles.OnTitleChanged / bco_base.GetAddRemoveFromChange: amend held rows without another read. */
export function changeMemberTitles(titles: Map<number, CorporationTitle>, titleID: number, change: JsonValue): void {
  const entries = readDictPairs(change).flatMap(([key, value]) => {
    const pair = Array.isArray(value) ? value : value && typeof value === "object" && "items" in value && Array.isArray(value.items) ? value.items : [];
    return typeof key === "string" && pair.length === 2 ? [{ key, old: pair[0], value: pair[1] }] : [];
  });
  if (!entries.length) return;
  if (entries.every(entry => entry.value === null)) { titles.delete(titleID); return; }
  if (entries.every(entry => entry.old === null)) titles.set(titleID, { ...Object.fromEntries(MEMBER_ROLE_FIELDS.map(field => [field, 0n])), titleID, titleName: "" } as CorporationTitle);
  const held = titles.get(titleID);
  const nameChange = entries.find(entry => entry.key === "titleName");
  if (held) titles.set(titleID, { ...held, ...(nameChange ? { titleName: titleText(nameChange.value) } : {}), ...Object.fromEntries(entries.filter(entry => MEMBER_ROLE_FIELDS.some(field => field === entry.key)).map(entry => [entry.key, memberInteger({ [entry.key]: entry.value }, entry.key) ?? 0n])) });
}

export function myGrantableRoles(member: CorporationMember, viewerIsCEO: boolean, viewerIsDirector: boolean, data: CorporationRoleData, titles: ReadonlyMap<number, RoleMasks>): GrantMasks {
  const grants = { roles: 0n, rolesAtHQ: 0n, rolesAtBase: 0n, rolesAtOther: 0n };
  const activeCEO = viewerIsCEO && viewerIsDirector;
  if (activeCEO || (member.masks.roles & 1n) !== 0n) {
    const locational = new Set(data.locationalRoles);
    for (const bit of Object.keys(data.roles)) {
      const id = 1n << BigInt(bit);
      if (locational.has(id.toString())) { grants.rolesAtHQ |= id; grants.rolesAtBase |= id; grants.rolesAtOther |= id; }
      else if (id !== 1n || activeCEO) grants.roles |= id;
    }
  } else if (!viewerIsCEO) {
    const fields = Object.entries(data.groups).map(([, group]) => [group.appliesTo, group.appliesToGrantable] as const);
    for (const [field, grantable] of fields) grants[field] = member.masks[grantable];
    for (const [id, title] of titles) {
      if (!id || (member.titleMask & id) !== id) continue;
      for (const [field, grantable] of fields) grants[field] |= title[grantable];
    }
  }
  return grants;
}

/** Compiled corp_util.CanEditRole; the role grouping chooses the authority domain. */
export function canEditCorporationRole(roleID: bigint, grantable: boolean, targetIsCEO: boolean, targetIsDirector: boolean, viewerIsCEO: boolean, viewerIsDirector: boolean, appliesTo: RoleField, myBaseID: number | null, targetBaseID: number | null, grants: GrantMasks): boolean {
  if (grantable) return roleID !== 1n && viewerIsDirector && !targetIsCEO && !targetIsDirector;
  if (targetIsCEO || (targetIsDirector && !viewerIsCEO) || (targetIsDirector && (roleID & 1n) !== 1n)) return false;
  if (appliesTo === "rolesAtBase") {
    if (viewerIsCEO || (viewerIsDirector && !targetIsDirector)) return true;
    if (myBaseID !== targetBaseID) return false;
  }
  return (grants[appliesTo] & roleID) === roleID;
}

/** CheckBoxChange: Director replaces all direct masks; the target's titleMask is retained until UpdateMember. */
export function changeCorporationRole(masks: RoleMasks, field: typeof MEMBER_ROLE_FIELDS[number], roleID: bigint, checked: boolean): RoleMasks {
  if (field === "roles" && roleID === 1n) return Object.fromEntries(MEMBER_ROLE_FIELDS.map(key => [key, key === "roles" && checked ? 1n : 0n])) as RoleMasks;
  return { ...masks, [field]: checked ? masks[field] | roleID : masks[field] & ~roleID };
}
