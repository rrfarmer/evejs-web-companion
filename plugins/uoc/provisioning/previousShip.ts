import { isSlotFlag, officeAt } from "../../../web/src/plugin-api/flying.ts";
import { checkedInventory, corpDivisionFlag } from "../shared/nativeInventory.ts";
import { readRowField } from "../shared/wire.ts";

type Read = (path: string, body?: unknown) => Promise<any>;
type ShipContext = {
  characterID: number;
  corporationID: number;
  shipID: number;
  shipTypeID: number;
  locationID: number;
};
export type StoragePlan = ShipContext & { officeID: number; division: number };
export type ShipStorageProof = {
  itemID: number;
  location: number;
  division: number;
  contentsCount: number;
};

const positive = (id: number) => Number.isSafeInteger(id) && id > 0;
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

async function ask(
  read: Read,
  service: string,
  method: string,
  args: readonly unknown[] = [],
  of?: number,
) {
  const reply = await read("/api/bridge/call", {
    service,
    method,
    args,
    kwargs: null,
    pilot: true,
    ...(of === undefined ? {} : { of }),
    ...(service === "invCache" ? { confirm: true } : {}),
  });
  return reply.result;
}

const officeFor = (read: Read, stationID: number) =>
  officeAt((service, method, args) => ask(read, service, method, args), stationID);

export async function reviewPreviousShipStorage(
  read: Read,
  context: ShipContext,
  replacing: boolean,
  division?: number,
) {
  if (division === undefined || !replacing) return { plan: null, reason: null };
  try {
    corpDivisionFlag(division);
    if (
      ![
        context.characterID,
        context.corporationID,
        context.shipID,
        context.shipTypeID,
        context.locationID,
      ].every(positive)
    )
      throw Error("The previous ship or its dock could not be identified.");
    const officeID = await officeFor(read, context.locationID);
    if (officeID === null) throw Error("The corporation has no verified office at this dock.");
    const { characterID, corporationID, shipID, shipTypeID, locationID } = context;
    return {
      plan: {
        characterID,
        corporationID,
        shipID,
        shipTypeID,
        locationID,
        officeID,
        division,
      } satisfies StoragePlan,
      reason: null,
    };
  } catch (error) {
    return {
      plan: null,
      reason: `Previous ship storage in corporation Division ${division} is unavailable. ${errorText(error)}`,
    };
  }
}

/** Runs on the same held pilot, after the replacement and its fit are verified. */
export async function storePreviousShip(
  read: Read,
  plan: StoragePlan,
  newShipID: number,
  beforeTransfer?: () => void,
) {
  const { characterID, corporationID, shipID, shipTypeID, locationID, officeID, division } = plan;
  const flag = corpDivisionFlag(division);
  const oldShip = `Previous ship #${shipID}`;
  const freshItem = async (itemID: number) => {
    await ask(read, "invCache", "InvalidateLocationCache", [itemID]);
    const raw = await ask(read, "invbroker", "GetSelfInvItem", [], itemID);
    const [row] = checkedInventory({ type: "list", items: [raw] });
    return { ...row!, singleton: readRowField(raw, "singleton") };
  };
  const inPersonalHangar = (row: Awaited<ReturnType<typeof freshItem>>) =>
    row.itemID === shipID &&
    row.typeID === shipTypeID &&
    row.ownerID === characterID &&
    row.locationID === locationID &&
    row.flagID === 4 &&
    (row.singleton === 1 || row.singleton === true);

  try {
    const original = await freshItem(shipID);
    if (newShipID === shipID || !inPersonalHangar(original))
      throw Error(`${oldShip} could not be verified in the personal hangar at the reviewed dock.`);
    const fitted = checkedInventory(await ask(read, "invbroker", "List", [], shipID)).filter(
      (row) => isSlotFlag(row.flagID),
    );
    if (fitted.some((row) => row.locationID !== shipID || row.ownerID !== characterID))
      throw Error(`The installed equipment of ship #${shipID} could not be verified.`);
    if ((await officeFor(read, locationID)) !== officeID)
      throw Error("The corporation office changed after Review.");
    const { flight } = await read("/api/bridge/flight/status");
    if (flight?.docked !== true || flight.stationID !== locationID || flight.shipID !== newShipID)
      throw Error("The replacement ship is no longer at the reviewed dock.");
    beforeTransfer?.();

    let transferFailure: string | null = null;
    try {
      const transfer = await read("/api/bridge/inventory/transfer", {
        itemIDs: [shipID],
        from: { kind: "hangar" },
        to: { kind: "corp", division },
      });
      if (Array.isArray(transfer.declined) && transfer.declined.includes(shipID))
        transferFailure = "The inventory transfer was declined.";
    } catch (error) {
      transferFailure = errorText(error);
    }

    // An unanswered transfer can still have landed. Read the one selected division without replaying it.
    await ask(read, "invCache", "InvalidateLocationCache", [officeID]);
    const stored = checkedInventory(await ask(read, "invbroker", "List", [flag], officeID)).find(
      (row) =>
        row.itemID === shipID &&
        row.typeID === shipTypeID &&
        row.ownerID === corporationID &&
        row.flagID === flag,
    );
    if (!stored) {
      const personal = await freshItem(shipID)
        .then(inPersonalHangar)
        .catch(() => false);
      const location = personal
        ? "is still in the personal hangar"
        : `could not be verified in corporation Division ${division}`;
      throw Error(`${oldShip} ${location}.${transferFailure ? ` ${transferFailure}` : ""}`);
    }

    // A corporate ship's List can omit its fit. Read the known items themselves under the division's Query authority.
    for (const item of fitted) {
      const after = await freshItem(item.itemID).catch(() => null);
      if (
        !after ||
        after.itemID !== item.itemID ||
        after.typeID !== item.typeID ||
        after.ownerID !== corporationID ||
        after.locationID !== shipID ||
        after.flagID !== item.flagID ||
        after.quantity !== item.quantity
      )
        throw Error(
          `${oldShip} is in corporation Division ${division}. Installed item #${item.itemID} could not be verified in its original slot.`,
        );
    }
    return {
      proof: {
        itemID: shipID,
        location: stored.locationID,
        division,
        contentsCount: fitted.length,
      } satisfies ShipStorageProof,
      reason: null,
    };
  } catch (error) {
    return { proof: null, reason: errorText(error) };
  }
}

export function previousShipStorageProof(
  stored: ShipStorageProof | null | undefined,
  itemID: number,
  division?: number,
): ShipStorageProof | null {
  if (
    division === undefined ||
    stored?.itemID !== itemID ||
    stored.division !== division ||
    !positive(stored.location) ||
    !Number.isSafeInteger(stored.contentsCount) ||
    stored.contentsCount < 0
  )
    return null;
  return { itemID, location: stored.location, division, contentsCount: stored.contentsCount };
}
