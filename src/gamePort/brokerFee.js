"use strict";

// The broker's fee rate at an NPC station, as the retail client works it out.
//
// The client names this rate when it places an order: it is a buy order's ninth
// argument (buyThisTypeWindow.py 701), a sale's fourth for an order that stands
// (sellMulti.py 462), and a field of each item of a sale (sellMulti.py 501).
// The server works the rate out for itself and refuses an order whose named
// rate is not its own (MktBrokersFeeUnexpected2).
//
//   marketsvc.GetBrokersFeeCommissionFromStationID(stationID)            (161)
//     SkillLimits.GetBrokersFeeForLocation                 (skilllimits.py 25)
//         the base, 3 percent, less 0.3 of a percent for each level of
//         Broker Relations the pilot has in effect
//         halve the result at Amarr VIII (Oris) in 24.02
//     BrokerFeeProvider.GetAdjustedCommissionPercentage      (brokerFee.py 62)
//         facwarCommon.GetAdjustedFeePercentage: a tenth off for each level
//             the system is upgraded to, where the militias fight over it
//         less 0.0003 for each point of standing the station's owner's
//             faction has to the pilot, and 0.0002 for each point the owner
//             itself has: standingSvc.GetStanding(fromID, session.charid),
//             the standing kept, or none (marketsvc.py 745)
//
// The sums are in the client's order, one operation at a time, so that the
// float is the client's to the last digit: the test holds it to the client's
// own Python.
//
// A structure's rate is the second function's: its base is the structure's own
// market tax, which whoever calls it has asked of the server, and no skill and
// no standing is in it.
//
// Not here: the upgrade level itself, which the client asks of the war's
// manager for a system in a warzone. Whoever calls these names the level.

const MARKET_COMMISSION_PERCENTAGE = 3.0;
const BROKER_RELATIONS_SKILL_MODIFIER = 0.3;
const MARKET_FACTION_STANDING_MULTIPLIER = 0.0003;
const MARKET_NPC_CORP_STANDING_MULTIPLIER = 0.0002;
const STATION_AMARR_VIII_ORIS = 60008494;

/**
 * The rate, as a fraction: 0.03 is three percent. `brokerRelations` is the level in effect; the two standings
 * are the owner's faction's and the owner's to the pilot; `upgradeLevel` is the system's, nought outside a warzone.
 */
function brokersFeeRate({ brokerRelations, factionToCharStanding, corpToCharStanding, upgradeLevel = 0, stationID = null }) {
  let rate = MARKET_COMMISSION_PERCENTAGE / 100.0;
  rate -= (brokerRelations * BROKER_RELATIONS_SKILL_MODIFIER) / 100;
  if (stationID === STATION_AMARR_VIII_ORIS) rate *= 0.5;
  // "if not feePercentageAtLocation: return 0.0"
  if (!rate) return 0.0;
  rate *= 1 - 0.1 * upgradeLevel;
  return rate - factionToCharStanding * MARKET_FACTION_STANDING_MULTIPLIER - corpToCharStanding * MARKET_NPC_CORP_STANDING_MULTIPLIER;
}

/**
 * The rate in a structure, as a fraction (marketsvc.GetBrokersFeeCommissionFromStationID, 161, for what is no
 * station). `marketTax` is what the structure's settings answered for its market and the pilot
 * (marketsvc.GetBaseTax, 229 to 239): a percentage; True, which the client's Python divides as one; or null, which
 * is no market there for the pilot.
 *
 *   SkillLimits.GetBrokersFeeForLocation                    (skilllimits.py 25)
 *       no base, no rate; else the base over a hundred. No skill is taken off:
 *       the limits are made with doSkillsApply as IsStation(stationID) (marketsvc.py 242)
 *   "if not feePercentageAtLocation: return 0.0"              (marketsvc.py 165)
 *   BrokerFeeProvider.GetAdjustedCommissionPercentage         (brokerFee.py 63)
 *       a tenth off for each level the system is upgraded to; and no standing,
 *       a structure's owner being no NPC (marketsvc.py 745 to 752)
 *
 * The client's two guards come of themselves here: no tax is nought to Number(), as False is and True is one, and
 * nought over a hundred is the rate of nothing the client answers for it.
 */
function brokersFeeRateInStructure({ marketTax, upgradeLevel = 0 }) {
  return (Number(marketTax) / 100.0) * (1 - 0.1 * upgradeLevel);
}

module.exports = { brokersFeeRate, brokersFeeRateInStructure };
