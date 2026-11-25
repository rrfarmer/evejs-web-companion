/** Source-qualified courier wire reads, ported from WC74's agent/inventory decoders. */
const seq = (v: any): any[] | null =>
  Array.isArray(v)
    ? v
    : v && (v.type === "list" || v.type === "tuple") && Array.isArray(v.items)
      ? v.items
      : null;
const get = (v: any, key: string): any => {
  if (v?.type === "object" && v.name === "util.KeyVal") v = v.args;
  if (v?.type !== "dict" || !Array.isArray(v.entries)) return undefined;
  return v.entries.find((r: any) => Array.isArray(r) && r[0] === key)?.[1];
};
const integer = (v: any): number | null => {
  if (v?.type === "long") v = v.value;
  const n =
    typeof v === "number" ? v : typeof v === "string" && /^-?\d+$/.test(v) ? Number(v) : NaN;
  return Number.isSafeInteger(n) ? n : null;
};
const decimal = (v: any): string | null => {
  if (v?.type === "long") v = v.value;
  return typeof v === "string" && /^-?\d+$/.test(v)
    ? v
    : typeof v === "number" && Number.isSafeInteger(v)
      ? String(v)
      : null;
};
export interface JournalRow {
  agentID: number;
  missionID: number;
  missionState: number;
  missionKey: string;
  missionName?: string;
  missionTitleID?: number;
  missionType?: string;
  important?: boolean;
}
export function checkedJournal(
  raw: unknown,
  scope: "all" | "missions" = "all",
): { active: JournalRow[]; offered: JournalRow[]; completed?: JournalRow[] } | null {
  const buckets = seq(raw);
  if (!buckets || buckets.length !== 2 || !seq(buckets[0]) || !seq(buckets[1])) return null;
  const active: JournalRow[] = [],
    offered: JournalRow[] = [],
    completed: JournalRow[] = [];
  // On EveJS the second slot of GetMyJournalDetails contains R&D projects.
  const rows = scope === "missions" ? seq(buckets[0])! : [...seq(buckets[0])!, ...seq(buckets[1])!];
  for (const entry of rows) {
    const a = seq(entry);
    if (!a || a.length < 10) return null;
    const state = integer(a[0]),
      agentID = integer(a[4]),
      missionID = integer(a[9]);
    if (
      scope === "missions" &&
      (state === 7 || (state === 4 && (!agentID || agentID <= 0 || !missionID || missionID <= 0)))
    )
      continue;
    if (
      (state !== 1 && state !== 2 && !(scope === "missions" && state === 4)) ||
      !agentID ||
      agentID <= 0 ||
      !missionID ||
      missionID <= 0
    )
      return null;
    const title = typeof a[3] === "string" ? null : integer(a[3]);
    const expiry = decimal(a[5]);
    const row = {
      agentID,
      missionID,
      missionState: state,
      missionKey: JSON.stringify([agentID, missionID, title, expiry]),
      ...(scope === "missions" && typeof a[2] === "string" ? { missionType: a[2] } : {}),
      ...(scope === "missions" ? { important: a[1] !== false && a[1] !== 0 } : {}),
      ...(typeof a[3] === "string" && a[3].trim() ? { missionName: a[3] } : {}),
      ...(scope === "missions" && title !== null && title > 0 ? { missionTitleID: title } : {}),
    };
    (state === 1 ? offered : state === 4 ? completed : active).push(row);
  }
  return { active, offered, ...(completed.length ? { completed } : {}) };
}
export type MissionJournal = NonNullable<ReturnType<typeof checkedJournal>>;
export function agentMission(journal: MissionJournal, agentID: number): JournalRow | null {
  const rows = [...journal.active, ...journal.offered].filter((row) => row.agentID === agentID);
  if (rows.length > 1)
    throw new Error(`Multiple current missions were returned for agent ${agentID}.`);
  return rows[0] ?? null;
}
export const missionLabel = (row: JournalRow) =>
  `${row.missionName ?? (row.missionTitleID ? `Mission title #${row.missionTitleID}` : `Mission #${row.missionID}`)} (${row.missionState === 2 ? "accepted" : "offered"}, agent ${row.agentID})`;
