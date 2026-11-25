/** Stock MCC's supported, raw-only belt profile. This inspection never starts pilots. */
export interface StockMember {
  readonly characterID: number;
  readonly accountName: string;
  readonly role: "MINER" | "HAULER" | "DEFENDER";
  readonly routineMode: "STANDARD";
}
export interface StockDefinition {
  readonly operationID: string;
  readonly area: {
    readonly anchorSystemID: number;
    readonly reach: string;
    readonly targetClasses: readonly string[];
  };
  readonly unloadPolicy: string;
  readonly unloadDestination: {
    readonly stationID: number;
    readonly corporationID: number;
    readonly corporationDivision: number;
  };
  readonly policies: {
    readonly parking: { readonly mode: string };
    readonly resourcePolicy?: { readonly mode: string };
  };
  readonly members: readonly StockMember[];
  readonly support?: unknown;
  readonly oreLogistics?: unknown;
}
export interface ResourceRow {
  readonly typeID: number;
  readonly family: "ore" | "ice";
  readonly name: string;
}
export interface HoldSnapshot {
  readonly characterID: number;
  readonly accountName: string;
  readonly heldCharacterID: number;
  readonly onlineCharacterID: number;
  readonly shipID: number;
  readonly source: "stock-ore-hold";
  readonly observedAt: number;
  readonly activeShipID: number;
  readonly holds: readonly {
    readonly key: string;
    readonly present: boolean;
    readonly error: string | null;
    readonly capacity: { readonly capacity: number; readonly used: number } | null;
    readonly items:
      | readonly {
          readonly itemID: number;
          readonly typeID: number;
          readonly categoryID: number | null;
          readonly quantity: number;
        }[]
      | null;
  }[];
}
export interface Inspection {
  readonly observedRawOnly: boolean;
  readonly launchReady: false;
  readonly problems: readonly string[];
  readonly blockers: readonly string[];
}
const positive = (n: unknown): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && n > 0;
const keys = ["cargo", "ore", "gas", "ice", "asteroid"] as const;
/** Validates identity and all specialty hold rows against the native static uncompressed ore catalogue.
 * Stock ore-hold is a BFF projection which can drop malformed raw rows: this is observational, not an exact write fence. */
