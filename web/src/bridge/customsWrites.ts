// A launchpad's goods sent up into its planet's customs office by the page itself (the plan's Phase 6b): the
// second of the page's own calls on an inventory's own object, after a module's fitting (bridge/fitModule.ts).
//
// Until 2026-10-13 it was a route of the BFF's (POST /api/bridge/planet/customs/export), which read the pilot's
// flight to refuse a docked pilot, asked the office's tax rate, and made the transfer naming it.
//
// THE CALLS, as the client's customs window makes them (eve/client/script/ui/shared/planet/importExportUI.py):
//
//   the office's tax rate   UpdateTaxRate (382 to 385):
//                             eveMoniker.GetPlanetOrbitalRegistry(session.solarsystemid).GetTaxRate(officeID)
//                           on a Moniker for the system the session is in space in. None where the office's
//                           owner does not let the pilot use it: the window then says so, and refuses an export
//                           (ExportCommodity, 467 to 469: PortStandingCheckFail).
//   the transfer            ConfirmCommodityTransfer (537 to 558), on the office's own inventory:
//                             invCache.GetInventoryFromId(officeID).ImportExportWithPlanet(spaceportPinID,
//                               importData, exportData, self.taxRate)
//                           what comes down a dict of quantities by the item in the office, what goes up a dict
//                           of quantities by type, and the rate the registry answered.
//
// The window is opened at an office, in space (ApplyAttributes, 81 to 103: the office's slim item from the
// ballpark), and its registry Moniker is for the system the session is in space in: a docked client has neither.
// The page asks it only where the pilot is in space, as the route did. Up only: nothing comes down here.
//
// WHAT THE SERVER TAKES FROM THE CALLER (read 2026-10-09, at the route's making): the colony from the session's
// own character and the pin, the office checked to be that colony's planet's, the tax from the session's own
// wallet. A pin or an office that is not the pilot's own to use moves nothing. A rate that is not the office's is
// refused, TaxChanged.

import type { Ask } from "./ask.ts";
import type { ColonyPin, InventoryItemRow, CapacityInfo, SpaceSnapshot } from "../store/types.ts";
import type { DogmaStatic } from "./dogma/location.ts";
import type { JsonValue } from "./wire.ts";

/** What the window says where the registry names no rate (CustomsOfficeAccessDenied), as the route said it. */
export const CUSTOMS_ACCESS_DENIED = "This customs office named no tax rate: its owner does not let this pilot use it.";

/** Where the pilot is: docked at a station or a structure, or in space (null). */
export interface CustomsPlace {
  readonly dockedAt: number | null;
}

