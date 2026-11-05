// Holdings shared by every view that counts goods across pilots: corp hangar
// divisions, which corporations are worth reading, and the words for a place.

import test from "node:test";
import assert from "node:assert/strict";

import {
  compareHoldings,
  corpDivisionOfFlag,
  decodeStockStack,
  holdingsFromCorpReads,
  isPlayerCorporation,
  stationWords,
  type CorpStockRead,
  type Holding,
} from "./stockHoldings.ts";

// ESI's documented example ids, and obviously synthetic ones for the rest.
const CORP = 98000001;
const STATION = 60000004;

test("corp divisions are flags 115 to 121; NPC corporations have no hangars worth reading", () => {
  assert.equal(corpDivisionOfFlag(115), 1);
  assert.equal(corpDivisionOfFlag(121), 7);
  assert.equal(corpDivisionOfFlag(4), null);
  assert.equal(corpDivisionOfFlag(122), null);
  assert.equal(isPlayerCorporation(1000044), false);
  assert.equal(isPlayerCorporation(CORP), true);
  assert.equal(isPlayerCorporation(null), false);
});

test("a stack is said with what holds it, and a malformed one is dropped", () => {
  const ship = decodeStockStack({ typeID: 34, quantity: 10, locationID: STATION, locationName: "Jita IV - Moon 4", holder: "ship", holderName: "Hauler One" });
  assert.equal(ship && stationWords(ship), "Jita IV - Moon 4, in Hauler One's cargo");
  const hangar = decodeStockStack({ typeID: 34, quantity: 10, locationID: STATION, holder: "hangar", holderName: "ignored" });
  assert.equal(hangar && stationWords(hangar), "a place this map does not name hangar");
  assert.equal(hangar?.holderName, null);
  assert.equal(decodeStockStack({ typeID: 34, quantity: 0 }), null);
});

test("corp holdings are named by the caller's book, or left for the view to name", () => {
  const read: CorpStockRead = {
    corporationID: CORP,
    corporationName: null,
    state: "read",
    viaCharacterID: null,
    viaBot: false,
    readAtMs: 1,
    items: [{ typeID: 34, quantity: 5, locationID: STATION, locationName: "Jita IV - Moon 4", division: 2 }],
    refusals: [],
  };
  const named = holdingsFromCorpReads([read], () => "Tritanium");
  assert.deepEqual(named.map((holding) => [holding.typeName, holding.placeWords, holding.ownerWords]), [
    ["Tritanium", "Jita IV - Moon 4 office, division 2", "Your corporation"],
  ]);
  assert.equal(holdingsFromCorpReads([read], null)[0]?.typeName, null);
  assert.deepEqual(holdingsFromCorpReads([{ ...read, state: "failed" }], null), []);
});

test("holdings sort colony, then hangar, then corp, largest first within each", () => {
  const holding = (source: Holding["source"], quantity: number): Holding => ({
    typeID: 34, typeName: null, quantity, source, placeWords: "", ownerWords: "", planetID: null, readAtMs: null, clockOffsetMs: 0,
  });
  const sorted = [holding("corp", 9), holding("hangar", 1), holding("colony", 2), holding("hangar", 5)].sort(compareHoldings);
  assert.deepEqual(sorted.map((entry) => [entry.source, entry.quantity]), [["colony", 2], ["hangar", 5], ["hangar", 1], ["corp", 9]]);
});
