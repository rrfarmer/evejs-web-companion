"use strict";

// ── Server-side bot host ─────────────────────────────────────────────────────
//
// Bots used to run ENTIRELY in the browser tab that started them: the tab
// closes (or a phone locks its screen) and the ship sits. This module runs the
// SAME bot stack — clientStore + appFlow + scriptRunner, imported unchanged
// from web/src via Node's TypeScript type-stripping — inside the BFF process,
// driving the BFF's own HTTP surface. The browser becomes a remote control:
// start/stop/inspect from any device, and disconnecting changes nothing.
//
// A bot asks the BFF with the `fetch` the host is given. The BFF gives it one
// that runs each request through the app in this process, with no connection
// made (src/inProcessFetch.js); given none, the host uses the world's fetch
// over loopback to `baseUrl`, which is what it always did and is the way back
// (EVEJS_HOSTED_BOT_REACH=loopback).
//
// Architecturally a server bot is just ANOTHER SESSION (the R107 multibox
// work): its flow holds its own session token, its select lands in the same
// bridgeSessions map as a tab's, and every world call goes through the same
// audited routes. Nothing here talks to the gateway directly.
//
// AUTHENTICATION — no password crosses this module. The bot-start route runs
// under requireAuth, so the caller has already proven they hold the account;
// the host mints a fresh session token for the bot IN-PROCESS (webAuth) and
// seeds it into the flow via `initialSessionToken`. If /api/login ever grows a
// real password check, nothing here breaks.
//
// ONE HULL, ONE DRIVER. Starting a bot on a character any live web session is
// flying is refused (CHARACTER_IN_USE), and while a bot holds a character the
// /api/bridge/select guard refuses tabs (CHARACTER_IN_USE_BY_BOT) — the bot's
// own select passes because its fetch carries `x-evejs-bot-id`. The claim is
// registered synchronously BEFORE the first await so concurrent starts cannot
// both win.
//
// LIFECYCLE. A bot ends when its script finishes, hits an error, loses its
// session, or is stopped; ending always releases the character (logout), so
// the hull is immediately flyable from a tab. Finished records stay listable
// in a bounded ring of the last MAX_ENDED_RUNS ended runs, GLOBAL across every
// account and character (see that constant's comment) — not one-per-character
// as before, and not a durable log.
//
// DURABLE ACROSS RESTARTS. The RUNNING roster (who/what, never a token) is
// mirrored to `persistPath` on every start and end. The immutable script
// revision/hash and its restart policy are pinned with that row. `resume()` may
// start at step one ONLY when the exact saved revision still exists and every
// block is observed-state/restart-safe. A costly, destructive, social, or
// otherwise non-idempotent script stops visibly and waits for a fresh player
// start instead of replaying intent after a crash.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const jettison = require("./jettisonCustody");
const { createStartupRuns, credentialFree, preparationReady } = require("./startupRuns");
const { pathToFileURL } = require("url");
const { isBridgeWritePair } = require("./bridgeCallPolicy");

// An unguessable per-run claim capability. The public botID is deliberately NOT
// accepted by the select guard: account-scoped bot listings expose bot IDs, so
// using one as authority would let an ordinary browser impersonate the host.
const BOT_HEADER = "x-evejs-bot-claim";

// Terminal statuses: the runner has let go of the ship.
const ENDED_STATUSES = new Set(["stopped", "error", "idle"]);

// How often each running bot's ship vitals are sampled for the landing-page
// readout. Plain reads through the bot's own flow — the same polls an open
// tab would be making — never a world call.
const VITALS_SAMPLE_MS = 15_000;

// How far past its own deadline a bot's session token is minted to live.
//
// ⚠ THE MARGIN IS THE WHOLE POINT — A TOKEN THAT DIES WITH THE RUN IS A TOKEN
// THAT CANNOT END IT. `finalize` releases the bridge session by calling
// `/api/logout` through the bot's own flow, and that route reads the token to
// find the session to release: an expired one is indistinguishable from no
// session at all, so it answers ok and releases nothing. The pilot stays
// online, holding a hull no tab can take, until the gateway's own idle sweep
// notices half an hour later. Five miners ended a twelve-hour run that way.
//
// Fifteen seconds would do; five minutes costs nothing and covers a teardown
// that has to wait on a slow gateway.
const SESSION_TEARDOWN_MARGIN_MS = 5 * 60_000;

// How long a bot whose approved run time has ended may spend getting DOCKED
// before it is logged off wherever it is.
//
// ⚠ A DEADLINE IS NOT A REASON TO LEAVE A SHIP IN SPACE. The deadline used to
// stop the loop and log out on the spot, so a miner whose twelve hours ran out
// in a belt went offline in the belt, hull and cargo parked there unattended.
// The run now ends the way every other stop ends (scriptDecide `stopSafely`):
// fly in, dock, THEN release the pilot. Bounded, because a ship that is
// tackled or cannot route must still let its pilot go eventually. The token is
// minted to cover this too, and 72h plus this plus the teardown margin stays
// inside webAuth's MAX_SESSION_TTL_MS.
const DEADLINE_DOCK_GRACE_MS = 15 * 60_000;

// A stopped controller may still own drones in space. Spend at most three
// minutes confirming their return before Farmer's full dock grace begins.
// The token covers BOTH bounds and the teardown margin.
const CONTROLLED_DRONE_CLEANUP_MS = 3 * 60_000;

// How often the wind-down re-reads flight status while it waits to be docked.
const DOCK_POLL_MS = 5_000;

const DEADLINE_WHY_DOCKING = "The approved run time ended, so the bot is docking before it logs off.";
const DEADLINE_WHY_DOCKED = "The approved run time ended, so the bot docked and logged off.";
const DEADLINE_WHY_UNDOCKED =
  "The approved run time ended and the ship could not dock in time, so the server logged it off in space.";

// Ended runs are kept for the "recent runs" strip, not as a log: this is a
// MEMORY BOUND, so the ring holds the last MAX_ENDED_RUNS finalized records
// and nothing more. The cap is GLOBAL across every account, not per
// character — a busy account can age a quiet account's history out of the
// ring entirely. That is acceptable in a single-operator deployment (there is
// no tenant here to shortchange) and it is exactly why this is not a durable
// record: anyone who needs guaranteed history should look elsewhere, because
// this file already promises ended runs live in memory only and vanish on
// restart (see persistRoster below).
const MAX_ENDED_RUNS = 20;

// The browser stack, imported once per process and shared by every bot. Kept
// lazy so `require("./botHost")` stays cheap and the BFF boots even if the
// web sources are absent (the routes then fail per-start, not at boot).
let stackPromise = null;
function defaultLoadStack() {
  if (stackPromise === null) {
    const webSrc = path.resolve(__dirname, "..", "web", "src");
    const webUrl = (rel) => pathToFileURL(path.join(webSrc, rel)).href;
    stackPromise = (async () => {
      const [sessionToken, clientStore, flow, codec, runPolicy, supportFleet, pluginBlocks, hostedEvents] =
        await Promise.all([
          import(webUrl("app/sessionToken.ts")),
          import(webUrl("store/clientStore.ts")),
          import(webUrl("app/flow.ts")),
          import(webUrl("bots/scriptCodec.ts")),
          import(webUrl("bots/runPolicy.ts")),
          import(webUrl("nav/miningSupportFleet.ts")),
          import(webUrl("bots/pluginMacros.ts")),
          // Headless pilots need the same push-only fleet invitation authority as tabs.
          import(webUrl("app/hostedEventSource.ts")),
        ]);
      // The server has no sessionStorage; force the in-memory fallback. Bots
      // never use the global token anyway (perSessionToken), but the module
      // must not touch a browser API on import of anything else.
      sessionToken.setSessionTokenStorage(null);
      return {
        createClientStore: clientStore.createClientStore,
        createAppFlow: flow.createAppFlow,
        createHostedEventSource: hostedEvents.createHostedEventSource,
        PLUGIN_RUN_GRANT_REV: runPolicy.PLUGIN_RUN_GRANT_REV,
        pluginRunBotPolicy: runPolicy.pluginRunBotPolicy,
        decodeScriptValue: codec.decodeScriptValue,
        scriptWithFormerMacroIDs: pluginBlocks.scriptWithFormerMacroIDs,
        analyzeBotRunPolicy: runPolicy.analyzeBotRunPolicy,
        supportsHostedOreJettisonRecovery: runPolicy.supportsHostedOreJettisonRecovery,
        validateBotLaunchGrant: runPolicy.validateBotLaunchGrant,
        supportFleet,
      };
    })();
    stackPromise.catch(() => {
      stackPromise = null; // a failed load may be retried on the next start
    });
  }
  return stackPromise;
}

function stableJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function hashScript(doc) {
  return crypto.createHash("sha256").update(stableJson(doc), "utf8").digest("hex");
}

