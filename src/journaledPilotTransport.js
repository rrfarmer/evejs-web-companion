"use strict";

/** Journal selected session handles even when they never enter the browser session map. */
function journaledPilotTransport(transport, journal) {
  return new Proxy(transport, { get(target, name) {
    const fn = target[name];
    if (typeof fn !== "function") return fn;
    if (name === "selectCharacter") return async (...args) => {
      const selected = await fn.apply(target, args);
      journal.track({ bridgeSessionID: selected?.bridgeSessionID, accountID: args[2]?.userid,
        characterID: selected?.session?.characterID ?? args[0]?.[0] });
      return selected;
    };
    if (name === "releaseBridgeSession") return async (...args) => {
      try {
        const result = await fn.apply(target, args);
        if (result?.released === true) journal.confirmReleased(args[0]);
        return result;
      } catch (error) {
        if (error?.code === "SESSION_NOT_FOUND") journal.confirmReleased(args[0]);
        throw error;
      }
    };
    // Preserve the transport receiver, including methods with private fields.
    return fn.bind(target);
  } });
}

module.exports = { journaledPilotTransport };