export function inspectRawStockOperation(
  def: StockDefinition,
  resources: readonly ResourceRow[],
  snapshots: readonly HoldSnapshot[],
  nowMs: number,
): Inspection {
  const problems: string[] = [];
  const catalog = Array.isArray(resources) ? resources : [],
    readings = Array.isArray(snapshots) ? snapshots : [];
  if (!Number.isFinite(nowMs)) problems.push("The observation clock is unavailable.");
  const members = Array.isArray(def?.members) ? def.members : [];
  if (
    !def?.operationID ||
    !positive(def.area?.anchorSystemID) ||
    def.area.reach !== "CURRENT_SYSTEM" ||
    !Array.isArray(def.area.targetClasses) ||
    def.area.targetClasses.length !== 1 ||
    def.area.targetClasses[0] !== "BELT" ||
    def.unloadPolicy !== "HAULER_SERVICE" ||
    def.support != null ||
    def.oreLogistics != null ||
    def.policies?.parking?.mode !== "RETURN_HOME_UNLOAD_DOCK" ||
    !positive(def.unloadDestination?.stationID) ||
    !positive(def.unloadDestination?.corporationID) ||
    !positive(def.unloadDestination?.corporationDivision) ||
    def.unloadDestination.corporationDivision > 7
  )
    problems.push(
      "Operation must use the single-belt raw hauler-service profile and an exact corporation destination with unload-and-dock Stop.",
    );
  if (
    members.filter((m) => m?.role === "MINER").length !== 2 ||
    members.filter((m) => m?.role === "HAULER").length !== 1 ||
    members.filter((m) => m?.role === "DEFENDER").length > 1 ||
    members.some(
      (m) =>
        !m ||
        !positive(m.characterID) ||
        !m.accountName ||
        m.routineMode !== "STANDARD" ||
        !["MINER", "HAULER", "DEFENDER"].includes(m.role),
    ) ||
    new Set(members.map((m) => m?.characterID)).size !== members.length
  )
    problems.push(
      "Roster must contain two distinct Standard miners, one Standard hauler and at most one Standard defender.",
    );
  const raw = new Set<number>();
  if (!catalog.length) problems.push("Raw ore catalogue is unavailable.");
  else
    for (const row of catalog) {
      if (
        !positive(row?.typeID) ||
        !row.name ||
        !["ore", "ice"].includes(row.family) ||
        raw.has(row.typeID)
      ) {
        problems.push("Raw ore catalogue is malformed or duplicated.");
        break;
      }
      raw.add(row.typeID);
    }
  const oreTypes = new Set(catalog.filter((r) => r?.family === "ore").map((r) => r.typeID));
  if (!oreTypes.size) problems.push("No source-qualified raw belt ore types are available.");
  const miners = members.filter((m) => m?.role === "MINER");
  if (
    readings.length !== miners.length ||
    new Set(readings.map((s) => s?.characterID)).size !== readings.length ||
    new Set(readings.map((s) => s?.shipID)).size !== readings.length
  )
    problems.push("Every miner needs one fresh owned-ship hold observation.");
  for (const miner of miners) {
    const snap = readings.find((s) => s?.characterID === miner.characterID);
    if (
      !snap ||
      snap.source !== "stock-ore-hold" ||
      typeof snap.accountName !== "string" ||
      typeof miner.accountName !== "string" ||
      snap.accountName.toLowerCase() !== miner.accountName.toLowerCase() ||
      snap.heldCharacterID !== miner.characterID ||
      snap.onlineCharacterID !== miner.characterID ||
      !positive(snap.shipID) ||
      snap.activeShipID !== snap.shipID ||
      !Number.isFinite(snap.observedAt) ||
      snap.observedAt > nowMs ||
      nowMs - snap.observedAt > 15_000 ||
      !Array.isArray(snap.holds) ||
      snap.holds.length !== keys.length ||
      new Set(snap.holds.map((h: HoldSnapshot["holds"][number]) => h?.key)).size !== keys.length ||
      keys.some((key) => !snap.holds.some((h: HoldSnapshot["holds"][number]) => h?.key === key))
    ) {
      problems.push(`Miner ${miner.characterID}: ship or hold observation is incomplete or stale.`);
      continue;
    }
    const seen = new Set<number>();
    let hasSpecialty = false;
    for (const hold of snap.holds) {
      if (
        !hold ||
        typeof hold.present !== "boolean" ||
        hold.error !== null ||
        !Array.isArray(hold.items) ||
        (!hold.present && hold.items.length) ||
        !hold.capacity ||
        !Number.isFinite(hold.capacity.capacity) ||
        !Number.isFinite(hold.capacity.used) ||
        hold.capacity.capacity < 0 ||
        hold.capacity.used < 0 ||
        hold.capacity.used > hold.capacity.capacity ||
        (hold.present
          ? hold.capacity.capacity <= 0
          : hold.capacity.capacity !== 0 || hold.capacity.used !== 0)
      ) {
        problems.push(`Miner ${miner.characterID}: hold ${hold?.key ?? "unknown"} is unreadable.`);
        continue;
      }
      if (hold.key !== "cargo" && hold.present) hasSpecialty = true;
      for (const item of hold.items) {
        if (
          !item ||
          !positive(item.itemID) ||
          seen.has(item.itemID) ||
          !positive(item.typeID) ||
          !positive(item.quantity)
        ) {
          problems.push(`Miner ${miner.characterID}: duplicate or invalid hold row.`);
          continue;
        }
        seen.add(item.itemID);
        if (
          hold.key !== "cargo" &&
          hold.present &&
          (item.categoryID !== 25 || !oreTypes.has(item.typeID))
        )
          problems.push(
            `Miner ${miner.characterID}: specialty hold contains an item not in the raw ore catalogue.`,
          );
      }
    }
    if (!hasSpecialty)
      problems.push(
        `Miner ${miner.characterID}: Standard jettison profile requires a specialty hold.`,
      );
  }
  return {
    observedRawOnly: problems.length === 0,
    launchReady: false,
    problems,
    blockers: [
      "Stock Standard Miner has no execution-time raw-only jettison gate and the operation assignment exposes no exact can manifest before hauling.",
      "Stock hold rows are a lossy projection; raw ListByFlags and exact post-can/delivery receipts are not available to this preflight.",
    ],
  };
}

/** Player-authenticated read/stop surface. Start is intentionally absent until the runtime manifest fence exists. */
export function createStockOperationClient(fetcher: typeof fetch, baseUrl: string) {
  const request = async (path: string, init?: RequestInit) => {
    const response = await fetcher(new URL(path, baseUrl), init),
      body = await response.json();
    if (!response.ok || !body || body.ok !== true)
      throw new Error(
        typeof body?.message === "string"
          ? body.message
          : `Operation request failed (${response.status}).`,
      );
    return body;
  };
  const path = (id: string) => {
    if (!id || id.length > 160) throw new Error("Invalid operation identity.");
    return `/api/mining-operations/${encodeURIComponent(id)}`;
  };
  return {
    resources: () => request("/api/mining-operations/resources"),
    preview: (id: string) => request(`${path(id)}/launch-plan`),
    stop: (id: string) =>
      request(`${path(id)}/stop`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
  };
}
