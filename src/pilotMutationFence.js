"use strict";
const { AsyncLocalStorage } = require("node:async_hooks");
const { isBridgeWritePair } = require("./bridgeCallPolicy");

function createPilotMutationFence({ heldSessions, assertWritable, assertSelectable, enterWrite }) {
  const scope = new AsyncLocalStorage();
  function wrap(gateway) {
    return new Proxy(gateway, { get(target, name) {
      const fn = target[name];
      if (typeof fn !== "function") return fn;
      return (...args) => {
        const releases = [];
        const release = () => { for (const fn of releases.reverse()) fn(); };
        try {
          let write = !/^(get|read|list|bind|health|subscribe)/i.test(String(name));
          if (name === "createChatSession") write = false; // Transport/presence, no pilot inventory or flight authority.
          if (name === "callMethod") write = isBridgeWritePair(args[0], args[1]);
          if (name === "callBoundMethod") write = !/^(Get|List|Query|Is|Has|Check)/.test(String(args[1]));
          if (write) {
            const pilots = new Set();
            for (const held of heldSessions.values()) if (args.includes(held.bridgeSessionID)) pilots.add(held.characterID);
            if (name === "selectCharacter") pilots.add(Number(args[0]?.[0]));
            if (name === "selectFactoryCharacter") pilots.add(Number(args[1]));
            for (const arg of args) if (arg && typeof arg === "object" && Number.isSafeInteger(arg.characterID)) pilots.add(arg.characterID);
            for (const pilot of pilots) {
              const capability = scope.getStore();
              if (name === "selectFactoryCharacter" && capability?.purpose === "custody-selection" && capability.pilot === pilot) {
                assertSelectable(pilot); // Runtime atomically enforces free-only selection.
              } else {
                assertWritable(pilot, capability || null);
                if (enterWrite) releases.push(enterWrite(pilot, capability || null));
              }
            }
          }
          const result = fn.apply(target, args);
          if (result && typeof result.then === "function") return Promise.resolve(result).finally(release);
          release(); return result;
        } catch (error) { release(); throw error; }
      };
    } });
  }
  return { wrap, withLease: (lease, action) => scope.run(lease, action),
    withCustodySelection: (pilot, action) => scope.run({ purpose: "custody-selection", pilot }, action) };
}
module.exports = { createPilotMutationFence };
