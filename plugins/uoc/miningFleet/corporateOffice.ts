import {
  isListValue,
  isPackedRowValue,
  readDictPairs,
  readRowField,
  unwrapLong,
} from "../shared/wire.ts";

const GLOBAL_ROLE_MASK = 9222811354509877121n;
const LOCAL_ROLE_MASK = 558552041119758n;
const DIRECTOR = 1n;
const HANGAR_QUERY_1 = 1048576n;
const HANGAR_TAKE_1 = 8192n;

function field(row: unknown, name: string): unknown {
  const direct = readRowField(row, name);
  if (direct !== undefined) return direct;
  const value = row as { type?: unknown; name?: unknown; args?: unknown } | null;
  if (value?.type !== "object" || value.name !== "util.Row") return undefined;
  const entries = readDictPairs(value.args);
  const header = entries.find(([key]) => key === "header")?.[1];
  const line = entries.find(([key]) => key === "line")?.[1];
  if (!isListValue(header) || !isListValue(line) || header.items.length !== line.items.length)
    return undefined;
  const index = header.items.indexOf(name);
  return index < 0 ? undefined : line.items[index];
}

function integer(value: unknown): bigint | null {
  const wire = value as { type?: unknown; value?: unknown } | null;
  const scalar = wire?.type === "long" || wire?.type === "int" ? wire.value : value;
  if (typeof scalar === "number" && !Number.isSafeInteger(scalar)) return null;
  return unwrapLong(scalar);
}

function location(value: unknown): number | null {
  if (value === null) return null;
  const id = integer(value);
  if (id === null || id < 0n || id > BigInt(Number.MAX_SAFE_INTEGER))
    throw Error("Corporation headquarters or pilot base is unreadable.");
  return Number(id);
}

function mask(value: unknown, allowed: bigint, what = "Corporation roles"): bigint {
  const roles = integer(value);
  if (roles === null || roles < 0n || (roles & ~allowed) !== 0n)
    throw Error(`${what} are unreadable.`);
  return roles;
}

const TITLE_MASK = 0xffffn;

function assignedTitles(raw: unknown, titleMask: bigint, corporationID: bigint) {
  // GetTitles is a CIndexedRowset, with packed rows indexed by titleID in dict.
  const indexed = raw as { type?: unknown; header?: unknown[]; dict?: unknown } | null;
  const header = indexed?.header;
  const klass = Array.isArray(header?.[0]) ? header[0][0] : null;
  const columns = readDictPairs(header?.[1]);
  if (
    indexed?.type !== "objectex2" ||
    klass?.type !== "token" ||
    klass.value !== "carbon.common.script.sys.crowset.CIndexedRowset" ||
    !columns.some(([key, value]) => key === "idName" && value === "titleID") ||
    !Array.isArray(indexed.dict)
  )
    throw Error("Corporation title definitions are unreadable.");

  const seen = new Set<bigint>();
  const assigned: unknown[] = [];
  for (const entry of indexed.dict) {
    if (!Array.isArray(entry) || entry.length !== 2)
      throw Error("Corporation title definitions are unreadable.");
    const id = integer(entry[0]);
    if (
      id === null ||
      id <= 0n ||
      (id & ~TITLE_MASK) !== 0n ||
      (id & (id - 1n)) !== 0n ||
      seen.has(id)
    )
      throw Error("Corporation title identity is unreadable.");
    seen.add(id);
    if ((titleMask & id) === 0n) continue;
    const row = entry[1];
    if (
      !isPackedRowValue(row) ||
      integer(field(row, "titleID")) !== id ||
      integer(field(row, "corporationID")) !== corporationID
    )
      throw Error("Assigned corporation title does not match the pilot's corporation or title ID.");
    assigned.push(row);
  }
  // Only existing definitions grant roles, as on the game server.
  return assigned;
}

type OfficeDivision = { division: number; name: string | null };
type OfficeAccess = {
  corporationID: number;
  locationID: number;
  officeAvailable: boolean;
  divisions: readonly { division: number; query: boolean }[];
};

