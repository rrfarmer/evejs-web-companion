"use strict";
const { prerequisiteClosure, readSkillState } = require("./pilotTraining");
const slot = f => [[11,34],[92,99],[125,132],[164,171]].some(([lo,hi]) => f >= lo && f <= hi);

// Role policy consumes the ordinary exact saved-fitting contract. It does not
// choose a hull, refit equipment, load supplies or own provisioning custody.
function defenderReadiness(contract, observation, sheet, data, allowReplenishment = false) {
  if (!contract || observation?.complete !== true || observation.shipTypeID !== contract.shipTypeID ||
      Number(data.getType(contract.shipTypeID)?.categoryID) !== 6 || Number(data.getType(contract.shipTypeID)?.groupID) === 29)
    return { state: "BLOCKED", reason: "Defender ship/fit observation UNKNOWN." };
  const types = [contract.shipTypeID, ...contract.equipment.filter(([flag]) => slot(flag) || flag === 87).map(([,type]) => type)];
  try {
    const skills = readSkillState(sheet), required = prerequisiteClosure(types, data);
    if (!skills) return { state: "BLOCKED", reason: "Defender skill qualification UNKNOWN." };
    const missing = [...required].filter(([id,level]) => (skills.get(id)?.level || 0) < level);
    if (missing.length) return { state: "BLOCKED", reason: `Defender skills NOT_READY: ${missing.map(([id,level]) => `${data.getTypeName(id)} ${level}`).join(", ")}.` };
  } catch { return { state: "BLOCKED", reason: "Defender skill prerequisites UNKNOWN." }; }
  const rows = observation.rows;
  const drones = rows.some(r => r.flagID === 87 && r.quantity > 0 && Number(data.getType(r.typeID)?.groupID) === 100);
  const weapons = rows.filter(r => r.flagID >= 27 && r.flagID <= 34 &&
    Number(data.getType(r.typeID)?.categoryID) === 7 && data.getTypeDogma(r.typeID)?.effects?.some(e => [12,101].includes(Number(e))));
  if (!drones && !weapons.length) return { state: "BLOCKED", reason: "Defender needs combat drones or supported turrets/launchers." };
  for (const weapon of weapons) {
    const attrs = data.getTypeDogma(weapon.typeID)?.attributes || {};
    const groups = [604,605,606,609,610].map(id => Number(attrs[id])).filter(id => Number.isSafeInteger(id) && id > 0);
    const size = Number(attrs[128]);
    const compatible = typeID => {
      const type = data.getType(typeID), ammo = data.getTypeDogma(typeID)?.attributes;
      return Number(type?.categoryID) === 8 && groups.includes(Number(type.groupID)) &&
        Number.isSafeInteger(size) && size > 0 && Number(ammo?.[128]) === size;
    };
    const aboard = rows.some(r => r.quantity > 0 && (r.flagID === weapon.flagID || [5,143].includes(r.flagID)) && compatible(r.typeID));
    const provisioned = allowReplenishment && contract.supplies.some(t => t.target > 0 && compatible(t.typeID));
    if (!aboard && !provisioned) return { state: "BLOCKED", reason: `Defender weapon ${data.getTypeName(weapon.typeID)} has no proven compatible ammunition.` };
  }
  return { state: "VERIFIED", reason: null, damagePaths: [...(drones ? ["DRONES"] : []), ...(weapons.length ? ["WEAPONS"] : [])] };
}
module.exports = { defenderReadiness };
