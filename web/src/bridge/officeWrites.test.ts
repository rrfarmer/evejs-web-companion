// An office rented and given up by the page itself.

import test from "node:test";
import assert from "node:assert/strict";

import { giveUpOffice, OFFICE_RENTAL_DAYS, quoteOffice, rentOffice, type DockedIn, type OfficesHere } from "./officeWrites.ts";

const CORPORATION = 98000001;
const IN_A_STATION: DockedIn = { stationID: 60003760, structureID: null };
/** A pilot who may rent and may give up, whose corporation has no office here. */
const NO_OFFICE: OfficesHere = { available: true, ownOffice: false, canRent: true, canGiveUp: true };
const AN_OFFICE: OfficesHere = { ...NO_OFFICE, ownOffice: true };

function harness(answer: unknown = null, refusal: Error | null = null) {
  const asked: unknown[][] = [];
  const act = async (...call: unknown[]) => { asked.push(call); if (refusal) throw refusal; return answer as never; };
  return { asked, act };
}

test("an office's price is asked of the office manager for the pilot's own corporation, and kept as the station said it", async () => {
  const { asked, act } = harness(10000);

  // officeManager.GetPriceQuote (114): self.station.GetPriceQuote(session.corpid). appConst.rentalPeriodOffice: 30.
  assert.equal(OFFICE_RENTAL_DAYS, 30);
  assert.deepEqual(await quoteOffice(act, CORPORATION, NO_OFFICE, IN_A_STATION), { cost: 10000, days: 30, quoted: 10000 });
  assert.deepEqual(asked, [["officeManager", "GetPriceQuote", [CORPORATION]]]);
  // Tranquility's recording: answered the long 100113.
  const long = { type: "long", value: "100113" };
  assert.deepEqual(await quoteOffice(harness(long).act, CORPORATION, NO_OFFICE, IN_A_STATION), { cost: 100113, days: 30, quoted: long });
  // A price of nought is a price.
  assert.deepEqual(await quoteOffice(harness(0).act, CORPORATION, NO_OFFICE, IN_A_STATION), { cost: 0, days: 30, quoted: 0 });
});

test("what is no price is not handed on as one", async () => {
  for (const answer of [null, undefined, "10000", "cheap", -1, 10.5, Number.MAX_SAFE_INTEGER + 2, true, [10000], { type: "long", value: "cheap" }, { type: "long", value: "-5" }, { type: "long", value: 10000 }, { type: "long" }, { type: "real", value: 10000 }, { value: "10000" }, { type: "long", value: "9007199254740993" }]) {
    await assert.rejects(quoteOffice(harness(answer).act, CORPORATION, NO_OFFICE, IN_A_STATION), /The station did not say what an office costs\./, JSON.stringify(answer));
  }
});

test("an office is rented by one call of the office manager, with the price as it was quoted and nothing else", async () => {
  for (const quoted of [10000, 0, { type: "long", value: "100113" }]) {
    const { asked, act } = harness();
    await rentOffice(act, NO_OFFICE, IN_A_STATION, quoted);
    // officeManager.RentOffice (117): self.station.RentOffice(cost).
    assert.deepEqual(asked, [["officeManager", "RentOffice", [quoted]]], JSON.stringify(quoted));
  }
});

test("a rent with what is no price asks nothing", async () => {
  for (const quoted of [null, undefined, "10000", -1, 10.5, { type: "long", value: "cheap" }, { type: "real", value: 10000 }]) {
    const { asked, act } = harness();
    await assert.rejects(rentOffice(act, NO_OFFICE, IN_A_STATION, quoted as never), /The rent goes with the price that was quoted\./, JSON.stringify(quoted));
    assert.deepEqual(asked, []);
  }
});

test("an office is given up by one call of the office manager, with nothing", async () => {
  const { asked, act } = harness();

  await giveUpOffice(act, AN_OFFICE, IN_A_STATION);

  // officeManager.UnrentOffice (122): self.station.UnrentOffice().
  assert.deepEqual(asked, [["officeManager", "UnrentOffice", []]]);
});