export function referralAgent(raw: unknown): number | null | undefined {
  const rows = seq(get(raw, "objectives"));
  if (!rows) return undefined;
  for (const row of rows) {
    const objective = seq(row);
    if (!objective || typeof objective[0] !== "string") return undefined;
    if (objective[0] === "agent") {
      const target = integer(seq(objective[1])?.[0]);
      return target && target > 0 ? target : undefined;
    }
  }
  return null;
}
export function conversation(raw: unknown) {
  const outer = seq(raw),
    inner = seq(outer?.[0]),
    actions = seq(inner?.[1]);
  if (!outer || outer.length < 2 || !inner || !actions) return null;
  const decoded = [];
  for (const entry of actions) {
    const a = seq(entry),
      id = integer(a?.[0]),
      button = integer(a?.[1]);
    if (!id || id <= 0 || !button || button <= 0) return null;
    decoded.push({ id, button });
  }
  const said = seq(inner[0])?.[0];
  const confirmed = (key: string) => {
    const flag = get(outer[1], key);
    return typeof flag === "boolean" ? flag : null;
  };
  return {
    actions: decoded,
    completed: confirmed("missionCompleted"),
    says: typeof said === "string" ? said : "",
    declined: confirmed("missionDeclined"),
    quit: confirmed("missionQuit"),
  };
}
export interface Courier {
  contentID: number;
  missionState: 1 | 2;
  acceptedAt?: string;
  typeID: number;
  quantity: number;
  volume: number;
  pickup: number;
  pickupSystem: number;
  destination: number;
  destinationSystem: number;
}
export function courier(objective: unknown): Courier | null {
  const contentID = integer(get(objective, "contentID")),
    missionState = integer(get(objective, "missionState"));
  if (!contentID || contentID <= 0 || (missionState !== 1 && missionState !== 2)) return null;
  const rows = seq(get(objective, "objectives"));
  if (!rows || rows.length !== 1) return null;
  const entry = seq(rows[0]);
  if (!entry || entry[0] !== "transport") return null;
  const values = seq(entry[1]);
  if (!values || values.length !== 5) return null;
  const pickup = integer(get(values[1], "locationID")),
    pickupSystem = integer(get(values[1], "solarsystemID")),
    destination = integer(get(values[3], "locationID")),
    destinationSystem = integer(get(values[3], "solarsystemID")),
    typeID = integer(get(values[4], "typeID")),
    quantity = integer(get(values[4], "quantity")),
    v = get(values[4], "volume"),
    volume = typeof v === "number" ? v : Number(decimal(v));
  if (
    ![pickup, pickupSystem, destination, destinationSystem, typeID, quantity].every(
      (n) => n !== null && n > 0,
    ) ||
    !Number.isFinite(volume) ||
    volume <= 0
  )
    return null;
  return {
    contentID,
    missionState,
    pickup: pickup!,
    pickupSystem: pickupSystem!,
    destination: destination!,
    destinationSystem: destinationSystem!,
    typeID: typeID!,
    quantity: quantity!,
    volume,
  };
}
export function checkedInventory(
  raw: any,
): { itemID: number; typeID: number; quantity: number }[] | null {
  let v = raw;
  if (v?.type === "objectex1" && v.header?.[0]?.value === "__builtin__.set") {
    if (!Array.isArray(v.header[1]) || v.header[1].length !== 1) return null;
    v = v.header[1][0];
  } else if (v?.type === "object" && Array.isArray(v.args)) {
    if (v.args.length !== 1) return null;
    v = v.args[0];
  }
  if (v?.type !== "list" || !Array.isArray(v.items)) return null;
  const out = [],
    seen = new Set<number>();
  for (const item of v.items) {
    const f = item?.type === "packedrow" ? item.fields : item;
    const id = integer(f?.itemID),
      typeID = integer(f?.typeID),
      single = f?.singleton === true || integer(f?.singleton) === 1;
    const quantity = single ? 1 : integer(f?.quantity) || integer(f?.stacksize);
    if (!id || id <= 0 || seen.has(id) || !typeID || typeID <= 0 || !quantity || quantity <= 0)
      return null;
    seen.add(id);
    out.push({ itemID: id, typeID, quantity });
  }
  return out;
}
export function capacity(raw: unknown): { capacity: number; used: number } | null {
  const c = get(raw, "capacity"),
    u = get(raw, "used");
  return typeof c === "number" &&
    Number.isFinite(c) &&
    c >= 0 &&
    typeof u === "number" &&
    Number.isFinite(u) &&
    u >= 0 &&
    u <= c
    ? { capacity: c, used: u }
    : null;
}
