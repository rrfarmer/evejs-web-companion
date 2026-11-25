import { isSlotFlag } from "../../../web/src/plugin-api/flying.ts";
import { decodeCorpAssetItems, unwrapCachedResult } from "../compat/flying.ts";
import {
  checkedInventory,
  corpDivisionFlag,
  type NativeInventoryRow,
} from "../shared/nativeInventory.ts";

type Read = (path: string, body?: unknown) => Promise<any>;
type Scope = {
  characterID: number;
  corporationID: number;
  locationID: number;
  shipID: number;
  shipTypeID: number;
};
type Source = { kind: "hangar" } | { kind: "corp"; division: number };
type Candidate = { itemID: number; origin: "active" | "hangar" | "corp" };
type Fitted = Pick<NativeInventoryRow, "itemID" | "typeID" | "flagID" | "quantity">;
type Requirement = { flag: number; typeID: number; quantity: number; kind: "FITTED" | "LOADED" };
type Stock = NativeInventoryRow & { singleton: boolean };
type Move = Requirement & { itemID: number; locationID: number };
export type ExistingHull = Candidate & {
  kind: "READY" | "PARTIAL" | "EMPTY";
  fitted: Fitted[];
  moves: Move[];
  requiresTake: boolean;
};
const hangar = { kind: "hangar" } as const;
const positive = (id: unknown): id is number =>
  typeof id === "number" && Number.isSafeInteger(id) && id > 0;
const rig = (flag: number) => flag >= 92 && flag <= 99;
const slot = (flag: number) => isSlotFlag(flag) || (flag >= 164 && flag <= 171);
const key = (flag: number, typeID: number) => `${flag}:${typeID}`;
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

async function ask(
  read: Read,
  service: string,
  method: string,
  args: unknown[] = [],
  of?: number | "hangar",
  confirm = false,
  kwargs: object | null = null,
) {
  const answer = await read("/api/bridge/call", {
    service,
    method,
    args,
    kwargs,
    pilot: true,
    ...(of === undefined ? {} : { of }),
    ...(confirm ? { confirm: true } : {}),
  });
  return answer.result;
}

function required(review: any): Requirement[] {
  const rows: Requirement[] = review.plan.requirements;
  const fitted = Array.isArray(rows) ? rows.filter((row) => row?.kind === "FITTED") : [];
  if (
    !Array.isArray(rows) ||
    rows.some(
      (row) =>
        !positive(row.flag) ||
        !positive(row.typeID) ||
        !positive(row.quantity) ||
        (slot(row.flag)
          ? row.kind !== "FITTED" || row.quantity !== 1
          : row.kind !== "LOADED" || ![5, 87].includes(row.flag)),
    ) ||
    new Set(rows.map((row) => key(row.flag, row.typeID))).size !== rows.length ||
    new Set(fitted.map((row) => row.flag)).size !== fitted.length
  )
    throw Error("The exact fitting requirements are unreadable.");
  return rows;
}

function inventoryItems(raw: any): any[] {
  const list =
    raw?.type === "objectex1" &&
    raw.header?.[0]?.value === "__builtin__.set" &&
    raw.header[1]?.length === 1
      ? raw.header[1][0]
      : raw?.type === "object" && Array.isArray(raw.args)
        ? raw.args[0]
        : raw;
  if (list?.type !== "list" || !Array.isArray(list.items))
    throw Error("Inventory list is unreadable.");
  return list.items;
}

function singleton(row: any) {
  return (
    row.singleton === true || row.singleton === 1 || row.quantity === -1 || row.quantity === -2
  );
}

function atHangar(row: NativeInventoryRow, scope: Scope) {
  return (
    row.ownerID === scope.characterID && row.locationID === scope.locationID && row.flagID === 4
  );
}

function stockRows(review: any): Stock[] {
  const { pin, rows } = review.source;
  if (
    !Array.isArray(rows) ||
    rows.some(
      (row) =>
        !positive(row.itemID) ||
        !positive(row.typeID) ||
        !positive(row.quantity) ||
        row.ownerID !== pin.ownerID ||
        row.locationID !== pin.locationID ||
        row.flagID !== pin.flag ||
        typeof row.singleton !== "boolean" ||
        row.loaded === true,
    ) ||
    new Set(rows.map((row) => row.itemID)).size !== rows.length
  )
    throw Error("The selected stock could not be verified.");
  return rows;
}