test("where the client's lobby has no button, nothing is asked: the role, and whether the corporation has an office here", async () => {
  // dockedUI/offices.py, _load_buttons: to rent, can_rent and no office; to give up, can_unrent and an office.
  const cases: ReadonlyArray<readonly [string, (act: never) => Promise<unknown>, RegExp]> = [
    ["a price without the renting role", (act) => quoteOffice(act, CORPORATION, { ...NO_OFFICE, canRent: false }, IN_A_STATION), /Renting an office takes the role that may rent one\./],
    ["a rent without the renting role", (act) => rentOffice(act, { ...NO_OFFICE, canRent: false }, IN_A_STATION, 10000), /Renting an office takes the role that may rent one\./],
    ["a price where there is an office", (act) => quoteOffice(act, CORPORATION, AN_OFFICE, IN_A_STATION), /Your corporation has an office in this station already\./],
    ["a rent where there is an office", (act) => rentOffice(act, AN_OFFICE, IN_A_STATION, 10000), /Your corporation has an office in this station already\./],
    ["a giving up by one who is no director", (act) => giveUpOffice(act, { ...AN_OFFICE, canGiveUp: false }, IN_A_STATION), /Giving up an office takes a director\./],
    ["a giving up where there is no office", (act) => giveUpOffice(act, NO_OFFICE, IN_A_STATION), /Your corporation has no office in this station\./],
  ];
  for (const [why, attempt, words] of cases) {
    const { asked, act } = harness(10000);
    await assert.rejects(attempt(act as never), words, why);
    assert.deepEqual(asked, [], why);
  }
});

test("nothing is asked in space, before the offices are listed, on a connection that does not carry them, or in a structure", async () => {
  const places: ReadonlyArray<readonly [string, OfficesHere | null, DockedIn, RegExp]> = [
    ["in space", AN_OFFICE, { stationID: null, structureID: null }, /An office is rented or given up while docked in the station\./],
    ["not listed yet", null, IN_A_STATION, /The station's offices have not been listed yet\./],
    ["the gateway", { ...AN_OFFICE, available: false }, IN_A_STATION, /This pilot's connection does not carry a station's offices\./],
    ["a structure", AN_OFFICE, { stationID: null, structureID: 1030000000001 }, /An office in a structure is not rented or given up from here\./],
    // A flight that names the structure as the station too: a structure's all the same, as the route took it.
    ["a structure named twice", AN_OFFICE, { stationID: 1030000000001, structureID: 1030000000001 }, /An office in a structure is not rented or given up from here\./],
    // In space is said first, as the route said it.
    ["in space and not listed", null, { stationID: null, structureID: null }, /while docked in the station/],
  ];
  for (const [why, offices, where, words] of places) {
    for (const attempt of [
      (act: never) => quoteOffice(act, CORPORATION, offices && { ...offices, ownOffice: false }, where),
      (act: never) => rentOffice(act, offices && { ...offices, ownOffice: false }, where, 10000),
      (act: never) => giveUpOffice(act, offices, where),
    ]) {
      const { asked, act } = harness(10000);
      await assert.rejects(attempt(act as never), words, why);
      assert.deepEqual(asked, [], why);
    }
  }
});

test("a price is not asked for a corporation that is not known", async () => {
  for (const corporationID of [null, 0, -1, 1.5, Number.NaN]) {
    const { asked, act } = harness(10000);
    await assert.rejects(quoteOffice(act, corporationID, NO_OFFICE, IN_A_STATION), /Which corporation the pilot is in is not known yet\./, String(corporationID));
    assert.deepEqual(asked, []);
  }
});

test("the server's refusal is the caller's, as it came", async () => {
  const refused = new Error("CrpAccessDenied");
  await assert.rejects(quoteOffice(harness(null, refused).act, CORPORATION, NO_OFFICE, IN_A_STATION), /CrpAccessDenied/);
  await assert.rejects(rentOffice(harness(null, refused).act, NO_OFFICE, IN_A_STATION, 10000), /CrpAccessDenied/);
  await assert.rejects(giveUpOffice(harness(null, refused).act, AN_OFFICE, IN_A_STATION), /CrpAccessDenied/);
});
