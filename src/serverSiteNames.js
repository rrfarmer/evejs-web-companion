"use strict";

// Scanner site names by their name message, read from the EveJS server's own
// site packs, for an install with no retail client to word them.
//
// A cosmic anomaly reaches the page as a row carrying `dungeonNameID`, the
// message its name is. The client's localisation turns that into "Angel Haven"
// (src/clientData/clientWords.js), but only when EVEJS_CLIENT_ROOT names a
// client install, and plenty of installs have none. A site list on the
// site-warp blocks (issue 182) compares NAMES, so without them every site is
// nameless and the bot can fly nowhere.
//
// The server knows each site's name: every template in its content packs
// carries `dungeonNameID` beside `resolvedName`. The web client already mounts
// the server tree read-only (EVEJS_ROOT, the same mount the game store and SDE
// are read from), so the names are read from there. The client's words win when
// there are any: this is only what is used when they are not.
//
// ⚠ ONLY THE ANOMALY PACKS. The packs are big (the whole folder is over half a
// gigabyte, much of it mission content), and only the three that hold scanner
// anomalies name a site the warp blocks can fly to: combat, rogue drone and
// ore. They are read one at a time, once, on the first ask, and only the name
// table is kept. A pack replaced on disk (a server update) is read again.
//
// ⚠ NEVER IN ONE BLOCKING GO. The three packs are about 110 MB of JSON, and the
// BFF's one event loop carries every pilot's bridge calls: each file is read
// asynchronously, the loop is given back between files, and concurrent asks
// share the one load in flight. A pack that fails to read (a half-written file
// during a server update) is not remembered as read, so the next look at the
// folder tries it again rather than leaving its sites nameless until the file
// changes once more.

const fs = require("fs");
const path = require("path");

const ANOMALY_PACK = /^evejs-[a-z-]*anomalies-[\d.]+\.json$/;

/** How long a built table is trusted before the folder is looked at again. */
const RECHECK_MS = 60_000;

function packFiles(packDir) {
  let names;
  try {
    names = fs.readdirSync(packDir);
  } catch {
    return [];
  }
  return names
    .filter((name) => ANOMALY_PACK.test(name))
    .sort()
    .flatMap((name) => {
      try {
        const stat = fs.statSync(path.join(packDir, name));
        return [{ name, size: stat.size, mtimeMs: stat.mtimeMs }];
      } catch {
        return [];
      }
    });
}

/** Every anomaly template's name, by its name message, out of one pack's text. */
function namesInPack(text) {
  const out = new Map();
  const pack = JSON.parse(text);
  const templates = pack && pack.payload && pack.payload.dungeon && pack.payload.dungeon.templatesByID;
  if (!templates || typeof templates !== "object") {
    return out;
  }
  for (const template of Object.values(templates)) {
    if (!template || typeof template !== "object") continue;
    const id = template.dungeonNameID;
    const name = typeof template.resolvedName === "string" ? template.resolvedName.trim() : "";
    if (Number.isSafeInteger(id) && id > 0 && name.length > 0 && !out.has(id)) {
      out.set(id, name);
    }
  }
  return out;
}

const yieldToLoop = () => new Promise((resolve) => setImmediate(resolve));

/**
 * A reader over `<eveRoot>/content-packs`. `names(ids)` answers each id with
 * its site name, or null when no anomaly pack names it, and `available` is
 * false when no anomaly pack could be read. Both are async: the first ask
 * waits for the load.
 */
function createServerSiteNames({ eveRoot, onError = () => {}, now = () => Date.now() } = {}) {
  const packDir = eveRoot ? path.join(eveRoot, "content-packs") : null;
  let table = new Map();
  let signature = null;
  let checkedAt = -Infinity;
  let loading = null;

  async function load() {
    checkedAt = now();
    const files = packFiles(packDir);
    const next = JSON.stringify(files);
    if (next === signature) {
      return;
    }
    const built = new Map();
    let complete = true;
    for (const file of files) {
      try {
        const text = await fs.promises.readFile(path.join(packDir, file.name), "utf8");
        for (const [id, name] of namesInPack(text)) {
          if (!built.has(id)) built.set(id, name);
        }
      } catch (error) {
        complete = false;
        onError(error, file.name);
      }
      await yieldToLoop();
    }
    table = built;
    // Remembered only when every pack was read, so a failed one is tried again.
    signature = complete ? next : null;
  }

  function refresh() {
    if (packDir === null) {
      return Promise.resolve();
    }
    if (loading === null && now() - checkedAt >= RECHECK_MS) {
      loading = load().finally(() => {
        loading = null;
      });
    }
    return loading ?? Promise.resolve();
  }

  return {
    async available() {
      await refresh();
      return table.size > 0;
    },
    async names(ids) {
      await refresh();
      const out = {};
      for (const id of ids) {
        out[String(id)] = table.get(id) ?? null;
      }
      return out;
    },
  };
}

module.exports = { createServerSiteNames, namesInPack, ANOMALY_PACK };
