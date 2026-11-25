import { readKeyVal, readPlainJsonField, readRowsetRows, unwrapLong, type JsonValue } from "./wire.ts";
import { filetimeToUnixMs } from "./activity.ts";

export interface JumpClone {
  readonly id: number;
  readonly locationID: number;
  readonly name: string;
  readonly implants: readonly number[];
}

export interface JumpCloneState {
  readonly clones: readonly JumpClone[];
  readonly lastJumpMs: number | null;
}

export interface CloneJumpQuote {
  readonly clone: JumpClone;
  readonly origin: number;
  readonly shipID: number;
  readonly leavesShip: boolean;
  readonly price: number;
}

export interface CloneJumpWarning {
  readonly quote: CloneJumpQuote;
  readonly message: string;
}

export const CLONE_JUMP_COOLDOWN_ATTRIBUTE = 1921;

export function cloneJumpCooldownEnd(lastJump: number | null, hours: unknown): number | null {
  return lastJump !== null && typeof hours === "number" && Number.isFinite(hours) && hours > 0
    ? lastJump + Math.round(hours) * 3_600_000 : null;
}

export function cloneBayAvailable(serviceIDs: readonly number[] | null | undefined, structure: boolean): boolean {
  return serviceIDs?.some(id => structure ? id === 10 : [10, 11, 12, 24].includes(id)) === true;
}

export function jumpCloneLocationKind(id: number): "station" | "structure" {
  return id >= 60_000_000 && id < 64_000_000 ? "station" : "structure";
}

export function decodeJumpClones(state: JsonValue): JumpCloneState {
  const rows = readKeyVal(state, "clones");
  const implantRows = readKeyVal(state, "implants");
  if (!rows || !implantRows) throw new Error("The jump clone roster could not be read.");
  const implants = new Map<number, number[]>();
  for (const row of readRowsetRows(implantRows)) {
    const id = Number(unwrapLong(row.jumpCloneID));
    const typeID = Number(unwrapLong(row.typeID));
    if (id <= 0 || typeID <= 0) continue;
    const installed = implants.get(id);
    if (installed) installed.push(typeID);
    else implants.set(id, [typeID]);
  }
  const clones = readRowsetRows(rows).flatMap(row => {
    const id = Number(unwrapLong(row.jumpCloneID));
    const locationID = Number(unwrapLong(row.locationID));
    if (!Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(locationID) || locationID <= 0) return [];
    const name = typeof row.cloneName === "string" ? row.cloneName : readPlainJsonField(row.cloneName, "value");
    return [{ id, locationID, name: typeof name === "string" ? name : "", implants: implants.get(id) ?? [] }];
  });
  const lastJump = unwrapLong(readKeyVal(state, "timeLastJump"));
  return { clones, lastJumpMs: lastJump && lastJump > 0n ? filetimeToUnixMs(lastJump) : null };
}