export function requireMiningOfficeQuery(
  access: OfficeAccess,
  corporationID: number,
  division: number,
) {
  const { locationID } = access;
  if (access.corporationID !== corporationID)
    throw Error(
      `The held pilot's corporation does not match the corporate destination at dock ${locationID}.`,
    );
  if (!access.officeAvailable)
    throw Error(`The pilot's corporation has no office at dock ${locationID}.`);
  // The game's ordinary corp hangar deposits require Query. Take applies to withdrawals.
  if (!access.divisions.some((row) => row.division === division && row.query))
    throw Error(
      `This pilot lacks verified Query access to corporation division ${division} at dock ${locationID}.`,
    );
}

export async function readMiningOfficeAccess(
  pilot: { characterID: number; corporationID: number },
  destinations: readonly number[],
  read: (path: string) => Promise<unknown>,
  ask: (method: string, args?: readonly number[]) => Promise<unknown>,
) {
  const offices = (await read("/api/bridge/corp-offices")) as {
    error?: unknown;
    stationIDs?: unknown;
    divisions?: unknown;
  } | null;
  if (
    offices?.error !== null ||
    !Array.isArray(offices.stationIDs) ||
    offices.stationIDs.some((id) => !Number.isSafeInteger(id) || id <= 0) ||
    !Array.isArray(offices.divisions) ||
    offices.divisions.length !== 7 ||
    offices.divisions.some(
      (row) =>
        !row ||
        !Number.isInteger(row.division) ||
        row.division < 1 ||
        row.division > 7 ||
        (row.name !== null && typeof row.name !== "string"),
    ) ||
    new Set(offices.divisions.map((row) => row.division)).size !== 7
  )
    throw Error("Corporate office list or division names are unreadable.");

  const stations = new Set<number>(offices.stationIDs);
  const divisions = offices.divisions as OfficeDivision[];
  const missing = (locationID: number) => ({
    ...pilot,
    locationID,
    officeAvailable: false,
    divisions: [],
  });
  if (!destinations.some((id) => stations.has(id))) return missing;

  const [corp, member] = await Promise.all([
    ask("GetCorporation"),
    ask("GetMember", [pilot.characterID]),
  ]);
  const corporationID = BigInt(pilot.corporationID);
  if (
    integer(field(corp, "corporationID")) !== corporationID ||
    integer(field(member, "corporationID")) !== corporationID ||
    integer(field(member, "characterID")) !== BigInt(pilot.characterID)
  )
    throw Error("The held pilot or corporation did not match the current corporation records.");

  const globalRoles = mask(field(member, "roles"), GLOBAL_ROLE_MASK);
  const director =
    (globalRoles & DIRECTOR) !== 0n || integer(field(corp, "ceoID")) === BigInt(pilot.characterID);
  const titles = director
    ? 0n
    : mask(field(member, "titleMask"), TITLE_MASK, "Corporation title assignments");
  const assigned = titles ? assignedTitles(await ask("GetTitles"), titles, corporationID) : [];
  const rolesAtAll = assigned.reduce<bigint>(
    (roles, title) =>
      roles | mask(field(title, "roles"), GLOBAL_ROLE_MASK & ~DIRECTOR, "Corporation title roles"),
    globalRoles,
  );
  const headquarters = location(field(corp, "stationID"));
  const base = location(field(member, "baseID"));

  return (locationID: number) => {
    if (!stations.has(locationID)) return missing(locationID);
    const localField =
      locationID === headquarters
        ? "rolesAtHQ"
        : locationID === base
          ? "rolesAtBase"
          : "rolesAtOther";
    const roles = director
      ? rolesAtAll
      : assigned.reduce<bigint>(
          (effective, title) =>
            effective | mask(field(title, localField), LOCAL_ROLE_MASK, "Corporation title roles"),
          rolesAtAll | mask(field(member, localField), LOCAL_ROLE_MASK),
        );
    return {
      ...pilot,
      locationID,
      officeAvailable: true,
      divisions: divisions.map((row) => {
        const shift = BigInt(row.division - 1);
        return {
          ...row,
          query: director || (roles & (HANGAR_QUERY_1 << shift)) !== 0n,
          take: director || (roles & (HANGAR_TAKE_1 << shift)) !== 0n,
        };
      }),
    };
  };
}
