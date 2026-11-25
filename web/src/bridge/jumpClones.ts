import { readKeyVal, readPlainJsonField, readRowsetRows, unwrapLong, type JsonValue } from "./wire.ts";

export interface JumpClone {
  readonly id: number;
  readonly locationID: number;
  readonly name: string;
  readonly implants: readonly number[];
}

export function cloneBayAvailable(serviceIDs: readonly number[] | null | undefined, structure: boolean): boolean {
  return serviceIDs?.some(id => structure ? id === 10 : [10, 11, 12, 24].includes(id)) === true;
}

export function jumpCloneLocationKind(id: number): "station" | "structure" {
  return id >= 60_000_000 && id < 64_000_000 ? "station" : "structure";
}

export function decodeJumpClones(state: JsonValue): readonly JumpClone[] {
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
  return readRowsetRows(rows).flatMap(row => {
    const id = Number(unwrapLong(row.jumpCloneID));
    const locationID = Number(unwrapLong(row.locationID));
    if (!Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(locationID) || locationID <= 0) return [];
    const name = typeof row.cloneName === "string" ? row.cloneName : readPlainJsonField(row.cloneName, "value");
    return [{ id, locationID, name: typeof name === "string" ? name : "", implants: implants.get(id) ?? [] }];
  });
}
