"use strict";

// Each pilot's route settings, kept on the BFF so a run the server hosts plans
// its route as the pilot does.
//
// The retail client keeps the autopilot's settings (pfRouteType, pfPenalty, the
// avoidance list...) per character in its LOCAL settings (settings.char.ui,
// clientPathfinderService.py 204), never on the server, and the page keeps them
// the same way, in the browser's storage (web/src/nav/autopilotSettings.ts). A
// hosted run has no browser, so it planned with the defaults: "Prefer safer",
// which around low-sec space turns a three-jump hop into twenty. So the page
// hands the pilot's settings here as they are changed, and the bot host gives a
// hosted run a storage that answers with them (storageFor). They can be set
// here for a pilot nobody has logged in on a page (POST
// /api/pilot-route-settings), and the latest change is the one kept.
//
// ⚠ KEPT AS THE PAGE SENT THEM, CHECKED WHERE THEY ARE READ. The settings'
// meaning is loadAutopilotSettings' (autopilotSettings.ts), which reads every
// field defensively; this file only bounds the size and keeps the shape an
// object.

const fs = require("fs");
const path = require("path");

const MAX_SETTINGS_BYTES = 64 * 1024;

/**
 * The key the page's flow keeps a character's route settings under.
 * ⚠ autopilotSettingsKey (web/src/nav/autopilotSettings.ts) says it too;
 * pilotRouteSettings.test.js pins the two together.
 */
function routeSettingsKey(characterID) {
  return `evejs.autopilot.settings.${characterID}`;
}

function fail(code, message) {
  return Object.assign(new Error(message), { code });
}

/**
 * `filePath` null keeps them for as long as the process lives (tests).
 */
function createPilotRouteSettings({ filePath = null } = {}) {
  let kept = null;

  function load() {
    if (kept !== null) return kept;
    kept = new Map();
    if (filePath === null) return kept;
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      for (const [id, text] of Object.entries(parsed && typeof parsed === "object" ? parsed.pilots ?? {} : {})) {
        if (Number.isSafeInteger(Number(id)) && typeof text === "string") kept.set(Number(id), text);
      }
    } catch {
      // No file yet, or unreadable: nothing kept.
    }
    return kept;
  }

  function persist() {
    if (filePath === null) return;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const staging = `${filePath}.tmp`;
    fs.writeFileSync(staging, JSON.stringify({ version: 1, pilots: Object.fromEntries(kept) }), "utf8");
    fs.renameSync(staging, filePath);
  }

  const get = (characterID) => load().get(Number(characterID)) ?? null;
  return {
    /** The pilot's settings as the page kept them (JSON text), or null. */
    get,
    /** Keep the pilot's settings, an object as the page keeps it. */
    set(characterID, settings) {
      if (!Number.isSafeInteger(characterID) || characterID <= 0) {
        throw fail("INVALID_CHARACTER", "A character is required.");
      }
      if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
        throw fail("INVALID_ROUTE_SETTINGS", "Route settings are an object.");
      }
      const text = JSON.stringify(settings);
      if (Buffer.byteLength(text, "utf8") > MAX_SETTINGS_BYTES) {
        throw fail("INVALID_ROUTE_SETTINGS", "Those route settings are too large.");
      }
      load().set(characterID, text);
      persist();
    },
    /**
     * A settings storage for a hosted run's flow (AppFlowOptions.storage): the
     * pilot's route settings under their key, as they are when the run first
     * plans a route (the flow keeps them from then on, as it keeps a page's).
     * Nothing else is kept, as for a flow given none.
     */
    storageFor(characterID) {
      const key = routeSettingsKey(characterID);
      return {
        getItem: (name) => (name === key ? get(characterID) : null),
        setItem: () => {},
      };
    },
  };
}

module.exports = { createPilotRouteSettings, routeSettingsKey, MAX_SETTINGS_BYTES };
