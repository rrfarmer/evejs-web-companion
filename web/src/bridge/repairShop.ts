// The repair shop, asked by the page itself as the client asks it (the plan's Phase 6b).
//
// Until 2026-10-10 the quote and the repair were two routes of the BFF (GET /api/bridge/station/repair-quotes and
// POST /api/bridge/station/repair). The quote's made the client's call by the service's name. The repair's made a
// call no client makes, repairSvc.RepairItems(itemIDs, None), which is the server's own name for both of the
// client's two, and named no payment: the server then charged the whole cost.
//
// THE CALLS, as the client's repair service makes them (station/repairshop/base_repairshop.py), each on a Moniker
// of repairSvc made anew for the one call (GetRemoteRepairMgr, 45 to 60: the dockable place, the place and its
// group; with neither a station nor a structure it raises):
//
//   GetRepairQuotes (63)   GetRepairQuotes(itemIDs)
//   RepairItems (65 to 70) RepairItemsInStation(itemIDs, payment), with a station in the session;
//                          RepairItemsInStructure(itemIDs), with a structure
//
// THE PAYMENT is the shop window's amount (RepairItems, 300 to 327): each listed part's ceil(damage) times its
// unit cost, added. With a module among the parts the pilot is asked yes or no to that whole cost, since a module
// is repaired in full or not at all; with none the pilot may name less of it. The page pays the whole cost, which
// is what its panel shows before the paying press, and what its bots are let pay by the tick that lets them.
// None of the three calls is in a Tranquility recording.
//
// WHAT THE SERVER TAKES FROM THE CALLER: the items named and the payment. It repairs only what of them is the
// session's own character's and is where the session is docked, from that character's wallet. In a structure it
// asks for the structure's repair service for itself. It refuses a session that is docked nowhere.
//
// The Moniker is the game port's to make (src/gamePort/pilots.js). Through the web gateway, whose list has the
// server's own name for a repair and no other, the BFF asks by that name (src/bridgeCallPolicy.js).

import type { Ask } from "./ask.ts";
import type { DockedIn } from "./officeWrites.ts";
import { decodeRepairQuotes, repairQuoteTotal, repairTargets, type RepairQuoteRow } from "./repairQuotes.ts";

/**
 * The shop's quote for these items: the damaged among them, each with its parts and their cost. With nothing
 * named the shop is not asked, as the client's window asks nothing for no rows.
 */
export async function quoteRepairs(ask: Ask, itemIDs: readonly number[]): Promise<readonly RepairQuoteRow[]> {
  if (itemIDs.length === 0) {
    return [];
  }
  return decodeRepairQuotes(await ask("repairSvc", "GetRepairQuotes", [[...itemIDs]]));
}

/**
 * Pays for the repair of what a quote lists: every damaged part's own ID, at the quote's whole cost in a station
 * and for nothing in a structure. With nothing listed nothing is asked. Fails as the call fails, and before it
 * where the pilot is docked nowhere or, in a station, the quote has a part with no price.
 */
export async function repairQuoted(act: Ask, quotes: readonly RepairQuoteRow[], where: DockedIn): Promise<void> {
  const targets = repairTargets(quotes);
  if (targets.length === 0) {
    return;
  }
  if (where.stationID !== null) {
    const payment = repairQuoteTotal(quotes);
    if (payment === null) {
      throw new Error("The repair shop did not say what that costs, so nothing was paid.");
    }
    await act("repairSvc", "RepairItemsInStation", [[...targets], payment]);
    return;
  }
  if (where.structureID === null) {
    throw new Error("You must be docked to use the repair shop.");
  }
  await act("repairSvc", "RepairItemsInStructure", [[...targets]]);
}

/**
 * Repairs these items where no quote is in hand (a bot's tick names items, not rows): the shop is asked its quote
 * for exactly them, and what it finds damaged is repaired at that quote.
 */
export async function repairItemsAtShop(ask: Ask, act: Ask, itemIDs: readonly number[], where: DockedIn): Promise<void> {
  await repairQuoted(act, await quoteRepairs(ask, itemIDs), where);
}
