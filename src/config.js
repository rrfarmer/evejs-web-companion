"use strict";

const path = require("path");

const repoRoot = path.resolve(__dirname, "..");
const defaultEveRoot = path.resolve(repoRoot, "..", "eve.js");
const eveRoot = path.resolve(process.env.EVEJS_ROOT || defaultEveRoot);
const dataDir = path.resolve(process.env.EVEJS_WEB_POC_DATA_DIR || path.join(repoRoot, "data"));

// The SDE build this POC's static reads are pinned to. It matches the build
// EveJS's docker/entrypoint.sh downloads and extracts, which is why the two
// layouts below can be pointed at each other.
const SDE_BUILD = "3698585";

// Where the static gameStore tables and the SDE JSONL live.
//
// There are TWO layouts in the wild and they are not the same shape:
//
//   native EveJS  ->  <eveRoot>/_local/gameStore/data
//                     <eveRoot>/_local/sde/eve-online-static-data-<build>-jsonl
//   docker EveJS  ->  /var/lib/evejs/gameStore/data          (the evejs-data volume)
//                     /var/lib/evejs/sde/eve-online-static-data-<build>-jsonl
//
// Defaulting to the native layout keeps every existing host setup working with
// no env at all. The two overrides exist so a containerised BFF can mount the
// evejs-data volume read-only and read the AUTHORITATIVE tables the running
// server was built from, instead of whatever stale copy happens to sit in a
// host checkout's _local/.
const gamestoreDataDir = path.resolve(
  process.env.EVEJS_GAMESTORE_DATA_DIR ||
    path.join(eveRoot, "_local", "gameStore", "data"),
);
const sdeDir = path.resolve(
  process.env.EVEJS_SDE_DIR ||
    path.join(eveRoot, "_local", "sde", `eve-online-static-data-${SDE_BUILD}-jsonl`),
);

module.exports = {
  repoRoot,
  dataDir,
  // Optional local client-derived seasonal rewards. Generated data stays in ignored operator storage.
  seasonalCampaignsPath: path.resolve(process.env.EVEJS_SEASONAL_CAMPAIGNS_FILE || path.join(dataDir, "seasonal-campaigns.json")),
  iconCacheDir: path.resolve(process.env.EVEJS_ICON_CACHE_DIR || path.join(dataDir, "icon-cache")),
  iconCacheUrlPath: "/icon-cache",
  eveRoot,
  sdeBuild: SDE_BUILD,
  gamestoreDataDir,
  sdeDir,
  gamestorePath: path.resolve(
    process.env.EVEJS_GAMESTORE_DB ||
      path.join(eveRoot, "_local", "gameStore", "gamestore.sqlite"),
  ),
  // Where the player's own copy of the retail client is installed (the folder
  // holding `tq` and `ResFiles`). Its localisation data is read from there, at
  // run time, for the text of the labels the server sends. Unset: no client's
  // words, and the web client words what it can itself.
  clientRoot: process.env.EVEJS_CLIENT_ROOT ? path.resolve(process.env.EVEJS_CLIENT_ROOT) : null,
  // The 64-bit Python 3 that hosts the client's own Python when one of the
  // client's built data tables is read (src/clientData/clientBuiltData.js).
  clientPython: process.env.EVEJS_PYTHON || "python",
  // Whether game-port pilots run that client's own Python, the native client
  // layer (docs/native-layer-optional-plan.md). "auto", the default, runs it
  // when clientRoot names an install. "off" never does; the install's words
  // and data are still read for the page. server.js refuses any other value.
  nativeClient: (process.env.EVEJS_NATIVE_CLIENT || "auto").trim().toLowerCase(),
  host: process.env.HOST || "127.0.0.1",
  port: Number.parseInt(process.env.PORT || "26500", 10) || 26500,
  sessionCookieName: "evejs_web_poc",
  sessionTtlMs: 12 * 60 * 60 * 1000,
  // Farmer's hosted grant is bounded to 72 hours; its token remains valid
  // through the additional bounded home/dock cleanup window.
  hostedRunPolicy: Object.freeze({
    maxRuntimeMinutes: 72 * 60,
    defaultRuntimeMinutes: 12 * 60,
    durationChoices: Object.freeze([60, 240, 720, 1440, 2880, 4320]),
  }),
};
