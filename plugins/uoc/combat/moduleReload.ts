import type { SecurityStorage } from "./journal.ts";
export interface CombatReload {
  key: string;
  characterID: number;
  shipID: number;
  moduleID: number;
  moduleTypeID: number;
  cargoItemID: number;
  chargeTypeID: number;
}
const positive = (x: unknown): x is number =>
  typeof x === "number" && Number.isSafeInteger(x) && x > 0;
/** Only known matching charge group/size and a non-FOF type are candidates. */
export function chooseCombatAmmo(
  rows: readonly { itemID: number; typeID: number; groupID: number | null; quantity: number }[],
  fit: { groups: readonly number[]; size: number | null },
  facts: Readonly<Record<number, Readonly<Record<number, number>>>>,
): { itemID: number; typeID: number } | null {
  if (
    !positive(fit.size) ||
    !Array.isArray(fit.groups) ||
    !fit.groups.length ||
    fit.groups.some((g) => !positive(g))
  )
    return null;
  return (
    rows
      .filter(
        (row) =>
          positive(row.itemID) &&
          positive(row.typeID) &&
          positive(row.groupID) &&
          positive(row.quantity) &&
          fit.groups.includes(row.groupID) &&
          Object.hasOwn(facts, row.typeID) &&
          facts[row.typeID]?.[128] === fit.size &&
          (facts[row.typeID]?.[1455] === undefined || facts[row.typeID]![1455] === 0),
      )
      .sort((a, b) => a.itemID - b.itemID)
      .map((row) => ({ itemID: row.itemID, typeID: row.typeID }))[0] ?? null
  );
}
type Row = { identity: CombatReload; status: "DISPATCHED" | "ACKNOWLEDGED" | "CONFIRMED" };

function readReloads(document: SecurityStorage) {
  const raw = document.read(),
    doc = raw === null ? { version: 1, rows: [] as Row[] } : (raw as { version: 1; rows: Row[] });
  if (
    !doc ||
    doc.version !== 1 ||
    !Array.isArray(doc.rows) ||
    doc.rows.some(
      (r) =>
        !r ||
        !r.identity ||
        typeof r.identity.key !== "string" ||
        !r.identity.key ||
        ![
          r.identity.characterID,
          r.identity.shipID,
          r.identity.moduleID,
          r.identity.moduleTypeID,
          r.identity.cargoItemID,
          r.identity.chargeTypeID,
        ].every(positive) ||
        !["DISPATCHED", "ACKNOWLEDGED", "CONFIRMED"].includes(r.status),
    ) ||
    new Set(doc.rows.map((r) => r.identity.key)).size !== doc.rows.length
  )
    throw Error("Combat reload journal is unreadable.");
  return doc;
}

/** Observe exact fitted charges in the Defender's ordinary fitting read. */
export function observeCombatReloads(
  document: SecurityStorage,
  scope: { characterID: number; shipID: number },
  loaded: (identity: CombatReload) => boolean,
) {
  const doc = readReloads(document),
    pending = new Set<number>();
  let changed = false;
  for (const row of doc.rows) {
    const { identity, status } = row;
    if (
      status === "CONFIRMED" ||
      identity.characterID !== scope.characterID ||
      identity.shipID !== scope.shipID
    )
      continue;
    if (loaded(identity)) {
      row.status = "CONFIRMED";
      changed = true;
    } else pending.add(identity.moduleID);
  }
  if (changed) document.write(doc);
  return { pending, confirmed: changed };
}

/** One cargo-to-module load, completed only by an exact fitting observation. */
export async function executeCombatReload(
  identity: CombatReload,
  deps: {
    document: SecurityStorage;
    current(): void;
    fence(): Promise<void>;
    load(): Promise<void>;
    loaded(): Promise<boolean>;
    sleep(ms: number): Promise<void>;
    now(): number;
    deferConfirmation?: boolean;
  },
): Promise<void> {
  if (
    typeof identity.key !== "string" ||
    !identity.key ||
    ![
      identity.characterID,
      identity.shipID,
      identity.moduleID,
      identity.moduleTypeID,
      identity.cargoItemID,
      identity.chargeTypeID,
    ].every(positive)
  )
    throw Error("Combat reload identity is incomplete.");
  const { document } = deps;
  const doc = readReloads(document);
  const prior = doc.rows.find((r) => r.identity.key === identity.key);
  if (prior && JSON.stringify(prior.identity) !== JSON.stringify(identity))
    throw Error("Combat reload key belongs to another identity.");
  if (
    doc.rows.some(
      (r) =>
        r.identity.key !== identity.key &&
        r.identity.moduleID === identity.moduleID &&
        r.status !== "CONFIRMED",
    )
  )
    throw Error("Another reload remains unresolved.");
  if (prior?.status === "CONFIRMED") return;
  const update = (status: Row["status"]) => {
    deps.current();
    const fresh = readReloads(document),
      row = fresh.rows.find((r) => r.identity.key === identity.key);
    if (!row || JSON.stringify(row.identity) !== JSON.stringify(identity))
      throw Error("Combat reload record changed.");
    if (row.status === "CONFIRMED") return;
    row.status = status;
    document.write(fresh);
  };
  deps.current();
  await deps.fence();
  deps.current();
  if (prior) {
    if (!deps.deferConfirmation && (await deps.loaded())) {
      update("CONFIRMED");
      return;
    }
    throw Error("Combat reload outcome remains unresolved; no replay.");
  }
  const fresh = readReloads(document);
  if (
    fresh.rows.some(
      (r) =>
        r.identity.key === identity.key ||
        (r.identity.moduleID === identity.moduleID && r.status !== "CONFIRMED"),
    )
  )
    throw Error("Another reload remains unresolved.");
  fresh.rows.push({ identity, status: "DISPATCHED" });
  document.write(fresh);
  deps.current();
  await deps.load();
  update("ACKNOWLEDGED");
  if (deps.deferConfirmation) return;
  const deadline = deps.now() + 90_000;
  for (let n = 0; n <= 90; n++) {
    deps.current();
    await deps.fence();
    deps.current();
    if (await deps.loaded()) {
      update("CONFIRMED");
      return;
    }
    if (deps.now() >= deadline) break;
    await deps.sleep(1000);
  }
  throw Error("Combat reload was not confirmed; no replay.");
}