function sameSecret(left, right) {
  if (typeof left !== "string" || typeof right !== "string" || left.length === 0 || right.length === 0) {
    return false;
  }
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// What a run's roster row and public row call its kind. "script" when absent: a row written before `kind` existed.
const kindOf = (kind) => (kind === "plugin" ? kind : "script");

// ── Runs a plugin flies ──────────────────────────────────────────────────────
//
// A plugin's run is a bot like any other to this host: the same launch grant,
// claim, roster, resume, deadline and Stop, on a flow of the host's own that
// selects the pilot and logs it off. What differs is who decides. The loop lives
// in the plugin's process, on a flow of its own attached to the session the host
// selected, and reaches the BFF only through `pluginRunEvents.fetch` below. The
// host adds the token and the claim there, so neither ever reaches the plugin.
//
// ⚠ A PLUGIN THAT STOPS LEAVES A SHIP IN SPACE WITH NOBODY FLYING IT. The condition
// checked is that the plugin's process is up; the protocol when it is not is:
// wait for the restart, which takes seconds and carries on where it was, and
// recall the pilot and dock it if that does not come. Measured on a test server,
// mid-fight: a killed process flew again in about 3 s and a hung one in about 11 s,
// and waiting for the plugin host to give up took 73 s and cost ships.
const PLUGIN_DOWN_RECALL_MS = 20_000;
// A process that keeps dying never stays down long enough for that clock to run.
const PLUGIN_DOWN_LIMIT = 3;
const PLUGIN_DOWN_WINDOW_MS = 2 * 60_000;
// What a plugin may keep with a run. Each is read back on every restart, so these are bounds on a mistake, not budgets.
const PLUGIN_RESUME_DATA_MAX_BYTES = 64 * 1024;
const PLUGIN_READOUT_MAX_BYTES = 16 * 1024;
const PLUGIN_RUN_STATUSES = new Set(["running", "paused", "idle", "stopped", "error"]);
// What only the host does for a run: it chose the pilot, it ends the session, and only the player starts or stops
// a bot. Read as the router reads a path, which ignores case and a trailing slash: an exact match lets "/api/LOGOUT" by.
// What a run may still do once it is being stopped: say how it ended. It flies nothing,
// and the end of a run is what its log is most often read for.
function isPluginLastWords(message) {
  try {
    return String(message.method).toUpperCase() === "POST"
      && /^\/api\/bots\/bot-log\/?$/i.test(new URL(String(message.url), "http://bff.invalid").pathname);
  } catch {
    return false;
  }
}

const PLUGIN_REFUSED_PATH =/^\/api\/(login|logout|bridge\/select|bridge\/release|bots\/start|bots\/[^/]+\/(stop|reconnect)|mining-operations\/[^/]+\/(start|stop))\/?$/i;
const PLUGIN_STOPPED_PHASE = "Plugin stopped";

/**
 * What a request by the generic call asks, read off its body: the call's service and its method, and the object
 * it is made on (`of`), as the page sends them (web/src/bridge/callMethod.ts). Null where the body is not one.
 */
function genericCallOf(body) {
  if (typeof body !== "string") return null;
  try {
    const call = JSON.parse(body);
    return call !== null && typeof call === "object" && typeof call.service === "string" && typeof call.method === "string" ? call : null;
  } catch { return null; }
}

function createBotHost(options) {
  const auth = options.webAuth;
  const baseUrl = options.baseUrl;
  // How a bot's requests reach the BFF. Read at each request where none is handed in: the world's fetch is the
  // world's to replace.
  const reach = typeof options.fetch === "function" ? options.fetch : (input, init) => globalThis.fetch(input, init);
  // Injected from server.js: is ANY held bridge session flying this character?
  const isCharacterHeld = options.isCharacterHeld || (() => false);
  const logError = options.errorLogger || (() => {});
  const loadStack = options.loadStack || defaultLoadStack;
  // The plugin host (src/pluginHost.js), for a run a plugin flies. A function: it is made after this host.
  const pluginProcess = typeof options.pluginProcess === "function" ? options.pluginProcess : () => null;
  const pluginDownRecallMs = options.pluginDownRecallMs || PLUGIN_DOWN_RECALL_MS;
  const createClaimSecret = options.createClaimSecret || (() => crypto.randomBytes(32).toString("base64url"));
  const now = typeof options.now === "function" ? options.now : () => Date.now();
  const setDeadlineTimeout = options.setDeadlineTimeout || ((callback, delayMs) => setTimeout(callback, delayMs));
  const clearDeadlineTimeout = options.clearDeadlineTimeout || ((timer) => clearTimeout(timer));
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const nowISO = () => new Date(now()).toISOString();
  // Durability: where the running roster is mirrored (absent = memory-only),
  // and the reads resume() needs to rebuild a bot from its persisted row.
  const persistPath = options.persistPath || null;
  const startupRuns = options.startupRuns || createStartupRuns({ filePath: persistPath ? `${persistPath}.startup.json` : null, now });
  const loadAccount = options.loadAccount || (async () => null);
  // The saved-script library is platform-wide: any account's characters may
  // run any account's script. `loadScript(scriptID) -> Record | null` looks a
  // script up by ID alone — it does NOT check who authored it. Authority over
  // characters and running bots stays account-scoped elsewhere in this file
  // (claims, list(), stop()); only the script lookup is global.
  const loadScript = options.loadScript || (() => null);

  /**
   * botID -> record, running and ended alike. Ended (finalized) records are
   * bounded to MAX_ENDED_RUNS by evictOldEndedRuns(), a global ring across
   * every account and character — see the constant's comment for why.
   * Running records are never touched by that ring.
   */
  const records = new Map();
  /** characterID -> botID for RUNNING bots only — the claim the guards read. */
  const claims = new Map();

  // Mirror the RUNNING roster to disk (atomic tmp+rename, like webAuth's
  // stores). No token, claim capability, or doc is persisted. The revision and
  // canonical hash bind a restart to the exact document the player launched.
  function persistRoster() {
    if (persistPath === null) {
      return;
    }
    try {
      const bots = [];
      for (const record of records.values()) {
        if (!record.finalized) {
          const row = {
            kind: kindOf(record.kind),
            accountID: record.accountID,
            username: record.username,
            characterID: record.characterID,
            scriptID: record.scriptID,
            scriptName: record.scriptName,
            scriptRev: record.scriptRev,
            scriptHash: record.scriptHash,
            logicalRunID: record.logicalRunID,
            restartSafe: record.restartSafe,
            riskClasses: record.riskClasses,
            maxRuntimeMinutes: record.maxRuntimeMinutes,
            expiresAt: record.expiresAt,
            startedAt: record.startedAt,
            stopRequested: record.windingDown === true,
            stopBlocked: record.stopBlocked === true,
            ...(record.operationID ? { operationID: record.operationID, operationRole: record.operationRole,
              operationControllerAccountID: record.operationControllerAccountID,
              operationStopRequested: record.operationStopRequested === true,
              recoveryAttempts: record.recoveryAttempts || 0, recoveryBlocked: record.recovering === true } : {}),
            ...(record.operationPreparation ? { operationRunID: record.operationRunID,
              operationPreparation: record.operationPreparation, preparation: record.preparation,
              deferMain: record.deferMain } : {}),
          };
          if (record.kind === "plugin") {
            // There is no library for a plugin's run, so the row is the authority
            // for what was approved, and the plugin checks it again on a resume.
            row.pluginID = record.pluginID;
            row.pluginRun = record.pluginRun;
            row.request = record.pluginSetup;
            row.resumeData = record.pluginResumeData;
          }

          bots.push(row);
        }
      }
      fs.mkdirSync(path.dirname(persistPath), { recursive: true });
      const tempPath = `${persistPath}.${process.pid}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify({ version: 2, bots }, null, 2), "utf8");
      fs.renameSync(tempPath, persistPath);
    } catch (error) {
      logError(error);
    }
  }

  function readRoster() {
    if (persistPath === null) {
      return [];
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(persistPath, "utf8"));
      return Array.isArray(parsed && parsed.bots) ? parsed.bots : [];
    } catch (error) {
      if (error && error.code !== "ENOENT") {
        logError(error);
      }
      return [];
    }
  }

  function publicBot(record) {
    return {
      botID: record.botID,
      accountID: record.accountID,
      characterID: record.characterID,
      characterName: record.characterName,
      // "script" when absent, matching the same default the roster row and
      // resume() give an on-disk record with no `kind` field at all.
      kind: kindOf(record.kind),
      plugin: record.kind === "plugin" ? { pluginID: record.pluginID, run: record.pluginRun, readout: record.pluginReadout ?? null } : null,
      resumedAt: record.resumedAt,
      vitals: record.vitals,
      scriptID: record.scriptID,
      scriptName: record.scriptName,
      scriptRev: record.scriptRev,
      scriptHash: record.scriptHash,
      logicalRunID: record.logicalRunID,
      operationID: record.operationID,
      operationRole: record.operationRole,
      ...(record.operationPreparation ? { operationRunID: record.operationRunID,
        preparation: structuredClone(record.preparation), deferMain: record.deferMain,
        preparationOwnerAvailable: preparationOwnerAvailable(record) } : {}),
      parking: record.parking,
      recovery: record.recovery ? { ...record.recovery } : null,
      restartSafe: record.restartSafe,
      jettisonCustody: jettison.copy(record.jettisonCustody),
      riskClasses: record.riskClasses,
      maxRuntimeMinutes: record.maxRuntimeMinutes,
      expiresAt: record.expiresAt,
      status: record.status,
      phase: record.phase,
      why: record.why,
      stepPath: record.stepPath,
      pauseReason: record.pauseReason,
      note: record.note,
      lastAlert: record.lastAlert,
      startError: record.startError,
      startedAt: record.startedAt,
      endedAt: record.endedAt,
    };
  }

  // Fold the store's customBot slice into the record — same words the in-tab
  // readout shows, so the phone and a tab never tell different stories.
  //
  // ⚠ `lastAlert` is the reason an "alert me" watch is worth anything on a server
  // bot: the bot runs in THIS process with no browser to notify, so the alert's
  // only route to the player is the record → /api/bots → the Server Bots readout.
  // It is never cleared here — an alert a player has not seen yet must not be
  // erased by the next progress tick.
  function applySnapshot(record, snapshot) {
    record.status = snapshot.status;
    record.phase = snapshot.phase;
    record.why = snapshot.why;
    record.startError = snapshot.startError ?? null;
    record.stepPath = snapshot.stepPath;
    record.pauseReason = snapshot.pauseReason;
    record.note = snapshot.note;
    if (snapshot.lastAlert) {
      record.lastAlert = { message: String(snapshot.lastAlert.message), atMs: Number(snapshot.lastAlert.atMs) };
    }
  }

  // The ring: keep at most MAX_ENDED_RUNS finalized records, evicting the
  // OLDEST by endedAt — not by Map insertion order, which is start order and
  // can disagree with finish order (a long-running bot can finalize well
  // after a short one that started later). Running records are excluded from
  // both the count and the eviction; they are never subject to this cap.
  function evictOldEndedRuns() {
    const ended = [];
    for (const record of records.values()) {
      if (record.finalized) {
        ended.push(record);
      }
    }
    if (ended.length <= MAX_ENDED_RUNS) {
      return;
    }
    ended.sort((a, b) => String(a.endedAt).localeCompare(String(b.endedAt)));
    const excess = ended.length - MAX_ENDED_RUNS;
    for (let i = 0; i < excess; i++) {
      records.delete(ended[i].botID);
    }
  }

  // End of a run, from EITHER side (script finished/errored, or stop()):
  // release the claim and the character. Idempotent — the store subscription
  // and an explicit stop can both land here.
  function finalize(record) {
    if (record.finalized) return Promise.resolve(true);
    if (record.finalizePromise) return record.finalizePromise;
    const pending = finalizeBody(record);
    record.finalizePromise = pending.finally(() => { record.finalizePromise = null; });
    return record.finalizePromise;
  }

  async function finalizeBody(record) {
    if (record.recoveryWriteUnresolved || record.jettisonWriteUnresolved || jettison.unresolved(record.jettisonCustody) ||
        await preparationCustodyUnresolved(record) ||
        Object.values(record.startup?.snapshot().blocks || {}).some(block => ["PENDING", "BLOCKED"].includes(block.state))) {
      record.status = "paused"; record.phase = "Unresolved write custody";
      record.why = "The issued write needs reconciliation before pilot control can be released.";
      record.stopBlocked = true; persistRoster(); return false;
    }
    // A start that did not get going, of a pilot a tab held: the tab has it again, so the logoff below has nothing to
    // log off and the pilot stays in its fleet.
    record.giveBackSession?.();
    record.giveBackSession = null;
    // Keep the stopped row durable through logout. If the process dies in
    // teardown, resume sees stopRequested and will not restart bot work.
    record.windingDown = true;
    if (record.deadlineTimer) {
      clearDeadlineTimeout(record.deadlineTimer);
      record.deadlineTimer = null;
    }
    if (record.unsubscribe) {
      try {
        record.unsubscribe();
      } catch {}
      record.unsubscribe = null;
    }
    clearPluginDownTimer(record);
    persistRoster();
    // Before the logoff, so what the plugin writes in its `stop` reaches the pilot's log.
    if (record.kind === "plugin") await stopPluginLoop(record);
    const flow = record.flow;
    record.flow = null;
    record.store = null;
    let released = true;
    if (flow) {
      try {
        flow.stopCustomBot();
      } catch {}
      try {
        // A deadline wind-down may have left a dock flight running (see
        // endRunDocked); it has nothing left to fly for.
        if (typeof flow.abortRoute === "function") {
          flow.abortRoute();
        }
      } catch {}
      try {
        // Releases the bridge session — the character goes offline and the
        // hull is immediately available to a tab.
        await flow.logout();
      } catch (error) {
        logError(error);
        released = false;
      }
    }
    if (!released) {
      record.flow = flow;
      record.status = "paused";
      record.phase = "Session release blocked";
      record.why = "The pilot session release could not be confirmed. Retry Stop before selecting this character elsewhere.";
      record.stopBlocked = true;
      persistRoster();
      return false;
    }
    record.startup?.end();
    record.preparationCheckpoint?.end();
    record.finalized = true;
    record.endedAt = nowISO();
    persistRoster();
    // Keep the private claim through logout; a tab may not select a hull while
    // its old controller is still releasing the gateway session.
    if (claims.get(record.characterID) === record.botID) claims.delete(record.characterID);
    evictOldEndedRuns();
    return true;
  }

  /** True only when flight status says the ship is docked right now. */
  async function isDocked(record) {
    const flow = record.flow;
    const store = record.store;
    if (!flow || !store) {
      return false;
    }
    try {
      await flow.loadFlightStatus();
      const status = store.flight.get().status;
      return Boolean(status && status.docked === true);
    } catch {
      return false;
    }
  }

  /**
   * The approved run time is over: get the ship DOCKED, then finalize.
   *
   * 1. A script flies itself in: the runner latches the deadline the way it
   *    latches its own faults, flies to the script's home (or, if home cannot
   *    be flown to, the nearest station) and pauses on arrival.
   * 2. Anything still in space after that — a plugin's run, which has no home,
   *    or a script whose flight in failed — gets the readout's own "Recall
   *    drones & dock": every loop stopped, drones home, dock at the nearest
   *    station.
   * 3. Log off once flight status says docked, or when DEADLINE_DOCK_GRACE_MS
   *    runs out, and say which of the two it was.
   *
   * A player's Stop during this wind-down shares its pending safety gate and
   * then overrides docking, as the old manual Stop did.
   */
  async function endRunDocked(record) {
    record.deadlineDockingStarted = true;
    const words = record.recall ?? { docking: DEADLINE_WHY_DOCKING, docked: DEADLINE_WHY_DOCKED, undocked: DEADLINE_WHY_UNDOCKED };
    record.why = words.docking;
    const giveUpAt = now() + DEADLINE_DOCK_GRACE_MS;
    const stillWaiting = () => !record.finalized && !record.manualStopRequested && now() < giveUpAt;
    let docked = false;
    try {
      const flow = record.flow;
      if (
        flow &&
        record.kind === "script" &&
        typeof flow.headCustomBotHome === "function" &&
        flow.headCustomBotHome(words.docking)
      ) {
        while (stillWaiting() && record.store && record.store.customBot.get().status === "running") {
          await sleep(DOCK_POLL_MS);
        }
      }
      if (!record.manualStopRequested) docked = await isDocked(record);
      if (!docked && stillWaiting() && record.flow && typeof record.flow.panicRecallAndDock === "function") {
        await record.flow.panicRecallAndDock(() => record.manualStopRequested);
        while (stillWaiting()) {
          docked = await isDocked(record);
          if (docked) {
            break;
          }
          await sleep(DOCK_POLL_MS);
        }
      }
    } catch (error) {
      logError(error);
    }
    if (record.finalized) {
      return;
    }
    if (record.manualStopRequested) {
      try {
        if (record.manualCancellationPromise) {
          const settlement = await record.manualCancellationPromise;
          if (!settlement.ok) throw settlement.error;
        }
      } catch (error) {
        record.status = "paused";
        record.phase = "Stop blocked";
        record.why = "The deadline home action did not settle; pilot control remains held.";
        record.stopBlocked = true;
        record.stopFailureCode = "CONTROL_SETTLEMENT_UNCONFIRMED";
        persistRoster();
        logError(error);
        return false;
      }
      record.status = "stopped";
      record.why = "The player stopped this bot after controlled drones returned.";
      return finalize(record);
    }
    // Set immediately before finalize, which unsubscribes before its first
    // await — no store push can overwrite these between here and there.
    record.status = record.recall ? "error" : "stopped";
    record.why = docked ? words.docked : words.undocked;
    if (record.operationStopRequested) record.parking = { state: docked ? "PARKED" : "PARKING_FAILED",
      reason: docked ? null : DEADLINE_WHY_UNDOCKED };
    return finalize(record);
  }

  /** One pending safety gate for manual Stop and the deadline timer. */
  function requestGracefulStop(record, fromDeadline) {
    if (record.finalized) return Promise.resolve({ ok: true, bot: publicBot(record) });
    if (fromDeadline) record.deadlineRequested = true;
    else record.manualStopRequested = true;
    if (record.finalizePromise) {
      return record.finalizePromise.then((released) => released
        ? { ok: true, bot: publicBot(record) }
        : { ok: false, code: "PILOT_RELEASE_UNVERIFIED", message: record.why, bot: publicBot(record) });
    }
    if (record.stopPromise) {
      if (!fromDeadline && record.deadlineDockingStarted && record.flow && !record.manualCancellationIssued) {
        // The shared safety gate may already have finished and Farmer's home
        // runner may now be active. Cancel it before the next tick can steer.
        record.manualCancellationIssued = true;
        if (typeof record.flow.cancelHostedHome === "function") {
          const flow = record.flow;
          record.manualCancellationPromise = Promise.resolve()
            .then(() => flow.cancelHostedHome(record.kind))
            .then(() => ({ ok: true }), (error) => ({ ok: false, error }));
        } else {
          try {
            record.flow.stopCustomBot();
          } catch (error) { logError(error); }
        }
        try {
          if (typeof record.flow.abortRoute === "function") record.flow.abortRoute();
        } catch (error) { logError(error); }
      }
      return record.stopPromise;
    }
    // Set before any flow action: stopping a controller emits a terminal store
    // snapshot, and the subscription must not finalize/logout ahead of recall.
    record.windingDown = true;
    record.stopBlocked = false;
    persistRoster(); // a process restart must not replay a requested Stop
    const pending = (async () => {
      try {
        if (record.recoveryWriteUnresolved || record.jettisonWriteUnresolved || jettison.unresolved(record.jettisonCustody) ||
            await preparationCustodyUnresolved(record)) throw new Error("An issued write still needs reconciliation; Stop retains pilot control.");
        // The plugin's loop first: it must not launch what the host is about to bring home.
        if (record.kind === "plugin" && !record.recall) await stopPluginLoop(record);
        if (!record.droneSafetyConfirmed && (!record.flow || typeof record.flow.prepareHostedBotStop !== "function")) {
          if (record.flow) {
            record.flow.stopCustomBot();
          }
          throw new Error("The controlled-drone safety read is unavailable.");
        }
        if (!record.droneSafetyConfirmed) {
          await record.flow.prepareHostedBotStop(record.kind, now() + CONTROLLED_DRONE_CLEANUP_MS * (record.operationRole === "COMMAND" ? 2 : 1));
          record.droneSafetyConfirmed = true;
        }
      } catch (error) {
        const reason = error && error.message ? String(error.message) : "Controlled drone return could not be confirmed.";
        record.status = "paused";
        record.phase = "Stop blocked";
        record.why = `Controlled-drone cleanup is blocked. ${reason}`;
        record.pauseReason = record.why;
        record.stopBlocked = true;
        persistRoster();
        return { ok: false, code: "DRONE_RETURN_UNCONFIRMED", message: record.why, bot: publicBot(record) };
      }
      if (record.manualStopRequested) {
        // A previous manual interruption may have timed out while a deadline
        // home issue was still settling. Retry that exact prerequisite before
        // finalization; confirmed drones alone cannot authorize logout here.
        if (record.stopFailureCode === "CONTROL_SETTLEMENT_UNCONFIRMED") {
          try {
            await record.flow.cancelHostedHome(record.kind);
            record.stopFailureCode = null;
          } catch (error) {
            logError(error);
            record.stopBlocked = true;
            persistRoster();
            return { ok: false, code: "CONTROL_SETTLEMENT_UNCONFIRMED", message: record.why, bot: publicBot(record) };
          }
        }
        record.status = "stopped";
        record.why = "The player stopped this bot after controlled drones returned.";
        if (!(await finalize(record))) {
          return { ok: false, code: "PILOT_RELEASE_UNVERIFIED", message: record.why, bot: publicBot(record) };
        }
      } else {
        if (!(await endRunDocked(record))) {
          return { ok: false, code: record.stopFailureCode || "PILOT_RELEASE_UNVERIFIED", message: record.why, bot: publicBot(record) };
        }
      }
      return { ok: true, bot: publicBot(record) };
    })();
    record.stopPromise = pending.finally(() => { record.stopPromise = null; });
    return record.stopPromise;
  }

  // ─── Runs a plugin flies (see the comment at the top of this section's constants) ───

  function clearPluginDownTimer(record) {
    if (record.pluginDownTimer) clearTimeout(record.pluginDownTimer);
    record.pluginDownTimer = null;
  }

  /** Tell the plugin to stop this run's loop. Bounded, and never throws: its process may be what stopped. */
  async function stopPluginLoop(record) {
    const host = pluginProcess();
    if (!host || !record.pluginStarted) return;
    record.pluginStarted = false;
    try {
      await host.stopRun(record.pluginID, record.botID);
    } catch (error) {
      logError(error);
    }
  }

  /** Hand the run to its plugin's process, new or after a restart. Resolves to an error sentence or null. */
  async function startPluginLoop(record, resumed) {
    const host = pluginProcess();
    if (!host) return "This server cannot run plugins.";
    record.pluginStarted = true;
    const failure = await host.startRun(record.pluginID, {
      botID: record.botID,
      run: record.pluginRun,
      characterID: record.characterID,
      setup: record.pluginSetup,
      resumed,
      resumeData: record.pluginResumeData ?? null,
      held: record.flow.heldPilot(),
      routeSettings: record.flow.autopilotSettings(),
      baseUrl,
    });
    // A start that only answered late is still coming, so the plugin is told it is not wanted.
    if (failure) void stopPluginLoop(record);
    return failure;
  }

  /** The plugin cannot fly this pilot any more: every loop stopped, drones home, dock, log off, say why. */
  function recallPluginRun(record, why) {
    clearPluginDownTimer(record);
    if (record.finalized || record.windingDown) return;
    record.pluginStarted = false;
    record.phase = "Recalled";
    record.recall = {
      docking: `${why} Recalling the drones and docking.`,
      docked: `${why} The pilot was recalled, docked and logged off.`,
      undocked: `${why} The pilot could not be docked, so it was logged off in space.`,
    };
    // The recall brings the drones in itself, and waiting for them first is time under fire.
    record.droneSafetyConfirmed = true;
    void requestGracefulStop(record, true).catch(logError);
  }

  function unfinishedPluginRuns(pluginID) {
    return [...records.values()].filter((record) => record.kind === "plugin" && record.pluginID === pluginID && !record.finalized);
  }

  /** In the shape a Response body reaches a plugin's process. */
  async function answerPluginFetch(send, id, response) {
    const headers = {};
    response.headers.forEach((value, name) => { headers[name] = value; });
    send({ type: "runFetchAnswer", part: "head", id, status: response.status, headers });
    if (response.body) {
      for await (const chunk of response.body) {
        send({ type: "runFetchAnswer", part: "chunk", id, data: chunk });
      }
    }
    send({ type: "runFetchAnswer", part: "end", id });
  }

  const refusedPluginFetch = (status, error, message) =>
    new Response(JSON.stringify({ ok: false, error, message }), { status, headers: { "content-type": "application/json" } });

  /** What a plugin's process asks of its runs, as src/pluginHost.js hears it. */
  const pluginRunEvents = {
    /** One of a run's requests. It may only be for a run of this plugin that is still its to fly. */
    fetch(pluginID, send, flights, message) {
      const controller = new AbortController();
      flights.set(message.id, controller);
      void (async () => {
        try {
          const record = records.get(String(message.botID));
          let response;
          if (!record || record.kind !== "plugin" || record.pluginID !== pluginID) {
            response = refusedPluginFetch(404, "PLUGIN_RUN_NOT_FOUND", "This plugin has no such run.");
          } else if (record.finalized || !record.pluginFetch || (record.windingDown && !isPluginLastWords(message))) {
            response = refusedPluginFetch(409, "PLUGIN_RUN_ENDED", "This run has ended or is being stopped.");
          } else {
            const url = new URL(String(message.url), baseUrl);
            if (url.origin !== new URL(baseUrl).origin || !url.pathname.startsWith("/api/")) {
              response = refusedPluginFetch(403, "PLUGIN_RUN_OUTSIDE_API", "A run asks only the BFF's own API.");
            } else if (PLUGIN_REFUSED_PATH.test(url.pathname)) {
              response = refusedPluginFetch(403, "PLUGIN_RUN_SESSION_IS_CORES", "Core chooses a run's pilot and ends its session, and a run does not start or stop bots.");
            } else {
              // The flow's stand-in for the token goes in the URL of its event stream.
              url.searchParams.delete("token");
              response = await record.pluginFetch(url.href, { method: message.method, headers: message.headers, body: message.body, redirect: message.redirect, signal: controller.signal });
            }
          }
          await answerPluginFetch(send, message.id, response);
        } catch (error) {
          send({ type: "runFetchAnswer", part: "error", id: message.id, message: String((error && error.message) || error) });
        } finally {
          flights.delete(message.id);
        }
      })();
    },

    /** What a run is doing, in the plugin's own words. */
    report(pluginID, message) {
      const record = records.get(String(message.botID));
      if (!record || record.kind !== "plugin" || record.pluginID !== pluginID || record.finalized) return;
      const report = message.report;
      if (report === null || typeof report !== "object" || !PLUGIN_RUN_STATUSES.has(report.status)) return;
      const fits = (value, most, name) => {
        try { if (Buffer.byteLength(JSON.stringify(value) ?? "") <= most) return true; } catch { /* said below */ }
        // Once a run: a plugin over its limit is over it on every report.
        if (!record.pluginOversizeSaid) {
          record.pluginOversizeSaid = true;
          logError(new Error(`Plugin ${pluginID}: a run's ${name} cannot be stored or is over ${most} bytes, so it was not kept.`));
        }
        return false;
      };
      // The first end stands: core's own reason for ending a run is not overwritten by what the plugin sees of the same thing.
      if (!record.windingDown && !ENDED_STATUSES.has(record.status)) {
        record.status = report.status;
        record.phase = typeof report.phase === "string" ? report.phase : null;
        record.why = typeof report.why === "string" ? report.why : null;
        record.startError = typeof report.startError === "string" ? report.startError : null;
      }
      if (report.readout !== undefined && fits(report.readout, PLUGIN_READOUT_MAX_BYTES, "readout")) record.pluginReadout = report.readout;
      if (report.resumeData !== undefined && fits(report.resumeData, PLUGIN_RESUME_DATA_MAX_BYTES, "resumeData") &&
          stableJson(report.resumeData) !== stableJson(record.pluginResumeData ?? null)) {
        record.pluginResumeData = report.resumeData;
        persistRoster();
      }
      // The run reached its end by itself. As with a bot: released as soon as the loop lets go of the ship.
      if (ENDED_STATUSES.has(report.status) && !record.windingDown && record.pluginStarted) void finalize(record);
    },

    /** The plugin's process ended, or could not be started. */
    down(pluginID) {
      for (const record of unfinishedPluginRuns(pluginID)) {
        if (!record.pluginStarted || record.windingDown) continue;
        const at = now();
        record.pluginDowns = (record.pluginDowns || []).filter((when) => at - when < PLUGIN_DOWN_WINDOW_MS).concat(at);
        // A run that may repeat what it did is not started again, whatever the plugin would do.
        if (!record.restartSafe) { recallPluginRun(record, "The plugin flying this pilot stopped, and this run cannot be restarted safely."); continue; }
        if (record.pluginDowns.length >= PLUGIN_DOWN_LIMIT) { recallPluginRun(record, "The plugin flying this pilot keeps stopping."); continue; }
        record.status = "paused";
        record.phase = PLUGIN_STOPPED_PHASE;
        record.why = "The plugin flying this pilot stopped. Waiting for it to start again.";
        // Its clock runs from the first stop: dying again while it comes back buys no more time.
        if (record.pluginDownTimer) continue;
        record.pluginDownTimer = setTimeout(() => {
          record.pluginDownTimer = null;
          recallPluginRun(record, "The plugin flying this pilot stopped and did not come back.");
        }, pluginDownRecallMs);
        record.pluginDownTimer.unref?.();
      }
    },

    /** The plugin's process is up again: its runs carry on where they are, on the session the host kept. */
    up(pluginID) {
      for (const record of unfinishedPluginRuns(pluginID)) {
        if (!record.pluginDownTimer || record.windingDown) continue;
        clearPluginDownTimer(record);
        void startPluginLoop(record, true).then((failure) => {
          if (failure) { recallPluginRun(record, `The plugin flying this pilot could not carry on: ${failure}`); return; }
          // Flying again, and a plugin need not report until something changes.
          if (record.phase === PLUGIN_STOPPED_PHASE && !record.windingDown) {
            record.status = "running";
            record.phase = null;
            record.why = null;
          }
        }).catch(logError);
      }
    },
  };

  async function start({
    account,
    characterID,
    kind = "script",
    pluginID = null,
    pluginRun = null,
    resumeData = null,
    scriptID,
    scriptName,
    scriptRev,
    doc,
    request,
    grant,
    resumed = false,
    expectedScriptRev = null,
    expectedScriptHash = null,
    expectedExpiresAt = null,
    callerSessionID = null,
    probeReservation = null,
    beforeStart = null,
    operationID = null,
    operationRole = null,
    operationControllerAccountID = null,
    recoveryAttempts = 0,
    logicalRunID = null,
    operationRunID = null,
    operationPreparation = null,
    preparation = null,
    deferMain = false,
  }) {
    const isPlugin = kind === "plugin";
    if (operationPreparation && (typeof operationPreparation !== "object" || Array.isArray(operationPreparation) ||
        typeof operationID !== "string" || !operationID ||
        typeof operationRunID !== "string" || !operationRunID || !credentialFree(operationPreparation) ||
        typeof options.prepareOperation !== "function"))
      return { ok: false, code: "OPERATION_PREPARATION_INVALID", message: "Operation preparation requires its accepted run identity and shared preparation adapter." };
    let stack;
    try {
      stack = await loadStack();
    } catch (error) {
      logError(error);
      return { ok: false, code: "BOT_STACK_UNAVAILABLE", message: "The server could not load the bot engine." };
    }

    let normalizedRev;
    let normalizedHash;
    let runPolicy;
    let decodedDoc = null;
    let pluginSetup = null;
    let recordScriptID;
    let recordScriptName;

    if (isPlugin) {
      // The setup is untrusted bytes, and the plugin that will fly it is its one
      // gate: it says what it reads the setup as, and what running it risks.
      const host = pluginProcess();
      const checked = host ? await host.checkRun(String(pluginID), String(pluginRun), request) : { ok: false, code: "PLUGIN_RUN_UNAVAILABLE", refusal: "This server cannot run plugins." };
      if (!checked.ok) return { ok: false, code: checked.code || "PLUGIN_RUN_INVALID", message: checked.refusal };
      pluginSetup = checked.setup;
      normalizedRev = stack.PLUGIN_RUN_GRANT_REV;
      normalizedHash = hashScript(pluginSetup);
      if (expectedScriptRev !== null && (normalizedRev !== Number(expectedScriptRev) || normalizedHash !== String(expectedScriptHash || ""))) {
        return { ok: false, code: "BOT_SCRIPT_CHANGED", message: "The plugin reads this run's setup differently now. Start it again to review it." };
      }
      runPolicy = stack.pluginRunBotPolicy(checked.policy);
      recordScriptID = `plugin:${pluginID}:${pluginRun}`;
      recordScriptName = String(checked.name || pluginRun);
    } else {
      // A stored bot doc is untrusted bytes like any other; the codec is the door.
      const decoded = stack.decodeScriptValue(doc);
      if (!decoded.ok) {
        return { ok: false, code: "BOTSCRIPT_INVALID", message: decoded.refusal };
      }
      decodedDoc = decoded.doc;
      normalizedRev = Number(scriptRev);
      if (!Number.isSafeInteger(normalizedRev) || normalizedRev <= 0) {
        return { ok: false, code: "BOTSCRIPT_REVISION_REQUIRED", message: "The saved bot revision is missing." };
      }
      normalizedHash = hashScript(decodedDoc);
      // ⚠ A BLOCK THAT MOVED OUT OF CORE IS NOT A CHANGED SCRIPT. The codec reads a
      // moved block under its plugin id (`formerly`), so a run authorized before the
      // move holds the hash of the same script under the old id. The revision is
      // the same either way, and from here on the run holds the new hash.
      const expectedHash = String(expectedScriptHash || "");
      const sameScript = normalizedHash === expectedHash ||
        (typeof stack.scriptWithFormerMacroIDs === "function" && hashScript(stack.scriptWithFormerMacroIDs(decodedDoc)) === expectedHash);
      if (
        expectedScriptRev !== null &&
        (normalizedRev !== Number(expectedScriptRev) || !sameScript)
      ) {
        return {
          ok: false,
          code: "BOT_SCRIPT_CHANGED",
          message: "The saved bot changed after this run was authorized. Start it again to review the new version.",
        };
      }
      runPolicy = stack.analyzeBotRunPolicy(decodedDoc);
      if (runPolicy.containsSubBots) {
        return {
          ok: false,
          code: "BOT_SUBBOT_GRANT_UNAVAILABLE",
          message: "A server bot cannot yet grant permissions to included saved bots. Inline them before starting this run.",
        };
      }
      recordScriptID = scriptID;
      recordScriptName = scriptName;
    }

    const grantVerdict = stack.validateBotLaunchGrant(grant, normalizedRev, runPolicy);
    if (!grantVerdict.ok) {
      return { ok: false, code: grantVerdict.code, message: grantVerdict.message };
    }
    const pendingPreparationResume = resumed && operationPreparation && deferMain === true &&
      startupRuns.get(logicalRunID)?.preparation?.mainEntered === false;
    if (resumed && !runPolicy.restartSafe && !pendingPreparationResume) {
      return {
        ok: false,
        code: "BOT_RESTART_REQUIRES_CONFIRMATION",
        message: "This bot can repeat a consequential action, so it was not restarted automatically. Review and start it again.",
      };
    }
    const expiresAt =
      expectedExpiresAt === null
        ? new Date(now() + grantVerdict.grant.maxRuntimeMinutes * 60_000).toISOString()
        : String(expectedExpiresAt);
    const deadlineMs = Date.parse(expiresAt);
    if (!Number.isFinite(deadlineMs) || deadlineMs <= now()) {
      return {
        ok: false,
        code: "BOT_GRANT_EXPIRED",
        message: "This bot's approved run time has ended. Review and start it again.",
      };
    }

    if (claims.has(characterID)) {
      return { ok: false, code: "BOT_ALREADY_RUNNING", message: "A server bot is already flying this character." };
    }
    let heldByAnother;
    try {
      heldByAnother = await isCharacterHeld(characterID, callerSessionID,
        { resumed, operationRunID, logicalRunID, operationPreparation, accountID: Number(account.accountID) }, probeReservation);
    } catch (error) {
      logError(error);
      return { ok: false, code: "CHARACTER_OWNERSHIP_UNVERIFIED",
        message: "The live pilot owner could not be confirmed. Try again when the gateway is reachable." };
    }
    // The gateway probe awaited; another start may have claimed the hull then.
    if (claims.has(characterID)) {
      return { ok: false, code: "BOT_ALREADY_RUNNING", message: "A server bot is already flying this character." };
    }
    if (heldByAnother) {
      return {
        ok: false,
        code: "CHARACTER_IN_USE",
        message: "A web session is flying this character. Log it out (or wait for it to expire), then start the bot.",
      };
    }
    // ONE CLIENT PER ACCOUNT. Where the game server closes an account's other
    // clients at each login (gamePort/pilots.js closedByServer), this start's
    // select would log out a run already flying another pilot of the account,
    // and that run would end mid-step. Checked with the claim below, after the
    // last await, so two starts on one account cannot both pass.
    const sharing = typeof options.oneClientPerAccount === "function" &&
      options.oneClientPerAccount({ accountID: Number(account.accountID), characterID, userName: String(account.username || "") })
      ? [...records.values()].find((row) => !row.finalized && row.accountID === Number(account.accountID) &&
          row.characterID !== characterID && claims.get(row.characterID) === row.botID)
      : undefined;
    if (sharing) {
      return {
        ok: false,
        code: "ACCOUNT_IN_USE_BY_BOT",
        message: `${sharing.characterName || "Another pilot of this account"} is flying a server run, and the game server ` +
          "lets one pilot of an account be in game at a time: starting this one would log that one out. Let that run " +
          "end, or stop it, then start this one.",
      };
    }

    const botID = crypto.randomUUID();
    const record = {
      botID,
      logicalRunID: logicalRunID || crypto.randomUUID(),
      accountID: Number(account.accountID),
      username: String(account.username || ""),
      characterID,
      characterName: null,
      kind: kindOf(kind),
      pluginID: isPlugin ? String(pluginID) : null,
      pluginRun: isPlugin ? String(pluginRun) : null,
      pluginSetup,
      pluginResumeData: isPlugin ? resumeData : null,
      pluginReadout: null,
      pluginFetch: null,
      pluginStarted: false,
      pluginDownTimer: null,
      pluginDowns: [],
      pluginOversizeSaid: false,
      recall: null,
      scriptID: recordScriptID,
      scriptName: recordScriptName,
      scriptRev: normalizedRev,
      scriptHash: normalizedHash,
      operationID: typeof operationID === "string" && operationID.length > 0 ? operationID : null,
      operationRole: ["MINER", "HAULER", "COMMAND", "DEFENDER"].includes(operationRole) ? operationRole : null,
      operationRunID,
      operationPreparation: operationPreparation ? structuredClone(operationPreparation) : null,
      preparation: operationPreparation ? { state: "PENDING" } : null,
      preparationCheckpoint: null,
      deferMain: !!operationPreparation && (deferMain || resumed),
      mainStarted: false,
      activationFailed: false,
      activatePromise: null,
      operationControllerAccountID: Number.isSafeInteger(Number(operationControllerAccountID)) && Number(operationControllerAccountID) > 0 ? Number(operationControllerAccountID) : null,
      operationStopRequested: false,
      parking: null,
      prepareParkingPromise: null,
      parkingPromise: null,
      restartSafe: runPolicy.restartSafe === true,
      hostedOreJettisonRecovery: operationRole === "MINER" && !!operationID && recordScriptID.startsWith("mcc.") &&
        stack.supportsHostedOreJettisonRecovery?.(decodedDoc) === true,
      jettisonCustody: null,
      riskClasses: [...runPolicy.riskClasses],
      maxRuntimeMinutes: grantVerdict.grant.maxRuntimeMinutes,
      expiresAt,
      resumedAt: resumed ? nowISO() : null,
      vitals: null,
      status: "starting",
      phase: null,
      why: null,
      stepPath: null,
      pauseReason: null,
      note: null,
      lastAlert: null,
      startError: null,
      startedAt: nowISO(),
      endedAt: null,
      finalized: false,
      flow: null,
      store: null,
      unsubscribe: null,
      claimSecret: createClaimSecret(),
      // The web session the bot's own token names -- the key its held game
      // session sits under in the server's bridgeSessions. Only ever handed
      // out by readableSessionOf below, and never serialized.
      webSessionID: null,
      deadlineTimer: null,
      deadlineRequested: false,
      deadlineDockingStarted: false,
      manualStopRequested: false,
      manualCancellationIssued: false,
      manualCancellationPromise: null,
      stopFailureCode: null,
      stopPromise: null,
      stopBlocked: false,
      droneSafetyConfirmed: false,
      // Set once the deadline has fired and endRunDocked is bringing the ship
      // in; the store subscription then leaves finalizing to it.
      windingDown: false,
      recovering: false,
      recoveryEnabled: false,
      recoveryAttempts: Number.isSafeInteger(recoveryAttempts) && recoveryAttempts >= 0 ? recoveryAttempts : 0,
      recovery: null,
      recoveryPromise: null,
      recoverSession: null,
    };
    // Claim BEFORE the first await — two concurrent starts must not both win,
    // and the select guard must already know this bot when its select arrives.
    claims.set(characterID, botID);
    records.set(botID, record);

    try {
      // The token covers the APPROVED RUN, not the web default: a bot flying
      // for an hour holds an hour's credential, and one approved for longer
      // than a browser session lives (runPolicy allows up to 72h, the default
      // sign-in is 12h) is no longer cut off in silence halfway through. See
      // SESSION_TEARDOWN_MARGIN_MS and DEADLINE_DOCK_GRACE_MS for why it
      // outlives the deadline, and
      // webAuth.createSessionToken for the rail on how far this can be pushed.
      // A resumed bot asks for the time its ORIGINAL grant has left, because
      // `expiresAt` is the persisted deadline, not a fresh one.
      const token = auth.createSessionToken(account, {
        ttlMs: deadlineMs - now() + CONTROLLED_DRONE_CLEANUP_MS * (record.operationRole === "COMMAND" ? 2 : 1) + DEADLINE_DOCK_GRACE_MS + SESSION_TEARDOWN_MARGIN_MS,
      });
      const tokenPayload =
        typeof auth.verifySessionToken === "function" ? auth.verifySessionToken(token) : null;
      record.webSessionID = tokenPayload && tokenPayload.sessionID ? String(tokenPayload.sessionID) : null;
      const store = stack.createClientStore();
      // Same fetch the server itself trusts, plus the bot's name on every
      // request so the select guard can tell the bot's own select from a tab's.
      const pendingRequests = new Set();
      const botFetch = (input, init) => {
        const secret = record.claimSecret;
        const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url, baseUrl);
        const method = String(init?.method || "GET").toUpperCase();
        // The page makes its own writes by the generic call (the plan's Phase 6b), where the call's name says
        // whether it is one, as it says to the BFF (bridgeCallPolicy.js). A call that cannot be read is taken
        // for a write: unknown intent stays blocked.
        const call = url.pathname === "/api/bridge/call" ? genericCallOf(init?.body) : null;
        const writes = method !== "GET" && method !== "HEAD" &&
          (url.pathname !== "/api/bridge/call" || call === null || isBridgeWritePair(call.service, call.method));
        const fleetAcceptance = record.recoveryFleetAcceptance;
        let exactFleetAcceptance = false;
        // An invitation is accepted by the generic call, on the fleet the call names (fleetWrites.ts, acceptFleetInvite).
        if (call?.service === "fleetObjectHandler" && call.method === "AcceptInvite" && fleetAcceptance?.secret === secret && record.riskClasses.includes("fleet")) {
          try { fleetAcceptance.assertCurrent(); } catch (error) { return Promise.reject(error); }
          exactFleetAcceptance = call.of === fleetAcceptance.fleetID;
        }
        const preparationRecovery = record.operationPreparation && record.preparingRecovery === true &&
          ["/api/bridge/provisioning/review", "/api/bridge/provisioning/reconcile"].includes(url.pathname);
        // (The stop is the ship's own command, by the generic call: movementWrites.ts, stopShip.)
        const stops = call?.service === "beyonce" && call.method === "CmdStop";
        const recoveryWrite = preparationRecovery || exactFleetAcceptance || stops || ["/api/bridge/select", "/api/bridge/entity/drones/reconnect", "/api/bridge/drones/recall",
          "/api/bridge/drone-recovery/ready", "/api/bridge/ship/jettison/reconcile"].includes(url.pathname);
        if (record.recovering && !record.windingDown && writes && !recoveryWrite) {
          return Promise.reject(Object.assign(new Error("The hosted session is recovering; productive writes are paused."),
            { code: "HOSTED_RECOVERY_PENDING" }));
        }
        const headers = new Headers(init && init.headers);
        headers.set(BOT_HEADER, secret);
        const pending = (async () => {
          const response = await reach(input, { ...init, headers });
          if (!response.ok && record.recoveryEnabled) {
            const body = await response.clone().json().catch(() => null);
            if (["SESSION_NOT_FOUND", "NO_LIVE_SESSION"].includes(body?.error)) {
              // A lost write may have reached the world. Preserve that ambiguity
              // independently of the runner/frame that was still awaiting it.
              if (writes) {
                if (url.pathname === "/api/bridge/ship/jettison" && record.hostedOreJettisonRecovery) record.jettisonWriteUnresolved = true;
                else record.recoveryWriteUnresolved = true;
              }
              if (!record.recovering && secret === record.claimSecret) void record.recoverSession(false).catch(logError);
            }
          }
          return response;
        })().catch(error => {
          if (writes && url.pathname === "/api/bridge/ship/jettison" && record.hostedOreJettisonRecovery)
            record.jettisonWriteUnresolved = true;
          throw error;
        }).finally(() => pendingRequests.delete(pending));
        pendingRequests.add(pending);
        return pending;
      };
      let hostedStartup;
      if (record.operationPreparation) {
        const checkpointSecret = record.claimSecret;
        record.preparationCheckpoint = startupRuns.openPreparation({ logicalRunID: record.logicalRunID,
          accountID: record.accountID, characterID, scriptHash: normalizedHash, scriptRev: normalizedRev,
          operationID: record.operationID, operationRunID: record.operationRunID, intent: record.operationPreparation,
          resumed, assertCurrent: () => preparationOwner(record, checkpointSecret) });
        record.preparation = record.preparationCheckpoint.snapshot();
        persistRoster();
      }
      if (!isPlugin && Array.isArray(decodedDoc.program)) {
        const startup = await import(pathToFileURL(path.resolve(__dirname, "../web/src/bots/startup.ts")).href);
        if (startup.startupPrefix(decodedDoc).length) {
          if (resumed && !logicalRunID) throw new Error("Older startup run has no durable identity; start manually after review.");
          hostedStartup = startupRuns.open({ logicalRunID: record.operationPreparation ? record.logicalRunID : resumed ? logicalRunID : null,
            accountID: record.accountID, characterID, scriptHash: normalizedHash, scriptRev: normalizedRev,
            steps: startup.startupSteps(decodedDoc), prefixLength: startup.startupPrefix(decodedDoc).length, program: decodedDoc.program,
            adapters: { postcondition: startup.startupPostcondition, actionSupported: startup.startupActionSupported,
              actionLanded: startup.startupActionLanded, changesShip: startup.startupChangesShip,
              unfenced: startup.startupActionUnfenced } });
          record.startup = hostedStartup;
          record.logicalRunID = hostedStartup.logicalRunID;
          persistRoster();
        }
      }
      const flow = stack.createAppFlow(store, {
        hostedStartup,
        baseUrl,
        fetch: botFetch,
        perSessionToken: true,
        initialSessionToken: token,
        eventSource: url => stack.createHostedEventSource(url, { fetch: botFetch }),
        miningOperationID: record.operationID,
        hostedOreJettisonRecovery: record.hostedOreJettisonRecovery,
        // The pilot's own route settings, as its page keeps them (src/pilotRouteSettings.js): a run with none plans
        // every route "Prefer safer", whatever the pilot chose.
        ...(typeof options.settingsStorageFor === "function" ? { storage: options.settingsStorageFor(characterID) } : {}),
      });
      record.flow = flow;
      record.store = store;
      // What the plugin's process asks is asked as this run: its token and claim are added here and stay here.
      if (isPlugin) {
        record.pluginFetch = (input, init = {}) => {
          const headers = new Headers(init.headers);
          headers.set("authorization", `Bearer ${token}`);
          return botFetch(input, { ...init, headers });
        };
      }
      record.startProductive = async () => {
        if (isPlugin) {
          record.startError = await startPluginLoop(record, resumed);
          if (record.startError === null && record.status === "starting") record.status = "running";
          return;
        }
        else await flow.startCustomBot(decodedDoc);
        applySnapshot(record, store.customBot.get());
      };
      record.recoverSession = (disconnect = false) => {
        if (record.recoveryPromise) return record.recoveryPromise;
        if (!record.recoveryEnabled || record.kind !== "script" || !record.operationID || record.windingDown ||
            record.operationStopRequested || record.manualStopRequested || record.deadlineRequested || record.finalized)
          return Promise.reject(new Error("This hosted run cannot recover its session."));
        const observedShipID = store.flight.get().status?.shipID ?? store.space.get().snapshot?.shipID ?? store.station.get().online?.shipID;
        const previousSecret = record.claimSecret;
        record.recovering = true;
        record.claimSecret = createClaimSecret();
        record.status = "paused"; record.phase = "Session recovery";
        record.recovery = { state: "RECOVERY", attempts: record.recoveryAttempts, reason: null };
        const suspended = flow.suspendHostedSession();
        const until = Math.min(Date.parse(record.expiresAt), now() + 180_000);
        const current = () => {
          if (record.finalized || record.flow !== flow || claims.get(characterID) !== botID || record.windingDown ||
              record.operationStopRequested || record.manualStopRequested || record.deadlineRequested || now() >= until)
            throw new Error("Session recovery was superseded or its original grant ended.");
        };
        const bounded = async pending => {
          let timer;
          try {
            const result = await Promise.race([pending, new Promise((_resolve, reject) => {
              timer = setTimeout(() => reject(new Error("Session recovery exceeded its observation bound.")), Math.max(1, until - now()));
            })]);
            current();
            return result;
          } finally { clearTimeout(timer); }
        };
        const recover = (async () => {
          try {
            await bounded(suspended);
            await bounded(Promise.all([...pendingRequests]));
            // The game server closed this pilot's connection with a reason of its own (another login of its account):
            // a retail client so closed stays closed, and so does this run (gamePort/pilots.js closedByServer).
            const closedByServer = typeof options.closedByServer === "function" ? options.closedByServer(characterID) : null;
            if (closedByServer)
              throw new Error(`The game server closed this pilot's connection (${closedByServer.reasonCode}): ${closedByServer.reason}`);
            if (!Number.isSafeInteger(observedShipID) || observedShipID <= 0) throw new Error("The original hosted hull was not positively observed.");
            const liveAccount = await bounded(loadAccount(record.username));
            if (!liveAccount || liveAccount.banned || Number(liveAccount.accountID) !== record.accountID) throw new Error("The hosted account is unavailable.");
            const saved = await bounded(Promise.resolve(loadScript(record.scriptID, record)));
            const decoded = saved && stack.decodeScriptValue(saved.doc);
            const policy = decoded?.ok ? stack.analyzeBotRunPolicy(decoded.doc) : null;
            if (!decoded?.ok || Number(saved.rev) !== record.scriptRev || hashScript(decoded.doc) !== record.scriptHash ||
                !(policy?.restartSafe || record.hostedOreJettisonRecovery && stack.supportsHostedOreJettisonRecovery?.(decoded.doc)) || policy.containsSubBots || !stack.validateBotLaunchGrant({ scriptRev: record.scriptRev,
                  riskClasses: record.riskClasses, maxRuntimeMinutes: record.maxRuntimeMinutes }, record.scriptRev, policy).ok)
              throw new Error("The pinned script or granted permissions changed.");
            if (disconnect) {
              if (typeof options.disconnectOwnedSession !== "function") throw new Error("Owned session disconnect is unavailable.");
              await bounded(options.disconnectOwnedSession({ webSessionID: record.webSessionID, characterID, accountID: record.accountID,
                claimSecret: record.claimSecret, previousSecret }));
            }
            if (record.recoveryAttempts >= 3) throw new Error("Session recovery retry budget is exhausted.");
            while (record.recoveryAttempts < 3) {
              current(); record.recoveryAttempts += 1;
              record.recovery.attempts = record.recoveryAttempts; persistRoster();
              try { await bounded(flow.selectCharacter(characterID)); break; }
              catch (error) {
                // Only positive session disappearance permits another select.
                // Timeouts/release uncertainty keep the claim and never replay.
                if (!["SESSION_NOT_FOUND", "NO_LIVE_SESSION"].includes(error?.code) || record.recoveryAttempts >= 3) throw error;
                await bounded(sleep(30_000));
              }
            }
            if (record.recoveryWriteUnresolved) throw new Error("A write outcome is unresolved; work custody is retained for reconciliation.");
            await bounded(flow.verifyHostedSessionRecovery(observedShipID));
            current();
            if (record.operationPreparation) {
              record.preparingRecovery = true;
              try { await bounded(prepareOperationRecord(record)); }
              finally { record.preparingRecovery = false; }
              current();
              if (!preparationReady(record.preparation)) throw new Error("Operation preparation still requires recovery before MAIN.");
            }
            if (record.jettisonWriteUnresolved || jettison.unresolved(record.jettisonCustody))
              throw new Error("Jettison outcome is ambiguous; exact mutation custody and pilot control are retained.");
            if (record.recoveryWriteUnresolved) throw new Error("A late write outcome remains unresolved; control is retained.");
            if (record.operationRole === "HAULER") {
              const assignment = await bounded(flow.readMiningOperationAssignment());
              if (assignment?.support) {
                const supportID = assignment.support.characterID;
                const peer = [...records.values()].find(row => row.operationID === record.operationID && row.operationRole === "COMMAND" && row.characterID === supportID);
                const peerFlow = peer?.flow, peerSecret = peer?.claimSecret;
                const assertMember = () => {
                  current();
                  if (assignment.operationID !== record.operationID || assignment.role !== "HAULER" || assignment.stopRequested ||
                      !record.riskClasses.includes("fleet") || !peer || peer.finalized || peer.recovering || peer.windingDown ||
                      peer.operationStopRequested || peer.manualStopRequested || peer.deadlineRequested || !peer.riskClasses.includes("fleet") ||
                      peer.flow !== peerFlow || peer.claimSecret !== peerSecret || claims.get(supportID) !== peer.botID || Date.parse(peer.expiresAt) <= now() ||
                      peer.store?.station.get().online?.characterID !== supportID || store.station.get().online?.characterID !== characterID)
                    throw new Error("The hauler's surviving support fleet authority changed.");
                };
                let memberMemory = stack.supportFleet.freshMiningSupportFleetMemory(), leaderMemory = stack.supportFleet.freshMiningSupportFleetMemory();
                let memberFeedback, leaderFeedback, ready = false;
                // A hauler can suspend inside a long-lived loot step. Confirm
                // membership before resuming that step, using the ordinary
                // invite/accept deciders with at most one action per read tick.
                for (let tick = 0; tick < 30; tick++) {
                  assertMember();
                  const latest = await bounded(flow.readMiningOperationAssignment());
                  if (latest?.operationID !== assignment.operationID || latest.role !== "HAULER" || latest.stopRequested ||
                      latest.support?.characterID !== supportID || latest.support.fleetPolicy !== assignment.support.fleetPolicy)
                    throw new Error("The hauler support assignment changed during recovery.");
                  await bounded(peerFlow.loadFleet()); assertMember();
                  await bounded(flow.loadFleet()); assertMember();
                  const own = flow.readMiningSupportFleet(`${botID}:${record.recoveryAttempts}`);
                  const support = peerFlow.readMiningSupportFleet(`${peer.botID}:${peer.recoveryAttempts}`);
                  const member = stack.supportFleet.decideMiningSupportFleetMember({ own, support, supportCharacterID: supportID,
                    policy: { mode: latest.support.fleetPolicy }, nowMs: now(), feedback: memberFeedback }, memberMemory);
                  memberMemory = member.memory; memberFeedback = undefined;
                  if (member.state === "ready") { ready = true; break; }
                  if (member.state === "blocked" || latest.support.fleetPolicy !== "MANAGED") throw new Error("The hauler is outside its selected support fleet.");
                  if (member.action) {
                    if (member.action.kind !== "acceptFleetInvite") throw new Error("Hauler recovery requires an ordinary support invitation.");
                    record.recoveryFleetAcceptance = { secret: record.claimSecret, fleetID: member.action.fleetID, assertCurrent: assertMember };
                    try { await bounded(flow.acceptFleetInvite(member.action.fleetID)); }
                    finally { record.recoveryFleetAcceptance = null; }
                    assertMember();
                    if (store.fleet.get().actionError) throw new Error("The hauler's fleet acceptance was not confirmed.");
                    memberFeedback = { scope: own.scope, actionID: member.actionID, outcome: "acknowledged" };
                  } else {
                    const leader = stack.supportFleet.decideMiningSupportFleet({ own: support, intendedCharacterIDs: [characterID],
                      memberObservations: [own], policy: { mode: "MANAGED" }, nowMs: now(), feedback: leaderFeedback }, leaderMemory);
                    leaderMemory = leader.memory; leaderFeedback = undefined;
                    if (["blocked", "recovery-required"].includes(leader.state)) throw new Error("The surviving support invitation is blocked.");
                    if (leader.action) {
                      if (leader.action.kind !== "inviteToFleet" || leader.action.charID !== characterID || !leader.fleetID) throw new Error("Hauler recovery cannot create or switch fleets.");
                      await bounded(peerFlow.inviteFleetMember(characterID, assertMember, leader.fleetID)); assertMember();
                      if (peer.store.fleet.get().actionError) throw new Error("The support invitation was not confirmed.");
                      leaderFeedback = { scope: support.scope, actionID: leader.actionID, outcome: "acknowledged" };
                    }
                  }
                  await bounded(sleep(2000));
                }
                if (!ready) throw new Error("The hauler's selected fleet membership remains unconfirmed.");
              }
            }
            if (record.operationRole === "COMMAND") {
              const assignment = await bounded(flow.readMiningOperationAssignment());
              const managed = value => value?.operationID === record.operationID && value.role === "COMMAND" &&
                value.support?.characterID === characterID && value.support.fleetPolicy === "MANAGED" && !value.stopRequested;
              if (managed(assignment)) {
                const peers = [...records.values()].filter(peer => peer !== record && peer.operationID === record.operationID);
                const captured = peers.map(peer => ({ peer, flow: peer.flow, secret: peer.claimSecret }));
                const livePeer = item => !item.peer.finalized && !item.peer.recovering && !item.peer.windingDown &&
                  !item.peer.operationStopRequested && !item.peer.manualStopRequested && !item.peer.deadlineRequested &&
                  item.peer.flow === item.flow && item.peer.claimSecret === item.secret && claims.get(item.peer.characterID) === item.peer.botID &&
                  Date.parse(item.peer.expiresAt) > now() && item.flow && item.peer.store?.station.get().online?.characterID === item.peer.characterID;
                const observations = [];
                for (const item of captured) {
                  if (!livePeer(item)) continue;
                  await bounded(item.flow.loadFleet());
                  if (!livePeer(item)) continue;
                  const observed = item.flow.readMiningSupportFleet(`${item.peer.botID}:${item.peer.recoveryAttempts}`);
                  if (observed) observations.push(observed);
                }
                await bounded(flow.loadFleet());
                const own = flow.readMiningSupportFleet(`${botID}:${record.recoveryAttempts}`);
                const latest = await bounded(flow.readMiningOperationAssignment());
                if (!managed(latest) || JSON.stringify(latest.intendedFleetCharacterIDs) !== JSON.stringify(assignment.intendedFleetCharacterIDs))
                  throw new Error("The managed support assignment changed during recovery.");
                const selected = stack.supportFleet.miningSupportRecoveryInviter({ own,
                  intendedCharacterIDs: latest.intendedFleetCharacterIDs ?? [], memberObservations: observations, nowMs: now() });
                if (["unknown", "conflict"].includes(selected.state)) throw new Error("Surviving fleet authority is unavailable or conflicting.");
                if (selected.state === "ready") {
                  const inviter = captured.find(item => item.peer.characterID === selected.characterID);
                  const assertInvite = () => { current(); if (!inviter || !livePeer(inviter) || !inviter.peer.riskClasses.includes("fleet"))
                    throw new Error("The surviving member's fleet grant or ownership changed."); };
                  assertInvite();
                  const scope = observations.find(row => row.scope.characterID === selected.characterID);
                  const prior = record.recoveryFleetInvite;
                  const same = prior?.inviterSecret === inviter.secret && prior.targetSecret === record.claimSecret;
                  const decision = stack.supportFleet.decideMiningSupportFleet({ own: scope, intendedCharacterIDs: [characterID],
                    memberObservations: [own], policy: { mode: "MANAGED" }, nowMs: now(), feedback: same ? prior.feedback : undefined },
                    same ? prior.memory : stack.supportFleet.freshMiningSupportFleetMemory());
                  record.recoveryFleetInvite = { inviterSecret: inviter.secret, targetSecret: record.claimSecret, memory: decision.memory, feedback: undefined };
                  if (decision.action) {
                    if (decision.action.kind !== "inviteToFleet" || decision.action.charID !== characterID) throw new Error("Recovery requires an ordinary member invitation.");
                    await bounded(inviter.flow.inviteFleetMember(characterID, assertInvite, selected.fleetID));
                    assertInvite();
                    if (inviter.peer.store.fleet?.get().actionError) throw new Error("The surviving member invitation could not be confirmed.");
                    record.recoveryFleetInvite.feedback = { scope: scope.scope, actionID: decision.actionID, outcome: "acknowledged" };
                  } else if (decision.state === "blocked") throw new Error("The surviving member invitation is blocked.");
                }
              }
            }
            current();
            if (record.recoveryWriteUnresolved) throw new Error("A late write outcome remains unresolved; control is retained.");
            if (!record.operationPreparation || record.mainStarted) flow.resumeHostedSession();
            record.recovering = false; record.recovery = { state: "READY", attempts: record.recoveryAttempts, reason: null };
            if (!record.operationPreparation || record.mainStarted) applySnapshot(record, store.customBot.get());
            else { record.status = "paused"; record.phase = "Waiting for operation readiness"; }
            persistRoster();
            if (record.operationPreparation && !record.mainStarted && typeof options.onOperationResume === "function")
              await options.onOperationResume();
          } catch (error) {
            if (!record.finalized && !record.windingDown) {
              record.status = "paused"; record.phase = "Session recovery blocked"; record.why = error?.message || "Session authority could not be re-established.";
              record.recovery = { state: "BLOCKED", attempts: record.recoveryAttempts, reason: record.why };
              persistRoster();
            }
            throw error;
          }
        })();
        record.recoveryPromise = recover.finally(() => { record.recoveryPromise = null; });
        persistRoster();
        return record.recoveryPromise;
      };

      if (beforeStart) {
        const handedOver = await beforeStart({ claimSecret: record.claimSecret, webSessionID: record.webSessionID });
        record.giveBackSession = handedOver?.giveBack ?? null;
      }
      await flow.selectCharacter(characterID);
      const online = store.station.get().online;
      record.characterName = online ? online.characterName : null;
      if (record.operationPreparation) await prepareOperationRecord(record);
      if (record.operationPreparation && (record.finalized || record.manualStopRequested || record.operationStopRequested))
        return { ok: true, bot: publicBot(record) };

      // The readout is store-driven exactly like the in-tab panel: project the
      // customBot slice onto the record, and treat the loop
      // letting go of the ship as the end of the bot.
      let sawRunning = false;
      record.unsubscribe = store.subscribe((state) => {
        if (record.recovering && !record.windingDown) return;
        if (record.operationPreparation && !record.mainStarted) return;
        if (isPlugin) {
          // This flow only holds the session: what the run is doing, the plugin reports.
          if (record.pluginStarted && !record.windingDown && state.station.online === null) {
            const closed = typeof options.closedByServer === "function" ? options.closedByServer(characterID) : null;
            record.status = "error";
            record.why = closed
              ? `The game server closed this pilot's connection: ${closed.reason}.`
              : "The pilot went offline, so the run stopped.";
            void finalize(record);
          }
          return;
        }
        const snapshot = state.customBot;
        // ⚠ A PILOT THAT WENT OFFLINE IS NOT A FINISHED RUN. Losing the session
        // (another login of the account closes this one) resets every slice to
        // its start, and a reset slice reads "idle", which is how a run that
        // reached its end reads too. The last readout is kept, and the run ends
        // as an error that says what happened.
        if (sawRunning && !record.windingDown && state.station.online === null && ENDED_STATUSES.has(snapshot.status)) {
          const closed = typeof options.closedByServer === "function" ? options.closedByServer(characterID) : null;
          record.status = "error";
          record.pauseReason = null;
          record.why = closed
            ? `The game server closed this pilot's connection: ${closed.reason}.`
            : "The pilot went offline, so the run stopped.";
          void finalize(record);
          return;
        }
        applySnapshot(record, snapshot);
        if (snapshot.status === "running" || snapshot.status === "paused") {
          sawRunning = true;
        }
        // ⚠ NOT WHILE WINDING DOWN: endRunDocked stops the loop on purpose to
        // dock the ship, and that stop must not log the pilot off in space.
        if (sawRunning && ENDED_STATUSES.has(snapshot.status) && !record.windingDown) {
          void finalize(record);
        }
      });

      if (!record.operationPreparation) await record.startProductive();
      else if (!record.deferMain && preparationReady(record.preparation))
        await activateOperationMember(record.botID, record.accountID, record.operationID, record.operationRunID);
      if (record.startError !== null && !record.operationPreparation) {
        await finalize(record);
        return { ok: false, code: "BOT_START_FAILED", message: record.startError };
      }
      record.giveBackSession = null;
      record.recoveryEnabled = !!record.operationID && (record.restartSafe || record.hostedOreJettisonRecovery) && typeof flow.suspendHostedSession === "function";
      const remainingMs = Math.max(1, Date.parse(record.expiresAt) - now());
      record.deadlineTimer = setDeadlineTimeout(() => {
        record.deadlineTimer = null;
        if (record.finalized || record.windingDown) {
          return;
        }
        if (record.operationID) {
          // MCC must enter Stop while every pilot is still owned. Independent
          // deadline finalization would strand the operation and its leases.
          void Promise.resolve().then(() => {
            if (typeof options.onOperationDeadline !== "function") throw new Error("Operation deadline coordination is unavailable.");
            return options.onOperationDeadline(record.operationID);
          }).catch(async error => {
            if (!record.finalized) {
              await prepareOperationStop(record.botID, record.accountID, record.operationID);
              if (record.finalized || claims.get(record.characterID) !== record.botID) return;
              record.status = "paused";
              record.phase = "Operation deadline blocked";
              record.why = error?.message || "Operation deadline coordination failed.";
              record.stopBlocked = true;
              persistRoster();
            }
            logError(error);
          });
        } else void requestGracefulStop(record, true).catch(logError);
      }, remainingMs);
      if (typeof record.deadlineTimer.unref === "function") {
        record.deadlineTimer.unref();
      }
      persistRoster();
      // First vitals sample right away (fire-and-forget), so the landing
      // page's next poll already has ship state instead of a blank line.
      void sampleBotVitals(record);
      return { ok: true, bot: publicBot(record) };
    } catch (error) {
      logError(error);
      record.status = "error";
      record.why = error && error.message ? String(error.message) : "The bot could not be started.";
      await finalize(record);
      return { ok: false, code: error && ["CHARACTER_IN_USE", "PILOT_RELEASE_UNVERIFIED", "DRONE_HANDOFF_UNSAFE", "DRONE_RECOVERY_PENDING"].includes(error.code)
        ? error.code : "BOT_START_FAILED", message: record.why };
    }
  }

  async function stop(botID, accountID) {
    const record = records.get(botID);
    if (!record || record.accountID !== Number(accountID)) {
      return { ok: false, code: "BOT_NOT_FOUND" };
    }
    return requestGracefulStop(record, false);
  }

  function operationRecord(botID, accountID, operationID) {
    const record = records.get(botID);
    return record && !record.finalized && record.accountID === Number(accountID) &&
      record.operationID === operationID && claims.get(record.characterID) === botID ? record : null;
  }

  function preparationOwner(record, secret) {
    if (record.finalized || record.claimSecret !== secret || claims.get(record.characterID) !== record.botID ||
        record.windingDown || record.operationStopRequested || record.manualStopRequested || record.deadlineRequested ||
        Date.parse(record.expiresAt) <= now())
      throw Object.assign(new Error("Operation preparation owner or run is no longer current."), { code: "OPERATION_PREPARATION_STALE" });
  }

  function preparationOwnerAvailable(record) {
    return claims.get(record.characterID) === record.botID && !record.finalized && !!record.flow &&
      !record.recovering && record.recovery?.state !== "BLOCKED" && !record.activationFailed &&
      !record.windingDown && !record.operationStopRequested && !record.manualStopRequested &&
      !record.deadlineRequested && Date.parse(record.expiresAt) > now();
  }

  async function preparationCustodyUnresolved(record) {
    if (!record.operationPreparation) return false;
    if (typeof options.preparationUnresolved === "function") return await options.preparationUnresolved(record) !== false;
    return ["PREPARING", "RECOVERY_REQUIRED"].includes((record.preparationCheckpoint?.snapshot() || record.preparation)?.state);
  }

  async function prepareOperationRecord(record) {
    const secret = record.claimSecret;
    const assertCurrent = () => preparationOwner(record, secret);
    const checkpoint = startupRuns.openPreparation({ logicalRunID: record.logicalRunID,
      accountID: record.accountID, characterID: record.characterID, scriptHash: record.scriptHash, scriptRev: record.scriptRev,
      operationID: record.operationID, operationRunID: record.operationRunID, intent: record.operationPreparation,
      resumed: true, assertCurrent });
    record.preparationCheckpoint = checkpoint;
    record.assertPreparationCurrent = assertCurrent;
    record.preparation = checkpoint.snapshot();
    if (preparationReady(record.preparation)) {
      record.status = "paused"; record.phase = "Waiting for operation readiness";
      record.why = record.preparation.reason || null;
      persistRoster(); return;
    }
    record.status = "paused"; record.phase = "Operation preparation";
    // Do not manufacture an issued mutation. The shared preparation adapter
    // begins its durable block before asking the existing custody engine to act.
    record.preparation = { ...record.preparation, state: "PREPARING" }; persistRoster();
    try {
      const result = await options.prepareOperation({ ...record, preparationCheckpoint: checkpoint,
        assertPreparationCurrent: assertCurrent });
      assertCurrent();
      record.preparation = preparationReady(result) ? checkpoint.complete(result) : checkpoint.block(result || {
        state: "BLOCKED", reason: "Preparation did not provide readiness evidence." });
    } catch (error) {
      try {
        assertCurrent();
        const pending = checkpoint.snapshot();
        record.preparation = checkpoint.block({ state: pending.state === "PREPARING" || pending.state === "RECOVERY_REQUIRED"
          ? "RECOVERY_REQUIRED" : "BLOCKED", reason: error?.message || "Preparation could not be verified." });
      } catch { return; } // A retired invocation cannot settle a newer run.
    }
    record.status = "paused";
    record.phase = preparationReady(record.preparation) ? "Waiting for operation readiness" : "Operation preparation blocked";
    record.why = record.preparation.reason || null;
    persistRoster();
  }

  async function activateOperationMember(botID, accountID, operationID, operationRunID) {
    const record = operationRecord(botID, accountID, operationID);
    if (!record || !record.operationPreparation || record.operationRunID !== operationRunID)
      return { ok: false, code: "OPERATION_PREPARATION_STALE", message: "This operation run does not own the hosted member." };
    if (record.activatePromise) return record.activatePromise;
    const pending = (async () => {
      const secret = record.claimSecret;
      try {
        preparationOwner(record, secret);
        if (!preparationOwnerAvailable(record)) return { ok: false, code: "OPERATION_NOT_READY",
          message: "The hosted preparation owner has not finished session recovery." };
        if (record.activationFailed) return { ok: false, code: "BOT_START_FAILED", message: record.why || "Productive fitting validation failed; this run requires review." };
        // A synchronous predicate proves the current aggregate owner set in
        // this same turn as enterMain. An awaited approval can outlive a peer.
        const barrier = typeof options.operationBarrierReady === "function" && options.operationBarrierReady(record);
        if (barrier && typeof barrier.then === "function") Promise.resolve(barrier).catch(logError);
        if (!preparationReady(record.preparationCheckpoint.snapshot()) || barrier !== true)
          return { ok: false, code: "OPERATION_NOT_READY", message: "Required operation members have not crossed the readiness barrier." };
        preparationOwner(record, secret);
        if (!preparationOwnerAvailable(record)) return { ok: false, code: "OPERATION_NOT_READY",
          message: "The hosted preparation owner has not finished session recovery." };
        if (record.mainStarted) return { ok: true, bot: publicBot(record) };
        record.preparation = record.preparationCheckpoint.enterMain();
        record.mainStarted = true; record.deferMain = false;
        persistRoster(); // MAIN eligibility is durable before the first runner action.
        await record.startProductive();
        preparationOwner(record, secret);
        if (record.startError !== null) throw new Error(record.startError);
        persistRoster();
        return { ok: true, bot: publicBot(record) };
      } catch (error) {
        if (!record.finalized && record.claimSecret === secret) {
          if (record.mainStarted) record.activationFailed = true;
          record.status = "paused"; record.phase = "Operation activation blocked"; record.why = error.message;
          persistRoster();
        }
        return { ok: false, code: error.code || "BOT_START_FAILED", message: error.message };
      }
    })();
    record.activatePromise = pending;
    try { return await pending; } finally { record.activatePromise = null; }
  }

  async function prepareOperationStop(botID, accountID, operationID) {
    const record = operationRecord(botID, accountID, operationID);
    if (!record) return { ok: false, code: "PARKING_MEMBER_UNAVAILABLE", message: "Operation does not own this live pilot." };
    if (record.prepareParkingPromise) return record.prepareParkingPromise;
    if (record.stopPromise || record.deadlineRequested) {
      return { ok: false, code: "PARKING_STOP_IN_PROGRESS", message: "A hosted Stop or deadline is already settling this pilot." };
    }
    record.operationStopRequested = true;
    record.windingDown = true;
    record.parking = { state: "SETTLING", reason: null };
    persistRoster();
    const pending = (async () => {
      try {
        if (record.recoveryWriteUnresolved || record.jettisonWriteUnresolved || jettison.unresolved(record.jettisonCustody) ||
            await preparationCustodyUnresolved(record)) throw new Error("An issued write still needs reconciliation; Parking retains pilot control.");
        if (record.deferMain === true && record.mainStarted === false && record.preparationCheckpoint?.snapshot()?.mainEntered === false)
          await record.flow.prepareHostedBotStop(record.kind, now() + CONTROLLED_DRONE_CLEANUP_MS * (record.operationRole === "COMMAND" ? 2 : 1));
        else await record.flow.prepareCustomBotParking();
        record.droneSafetyConfirmed = true;
        record.parking = { state: "READY", reason: null };
        persistRoster();
        return { ok: true };
      } catch (error) {
        const reason = error?.message || "Mining equipment or controlled drones could not be settled.";
        record.parking = { state: "PARKING_FAILED", reason };
        record.status = "paused";
        record.phase = "Parking settlement blocked";
        record.why = reason;
        record.stopBlocked = true;
        persistRoster();
        return { ok: false, code: "PARKING_PREPARE_FAILED", message: reason };
      }
    })();
    record.prepareParkingPromise = pending;
    try { return await pending; } finally { record.prepareParkingPromise = null; }
  }

  async function parkOperationMember(botID, accountID, operationID, policy, cause = "manual") {
    const record = operationRecord(botID, accountID, operationID);
    if (!record) return { ok: false, code: "PARKING_MEMBER_UNAVAILABLE", message: "Operation does not own this live pilot." };
    if (record.parkingPromise) return record.parkingPromise;
    if (record.parking?.state !== "READY") return { ok: false, code: "PARKING_NOT_SETTLED", message: "Settle this member before parking." };
    const pending = (async () => {
      try {
        record.parking = { state: "PARKING", reason: null };
        persistRoster();
        await record.flow.parkCustomBot(policy, Math.min(Date.parse(record.expiresAt) + DEADLINE_DOCK_GRACE_MS, now() + DEADLINE_DOCK_GRACE_MS));
        record.parking = { state: "PARKED", reason: null };
        persistRoster();
        // The existing graceful Stop remains the sole release authority.
        const result = await requestGracefulStop(record, cause === "deadline");
        return cause !== "deadline" || result.ok && record.parking?.state === "PARKED" ? result : {
          ok: false, code: "PARKING_FAILED", message: record.parking?.reason || result.message || "Deadline docking was not confirmed." };
      } catch (error) {
        const reason = error?.message || "Parking could not be confirmed.";
        record.status = "paused";
        record.phase = "Parking failed";
        record.why = reason;
        record.parking = { state: "PARKING_FAILED", reason };
        record.stopBlocked = true;
        persistRoster();
        return { ok: false, code: "PARKING_FAILED", message: reason };
      }
    })();
    record.parkingPromise = pending;
    try { return await pending; } finally { record.parkingPromise = null; }
  }

  async function endOperationDeadline(botID, accountID, operationID) {
    const record = operationRecord(botID, accountID, operationID);
    if (!record) return { ok: false, code: "PARKING_MEMBER_UNAVAILABLE", message: "Operation does not own this live pilot." };
    if (record.parking?.state !== "READY") return { ok: false, code: "PARKING_NOT_SETTLED", message: "Settle this member before deadline docking." };
    record.parking = { state: "PARKING", reason: null };
    const result = await requestGracefulStop(record, true);
    return result.ok && record.parking?.state === "PARKED" ? result : { ok: false,
      code: "PARKING_FAILED", message: record.parking?.reason || result.message || "Deadline docking was not confirmed." };
  }

  async function extendOperationGrant() {
    return { ok: false, code: "OPERATION_GRANT_EXTENSION_UNAVAILABLE",
      message: "This hosted credential cannot be extended in place. Start a newly approved run after safely stopping this one." };
  }

  function listAll() {
    return [...records.values()].map(publicBot);
  }

  function operationForClaim(characterID, secret) {
    if (!authorizesClaim(characterID, secret)) return null;
    const record = records.get(claims.get(Number(characterID)));
    return record?.operationID ? { operationID: record.operationID, operationRole: record.operationRole,
      operationRunID: record.operationRunID } : null;
  }

  function preparationForClaim(characterID, secret) {
    if (!authorizesClaim(characterID, secret)) return null;
    const record = records.get(claims.get(Number(characterID)));
    if (!record?.operationPreparation || !(record.resumedAt || record.recovering)) return null;
    preparationOwner(record, secret);
    const checkpoint = record.preparationCheckpoint?.snapshot();
    if (!checkpoint || checkpoint.mainEntered !== false || checkpoint.operationID !== record.operationID ||
        checkpoint.operationRunID !== record.operationRunID ||
        JSON.stringify(checkpoint.intent) !== JSON.stringify(record.operationPreparation)) return null;
    return checkpoint;
  }

  function jettisonOwnerForClaim(characterID, secret) {
    if (!authorizesClaim(characterID, secret)) return null;
    const record = records.get(claims.get(Number(characterID)));
    if (!record?.hostedOreJettisonRecovery || record.operationRole !== "MINER") return null;
    const current = productive => {
      if (record.finalized || claims.get(record.characterID) !== record.botID ||
          !sameSecret(record.claimSecret, secret) || Date.parse(record.expiresAt) <= now() ||
          productive && (record.recovering || record.windingDown || record.operationStopRequested || record.manualStopRequested))
        throw Object.assign(new Error("Hosted jettison generation or grant changed."), { code: "JETTISON_SCOPE_CHANGED" });
    };
    return {
      scope: { botID: record.botID, runGeneration: record.hostStartedAt || record.startedAt,
        pilotID: record.characterID, operationID: record.operationID },
      current,
      read: () => jettison.copy(record.jettisonCustody),
      begin: value => {
        current(true);
        const previous = record.jettisonCustody;
        if (previous?.state === "not-issued" || jettison.unresolved(previous) || previous && (previous.scope.runID !== value.scope.runID ||
            value.scope.invocationID <= previous.scope.invocationID))
          throw Object.assign(new Error("Prior jettison custody is still owned."), { code: "JETTISON_PENDING" });
        record.jettisonCustody = jettison.copy(value);
      },
      markIssued: value => {
        current(true);
        const previous = record.jettisonCustody;
        if (previous?.state !== "not-issued" || previous.scope.runID !== value.scope.runID || previous.scope.invocationID !== value.scope.invocationID)
          throw Object.assign(new Error("Jettison invocation changed before issue."), { code: "JETTISON_PENDING" });
        record.jettisonCustody = jettison.copy(value);
      },
      settle: value => {
        // A late reply can only add facts to its exact invocation. It cannot
        // replace a newer invocation, renew authority, or resume the runner.
        const previous = record.jettisonCustody;
        if (!record.finalized && previous?.scope.runID === value.scope.runID && previous.scope.invocationID === value.scope.invocationID) {
          if (previous.issuedAtMs !== null && (value.state === "not-issued" || value.state === "refused-before-dispatch")) return;
          if (["confirmed-created", "confirmed-no-ore-mutation"].includes(previous.state) && value.state === "issued-pending") return;
          record.jettisonCustody = jettison.copy(value);
          if (!jettison.unresolved(value)) record.jettisonWriteUnresolved = false;
        }
      },
    };
  }

  function list(accountID) {
    const rows = [];
    for (const record of records.values()) {
      if (record.accountID === Number(accountID)) {
        rows.push(publicBot(record));
      }
    }
    rows.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
    return rows;
  }

  /** The RUNNING bot claiming this character, or null — the select guard. */
  function claimedBy(characterID) {
    return claims.get(characterID) || null;
  }

  /** True only for the private capability carried by this run's loopback fetch. */
  function authorizesClaim(characterID, secret) {
    const botID = claims.get(Number(characterID));
    const record = botID ? records.get(botID) : null;
    return Boolean(record && !record.finalized && sameSecret(record.claimSecret, secret));
  }

  /**
   * The web session a RUNNING bot of THIS account holds for this character, or
   * null. A read-only route (the PI board's corp hangar read) looks the bot's
   * held game session up by it and makes one read on it, as the vitals sampler
   * does. Deliberately only an id: no flow and no store leave the host, so
   * nothing that asks can drive the bot, stop it or re-select its pilot.
   */
  function readableSessionOf(characterID, accountID) {
    const botID = claims.get(Number(characterID));
    const record = botID ? records.get(botID) : null;
    if (!record || record.finalized || record.accountID !== Number(accountID)) {
      return null;
    }
    return record.webSessionID;
  }

  /**
   * Character IDs a bot is flying RIGHT NOW. Served without auth (the login
   * and character screens mark bot-flown pilots before any sign-in exists), so
   * it is deliberately just the IDs — no names, scripts, or accounts.
   */
  function activeCharacterIDs() {
    return [...claims.keys()];
  }

  /**
   * The landing-page readout rows for every RUNNING bot: which character,
   * what the bot is doing, and the last vitals sample. Like
   * activeCharacterIDs this is served without auth, so it carries game state
   * only — no account names, script ids, or bot ids (nothing controllable).
   */
  function activeBots() {
    const rows = [];
    for (const record of records.values()) {
      if (!record.finalized) {
        rows.push({
          characterID: record.characterID,
          status: record.status,
          phase: record.phase,
          why: record.why,
          // The program step's own id ("fly-2"), so a board that started the
          // run can say how far along it is. Ids are the document's, not the
          // owner's, so nothing identifying rides on it.
          stepPath: record.stepPath,
          note: record.note,
          vitals: record.vitals,
        });
      }
    }
    return rows;
  }

  // ── Vitals sampling (the landing-page ship readout) ────────────────────────
  // Every VITALS_SAMPLE_MS each running bot answers "how is the ship?": flight
  // status (docked or not), the space snapshot's own-ship shield/armor/hull
  // (only meaningful in space), and the mining holds (cargo/ore fill). These
  // are the SAME store-backed reads an open tab polls; a failed sample keeps
  // the previous one (stale-but-honest beats blank).
  async function sampleBotVitals(record) {
    const flow = record.flow;
    const store = record.store;
    if (!flow || !store || record.finalized) {
      return;
    }
    try {
      await flow.loadFlightStatus();
      const flight = store.flight.get().status;
      const docked = flight === null ? null : flight.docked === true;
      if (docked === false) {
        await flow.loadSpaceSnapshot();
      }
      await flow.loadMiningHolds();
      const snapshot = docked === false ? store.space.get().snapshot : null;
      const ship = snapshot ? snapshot.ship : null;
      const holds = store.mining.get().holds || [];
      record.vitals = {
        sampledAt: nowISO(),
        docked,
        shield: ship ? ship.shieldRatio : null,
        armor: ship ? ship.armorRatio : null,
        hull: ship ? ship.hullRatio : null,
        holds: holds
          .filter((hold) => hold.present)
          .map((hold) => ({
            label: hold.label,
            used: hold.capacity ? hold.capacity.used : null,
            capacity: hold.capacity ? hold.capacity.capacity : null,
          })),
      };
    } catch {
      // Best-effort: the last sample stands until a read succeeds again.
    }
  }

  /** Sample every running bot now (the timer's tick; exposed for tests). */
  async function sampleAllVitals() {
    const running = [...records.values()].filter((record) => !record.finalized);
    await Promise.all(running.map((record) => sampleBotVitals(record)));
  }

  const vitalsTimer = setInterval(() => {
    void sampleAllVitals();
  }, options.vitalsIntervalMs || VITALS_SAMPLE_MS);
  if (typeof vitalsTimer.unref === "function") {
    vitalsTimer.unref(); // never the reason the process stays alive
  }

  // A bot that could not come back must SAY SO where the player looks, not
  // silently drop off the roster: a finished error record, subject to the
  // same ended-run ring as any other finalized record (evicted below).
  function recordResumeFailure(row, message) {
    const botID = crypto.randomUUID();
    const retainedPreparation = row.operationPreparation && typeof row.logicalRunID === "string"
      ? startupRuns.get(row.logicalRunID)?.preparation : null;
    records.set(botID, {
      botID,
      logicalRunID: row.logicalRunID || null,
      accountID: Number(row.accountID),
      username: String(row.username || ""),
      characterID: Number(row.characterID),
      characterName: null,
      kind: kindOf(row.kind),
      pluginID: typeof row.pluginID === "string" ? row.pluginID : null,
      pluginRun: typeof row.pluginRun === "string" ? row.pluginRun : null,
      scriptID: String(row.scriptID || ""),
      scriptName: String(row.scriptName || "Untitled bot"),
      scriptRev: Number(row.scriptRev || 0),
      scriptHash: String(row.scriptHash || ""),
      operationID: typeof row.operationID === "string" ? row.operationID : null,
      operationRole: row.operationRole ?? null,
      operationControllerAccountID: row.operationControllerAccountID ?? null,
      ...(retainedPreparation ? { operationRunID: retainedPreparation.operationRunID, operationPreparation: retainedPreparation.intent,
        preparation: { ...retainedPreparation, state: "RECOVERY_REQUIRED", reason: message }, deferMain: true } : {}),
      operationStopRequested: row.operationStopRequested === true,
      parking: row.operationStopRequested ? { state: "PARKING_FAILED", reason: "A restart interrupted operation parking." } : null,
      restartSafe: retainedPreparation ? row.restartSafe === true : false,
      riskClasses: Array.isArray(row.riskClasses) ? row.riskClasses.map(String) : [],
      maxRuntimeMinutes: Number(row.maxRuntimeMinutes || 0),
      expiresAt: typeof row.expiresAt === "string" ? row.expiresAt : null,
      resumedAt: null,
      vitals: null,
      status: retainedPreparation ? "paused" : "error",
      phase: retainedPreparation ? "Operation recovery required" : null,
      why: `This bot was running when the server restarted and could not be restarted: ${message}`,
      stepPath: null,
      pauseReason: null,
      note: null,
      startError: null,
      startedAt: String(row.startedAt || nowISO()),
      endedAt: retainedPreparation ? null : nowISO(),
      finalized: !retainedPreparation,
      flow: null,
      store: null,
      unsubscribe: null,
      claimSecret: null,
      deadlineTimer: null,
    });
    evictOldEndedRuns();
  }

  /**
   * Bring the persisted roster back after a restart. Call ONLY once the server
   * is listening — every bot drives it over loopback. Sequential on purpose
   * (like the tab's own pilot restore): the first select warms a cold gateway,
   * and one wedged character cannot wedge the file rewrite at the end.
   */
  async function resume() {
    const rows = readRoster();
    const restored = [];
    for (const savedRow of rows) {
      // A bot saved under a kind core no longer flies, that a plugin has taken over.
      const former = pluginProcess()?.formerBotKind?.(savedRow.kind) ?? null;
      const row = former === null ? savedRow : {
        ...savedRow,
        kind: "plugin",
        pluginID: former.pluginID,
        pluginRun: former.run,
        resumeData: { formerRow: savedRow },
      };
      const characterID = Number(row.characterID);
      const kind = kindOf(row.kind);
      try {
        const account = await loadAccount(String(row.username || ""));
        if (!account || account.banned) {
          recordResumeFailure(row, "the account is gone or banned.");
          continue;
        }
        // A kind only a plugin flew, and that plugin is off or did not load. Not a script that went missing.
        if (row.kind !== undefined && row.kind !== "script" && row.kind !== "plugin") {
          recordResumeFailure(row, "the plugin that flew it is not running. Start it again when it is.");
          continue;
        }
        let script = null;
        if (kind === "script") {
          script = loadScript(String(row.scriptID || ""), row);
          if (!script) {
            recordResumeFailure(row, "the saved bot no longer exists.");
            continue;
          }
        }
        // scriptHash is the canonical identity either way — a real script
        // hash for a script row, hashScript(request) for a plugin row
        // (see persistRoster's comment) — so this check is unchanged by kind.
        if (!Number.isSafeInteger(Number(row.scriptRev)) || !/^[a-f0-9]{64}$/.test(String(row.scriptHash || ""))) {
          recordResumeFailure(
            row,
            "its older restart record has no pinned script revision. Start it again manually.",
          );
          continue;
        }
        const preparationPending = row.operationPreparation && row.deferMain === true &&
          startupRuns.get(row.logicalRunID)?.preparation?.mainEntered === false;
        if (row.restartSafe !== true && !preparationPending) {
          recordResumeFailure(row, "it can repeat a consequential action. Review and start it again manually.");
          continue;
        }
        if (row.stopRequested === true || row.stopBlocked === true || row.operationStopRequested === true || row.recoveryBlocked === true) {
          recordResumeFailure(row, "a graceful Stop was blocked before restart. Review this pilot manually.");
          continue;
        }
        if (!Number.isFinite(Date.parse(String(row.expiresAt || ""))) || Date.parse(String(row.expiresAt)) <= now()) {
          recordResumeFailure(row, "its approved run time has ended. Start it again manually.");
          continue;
        }
        const grant = {
          // What was approved under the old kind has that kind's revision and hash. The plugin
          // reads the setup again in `start`, and what it risks must still be what was approved.
          scriptRev: former === null ? row.scriptRev : (await loadStack()).PLUGIN_RUN_GRANT_REV,
          riskClasses: Array.isArray(row.riskClasses) ? row.riskClasses : [],
          maxRuntimeMinutes: row.maxRuntimeMinutes,
        };
        const outcome =
          kind === "plugin"
            ? await start({
                account,
                characterID,
                kind: "plugin",
                pluginID: row.pluginID,
                pluginRun: row.pluginRun,
                request: row.request,
                resumeData: row.resumeData ?? null,
                grant,
                resumed: true,
                expectedScriptRev: former === null ? row.scriptRev : null,
                expectedScriptHash: former === null ? row.scriptHash : null,
                expectedExpiresAt: row.expiresAt,
              })
            : await start({
                account,
                characterID,
                kind: "script",
                scriptID: script.scriptID,
                scriptName: script.name,
                scriptRev: script.rev,
                doc: script.doc,
                grant,
                resumed: true,
                expectedScriptRev: row.scriptRev,
                expectedScriptHash: row.scriptHash,
                expectedExpiresAt: row.expiresAt,
                operationID: row.operationID ?? null,
                operationRole: row.operationRole ?? null,
                operationControllerAccountID: row.operationControllerAccountID ?? null,
                recoveryAttempts: row.recoveryAttempts || 0,
                logicalRunID: row.logicalRunID || null,
                operationRunID: row.operationRunID || null,
                operationPreparation: row.operationPreparation || null,
                preparation: row.preparation || null,
                deferMain: row.deferMain === true,
              });
        if (!outcome.ok) {
          recordResumeFailure(row, outcome.message || outcome.code);
        } else restored.push(outcome.bot.botID);
      } catch (error) {
        logError(error);
        recordResumeFailure(row, error && error.message ? String(error.message) : "an unexpected error.");
      }
    }
    // A failed attempt can leave a durable report beside its original roster
    // row. Retire only that unowned report after this exact run has an owner;
    // finalizing it would end the owner's shared checkpoint or release it.
    for (const botID of restored) {
      const owner = records.get(botID);
      if (!owner || owner.finalized || !owner.flow || !owner.operationPreparation ||
          claims.get(owner.characterID) !== botID) continue;
      for (const report of records.values()) {
        if (report === owner || report.finalized || report.flow || claims.get(report.characterID) === report.botID ||
            report.logicalRunID !== owner.logicalRunID || report.accountID !== owner.accountID ||
            report.characterID !== owner.characterID || report.operationID !== owner.operationID ||
            report.operationRunID !== owner.operationRunID) continue;
        report.finalized = true;
        report.endedAt = nowISO();
        report.status = "error";
        report.phase = "Superseded recovery report";
      }
    }
    // Rewrite the file to what actually came back, dropping the failures.
    persistRoster();
    if (typeof options.onOperationResume === "function") await options.onOperationResume();
  }

  /** Stop every running bot (server shutdown — best effort). */
  async function stopAll() {
    const running = [...records.values()].filter((record) => !record.finalized);
    await Promise.all(running.map((record) => finalize(record)));
  }

  return {
    // Account-owned passive diagnostics use the same reads as the hosted
    // runner. Neither its flow nor either session capability leaves the host.
    async readOwnedObservation(characterID, accountID) {
      const botID = claims.get(Number(characterID));
      const record = botID ? records.get(botID) : null;
      const flow = record?.flow, store = record?.store;
      const current = () => record && !record.finalized && record.accountID === Number(accountID)
        && claims.get(record.characterID) === botID && flow && store && record.flow === flow && record.store === store
        && store.station.get().online?.characterID === record.characterID;
      if (!current()) return null;
      // Like the vitals sampler, these reads update the normal observed state
      // and retain its ordinary session-loss handling. No separate driver.
      await flow.loadFleet();
      if (!current()) return null;
      await flow.loadSpaceSnapshot();
      if (!current()) return null;
      const space = store.space.get();
      return structuredClone({ characterID: record.characterID, readAtMs: Date.now(),
        space: space.error ? null : space.snapshot, spaceError: space.error ?? null,
        fleet: flow.readMiningSupportFleet(botID), supportWork: flow.readMiningSupportWork?.() ?? null,
        fleetWork: flow.readMiningSupportFleetDiagnostic?.() ?? null });
    },
    async readOperationFleets(operationID) {
      const result = [];
      for (const record of records.values()) {
        const flow = record.flow, secret = record.claimSecret;
        const current = () => record.operationID === operationID && !record.finalized && !record.recovering && !record.windingDown &&
          flow && record.flow === flow && record.claimSecret === secret && claims.get(record.characterID) === record.botID;
        if (!current()) continue;
        try {
          await flow.loadFleet();
          const observed = flow.readMiningSupportFleet(record.botID);
          if (current() && observed) result.push(observed);
        } catch { /* missing authority cannot prove fleet disappearance */ }
      }
      return result;
    },
    start,
    activateOperationMember,
    preparationForRun: logicalRunID => startupRuns.get(logicalRunID)?.preparation || null,
    reconnect(botID, accountID) {
      const record = records.get(botID);
      if (!record || record.finalized || record.accountID !== Number(accountID) || !record.recoveryEnabled || record.recovering ||
          record.recoveryAttempts >= 3 || record.windingDown || record.operationStopRequested || Date.parse(record.expiresAt) <= now())
        return { ok: false, code: "BOT_RECOVERY_UNAVAILABLE", message: "This account has no recoverable active operation run." };
      record.recoveryPromise = null;
      void record.recoverSession(true).catch(logError);
      return { ok: true, bot: publicBot(record) };
    },
    stop,
    extendOperationGrant,
    prepareOperationStop,
    parkOperationMember,
    endOperationDeadline,
    listAll,
    operationForClaim,
    preparationForClaim,
    jettisonOwnerForClaim,
    list,
    claimedBy,
    authorizesClaim,
    readableSessionOf,
    activeCharacterIDs,
    activeBots,
    sampleAllVitals,
    resume,
    stopAll,
    pluginRunEvents,
    BOT_HEADER,
  };
}

module.exports = { createBotHost, BOT_HEADER, MAX_ENDED_RUNS };