function stockSource(review: any): Source {
  const pin = review.source.pin,
    { kind, division } = pin.descriptor,
    scope: Scope = review.context;
  if (pin.dockedLocationID !== scope.locationID || review.source.access.query !== true)
    throw Error("The selected stock and dock do not match.");
  if (
    kind === "hangar" &&
    pin.ownerID === scope.characterID &&
    pin.locationID === scope.locationID &&
    pin.flag === 4
  )
    return hangar;
  if (
    kind === "corp" &&
    pin.ownerID === scope.corporationID &&
    pin.descriptor.corporationID === scope.corporationID &&
    pin.flag === corpDivisionFlag(division) &&
    typeof pin.office === "string"
  )
    return { kind, division };
  throw Error("The selected stock owner or division could not be verified.");
}

async function personalFit(read: Read, itemID: number, characterID: number) {
  await ask(read, "invCache", "InvalidateLocationCache", [itemID], undefined, true);
  const rows = inventoryItems(await ask(read, "invbroker", "List", [], itemID)).filter((entry) => {
    const row = entry?.fields ?? entry;
    // The active ship can list loaded charges as synthetic tuple IDs. Charges
    // in a module slot are not the installed module and are outside the fit.
    return !(
      row?.categoryID === 8 &&
      slot(row.flagID) &&
      row.locationID === itemID &&
      row.ownerID === characterID
    );
  });
  const contents = checkedInventory({ type: "list", items: rows });
  if (contents.some((row) => row.ownerID !== characterID || row.locationID !== itemID))
    throw Error("The fitting inventory does not belong to the selected hull.");
  return contents;
}

async function corporationFits(read: Read, scope: Scope) {
  const raw = await ask(read, "corpmgr", "GetAssetInventoryForLocation", [
    scope.corporationID,
    scope.locationID,
    "offices",
  ]);
  const rowset = unwrapCachedResult(raw) as { type?: string; list?: unknown[] } | null;
  const assets = decodeCorpAssetItems(raw);
  if (
    rowset?.type !== "objectex2" ||
    !Array.isArray(rowset.list) ||
    assets.length !== rowset.list.length ||
    assets.some(
      (row) =>
        !positive(row.ownerID) ||
        !positive(row.locationID) ||
        !positive(row.typeID) ||
        !positive(row.units) ||
        !Number.isSafeInteger(row.flagID),
    ) ||
    new Set(assets.map((row) => row.itemID)).size !== assets.length
  )
    throw Error("Corporation asset inventory is unreadable.");
  return assets;
}

function observeFit(
  contents: readonly NativeInventoryRow[],
  wanted: readonly Requirement[],
): Fitted[] {
  return contents
    .filter(
      (row) =>
        (slot(row.flagID) && row.categoryID !== 8) ||
        [87, 158].includes(row.flagID) ||
        wanted.some(
          (need) =>
            need.kind === "LOADED" && need.flag === row.flagID && need.typeID === row.typeID,
        ),
    )
    .map(({ itemID, typeID, flagID, quantity }) => ({ itemID, typeID, flagID, quantity }))
    .sort((a, b) => a.itemID - b.itemID);
}

const quantity = (rows: readonly Fitted[], flag: number, typeID: number) =>
  rows.reduce((n, row) => n + (row.flagID === flag && row.typeID === typeID ? row.quantity : 0), 0);

function matchesSubset(rows: readonly Fitted[], wanted: readonly Requirement[]) {
  return rows.every((row) =>
    wanted.some(
      (need) =>
        need.flag === row.flagID &&
        need.typeID === row.typeID &&
        quantity(rows, row.flagID, row.typeID) <= need.quantity,
    ),
  );
}

function retainsSlots(before: readonly Fitted[], after: readonly Fitted[]) {
  return before
    .filter((row) => slot(row.flagID))
    .every((row) =>
      after.some(
        (item) =>
          item.flagID === row.flagID &&
          item.typeID === row.typeID &&
          item.itemID === row.itemID &&
          item.quantity === row.quantity,
      ),
    );
}

