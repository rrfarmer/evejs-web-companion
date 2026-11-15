"use strict";

// The broker's fee rate as the retail client works it out (src/gamePort/brokerFee.js). The rates it is held to
// are the client's own Python's, for the same sums in the same order (test/fixtures/brokerFeeOracle.json): the
// server compares the rate a client names with its own, so a rate that is off in its last digits matters.

const test = require("node:test");
const assert = require("node:assert/strict");

const { brokersFeeRate, brokersFeeRateInStructure } = require("../src/gamePort/brokerFee");
const oracle = require("./fixtures/brokerFeeOracle.json");
const structureOracle = require("./fixtures/brokerFeeStructureOracle.json");

test("the rate is the client's own, to the last digit, for every case its Python was asked", () => {
  assert.ok(oracle.cases.length > 100);
  for (const [brokerRelations, factionToCharStanding, corpToCharStanding, upgradeLevel, rate] of oracle.cases) {
    assert.equal(brokersFeeRate({ brokerRelations, factionToCharStanding, corpToCharStanding, upgradeLevel }), rate, JSON.stringify([brokerRelations, factionToCharStanding, corpToCharStanding, upgradeLevel]));
  }
  // The cases tell the parts apart: a skill, each standing and an upgrade each change some of them.
  const rates = (pick) => new Set(oracle.cases.filter(pick).map((each) => each[4]));
  assert.ok(rates(([, faction, corp, level]) => faction === 0 && corp === 0 && level === 0).size === 5, "five skill levels, five rates");
  assert.ok(rates(([broker, , , level]) => broker === 0 && level === 0).size === 7, "seven pairs of standings, seven rates");
  assert.ok(rates(([broker, faction, corp]) => broker === 0 && faction === 0 && corp === 0).size === 3, "three upgrade levels, three rates");
});

test("with no upgrade named the system has none; a standing is the standing, good or bad", () => {
  assert.equal(brokersFeeRate({ brokerRelations: 0, factionToCharStanding: 0, corpToCharStanding: 2.1 }), 0.02958);
  assert.equal(brokersFeeRate({ brokerRelations: 0, factionToCharStanding: 0, corpToCharStanding: 0 }), 0.03);
  // A pilot the owner dislikes pays more than the base.
  assert.ok(brokersFeeRate({ brokerRelations: 0, factionToCharStanding: -2.5, corpToCharStanding: -9.99 }) > 0.03);
  // Each level of Broker Relations takes 0.3 of a percent off.
  assert.ok(Math.abs(brokersFeeRate({ brokerRelations: 5, factionToCharStanding: 0, corpToCharStanding: 0 }) - 0.015) < 1e-12);
});

test("Oris applies its 24.02 commission modifier before owner and faction standings", () => {
  const pilot = { brokerRelations: 2, factionToCharStanding: 4, corpToCharStanding: 1.5 };
  assert.equal(brokersFeeRate({ ...pilot, stationID: 60008494 }), 0.0105);
  assert.equal(brokersFeeRate({ ...pilot, stationID: 60003760 }), 0.0225);
});

test("the rate in a structure is the client's own, to the last digit, for every case its Python was asked: the structure's tax over a hundred, True for one percent, and nothing for no tax", () => {
  assert.equal(structureOracle.cases.length, 42);
  for (const [marketTax, upgradeLevel, rate] of structureOracle.cases) {
    assert.equal(brokersFeeRateInStructure({ marketTax, upgradeLevel }), rate, JSON.stringify([marketTax, upgradeLevel]));
  }
  // The cases tell the parts apart: a tax, and an upgrade, each change some of them; and no tax, a tax of nought and
  // False are all a rate of nothing.
  const rates = (pick) => new Set(structureOracle.cases.filter(pick).map((each) => each[2]));
  assert.equal(rates(([tax, level]) => level === 0 && tax !== null && Number(tax) > 0).size, 8, "eight taxes, eight rates");
  assert.equal(rates(([tax]) => tax === 10).size, 3, "three upgrade levels, three rates");
  assert.deepEqual([...rates(([tax]) => tax === null || tax === false || tax === 0)], [0]);
  // With no upgrade named the system has none.
  assert.deepEqual([brokersFeeRateInStructure({ marketTax: 2.5 }), brokersFeeRateInStructure({ marketTax: true }), brokersFeeRateInStructure({ marketTax: null })], [0.025, 0.01, 0]);
});
