"use strict";
const { trainingError } = require("./pilotTrainingRead");

function createFactorySessions({ store, gateway, heldSessions, botHost }) {
  async function status(account, characterID) {
    const chars = await store.listCharactersForAccount(account.accountID);
    if (!chars.some((row) => row.characterID === characterID)) throw trainingError("CHARACTER_NOT_FOUND", "Account does not own pilot.", 404);
    const state = await gateway.getCharacterStatus(account.accountID, characterID);
    if (state?.characterID !== characterID || typeof state.online !== "boolean") throw trainingError("CHARACTER_CONTROL_UNAVAILABLE");
    const held = [...heldSessions.values()].find((row) => row.characterID === characterID);
    const owner = botHost.claimedBy(characterID) !== null ? "BOT" :
      held ? "BROWSER" :
      state.controlState === "offline" && state.online === false ? "OFF" : "OTHER_SESSION";
    return { characterID, owner, online: state.online };
  }
  return { status };
}
module.exports = { createFactorySessions };
