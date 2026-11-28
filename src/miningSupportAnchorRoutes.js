"use strict";

const ROSTER_FRESH_MS = 10_000;
const positiveID = value => Number.isSafeInteger(value) && value > 0 ? value : null;
const exactID = value => typeof value === "string" && /^[1-9]\d*$/.test(value) ? value
  : positiveID(value) === null ? null : String(value);

// Keep the read contract used by join-support-fleet. The retired Core MCC was the only publisher.
function registerMiningSupportAnchorRoutes({ app, requireAuth, requireHeld, currentSession, readFleet, sessionLost }) {
  async function fleetFor(held, sessionID) {
    const { decodeFleetInitState } = await import("../web/src/bridge/boundFleet.ts");
    // Never use the old held.fleetID as evidence, including after failed reads.
    held.fleetID = null;
    const observedAtMs = Date.now();
    const init = decodeFleetInitState(await readFleet(held, sessionID));
    const fleetID = exactID(init.fleetID);
    const members = init.members.map(row => ({ characterID: positiveID(Number(row.charID)), solarSystemID: positiveID(Number(row.solarSystemID)) }));
    if (!fleetID || members.some(row => row.characterID === null)
        || !members.some(row => row.characterID === held.characterID)) return null;
    held.fleetID = fleetID;
    return { fleetID, readerCharacterID: held.characterID, members, observedAtMs, expiresAtMs: observedAtMs + ROSTER_FRESH_MS };
  }
  function stillHeld(held, sessionID, bridgeSessionID) { return currentSession(sessionID) === held && held.bridgeSessionID === bridgeSessionID; }
  app.get("/api/bots/mining-support-anchors", requireAuth, async (req, res, next) => {
    const held = requireHeld(req, res);
    if (!held) return;
    const bridgeSessionID = held.bridgeSessionID;
    try {
      const fleet = await fleetFor(held, req.webSessionID);
      if (!stillHeld(held, req.webSessionID, bridgeSessionID)) return res.status(409).json({ ok: false, error: "SESSION_CHANGED" });
      const readAtMs = Date.now();
      if (!fleet || readAtMs >= fleet.expiresAtMs) return res.json({ ok: true, availability: "unknown", reason: "FLEET_UNKNOWN", readAtMs, fleet: null, anchors: [] });
      res.json({ ok: true, availability: "available", reason: null, readAtMs, fleet, anchors: [] });
    } catch (error) {
      if (error?.code === "SESSION_NOT_FOUND") { sessionLost(req.webSessionID); next(error); }
      else res.json({ ok: true, availability: "unknown", reason: error?.code || "READ_FAILED", readAtMs: Date.now(), fleet: null, anchors: [] });
    }
  });
}

module.exports = { registerMiningSupportAnchorRoutes };