function planMoves(fitted: Fitted[], wanted: Requirement[], stock: Stock[]) {
  const available = stock
    .filter((row) => !row.singleton)
    .sort((a, b) => b.quantity - a.quantity || a.itemID - b.itemID);
  const remaining = new Map(available.map((row) => [row.itemID, row.quantity]));
  const moves: Move[] = [];
  // A missing rig can supply CPU or powergrid for later modules.
  for (const need of [...wanted].sort((a, b) => Number(rig(b.flag)) - Number(rig(a.flag)))) {
    let missing = need.quantity - quantity(fitted, need.flag, need.typeID);
    for (const row of available) {
      if (missing === 0) break;
      const take =
        row.typeID === need.typeID ? Math.min(missing, remaining.get(row.itemID) ?? 0) : 0;
      if (take === 0) continue;
      moves.push({ ...need, itemID: row.itemID, locationID: row.locationID, quantity: take });
      remaining.set(row.itemID, (remaining.get(row.itemID) ?? 0) - take);
      missing -= take;
    }
    if (missing > 0) return null;
  }
  return moves;
}

export async function reviewExistingHull(
  read: Read,
  native: any,
): Promise<{ review: any; selection: ExistingHull | null }> {
  const unchanged = { review: native, selection: null };
  if (
    native.plan.mode !== "NEW_HULL" ||
    native.context.recoveryReady === false ||
    native.plan.unsupported.length ||
    native.plan.destructiveActions.length
  )
    return unchanged;
  const scope: Scope = native.context,
    typeID: number = native.plan.targetHullTypeID;
  const wanted = required(native),
    source = stockSource(native),
    stock = stockRows(native);
  const take = native.source.access.take === true;
  const candidates: Candidate[] = [];
  if (scope.shipTypeID === typeID) candidates.push({ itemID: scope.shipID, origin: "active" });
  let unreadable = false;
  try {
    let personal: Stock[] = stock;
    if (source.kind === "corp") {
      const items = inventoryItems(await ask(read, "invbroker", "List", [4], "hangar"));
      personal = checkedInventory({ type: "list", items }).map((row, i) => ({
        ...row,
        singleton: singleton(items[i]?.fields ?? items[i]),
      }));
      if (personal.some((row) => !atHangar(row, scope)))
        throw Error("The personal hangar identity is uncertain.");
    }
    candidates.push(
      ...personal
        .filter((row) => row.typeID === typeID && row.singleton && row.itemID !== scope.shipID)
        .sort((a, b) => a.itemID - b.itemID)
        .map((row) => ({ itemID: row.itemID, origin: "hangar" as const })),
    );
  } catch {
    unreadable = true;
  }

  if (source.kind === "corp" && take) {
    candidates.push(
      ...stock
        .filter((row) => row.typeID === typeID && row.singleton && row.itemID !== scope.shipID)
        .sort((a, b) => a.itemID - b.itemID)
        .map((row) => ({ itemID: row.itemID, origin: "corp" as const })),
    );
  }
  let corp: Awaited<ReturnType<typeof corporationFits>> | undefined;
  const approved: ExistingHull[] = [];
  for (const candidate of candidates) {
    const { itemID, origin } = candidate;
    let contents: NativeInventoryRow[];
    try {
      if (origin === "corp") {
        corp ??= await corporationFits(read, scope).catch(() => []);
        const root = stock.find((row) => row.itemID === itemID);
        if (
          !root ||
          !corp.some(
            (row) =>
              row.itemID === itemID &&
              row.typeID === typeID &&
              row.singleton &&
              row.locationID === root.locationID &&
              row.ownerID === scope.corporationID &&
              row.flagID === root.flagID,
          )
        )
          throw Error("The corporation did not confirm the exact assembled hull.");
        const children = corp.filter((row) => row.locationID === itemID);
        if (children.some((row) => row.ownerID !== scope.corporationID))
          throw Error("Corporate hull contents are unreadable.");
        contents = children.map((row) => ({ ...row, quantity: row.units }));
      } else contents = await personalFit(read, itemID, scope.characterID);
    } catch {
      unreadable = true;
      continue;
    }
    const fitted = observeFit(contents, wanted);
    if (!matchesSubset(fitted, wanted)) continue;
    const moves = planMoves(fitted, wanted, stock);
    if (!moves || (!take && moves.length)) continue;
    approved.push({
      ...candidate,
      fitted,
      moves,
      kind: moves.length === 0 ? "READY" : fitted.length ? "PARTIAL" : "EMPTY",
      requiresTake: origin === "corp" || moves.length > 0,
    });
    // Within the ready tier this order already minimizes boarding/withdrawal
    // and resolves Item ID ties, so further inventories cannot beat this fit.
    if (moves.length === 0) break;
  }
  // Exact matches first, then assembled ships with some correct kit, then empty.
  const rank = { READY: 0, PARTIAL: 1, EMPTY: 2 };
  const actions = (c: ExistingHull) =>
    c.moves.length + Number(c.origin !== "active") + Number(c.origin === "corp");
  const selection = approved.sort(
    (a, b) =>
      rank[a.kind] - rank[b.kind] ||
      actions(a) - actions(b) ||
      Number(b.origin === "active") - Number(a.origin === "active") ||
      a.itemID - b.itemID,
  )[0];
  if (!selection)
    return unreadable
      ? {
          selection: null,
          review: {
            ...native,
            canApply: false,
            plan: {
              ...native.plan,
              unsupported: [
                ...native.plan.unsupported,
                "An assembled hull could not be checked. Inspect its fitting before assembling another ship.",
              ],
            },
          },
        }
      : unchanged;

  const { itemID, origin, kind, fitted, moves, requiresTake } = selection;
  const plan = {
    ...native.plan,
    mode: "EXISTING_HULL",
    targetHullID: itemID,
    hullQuantity: 0,
    hullSourceItemID: null,
    hullSelection: {
      kind,
      origin,
      ...(origin === "corp" && source.kind === "corp" ? { division: source.division } : {}),
    },
    requirements: native.plan.requirements.map((row: Requirement) => {
      const current = quantity(fitted, row.flag, row.typeID);
      return { ...row, current, missing: row.quantity - current };
    }),
    candidateEquipment: fitted,
    requiresStockTake: requiresTake,
    requiresFitting: moves.some((move) => move.kind === "FITTED"),
    shortages: [],
    steps: [
      ...(origin === "corp" ? [`Withdraw assembled ship #${itemID} into the personal hangar`] : []),
      ...(origin !== "active" ? [`Board ship #${itemID}`] : []),
      ...(moves.length ? ["Install and load only the missing equipment"] : []),
      "Verify the active ship and exact fitting",
    ],
  };
  return {
    selection,
    review: {
      ...native,
      plan,
      canApply: ["VERIFIED", "MODIFIED"].includes(native.status?.equipment),
    },
  };
}

