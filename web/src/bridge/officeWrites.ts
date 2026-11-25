// An office in a station rented and given up, and its price asked, by the page itself (the plan's Phase 6b).
//
// Until 2026-10-10 these were three routes of the BFF (GET /api/bridge/station/office/quote, POST .../office/rent,
// POST .../office/give-up). Each read the pilot's flight, refused a pilot not docked in a station on the game
// port, checked the role the client's button needs as the BFF holds the session's roles, and made one call.
//
// THE CALLS, as the client's lobby makes them (dockedUI/offices.py; services/corporation/officeManager.py), each
// on the office manager's object for where the session is docked:
//
//   _rent_office (135 to 146)     cost = GetPriceQuote(session.corpid) (114); the pilot is asked, with the cost
//                                 and thirty days (appConst.rentalPeriodOffice); on yes, RentOffice(cost) (117).
//   _unrent_office (148 to 163)   nothing without an office; the pilot is asked; on yes, UnrentOffice() (122).
//
// The rent button is there for a pilot whose session has the renting role, where the corporation has no office in
// the station; the other for a director, where it has one (_load_buttons, 108 to 116).
//
// Tranquility's recordings have all three: GetPriceQuote(98838096) answered the LONG 100113, and RentOffice was
// sent that long back; UnrentOffice went with nothing. So the price goes back as the station said it. This
// server says a long too (eve.js 75b222d73), and the game port hands the page that answer with its long kept
// (src/gamePort/pilots.js, HANDED_BACK_AS_ANSWERED): the price is {type: "long", value: "<digits>"} here, and
// what is handed back is that. A station that says a plain whole number gets a plain whole number.
//
// WHAT THE SERVER TAKES FROM THE CALLER: nothing. It rents for the session's own corporation, where the session
// is, at its own price, and refuses a session without the role (CrpAccessDenied) or the ISK; it gives up the
// session's own corporation's office there, and refuses one who is no director.
//
// WHAT THE ROUTES KNEW THAT THE PAGE NOW GOES BY: the listing of the station's offices (the BFF's read still:
// whether this connection carries the offices at all, whether the corporation has one here, and the two roles),
// and the pilot's flight for where it is docked. Neither call lists the offices after: the server's notice of
// the office does, as in the client.
//
// IN A STRUCTURE the lobby's buttons and the three calls are the same: the office manager's object is for
// session.stationid or session.structureid (officeManager.py 49 to 56), and the structure's controller has the
// base controller's rent, price and giving up (dockedUI/controllers/structureController.py). Seen on this server
// 2026-10-12: a price quoted in a complex, an office rented at it, its hangar's divisions listed and moved into.
// The routes this stands in for refused a structure; this does not.

import type { Ask } from "./ask.ts";
import { unwrapReal, type JsonValue } from "./wire.ts";

/** appConst.rentalPeriodOffice: the days an office's rent pays for. */
export const OFFICE_RENTAL_DAYS = 30;

/** What the page's listing of a station's offices says that the lobby's two buttons go by. */
export interface OfficesHere {
  /** False where the pilot's connection does not carry a station's offices. */
  readonly available: boolean;
  readonly ownOffice: boolean;
  readonly canRent: boolean;
  readonly canGiveUp: boolean;
}

/** Where the pilot is docked: session.stationid and session.structureid, each null where it is not. */
export interface DockedIn {
  readonly stationID: number | null;
  readonly structureID: number | null;
}

/** An office's price: its number, the days it pays for, and the price as the station said it, to rent with. */
export interface OfficeQuote {
  readonly cost: number;
  readonly days: number;
  readonly quoted: JsonValue;
}

/** A price as a station's office manager says one: a whole number not below nought, or a long of one (its digits). */
function priceOf(value: JsonValue | undefined): number | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const long = value as { readonly type?: JsonValue; readonly value?: JsonValue };
  if (long.type !== "long" || typeof long.value !== "string" || !/^\d+$/.test(long.value)) {
    return null;
  }
  const cost = Number(long.value);
  return Number.isSafeInteger(cost) ? cost : null;
}

/** Office impound release can cost a fractional ISK, unlike the rent quote. */
export function impoundReleaseCost(quote: JsonValue): number | null {
  const cost = unwrapReal(quote) ?? priceOf(quote);
  return cost !== null && cost >= 0 && cost <= Number.MAX_SAFE_INTEGER ? cost : null;
}

/** The listed offices of where the pilot is docked, a station or a structure, on a connection that carries them; or the reason there are none to act on. */
function officesIn(offices: OfficesHere | null, where: DockedIn): OfficesHere {
  if (where.stationID === null && where.structureID === null) {
    throw new Error("An office is rented or given up while docked in the station.");
  }
  if (offices === null) {
    throw new Error("The station's offices have not been listed yet.");
  }
  if (!offices.available) {
    throw new Error("This pilot's connection does not carry a station's offices.");
  }
  return offices;
}

/** The same, for a pilot the client's lobby would show the rent button. */
function officesToRent(offices: OfficesHere | null, where: DockedIn): void {
  const here = officesIn(offices, where);
  if (!here.canRent) {
    throw new Error("Renting an office takes the role that may rent one.");
  }
  if (here.ownOffice) {
    throw new Error("Your corporation has an office in this station already.");
  }
}

/**
 * What an office in the station costs the pilot's corporation, for thirty days, asked as the lobby's rent button
 * asks it. An answer that is no price is an error: the player is never shown a price nobody quoted.
 */
export async function quoteOffice(ask: Ask, corporationID: number | null, offices: OfficesHere | null, where: DockedIn): Promise<OfficeQuote> {
  officesToRent(offices, where);
  if (corporationID === null || !Number.isSafeInteger(corporationID) || corporationID <= 0) {
    throw new Error("Which corporation the pilot is in is not known yet.");
  }
  const quoted = await ask("officeManager", "GetPriceQuote", [corporationID]);
  const cost = priceOf(quoted);
  if (cost === null) {
    throw new Error("The station did not say what an office costs.");
  }
  return { cost, days: OFFICE_RENTAL_DAYS, quoted };
}

/** Rents the corporation an office in the station at the price it was quoted, the player having said yes to it. */
export async function rentOffice(act: Ask, offices: OfficesHere | null, where: DockedIn, quoted: JsonValue): Promise<void> {
  officesToRent(offices, where);
  if (priceOf(quoted) === null) {
    throw new Error("The rent goes with the price that was quoted.");
  }
  await act("officeManager", "RentOffice", [quoted]);
}

/** Gives up the corporation's office in the station, the player having said yes. */
export async function giveUpOffice(act: Ask, offices: OfficesHere | null, where: DockedIn): Promise<void> {
  const here = officesIn(offices, where);
  if (!here.canGiveUp) {
    throw new Error("Giving up an office takes a director.");
  }
  if (!here.ownOffice) {
    throw new Error("Your corporation has no office in this station.");
  }
  await act("officeManager", "UnrentOffice", []);
}