const whole = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/** The registry's rate as a number, however the wire spelled it; null for none. */
export function taxRateOf(answer: unknown): number | null {
  const value = answer !== null && typeof answer === "object" && (answer as { type?: unknown }).type === "real"
    ? (answer as { value?: unknown }).value
    : answer;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export const CUSTOMS_OFFICE_GROUP_ID = 1025;

export function customsOfficeForPlanet(snapshot: SpaceSnapshot | null, planetID: number) {
  return snapshot?.inSpace
    ? snapshot.entities.find(entity => entity.groupID === CUSTOMS_OFFICE_GROUP_ID && entity.planetID === planetID)
    : undefined;
}

export interface CustomsOfficeRead {
  readonly officeID: number;
  readonly planetName: string;
  readonly pads: readonly ColonyPin[];
  readonly rows: readonly InventoryItemRow[];
  readonly capacity: CapacityInfo | null;
  readonly taxRate: number | null;
  readonly facts: DogmaStatic["types"];
  readonly volumes: Readonly<Record<number, number | null>>;
}

export interface CustomsTransfer {
  readonly pinID: number;
  readonly imports: Readonly<Record<number, number>>;
  readonly exports: Readonly<Record<number, number>>;
}

export interface CustomsQuote {
  readonly importTax: number;
  readonly exportTax: number;
  readonly landedVolume: number;
  readonly liftedVolume: number;
}

export function customsCommodity(type: { categoryID: number | null; groupID: number | null }): boolean {
  return type.categoryID === 42 || type.categoryID === 43 || (type.categoryID === 17 && type.groupID === 280);
}

// The installed SpaceportPin uses importTaxMultiplier for both directions.
const IMPORT_TAX = 1638;
const EXPORT_TAX = 1639;
const IMPORT_TAX_MULTIPLIER = 1640;
const VOLUME_TOLERANCE = 1e-5;
const cents = (amount: number) => Math.round(amount * 100) / 100;

export function quoteCustomsTransfer(office: CustomsOfficeRead, transfer: CustomsTransfer): CustomsQuote {
  const pad = office.pads.find(pin => pin.pinID === transfer.pinID);
  if (!pad) throw new Error("Select an installed launchpad.");
  const rate = office.taxRate;
  if (rate === null) throw new Error(CUSTOMS_ACCESS_DENIED);
  const launchpad = pad;
  const attribute = (typeID: number, id: number) => office.facts[typeID]?.attributes.find(([key]) => key === id)?.[1];

  function total(quantities: CustomsTransfer["imports"], importing: boolean) {
    let volume = 0;
    let tax = 0;
    for (const [key, quantity] of Object.entries(quantities)) {
      const item = importing ? office.rows.find(row => row.itemID === Number(key))
        : launchpad.contents.find(row => row.typeID === Number(key));
      if (!item || !whole(quantity) || quantity > item.quantity) {
        throw new Error("Enter a whole quantity within the available stack.");
      }
      const facts = office.facts[item.typeID];
      if (!facts || !customsCommodity(facts)) throw new Error("This commodity cannot pass through customs.");
      const perUnit = office.volumes[item.typeID];
      const multiplier = attribute(item.typeID, IMPORT_TAX_MULTIPLIER) ?? 0;
      const pinRate = attribute(launchpad.typeID, importing ? IMPORT_TAX : EXPORT_TAX);
      if (perUnit == null || !Number.isFinite(perUnit) || pinRate == null) {
        throw new Error("Commodity volume or customs tax data is unavailable.");
      }
      volume += perUnit * quantity;
      tax += quantity * pinRate * multiplier;
    }
    return { volume, tax };
  }

  const imported = total(transfer.imports, true);
  const exported = total(transfer.exports, false);
  // The installed customs window checks each destination's free space before settlement.
  if (imported.volume > 0 && (pad.usedM3 === null || pad.capacityM3 === null)) {
    throw new Error("Launchpad capacity is unavailable.");
  }
  if (imported.volume > 0 && imported.volume - ((pad.capacityM3 ?? 0) - (pad.usedM3 ?? 0)) > VOLUME_TOLERANCE) {
    throw new Error("The launchpad does not have enough free space.");
  }
  if (exported.volume > 0 && !office.capacity) throw new Error("Customs office capacity is unavailable.");
  if (exported.volume > 0 && office.capacity && exported.volume - (office.capacity.capacity - office.capacity.used) > VOLUME_TOLERANCE) {
    throw new Error("The customs office does not have enough free space.");
  }
  return { importTax: cents(imported.tax * rate), exportTax: cents(exported.tax * rate),
    landedVolume: imported.volume, liftedVolume: exported.volume };
}

export async function transferAtCustomsOffice(act: Ask, officeID: number, transfer: CustomsTransfer, answered: JsonValue): Promise<void> {
  await act("invbroker", "ImportExportWithPlanet", [transfer.pinID, transfer.imports, transfer.exports, answered], null, officeID);
}

/**
 * Sends one launchpad's goods up into the customs office: the office's tax rate asked, and the transfer made on
 * the office's own inventory naming that rate, as it was answered. Fails as either call fails, and where the
 * office names no rate.
 */
export async function exportToCustomsOffice(
  ask: Ask,
  act: Ask,
  place: CustomsPlace,
  officeID: number,
  pinID: number,
  commodities: Readonly<Record<number, number>>,
): Promise<void> {
  const given = Object.entries(commodities);
  if (!whole(officeID) || !whole(pinID) || given.length === 0 || !given.every(([typeID, quantity]) => /^\d+$/.test(typeID) && whole(Number(typeID)) && whole(quantity))) {
    throw new Error("A customs office, a launchpad and a whole quantity of each commodity are required.");
  }
  if (place.dockedAt !== null) throw new Error("The ship is not in space; undock first.");
  const answered = await ask("planetOrbitalRegistryBroker", "GetTaxRate", [officeID]);
  if (taxRateOf(answered) === null) throw new Error(CUSTOMS_ACCESS_DENIED);
  await transferAtCustomsOffice(act, officeID, { pinID, imports: {}, exports: Object.fromEntries(given) }, answered);
}