async function flightAt(read: Read, scope: Scope) {
  const { flight } = await read("/api/bridge/flight/status");
  if (flight?.docked !== true || flight.stationID !== scope.locationID || !positive(flight.shipID))
    throw Error("The pilot is no longer at the reviewed dock.");
  return flight.shipID as number;
}

export async function verifyPersonalHull(read: Read, scope: Scope, itemID: number, typeID: number) {
  await ask(read, "invCache", "InvalidateLocationCache", [itemID], undefined, true);
  const raw = await ask(read, "invbroker", "GetSelfInvItem", [], itemID);
  const [row] = checkedInventory({ type: "list", items: [raw] });
  if (
    !row ||
    row.itemID !== itemID ||
    row.typeID !== typeID ||
    !atHangar(row, scope) ||
    !singleton(raw?.fields ?? raw)
  )
    throw Error(`Assembled ship #${itemID} could not be verified in the personal hangar.`);
}

/** Each write is attempted once. The next step depends on its physical readback. */
export async function applyExistingHull(
  read: Read,
  review: any,
  selection: ExistingHull,
  beforeWrite?: () => void,
) {
  const scope: Scope = review.context,
    wanted = required(review),
    source = stockSource(review);
  const { itemID, origin, fitted, moves } = selection,
    typeID: number = review.plan.targetHullTypeID;
  let stage = "Checking the reviewed ship";
  const requireShip = async (shipID: number) => {
    if ((await flightAt(read, scope)) !== shipID)
      throw Error(`Active ship #${shipID} could not be confirmed.`);
  };
  const readFit = async () =>
    observeFit(await personalFit(read, itemID, scope.characterID), wanted);
  const write = async <T>(send: () => Promise<unknown>, verify: () => Promise<T>): Promise<T> => {
    beforeWrite?.();
    let failure: string | null = null;
    try {
      await send();
    } catch (error) {
      failure = errorText(error);
    }
    try {
      return await verify();
    } catch (error) {
      throw Error(`${errorText(error)}${failure ? ` ${failure}` : ""}`);
    }
  };

  try {
    await requireShip(scope.shipID);
    if (origin === "corp") {
      if (source.kind !== "corp" || review.source.access.take !== true)
        throw Error("Corporation withdrawal is unavailable.");
      stage = "Withdrawing the assembled ship";
      await write(
        () =>
          read("/api/bridge/inventory/transfer", { itemIDs: [itemID], from: source, to: hangar }),
        () => verifyPersonalHull(read, scope, itemID, typeID),
      );
    } else if (origin === "hangar") await verifyPersonalHull(read, scope, itemID, typeID);
    let actual = await readFit();
    if (JSON.stringify(actual) !== JSON.stringify(fitted))
      throw Error("The assembled ship's fitting changed after Review.");

    if (origin !== "active") {
      stage = "Boarding the reviewed ship";
      await requireShip(scope.shipID);
      await write(
        () => ask(read, "ship", "Board", [itemID, scope.shipID], undefined, true),
        () => requireShip(itemID),
      );
      actual = await readFit();
      if (JSON.stringify(actual) !== JSON.stringify(fitted))
        throw Error("The fitting changed during boarding.");
    }

    for (const move of moves) {
      stage = `Adding type ${move.typeID} to slot or bay ${move.flag}`;
      await requireShip(itemID);
      const before = actual,
        present = quantity(before, move.flag, move.typeID);
      if (
        !matchesSubset(before, wanted) ||
        (move.kind === "FITTED" && before.some((row) => row.flagID === move.flag))
      )
        throw Error("The destination is no longer suitable for the reviewed equipment.");
      actual = await write(
        () => {
          if (move.kind === "LOADED")
            return read("/api/bridge/inventory/transfer", {
              itemIDs: [move.itemID],
              qty: move.quantity,
              from: source,
              to: move.flag === 87 ? { kind: "shipBay", bay: "drone" } : { kind: "cargo" },
            });
          if (rig(move.flag))
            return ask(
              read,
              "invbroker",
              "FitFitting",
              [
                itemID,
                typeID,
                { [move.typeID]: [move.itemID] },
                move.locationID,
                { [move.flag]: move.typeID },
                {},
                true,
              ],
              itemID,
              true,
            );
          // A full fitting may swap an occupied regular slot. A single Add
          // to that exact slot is refused if it has become occupied.
          return ask(read, "invbroker", "Add", [move.itemID, move.locationID], itemID, true, {
            qty: 1,
            flag: move.flag,
          });
        },
        async () => {
          const after = await readFit();
          if (
            !matchesSubset(after, wanted) ||
            !retainsSlots(before, after) ||
            quantity(after, move.flag, move.typeID) !== present + move.quantity
          )
            throw Error("The full equipment change could not be confirmed.");
          return after;
        },
      );
    }
    stage = "Verifying the completed fitting";
    await requireShip(itemID);
    if (
      !retainsSlots(fitted, actual) ||
      wanted.some((row) => quantity(actual, row.flag, row.typeID) !== row.quantity)
    )
      throw Error("The complete fitting could not be verified.");
    return { ok: true as const };
  } catch (error) {
    const activeShipID = await flightAt(read, scope).catch(() => null);
    return {
      ok: false as const,
      activeShipID,
      reason: `Ship #${itemID}. ${stage}: ${errorText(error)}`,
    };
  }
}
