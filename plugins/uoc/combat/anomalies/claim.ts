import type { CombatSite } from "./discovery.ts";
type Document = { read(): unknown; write(value: unknown): void };
type Claim = {
  version: 1;
  operationID: string;
  operationRunID: string;
  systemID: number;
  instanceID: number;
  dungeonID: number;
  scannerKey: number;
  state: "ACTIVE" | "RELEASED";
};
/** One exact site instance stays reserved across restart until all pilots have settled and parked. */
export function createAnomalyClaim(
  document: Document,
  site: CombatSite,
  operationID: string,
  operationRunID: string,
) {
  if (
    !operationID ||
    !operationRunID ||
    ![site.systemID, site.instanceID, site.dungeonID, site.scannerKey].every(
      (n) => Number.isSafeInteger(n) && n > 0,
    )
  )
    throw Error("Anomaly claim identity is invalid.");
  const identity = {
    version: 1 as const,
    operationID,
    operationRunID,
    systemID: site.systemID,
    instanceID: site.instanceID,
    dungeonID: site.dungeonID,
    scannerKey: site.scannerKey,
  };
  const textScope = (v: Claim) =>
    typeof v.operationID === "string" &&
    !!v.operationID &&
    typeof v.operationRunID === "string" &&
    !!v.operationRunID;
  const same = (v: any) => v && Object.entries(identity).every(([k, value]) => v[k] === value);
  const original = document.read() as Claim | null;
  if (
    original !== null &&
    (!original ||
      original.version !== 1 ||
      !textScope(original) ||
      !["ACTIVE", "RELEASED"].includes(original.state) ||
      original.systemID !== site.systemID ||
      original.instanceID !== site.instanceID ||
      original.dungeonID !== site.dungeonID ||
      original.scannerKey !== site.scannerKey)
  )
    throw Error("Anomaly site claim is unreadable.");
  if (
    original !== null &&
    original.state !== "RELEASED" &&
    (!same(original) || original.state !== "ACTIVE")
  )
    throw Error("Anomaly site is already claimed or retained for reconciliation.");
  if (original === null || original.state === "RELEASED") {
    if (original !== null && same(original))
      throw Error("A terminal anomaly operation cannot restart.");
    document.write({ ...identity, state: "ACTIVE" });
  }
  const assertCurrent = () => {
    const value = document.read();
    if (!same(value) || (value as Claim).state !== "ACTIVE")
      throw Error("Anomaly site claim changed.");
  };
  const release = (evidence: { state: string; settledAndParked: boolean }) => {
    if (evidence.state !== "STOPPED" || evidence.settledAndParked !== true)
      throw Error("Anomaly fleet has not settled and parked.");
    const value = document.read() as Claim | null;
    if (same(value) && value?.state === "RELEASED") return;
    assertCurrent();
    document.write({ ...identity, state: "RELEASED" });
  };
  return { assertCurrent, release };
}
