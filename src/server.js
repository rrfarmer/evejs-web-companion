"use strict";

const express = require("express");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { randomUUID, createHash } = require("crypto");
const { spawn } = require("child_process");
const eveStore = require("./eveStore");
const eveGatewayClient = require("./eveGatewayClient");
const webAuth = require("./webAuth");
const staticDataModule = require("./staticData");
const { createClientWords } = require("./clientData/clientWords");
const { createClientTextures } = require("./clientData/clientTextures");
const { createMultibuyImport } = require("./clientData/importMultibuy");
const { createSkillplanImport } = require("./clientData/importSkillplan");
const { createClientBuiltData } = require("./clientData/clientBuiltData");
const { hullBrowserData } = require("./clientData/hullBrowser");
const { readFitting } = require("./clientData/importFitting");
const { createClientConstants } = require("./clientData/clientConstants");
const { createClientNotificationFormats } = require("./clientData/clientNotificationFormats");
const { STATION_CAPACITY, capacityAnswer, packagedVolume, shipHasHold, usedVolume } = require("./clientData/holdCapacity");
const { readMinerPilot } = require("./pilotTrainingRead");
const { createTrainingQueueService } = require("./pilotTrainingQueue");
const { createFactorySessions } = require("./factorySessions");
const { createReplenishment } = require("./replenishment");
const { createPilotMutationFence } = require("./pilotMutationFence");
const { createPilotTransport, isGamePortHandle, pilotTransportSetting } = require("./pilotTransport");
const { createGamePortPilots } = require("./gamePort/pilots");
const { retailForm } = require("./gamePort/retailCalls");
const { gameEndpoint } = require("./gamePort/tcp");
const { createPublicGateway, publicGatewayUrl } = require("./gamePort/publicGateway");
const { attachPilotSocket } = require("./pilotSocket");
const { createInProcessFetch, hostedBotReach } = require("./inProcessFetch");
const { registerProvisioningRoutes } = require("./provisioningRoutes");
const { createFactorySkills } = require("./factorySkills");
const { createTrainingOnboarding } = require("./trainingOnboarding");
const { readTrainingSettingsContext } = require("./trainingSettingsRead");
const { createTrainingAccounts } = require("./trainingAccounts");
const { createCharacterCreation } = require("./characterCreation");
const { createCreationAttemptJournal } = require("./creationAttemptJournal");
const config = require("./config");
const botScriptStoreModule = require("./botScriptStore");
const { lazyCompanionDb } = require("./companionDb");
const { createPiPlanStore } = require("./piPlanStore");
const { createPiExpansionStore } = require("./piExpansionStore");
const { createIndustryPlanStore } = require("./industryPlanStore");
const industryRecipes = require("./industryRecipes");
const botHostModule = require("./botHost");
const { createAccountCache } = require("./accountCache");
const { createBeltMemory } = require("./beltMemory");
const { createSquadBoard } = require("./squadBoard");
const { createMiningSupportAnchorBoard } = require("./miningSupportAnchorBoard");
const { registerMiningSupportAnchorRoutes } = require("./miningSupportAnchorRoutes");
const jettisonCustody = require("./jettisonCustody");
const { createJettisonCustodyHandler } = require("./jettisonCustodyRoutes");
const { createLootMemory, CONTAINER_LEASE_MS } = require("./lootMemory");
const { createMiningTargetBoard } = require("./miningTargetBoard");
const { createMiningOperationStore } = require("./miningOperationStore");
const { standardProfileFor, buildStandardProfile, familyCapabilities } = require("./miningOperationProfiles");
const { miningResourceFamily } = require("./miningResourceFamily");
const { validateResourcePolicy } = require("./miningResourcePolicy");
const { extendMiningOperation } = require("./miningOperationGrant");
const { normalizePolicies } = require("./miningOperationPolicies");
const { createMiningOperationStopper } = require("./miningOperationStop");
const { createMiningOperations, auditMiningScript, operationRoutineCompatibility, EXECUTABLE_TARGET_CLASSES } = require("./miningOperations");
const { reconnectCandidate, hasPendingRecovery, recoveryReadyProof, handoffFlightReady } = require("./droneRecoveryGate");
const { createBotLogStore } = require("./botLogStore");
// The game port, for the one write the web gateway does not carry: moving a
// colony's launchpad goods into its customs office (src/piCustomsExport.js).
const { GameClient } = require("./gameClient");
const { runCustomsExport, planCustomsExports } = require("./piCustomsExport");
const { colonyRowOf, planetIDsOf, resourceRecordOf } = require("./planetInfoColony");
const {
  isBridgeWritePair,
  isPageWritePair,
  gatewaysNameFor,
  objectOfPageCall,
  ordersAFollow,
  pageMayNameTheObject,
  pageNamesTheObject,
  pickSafeBrowserSessionFields,
  swapsThePilotsShip,
  swapTargetOf,
  placeChangeOf,
} = require("./bridgeCallPolicy");
const {
  adoptObservedShip,
  beginHeldTransition,
  cancelHeldTransition,
  markTransitionAccepted,
  markTransitionFailed,
  publicTransition,
  resolveFailedTransition,
  waitForTransitionReady,
} = require("./transitionBarrier");

// Map a bot-script store error (it carries a .code) to an HTTP status + envelope.
const BOTSCRIPT_STATUS = {
  BOTSCRIPT_INVALID: 400,
  BOTSCRIPT_TOO_BIG: 413,
  BOTSCRIPT_LIMIT_REACHED: 409,
  SCRIPT_REV_CONFLICT: 409,
  BOTSCRIPT_NOT_FOUND: 404,
  BOTCATEGORY_INVALID: 400,
  BOTCATEGORY_NAME_TAKEN: 409,
  BOTCATEGORY_LIMIT_REACHED: 409,
  BOTCATEGORY_NOT_FOUND: 404,
};
// The same for a saved PI plan (src/piPlanStore.js).
const PI_PLAN_STATUS = {
  PI_PLAN_INVALID: 400,
  PI_PLAN_LIMIT_REACHED: 409,
  PI_PLAN_REV_CONFLICT: 409,
  PI_PLAN_NOT_FOUND: 404,
};
// The same for a saved PI expansion plan (src/piExpansionStore.js).
const PI_EXPANSION_STATUS = {
  PI_EXPANSION_INVALID: 400,
  PI_EXPANSION_LIMIT_REACHED: 409,
  PI_EXPANSION_REV_CONFLICT: 409,
  PI_EXPANSION_NOT_FOUND: 404,
};
// The same for a saved Industry Manager plan (src/industryPlanStore.js).
const INDUSTRY_PLAN_STATUS = {
  INDUSTRY_PLAN_INVALID: 400,
  INDUSTRY_PLAN_LIMIT_REACHED: 409,
  INDUSTRY_PLAN_REV_CONFLICT: 409,
  INDUSTRY_PLAN_NOT_FOUND: 404,
};
function sendIndustryPlanError(res, error, next) {
  const status = error && INDUSTRY_PLAN_STATUS[error.code];
  if (status) {
    res.status(status).json({ ok: false, error: error.code, message: error.message });
    return;
  }
  next(error);
}
function sendPiExpansionError(res, error, next) {
  const status = error && PI_EXPANSION_STATUS[error.code];
  if (status) {
    res.status(status).json({ ok: false, error: error.code, message: error.message });
    return;
  }
  next(error);
}
function sendPiPlanError(res, error, next) {
  const status = error && PI_PLAN_STATUS[error.code];
  if (status) {
    res.status(status).json({ ok: false, error: error.code, message: error.message });
    return;
  }
  next(error);
}

function sendBotScriptError(res, error, next) {
  const status = error && BOTSCRIPT_STATUS[error.code];
  if (status) {
    res.status(status).json({ ok: false, error: error.code, message: error.message });
    return;
  }
  next(error);
}

function createApp(options = {}) {
const app = express();
const store = options.eveStore || eveStore;
let replenishment;
const mutationFence = createPilotMutationFence({ heldSessions: { values: () => bridgeSessions.values() },
  assertWritable: (pilot, lease) => replenishment?.assertWritable(pilot, lease),
  enterWrite: (pilot, lease) => replenishment.enterWrite(pilot, lease) });
// A selected pilot is reached through this, on whichever transport holds its
// session (src/pilotTransport.js). With no game-port transport it is the
// gateway client itself.
//
// The game-port transport exists unless EVEJS_PILOT_TRANSPORT and its
// overrides send everybody to the gateway (the game port is the default), and
// never for an app built around an injected gateway client: a test gets one
// only by handing one in. A value there that is not a transport stops the
// server starting.
const accountGateway = options.eveGatewayClient || eveGatewayClient;
// What this BFF asks the web gateway is tallied in the gateway client itself (src/gatewayLedger.js): the
// measure of the plan's cutover. A test's stand-in for the gateway is not the gateway, and has no tally.
const gatewayLedger = options.eveGatewayClient ? null : eveGatewayClient.gatewayLedger;
app.locals.gatewayLedger = gatewayLedger;
const pilotSetting = options.pilotTransportFor ? null : pilotTransportSetting(options.env || process.env);
const someoneOnGamePort = pilotSetting !== null &&
  (pilotSetting.fallback === "gameport" || [...pilotSetting.overrides.values()].includes("gameport"));
const gamePortPilots = options.gamePortPilots !== undefined
  ? options.gamePortPilots
  : someoneOnGamePort && !options.eveGatewayClient
    ? createGamePortPilots({
      // "Released" is said once the server itself has the character offline.
      isOnline: async (accountID, characterID) => (await accountGateway.getCharacterStatus(accountID, characterID))?.online,
      // Each pilot's public gateway notices, on the connection its gateway requests go on (gamePort/publicGateway.js).
      gatewayNotices: (pilot, onNotice) => sharedPublicGateway().consume(pilot, onNotice),
      // A pilot's ballpark runs in its own time; nobody is waiting on it to hear that something went wrong.
      onSpaceError: (error, what, characterID) => console.warn(`[game-port] pilot ${characterID}: ballpark ${what} failed: ${error && error.message}`),
      // The client's travel effects, from its own data (clientBuiltData, made below; asked for once a pilot is in space).
      travelEffects: async () => {
        const table = await clientBuiltData.table("travelEffects");
        return table ? new Set(Object.keys(table)) : null;
      },
      // The server asked the client something. Say what, and what it was told.
      onClientCall: (call, characterID) => {
        const asked = `[game-port] pilot ${characterID}: the server called ${call.service}.${call.method} on the client`;
        if (call.answered) console.log(`${asked}, and was answered ${JSON.stringify(call.answer)}`);
        else console.warn(`${asked}, which ${call.error ? `failed: ${call.error.message}` : "this client does not answer"}`);
      },
    })
    : null;
app.locals.gamePortPilots = gamePortPilots;
// What a socket's hello is checked by (src/pilotSocket.js): whether a token is a web session's. Each operation
// carried on the socket is then authenticated by its own route, as over HTTP.
app.locals.verifySessionToken = (token) => (options.webAuth || webAuth).verifySessionToken(token);
const gateway = mutationFence.wrap(createPilotTransport({
  gateway: accountGateway,
  gamePort: gamePortPilots,
  transportFor: options.pilotTransportFor || (pilotSetting ? (who) => pilotSetting.transportFor(who) : undefined),
}));
const auth = options.webAuth || webAuth;
const staticData = options.staticData || staticDataModule;
// The retail client's own text for the labels the server sends, read from the
// player's installed client when there is one (src/clientData/clientWords.js).
const clientWords = options.clientWords || createClientWords({
  clientRoot: config.clientRoot,
  onError: (error) => console.warn(`[client-words] the client's localisation could not be read: ${error && error.message}`),
});
// The retail client's built data, read by the client's own loaders from the
// same install (src/clientData/clientBuiltData.js).
const clientBuiltData = options.clientBuiltData || createClientBuiltData({
  clientRoot: config.clientRoot,
  python: config.clientPython,
  onError: (error) => console.warn(`[client-data] a table of the client's built data could not be read: ${error && error.message}`),
});
// The retail client's own constants, read by running its code from the same
// install (src/clientData/clientConstants.js).
const clientConstants = options.clientConstants || createClientConstants({
  clientRoot: config.clientRoot,
  python: config.clientPython,
  onError: (error) => console.warn(`[client-data] the client's constants could not be read: ${error && error.message}`),
});
// How the retail client words each kind of notification, read by running its
// code from the same install (src/clientData/clientNotificationFormats.js).
const clientNotificationFormats = options.clientNotificationFormats || createClientNotificationFormats({
  clientRoot: config.clientRoot,
  python: config.clientPython,
  onError: (error) => console.warn(`[client-data] the client's notification formats could not be read: ${error && error.message}`),
});
// The retail client's own pictures, by their res: path, from the same install
// (src/clientData/clientTextures.js).
const clientTextures = options.clientTextures || createClientTextures({ clientRoot: config.clientRoot });
// The game-port client the customs-export hop speaks. Injected so the route
// is exercised in tests without a socket, exactly as the gateway client is.
const gameClientFactory = options.gameClientFactory || ((endpoint) => new GameClient(endpoint));
// Injected EveJS stores (unit fixtures) stay in-memory unless a test supplies
// an explicit journal. Normal WC keeps the fence across process restarts.
const creationAttempts = options.creationAttemptJournal || createCreationAttemptJournal({
  filePath: options.eveStore ? null : path.join(config.dataDir, "pilot-training-creation-attempts.json"),
});
const trainingQueues = createTrainingQueueService({ store, gateway, data: staticData });
const trainingAccounts = createTrainingAccounts({ store, journal: creationAttempts });
const characterCreation = createCharacterCreation({ call: (...args) => accountLevelCall(...args), attempts: creationAttempts });
// The player Bot Builder library — web-app data in data/bot-scripts.json, keyed
// PLATFORM-WIDE (every account sees every saved bot). Never eve.js's store; this
// is our own JSON file.
const botScripts =
  options.botScriptStore || botScriptStoreModule.createBotScriptStore({ dataDir: config.dataDir });
// Saved PI plans, in the companion's own data/companion.sqlite (src/companionDb.js),
// opened on the first request that needs it -- never eve.js's gamestore.
const piPlans =
  options.piPlanStore || createPiPlanStore({ db: lazyCompanionDb({ dataDir: config.dataDir }) });
// Saved PI expansion plans: where to look and the colonies the player accepted.
const piExpansions =
  options.piExpansionStore || createPiExpansionStore({ db: lazyCompanionDb({ dataDir: config.dataDir }) });
// Saved Industry Manager plans (R109), in the same file. A second lazy handle
// is a second connection to it, which WAL and the busy timeout are there for.
const industryPlans =
  options.industryPlanStore || createIndustryPlanStore({ db: lazyCompanionDb({ dataDir: config.dataDir }) });
// Persistent-session handles (goal R2): webSessionID -> the opaque
// bridgeSessionID the gateway minted, held server-side only. The browser
// never sees the handle; it just gets its character/station state back.
const bridgeSessions = options.bridgeSessionStore || new Map();
// The tally says of a read of one character whether that character was online here then: a read the plan
// keeps on the gateway for pilots who are offline is another matter when the pilot is online.
gatewayLedger?.watch({ isOnline: (characterID) => [...bridgeSessions.values()].some((held) => Number(held && held.characterID) === characterID) });
// Short-lived operation reservations, not a second owner registry. They close
// the await gap between browser select/release and a hosted handoff.
const characterOperations = new Map();
const sessionOperations = new Map();
replenishment = options.replenishment || createReplenishment({ operations: characterOperations, data: staticData,
  filePath: options.replenishmentJournalPath || (options.eveStore ? null : path.join(config.dataDir, "replenishment-custody.json")) });
/**
 * Web sessions whose pilot is on the GAME PORT for a moment (the customs-office
 * export hop), by expiry instant.
 *
 * ⚠ PAUSED IS NOT GONE, AND THE DIFFERENCE IS THE WHOLE POINT. A character may
 * be in game on one session, so the hop logs the tab's session out and selects
 * it straight back. A read landing in that window would otherwise answer
 * NO_LIVE_SESSION or SESSION_NOT_FOUND - both of which the browser reads as
 * "this pilot is lost" and PRUNES the cockpit (web/src/app/flow.ts,
 * isSessionLost). So reads are answered 409 CHARACTER_IN_USE instead, which is
 * an ordinary transient failure the tab retries through, and the pilot is still
 * there when the hop hands it back. The expiry is a backstop only: the route
 * clears its own entry in a finally.
 */
const gamePortHolds = new Map();
const GAME_PORT_HOLD_MS = 120_000;

/** Is this web session's pilot on the game port right now? */
function heldOnGamePort(webSessionID) {
  const until = gamePortHolds.get(webSessionID);
  if (until === undefined) {
    return false;
  }
  if (until <= Date.now() && !sessionOperations.has(webSessionID)) {
    gamePortHolds.delete(webSessionID);
    return false;
  }
  return true;
}
async function isCharacterHeld(characterID, callerSessionID = null, preparationOwner = null, probeReservation = null) {
  const reservation = characterOperations.get(characterID);
  // Only the exact private operation reservation can probe its own hold.
  // Both maps must still contain it; a name or stale token grants no exception.
  const ownsProbeNow = () => probeReservation !== null && characterOperations.get(characterID) === probeReservation &&
    sessionOperations.get(callerSessionID) === probeReservation;
  const ownsProbe = ownsProbeNow();
  if (probeReservation !== null && !ownsProbe) return true;
  const handoff = reservation?.kind === "mining-operation-handoff" &&
    reservation.operationRunID === preparationOwner?.operationRunID &&
    reservation.operationID === preparationOwner?.operationPreparation?.operationID;
  if (reservation && !ownsProbe && !handoff) return true;
  if (replenishment.unresolved(characterID).length) {
    const checkpoint = preparationOwner?.resumed && botHost.preparationForRun?.(preparationOwner.logicalRunID);
    const custodyID = checkpoint?.custodyOperationID || checkpoint?.evidence?.custodyOperationID;
    const pending = replenishment.unresolved(characterID);
    if (!checkpoint || checkpoint.mainEntered || checkpoint.operationRunID !== preparationOwner.operationRunID ||
        JSON.stringify(checkpoint.intent) !== JSON.stringify(preparationOwner.operationPreparation) ||
        pending.some(row=>row.key!==custodyID || row.accountID!==checkpoint.intent.accountID)) return true;
    // Custody is observation/reconciliation permission only. A restart may
    // re-establish the same run only after runtime positively proves offline.
    const status = await gateway.getCharacterStatus(checkpoint.intent.accountID,characterID);
    if (status?.characterID!==characterID || status.online!==false || status.controlState!=="offline") return true;
  }
  for (const [sessionID, held] of bridgeSessions) {
    if (sessionID === callerSessionID || Number(held.characterID) !== Number(characterID)) continue;
    try {
      await gateway.readFlightStatus(held.bridgeSessionID, { userid: held.accountID });
      return true;
    } catch (error) {
      if (!error || error.code !== "SESSION_NOT_FOUND") throw error;
      if (bridgeSessions.get(sessionID) === held) forgetBridgeSession(sessionID);
    }
  }
  // A public hosted Start may hand off its own cockpit, but may never take an
  // external retail/browser/Factory pilot observed here. A later external
  // login is arbitrated by stock SelectCharacterID and the server's retail
  // takeover policy; this WC observation is not an atomic free-only claim.
  if (ownsProbe && preparationOwner?.accountID && Number(bridgeSessions.get(callerSessionID)?.characterID) !== Number(characterID)) {
    const status = await gateway.getCharacterStatus(preparationOwner.accountID, characterID);
    if (status?.characterID !== characterID || status.online !== false || status.controlState !== "offline") return true;
  }
  return probeReservation !== null && !ownsProbeNow();
}
// Short-lived cache for the auth path's account lookup (src/accountCache.js).
// Without it, every authenticated request costs a second owner call re-reading
// an unchanged account — half of all measured gateway traffic.
const accountCache = options.accountCache || createAccountCache();
const errorLogger = options.errorLogger || ((error) => console.error(error));
// Server-side bot host (see src/botHost.js): runs the browser bot stack in
// THIS process, driving the routes below as just another session, so a bot
// outlives the tab (or phone) that started it. Its requests are run through
// this app where it is, with no connection made (src/inProcessFetch.js; the
// plan's Phase 6a); EVEJS_HOSTED_BOT_REACH=loopback has them made over loopback
// HTTP to `baseUrl` as they were.
const botHostBaseUrl = options.botHostBaseUrl || `http://127.0.0.1:${config.port}`;
const botHost =
  options.botHost ||
  botHostModule.createBotHost({
    webAuth: auth,
    baseUrl: botHostBaseUrl,
    fetch: options.botHostFetch || (hostedBotReach(process.env) === "loopback" ? undefined : createInProcessFetch(app, { baseUrl: botHostBaseUrl })),
    // Durable roster: running bots are mirrored here and startServer calls
    // botHost.resume() once listening, so a BFF restart brings them back.
    persistPath: path.join(config.dataDir, "server-bots.json"),
    loadAccount: (username) => store.getAccount(username),
    loadScript: (scriptID, row) => {
      if (!scriptID.startsWith("mcc.")) return botScripts.get(scriptID);
      const definition = miningOperationStore.get(row?.operationID);
      const member = definition?.members.find(candidate => candidate.characterID === Number(row?.characterID));
      const profile = member && buildStandardProfile(definition, member);
      return profile?.scriptID === scriptID ? profile : null;
    },
    // ONE HULL, ONE DRIVER, direction 1: a bot may not take a character any
    // live web session is flying. (Direction 2 — a tab may not take a bot's
    // character — is the guard in /api/bridge/select.)
    isCharacterHeld,
    // What the game server closed a pilot's connection with, where it said (another login of its account): such a
    // pilot is not logged in again by a run's recovery (gamePort/pilots.js closedByServer).
    closedByServer: (characterID) =>
      gamePortPilots && typeof gamePortPilots.closedByServer === "function" ? gamePortPilots.closedByServer(characterID) : null,
    disconnectOwnedSession: async ({ webSessionID, characterID, accountID, claimSecret, previousSecret }) => {
      const held = bridgeSessions.get(webSessionID);
      if (!held || held.characterID !== characterID || Number(held.accountID) !== accountID ||
          held.botClaimSecret !== previousSecret || !botHost.authorizesClaim(characterID, claimSecret) ||
          sessionOperations.has(webSessionID) || characterOperations.has(characterID))
        throw new Error("The host does not own this current pilot session for reconnect.");
      const reservation = Symbol("hosted-reconnect");
      sessionOperations.set(webSessionID, reservation); characterOperations.set(characterID, reservation);
      try {
        await releaseHeldBridgeSession(webSessionID, { confirmed: true });
        if (bridgeSessions.has(webSessionID)) throw new Error("The released hosted session was replaced; reconnect is paused.");
      } finally {
        if (sessionOperations.get(webSessionID) === reservation) sessionOperations.delete(webSessionID);
        if (characterOperations.get(characterID) === reservation) characterOperations.delete(characterID);
      }
    },
    errorLogger,
    prepareOperation: record => {
      const reservation = characterOperations.get(record.characterID);
      if (reservation?.kind === "mining-operation-handoff" && reservation.operationID===record.operationID &&
          reservation.operationRunID===record.operationRunID && botHost.authorizesClaim(record.characterID,record.claimSecret))
        characterOperations.delete(record.characterID);
      return miningPreparation.prepare(record);
    },
    preparationUnresolved: record => miningPreparation.unresolved(record),
    operationBarrierReady: record => operationPreparationBarrier(record.operationID,record.operationRunID),
    onOperationResume: async () => {
      miningOperations.reconcileBots(botHost.listAll());
      for (const definition of miningOperationStore.list()) {
        const runtime = miningOperations.runtimeFor(definition.operationID);
        if (runtime?.operationRunID) await activatePreparedOperation(definition,runtime.operationRunID);
      }
    },
    onOperationDeadline: operationID => {
      const definition = miningOperations.definition(operationID);
      if (!definition) throw new Error("The expiring operation definition is unavailable.");
      const policies = normalizePolicies(definition.policies, staticData.getStation, staticData.getSolarSystem);
      return miningOperationStopper.stop({ ...definition, policies }, { cause: "deadline" });
    },
  });
app.locals.botHost = botHost;
app.locals.bridgeSessions = bridgeSessions;
app.locals.replenishment = replenishment;
const factorySessions = createFactorySessions({ store, gateway, operations: characterOperations, heldSessions: bridgeSessions, botHost,
  withLease: mutationFence.withLease });
const factorySkills = createFactorySkills({ store, gateway, data: staticData, queues: trainingQueues, sessions: factorySessions });
const trainingOnboarding = createTrainingOnboarding({ store, gateway, sessions: factorySessions });
// startServer() seeds the starter bots once the port is open, and all it
// holds is the app -- never createApp's locals. Published here so that call
// reaches THIS app's store, including one injected by a test.
app.locals.botScripts = botScripts;
// Shared, in-process (never persisted — see src/beltMemory.js) memory of belts
// mining bots have found dry, keyed by solar-system NAME then belt NAME. Every
// account's bots share the one instance; a restart forgets it, which is fine —
// belts repopulate and entries expire on their own.
const beltMemory = options.beltMemory || createBeltMemory();
app.locals.beltMemory = beltMemory;
const miningTargetBoard = options.miningTargetBoard || createMiningTargetBoard();
const miningOperationStore = options.miningOperationStore || createMiningOperationStore({
  dataDir: config.dataDir,
  resolveSystem: id => staticData.getSolarSystem(id),
  resolveStation: id => staticData.getStation(id),
});
const miningOperations = options.miningOperations || createMiningOperations({
  store: miningOperationStore, targetBoard: miningTargetBoard, beltMemory,
});
app.locals.miningTargetBoard = miningTargetBoard;
app.locals.miningOperations = miningOperations;
// Shared, in-process (never persisted — see src/squadBoard.js) call board: one
// standing primary per FLEET, so pilots on one grid concentrate their fire
// instead of each shooting whatever it ranked first for itself. Keyed by the
// fleet id the BFF resolved from that fleet's own read, never by anything the
// browser supplies.
const squadBoard = options.squadBoard || createSquadBoard();
app.locals.squadBoard = squadBoard;
const miningSupportAnchorBoard = options.miningSupportAnchorBoard || createMiningSupportAnchorBoard();
// Shared, in-process (never persisted — see src/lootMemory.js) memory of the
// wrecks and cans somebody has already emptied, keyed by solar-system id. A
// wreck's contents cannot be read from further than 2,500 m and the one field
// that says "this is empty" never reaches a web session, so the FIRST pilot to
// fly to a wreck is the only one who can answer the question — this is where it
// answers it for everybody else.
const lootMemory = options.lootMemory || createLootMemory();
app.locals.lootMemory = lootMemory;
// The bot flight recorder's files (src/botLogStore.js): one log per character,
// rotated when a run starts, so the current run and the one before it are
// always readable. Under the web data dir — an operator artifact, never served
// into the game UI and never committed.
const botLogStore =
  options.botLogStore || createBotLogStore({ dir: path.join(config.dataDir, "bot-logs") });
app.locals.botLogStore = botLogStore;
fs.mkdirSync(config.iconCacheDir, { recursive: true });

app.disable("x-powered-by");
app.use(express.json({ limit: "64kb" }));
app.use((req, res, next) => {
  if (req.path.startsWith("/api/")) {
    res.setHeader("Cache-Control", "no-store");
  }
  next();
});

function parseCookies(header) {
  const cookies = {};
  for (const part of String(header || "").split(";")) {
    const index = part.indexOf("=");
    if (index < 0) {
      continue;
    }
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) {
      cookies[key] = decodeURIComponent(value);
    }
  }
  return cookies;
}

// --- R42: the login token rides TWO carriers, so tabs stop colliding --------
//
// The signed login token used to have exactly one carrier: the httpOnly cookie
// below, scoped to path "/". A cookie belongs to the BROWSER PROFILE, not to
// the tab, so a second tab logging in as another account OVERWROTE the first
// tab's session and every open tab collapsed onto whichever account signed in
// last. The operator wants ten tabs running ten accounts, so the token now
// also rides `Authorization: Bearer <token>`, fed from the tab's own
// `sessionStorage` — which is per-tab by specification. Same token, same
// `webAuth.verifySessionToken`, same `req.webSessionID`: this changes the
// CARRIER, not the authentication. The cookie stays for the migration window
// so nothing that already works breaks.
//
// SECURITY TRADE — DELIBERATE, AND LOCAL TO THIS POC. A token the page's own
// JavaScript can read is a token an XSS bug can steal; `httpOnly` existed to
// prevent precisely that, and we are giving it up. That is acceptable HERE and
// only here: this BFF is a companion to a LOCAL DEV EMULATOR whose login
// accepts ANY password for ANY existing username (see /api/login below, goal
// R1) — there is no secret left for httpOnly to protect. DO NOT COPY THIS
// PATTERN into anything reachable from a network. If this app ever grows real
// credentials, per-tab identity has to be solved some other way (a per-tab
// path-scoped cookie, or a session id in the URL path) and the token must go
// back to being httpOnly.
function setSessionCookie(res, token) {
  res.cookie(config.sessionCookieName, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: false,
    maxAge: config.sessionTtlMs,
    path: "/",
  });
}

function clearSessionCookie(res) {
  res.clearCookie(config.sessionCookieName, {
    httpOnly: true,
    sameSite: "lax",
    secure: false,
    path: "/",
  });
}

function publicAccount(account) {
  return {
    username: account.username,
    accountID: account.accountID,
    role: account.role,
    banned: account.banned,
  };
}

// The query-string name the SSE stream carries its token under. See
// requireStreamAuth below for why the stream needs one and every other route
// refuses it.
const SESSION_QUERY_PARAM = "access_token";

function readBearerToken(authorizationHeader) {
  const match = /^Bearer +(\S.*)$/i.exec(String(authorizationHeader || "").trim());
  return match ? match[1].trim() : "";
}

// The one place that decides which carrier a request's session token came from.
// Header first: when a tab has its own token in sessionStorage that is the
// deliberate identity, and the shared cookie left over from another tab's login
// must not be able to override it.
function readSessionToken(req, { allowQueryParam = false } = {}) {
  const fromHeader = readBearerToken(req.headers.authorization);
  if (fromHeader) {
    return fromHeader;
  }
  if (allowQueryParam) {
    const fromQuery = req.query ? req.query[SESSION_QUERY_PARAM] : undefined;
    if (typeof fromQuery === "string" && fromQuery) {
      return fromQuery;
    }
  }
  const cookies = parseCookies(req.headers.cookie);
  return cookies[config.sessionCookieName] || "";
}

// One implementation, two doors — `requireAuth` for everything, and the
// query-tolerant variant the SSE route needs. The auth itself is identical;
// only the accepted carrier set differs.
function makeRequireAuth({ allowQueryParam = false, cleanupSession = true } = {}) {
  return async function requireAuthenticatedSession(req, res, next) {
    const payload = auth.verifySessionToken(readSessionToken(req, { allowQueryParam }));
    if (!payload) {
      res.status(401).json({ ok: false, error: "AUTH_REQUIRED" });
      return;
    }

    try {
      // Cached for a few seconds (src/accountCache.js). This lookup used to be
      // a gateway round trip on EVERY authenticated request — 51% of all owner
      // calls on a measured two-client run — re-reading a value that had not
      // changed. Every check below still runs on the resolved account.
      const account = await accountCache.resolve(
        payload.username,
        () => store.getAccount(payload.username),
      );
      if (!account || account.accountID !== Number(payload.accountID)) {
        if (cleanupSession) clearSessionCookie(res);
        res.status(401).json({ ok: false, error: "ACCOUNT_NOT_FOUND" });
        return;
      }
      if (account.banned) {
        if (cleanupSession) clearSessionCookie(res);
        res.status(403).json({ ok: false, error: "ACCOUNT_BANNED" });
        return;
      }
      req.account = account;
      req.webSessionID = payload.sessionID;
      const held = bridgeSessions.get(req.webSessionID);
      if (held && req.path.startsWith("/api/bridge/")) assertHeldRequestGeneration(req, held);
      next();
    } catch (error) {
      next(error);
    }
  };
}

// Every route. Header or cookie only — a token in the query string is REFUSED
// here, deliberately; see requireStreamAuth.
const requireAuth = makeRequireAuth();
// The standalone training control plane never clears cockpit ownership as a
// side effect of an account-read failure.
const requireTrainingAuth = makeRequireAuth({ cleanupSession: false });

// The SSE push channel alone. `EventSource` cannot set request headers — the
// API has no hook for it — so GET /api/bridge/events accepts the token as the
// `access_token` query parameter. That puts a credential in a URL, which is a
// real cost: URLs reach browser history, `Referer` headers, and any access log
// in front of the app. Two things contain it. First, this BFF writes no access
// log: nothing here logs `req.url`, and the error handler logs the Error alone,
// so the token is not recorded on this side — keep it that way if request
// logging is ever added, and redact this parameter if it is. Second, the query
// carrier is accepted by this route and no other, so a token that leaks through
// a URL can be used to WATCH a session's stream but never to drive it: every
// mutating route goes through `requireAuth`, which ignores the query string.
//
// A per-tab session whose push channel still rode the shared cookie would be
// half a feature — tab two would receive tab one's live events — so this is not
// optional decoration.
const requireStreamAuth = makeRequireAuth({ allowQueryParam: true });

// Dispatch gates below also protect requests that passed middleware before
// Apply acquired its reservation. No browser-supplied lease is accepted.
app.use("/api/bridge", (req, res, next) => {
  // EventSource carries its per-tab token in the URL. Preserve that carrier
  // through this shared gate; every other bridge route still requires normal auth.
  const authenticate = req.method === "GET" && /^\/events\/?$/i.test(req.path) ? requireStreamAuth : requireAuth;
  return authenticate(req, res, next);
}, (req, res, next) => {
  try {
    // An answer to the server's question is the rest of the write that caused the question, which is still in
    // flight and holding the pilot: it must get through, or that write can never finish.
    const answersAQuestion = /^\/questions\/[^/]+\/answer\/?$/.test(req.path);
    if (req.method === "POST" && !answersAQuestion && !["/call", "/provisioning/review", "/provisioning/ship-review", "/provisioning/provision-ship", "/provisioning/reconcile", "/drone-recovery/ready"].includes(req.path)) {
      const held = bridgeSessions.get(req.webSessionID);
      if (req.path === "/select") {
        const target = Number(req.body?.characterID);
        if (held && held.characterID !== target) replenishment.assertWritable(held.characterID);
        replenishment.assertSelectable(target);
      } else if (held) replenishment.assertWritable(held.characterID);
    }
    next();
  } catch (error) { next(error); }
});
app.get("/api/health", async (req, res) => {
  try {
    const storeStatus = await store.getStatus();
    res.json({
      ok: true,
      eveRoot: config.eveRoot,
      webUsersConfigured: auth.countConfiguredUsers(),
      gateway: storeStatus,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
      gatewayUrl: process.env.EVEJS_GATEWAY_URL || "http://127.0.0.1:26002/_evejs-web/v1",
    });
  }
});

// Who-cares web login (roadmap section 6, goals R1 + R2): an EveJS account
// username signs in with ANY password, including an empty one — the password
// is not checked at all — and an UNKNOWN username is auto-created through the
// gateway. Both halves deliberately mirror the emulator's retail-path
// dev flags (devSkipPasswordValidation + devAutoCreateAccounts): the web login
// behaves exactly like a retail client's first login against this dev server.
// The gateway owns the auto-create policy — when devAutoCreateAccounts is off
// it refuses with ACCOUNT_CREATE_DISABLED and unknown usernames keep their
// clear 401. The scrypt web-password store is BYPASSED, NOT DELETED:
// src/webAuth.js verifyWebPassword/upsertWebPassword, data/web-users.json, and
// `npm run webpass` stay in place (data-preservation rule) but are deprecated
// for login.
// Training account creation is explicit and never installs a cockpit cookie.
for (const action of ["create", "recover"]) {
  app.post(`/api/pilot-training/accounts/${action}`, async (req, res, next) => {
    try { res.json({ ok: true, ...await trainingAccounts[action](req.body || {}) }); }
    catch (error) { next(error); }
  });
}
app.post(["/api/login", "/api/goblin-factory/login", "/api/pilot-training/login", "/api/ship-provisioning/login"], async (req, res, next) => {
  // The standalone training door must never auto-create an unknown account or
  // replace the cookie belonging to an already-running cockpit.
  const factoryLogin = /^\/api\/(?:goblin-factory|pilot-training|ship-provisioning)\/login\/?$/i.test(req.path);
  const username = String(req.body && req.body.username || "").trim();
  try {
    // An empty username can never name or create an account; refuse it here
    // instead of round-tripping the gateway.
    if (!username) {
      res.status(401).json({
        ok: false,
        error: "UNKNOWN_EVEJS_ACCOUNT",
        message: "Unknown EveJS account.",
      });
      return;
    }
    let account = null;
    let accountCreated = false;
    try {
      account = await store.getAccount(username);
    } catch (error) {
      if (!(error && error.code === "ACCOUNT_NOT_FOUND")) {
        throw error;
      }
    }
    if (!account && !factoryLogin) {
      try {
        const outcome = await store.createAccount(username);
        account = outcome && outcome.account || null;
        accountCreated = Boolean(outcome && outcome.created);
      } catch (error) {
        if (error && error.code === "ACCOUNT_CREATE_DISABLED") {
          // Auto-create is off server-side: unknown usernames get the same
          // 401 they always got (the `if (!account)` below).
        } else if (error && error.code === "ACCOUNT_INVALID") {
          // The username failed the gateway's charset/length rules — that is
          // "fix your input", not "unknown account".
          res.status(400).json({
            ok: false,
            error: "ACCOUNT_INVALID",
            message: error.message || "Account username is invalid.",
          });
          return;
        } else {
          throw error;
        }
      }
    }
    if (!account) {
      res.status(401).json({
        ok: false,
        error: "UNKNOWN_EVEJS_ACCOUNT",
        message: "Unknown EveJS account.",
      });
      return;
    }
    if (account.banned) {
      res.status(403).json({ ok: false, error: "ACCOUNT_BANNED" });
      return;
    }

    // R42: one token, both carriers. The cookie keeps the pre-R42 client
    // working; `sessionToken` in the body is what the tab puts in its own
    // sessionStorage so ten tabs can hold ten different accounts. Read the
    // security note above setSessionCookie before copying this anywhere.
    const token = auth.createSessionToken(account);
    if (!factoryLogin) setSessionCookie(res, token);
    res.json({
      ok: true,
      sessionToken: token,
      account: publicAccount(account),
      // R2: true exactly when THIS login minted the account, so the UI can say
      // so (a fresh account also arrives with zero characters, which sends the
      // client straight into the create-character flow).
      accountCreated,
      characters: await store.listCharactersForAccount(account.accountID),
    });
  } catch (error) {
    next(error);
  }
});

// Logging out has to release the session the CALLING TAB holds, so it reads the
// same carriers as requireAuth: a tab signing out with its own Bearer token
// must not release whatever session the shared cookie happens to name.
app.post("/api/logout", async (req, res) => {
  // An expired but correctly signed credential can release only its OWN held
  // session. Normal reads/writes still require an unexpired credential.
  const payload = auth.verifySessionToken(readSessionToken(req), { allowExpired: true });
  if (!payload?.sessionID) {
    res.status(401).json({ ok: false, error: "INVALID_SESSION", message: "A signed session is required to confirm logout." });
    return;
  }
  if (payload?.sessionID && sessionOperations.has(payload.sessionID)) {
    res.status(409).json({ ok: false, error: "CHARACTER_IN_USE", message: "This pilot is changing sessions. Try again shortly." });
    return;
  }
  const held = payload && payload.sessionID ? bridgeSessions.get(payload.sessionID) : null;
  if (held) {
    try { replenishment.assertWritable(held.characterID); }
    catch (error) { res.status(409).json({ ok: false, error: error.code, message: error.message }); return; }
  }
  if (held && Number(held.accountID) !== Number(payload.accountID)) {
    res.status(409).json({ ok: false, error: "PILOT_RELEASE_UNVERIFIED", message: "The signed account does not own this pilot session." });
    return;
  }
  if (held && hasPendingRecovery(held, held.characterID)) {
    res.status(409).json({ ok: false, error: "DRONE_RECOVERY_PENDING",
      message: "Finish nearby drone recovery before logging out this pilot." });
    return;
  }
  if (held && Number(held.accountID) === Number(payload.accountID)) {
    // Even an expired caller may clean up its own signed session, but an
    // ambiguous gateway answer must retain the held owner for reconciliation.
    try {
      await releaseHeldBridgeSession(payload.sessionID, { confirmed: true });
    } catch (error) {
      res.status(409).json({ ok: false, error: "PILOT_RELEASE_UNVERIFIED", message: "The pilot session could not be confirmed released. Try again." });
      return;
    }
  }
  if (payload && payload.username) {
    // Drop the cached account rather than let a signed-out user's record sit
    // in the auth cache for the rest of its TTL.
    accountCache.invalidate(payload.username);
  }
  clearSessionCookie(res);
  res.json({ ok: true });
});

// The page makes its own writes by the generic call (the plan's Phase 6b), so that call is a read only where it
// names one. A gate that tells a write by its path takes the call's own name for it, as the call's handler does
// (bridgeCallPolicy.js). A body that names nothing is no call, and is refused there.
function writesByTheGenericCall(req) {
  const body = req.body || {};
  return req.method === "POST" && `${req.baseUrl || ""}${req.path}` === "/api/bridge/call" && isBridgeWritePair(body.service, body.method);
}

// A session-changing command is issued once, then its HTTP handler waits for
// authoritative location/scene/ship readiness. While that observation is
// pending, no second bridge POST action may slip through another route. GET
// reads, a read by the generic call (a write by it is gated), release, and character reselection
// remain available so the UI can observe or recover the session. Once phase is
// `ready`, ordinary commands are legal even
// while retail's separate next-session-mutation cooldown is still running.
const TRANSITION_GATE_EXEMPT_POST_PATHS = new Set([
  "/api/bridge/call", // the generic seam where it names a read: a write named there is gated (writesByTheGenericCall)
  "/api/bridge/select",
  "/api/bridge/release",
  "/api/bridge/provisioning/review", // read-only despite the structured POST body
  "/api/bridge/provisioning/ship-review", // read-only plan; Apply reserves in the shared engine
  "/api/bridge/provisioning/reconcile", // evidence reads only; never dispatches
]);
app.use((req, res, next) => {
  if (
    req.method !== "POST" ||
    !req.path.startsWith("/api/bridge/") ||
    (TRANSITION_GATE_EXEMPT_POST_PATHS.has(req.path) && !writesByTheGenericCall(req))
  ) {
    next();
    return;
  }
  const payload = auth.verifySessionToken(readSessionToken(req));
  const held = payload && payload.sessionID
    ? bridgeSessions.get(payload.sessionID) || null
    : null;
  if (!held || !held.transition || held.transition.phase === "ready") {
    next();
    return;
  }
  res.status(409).json({
    ok: false,
    error: "SESSION_CHANGE_IN_PROGRESS",
    message: `The ${held.transition.kind} transition is not ready for another command.`,
    transition: publicTransition(held),
  });
});

const provisioningRoutes = registerProvisioningRoutes({ app, requireAuth, requireHeld: requireHeldBridgeSession, engine: replenishment, store, gateway, data: staticData,
  flight: readHeldFlight, currentHeld: assertCurrentHeldSession, inventoryLocation: inventoryLocationID,
  resolvePlace, boundCall, cargoBindSpec, inventoryManagerBindSpec, slots: () => ALL_SLOT_FLAGS, shipBays: () => SHIP_BAYS,
  capacity: decodeCapacityReading, heldCall: heldTopLevelCall, mutationFence,
  pendingRecovery: held => hasPendingRecovery(held, held.characterID),
  boardShip: async (held, sessionID, shipID, revalidate) => {
    const response = { status() { return this; }, json(value) { throw Object.assign(new Error(value.message || value.error), { code: value.error, statusCode: 409 }); } };
    if (!await acquireRouteTransition(response, held, "board", { shipID }, revalidate)) return;
    let dispatchError;
    try { await boundCall(held, sessionID, shipBindSpec(held), "Board", [shipID, held.activeShipID], null); }
    catch (error) { dispatchError = error; }
    markTransitionAccepted(held); // Outcome may be uncertain; observe even on error.
    const ready = await awaitRouteTransition(held, sessionID, "board", { shipID });
    if (!ready.ok) throw Object.assign(new Error("Exact target hull transition is unproven."), { code: "PROVISIONING_BOARD_UNPROVEN", statusCode: 409 });
    held.activeShipID = Number(ready.flight.shipID);
    if (dispatchError) throw dispatchError;
  } });

const provisioningCenter = require("./provisioningCenter").registerProvisioningCenter({ app, requireAuth: requireTrainingAuth, gateway, data: staticData,
  store, operations: characterOperations, sessionOperations, heldSessions: bridgeSessions, botHost, engine: replenishment,
  withLease: mutationFence.withLease,
  // Exact administrative release remains available while shared custody blocks
  // inventory writes. Only the bounded service's acquired handle reaches here.
  releaseSession: (handle, fields) => (options.eveGatewayClient || eveGatewayClient).releaseBridgeSession(handle, fields),
  selectedAdapter: provisioningRoutes.adapter,
  filePath: options.provisioningCenterJournalPath || (options.eveStore ? null : path.join(config.dataDir, "provisioning-center-control.json")),
  fault: options.provisioningCenterFault || null,
  attach(account, characterID, selected, operationID) {
    const webSessionID = `provisioning-center:${operationID}`;
    if (bridgeSessions.has(webSessionID) || [...bridgeSessions.values()].some(h => h.characterID === characterID))
      throw Object.assign(new Error("Pilot ownership changed."), { code: "PILOT_BUSY" });
    const held = makeHeldCharacter(account, characterID, selected);
    held.temporaryProvisioning = true;
    held.droneRecoveryReady = !!held.stationID && !held.structureID;
    bridgeSessions.set(webSessionID, held);
    return { held, req: { account, webSessionID } };
  },
  detach(binding) { if (bridgeSessions.get(binding.req.webSessionID) === binding.held) bridgeSessions.delete(binding.req.webSessionID); },
});

const trainingEquipment = require("./trainingEquipment").createTrainingEquipment({ center: provisioningCenter,
  async readQualification(account, input) {
    return (await readMinerPilot({ store, gateway, data: staticData, account, readSkills: accountSkillSheet, ...input })).read;
  } });
for (const action of ["review", "apply", "recover"]) app.post(`/api/pilot-training/equipment/${action}`, requireTrainingAuth, async (req, res, next) => {
  try { res.json({ ok: true, [action === "review" ? "review" : "outcome"]: await trainingEquipment[action](req.account, req.body || {}, req.webSessionID) }); }
  catch (error) { next(error); }
});

const miningPreparation = options.miningPreparation || require("./miningPreparation").createMiningPreparation({
  store, readDefinitions: (accountID,input) => require("./provisioningRoutes").readProvisioningDefinitions({
    store,gateway,data:staticData,accountID,providerCharacterID:input.providerCharacterID,supplyPolicy:input.supplyPolicy }),
  engine: replenishment, data: staticData, bots: () => botHost.listAll(),
  readSkills: (accountID, characterID) => accountSkillSheet(accountID, characterID),
  currentRun: operationID => miningOperations.runtimeFor(operationID)?.operationRunID ||
    botHost.listAll().find(b=>b.operationID===operationID && !b.endedAt)?.operationRunID,
  adapterFor(record) {
    const held=bridgeSessions.get(record.webSessionID);
    if (!held || held.characterID!==record.characterID || held.botClaimSecret!==record.claimSecret ||
        !botHost.authorizesClaim(record.characterID,record.claimSecret)) throw Object.assign(new Error("Hosted preparation authority changed."),{code:"HOSTED_GENERATION_CHANGED"});
    return provisioningRoutes.adapter({account:{accountID:record.accountID},webSessionID:record.webSessionID},held);
  },
  fault: options.miningPreparationFault || null,
});
app.locals.miningPreparation=miningPreparation;
function operationPreparationBarrier(operationID,operationRunID) {
  const definition=miningOperations.definition(operationID), runtime=miningOperations.runtimeFor(operationID), rows=botHost.listAll();
  return !!definition && runtime?.operationRunID===operationRunID && !["STOPPING","STOPPED","PARKING","PARKING_FAILED"].includes(runtime.state) &&
    definition.members.every(m=>rows.some(b=>b.operationID===operationID && b.operationRunID===operationRunID &&
      b.characterID===m.characterID && !b.endedAt && b.preparationOwnerAvailable===true &&
      botHost.claimedBy(m.characterID)===b.botID && miningPreparation.ready(b.preparation)));
}
async function activatePreparedOperation(definition,operationRunID) {
  if (!operationPreparationBarrier(definition.operationID,operationRunID)) return false;
  for (const bot of botHost.listAll().filter(b=>b.operationID===definition.operationID && b.operationRunID===operationRunID && !b.endedAt && b.deferMain)) {
    const result=await botHost.activateOperationMember(bot.botID,bot.accountID,definition.operationID,operationRunID);
    if (!result.ok) miningOperations.memberFailed(definition.operationID,bot.characterID,{code:result.code,message:result.message});
  }
  return true;
}

// Thin bridge proxy for the whitelisted EveJS callMethod path (goal R1).
// Forwards the retail call tuple (service, method, args, kwargs) to the
// gateway's POST /_evejs-web/v1/call; the gateway enforces the deny-by-default
// (service, method) allowlist and materializes the browser-backed session. This
// generic seam makes a read, or one of the writes the page makes itself for its
// pilot (below; the plan's Phase 6b): every other write it refuses. (A few writes have
// a route of their own still; most have none since 2026-10-14, the loop's item 62.)
// The BFF also projects browser session fields
// onto an explicit presentation-only allowlist; `userid` always comes from the
// signed login session. Wire contract: docs/bridge-wire-contract.md.
app.post("/api/bridge/call", requireAuth, async (req, res, next) => {
  const body = req.body || {};
  // A call names its service and its method, each as text. Anything else is no call: a list of one name spells
  // that name wherever it is made into text further on, and a write named so is no write to the check below.
  if (typeof body.service !== "string" || body.service === "" || typeof body.method !== "string" || body.method === "") {
    res.status(400).json({ ok: false, error: "INVALID_REQUEST", message: "A call names its service and its method, each as text." });
    return;
  }
  // A write is made here only as the page makes one for its pilot (the plan's Phase 6b): said to be a pilot's,
  // said to be meant (`confirm`, which is what its route's confirmation was), and one of the writes the page
  // makes itself (bridgeCallPolicy.js). Any other write is refused, and the words say which of the two it was.
  const write = isBridgeWritePair(body.service, body.method);
  if (write && !(body.pilot === true && body.confirm === true && isPageWritePair(body.service, body.method))) {
    res.status(403).json({
      ok: false,
      error: "BRIDGE_WRITE_REFUSED",
      message: isPageWritePair(body.service, body.method)
        ? `${body.service}.${body.method} is a write the page makes for its pilot: it is made only with pilot and confirm said.`
        : `${body.service}.${body.method} is a write, and none of those the page makes: this call does not make it.`,
    });
    return;
  }
  // An order to the ship was a flight route's, and those are held back while the pilot's lost drones are looked
  // for (heldBackForDroneRecovery, below): every write of the page's own on beyonce was one of them, and the stop,
  // which that gate lets through, is CmdStop. So was every change of place the page makes (the undock, a flight
  // route until 2026-10-14).
  const ordersTheShip = body.service === "beyonce" && body.method !== "CmdStop";
  if (write && (ordersTheShip || placeChangeOf(body.service, body.method, body.args) !== null) && heldBackForDroneRecovery(req, res)) {
    return;
  }
  // A call the client makes on an object of the service's for a thing it names (its Moniker(service, what)) says
  // which with `of`, and is made on the object bound for it. Only the page's own calls of that kind take one
  // (bridgeCallPolicy.js): with one, any other is no call; and such a call without one is none either.
  // (An object the session has only one of, its system's scan manager, is named by nothing: such a call takes
  // no `of` either. The pilot's own fleet, for an invitation, may be said or not: bridgeCallPolicy.js,
  // OBJECTS_THE_PAGE_MAY_NAME.)
  const objectKind = objectOfPageCall(body.service, body.method);
  const saysWhich = body.of !== undefined && body.of !== null;
  if (!pageMayNameTheObject(objectKind) && saysWhich !== pageNamesTheObject(objectKind)) {
    res.status(400).json({
      ok: false,
      error: "INVALID_REQUEST",
      message: pageNamesTheObject(objectKind)
        ? `${body.service}.${body.method} is made on an object of its own: the call says which with "of".`
        : `${body.service}.${body.method} is made on no object the page names.`,
    });
    return;
  }
  if (objectKind === "planet" && !(Number.isSafeInteger(body.of) && body.of > 0)) {
    res.status(400).json({ ok: false, error: "INVALID_PLANET", message: "A positive planetID is required." });
    return;
  }
  // (An agent's number, as an agent's routes take one: a whole number above nought.)
  if (objectKind === "agent" && !(Number.isSafeInteger(body.of) && body.of > 0)) {
    res.status(400).json({ ok: false, error: "INVALID_AGENT", message: "A positive agentID is required." });
    return;
  }
  // (An inventory is a thing's own, said by the thing's number, or the hangar of where the pilot is docked, said
  // by its word: invCache.GetInventoryFromId(itemID) and invCache.GetInventory(const.containerHangar).)
  if (objectKind === "inventory" && !((Number.isSafeInteger(body.of) && body.of > 0) || body.of === "hangar")) {
    res.status(400).json({ ok: false, error: "INVALID_INVENTORY", message: "An inventory is a thing's own, said by its number, or \"hangar\"." });
    return;
  }
  // (A fleet's number as its routes take one: a whole number above nought, or the text of one.)
  if (objectKind === "fleetByNumber" && strictPositiveID(body.of) === null) {
    res.status(400).json({ ok: false, error: "INVALID_FLEET_ID", message: "A positive fleetID is required." });
    return;
  }
  // (An invitation turned down goes with the client's word for it or with none: true, false, or nothing at all.)
  if (objectKind === "fleetByNumber" && body.method === "RejectInvite" && decliningWordOf(body.args) === null) {
    res.status(400).json({ ok: false, error: "INVALID_ALREADY_IN_FLEET", message: "An invitation is turned down with true, with false, or with nothing." });
    return;
  }
  // (The fleet an invitation is to, where the call says one: a fleet's number as above. And the pilot invited
  // is a pilot's number, the call's first argument; its place, the next three, a wing's, a squad's and a role's
  // number or nothing each: nothing else of what it came with is taken.)
  if (objectKind === "fleetExpected" && saysWhich && strictPositiveID(body.of) === null) {
    res.status(400).json({ ok: false, error: "INVALID_FLEET_ID", message: "A positive fleetID is required." });
    return;
  }
  if (objectKind === "fleetExpected" && inviteeOf(body.args) === null) {
    res.status(400).json({ ok: false, error: "INVALID_CHARACTER", message: "A positive characterID is required." });
    return;
  }
  if (objectKind === "fleetExpected" && invitedPlaceOf(body.args) === null) {
    res.status(400).json({ ok: false, error: "INVALID_FLEET_PLACE", message: "A wing, a squad and a role are each a positive number or nothing." });
    return;
  }
  if (objectKind !== null && body.pilot !== true) {
    res.status(400).json({ ok: false, error: "INVALID_REQUEST", message: "A call on an object is a pilot's." });
    return;
  }
  // A warp of the page's is one the client's menus make: to a thing, a fleet member, a bookmark, a scan result or
  // a launch, with a range and fleet=False at most, and a fleet's warp to a member with the formation's settings.
  // The server's handler takes more of a caller than that (a point to fly to, a fleet's warp to anything else,
  // subjects no menu of the page's has): what is none of a client's is refused here, on either transport, and
  // nothing is sent.
  if (body.service === "beyonce" && body.method === "CmdWarpToStuff") {
    const why = notAClientsWarp(body.args, body.kwargs ?? null);
    if (why !== null) {
      res.status(400).json({ ok: false, error: "INVALID_REQUEST", message: `That is no warp the page makes. ${why}` });
      return;
    }
  }
  // A call the page makes for a pilot, in place of a route that needed one held (the plan's Phase 6b): with none
  // held it is refused as that route refused, and is not taken for the account's.
  if (body.pilot === true && !requireHeldBridgeSession(req, res)) {
    return;
  }
  // A write that puts the pilot in another ship is made under the BFF's own watch of the swap, as its route made
  // it (bridgeCallPolicy.js, PAGE_SHIP_SWAP_CALLS): the BFF's word for the pilot's ship is kept there. It is
  // answered as any call here is, once the pilot's flight says another ship.
  if (swapsThePilotsShip(body.service, body.method)) {
    const args = Array.isArray(body.args) ? body.args : [];
    // The ship boarded is held to, as the board's route held it: the swap is over when the pilot is in that ship.
    await dispatchShipSwapWrite(req, res, next, body.service, body.method, args, swapTargetOf(body.service, body.method, args), (outcome, after) => ({
      ok: true,
      service: body.service,
      method: body.method,
      result: outcome.result ?? null,
      notifications: [...outcome.notifications, ...after.notifications],
      ...pilotClock(bridgeSessions.get(req.webSessionID) || null),
    }), body.kwargs ?? null);
    return;
  }
  // A write that takes the pilot to another place is made under the BFF's keeping of the session change, as the
  // client's session manager makes it and as its route made it (bridgeCallPolicy.js, PAGE_PLACE_CHANGE_CALLS): it
  // is answered as any call here is, once the pilot is usable in its new place.
  const placeChange = placeChangeOf(body.service, body.method, body.args);
  if (placeChange !== null) {
    await dispatchPlaceChangeWrite(req, res, next, placeChange, body.service, body.method,
      Array.isArray(body.args) ? body.args : [], body.kwargs ?? null);
    return;
  }
  const clientSessionFields = pickSafeBrowserSessionFields(body.session);
  // When this web session holds a persistent bridge session (goal R2), every
  // bridge call runs on that live session — one web login is one client
  // session, like retail. A browser-supplied bridgeSessionID is ignored; only
  // the server-held handle is ever forwarded.
  const heldBridgeSession = bridgeSessions.get(req.webSessionID) || null;
  try {
    // With no pilot held this is the account asking (the hangar's roster is the client's character selection
    // screen), and the seam sends what the retail client asks there to where the account is (pilotTransport.js).
    // (A write is a pilot's, so one is held; and it is made under the checks every write of a held pilot's is
    // under, as its route made it.)
    // (A call on a planet's object goes by the bind its route went by: bound once for the planet and kept.)
    const outcome = objectKind === "planet"
      ? { service: body.service, method: body.method, ...await heldRequest(heldBridgeSession, req.webSessionID, write, () => boundCall(
        heldBridgeSession, req.webSessionID, planetBindSpec(body.of), body.method, Array.isArray(body.args) ? body.args : [], body.kwargs ?? null)) }
      // (A call on an agent's object goes by the bind an agent's routes go by: bound for that agent, and kept.)
      : objectKind === "agent"
      ? { service: body.service, method: body.method, ...await heldRequest(heldBridgeSession, req.webSessionID, write, () => boundCall(
        heldBridgeSession, req.webSessionID, agentBindSpec(body.of), body.method, Array.isArray(body.args) ? body.args : [], body.kwargs ?? null)) }
      // (A call on an inventory's own object goes by the bind an inventory's routes go by, held to where the pilot
      // is docked as they held it.)
      : objectKind === "inventory"
      ? { service: body.service, method: body.method, ...await heldRequest(heldBridgeSession, req.webSessionID, write, () => inventoryCall(
        heldBridgeSession, req.webSessionID, body.of, body.method, Array.isArray(body.args) ? body.args : [], body.kwargs ?? null)) }
      // (And a call on the inventory manager of where the pilot is, by the bind the trash route went by: the game
      // port makes it the client's own, Moniker('invbroker', the session's place) as eveMoniker.GetInventoryMgr has
      // it. boundCall reads the pilot's place again before TrashItems, as before every inventory write.)
      : objectKind === "inventoryManager"
      ? { service: body.service, method: body.method, ...await heldRequest(heldBridgeSession, req.webSessionID, write, () => boundCall(
        heldBridgeSession, req.webSessionID, inventoryManagerBindSpec(heldBridgeSession), body.method, Array.isArray(body.args) ? body.args : [], body.kwargs ?? null)) }
      // (And a call on the refinery of where the pilot is docked, by the object its route went by: a structure's
      // hangar access asked first, as the route asked it.)
      : objectKind === "refinery"
      ? { service: body.service, method: body.method, ...await heldRequest(heldBridgeSession, req.webSessionID, write, () => refineryCall(
        heldBridgeSession, req.webSessionID, body.method, Array.isArray(body.args) ? body.args : [], body.kwargs ?? null)) }
      // (And a call on the system's scan manager, by the object its route went by.)
      : objectKind === "scanManager"
      ? { service: body.service, method: body.method, ...await heldRequest(heldBridgeSession, req.webSessionID, write, () => systemScanCall(
        heldBridgeSession, req.webSessionID, body.method, Array.isArray(body.args) ? body.args : [], body.kwargs ?? null)) }
      // (And a call on the pilot's own things everywhere, by the object its route goes by, bound for the pilot held.)
      : objectKind === "assets"
      ? { service: body.service, method: body.method, ...await heldRequest(heldBridgeSession, req.webSessionID, write, () => globalAssetsCall(
        heldBridgeSession, req.webSessionID, body.method, Array.isArray(body.args) ? body.args : [], body.kwargs ?? null)) }
      // (And the pilot's fleet left, as its route leaves it: on the fleet's object, or of fleetMgr where none is
      // held. Answered as the call that was asked.)
      // (Or a fleet formed, as its route forms one: bound through the call, and Init asked on what it answered.)
      : objectKind === "fleet"
      // (Or a member kicked, or the boss handed on, on the session's own fleet's object: fleetSvc.KickMember and
      // MakeLeader, 601 to 612.)
      ? { ...await heldRequest(heldBridgeSession, req.webSessionID, write, () => (body.method === "CreateFleet"
        ? createFleetCall(heldBridgeSession, req.webSessionID)
        : body.method === "LeaveFleet"
        ? leaveFleetCall(heldBridgeSession, req.webSessionID, Array.isArray(body.args) ? body.args : [], body.kwargs ?? null)
        : boundCall(heldBridgeSession, req.webSessionID, fleetBindSpec(), body.method, Array.isArray(body.args) ? body.args : [], body.kwargs ?? null))), service: body.service, method: body.method }
      // (An invitation accepted, as its route accepts one: on the fleet the page names, bound by its number,
      // with no type of ship said whatever the call came with.)
      : objectKind === "fleetByNumber"
      // (Or turned down, as its route turns one down: on the same object, with the word the call said or none.)
      ? { ...await heldRequest(heldBridgeSession, req.webSessionID, write, () => (body.method === "RejectInvite"
        ? rejectFleetInviteCall(heldBridgeSession, req.webSessionID, strictPositiveID(body.of), decliningWordOf(body.args))
        : acceptFleetInviteCall(heldBridgeSession, req.webSessionID, strictPositiveID(body.of)))),
        service: body.service, method: body.method }
      // (A pilot invited, on the session's own fleet or on the fleet the call expects, with the invitee and the
      // place the call says, a wing, a squad and a role or nothing of them.)
      : objectKind === "fleetExpected"
      ? { ...await heldRequest(heldBridgeSession, req.webSessionID, write, () => inviteToFleetCall(
        heldBridgeSession, req.webSessionID, inviteeOf(body.args), saysWhich ? strictPositiveID(body.of) : null, invitedPlaceOf(body.args))), service: body.service, method: body.method }
      // (A follow, as its routes made it: held back where the ship already flies it, and through the gateway
      // with the throttle opened first. bridgeCallPolicy.js, PAGE_FOLLOW_CALLS.)
      : ordersAFollow(body.service, body.method)
      ? { ...await heldRequest(heldBridgeSession, req.webSessionID, write, () => followCall(
        heldBridgeSession, req.webSessionID, body.method, Array.isArray(body.args) ? body.args : [], body.kwargs ?? null)), service: body.service, method: body.method }
      // (A write the gateway's list has under another name is asked by that name there, and answered as the call
      // that was asked: bridgeCallPolicy.js, gatewaysNameFor.)
      : write
      ? { ...await heldTopLevelCall(heldBridgeSession, req.webSessionID, body.service,
        gamePortPilots && isGamePortHandle(heldBridgeSession.bridgeSessionID) ? body.method : gatewaysNameFor(body.service, body.method), body.args, body.kwargs), method: body.method }
      : !heldBridgeSession && typeof gateway.accountCall === "function"
      ? await gateway.accountCall(body.service, body.method, body.args, body.kwargs, {
        accountID: Number(req.account.accountID),
        userName: String(req.account.username || ""),
        fields: clientSessionFields,
      })
      : await gateway.callMethod(
        body.service,
        body.method,
        body.args,
        body.kwargs,
        { ...clientSessionFields, userid: Number(req.account.accountID) },
        heldBridgeSession ? heldBridgeSession.bridgeSessionID : undefined,
      );
    res.json({
      ok: true,
      service: outcome.service,
      method: outcome.method,
      result: outcome.result,
      notifications: outcome.notifications,
      ...pilotClock(heldBridgeSession),
    });
  } catch (error) {
    // The gateway reaped or lost the persistent session (TTL expiry, retail
    // takeover, restart): drop the stale handle so the next call is stateless
    // and surface the typed error so the page can return to character select.
    if (heldBridgeSession && error && error.code === "SESSION_NOT_FOUND") {
      forgetBridgeSession(req.webSessionID, heldBridgeSession);
    }
    next(error);
  }
});

/**
 * The server's clock, to go with a pilot's answer: `{ serverNowMs }`. A retail client's clock is kept set by its own
 * connection. The page has no connection of its own, and what it works out from the time (a skill in training, a
 * countdown) it works out from this, told with each of its pilot's answers (the plan's Phase 6b).
 *
 * For a pilot on the game port it is the clock as that pilot's session has it; nothing where the session cannot
 * say. Through the web gateway there is no such session, and it is the BFF's own clock, which is what the routes
 * that put a time beside their answers put there. With no pilot held, nothing.
 */
function pilotClock(held) {
  if (!held) return {};
  if (!isGamePortHandle(held.bridgeSessionID)) return { serverNowMs: Date.now() };
  try {
    const serverNowMs = gamePortPilots.serverNowMs({ userid: held.accountID }, held.bridgeSessionID);
    return Number.isFinite(serverNowMs) ? { serverNowMs } : {};
  } catch {
    return {};
  }
}

// Drop a held bridge session from the BFF's map. Every site that forgets a
// handle goes through here so the R10 push stream is torn down with it: a
// gateway WebSocket for a session the BFF no longer holds can never be useful,
// and attached browsers are told the channel ended rather than being left on a
// silent stream.
function forgetBridgeSession(webSessionID, expectedHeld = null) {
  const held = bridgeSessions.get(webSessionID);
  if (!held || expectedHeld !== null && held !== expectedHeld) {
    return false;
  }
  // Ordinary claims release with the session. An issued inventory transfer
  // remains exclusive until its authoritative reread settles (or its bounded
  // lease expires if settlement cannot be observed).
  lootMemory.releaseClaims(webSessionID);
  bridgeSessions.delete(webSessionID);
  publishStreamStatus(held, "ended", "session_released");
  closeHeldStream(held);
  // The chat connection is this character's presence in Local: it has to go
  // when the character does, or a pilot nobody is flying stays in the member
  // list until the stub reaps a half-open socket.
  if (held.chat) {
    held.chat.close();
    held.chat = null;
  }
  for (const subscriber of [...held.streamSubscribers]) {
    held.streamSubscribers.delete(subscriber);
    try {
      subscriber.end();
    } catch {
      // The response is already gone.
    }
  }
  return true;
}

// Best-effort release of the bridge session a web session holds. Returns true
// when a held session existed. SESSION_NOT_FOUND from the gateway means the
// TTL (or a takeover) already disconnected it — the handle is just dropped.
// A TRANSPORT failure is best-effort too: the handle is already forgotten by
// the time the gateway is asked, so rethrowing a timeout only shows the user a
// failed logout for a release that probably landed — and when it truly did
// not, the gateway's own session TTL retires the live session. Log it; never
// fail the logout over it.
const RELEASE_BEST_EFFORT_CODES = new Set([
  "SESSION_NOT_FOUND",
  "EVE_GATEWAY_TIMEOUT",
  "EVE_GATEWAY_UNREACHABLE",
]);
async function releaseHeldBridgeSession(webSessionID, { confirmed = false } = {}) {
  const held = bridgeSessions.get(webSessionID);
  if (!held) {
    return false;
  }
  replenishment.assertWritable(held.characterID);
  const existing = characterOperations.get(held.characterID);
  if (existing && sessionOperations.get(webSessionID) !== existing)
    throw Object.assign(new Error("The pilot has another operation in progress."), { code: "CHARACTER_IN_USE", statusCode: 409 });
  const reservation = existing || Symbol("pilot-release");
  if (!existing) characterOperations.set(held.characterID, reservation);
  try {
    if (confirmed) {
      try {
        const outcome = await gateway.releaseBridgeSession(held.bridgeSessionID, { userid: Number(held.accountID) });
        if (outcome?.released !== true) {
          throw Object.assign(new Error("Pilot release was not confirmed."), { code: "PILOT_RELEASE_UNVERIFIED", statusCode: 409 });
        }
      } catch (error) {
        if (!error || error.code !== "SESSION_NOT_FOUND") throw error;
      }
      if (bridgeSessions.get(webSessionID) === held) forgetBridgeSession(webSessionID);
      return true;
    }
    forgetBridgeSession(webSessionID, held);
    try {
      await gateway.releaseBridgeSession(held.bridgeSessionID, {
        userid: Number(held.accountID),
      });
    } catch (error) {
      if (!(error && RELEASE_BEST_EFFORT_CODES.has(error.code))) {
        throw error;
      }
      if (error.code !== "SESSION_NOT_FOUND") {
        errorLogger(error);
      }
    }
    return true;
  } finally {
    if (!existing && characterOperations.get(held.characterID) === reservation) characterOperations.delete(held.characterID);
  }
}

// --- R10 live event channel (gateway push -> SSE) --------------------------
// The BFF holds at most ONE gateway WebSocket per held bridge session and
// republishes it to the browser as Server-Sent Events on GET /api/bridge/events
// (same-origin, routed to this web session's held bridge session). The
// bridgeSessionID stays server-side, exactly as on every request route. Since
// R42 the stream authenticates from the `access_token` query parameter as well
// as the cookie, because EventSource cannot send a header — see
// requireStreamAuth for the trade that buys and what bounds it.
//
// The stream is opened lazily when a browser attaches and closed when the last
// one detaches, so a held session with nobody watching costs nothing. The last
// cursor seen is remembered on the held-session entry, so a gateway reconnect
// resumes with it and the gateway replays the frames missed in between.
//
// Liveness only: every request route still drains notifications onto its
// response, so a stream that never opens or drops mid-flight degrades to the
// old poll-based behaviour rather than losing data.

const STREAM_RETRY_MS = 3000;
const SSE_HEARTBEAT_MS = 25_000;

function writeSseFrame(res, payload) {
  try {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
    return true;
  } catch {
    return false;
  }
}

// Fan a gateway frame out to every SSE subscriber on this held session, and
// remember its cursor so a reconnect resumes from it.
function publishStreamFrame(held, frame) {
  if (frame && frame.cursor && typeof frame.cursor.epoch === "string") {
    held.streamCursor = {
      epoch: frame.cursor.epoch,
      sequence: Number(frame.cursor.sequence) || 0,
    };
  }
  for (const subscriber of [...held.streamSubscribers]) {
    if (!writeSseFrame(subscriber, frame)) {
      held.streamSubscribers.delete(subscriber);
    }
  }
}

function publishStreamStatus(held, state, detail) {
  publishStreamFrame(held, {
    source: "evejs-web-bff",
    type: "stream-status",
    state,
    detail: detail === undefined ? null : detail,
  });
}

// The push channel's only server-side evidence. Lifecycle strings and a short
// session-id prefix only — never the full bridgeSessionID and never a token —
// so a drop, refusal, or reconnect loop is visible in the BFF log instead of
// leaving nothing to diagnose from.
function logStreamEvent(held, message) {
  const sessionTag = String(held.bridgeSessionID || "").slice(0, 8) || "unknown";
  console.log(
    `[${new Date().toISOString()}] [bridge-events ${sessionTag}] ${message}`,
  );
}

function openHeldStream(webSessionID, held) {
  if (held.stream || held.streamSubscribers.size === 0) {
    return;
  }
  if (held.streamRetryTimer) {
    clearTimeout(held.streamRetryTimer);
    held.streamRetryTimer = null;
  }
  held.stream = gateway.openSessionEventStream({
    bridgeSessionID: held.bridgeSessionID,
    userid: Number(held.accountID),
    cursor: held.streamCursor || null,
    onOpen() {
      logStreamEvent(held, "gateway stream live");
      publishStreamStatus(held, "live");
    },
    onFrame(frame) {
      publishStreamFrame(held, frame);
    },
    onClose(details) {
      held.stream = null;
      const code = Number(details && details.code) || 0;
      const reason = (details && details.reason) || "";
      if (held.streamSubscribers.size === 0) {
        logStreamEvent(
          held,
          `gateway stream closed (code=${code} reason=${reason || "none"}); no subscribers, not retrying`,
        );
        return;
      }
      // Tell the browser the channel is degraded so it leans on its poll, then
      // retry. A 404 means the gateway no longer knows this bridge session —
      // retrying cannot fix that, so stop and let the next request route
      // surface SESSION_NOT_FOUND.
      const refusal = Number(details && details.refusalStatus) || 0;
      if (refusal === 404) {
        logStreamEvent(held, "gateway refused the stream (404); session ended");
        publishStreamStatus(held, "ended", "session_not_found");
        return;
      }
      logStreamEvent(
        held,
        `gateway stream dropped (code=${code} reason=${reason || "none"}` +
          `${refusal ? ` refusal=${refusal}` : ""}); retrying in ${STREAM_RETRY_MS}ms`,
      );
      publishStreamStatus(held, "degraded", reason || null);
      held.streamRetryTimer = setTimeout(() => {
        held.streamRetryTimer = null;
        if (bridgeSessions.get(webSessionID) === held) {
          openHeldStream(webSessionID, held);
        }
      }, STREAM_RETRY_MS);
      if (typeof held.streamRetryTimer.unref === "function") {
        held.streamRetryTimer.unref();
      }
    },
  });
}

function closeHeldStream(held) {
  if (held.streamRetryTimer) {
    clearTimeout(held.streamRetryTimer);
    held.streamRetryTimer = null;
  }
  if (held.stream) {
    held.stream.close();
    held.stream = null;
  }
}

app.get("/api/bridge/events", requireStreamAuth, (req, res) => {
  const held = bridgeSessions.get(req.webSessionID) || null;
  if (!held) {
    res.status(409).json({
      ok: false,
      error: "NO_LIVE_SESSION",
      message: "No character is online; select a character first.",
    });
    return;
  }
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
    // Defeat proxy buffering, which would otherwise hold frames back and
    // reintroduce exactly the latency this channel removes.
    "x-accel-buffering": "no",
  });
  res.write(": open\n\n");
  held.streamSubscribers.add(res);
  publishStreamStatus(held, held.stream ? "live" : "connecting");
  openHeldStream(req.webSessionID, held);

  // SSE comment heartbeat: keeps intermediaries from reaping an idle stream.
  const heartbeat = setInterval(() => {
    try {
      res.write(": ping\n\n");
    } catch {
      // The close handler below owns teardown.
    }
  }, SSE_HEARTBEAT_MS);
  if (typeof heartbeat.unref === "function") {
    heartbeat.unref();
  }

  req.on("close", () => {
    clearInterval(heartbeat);
    held.streamSubscribers.delete(res);
    if (held.streamSubscribers.size === 0) {
      closeHeldStream(held);
    }
  });
});

// Read-only station identity from the local static reference data (allowed by
// the roadmap: names/SDE stay client-local, exactly as the retail client
// resolves station names from its static DB).
function buildStationStatic(stationID) {
  const numericStationID = Number(stationID) || 0;
  if (numericStationID <= 0) {
    return null;
  }
  const record = staticData.getStation(numericStationID) || {};
  const stationTypeID = Number(record.stationTypeID) || null;
  return {
    stationID: numericStationID,
    stationName: String(record.stationName || `Station ${numericStationID}`),
    solarSystemName: String(record.solarSystemName || ""),
    regionName: String(record.regionName || ""),
    stationTypeID,
    stationTypeName: stationTypeID ? staticData.getTypeName(stationTypeID) : null,
    operationID: Number(record.operationID) || null,
    security: Number(record.security) || null,
  };
}

// Shared by ordinary select and the narrowly guarded handoff restoration.
async function selectHeldCharacter(webSessionID, account, characterID, { assertCurrent = () => {}, hostedSecret = null } = {}) {
  assertCurrent();
  const accountID = Number(account.accountID);
  const pendingCustody = replenishment.unresolved(characterID).length > 0;
  if (pendingCustody)
    throw Object.assign(new Error("Free-only custody recovery selection is unavailable; pilot control remains fenced."),
      { code: "PROVISIONING_RECOVERY_AUTHORITY_UNAVAILABLE", statusCode: 409 });
  const outcome = await gateway.selectCharacter(
    [characterID, null, true], null,
    { userid: Number(account.accountID), userName: String(account.username || "") },
  );
  const held = makeHeldCharacter(account, characterID, outcome);
  try { assertCurrent(); }
  catch (error) {
    // Selection awaited: a retired generation must not install its outcome.
    // Clean only the returned handle, never the current web-session row.
    try {
      const released = await gateway.releaseBridgeSession(outcome.bridgeSessionID, { userid: accountID });
      if (released?.released !== true) throw new Error("Selection release was not confirmed.");
    } catch (releaseError) {
      if (releaseError?.code !== "SESSION_NOT_FOUND") {
        // Preserve uncertainty in the existing held-session fence, without
        // replacing a newer row or enabling any productive action.
        if (!bridgeSessions.has(webSessionID)) {
          held.selectionReleaseUnverified = true;
          held.droneRecoveryReady = true;
          if (hostedSecret !== null) held.botClaimSecret = hostedSecret;
          bridgeSessions.set(webSessionID, held);
        }
        throw Object.assign(new Error("The stale selection's exact session release could not be confirmed. Retry its logout before selecting again."),
          { code: "PILOT_RELEASE_UNVERIFIED", statusCode: 409 });
      }
    }
    throw error;
  }
  bridgeSessions.set(webSessionID, held);
  joinHeldChat(bridgeSessions.get(webSessionID));
  return outcome;
}

async function restoreHeldCaller(webSessionID, account, characterID, reservation) {
  const current = () => characterOperations.get(characterID) === reservation &&
    sessionOperations.get(webSessionID) === reservation && !bridgeSessions.has(webSessionID) &&
    botHost.claimedBy(characterID) === null && !replenishment.unresolved(characterID).length &&
    ![...bridgeSessions.values()].some(held => Number(held.characterID) === characterID);
  if (!current() || await isCharacterHeld(characterID, webSessionID,
    { accountID: Number(account.accountID) }, reservation) || !current()) return false;
  // The fresh offline observation and exact WC generation checks do not fence
  // a later external login. Re-selection follows stock retail server policy.
  await selectHeldCharacter(webSessionID, account, characterID, { assertCurrent: () => {
    if (!current()) throw Object.assign(new Error("The caller's ownership changed during restoration."),
      { code: "CHARACTER_IN_USE", statusCode: 409 });
  } });
  return true;
}
function makeHeldCharacter(account, characterID, outcome) {
  return {
    bridgeSessionID: outcome.bridgeSessionID,
    characterID: Number(outcome.session.characterID) || characterID,
    accountID: Number(account.accountID),
    corporationID: Number(outcome.session.corporationID) || null,
    stationID: Number(outcome.session.stationID) || null,
    structureID: Number(outcome.session.structureID) || null,
    dockedLocationID: Number(outcome.session.structureID) || Number(outcome.session.stationID) || null,
    solarSystemID: Number(outcome.session.solarSystemID) || null,
    activeShipID: Number(outcome.session.shipID) || null,
    boundHandles: new Map(),
    transitionEpoch: 0,
    transition: null,
    transitionReservation: null,
    cooldownUntilMs: 0,
    stream: null,
    streamSubscribers: new Set(),
    streamCursor: null,
    streamRetryTimer: null,
    chat: null,
    droneRecoveryReady: false,
    droneRecoveryCheckID: randomUUID(),
    recoveryDroneIDs: new Set(),
  };
}

// Select a character onto a persistent browser-backed session (goal R2): the
// BFF forwards the retail tuple SelectCharacterID(charID, secondChoiceID,
// skipTutorial) to the gateway's session/select route, pins the identity to
// the signed login session, and keeps the returned bridgeSessionID
// server-side in its own session store — it must never reach browser JS.
app.post("/api/bridge/select", requireAuth, async (req, res, next) => {
  const characterID = Number(req.body && req.body.characterID || 0);
  try {
    if (!Number.isSafeInteger(characterID) || characterID <= 0) {
      res.status(400).json({
        ok: false,
        error: "INVALID_CHARACTER",
        message: "A positive characterID is required.",
      });
      return;
    }
    const character = await store.getCharacterForAccount(
      req.account.accountID,
      characterID,
    );
    if (!character) {
      res.status(404).json({ ok: false, error: "CHARACTER_NOT_FOUND" });
      return;
    }
    const previousHeld = bridgeSessions.get(req.webSessionID);
    if (previousHeld && hasPendingRecovery(previousHeld, previousHeld.characterID) &&
        Number(previousHeld.characterID) !== characterID &&
        !botHost.authorizesClaim(previousHeld.characterID, req.get(botHostModule.BOT_HEADER))) {
      res.status(409).json({ ok: false, error: "DRONE_RECOVERY_PENDING",
        message: "Finish the selected pilot's nearby drone recovery before selecting a pilot again." });
      return;
    }
    // ONE HULL, ONE DRIVER, direction 2: while a server bot claims this
    // character, a tab selecting it would put two drivers on one ship — the
    // takeover would kick the bot mid-script. Refused with a plain remedy;
    // the bot's OWN select passes because its fetch names it. Tab-vs-tab
    // takeover (desktop to phone) is untouched.
    const hostedSecret = req.get(botHostModule.BOT_HEADER);
    const hostedSelection = botHost.authorizesClaim(characterID, hostedSecret);
    const claimingBotID = botHost.claimedBy(characterID);
    if (claimingBotID !== null && !botHost.authorizesClaim(characterID, req.get(botHostModule.BOT_HEADER))) {
      res.status(409).json({
        ok: false,
        error: "CHARACTER_IN_USE_BY_BOT",
        // No screen named here on purpose: every roster screen that can show
        // this pilot now carries its own Stop (the Pilot Hangar row, the
        // onboarding picker, the Bot Manager), so naming one of them would be
        // wrong on the other two.
        message: "A server bot is flying this character. Stop the bot first.",
      });
      return;
    }
    if (hostedSecret !== undefined && !hostedSelection)
      throw Object.assign(new Error("The requesting hosted controller generation is no longer current."),
        { code: "HOSTED_GENERATION_CHANGED", statusCode: 409 });
    const existingReservation = characterOperations.get(characterID);
    const operation = hostedSelection && botHost.operationForClaim?.(characterID, hostedSecret);
    const ownOperationHandoff = operation?.operationRunID && existingReservation?.kind === "mining-operation-handoff" &&
      existingReservation.operationID === operation.operationID && existingReservation.operationRunID === operation.operationRunID;
    if (sessionOperations.has(req.webSessionID) ||
        (existingReservation && !ownOperationHandoff)) {
      res.status(409).json({ ok: false, error: "CHARACTER_IN_USE", message: "This pilot is changing sessions. Try again shortly." });
      return;
    }
    // A tab can reload after select but before its recovery check is ACKed.
    // Reopening that exact held pilot must return the SAME check identity,
    // after proving the gateway session still exists. Re-selecting would
    // disconnect the recovery owner; refusing would strand the tab forever.
    if (previousHeld && Number(previousHeld.characterID) === characterID &&
        (hasPendingRecovery(previousHeld, characterID) || replenishment.unresolved(characterID).length) &&
        !botHost.authorizesClaim(characterID, req.get(botHostModule.BOT_HEADER))) {
      const current = await readHeldFlight(previousHeld, req.webSessionID);
      const liveShipID = Number(current.flight?.shipID);
      const heldShipID = Number(previousHeld.activeShipID);
      if (bridgeSessions.get(req.webSessionID) !== previousHeld ||
          (current.flight?.docked !== true && current.flight?.inSpace !== true) ||
          !Number.isSafeInteger(liveShipID) || liveShipID <= 0 ||
          !Number.isSafeInteger(heldShipID) || heldShipID <= 0 ||
          liveShipID !== heldShipID) {
        res.status(409).json({ ok: false, error: "DRONE_RECOVERY_UNCONFIRMED",
          message: "The held pilot or ship could not be confirmed. Retry recovery after the session is reconciled." });
        return;
      }
      res.json({ ok: true,
        character: { characterID, characterName: String(character.characterName || ""),
          stationID: previousHeld.stationID, structureID: previousHeld.structureID,
          solarSystemID: previousHeld.solarSystemID, corporationID: previousHeld.corporationID },
        station: buildStationStatic(previousHeld.stationID),
        notifications: current.notifications || [],
        droneRecoveryCheckID: previousHeld.droneRecoveryCheckID });
      return;
    }
    const reservation = Symbol("select");
    const ownsCharacterReservation = !characterOperations.has(characterID);
    if (ownsCharacterReservation) characterOperations.set(characterID, reservation);
    sessionOperations.set(req.webSessionID, reservation);
    const expectedCharacterReservation = characterOperations.get(characterID);
    try {
    // One client session per web login: switching characters releases the
    // previous persistent session (retail semantics live on the gateway side;
    // the handler's own refusals pass through as CALL_REFUSED).
    await releaseHeldBridgeSession(req.webSessionID);
    // The release awaited. Stock takeover policy never authorizes replacing a
    // newer WC reservation, generation or held owner discovered during that gap.
    const assertSelectionCurrent = () => {
      if (hostedSelection && !botHost.authorizesClaim(characterID, hostedSecret))
        throw Object.assign(new Error("The requesting hosted controller generation is no longer current."),
          { code: "HOSTED_GENERATION_CHANGED", statusCode: 409 });
      // Only the current resumed preparation may reconcile its own custody.
      // A fresh hosted Start has no checkpoint authority and cannot borrow it.
      const pendingCustody = hostedSelection ? replenishment.unresolved(characterID) : [];
      const checkpoint = pendingCustody.length && botHost.preparationForClaim?.(characterID, hostedSecret);
      const custodyID = checkpoint?.custodyOperationID || checkpoint?.evidence?.custodyOperationID;
      const ownsCustody = checkpoint?.intent?.accountID === Number(req.account.accountID) &&
        checkpoint.intent.characterID === characterID && custodyID &&
        pendingCustody.every(row => row.key === custodyID && row.accountID === checkpoint.intent.accountID);
      if (sessionOperations.get(req.webSessionID) !== reservation || bridgeSessions.has(req.webSessionID) ||
          characterOperations.get(characterID) !== expectedCharacterReservation ||
          hostedSelection && (pendingCustody.length && !ownsCustody ||
            [...bridgeSessions].some(([sessionID, held]) => sessionID !== req.webSessionID && Number(held.characterID) === characterID)))
        throw Object.assign(new Error("The pilot's WC ownership changed before selection."), { code: "CHARACTER_IN_USE", statusCode: 409 });
    };
    assertSelectionCurrent();
    const outcome = await selectHeldCharacter(req.webSessionID, req.account, characterID,
      { assertCurrent: assertSelectionCurrent, hostedSecret: hostedSelection ? hostedSecret : null });
    // Hosted bots already own their claim; browser sessions must complete the
    // nearby lost-flight check before any automation handoff or movement.
    if (botHost.authorizesClaim(characterID, req.get(botHostModule.BOT_HEADER))) {
      bridgeSessions.get(req.webSessionID).droneRecoveryReady = true;
      // Private generation authority, never serialized. A pending request
      // retaining this held object cannot dispatch after the host retires it.
      bridgeSessions.get(req.webSessionID).botClaimSecret = req.get(botHostModule.BOT_HEADER);
    }
    res.json({
      ok: true,
      character: {
        characterID: Number(outcome.session.characterID) || characterID,
        characterName: String(outcome.session.characterName || ""),
        stationID: outcome.session.stationID === undefined
          ? null
          : outcome.session.stationID,
        structureID: outcome.session.structureID === undefined
          ? null
          : outcome.session.structureID,
        solarSystemID: outcome.session.solarSystemID === undefined
          ? null
          : outcome.session.solarSystemID,
        corporationID: outcome.session.corporationID === undefined
          ? null
          : outcome.session.corporationID,
        // The alliance and the corporation roles, as the client's session holds them, where the transport says
        // them (the game port does; the gateway does not, and the page holds none).
        allianceID: outcome.session.allianceID === undefined
          ? null
          : outcome.session.allianceID,
        corpRole: typeof outcome.session.corpRole === "string" && /^\d+$/.test(outcome.session.corpRole)
          ? outcome.session.corpRole
          : null,
        // session.role, the session's own roles (a GM's among them), where the transport says them: the game port
        // does.
        role: typeof outcome.session.role === "string" && /^\d+$/.test(outcome.session.role)
          ? outcome.session.role
          : null,
        corpAccountKey: Number.isSafeInteger(outcome.session.corpAccountKey) ? outcome.session.corpAccountKey : null,
        raceID: Number.isSafeInteger(outcome.session.raceID) ? outcome.session.raceID : null,
      },
      station: buildStationStatic(outcome.session.stationID),
      notifications: outcome.notifications,
      droneRecoveryCheckID: bridgeSessions.get(req.webSessionID)?.droneRecoveryCheckID ?? null,
    });
    } finally {
      if (sessionOperations.get(req.webSessionID) === reservation) sessionOperations.delete(req.webSessionID);
      if (ownsCharacterReservation && characterOperations.get(characterID) === reservation) characterOperations.delete(characterID);
    }
  } catch (error) {
    next(error);
  }
});

// Release the persistent session this web login holds (character goes offline
// through the same disconnect path a retail socket close runs).
app.post("/api/bridge/release", requireAuth, async (req, res, next) => {
  try {
    if (sessionOperations.has(req.webSessionID)) {
      res.status(409).json({ ok: false, error: "CHARACTER_IN_USE", message: "This pilot is changing sessions. Try again shortly." });
      return;
    }
    const held = bridgeSessions.get(req.webSessionID);
    if (held && hasPendingRecovery(held, held.characterID) &&
        !botHost.authorizesClaim(held.characterID, req.get(botHostModule.BOT_HEADER))) {
      res.status(409).json({ ok: false, error: "DRONE_RECOVERY_PENDING",
        message: "Finish nearby drone recovery before releasing this pilot." });
      return;
    }
    if (held && characterOperations.has(held.characterID)) {
      res.status(409).json({ ok: false, error: "CHARACTER_IN_USE", message: "This pilot is changing sessions. Try again shortly." });
      return;
    }
    const released = await releaseHeldBridgeSession(req.webSessionID, { confirmed: true });
    res.json({ ok: true, released });
  } catch (error) {
    next(error);
  }
});

// --- R3 Inventory & Ship (bound-object bridge) -----------------------------
// The browser refers to inventories and ships by their GAME IDs; the BFF maps
// those to bound-object handles it holds server-side and drives the retail
// two-step (bind then bound method) on the gateway. Handles never reach the
// browser. Wire contract: docs/bridge-wire-contract.md.

const ITEM_FLAG_HANGAR = 4;
const ITEM_FLAG_CARGO_HOLD = 5;
/** dogma's `capacity`: a ship's cargo hold, as godma has it. */
const ATTRIBUTE_CAPACITY = 38;
// A placeholder groupStation bind tuple for ship.MachoBindObject; EveJS's ship
// bind mints an OID and ignores bindParams (the retail moniker is
// Moniker('ship',(stationID,groupStation))).
const SHIP_BIND_GROUP_STATION = 5;

function requireHeldBridgeSession(req, res) {
  // Before anything else: a pilot the customs-export hop has on the game port
  // is coming straight back, and must not be reported as lost (gamePortHolds).
  if (heldOnGamePort(req.webSessionID)) {
    res.status(409).json({
      ok: false,
      error: "CHARACTER_IN_USE",
      message: "This pilot is launching from its colonies. Try again in a moment.",
    });
    return null;
  }
  const held = bridgeSessions.get(req.webSessionID) || null;
  if (!held) {
    res.status(409).json({
      ok: false,
      error: "NO_LIVE_SESSION",
      message: "No character is online; select a character first.",
    });
    return null;
  }
  assertHeldRequestGeneration(req, held);
  return held;
}

function assertHeldRequestGeneration(req, held) {
  if (held.selectionReleaseUnverified && req.path !== "/api/bridge/release")
    throw Object.assign(new Error("The prior selection's session release is unconfirmed. Retry its logout first."),
      { code: "PILOT_RELEASE_UNVERIFIED", statusCode: 409 });
  const secret = req.get(botHostModule.BOT_HEADER);
  // A cockpit may attach to hosted GET readouts. Writes and requests naming a
  // hosted generation must belong to the generation that selected this session.
  // (The generic call is a read where it names one: the page makes its own writes by it. writesByTheGenericCall.)
  const readOnly = req.method === "GET" || (req.path === "/api/bridge/call" && !writesByTheGenericCall(req));
  if (held.botClaimSecret && (!readOnly || secret) &&
      (secret !== held.botClaimSecret || !botHost.authorizesClaim(held.characterID, secret))) {
    throw Object.assign(new Error("The requesting hosted controller generation is no longer current."),
      { code: "HOSTED_GENERATION_CHANGED", statusCode: 409 });
  }
}

function assertCurrentHeldSession(held, webSessionID) {
  if (bridgeSessions.get(webSessionID) !== held) {
    throw Object.assign(new Error("The pilot session changed before this call."),
      { code: "NO_LIVE_SESSION", statusCode: 409 });
  }
  if (held.selectionReleaseUnverified)
    throw Object.assign(new Error("The prior selection's session release is unconfirmed. Retry its logout first."),
      { code: "PILOT_RELEASE_UNVERIFIED", statusCode: 409 });
  if (held.botClaimSecret && !botHost.authorizesClaim(held.characterID, held.botClaimSecret)) {
    throw Object.assign(new Error("The hosted controller generation changed before this call."),
      { code: "HOSTED_GENERATION_CHANGED", statusCode: 409 });
  }
  held.maintenanceCurrent?.();
}

// The browser cannot leave the recovery grid while its login check is
// unresolved. StopShip remains available; the hosted bot's own claim is not a
// browser recovery session. All normal flight entry points share this gate.
app.use("/api/bridge/flight", requireAuth, (req, res, next) => {
  if (req.method === "POST" && req.path !== "/stop" && heldBackForDroneRecovery(req, res)) return;
  next();
});
// The page orders its ship by the generic call too (the plan's Phase 6b), and that call's handler asks this of
// each order: every write of the page's own on beyonce was one of the flight routes above, and the stop is CmdStop.
/** Answers a request for a pilot whose lost-drone check is unresolved, a hosted bot's own aside. True where it did. */
function heldBackForDroneRecovery(req, res) {
  const held = bridgeSessions.get(req.webSessionID);
  if (held && hasPendingRecovery(held, held.characterID) &&
      !botHost.authorizesClaim(held.characterID, req.get(botHostModule.BOT_HEADER))) {
    res.status(409).json({ ok: false, error: "DRONE_RECOVERY_PENDING",
      message: "Finish nearby lost-drone recovery before moving this pilot." });
    return true;
  }
  return false;
}

function inventoryLocationID(held) {
  return "dockedLocationID" in held ? held.dockedLocationID : held.stationID;
}

async function assertDockedInventoryAccess(held, webSessionID, serviceID = 1) {
  const outcome = await readHeldFlight(held, webSessionID);
  if (outcome.flight?.docked !== true || !inventoryLocationID(held)) {
    throw Object.assign(new Error("Dock before using the hangar."),
      { code: "NOT_DOCKED", statusCode: 409 });
  }
  if (held.structureID) await assertStructureService(held, webSessionID, held.structureID, serviceID);
  return inventoryLocationID(held);
}

/**
 * A call the client makes on an inventory's own object: what invCache.GetInventoryFromId(itemID) answered for a
 * thing (a ship, a container, a customs office), or what invCache.GetInventory(const.containerHangar) answered
 * for the hangar of where the pilot is docked. The page says which (bridgeCallPolicy.js, PAGE_OBJECT_CALLS:
 * "inventory"): a thing's number, or "hangar". It is bound as the inventory's routes bound it: the pilot's own
 * ship under the key its other reads share, the hangar only where the pilot is docked (it is asked for nowhere
 * else, and is refused here elsewhere as the routes refused), and, for a pilot docked in a structure, held to
 * that structure, so that a write asked there is not made after the pilot has left. boundCall reads the pilot's
 * place again before every inventory write, whoever asks.
 */
async function inventoryCall(held, webSessionID, of, method, args, kwargs) {
  let spec;
  if (of === "hangar") {
    await assertDockedInventoryAccess(held, webSessionID);
    spec = hangarBindSpec(held);
  } else if (Number(of) === Number(held.activeShipID)) {
    spec = cargoBindSpec(held, held.activeShipID);
  } else {
    // The corporation's office where the pilot is docked is bound as the corporation hangar's read binds it, so that
    // the two are one bind (the client's invCache keeps one inventory a thing) and a write to it is held to the office
    // service a structure has (boundCall). Anything else is bound as a container is.
    const here = inventoryLocationID(held);
    const offices = here ? await readCorpOffices(held, webSessionID).catch(() => []) : [];
    const office = offices.find((each) => each.officeID === Number(of) && each.stationID === here);
    spec = office ? corpOfficeBindSpec(office.officeID) : containerBindSpec(Number(of));
  }
  if (held.structureID) spec = { ...spec, expectedDockedLocationID: inventoryLocationID(held) };
  return boundCall(held, webSessionID, spec, method, args, kwargs);
}

// Bind spec factories for the semantic targets the page addresses.
function hangarBindSpec(held) {
  const locationID = inventoryLocationID(held);
  return {
    key: `hangar:${locationID}`,
    service: "invbroker",
    method: "GetInventory",
    args: [locationID],
    kwargs: null,
  };
}

function cargoBindSpec(held, shipID) {
  return {
    key: `cargo:${shipID}`,
    service: "invbroker",
    method: "GetInventoryFromId",
    args: [shipID],
    kwargs: { passive: 0 },
  };
}

function shipBindSpec(held) {
  const locationID = inventoryLocationID(held);
  return {
    key: `ship:${locationID}`,
    service: "ship",
    method: "MachoBindObject",
    args: [[locationID, SHIP_BIND_GROUP_STATION]],
    kwargs: null,
  };
}

// R4 agent moniker: Moniker('agentMgr', agentID) via MachoBindObject. The bound
// agent is what DoAction / GetMission* / GetAgentLocationWrap dispatch on.
function agentBindSpec(agentID) {
  return {
    key: `agent:${agentID}`,
    service: "agentMgr",
    method: "MachoBindObject",
    args: [Number(agentID)],
    kwargs: null,
  };
}

// R72 PLUMBING — the four OID-bind gateway specs the Phase-2 bound-read batches
// hang off (RB-DOGMA / RB-ENTITY / RB-SCAN / RB-FLEET). Each mints a BOUND HANDLE,
// not entity data; NO bound method is wired here (each Phase-2 bound read is its
// own batch with its own R63 ownership check). The BFF binds them SESSION-SCOPED
// — it passes NO caller-supplied target (args: []) so every gateway derives its
// target from the held session, and the handle stays BFF-side (never browser JS),
// exactly like every other bind. Mirrors the invbroker/ship/agentMgr shape.
//
// dogmaIM binds the active ship's dogma manager; the bound reads resolve the ship
// from the session, so the (ignored) bind param cannot steer a foreign ship.
function dogmaBindSpec() {
  return { key: "dogma", service: "dogmaIM", method: "MachoBindObject", args: [], kwargs: null };
}
// scanMgr.GetSystemScanMgr returns the bound handle for the session's OWN current
// system (server-derived) — a GetXxx, not a MachoBindObject, but it returns a real
// OID substruct so it rides the same /bound/bind two-step.
function systemScanBindSpec() {
  return { key: "scanMgr", service: "scanMgr", method: "GetSystemScanMgr", args: [], kwargs: null };
}
/**
 * A call the client makes on its system's scan manager, scanSvc.GetScanMan(): the object GetSystemScanMgr()
 * answered, kept while the session is in that system. On the game port it is asked so, of the one object the
 * scanner's other calls are made on too. The gateway answers the read (GetFullState) by the service's name, from
 * the session's system; the scanner's writes go by the bind there too, as their routes went (the four product
 * routes, until 2026-10-13).
 */
function systemScanCall(held, webSessionID, method, args, kwargs) {
  return (gamePortPilots && isGamePortHandle(held.bridgeSessionID)) || method !== "GetFullState"
    ? boundCall(held, webSessionID, systemScanBindSpec(), method, args, kwargs)
    : heldTopLevelCall(held, webSessionID, "scanMgr", method, args, kwargs);
}
// ⚠ fleetObjectHandler.MachoBindObject accepts a CALLER fleetID (no membership
// check) and stores it for the bound reads to honor — a binds-arbitrary-OID
// gateway (docs/arg-injection-leak-handoff.md). The BFF passes NO fleetID so it
// binds the session's OWN fleet; the leak risk lives on the Phase-2 bound READ,
// which must add a hard ownership check. Wired because it is the retail prereq.
function fleetBindSpec() {
  return { key: "fleet", service: "fleetObjectHandler", method: "MachoBindObject", args: [], kwargs: null };
}

// Invite acceptance/rejection and reconnect happen before `session.fleetid`
// points at the target fleet. Retail binds the fleet id carried by
// OnFleetInvite (or the saved reconnect record); the bound method then verifies
// the pending invite/member row.
function fleetIDBindSpec(fleetID) {
  return {
    key: `fleet:${fleetID}`,
    service: "fleetObjectHandler",
    method: "MachoBindObject",
    args: [[fleetID]],
    kwargs: null,
  };
}

/**
 * The fleet id out of a GetInitState read envelope, as an EXACT decimal string —
 * or null when the read failed, was refused (the fleetless case), or carried no
 * fleet. The squad board keys on this, so it is the BFF's own answer to "which
 * fleet is this session in", never a value the browser sent.
 *
 * ⚠ NEVER THROUGH Number. A fleet id is a game id that can exceed 2^53 (a live
 * one already reads twelve digits), so a marshaled {type:"long"} is stringified
 * rather than parsed — the same rule web/src/bridge/boundFleet.ts's `idData`
 * follows on the other side of the wire. This reads the two marshaled shapes the
 * gateway sends a util.KeyVal in: {type:"object", args:{type:"dict", entries}}
 * and a bare {type:"dict", entries}. A shape it does not recognise is "unknown",
 * which reads the same as no fleet, and no fleet means no board.
 */
function initStateFleetID(envelope) {
  if (!envelope || envelope.error || !envelope.result) {
    return null;
  }
  const result = envelope.result;
  let entries = null;
  if (result && result.type === "object" && result.args && result.args.type === "dict") {
    entries = result.args.entries;
  } else if (result && result.type === "dict") {
    entries = result.entries;
  }
  if (!Array.isArray(entries)) {
    return null;
  }
  const row = entries.find((entry) => Array.isArray(entry) && entry[0] === "fleetID");
  if (!row) {
    return null;
  }
  const value = row[1];
  const raw =
    value !== null && typeof value === "object" && value.type === "long" ? value.value : value;
  if (typeof raw === "number") {
    return Number.isSafeInteger(raw) && raw > 0 ? String(raw) : null;
  }
  if (typeof raw === "string" && /^\d+$/.test(raw) && raw !== "0") {
    return raw;
  }
  return null;
}

// Fleet handles capture a fleet id at bind time. Membership can change without the
// gateway session changing (create / accept / leave / disband), so treating `fleet`
// like an ordinary session-lifetime cache can either keep showing FleetNotFound after
// a join or, worse, keep reading the roster of a fleet the character has left. Drop
// every fleet-flavoured handle at membership boundaries and before an own-fleet read;
// the five reads in one batch still share the single in-flight replacement bind.
function invalidateFleetBoundHandles(held) {
  for (const key of held.boundHandles.keys()) {
    if (key === "fleet" || key.startsWith("fleet:") || key.startsWith("fleet-create:")) {
      held.boundHandles.delete(key);
    }
  }
}

// R77 PLUMBING — the RB-PI planet bind. Retail addresses the planetary-industry
// bound reads on Moniker("planetMgr", planetID) (eveMoniker.GetPlanet), a genuine
// bound two-step: planetMgr.MachoBindObject(planetID) mints the OID handle keyed
// on the planetID, and the reads dispatch as bound methods. The BIND itself is
// read-safe — a planetID is public celestial geography (the same id
// GetPlanetsForChar returns), and the handler reads no colony. Binding to the
// caller's requested planetID also SETS session._planetMgrLastPlanetID, which is
// how the two {allowArgs:false} reads (GetResourceData, GetProgramResultInfo)
// recover the planetID when their own args do not carry it. Keyed per planetID so
// distinct planets get distinct cached handles.
function planetBindSpec(planetID) {
  return {
    key: `planet:${Number(planetID)}`,
    service: "planetMgr",
    method: "MachoBindObject",
    args: [Number(planetID)],
    kwargs: null,
  };
}

// Dispatch a bound method, binding the target on demand and caching the bind
// under its semantic key. The cache holds the in-flight bind PROMISE, so the
// concurrent reads of one panel load (List + GetCapacity per container) share a
// single bind instead of racing to create duplicate OIDs. A reaped OID
// (BOUND_HANDLE_NOT_FOUND) rebinds once; a lost persistent session drops the
// whole held session (as /api/bridge/call).
async function boundCall(held, webSessionID, bindSpec, method, args, kwargs, bindNotifications = null) {
  assertCurrentHeldSession(held, webSessionID);
  if (bindSpec.service === "invbroker" &&
      ["Add", "MultiAdd", "MultiMerge", "StackAll", "TrashItems", "SplitStack", "FitFitting"].includes(method)) {
    // A picked structure or earlier service read is not mutation authority.
    // Recheck the live location and access before every inventory write.
    const flight = await readHeldFlight(held, webSessionID);
    if (bindSpec.expectedShipID && flight.flight?.shipID !== bindSpec.expectedShipID) {
      throw Object.assign(new Error("The active ship changed before inventory transfer."), { code: "INVENTORY_SHIP_CHANGED", statusCode: 409 });
    }
    if (bindSpec.expectedDockedLocationID &&
        (flight.flight?.docked !== true || inventoryLocationID(held) !== bindSpec.expectedDockedLocationID ||
         (isPlayerStructureID(bindSpec.expectedDockedLocationID) && held.structureID !== bindSpec.expectedDockedLocationID))) {
      throw Object.assign(new Error("The pilot left the intended docked inventory location."),
        { code: "INVENTORY_LOCATION_CHANGED", statusCode: 409 });
    }
    if (flight.flight?.docked === true && held.structureID) {
      await assertStructureService(held, webSessionID, held.structureID,
        bindSpec.key.startsWith("corpOffice:") ? 3 : 1);
    }
    if ((bindSpec.key.startsWith("hangar:") || bindSpec.key.startsWith("invManager:")) &&
        !bindSpec.key.endsWith(`:${inventoryLocationID(held)}`)) {
      throw Object.assign(new Error("Docked location changed before inventory transfer."),
        { code: "INVENTORY_LOCATION_CHANGED", statusCode: 409 });
    }
  }
  const sessionFields = { userid: held.accountID };
  function ensureHandle(forceRebind) {
    assertCurrentHeldSession(held, webSessionID);
    if (!forceRebind && held.boundHandles.has(bindSpec.key)) {
      return held.boundHandles.get(bindSpec.key);
    }
    const bindPromise = gateway
      .bindObject(
        bindSpec.service,
        bindSpec.method,
        bindSpec.args,
        bindSpec.kwargs,
        sessionFields,
        held.bridgeSessionID,
      )
      .then((bound) => {
        if (bindNotifications && Array.isArray(bound.notifications)) bindNotifications.push(...bound.notifications);
        return bound.boundHandle;
      })
      .catch((error) => {
        // Never cache a failed bind.
        if (held.boundHandles.get(bindSpec.key) === bindPromise) {
          held.boundHandles.delete(bindSpec.key);
        }
        // Name the target on the way past. A bind refusal says only WHAT the
        // gateway thought (`FakeItemNotFound`), never WHICH bind asked — and
        // one panel load fires four of them, so the log cannot otherwise tell
        // a despawned can from a stale active ship. `errorLogger` prints an
        // Error's own properties, so this rides out beside code/statusCode.
        // Set once: the first (innermost) bind to fail owns the name.
        if (error && typeof error === "object" && error.bindKey === undefined) {
          error.bindKey = bindSpec.key;
        }
        throw error;
      });
    held.boundHandles.set(bindSpec.key, bindPromise);
    return bindPromise;
  }
  async function dispatch(forceRebind) {
    const handle = await ensureHandle(forceRebind);
    assertCurrentHeldSession(held, webSessionID);
    return gateway.callBoundMethod(
      bindSpec.service,
      method,
      args,
      kwargs,
      sessionFields,
      held.bridgeSessionID,
      handle,
    );
  }
  try {
    return await dispatch(false);
  } catch (error) {
    if (error && error.code === "SESSION_NOT_FOUND") {
      forgetBridgeSession(webSessionID, held);
      throw error;
    }
    if (error && error.code === "BOUND_HANDLE_NOT_FOUND") {
      held.boundHandles.delete(bindSpec.key);
      return dispatch(true);
    }
    throw error;
  }
}

/**
 * A type's own volume in m³ from the static tables, nought where it is nought (956 published types: blueprints,
 * some modules and more), as the client's GetItemVolume has it; null only where the tables do not know the type.
 * The hold reckoning (usedOfListed), the routes that list items (readTypeVolumes) and GET /api/types/volumes all go
 * by it.
 *
 * A REFERENCE LOOKUP MUST NOT BE ABLE TO BREAK A ROUTE. Volume is an enrichment: without it a panel shows "—" and
 * a bot hands the server the whole stack to judge, both of which are defined behaviours. A static table that cannot
 * answer therefore says null, never a 500 on a read the player asked for.
 */
function staticTypeVolume(typeID) {
  if (typeof staticData.getType !== "function") return null;
  const type = staticData.getType(typeID);
  const volume = type && type.volume !== null && type.volume !== undefined ? Number(type.volume) : NaN;
  return Number.isFinite(volume) ? volume : null;
}

/**
 * A hold's capacity as the retail client reckons it, from a List that has
 * answered: the capacity handed in, and the volume of what the List holds in
 * that flag (src/clientData/holdCapacity.js). Null where it cannot be reckoned:
 * the List failed, or something in the hold has a volume nobody here knows.
 */
function reckonedCapacity(settledList, flag, capacity, packaged) {
  if (settledList.status !== "fulfilled") return null;
  const used = usedOfListed(settledList.value.result, flag, packaged);
  return used === null ? null : capacityAnswer(capacity, used);
}

// Load the full Inventory & Ship panel: station hangar + active-ship cargo,
// each with its List and its capacity. The reads are INDEPENDENT
// (Promise.allSettled) so one failed read never blanks the rest (R2's rule).
//
// ⚠ THE RETAIL CLIENT NEVER ASKS THE SERVER HOW FULL A HOLD IS. Its inventory
// cache reckons a capacity itself (invCache.py 1224), and godma a ship's
// (godma.py 871). On the game port this route does the same: a station's hangar
// has the client's own figure for a place with no limit, the cargo has the
// ship's capacity as godma holds it, and what is used of each is summed from
// its List by the client's own rule with the client's own packaged volumes.
// Where that cannot be followed (no client to read the volumes from, godma not
// knowing the ship, a thing whose volume is not known), and on the gateway,
// GetCapacity is asked as before.
app.get("/api/bridge/inventory", requireAuth, async (req, res, next) => {
  const held = requireHeldBridgeSession(req, res);
  if (!held) {
    return;
  }
  try {
    // Sync held station/ship to the live position first, so the hangar/cargo
    // binds target the CURRENT station + active ship after a new dock, not the
    // select-time ones.
    await readHeldFlight(held, req.webSessionID);
    if (held.structureID) await assertStructureService(held, req.webSessionID, held.structureID, 1);
    const shipID = held.activeShipID;
    const hangarSpec = hangarBindSpec(held);
    const cargoSpec = shipID ? cargoBindSpec(held, shipID) : null;
    const noShip = () => Promise.reject(Object.assign(new Error("No active ship."), { code: "NO_ACTIVE_SHIP" }));
    const listOf = (spec, flag) => (spec ? boundCall(held, req.webSessionID, spec, "List", [flag], null) : noShip());
    const askedOf = (spec, flag) => (spec ? boundCall(held, req.webSessionID, spec, "GetCapacity", [flag], null) : noShip());
    const onGamePort = Boolean(gamePortPilots) && isGamePortHandle(held.bridgeSessionID);
    const packaged = onGamePort ? await clientConstants.packagedVolumes() : null;
    // A packaged stack's volume, the client's, for the rows (readTypeVolumes): read on either transport where it can be.
    const packagedForVolumes = packaged ?? await packagedTablesOrNull();
    let hangarList;
    let hangarCap;
    let cargoList;
    let cargoCap;
    if (!packaged) {
      [hangarList, hangarCap, cargoList, cargoCap] = await Promise.allSettled([
        listOf(hangarSpec, ITEM_FLAG_HANGAR),
        askedOf(hangarSpec, ITEM_FLAG_HANGAR),
        listOf(cargoSpec, ITEM_FLAG_CARGO_HOLD),
        askedOf(cargoSpec, ITEM_FLAG_CARGO_HOLD),
      ]);
    } else {
      [hangarList, cargoList] = await Promise.allSettled([
        listOf(hangarSpec, ITEM_FLAG_HANGAR),
        listOf(cargoSpec, ITEM_FLAG_CARGO_HOLD),
      ]);
      const shipCapacity = cargoSpec && typeof gamePortPilots.shipAttribute === "function"
        ? await gamePortPilots.shipAttribute(ATTRIBUTE_CAPACITY, { userid: held.accountID }, held.bridgeSessionID)
        : null;
      // (A structure's hangar has no limit either, and the client shows none for it: its controllers have no
      // capacity, invControllers.py 1796 to 1822. It is said here as a station's is.)
      const hangarOwn = reckonedCapacity(hangarList, ITEM_FLAG_HANGAR, STATION_CAPACITY, packaged);
      const cargoOwn = shipCapacity === null ? null : reckonedCapacity(cargoList, ITEM_FLAG_CARGO_HOLD, shipCapacity, packaged);
      [hangarCap, cargoCap] = await Promise.allSettled([
        hangarOwn ? Promise.resolve({ result: hangarOwn }) : askedOf(hangarSpec, ITEM_FLAG_HANGAR),
        cargoOwn ? Promise.resolve({ result: cargoOwn }) : askedOf(cargoSpec, ITEM_FLAG_CARGO_HOLD),
      ]);
    }

    // A lost live session can't be recovered by any read; surface it so the
    // page returns to character select.
    for (const settled of [hangarList, hangarCap, cargoList, cargoCap]) {
      if (settled.status === "rejected" && settled.reason && settled.reason.code === "SESSION_NOT_FOUND") {
        next(settled.reason);
        return;
      }
    }

    const settledCode = (settled) =>
      settled.status === "rejected"
        ? String((settled.reason && settled.reason.code) || "READ_FAILED")
        : null;
    const settledValue = (settled) =>
      settled.status === "fulfilled" ? settled.value.result : null;

    res.json({
      ok: true,
      stationID: held.stationID,
      structureID: held.structureID,
      activeShipID: shipID,
      hangar: {
        list: settledValue(hangarList),
        capacity: settledValue(hangarCap),
        error: settledCode(hangarList) || settledCode(hangarCap),
      },
      cargo: {
        shipID,
        list: settledValue(cargoList),
        capacity: settledValue(cargoCap),
        error: settledCode(cargoList) || settledCode(cargoCap),
      },
      // Per-type VOLUME (m³) for every type in the hangar/cargo, from static
      // reference data — the SAME read the assets route does, no bridge call and
      // no new allowlist pair — and a packaged stack's own, the client's
      // (readTypeVolumes). The browser needs it to work out how much of
      // a stack fits in a hold before it tries the move; absent for a type the
      // static tables do not know (handled as "unknown", never zero).
      volumes: {
        ...readTypeVolumes(settledValue(hangarList), packagedForVolumes),
        ...readTypeVolumes(settledValue(cargoList), packagedForVolumes),
      },
    });
  } catch (error) {
    next(error);
  }
});

// R73 PLUMBING — the FIRST Phase-2 BOUND-READ batch: the 13 RB-SKILL reads that
// hang off the R72 skill-handler gateway. skillMgr2.GetMySkillHandler returns
// Moniker("skillHandler", null, <session charID>, null); because that is a
// Moniker (not an "N=" OID substruct) the retail client addresses these reads on
// the ORDINARY top-level /call seam with service "skillHandler" — NOT a bound
// two-step. So each dispatches as heldTopLevelCall("skillHandler", <method>).
//
// ⚠ SESSION-SCOPED. Every one of these 13 derives the character from the SESSION
// (SkillMgrService._getCharacterId -> getCharacterIDFromSession) and IGNORES any
// caller-supplied charID; the two arg-taking reads (CheckInjectionConstraints,
// GetDiminishedSpFromInjectors) take an injector item/type id + counts, not a
// charID. Verified LIVE cross-account (Farmer 140000005 vs GM Elysian 140000004:
// injecting Farmer's id returns the caller's OWN skills, never Farmer's) — so the
// browser-supplied-args risk on /api/bridge/call does not apply here.
//
// Independent Promise.allSettled: an empty queue / history / boosters / implants
// and a REFUSED CheckInjectionConstraints (CALL_REFUSED SkillTradingItemNotFound
// when no injector is owned) are legitimate states, never a blanking failure —
// each read carries its own {result} or {error, message}. Returns the raw result
// envelopes for web/src/bridge/boundSkills.ts; NO UI consumes this yet.
const SKILL_BOUND_READS = Object.freeze([
  ["GetSkills", []],
  ["GetAllSkills", []],
  ["GetAttributes", []],
  ["GetSkillHistory", []],
  ["GetSkillChangesForISIS", []],
  ["GetRespecInfo", []],
  ["GetFreeSkillPoints", []],
  ["GetBoosters", []],
  ["GetImplants", []],
  // CheckInjectionConstraints(itemID, quantity) — probed with no owned injector,
  // so it legitimately refuses; a future UI supplies a real injector itemID.
  ["CheckInjectionConstraints", [0, 1]],
  ["GetSkillPoints", []],
  // GetDiminishedSpFromInjectors(typeID, quantity, nonDiminishingRemaining) —
  // typeID 0 is not an injector, so it returns 0 (the empty preview).
  ["GetDiminishedSpFromInjectors", [0, 1, 0]],
  ["GetSkillQueue", []],
]);

app.get("/api/bridge/bound-skills", requireAuth, async (req, res, next) => {
  const held = requireHeldBridgeSession(req, res);
  if (!held) {
    return;
  }
  try {
    const settled = await Promise.allSettled(
      SKILL_BOUND_READS.map(([method, args]) =>
        heldTopLevelCall(held, req.webSessionID, "skillHandler", method, args, null),
      ),
    );
    // A lost live session cannot be recovered by any read; surface it so the page
    // returns to character select (matching /api/bridge/inventory).
    for (const s of settled) {
      if (s.status === "rejected" && s.reason && s.reason.code === "SESSION_NOT_FOUND") {
        next(s.reason);
        return;
      }
    }
    const reads = {};
    SKILL_BOUND_READS.forEach(([method], index) => {
      const s = settled[index];
      if (s.status === "fulfilled") {
        reads[method] = { result: s.value.result };
      } else {
        const reason = s.reason || {};
        reads[method] = {
          error: String(reason.code || "READ_FAILED"),
          message: typeof reason.message === "string" ? reason.message : null,
        };
      }
    });
    res.json({ ok: true, characterID: held.characterID, reads });
  } catch (error) {
    if (error && error.code === "SESSION_NOT_FOUND") {
      forgetBridgeSession(req.webSessionID, held);
    }
    next(error);
  }
});

// R74 PLUMBING — the SECOND Phase-2 BOUND-READ batch: the 11 RB-DOGMA reads that
// hang off the R72 dogma bind. Unlike R73's skills (a Moniker that rides the
// TOP-LEVEL /call seam), dogmaIM.MachoBindObject mints an "N=" OID handle, so
// these ARE the real bound two-step — each dispatches via boundCall against the
// dogmaBindSpec() handle (both added R72; the invbroker reads are the other
// reference). The BFF holds the handle; the browser never sees the OID.
//
// ⚠ SESSION-SCOPED. Every dogma read resolves its target from the SESSION and
// IGNORES the bound OID (dogmaService never consults getBoundObjectParams for a
// read), so bound and top-level dispatch return identical own-ship/char/scene
// data. The five session-derived reads (GetAllInfo/GetTargeters/
// GetCharacterAttributes/GetDroneSettingAttributes/GetLocationInfo) take no id;
// the four item reads (ItemGetInfo/QueryAllAttributesForItem/QueryAttributeValue/
// FullyDescribeAttribute) COERCE a foreign/unknown itemID to the caller's OWN
// ship (_findInventoryItemContext rejects a non-owned item, then the context
// falls back to the session's active ship); GetLayerDamageValuesByItems returns a
// ZEROED sentinel for a foreign item (explicit ownedByOther guard); and
// GetRequiredSkillLevels is STATIC public type metadata. Verified LIVE
// cross-account (Farmer vs Test Two) — foreign itemID never leaks the foreign
// item. No handoff-doc flag needed.
//
// ⚠ GetAllInfo alone fires afterCallResponse side effects (post-GetAllInfo charge
// refresh / post-undock dogma multi-event / character dogma-state sync) — the
// routine retail bootstrap recompute; non-destructive and drained into the
// response notifications. The other ten reads trigger nothing.
//
// Independent Promise.allSettled: an empty targeter list (docked, nobody locking
// you), an empty required-skill dict (typeID 0) and an empty layer-damage dict
// (no items requested) are legitimate states, never a blanking failure — each
// read carries its own {result} or {error, message}. Returns the raw result
// envelopes for web/src/bridge/boundDogma.ts; NO UI consumes this yet.
//
// ⚠ ONE READ, SINCE 2026-10-09. The Fitting window opens this route and reads
// GetAllInfo out of it and nothing else, and GetAllInfo is the one read the
// retail client's godma makes of the dogma location (godma.py 2409). The route
// used to ask ten more with every opening: an item with no ID and the drones'
// damage with no drones, which the client never asks so, and seven the client
// never asks at all. They are still allowlisted, and still decodable
// (web/src/bridge/boundDogma.ts), for whatever comes to need one with a real
// item to ask about; this route does not ask them for nothing.
const DOGMA_BOUND_READS = Object.freeze([
  // GetAllInfo(primeCharacter, primeShip, primeStructure): the whole ship, character
  // and module snapshot. Asked with none, the game port sends godma's first priming.
  ["GetAllInfo", []],
]);

app.get("/api/bridge/bound-dogma", requireAuth, async (req, res, next) => {
  const held = requireHeldBridgeSession(req, res);
  if (!held) {
    return;
  }
  const spec = dogmaBindSpec();
  try {
    const settled = await Promise.allSettled(
      DOGMA_BOUND_READS.map(([method, args]) =>
        boundCall(held, req.webSessionID, spec, method, args, null),
      ),
    );
    // A lost live session cannot be recovered by any read; surface it so the page
    // returns to character select (matching /api/bridge/inventory).
    for (const s of settled) {
      if (s.status === "rejected" && s.reason && s.reason.code === "SESSION_NOT_FOUND") {
        next(s.reason);
        return;
      }
    }
    const reads = {};
    DOGMA_BOUND_READS.forEach(([method], index) => {
      const s = settled[index];
      if (s.status === "fulfilled") {
        reads[method] = { result: s.value.result };
      } else {
        const reason = s.reason || {};
        reads[method] = {
          error: String(reason.code || "READ_FAILED"),
          message: typeof reason.message === "string" ? reason.message : null,
        };
      }
    });
    res.json({ ok: true, characterID: held.characterID, reads });
  } catch (error) {
    if (error && error.code === "SESSION_NOT_FOUND") {
      forgetBridgeSession(req.webSessionID, held);
    }
    next(error);
  }
});

// R77 PLUMBING — the FIFTH Phase-2 BOUND-READ batch: the 7 RB-PI reads (planetary-
// industry colony + resource geography) that bind to a planetID. Unlike R73/R76's
// session-global monikers (top-level /call seam), these ride the REAL bound two-
// step off planetMgr.MachoBindObject(planetID) (mirrors /api/bridge/bound-dogma /
// bound-inventory) — the BFF holds the handle, the browser never sees the OID. The
// route requires a ?planetID (a UI reaches it from GetPlanetsForChar, R71). Six of
// the seven also accept the planetID in args ({allowArgs:true}); the two that do
// NOT (GetResourceData / GetProgramResultInfo) recover it from the bind that
// planetBindSpec establishes.
//
// ⚠ OWNERSHIP is SPLIT for this batch (verified live cross-account, Farmer 140000005
// owns colony planetID 40009077 vs Test Two 140000002). This route is SESSION-SCOPED
// so it never leaks: ownerID defaults to held.characterID (the caller's OWN char),
// so GetFullNetworkForOwner reads the caller's own colony, and GetPlanetInfo's colony
// body is server-scoped to session.characterID regardless. But the HANDLERS leak
// under attacker-chosen args on /api/bridge/call (NOT via this route):
// GetFullNetworkForOwner(planetID, ownerID) returns ANY (planetID, ownerID) colony's
// full network with no session check, and GetCommandPinsForPlanet /
// GetExtractorsForPlanet list ALL owners' pins on a planetID — an arg-injection leak
// flagged in docs/arg-injection-leak-handoff.md, kept pre-plumbed (operator flag-
// only). GetPlanetResourceInfo / GetResourceData (static per-planet resource
// geography) and GetProgramResultInfo (a computed extractor-yield estimate) read no
// colony ownership — safe for everyone.
//
// Independent Promise.allSettled: a planet with no colony (empty network / no command
// pins / no extractors) and a zeroed program estimate are legitimate states, never a
// blanking failure — each read carries its own {result} or {error, message}. Returns
// the raw result envelopes for web/src/bridge/boundPlanets.ts; NO UI consumes this yet.
const PLANET_PROGRAM_HEAD_RADIUS = 0.1;
function planetBoundReads(planetID, ownerID, resourceTypeID) {
  const pid = Number(planetID) || 0;
  const oid = Number(ownerID) || 0;
  const rtid = Number(resourceTypeID) || 0;
  return [
    // GetPlanetInfo(planetID) — static celestial geography + (only) the SESSION
    // char's own colony body (KeyVal). Foreign colony never appears here.
    ["GetPlanetInfo", [pid]],
    // GetPlanetResourceInfo(planetID) — a CachedMethodCallResult wrapping a dict
    // {resourceTypeID -> quality} of the static per-planet resource field.
    ["GetPlanetResourceInfo", [pid]],
    // GetResourceData({resourceTypeID,oldBand,newBand,proximity}) — planetID from the
    // bind; the per-resource distribution band bytes {data, numBands, proximity}. A
    // UI supplies a real resourceTypeID (0 → an empty/default band read).
    ["GetResourceData", [{ resourceTypeID: rtid, oldBand: 0, newBand: 15, proximity: 0 }]],
    // GetFullNetworkForOwner(planetID, ownerID) — [pins(list of KeyVal), links(list of
    // [endpoint1,endpoint2])]. ownerID is the SESSION's own char here (never foreign).
    ["GetFullNetworkForOwner", [pid, oid]],
    // GetCommandPinsForPlanet(planetID) — dict {ownerID -> command-pin KeyVal} across
    // all colonies on the planet.
    ["GetCommandPinsForPlanet", [pid]],
    // GetExtractorsForPlanet(planetID) — list of extractor KeyVals across all colonies.
    ["GetExtractorsForPlanet", [pid]],
    // GetProgramResultInfo(planetID-ignored, resourceTypeID, heads, headRadius) —
    // planetID from the bind; a computed [qtyToDistribute, cycleTime, numCycles]
    // extractor-yield estimate (bigint-safe). Empty heads → a zeroed-qty estimate.
    ["GetProgramResultInfo", [pid, rtid, [], PLANET_PROGRAM_HEAD_RADIUS]],
  ];
}

/**
 * GET /api/pi/planet-richness?planetIDs=a,b,c -- each planet's resource
 * richness, the game's own GetPlanetResourceInfo, on the tab's HELD session.
 *
 * Only that one read, never the other six /bound-planet makes: richness is
 * static per planet and safe for anyone (see planetBoundReads), so a page that
 * wants it for fifty planets should not also ask fifty colonies' networks.
 * A few at a time, each planet answering for itself; the raw marshaled result
 * goes back for web/src/bridge/boundPlanets.ts to decode.
 */
const PLANET_RICHNESS_MAX_IDS = 60;
const PLANET_RICHNESS_PARALLEL = 4;
app.get("/api/pi/planet-richness", requireAuth, async (req, res, next) => {
  const held = requireHeldBridgeSession(req, res);
  if (!held) {
    return;
  }
  const planetIDs = [...new Set(String(req.query.planetIDs || "").split(",").map((id) => Number(id)).filter((id) => Number.isSafeInteger(id) && id > 0))];
  if (planetIDs.length > PLANET_RICHNESS_MAX_IDS) {
    res.status(400).json({ ok: false, error: "TOO_MANY_PLANETS", message: `Ask about at most ${PLANET_RICHNESS_MAX_IDS} planets at a time.` });
    return;
  }
  try {
    const planets = new Array(planetIDs.length);
    let nextIndex = 0;
    const worker = async () => {
      while (nextIndex < planetIDs.length) {
        const index = nextIndex++;
        const planetID = planetIDs[index];
        try {
          const read = await boundCall(held, req.webSessionID, planetBindSpec(planetID), "GetPlanetResourceInfo", [planetID], null);
          planets[index] = { planetID, result: read.result };
        } catch (error) {
          if (error && error.code === "SESSION_NOT_FOUND") throw error;
          planets[index] = { planetID, error: String((error && error.code) || "READ_FAILED") };
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(PLANET_RICHNESS_PARALLEL, planetIDs.length) }, worker));
    res.json({ ok: true, characterID: held.characterID, planets });
  } catch (error) {
    if (error && error.code === "SESSION_NOT_FOUND") {
      forgetBridgeSession(req.webSessionID, held);
    }
    next(error);
  }
});

// R85 — the 5 RB-FLEET Phase-2 BOUND reads (roster/init-state, wings, MOTD,
// join-requests, composition), the LAST Phase-2 bound-read batch — CLOSES Phase-2
// bound reads (111/111). PLUMBING ONLY — no UI, no writes. Retail addresses these
// on the fleet bound Moniker (fleetObjectHandler.MachoBindObject), a genuine bound
// two-step: the bind mints the OID handle keyed on the session's fleetID and the
// reads dispatch as bound methods. This route rides boundCall over fleetBindSpec()
// (the R72 bind, session-scoped: NO fleetID arg → the session's OWN fleet), same as
// /api/bridge/bound-inventory / bound-planet — the BFF holds the handle, the browser
// never sees the OID.
//
// ⚠ OWNERSHIP: this route is SESSION-SCOPED and never leaks — fleetBindSpec() passes
// no fleetID, so the bound context is the session's own fleet (fleetid 0 → no fleet,
// which is the real state for a docked/fleetless char). But ALL FIVE HANDLERS leak
// under attacker-chosen args on /api/bridge/call (NOT via this route): a browser can
// POST /api/bridge/call {service:"fleetObjectHandler", method:"MachoBindObject",
// args:[[<rival fleetID>]]} to mint a handle bound to a FOREIGN fleet, then the bound
// read off it returns that fleet's roster/wings/MOTD/join-requests/composition with no
// membership check — the R72 BINDS-ARBITRARY-OID gateway, flagged in
// docs/arg-injection-leak-handoff.md, kept pre-plumbed (operator flag-only). None of
// fleetRuntime.getFleetState/getWings/getMotd/getJoinRequests/getFleetComposition calls
// ensureFleetMembership (that gate guards only the fleet WRITES).
//
// Independent Promise.allSettled: with no fleet, ensureFleetExists(0) throws
// FleetNotFound, so each read comes back as {error:"CALL_REFUSED", message:
// "FleetNotFound"} (verified live) — a LEGITIMATE "not in a fleet" state, never a
// blanking failure. A char IN a fleet gets
// the populated envelopes. Each read carries its own {result} or {error, message}.
// Returns the raw result envelopes for web/src/bridge/boundFleet.ts; NO UI consumes
// this yet.
/** The five things the route reads of a fleet. */
const FLEET_READ_METHODS = Object.freeze(["GetInitState", "GetWings", "GetMotd", "GetJoinRequests", "GetFleetComposition"]);

app.get("/api/bridge/bound-fleet", requireAuth, async (req, res, next) => {
  const held = requireHeldBridgeSession(req, res);
  if (!held) {
    return;
  }
  // Re-resolve the session's current membership on every panel refresh. A fleet OID
  // is membership-scoped, not valid for the full lifetime of the selected character.
  invalidateFleetBoundHandles(held);
  // fleetSvc.py 254, 366: the client asks nothing of a fleet unless session.fleetid says the pilot is in one.
  // On the game port the session is the server's own, so its word is taken and nothing is asked.
  let own = null;
  if (gamePortPilots && isGamePortHandle(held.bridgeSessionID) && typeof gamePortPilots.fleet === "function") {
    try {
      own = gamePortPilots.fleet({ userid: held.accountID }, held.bridgeSessionID);
    } catch (error) {
      if (error && error.code === "SESSION_NOT_FOUND") forgetBridgeSession(req.webSessionID, held);
      next(error);
      return;
    }
    if (own.fleetID === null) {
      held.fleetID = null;
      res.json({
        ok: true,
        characterID: held.characterID,
        fleetID: null,
        membership: "none",
        reads: Object.fromEntries(FLEET_READ_METHODS.map((method) => [method, { error: "NOT_ASKED", message: null }])),
        notifications: [],
      });
      return;
    }
    // fleetSvc.InitFleet (254 to 258): without its fleet's object the client asks nothing of its fleet, whatever the
    // session says, and it has that object only from CreateFleet or an invitation it accepted (334, 1195); the game
    // port holds one the same way (pilots.js afterFleetCall). Where none is held the session's fleet is said and
    // nothing is asked (until 2026-10-15 the BFF bound one afresh here and asked all five reads).
    if (own.holdsObject !== true) {
      held.fleetID = String(own.fleetID);
      res.json({
        ok: true,
        characterID: held.characterID,
        fleetID: held.fleetID,
        reads: Object.fromEntries(FLEET_READ_METHODS.map((method) => [method, { error: "NOT_ASKED", message: null }])),
        notifications: [],
      });
      return;
    }
  }
  // fleetSvc.py reads a fleet's state once and keeps it right from the server's notices, its wings and its message
  // with it. Where the game port holds the fleet's object it keeps the fleet the same way (pilots.js fleetKept),
  // and those reads are answered from what is kept. With nothing kept they are asked of that object.
  let kept = null;
  if (own) {
    try {
      kept = await gamePortPilots.fleetKept({ userid: held.accountID }, held.bridgeSessionID);
    } catch (error) {
      if (error && error.code === "SESSION_NOT_FOUND") {
        forgetBridgeSession(req.webSessionID, held);
        next(error);
        return;
      }
    }
  }
  const spec = fleetBindSpec();
  const FLEET_READS = [
    // GetInitState() — the full fleet KeyVal {motd, options, fleetID, members(dict),
    // isLootLogging, squads(dict), wings(dict)}.
    ["GetInitState", []],
    // GetWings() — dict {wingID -> wing KeyVal{wingID, name, squads(dict)}}.
    ["GetWings", []],
    // GetMotd() — the MOTD string.
    ["GetMotd", []],
    // GetJoinRequests() — dict {charID -> join-request KeyVal{charID, corpID,
    // allianceID, warFactionID, securityStatus}}.
    ["GetJoinRequests", []],
    // GetFleetComposition() — list of composition KeyVals {characterID, solarSystemID,
    // stationID, shipTypeID, skills, skillIDs}.
    ["GetFleetComposition", []],
  ];
  try {
    const notifications = kept ? [...kept.notifications] : [];
    const settled = await Promise.allSettled(
      FLEET_READS.map(([method, args]) => (kept && Object.hasOwn(kept, method)
        ? { result: kept[method] }
        : boundCall(held, req.webSessionID, spec, method, args, null, notifications))),
    );
    // A lost live session cannot be recovered by any read; surface it so the page
    // returns to character select (matching /api/bridge/bound-planet).
    for (const s of settled) {
      if (s.status === "rejected" && s.reason && s.reason.code === "SESSION_NOT_FOUND") {
        next(s.reason);
        return;
      }
    }
    const reads = {};
    FLEET_READS.forEach(([method], index) => {
      const s = settled[index];
      if (s.status === "fulfilled") {
        reads[method] = { result: s.value.result };
        if (Array.isArray(s.value.notifications)) notifications.push(...s.value.notifications);
      } else {
        const reason = s.reason || {};
        reads[method] = {
          error: String(reason.code || "READ_FAILED"),
          message: typeof reason.message === "string" ? reason.message : null,
        };
      }
    });
    // ⚠ THE ONLY PLACE THE BFF LEARNS WHICH FLEET A SESSION IS IN. `held.fleetID`
    // has been READ here since this route landed and was never written anywhere:
    // it answered null for every session, which is why the client decoder takes
    // GetInitState's own fleetID over it (boundFleet.ts, "the read outranks the
    // cached field"). GetInitState is the fleet answering for itself, so it is
    // what the BFF stamps too — refreshed on every read, because membership
    // changes without the session changing.
    //
    // ANYTHING BUT A CLEAN FLEET ID CLEARS IT. A refused read (fleetless reads
    // come back {error:"CALL_REFUSED", message:"FleetNotFound"}) and a failed one
    // are treated alike on purpose: keeping the last known fleet would let a
    // character who has LEFT keep reading that fleet's squad-board calls, and the
    // board is advisory — a pilot whose fleet is momentarily unknown just falls
    // back to its own target ladder, which is a working bot.
    held.fleetID = initStateFleetID(reads.GetInitState);
    res.json({
      ok: true,
      characterID: held.characterID,
      fleetID: held.fleetID || null,
      reads,
      notifications,
    });
  } catch (error) {
    if (error && error.code === "SESSION_NOT_FOUND") {
      forgetBridgeSession(req.webSessionID, held);
    }
    next(error);
  }
});

// (A thing moved between the hangar and the ship's hold had a route of its own, POST /api/bridge/inventory/move,
// which nothing of the page asked: the page moves things by the transfer. It went on 2026-10-13.)

// (Stack All of the hangar or the ship's hold is the page's own call since 2026-10-14, as the client's window asks
// it: StackAll(the place's flag) on the place's own inventory (bridgeCallPolicy.js, PAGE_OBJECT_CALLS: "inventory";
// web/src/bridge/inventoryWrites.ts). The route, POST /api/bridge/inventory/stack, is gone.)

// --- R14 Inventory depth + corporation hangars -----------------------------
// All of this is the SAME R3 bound-object bridge above, with arguments R3
// hardcoded away. Nothing here forks a parallel path: every route goes through
// boundCall() and the shared bind/handle cache.
//
//   split a stack   Add(itemID, sourceLocationID, qty=<partial>)
//   multi-move      MultiAdd(itemIDs, sourceLocationID, flag=<dest>)
//   re-merge        MultiMerge([[src,dst,qty]], sourceContainerID)
//   open container  GetInventoryFromId(containerID) then List() with NO FLAG
//   corp hangar     GetInventoryFromId(officeID) then List(<division flag>)
//   trash           TrashItems(itemIDs, locationID) — DESTRUCTIVE, confirm-gated
//
// The browser never sends a flagID or a division flag: it names a place
// ("hangar", "cargo", a container's itemID, a corp division NUMBER 1-7) and the
// mapping to retail flags lives here.

// Container contents carry flagID 0 — NOT 4/5. A container is therefore listed
// with no flag at all, and an item filed INTO one must be given flag 0
// explicitly (a container binding's flag context is null, and a null flag falls
// back to the hangar flag).
const ITEM_FLAG_NONE = 0;
// flagCorpSAG1..7 = 115..121. Division N maps to 114 + N. These numbers never
// reach the browser; it addresses a division by its ordinal and sees its NAME.
const CORP_DIVISION_FLAG_BASE = 114;
const CORP_DIVISION_COUNT = 7;

function corpDivisionFlag(division) {
  return CORP_DIVISION_FLAG_BASE + division;
}

function isValidDivision(division) {
  return Number.isSafeInteger(division) && division >= 1 && division <= CORP_DIVISION_COUNT;
}

// A container binds with the IDENTICAL call ship cargo binds with — there is no
// container-specific bind method, and container-ness is a client-side
// static-data question the server never asks.
function containerBindSpec(containerID) {
  return {
    key: `container:${containerID}`,
    service: "invbroker",
    method: "GetInventoryFromId",
    args: [containerID],
    kwargs: { passive: 0 },
  };
}

// The corporation's office at this station. See readCorpOffice() for why the
// identifier bound here is the PUBLISHED one and what it is not.
function corpOfficeBindSpec(officeID) {
  return {
    key: `corpOffice:${officeID}`,
    service: "invbroker",
    method: "GetInventoryFromId",
    args: [officeID],
    kwargs: { passive: 0 },
  };
}

// Moniker('invbroker', (stationID, groupStation)) — the inventory MANAGER.
// TrashItems dispatches on this, not on a per-container binding.
function inventoryManagerBindSpec(held) {
  const locationID = inventoryLocationID(held);
  return {
    key: `invManager:${locationID}`,
    service: "invbroker",
    method: "MachoBindObject",
    args: [[locationID, SHIP_BIND_GROUP_STATION]],
    kwargs: null,
  };
}

// Decode an invbroker List result to plain rows. Rows arrive as packedrows, or
// (when empty and flag-scoped) a python set wrapping an empty list.
/** What an inventory List answered, out of whichever envelope it came in. */
function inventoryListItems(result) {
  let listValue = result;
  if (listValue && listValue.type === "objectex1" && Array.isArray(listValue.header)) {
    const token = listValue.header[0];
    if (token && token.value === "__builtin__.set" && Array.isArray(listValue.header[1])) {
      listValue = listValue.header[1][0] ?? null;
    }
  } else if (listValue && listValue.type === "object" && Array.isArray(listValue.args)) {
    listValue = listValue.args[0] ?? null;
  }
  return listValue && listValue.type === "list" && Array.isArray(listValue.items) ? listValue.items : [];
}

/**
 * What is used of a hold, summed from its List the client's way
 * (src/clientData/holdCapacity.js). Null where it cannot be: something the
 * List answered is not a row, or is a thing whose volume nobody here knows.
 * Never a sum that leaves something out.
 */
function usedOfListed(result, flag, packaged) {
  const rows = inventoryListItems(result).map((item) => (item && item.type === "packedrow" && item.fields ? item.fields : null));
  return rows.includes(null) ? null : usedVolume(rows, flag, staticTypeVolume, packaged);
}

function decodeInventoryRows(result) {
  const rows = [];
  for (const item of inventoryListItems(result)) {
    const fields = item && item.type === "packedrow" && item.fields ? item.fields : item;
    if (!fields || typeof fields !== "object") {
      continue;
    }
    const itemID = Number(fields.itemID) || 0;
    if (itemID > 0) {
      rows.push({
        itemID,
        typeID: Number(fields.typeID) || 0,
        locationID: Number(fields.locationID) || 0,
        flagID: Number(fields.flagID) || 0,
        quantity: Number(fields.quantity) || Number(fields.stacksize) || 0,
        // R40: what a row IS, not just where it sits. The ship bays route needs
        // these to tell a ship from a container from a stack of ore without a
        // second read. Additive — every existing caller picks the fields it
        // wants and is unaffected. groupID/categoryID are null (not 0) when the
        // row did not carry them: 0 is a real category and "absent" is not it.
        groupID: fields.groupID === undefined || fields.groupID === null ? null : Number(fields.groupID),
        categoryID:
          fields.categoryID === undefined || fields.categoryID === null
            ? null
            : Number(fields.categoryID),
        singleton: Number(fields.singleton) === 1,
      });
    }
  }
  return rows;
}

// Decode officeManager.GetMyCorporationsOffices (a CRowset: objectex2 whose
// `list` holds packedrows).
function decodeOfficeRows(result) {
  const rows = result && Array.isArray(result.list) ? result.list : [];
  const offices = [];
  for (const row of rows) {
    const fields = row && row.type === "packedrow" && row.fields ? row.fields : null;
    if (!fields) {
      continue;
    }
    offices.push({
      officeID: Number(fields.officeID) || 0,
      stationID: Number(fields.stationID) || 0,
    });
  }
  return offices;
}

// Decode corpRegistry.GetCorporation (a util.Row: a `header` list of column
// names paired with a `line` list of values) into division ordinal -> name.
function decodeDivisionNames(result) {
  const entries =
    result && result.type === "object" && result.args && Array.isArray(result.args.entries)
      ? result.args.entries
      : [];
  const header = (entries.find(([key]) => key === "header") || [])[1];
  const line = (entries.find(([key]) => key === "line") || [])[1];
  const names = (header && header.items) || [];
  const values = (line && line.items) || [];
  const byDivision = {};
  for (let division = 1; division <= CORP_DIVISION_COUNT; division += 1) {
    const index = names.indexOf(`division${division}`);
    const value = index >= 0 ? values[index] : null;
    byDivision[division] = typeof value === "string" && value.trim() !== "" ? value : null;
  }
  return byDivision;
}

/**
 * The names of a corporation's WALLET divisions, by ordinal, from the same row. As the client names them
 * (bco_corporations.py GetDivisionNames, 138): the second to the seventh by `walletDivision2` to
 * `walletDivision7`, and the first by no column, since it is the master wallet and has the client's own word.
 * `division1` to `division7` are the hangar's (decodeDivisionNames), and were read for the wallet's until
 * 2026-10-10. The page works this out for itself now (web/src/bridge/walletReads.ts); this is the route's.
 */
function decodeWalletDivisionNames(result) {
  const entries =
    result && result.type === "object" && result.args && Array.isArray(result.args.entries)
      ? result.args.entries
      : [];
  const header = (entries.find(([key]) => key === "header") || [])[1];
  const line = (entries.find(([key]) => key === "line") || [])[1];
  const names = (header && header.items) || [];
  const values = (line && line.items) || [];
  const byDivision = {};
  for (let division = 1; division <= CORP_DIVISION_COUNT; division += 1) {
    const index = division === 1 ? -1 : names.indexOf(`walletDivision${division}`);
    const value = index >= 0 ? values[index] : null;
    byDivision[division] = typeof value === "string" && value.trim() !== "" ? value : null;
  }
  return byDivision;
}

/**
 * Resolve the corporation's office at the docked station.
 *
 * ⚠ IDENTITY. An office carries three separately allocated ids: officeID (where
 * the hangar CONTENTS sit), officeFolderID, and itemID. What
 * GetMyCorporationsOffices publishes as `officeID` is the office's ITEM id.
 * GetInventoryFromId accepts any of the three, so BINDING with the published
 * value is correct — but it is NOT the items' locationID, and passing it as the
 * source location of a move-out gets the move declined SILENTLY (a 200 with
 * nothing moved). Everywhere a source location is needed, the bridge takes it
 * from the LISTED ROW's own locationID instead of assuming.
 *
 * Measured 2026-10-14: EveJS publishes the office's itemID as its officeID
 * (officeManagerService.js, resolveClientOfficeID), draws the three from three
 * counters (corporationRuntimeState.js, buildOfficeRecord), and lists as the
 * office's what lies in any of them (invBrokerService.js,
 * _listCorporationOfficeItems). In every office of the store (seven, all at
 * Jita) the three are one number, and a thing the page's own Add put in office
 * 263 lay in the published one. The client takes a move's source from the row's own
 * locationID (invControllers.py, _AddItem and AddItems), which the panel's rows
 * do not keep; the page names the office's published number.
 */
async function readCorpOffice(held, webSessionID) {
  if (held.structureID) await assertStructureService(held, webSessionID, held.structureID, 3);
  const offices = await readCorpOffices(held, webSessionID);
  const here = offices.find((office) => office.stationID === inventoryLocationID(held));
  return here ? here.officeID : 0;
}

/**
 * EVERY office the session's corporation rents, wherever it is.
 *
 * ⚠ THIS IS NOT A DOCKED-STATION READ, which is the whole reason it exists
 * apart from readCorpOffice above. GetMyCorporationsOffices answers from the
 * session's corporationID alone (evej's officeManagerService handler reads
 * nothing else), so "does my corporation have an office at station X" is
 * answerable from anywhere — in space, or docked on the far side of the map.
 * That is what lets the bot builder offer a corporation hangar for a station
 * the ship has never visited, instead of only for the one it is sitting in.
 */
async function readCorpOffices(held, webSessionID) {
  const outcome = await heldTopLevelCall(
    held,
    webSessionID,
    "officeManager",
    "GetMyCorporationsOffices",
    [],
    null,
  );
  return decodeOfficeRows(outcome.result).filter((office) => office.stationID > 0);
}

// Resolve a browser-supplied place descriptor to a bind spec, the destination
// flag, and the source location to quote when moving OUT of it.
//   { kind: "hangar" }                     the docked station hangar
//   { kind: "cargo" }                      the active ship's cargo hold
//   { kind: "shipBay", bay: "ore" }        a specialised bay of the ACTIVE ship
//   { kind: "container", itemID }          a container in the hangar or cargo
//   { kind: "corp", division: 1..7 }       a corporation hangar division
async function resolvePlace(held, webSessionID, descriptor) {
  const kind = String((descriptor && descriptor.kind) || "");
  if (kind === "hangar") {
    return { spec: hangarBindSpec(held), flag: ITEM_FLAG_HANGAR, locationID: inventoryLocationID(held) };
  }
  if (kind === "cargo") {
    if (!held.activeShipID) {
      throw Object.assign(new Error("No active ship."), { code: "NO_ACTIVE_SHIP", status: 409 });
    }
    return {
      spec: cargoBindSpec(held, held.activeShipID),
      flag: ITEM_FLAG_CARGO_HOLD,
      locationID: held.activeShipID,
    };
  }
  // A specialised bay of the ACTIVE ship (ore hold, drone bay, fleet hangar, …),
  // addressed by its bay KEY. The key -> flag mapping is R40's SHIP_BAYS, the
  // very enumeration the /bays route reads with — so a bay is never guessed and
  // the browser never sends a flag number. A bay is just a flag on the ship's
  // own inventory, so the bind and the source location are identical to cargo's;
  // only the flag differs. (There is deliberately no addressing for a bay on a
  // hull the player is NOT flying — that has no source location here.)
  if (kind === "shipBay") {
    if (!held.activeShipID) {
      throw Object.assign(new Error("No active ship."), { code: "NO_ACTIVE_SHIP", status: 409 });
    }
    const bayKey = String((descriptor && descriptor.bay) || "");
    const bay = SHIP_BAYS.find((entry) => entry.key === bayKey);
    if (!bay) {
      throw Object.assign(new Error("Unknown ship bay."), { code: "INVALID_BAY", status: 400 });
    }
    return {
      spec: cargoBindSpec(held, held.activeShipID),
      flag: bay.flag,
      locationID: held.activeShipID,
    };
  }
  if (kind === "container") {
    const containerID = Number(descriptor && descriptor.itemID) || 0;
    if (containerID <= 0) {
      throw Object.assign(new Error("A container is required."), {
        code: "INVALID_CONTAINER",
        status: 400,
      });
    }
    return {
      spec: containerBindSpec(containerID),
      flag: ITEM_FLAG_NONE,
      locationID: containerID,
    };
  }
  if (kind === "corp") {
    const division = Number(descriptor && descriptor.division) || 0;
    if (!isValidDivision(division)) {
      throw Object.assign(new Error("A corporation hangar division is required."), {
        code: "INVALID_DIVISION",
        status: 400,
      });
    }
    const officeID = await readCorpOffice(held, webSessionID);
    if (!officeID) {
      throw Object.assign(
        new Error("Your corporation has no office at this station."),
        { code: "NO_CORP_OFFICE", status: 409 },
      );
    }
    // locationID is deliberately null: the office's PUBLISHED id is not where
    // items sit, so a move OUT of a division must read the row's own location.
    return {
      spec: corpOfficeBindSpec(officeID),
      flag: corpDivisionFlag(division),
      locationID: null,
      division,
    };
  }
  throw Object.assign(new Error("Unknown inventory location."), {
    code: "INVALID_LOCATION",
    status: 400,
  });
}

// List a place. A container lists with NO flag argument at all; everything else
// is flag-scoped.
async function listPlace(held, webSessionID, place) {
  const args = place.flag === ITEM_FLAG_NONE ? [] : [place.flag];
  const outcome = await boundCall(held, webSessionID, place.spec, "List", args, null);
  return decodeInventoryRows(outcome.result);
}

function sendPlaceError(res, error) {
  if (error && error.status) {
    res.status(error.status).json({ ok: false, error: error.code, message: error.message });
    return true;
  }
  return false;
}

/** const.groupWreck: a wreck's group, which the client opens with no capacity (menusvc._OpenCargo, ItemWreck). */
const GROUP_WRECK = 186;

/**
 * A container's capacity as the retail client reckons it (invCache.py 1224 on,
 * asked with no flag): the capacity of the container's TYPE
 * (evetypes.GetCapacity), and the volume of everything its List answered,
 * summed flag by flag over the flags the List has. A plastic wrap is as big as
 * what is in it. Null where it cannot be reckoned: a type the static tables
 * have not or that has no capacity, or a List that cannot be summed.
 */
function reckonedContainerCapacity(listResult, typeID, packaged) {
  const type = typeof staticData.getType === "function" ? staticData.getType(typeID) : null;
  const capacity = type && type.capacity !== null && type.capacity !== undefined ? Number(type.capacity) : NaN;
  if (!Number.isFinite(capacity)) return null;
  let used = 0;
  for (const flag of new Set(inventoryListItems(listResult).map((item) => Number(item && item.fields && item.fields.flagID)))) {
    const inFlag = usedOfListed(listResult, flag, packaged);
    if (inFlag === null) return null;
    used += inFlag;
  }
  return capacityAnswer(typeID === packaged.plasticWrapTypeID ? used : capacity, used);
}

// Open a container and list its contents. THE RULE: a container binding is
// listed with NO flag — its contents carry flagID 0, so a flag-scoped List
// would answer empty and the container would look wrongly empty.
app.get("/api/bridge/inventory/container/:itemID", requireAuth, async (req, res, next) => {
  const held = requireHeldBridgeSession(req, res);
  if (!held) {
    return;
  }
  const containerID = Number(req.params.itemID) || 0;
  if (containerID <= 0) {
    res.status(400).json({ ok: false, error: "INVALID_CONTAINER", message: "A container is required." });
    return;
  }
  const spec = containerBindSpec(containerID);
  // ?typeID= — what the container IS, from the row the caller opened it by.
  //
  // ⚠ THE RETAIL CLIENT NEVER ASKS THE SERVER HOW FULL A CONTAINER IS. It
  // knows the type of what it opens and reckons the capacity from that
  // (reckonedContainerCapacity). On the game port this route does the same for
  // a caller that says the type, and for one that does not (a bot after the
  // contents) reckons nothing and asks nothing: the capacity is null. Where it
  // cannot be reckoned, and on the gateway, GetCapacity is asked as before.
  const containerTypeID = nonNegativeIntQuery(req.query.typeID, 0);
  const onGamePort = Boolean(gamePortPilots) && isGamePortHandle(held.bridgeSessionID);
  // menusvc._OpenCargo: a wreck (const.groupWreck, 186) is opened as an ItemWreck, which has no capacity
  // (invControllers.py 1634 to 1636: hasCapacity False). For one, nothing is reckoned and nothing asked, on either
  // transport; its type's own capacity (27,500 m³ in the static tables) is not what the client shows.
  const containerType = containerTypeID > 0 && typeof staticData.getType === "function" ? staticData.getType(containerTypeID) : null;
  const wreck = Boolean(containerType) && Number(containerType.groupID) === GROUP_WRECK;
  try {
    const asked = () => boundCall(held, req.webSessionID, spec, "GetCapacity", [], null);
    const listed = boundCall(held, req.webSessionID, spec, "List", [], null);
    const reckoned = async () => {
      const packaged = await clientConstants.packagedVolumes();
      if (!packaged) return asked();
      // A List that fails is the route's answer by itself, below; no capacity goes with it.
      const own = reckonedContainerCapacity((await listed).result, containerTypeID, packaged);
      return own === null ? asked() : { result: own };
    };
    const [list, capacity] = await Promise.allSettled([
      listed,
      wreck ? { result: null } : !onGamePort ? asked() : containerTypeID > 0 ? reckoned() : { result: null },
    ]);
    for (const settled of [list, capacity]) {
      if (settled.status === "rejected" && settled.reason && settled.reason.code === "SESSION_NOT_FOUND") {
        next(settled.reason);
        return;
      }
    }
    if (list.status === "rejected") {
      next(list.reason);
      return;
    }
    res.json({
      ok: true,
      containerID,
      list: list.value.result,
      // A container that reports no capacity is still browsable; the panel
      // simply omits the gauge.
      capacity: capacity.status === "fulfilled" ? capacity.value.result : null,
      // Whether the client's controller for it has a capacity at all (invControllers.py hasCapacity): a wreck's
      // (ItemWreck) has none, and the client draws it with no gauge and the volume of what is in it
      // (container.py UpdateLabel, UI/Inventory/ContainerCapacity). Not a capacity unread.
      hasCapacity: !wreck,
      // Per-type VOLUME, from static reference data — the same lookup the
      // inventory and asset routes already use, so no bridge call and no new
      // allowlist pair. Volume is a property of the TYPE, never of the stack.
      //
      // ⚠ THIS IS WHAT LETS A BOT TAKE WHAT FITS. Without it the browser cannot
      // work out how much of a stack a hold has room for, so the loot path had
      // to hand the WHOLE stack over and let the server judge — and a can
      // holding more than the free space was refused outright, over and over,
      // rather than being drained a load at a time.
      volumes: readTypeVolumes(list.value.result, await packagedTablesOrNull()),
    });
  } catch (error) {
    next(error);
  }
});

/**
 * The general move. One route carries split, multi-select move, and every
 * hangar/cargo/container/corp-division combination, because they are all the
 * same retail call with different arguments:
 *   one item  + qty   -> Add(itemID, sourceLocationID, {qty, flag})   (a SPLIT)
 *   many items        -> MultiAdd(itemIDs, sourceLocationID, {flag})
 *
 * The response reports what ACTUALLY moved. invbroker declines silently in
 * several branches (source-location mismatch, no room, a rig, a corp division
 * the character cannot take from) — it returns null WITHOUT raising — so a 200
 * is never treated as proof. The destination is re-read and the caller is told
 * which items landed and which did not.
 */
app.post("/api/bridge/inventory/transfer", requireAuth, async (req, res, next) => {
  const held = requireHeldBridgeSession(req, res);
  if (!held) {
    return;
  }
  const body = req.body || {};
  const itemIDs = (Array.isArray(body.itemIDs) ? body.itemIDs : [body.itemID])
    .map((value) => Number(value) || 0)
    .filter((value) => value > 0);
  const qty = Number(body.qty);
  const hasQty = Number.isSafeInteger(qty) && qty > 0;
  let pinnedClaim = null;
  let claimSettled = false;
  if (itemIDs.length === 0) {
    res.status(400).json({ ok: false, error: "INVALID_MOVE", message: "At least one item is required." });
    return;
  }
  if (hasQty && itemIDs.length > 1) {
    res.status(400).json({
      ok: false,
      error: "INVALID_SPLIT",
      message: "A quantity can only be given when moving a single stack.",
    });
    return;
  }
  try {
    const flight = await readHeldFlight(held, req.webSessionID);
    if (!requireExpectedInventoryFlight(res, body.expectedScope, flight.flight)) return;
    const expectedStructureID = flight.flight?.docked === true ? held.structureID : null;
    if (flight.flight?.docked === true && held.structureID) {
      await assertStructureService(held, req.webSessionID, held.structureID, 1);
    }
    const from = await resolvePlace(held, req.webSessionID, body.from);
    const to = await resolvePlace(held, req.webSessionID, body.to);
    const contract = body.haulContract;
    if (contract !== undefined) {
      const sourceKind = body.from?.kind, destinationKind = body.to?.kind;
      const shipKind = (kind) => kind === "cargo" || kind === "shipBay";
      if (!flight.flight?.docked || ![undefined, "station", "structure"].includes(contract?.locationKind) ||
          (contract.locationKind === "structure" ? flight.flight.structureID !== contract.stationID :
            flight.flight.stationID !== contract.stationID) || !Number.isSafeInteger(contract?.stationID) ||
          contract.stationID !== inventoryLocationID(held) || !Number.isSafeInteger(contract.corporationID) ||
          contract.corporationID <= 0 || contract.corporationID !== held.corporationID ||
          !isValidDivision(contract.division) || itemIDs.length !== 1 || !hasQty ||
          !Number.isSafeInteger(contract.typeID) || contract.typeID <= 0 ||
          !Number.isSafeInteger(contract.sourceQuantity) || contract.sourceQuantity < qty ||
          !((sourceKind === "corp" && shipKind(destinationKind) && body.from.division === contract.division) ||
            (shipKind(sourceKind) && destinationKind === "corp" && body.to.division === contract.division))) {
        res.status(409).json({ ok: false, error: "INVALID_HAUL_CONTRACT" });
        return;
      }
    }

    // Read the source FIRST. This is what supplies the source location for a
    // corp division (whose published office id is not the items' location), and
    // the before-quantity a split is judged against.
    const sourceRowsBefore = await listPlace(held, req.webSessionID, from);
    const sourceByID = new Map(sourceRowsBefore.map((row) => [row.itemID, row]));
    if (contract !== undefined && (sourceByID.get(itemIDs[0])?.typeID !== contract.typeID ||
        sourceByID.get(itemIDs[0])?.quantity !== contract.sourceQuantity)) {
      res.status(409).json({ ok: false, error: "HAUL_SOURCE_CHANGED" });
      return;
    }
    const destinationRowsBefore = contract === undefined && body.claimRunID === undefined && !held.structureID
      ? null : await listPlace(held, req.webSessionID, to);
    const missing = itemIDs.filter((itemID) => !sourceByID.has(itemID));
    if (missing.length === itemIDs.length) {
      res.status(409).json({
        ok: false,
        error: "ITEMS_NOT_AT_SOURCE",
        message: "Those items are no longer where the panel last saw them; refresh and try again.",
      });
      return;
    }
    const present = itemIDs.filter((itemID) => sourceByID.has(itemID));
    if (body.claimRunID !== undefined && (body.from?.kind !== "container" || missing.length > 0)) {
      res.status(409).json({ ok: false, error: "CONTAINER_TRANSFER_SCOPE_CHANGED" });
      return;
    }
    // Quote the source location the ITEMS report, never an assumed one.
    const sourceLocationID =
      from.locationID !== null && from.locationID !== undefined
        ? from.locationID
        : sourceByID.get(present[0]).locationID;

    const kwargs = { flag: to.flag };
    if (body.from?.kind === "container" && body.claimRunID !== undefined) {
      const runID = body.claimRunID;
      const itemID = Number(body.from.itemID);
      if (typeof runID !== "string" || !runID || !lootMemory.beginTransfer(req.webSessionID, runID, held.solarSystemID, itemID)) {
        res.status(409).json({ ok: false, error: "CONTAINER_CLAIM_LOST" });
        return;
      }
      pinnedClaim = { runID, systemID: held.solarSystemID, itemID };
    }
    let outcome;
    // A THROW IS NOT PROOF OF FAILURE, exactly as a 200 is not proof of
    // success. Looting an NPC wreck raises after the item has already moved
    // (eve.js nativeNpcWreckService.js:222 calls a scene method that does not
    // exist, but only once the transfer itself is done). Measured live: five
    // consecutive loot calls each answered CALL_FAILED and all five items were
    // in the cargo hold afterwards. So the dispatch error is REMEMBERED, not
    // rethrown here, and the re-read below decides. If the re-read shows
    // nothing moved, the original error is raised unchanged.
    let dispatchError = null;
    const writeSpec = expectedStructureID
      ? { ...to.spec, expectedDockedLocationID: expectedStructureID } : to.spec;
    if (body.expectedScope !== undefined && !requireExpectedInventoryFlight(res, body.expectedScope,
      (await readHeldFlight(held, req.webSessionID)).flight)) { claimSettled = true; return; }
    try {
      if (present.length === 1 && hasQty) {
        outcome = await boundCall(
          held,
          req.webSessionID,
          writeSpec,
          "Add",
          [present[0], sourceLocationID],
          { ...kwargs, qty },
        );
      } else if (present.length === 1) {
        outcome = await boundCall(
          held,
          req.webSessionID,
          writeSpec,
          "Add",
          [present[0], sourceLocationID],
          kwargs,
        );
      } else {
        outcome = await boundCall(
          held,
          req.webSessionID,
          writeSpec,
          "MultiAdd",
          [present, sourceLocationID],
          kwargs,
        );
      }
    } catch (error) {
      dispatchError = error;
      outcome = { notifications: [] };
    }

    // RE-READ. The status code above proves only that the call was dispatched.
    const [destinationRows, sourceRowsAfter] = await Promise.all([
      listPlace(held, req.webSessionID, to),
      listPlace(held, req.webSessionID, from),
    ]);
    if (held.structureID && (body.from?.kind === "hangar" || body.to?.kind === "hangar") &&
        destinationRowsBefore !== null) {
      const expectedByType = new Map();
      for (const itemID of present) {
        const row = sourceByID.get(itemID);
        const amount = hasQty ? qty : row.quantity;
        expectedByType.set(row.typeID, (expectedByType.get(row.typeID) || 0) + amount);
        const after = sourceRowsAfter.find((entry) => entry.itemID === itemID);
        if (row.quantity - (after?.quantity ?? 0) !== amount) {
          res.status(409).json({ ok: false, error: "PERSONAL_TRANSFER_UNCONFIRMED" }); return;
        }
      }
      const countType = (rows, typeID) => rows.filter((row) => row.typeID === typeID)
        .reduce((sum, row) => sum + row.quantity, 0);
      if ([...expectedByType].some(([typeID, amount]) =>
        countType(destinationRows, typeID) - countType(destinationRowsBefore, typeID) !== amount ||
        countType(sourceRowsBefore, typeID) - countType(sourceRowsAfter, typeID) !== amount)) {
        res.status(409).json({ ok: false, error: "PERSONAL_TRANSFER_UNCONFIRMED" }); return;
      }
    }
    if (pinnedClaim) {
      // A source-side `applied` bit is insufficient for a claimed container:
      // the destination must gain exactly what this run took. Otherwise a
      // partial or redirected move cannot free exclusivity as a success.
      const expectedByType = new Map();
      const changedByType = new Map();
      let exactItems = true;
      for (const itemID of present) {
        const before = sourceByID.get(itemID);
        const after = sourceRowsAfter.find((row) => row.itemID === itemID);
        const expected = hasQty ? qty : before.quantity;
        const changed = before.quantity - (after?.quantity ?? 0);
        expectedByType.set(before.typeID, (expectedByType.get(before.typeID) || 0) + expected);
        changedByType.set(before.typeID, (changedByType.get(before.typeID) || 0) + changed);
        if (changed !== expected || (after && after.typeID !== before.typeID)) exactItems = false;
      }
      const sumType = (rows, typeID) => rows.filter((row) => row.typeID === typeID)
        .reduce((total, row) => total + row.quantity, 0);
      const changes = [...expectedByType].map(([typeID, expected]) => ({
        expected,
        source: sumType(sourceRowsBefore, typeID) - sumType(sourceRowsAfter, typeID),
        destination: sumType(destinationRows, typeID) - sumType(destinationRowsBefore, typeID),
        selected: changedByType.get(typeID),
      }));
      if (!exactItems || changes.some((change) => change.source !== change.expected ||
          change.destination !== change.expected || change.selected !== change.expected)) {
        const refused = changes.every((change) => change.source === 0 && change.destination === 0);
        const partial = changes.every((change) => change.source > 0 && change.source < change.expected &&
          change.destination === change.source && change.selected === change.source);
        const transferStatus = refused ? "REFUSED" : partial ? "PARTIAL" : "AMBIGUOUS";
        claimSettled = transferStatus !== "AMBIGUOUS";
        res.status(409).json({ ok: false, error: "CONTAINER_TRANSFER_UNCONFIRMED", transferStatus });
        return;
      }
    }
    claimSettled = true;
    if (contract !== undefined) {
      const sum = (rows) => rows.filter((row) => row.typeID === contract.typeID)
        .reduce((total, row) => total + row.quantity, 0);
      const beforeSource = sourceByID.get(itemIDs[0]);
      const afterSource = sourceRowsAfter.find((row) => row.itemID === itemIDs[0]);
      const sourceChange = beforeSource.quantity - (afterSource?.quantity ?? 0);
      const totalSourceChange = sum(sourceRowsBefore) - sum(sourceRowsAfter);
      const destinationChange = sum(destinationRows) - sum(destinationRowsBefore);
      if (sourceChange !== qty || totalSourceChange !== qty || destinationChange !== qty) {
        const transferStatus = sourceChange === 0 && totalSourceChange === 0 && destinationChange === 0
          ? "REFUSED"
          : sourceChange > 0 && sourceChange < qty && totalSourceChange === sourceChange &&
            destinationChange === sourceChange ? "PARTIAL" : "AMBIGUOUS";
        res.status(409).json({
          ok: false, error: "HAUL_TRANSFER_UNCONFIRMED",
          transferStatus,
          message: "The exact movement into the requested division/hold could not be confirmed. Refresh both inventories before another move.",
          sourceChange, totalSourceChange, destinationChange,
        });
        return;
      }
    }
    const destinationIDs = new Set(destinationRows.map((row) => row.itemID));
    const sourceAfterByID = new Map(sourceRowsAfter.map((row) => [row.itemID, row]));

    // Items that kept their identity and are now at the destination. This is
    // the ONLY signal the route used to have, and it is the one that fails.
    const moved = present.filter((itemID) => destinationIDs.has(itemID));

    // THE SOURCE IS THE AUTHORITY, not the destination. Three different server
    // paths mint a NEW itemID at the destination and so can never appear in
    // `moved`, all three measured live against this emulator:
    //   * looting a wreck   — the wreck row is destroyed and a fresh row is
    //                         minted in the cargo hold (5/5 items, new ids)
    //   * splitting a stack — the source keeps its id and shrinks
    //   * fitting from a stack / loading ammo — one unit peels off as a new row
    // What every one of them has in common is that the SOURCE gave something
    // up: the row vanished, or its quantity fell. That is what `applied` now
    // asks. Judging by destination membership alone reported `applied:false`
    // on a completed move and would have told the player their loot was lost.
    const gaveUpAtSource = (itemID) => {
      const before = sourceByID.get(itemID);
      if (!before) {
        return false;
      }
      const after = sourceAfterByID.get(itemID);
      if (!after) {
        return true; // the row is gone from the source entirely
      }
      return (after.quantity ?? 0) < (before.quantity ?? 0);
    };
    const surrendered = present.filter(gaveUpAtSource);
    const applied = moved.length > 0 || surrendered.length > 0;

    // Nothing left the source AND nothing arrived: the server took the call and
    // did nothing, which is the silent-decline shape this bridge exists to
    // catch. Only now is a dispatch error a real failure.
    if (!applied && dispatchError) {
      throw dispatchError;
    }

    const declined = present.filter(
      (itemID) => !destinationIDs.has(itemID) && !gaveUpAtSource(itemID),
    );

    res.json({
      ok: true,
      applied,
      ...(contract === undefined && !pinnedClaim ? {} : { transferStatus: "SUCCESS" }),
      moved,
      // Items that left the source but arrived under a NEW id, so the caller
      // knows the move landed even though `moved` cannot name them.
      reminted: surrendered.filter((itemID) => !destinationIDs.has(itemID)),
      // Items the server did not move, and no reason was given: say exactly
      // that rather than inventing a cause.
      declined,
      declinedSilently: !applied && declined.length > 0,
      notFound: missing,
      notifications: outcome.notifications,
    });
  } catch (error) {
    if (sendPlaceError(res, error)) {
      return;
    }
    next(error);
  } finally {
    if (pinnedClaim) {
      lootMemory.endTransfer(req.webSessionID, pinnedClaim.runID, pinnedClaim.systemID, pinnedClaim.itemID, claimSettled);
    }
  }
});

// (A stack is merged into another by the page's own call since 2026-10-14, as the client's drop on a stack makes
// it: MultiMerge([(source, destination, qty)], where the source lies) on the inventory the target lies in, the
// corporation's hangar's the office's (bridgeCallPolicy.js, PAGE_OBJECT_CALLS: "inventory";
// web/src/bridge/inventoryWrites.ts). The route, POST /api/bridge/inventory/merge, is gone.)

// (Items are destroyed by the page's own call since 2026-10-13, as the client destroys them: TrashItems on the
// inventory manager of where the pilot is, through the generic call (bridgeCallPolicy.js, PAGE_OBJECT_CALLS:
// "inventoryManager"; web/src/bridge/inventoryWrites.ts). The route that listed the place, made the call and
// listed it again, POST /api/bridge/inventory/trash, is gone. Its own fence of a confirmation is the page's write
// fence now, and the page asks the pilot first as it did.)

/**
 * The corporation hangar: which office, what the seven divisions are CALLED,
 * and what is in each one. Every division is read independently
 * (Promise.allSettled) so a division the character lacks the query role for
 * never blanks the rest — the server answers an empty list for those, and it
 * stays authoritative. The client's own role check is cosmetic.
 */
app.get("/api/bridge/inventory/corp", requireAuth, async (req, res, next) => {
  const held = requireHeldBridgeSession(req, res);
  if (!held) {
    return;
  }
  try {
    await readHeldFlight(held, req.webSessionID);
    const [officeSettled, corporationSettled] = await Promise.allSettled([
      readCorpOffice(held, req.webSessionID),
      heldTopLevelCall(held, req.webSessionID, "corpRegistry", "GetCorporation", [], null),
    ]);
    for (const settled of [officeSettled, corporationSettled]) {
      if (settled.status === "rejected" && settled.reason && settled.reason.code === "SESSION_NOT_FOUND") {
        next(settled.reason);
        return;
      }
    }
    const divisionNames =
      corporationSettled.status === "fulfilled"
        ? decodeDivisionNames(corporationSettled.value.result)
        : {};
    const officeID = officeSettled.status === "fulfilled" ? officeSettled.value : 0;
    if (!officeID) {
      res.json({
        ok: true,
        available: false,
        stationID: held.stationID,
        // Not an error: plenty of characters simply have no corp office here.
        reason:
          officeSettled.status === "rejected"
            ? String((officeSettled.reason && officeSettled.reason.code) || "READ_FAILED")
            : "NO_CORP_OFFICE",
        divisions: [],
      });
      return;
    }
    const spec = corpOfficeBindSpec(officeID);
    const ordinals = [];
    for (let division = 1; division <= CORP_DIVISION_COUNT; division += 1) {
      ordinals.push(division);
    }
    const settledLists = await Promise.allSettled(
      ordinals.map((division) =>
        boundCall(held, req.webSessionID, spec, "List", [corpDivisionFlag(division)], null),
      ),
    );
    for (const settled of settledLists) {
      if (settled.status === "rejected" && settled.reason && settled.reason.code === "SESSION_NOT_FOUND") {
        next(settled.reason);
        return;
      }
    }
    const packagedForVolumes = await packagedTablesOrNull();
    res.json({
      ok: true,
      available: true,
      stationID: held.stationID,
      divisions: ordinals.map((division, index) => {
        const settled = settledLists[index];
        return {
          division,
          // The player-authored name; the browser falls back to "Division N"
          // when a corporation never renamed it. A flag number is never shown.
          name: divisionNames[division] || null,
          list: settled.status === "fulfilled" ? settled.value.result : null,
          volumes: settled.status === "fulfilled" ? readTypeVolumes(settled.value.result, packagedForVolumes) : {},
          error:
            settled.status === "rejected"
              ? String((settled.reason && settled.reason.code) || "READ_FAILED")
              : null,
        };
      }),
    });
  } catch (error) {
    next(error);
  }
});

/**
 * WHERE the corporation has offices, and what its seven divisions are CALLED.
 * No contents, no office ids — this answers a question a PLANNER asks before
 * flying anywhere: "if I haul a load to station X, can it go into a corporation
 * hangar there?"
 *
 * Neither read is scoped to the docked station (offices come from the session's
 * corporation, names from corpRegistry.GetCorporation), so this works in space
 * and answers for every station at once. The station ids are the corporation's
 * own offices — not a directory of who rents where.
 *
 * The divisions are listed WITHOUT a role check on purpose. The role that gates
 * a division is only enforced where it is enforceable — at the office itself,
 * by the server, at the moment of the deposit — and the unload route below
 * falls back to the personal hangar when it refuses. Offering a division here
 * that a pilot turns out not to have the role for costs them nothing; guessing
 * a role mask wrong and HIDING a division they do have would cost them the
 * feature.
 */
app.get("/api/bridge/corp-offices", requireAuth, async (req, res, next) => {
  const held = requireHeldBridgeSession(req, res);
  if (!held) {
    return;
  }
  try {
    const [officesSettled, corporationSettled] = await Promise.allSettled([
      readCorpOffices(held, req.webSessionID),
      heldTopLevelCall(held, req.webSessionID, "corpRegistry", "GetCorporation", [], null),
    ]);
    for (const settled of [officesSettled, corporationSettled]) {
      if (settled.status === "rejected" && settled.reason && settled.reason.code === "SESSION_NOT_FOUND") {
        next(settled.reason);
        return;
      }
    }
    const divisionNames =
      corporationSettled.status === "fulfilled"
        ? decodeDivisionNames(corporationSettled.value.result)
        : {};
    const stationIDs =
      officesSettled.status === "fulfilled"
        ? [...new Set(officesSettled.value.map((office) => office.stationID))]
        : [];
    const divisions = [];
    for (let division = 1; division <= CORP_DIVISION_COUNT; division += 1) {
      divisions.push({ division, name: divisionNames[division] || null });
    }
    res.json({
      ok: true,
      // An empty list is the ordinary answer for a corporation that rents no
      // office anywhere — not an error, and told apart from a failed read by
      // `error` being set.
      stationIDs,
      divisions,
      error:
        officesSettled.status === "rejected"
          ? String((officesSettled.reason && officesSettled.reason.code) || "READ_FAILED")
          : null,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/bridge/crimewatch — the pilot's combat timers and its ship's safety level, as crimewatch's
 * GetClientStates answers them, for the page to show. The answer goes on as it came; the BFF's clock at the
 * read goes beside it, so that the page counts a timer down to the server's time and not to the browser's.
 *
 * On the game port the transport asks crimewatch at the retail client's own moments and keeps the answer, so
 * this read is most often answered from there.
 */

/**
 * GET /api/bridge/clone-grade — the account's clone grade (clonegrade/const.py: 0 an alpha clone, 1 an omega),
 * which the retail client asks subscriptionMgr for as the account logs in, and keeps (gameui.py 450,
 * clone_grade_svc.py 125). On the game port the transport asked it at the pilot's login, and this is answered
 * from what it keeps. The web gateway's list has no call of the subscription manager's: a pilot there is
 * answered `available: false`, with nothing asked, and what goes by the grade is then as for an omega clone.
 */

/** appConst.corpRoleDirector and corpRoleCanRentOffice, the two the retail lobby's office buttons go by. */
const CORP_ROLE_DIRECTOR = 1n;
const CORP_ROLE_CAN_RENT_OFFICE = 562949953421312n;
/** appConst.rentalPeriodOffice: the days an office's rent pays for. */

/**
 * Whether the held session has every bit of a role in its corporation (baseController._HasRole:
 * session.corprole & role == role). False where the transport has not said what roles the session has.
 */
function heldHasCorpRole(held, role) {
  return typeof held.corpRole === "string" && /^\d+$/.test(held.corpRole) && (BigInt(held.corpRole) & role) === role;
}

/** idCheckers.IsNPCCorporation: inventorycommon.const minNPCCorporation to maxNPCCorporation. */
const isNpcCorporationID = (corporationID) => Number(corporationID) >= 1000000 && Number(corporationID) <= 1999999;

/** Whether the held pilot's corporation has an office where it is docked (officeManager.GetCorpOfficeAtLocation). */
async function hasCorpOfficeAt(held, webSessionID, stationID) {
  return (await readCorpOffices(held, webSessionID)).some((office) => office.stationID === stationID);
}

/** A whole number off a number or a wire long; null for anything else. */
function wholeWireNumber(value) {
  const number = typeof value === "number" ? value : value && value.type === "long" ? Number(value.value) : NaN;
  return Number.isSafeInteger(number) ? number : null;
}

/**
 * GET /api/bridge/station/offices — the lobby's offices where the pilot is
 * docked: the corporations with an office there, and how many offices are free.
 *
 * Asked as the retail client's lobby asks (dockedUI/offices.py, through
 * officeManager.py 34 and 136): the corporations first, then the count, each of
 * the station's own office object, which the game-port transport binds by the
 * station and keeps. A structure has no count of free offices
 * (officeManager.py 133), and none is asked for.
 *
 * The web gateway's list has neither read. A pilot there is answered
 * `available: false`, with nothing asked. A read that fails is an error: it is
 * never "this station has no offices".
 */
app.get("/api/bridge/station/offices", requireAuth, async (req, res, next) => {
  const held = requireHeldBridgeSession(req, res);
  if (!held) {
    return;
  }
  try {
    await readHeldFlight(held, req.webSessionID);
    const stationID = inventoryLocationID(held);
    if (!stationID) {
      res.status(409).json({ ok: false, error: "NOT_DOCKED", message: "A station's offices are read while docked in it." });
      return;
    }
    if (!(Boolean(gamePortPilots) && isGamePortHandle(held.bridgeSessionID))) {
      res.json({ ok: true, available: false, stationID, corporationIDs: [], freeOffices: null, ownOffice: false, impounded: false, canRent: false, canGiveUp: false });
      return;
    }
    // The lobby's buttons first, as the client loads them (offices.py, _load_buttons): whether the corporation
    // has an office here, which primes the office's item (officeManager.py 106; the transport sends that once
    // for the station's Moniker); and where it has none, whether a player's corporation has items impounded
    // (139 to 143).
    const ownOffice = await hasCorpOfficeAt(held, req.webSessionID, stationID);
    let impounded = false;
    if (ownOffice) {
      await heldTopLevelCall(held, req.webSessionID, "officeManager", "PrimeOfficeItem", [], null);
    } else if (!isNpcCorporationID(held.corporationID)) {
      impounded = (await heldTopLevelCall(held, req.webSessionID, "officeManager", "HasCorpImpoundedItems", [], null)).result === true;
    }
    const corporations = await heldTopLevelCall(held, req.webSessionID, "officeManager", "GetCorporationsWithOffices", [], null);
    const free = held.structureID
      ? null
      : wholeWireNumber((await heldTopLevelCall(held, req.webSessionID, "officeManager", "GetEmptyOfficeCount", [], null)).result);
    const corporationIDs = [...new Set(inventoryListItems(corporations.result).map(wholeWireNumber).filter((id) => id !== null && id > 0))];
    res.json({
      ok: true,
      available: true,
      stationID,
      // A set has no order of its own: by ID here, and by name on the page.
      corporationIDs: corporationIDs.sort((left, right) => left - right),
      freeOffices: free !== null && free >= 0 ? free : null,
      ownOffice,
      impounded,
      // baseController.CanRent and CanUnrent: the renting role, and a director.
      canRent: heldHasCorpRole(held, CORP_ROLE_CAN_RENT_OFFICE),
      canGiveUp: heldHasCorpRole(held, CORP_ROLE_DIRECTOR),
    });
  } catch (error) {
    next(error);
  }
});

/**
 * The station whose office object a held pilot's rent, price or giving up is asked of; or null, with the answer
 * already sent saying why there is none. In a structure the client's lobby has the same buttons; here they are
 * not built, and the structure's services are not this BFF's to offer.
 */

/** A pilot without the role is answered as the client answers it: with no button. */

/**
 * GET /api/bridge/station/office/quote — what an office in this station costs the pilot's corporation, for thirty
 * days (appConst.rentalPeriodOffice). The retail lobby asks it as its rent button is pressed, of the station's
 * own office object and for the session's corporation (officeManager.py 114), and shows it before anything is
 * paid.
 */

/**
 * POST /api/bridge/station/office/rent { cost, confirm: true } — rent the corporation an office in this station,
 * at the price the player was shown, as the retail lobby does once the player has said yes
 * (officeManager.py 117: RentOffice(cost) on the station's own office object). The server takes the rent from
 * the corporation's wallet and says the office changed; nothing here says so in its place.
 */

/**
 * POST /api/bridge/station/office/give-up { confirm: true } — give up the corporation's office in this station, as
 * the retail lobby does once the player has said yes (officeManager.py 122: UnrentOffice() on the station's own
 * office object).
 */

// Board a ship sitting in the station hangar (the retail
// Moniker('ship',(stationID,groupStation)).Board(shipID, oldShipID)). On
// success the newly boarded ship becomes the active ship for cargo reads.
// A ship is boarded by the page's own call since 2026-10-14 (web/src/bridge/shipWrites.ts: ship.Board(shipID, the ship
// left or where the pilot is docked), menuFunctions.py 209), under the BFF's keeping of the swap with the ship boarded
// pinned (the generic call, dispatchShipSwapWrite; bridgeCallPolicy.js, swapTargetOf). Its route
// (POST /api/bridge/ship/board) is gone.

// --- R12 Ship fitting -------------------------------------------------------
// Fitting is NOT a dedicated service: it is the SAME bound-object two-step the
// R3 inventory routes above drive, with a SLOT flag instead of the hangar (4) /
// cargo (5) flag. So `fit` and `unfit` are literally invbroker.Add through the
// same boundCall + handle cache, and this section adds no new bind machinery.
//
//   read  slots      ship binding . ListByFlags(<every slot flag>)
//   read  resources  dogmaIM.ShipGetInfo()        [top level, no bind]
//   read  online     dogmaIM.ShipOnlineModules()  [top level, no bind]
//   fit              ship binding . Add(moduleID, sourceID, {flag:<slot>})  [the page's own call; no route]
//   unfit            hangar/ship binding . Add(moduleID, shipID, {flag:4|5})  [the page's own call; no route]
//   online/offline   dogmaIM.SetModuleOnline / TakeModuleOffline  [the page's own call; no route]
//   remove a rig     ship binding . DestroyFitting(rigID)  -- DESTRUCTIVE
//
// The browser NEVER sends a slot flagID. It addresses a slot by FAMILY and
// INDEX ("the third high slot"), and this module is the only place that knows
// the numbers — which is what keeps raw flagIDs out of browser JS entirely.

// Slot flag families (inventorycommon/const.py; mirrored server-side by
// services/fitting/liveFittingState.js SLOT_FAMILY_FLAGS).
const SLOT_FAMILY_FLAGS = Object.freeze({
  high: Object.freeze([27, 28, 29, 30, 31, 32, 33, 34]),
  mid: Object.freeze([19, 20, 21, 22, 23, 24, 25, 26]),
  low: Object.freeze([11, 12, 13, 14, 15, 16, 17, 18]),
  rig: Object.freeze([92, 93, 94, 95, 96, 97, 98, 99]),
  subsystem: Object.freeze([125, 126, 127, 128, 129, 130, 131, 132]),
});
// Deliberately the SERVER's ranges (rig 92-99, subsystem 125-132), which are
// wider than the retail client's own lists (92-94 / 125-128). The server clamps
// each family to the ship's actual slot count anyway, so reading the wider
// range costs nothing and never misses a slot this server considers legal.
const ALL_SLOT_FLAGS = Object.freeze([
  ...SLOT_FAMILY_FLAGS.low,
  ...SLOT_FAMILY_FLAGS.mid,
  ...SLOT_FAMILY_FLAGS.high,
  ...SLOT_FAMILY_FLAGS.rig,
  ...SLOT_FAMILY_FLAGS.subsystem,
]);

// The ship's resource attributes (CPU / powergrid / capacitor / calibration)
// ride back in the raw ShipGetInfo result and are decoded browser side, like
// every other retail-shaped read here — see web/src/bridge/fitting.ts for the
// dogma attribute IDs and why the capacitor read is capacity-or-charge.

/**
 * The pilot's own ship as dogma has it, in the shapes ShipGetInfo and
 * ShipOnlineModules answer in.
 *
 * ⚠ THE RETAIL CLIENT SENDS NEITHER (godma.py 2409, 697). What it knows of
 * its ship it was primed with by GetAllInfo, and has been told of since. On
 * the game port the transport keeps that godma and answers from it, so nothing
 * is asked. Null where it cannot: off the game port, with godma not primed, or
 * while the ship godma holds is not the one this session has as its own.
 */
async function shipAsGodmaHoldsIt(held) {
  if (!gamePortPilots || !isGamePortHandle(held.bridgeSessionID) || typeof gamePortPilots.shipInfo !== "function") return null;
  const own = await gamePortPilots.shipInfo({ userid: held.accountID }, held.bridgeSessionID);
  // Godma is primed for the ship the session is in, which is the ship the server would answer of: its row is
  // the answer whatever ship the BFF holds for itself (after a ship's loss that is the lost one, until the flight
  // status is read again).
  if (!own.row) return null;
  return {
    shipInfo: { result: { type: "dict", entries: [[own.shipID, own.row]] }, notifications: [] },
    online: { result: { type: "list", items: own.online }, notifications: [] },
  };
}

// The whole fitting panel: what is in every slot, the ship's resource
// attributes, and which modules are online. The three reads are INDEPENDENT
// (Promise.allSettled) so one failed read never blanks the rest — R2's rule,
// as the inventory and rewards routes apply it.
app.get("/api/bridge/fitting", requireAuth, async (req, res, next) => {
  const held = requireHeldBridgeSession(req, res);
  if (!held) {
    return;
  }
  try {
    // Sync the held ship/station to the live position first, so the slot read
    // binds the CURRENT active ship after a board or a dock elsewhere.
    await readHeldFlight(held, req.webSessionID);
    const shipID = held.activeShipID;
    const noShip = () =>
      Promise.reject(Object.assign(new Error("No active ship."), { code: "NO_ACTIVE_SHIP" }));
    const godma = shipID ? await shipAsGodmaHoldsIt(held) : null;
    const [slots, shipInfo, online] = await Promise.allSettled([
      shipID
        ? boundCall(held, req.webSessionID, cargoBindSpec(held, shipID), "ListByFlags", [ALL_SLOT_FLAGS], null)
        : noShip(),
      !shipID ? noShip() : godma ? godma.shipInfo : heldTopLevelCall(held, req.webSessionID, "dogmaIM", "ShipGetInfo", [], null),
      !shipID ? noShip() : godma ? godma.online : heldTopLevelCall(held, req.webSessionID, "dogmaIM", "ShipOnlineModules", [], null),
    ]);

    for (const settled of [slots, shipInfo, online]) {
      if (settled.status === "rejected" && settled.reason && settled.reason.code === "SESSION_NOT_FOUND") {
        next(settled.reason);
        return;
      }
    }
    const settledCode = (settled) =>
      settled.status === "rejected"
        ? String((settled.reason && settled.reason.code) || "READ_FAILED")
        : null;
    const settledValue = (settled) =>
      settled.status === "fulfilled" ? settled.value.result : null;

    res.json({
      ok: true,
      activeShipID: shipID,
      stationID: held.stationID,
      slots: settledValue(slots),
      shipInfo: settledValue(shipInfo),
      online: settledValue(online),
      // What each fitted module TYPE will take: its charge size and the charge
      // groups it accepts, from the same static dogma the volume lookup uses —
      // no bridge call, no allowlist pair. ⚠ ADVISORY: a picker uses it to put
      // likely charges first and must never HIDE one, because the server is the
      // authority on what actually loads.
      chargeFits: readModuleChargeFits(settledValue(slots)),
      errors: {
        slots: settledCode(slots),
        shipInfo: settledCode(shipInfo),
        online: settledCode(online),
      },
    });
  } catch (error) {
    next(error);
  }
});

// (The pinned type facts for the shared combat utility classifier are static data, and are read where the
// static reads are since 2026-10-11: GET /api/types/combat-utility.)

// (A module is fitted and unfitted by the page's own call since 2026-10-13: invbroker.Add on the ship's own
// inventory, or on the hangar's, and invbroker.MultiAdd on the ship's for one fitted to no slot of it, through the
// generic call, with the slot's flag the page names and the page's own read of the slots before and after
// (bridgeCallPolicy.js, PAGE_OBJECT_CALLS: "inventory"; web/src/bridge/fitModule.ts). The two routes that named
// the flag and read the slots, POST /api/bridge/fitting/fit and .../unfit, are gone, and with them their check
// of a structure's fitting service before the call: the client makes none before either call, and the server
// refuses a fitting at a structure whose service is not to be had.)

// (A module is put online and taken offline by the page's own call since 2026-10-13: dogmaIM.SetModuleOnline and
// TakeModuleOffline through the generic call, with the ship the page's own fitting is of
// (bridgeCallPolicy.js, PAGE_WRITE_PAIR_KEYS; web/src/bridge/dogmaWrites.ts). The route that sent the module with
// the ship the BFF held, POST /api/bridge/fitting/state, is gone.)

// A fitted rig is destroyed by the page's own call on the ship's own inventory since 2026-10-14
// (web/src/bridge/fitModule.ts: invbroker.DestroyFitting, fittingSlotController.py 262), held to a rig and judged by
// the page's own read of the slots. Its route (POST /api/bridge/fitting/destroy-rig) is gone.

// --- R15 Industry (blueprints / jobs / facilities) -------------------------
// Unlike every panel before it, industry needs NO bound-object machinery: the
// whole retail surface is TOP-LEVEL (sm.RemoteSvc('blueprintManager') /
// ('industryManager') / ('facilityManager')), so heldTopLevelCall carries all
// of it. See docs/bridge-wire-contract.md for the call table.
//
// The split between live calls and static data:
//   LIVE  — the player's own blueprint INSTANCES (material/time efficiency,
//           runs left, where they sit, whether one is busy in a job), their
//           JOBS, their used job slots, and the FACILITIES their region offers
//           with each one's tax and supported activities.
//   STATIC — every NAME and every recipe: what a blueprint is called, what it
//           produces, what each activity consumes and how long it takes, and
//           what a facility/solar system is called. None of that changes with
//           the player, so it never needs a round-trip.

app.get("/api/bridge/industry", requireAuth, async (req, res, next) => {
  const held = requireHeldBridgeSession(req, res);
  if (!held) {
    return;
  }
  try {
    // Sync held station/system to the live position first, so the facility
    // read reflects where the character actually is.
    await readHeldFlight(held, req.webSessionID);
    const ownerID = held.characterID;
    // Five INDEPENDENT reads (R2's rule): one failure never blanks the rest.
    // A player with no facilities in range should still see their blueprints.
    const [blueprints, jobs, jobCounts, facilities, modifiers] = await Promise.allSettled([
      heldTopLevelCall(held, req.webSessionID, "blueprintManager", "GetBlueprintDataByOwner", [ownerID, null], null),
      // includeCompleted=true: the panel shows finished work alongside running
      // work, and filters client-side by the status the SERVER computed.
      heldTopLevelCall(held, req.webSessionID, "industryManager", "GetJobsByOwner", [ownerID, true], null),
      heldTopLevelCall(held, req.webSessionID, "industryManager", "GetJobCounts", [ownerID], null),
      heldTopLevelCall(held, req.webSessionID, "facilityManager", "GetFacilities", [], null),
      heldTopLevelCall(held, req.webSessionID, "facilityManager", "GetMaxActivityModifiers", [], null),
    ]);

    for (const settled of [blueprints, jobs, jobCounts, facilities, modifiers]) {
      if (settled.status === "rejected" && settled.reason && settled.reason.code === "SESSION_NOT_FOUND") {
        next(settled.reason);
        return;
      }
    }

    const settledCode = (settled) =>
      settled.status === "rejected"
        ? String((settled.reason && settled.reason.code) || "READ_FAILED")
        : null;
    const settledValue = (settled) =>
      settled.status === "fulfilled" ? settled.value.result : null;

    res.json({
      ok: true,
      ownerID,
      stationID: held.stationID,
      solarSystemID: held.solarSystemID ?? null,
      blueprints: { result: settledValue(blueprints), error: settledCode(blueprints) },
      jobs: { result: settledValue(jobs), error: settledCode(jobs) },
      jobCounts: { result: settledValue(jobCounts), error: settledCode(jobCounts) },
      facilities: { result: settledValue(facilities), error: settledCode(facilities) },
      activityModifiers: { result: settledValue(modifiers), error: settledCode(modifiers) },
    });
  } catch (error) {
    next(error);
  }
});

// --- R15 Industry mutations (install / deliver / cancel) --------------------
//
// A job is installed, delivered and stopped by the page's own calls: the delivery and the stop since 2026-10-11
// (web/src/bridge/industryWrites.ts: CompleteJob and CancelJob, industrySvc.py 150 and 160), the install since
// 2026-10-14 (web/src/app/flow.ts, installIndustryJob; web/src/bridge/industryMonitor.ts, installJob: InstallJob(job.dump()),
// industrySvc.py 139 to 144), the job reckoned by the page (web/src/bridge/industryJobReckoning.ts, the arithmetic in
// industryReckonings.mjs) and its dump made by the page. Their routes (POST /api/bridge/industry/install, deliver and
// cancel) are gone, and with them what they alone used: the industry requests' checks, the facility's places, the
// job's dump, the reckonings' glue and the jobs' statuses.

// --- R16 Market (order books, own orders, transactions, escrow) ------------
//
// ⚠ THE SERVICE IS "marketProxy". EveJS registers TWO market services and the
// obvious name is the wrong one: `market` (marketService.js) is a DEAD STUB
// whose every method answers an empty rowset. `marketProxy`
// (marketProxyService.js) is the real implementation — daemon-backed order
// books, escrow, broker fees, real wallet debits. Calling `market` would give
// the player a market page that renders perfectly and is permanently empty.
// Every call below names marketProxy; the gateway allowlist refuses `market`.
//
// ⚠ THERE IS NO SERVER `marketQuote`. Sorting, jump filtering, best-bid
// matching and skill-gated order limits are CLIENT-side in retail, so they are
// client-side here too (web/src/bridge/market.ts). Do not go looking for a
// call.
//
// ⚠ AN EXTERNAL DAEMON BACKS THIS. marketProxy talks to a market daemon over
// TCP 127.0.0.1:40111. When it is down, reads THROW rather than answering
// empty — which is what lets this route tell the browser "the market is not
// answering" instead of "nobody is trading this item". The two are different
// facts and the panel says which one happened.
//
// Like industry, market needs NO bound-object machinery: the whole surface is
// top-level (sm.ProxySvc('marketProxy')), so heldTopLevelCall carries it all.
//
// SCOPE, and why the browser cannot widen it: every read below is scoped by the
// SESSION the gateway materialized — region for the order book, character for
// the own-orders/transactions/escrow reads. The only argument any of them takes
// is a typeID. There is no owner parameter to tamper with.

/**
 * The daemon-outage code, told apart from an ordinary read failure so the panel
 * can say something true about which one happened.
 */
function isMarketUnavailable(error) {
  const text = String((error && (error.message || error.detail)) || "");
  return text.includes("MarketUnavailable") || text.includes("market daemon");
}

app.get("/api/bridge/market", requireAuth, async (req, res, next) => {
  const held = requireHeldBridgeSession(req, res);
  if (!held) {
    return;
  }
  // A typeID is OPTIONAL: the player's own orders and escrow are
  // worth showing before they have picked an item to look at.
  const typeID = Number(req.query.typeID) || 0;
  try {
    // Sync the held station/system to the live position first: the order book's
    // `jumps` column is computed from where the character actually is.
    await readHeldFlight(held, req.webSessionID);

    // Six INDEPENDENT reads (R2's rule): one failure never blanks the rest. A
    // player whose order book fails to load still sees their own orders and
    // their ISK.
    // The pilot's trades are not asked here: the client keeps them in its market service, asked once and let go
    // when its own orders change (marketSvc.GetPersonalMarketTransactions, 20 to 35), and the page reads them so
    // (flow.loadMarketTransactions). Asked with every market read, they went twice where the client asks once.
    // Nor the pilot's ISK: the client's wallet service asks it once and keeps it as OnAccountChange says (walletSvc.py
    // 41 to 49, 81 to 100); the page keeps it so (walletReads.wealth) and the market window shows that.
    // Nor its escrow: the client asks GetCharEscrow only for its market progression, kept in the character's settings
    // and asked again at most each twelve hours (playerprogression/marketprogressionnotifier.py); the page keeps it so
    // (flow.watchMarketProgression).
    const [book, ownOrders, history, priceHistory, priceHistoryOld] =
      await Promise.allSettled([
        typeID > 0
          ? heldTopLevelCall(held, req.webSessionID, "marketProxy", "GetOrders", [typeID], null)
          : Promise.resolve({ result: null }),
        heldTopLevelCall(held, req.webSessionID, "marketProxy", "GetCharOrders", [], null),
        heldTopLevelCall(held, req.webSessionID, "marketProxy", "GetMarketOrderHistory", [], null),
        typeID > 0
          ? heldTopLevelCall(held, req.webSessionID, "marketProxy", "GetNewPriceHistory", [typeID], null)
          : Promise.resolve({ result: null }),
        // marketsvc.GetPriceHistory (333): the client asks a type's history in two halves and joins them. The new
        // half alone is, on this server, the last day and nothing else.
        typeID > 0
          ? heldTopLevelCall(held, req.webSessionID, "marketProxy", "GetOldPriceHistory", [typeID], null)
          : Promise.resolve({ result: null }),
      ]);

    const settled = [book, ownOrders, history, priceHistory, priceHistoryOld];
    for (const entry of settled) {
      if (entry.status === "rejected" && entry.reason && entry.reason.code === "SESSION_NOT_FOUND") {
        next(entry.reason);
        return;
      }
    }

    const codeOf = (entry) =>
      entry.status === "rejected"
        ? String((entry.reason && entry.reason.code) || "READ_FAILED")
        : null;
    const valueOf = (entry) => (entry.status === "fulfilled" ? entry.value.result : null);

    // ⚠ The daemon-outage signal, extracted ONCE across every read: if the
    // market itself is not answering, saying "you have no orders" would be a
    // lie. The panel gets told which it is.
    const outage = settled.find(
      (entry) => entry.status === "rejected" && isMarketUnavailable(entry.reason),
    );

    // marketsvc.GetBrokersFeeCommissionFromStationID: the rate the pilot is charged where it is docked, worked out as
    // the client works it out, so that the page can show the fee and not an estimate at the base rate. The game
    // port has what it takes (pilots.js brokersFeeAt). Through the gateway nothing does, and the read says none.
    const worked = gamePortPilots && isGamePortHandle(held.bridgeSessionID) && inventoryLocationID(held)
      ? await gamePortPilots.brokersFeeRate(inventoryLocationID(held), { userid: held.accountID }, held.bridgeSessionID).catch(() => null)
      : null;

    res.json({
      ok: true,
      typeID: typeID > 0 ? typeID : null,
      characterID: held.characterID,
      stationID: held.stationID,
      // The structure the pilot is docked in, where it is in one: the rate below is then the structure's own.
      structureID: held.structureID ?? null,
      solarSystemID: held.solarSystemID ?? null,
      brokersFeeRate: typeof worked === "number" && Number.isFinite(worked) && worked >= 0 ? worked : null,
      book: { result: valueOf(book), error: codeOf(book) },
      ownOrders: { result: valueOf(ownOrders), error: codeOf(ownOrders) },
      orderHistory: { result: valueOf(history), error: codeOf(history) },
      priceHistory: { result: valueOf(priceHistory), error: codeOf(priceHistory) },
      priceHistoryOld: { result: valueOf(priceHistoryOld), error: codeOf(priceHistoryOld) },
      marketUnavailable: outage
        ? "The market is not answering right now, so these figures may be incomplete."
        : null,
    });
  } catch (error) {
    next(error);
  }
});

// --- R16 Market mutations ----------------------------------------------------
//
// (Orders are placed, repriced and taken down by the page's own calls: marketProxy.PlaceBuyOrder,
// PlaceMultiSellOrder, ModifyCharOrder and CancelCharOrder through the generic call, with the page's own reads
// of the pilot's wallet and orders before and after for its verdict (bridgeCallPolicy.js, PAGE_WRITE_PAIR_KEYS;
// web/src/bridge/marketOrderWrites.ts). The cancel's route went on 2026-10-13, and the buy's, the sale's and the
// reprice's (POST /api/bridge/market/buy, .../sell, .../modify) on 2026-10-14, with the helpers only they used.
// The broker's fee rate the page has not is the game port's to name (src/gamePort/retailCalls.js).)

// --- R17 Mail (mailMgr bridge) ---------------------------------------------
//
// Like industry and market, the whole retail mail surface is TOP-LEVEL
// (sm.RemoteSvc('mailMgr')) — no bound-object step — so heldTopLevelCall
// carries all of it and this adds no bridge machinery.
//
// ⚠ THE INBOX IS A DELTA SYNC, NOT A LIST CALL. There is no "give me my mail"
// method. SyncMail(firstID, lastID) takes the MIN and MAX messageID the CALLER
// already holds and answers only what falls outside that window. A caller that
// invents a window gets a PARTIAL mailbox and NO error. The browser caches
// nothing across a page load, so it is permanently cold and this route always
// passes the cold-start pair [null, 0] — "I hold nothing, send everything".
// (server/tests/webGatewayMail.test.js pins both the cold and the warm shape.)
//
// ⚠ AN EMPTY RECIPIENT LIST IS NOT REFUSED BY THE SERVER. mailState.sendMail's
// NO_RECIPIENTS guard reads `recipients.length === 0 && !saveSenderCopy`, and
// the handler hardcodes saveSenderCopy: true — so the guard can never fire
// through the gateway, and mail addressed to nobody is written, filed into the
// sender's own mailbox, and looks sent. The send route below refuses it here
// instead, because nothing downstream will.

/** The cold-start SyncMail window: "I hold nothing, send me the lot." */
const MAIL_COLD_START_SYNC = Object.freeze([null, 0]);
const MAIL_STATUS_MASK_READ = 1;

function readMailKeyVal(row, key) {
  const entries =
    row && row.args && Array.isArray(row.args.entries) ? row.args.entries : [];
  const entry = entries.find((candidate) => {
    const name = Array.isArray(candidate) ? candidate[0] : null;
    return (typeof name === "string" ? name : name && name.value) === key;
  });
  return entry ? entry[1] : undefined;
}

function mailListItems(value) {
  return value && Array.isArray(value.items) ? value.items : [];
}

function mailNumber(value) {
  if (typeof value === "number") {
    return value;
  }
  if (value && value.type === "long") {
    return Number(value.value) || 0;
  }
  return Number(value) || 0;
}

/**
 * The unread count, computed HERE rather than trusted from anywhere else: it is
 * the number of status rows whose read bit is clear. The browser gets the raw
 * rows too and could count them itself; this exists so the count shown beside
 * the tab and the count implied by the list can never disagree.
 */
function mailUnreadCount(syncResult) {
  let unread = 0;
  for (const row of mailListItems(readMailKeyVal(syncResult, "mailStatus"))) {
    if ((mailNumber(readMailKeyVal(row, "statusMask")) & MAIL_STATUS_MASK_READ) === 0) {
      unread += 1;
    }
  }
  return unread;
}

/** Is `messageID` present in this sync's headers? The send/read re-read verdict. */
function mailHeaderIDs(syncResult) {
  const ids = new Set();
  for (const arm of ["newMail", "oldMail"]) {
    for (const row of mailListItems(readMailKeyVal(syncResult, arm))) {
      ids.add(mailNumber(readMailKeyVal(row, "messageID")));
    }
  }
  return ids;
}

/**
 * GET /api/bridge/mail — the whole inbox, cold-started.
 *
 * The page no longer asks it: it keeps the mailbox as the client's mail service does, synced once with
 * SyncMail(firstID, lastID) by the generic call and kept by the mail notices (web/src/app/flow.ts, syncMail).
 * Kept for scripts/bff-parity.js.
 *
 * One call does it: a cold SyncMail IS the full mailbox. GetMailHeaders is the
 * backfill for any messageID that has a status row but no header, which a cold
 * sync should never produce — it is issued only when that actually happens, so
 * the common case stays a single round-trip.
 */
app.get("/api/bridge/mail", requireAuth, async (req, res, next) => {
  const held = requireHeldBridgeSession(req, res);
  if (!held) {
    return;
  }
  try {
    const sync = await heldTopLevelCall(
      held,
      req.webSessionID,
      "mailMgr",
      "SyncMail",
      MAIL_COLD_START_SYNC,
      null,
    );

    // Backfill: any message the mailbox knows the STATUS of but not the HEADER.
    // ⚠ The argument is a list NESTED in args[0], not a spread of ids.
    const haveHeaders = mailHeaderIDs(sync.result);
    const missing = [];
    for (const row of mailListItems(readMailKeyVal(sync.result, "mailStatus"))) {
      const messageID = mailNumber(readMailKeyVal(row, "messageID"));
      if (messageID > 0 && !haveHeaders.has(messageID)) {
        missing.push(messageID);
      }
    }
    let backfill = null;
    if (missing.length > 0) {
      const extra = await heldTopLevelCall(
        held,
        req.webSessionID,
        "mailMgr",
        "GetMailHeaders",
        [missing],
        null,
      );
      backfill = extra.result;
    }

    res.json({
      ok: true,
      characterID: held.characterID,
      sync: sync.result,
      backfill,
      unreadCount: mailUnreadCount(sync.result),
    });
  } catch (error) {
    next(error);
  }
});

// The body of a message is the page's own call since 2026-10-14 (web/src/app/flow.ts, openMail: mailMgr.GetBody,
// mailSvc.py 493 to 524), inflated by the page. Its route (GET /api/bridge/mail/body), its inflating and its
// cold sync of the whole mailbox after are gone.

// A mail is sent by the page's own call since 2026-10-14 (web/src/bridge/mailWrites.ts: mailMgr.SendMail,
// mailSvc.py 959 to 993), held to the compose window's own checks, which refuse a message to nobody before the
// call (the server's own guard of that never fires: see the note above). Its route (POST /api/bridge/mail/send),
// its limits and its read of the sender's mailbox after are gone.

// --- R86 Mail + mailing-list WRITES (mailMgr / mailingListsMgr) -------------
//
// The FIRST Phase-3 writes batch. Every retail mail write is TOP-LEVEL
// (sm.RemoteSvc("mailMgr") / sm.RemoteSvc("mailingListsMgr")) — no bound-object
// step — so heldTopLevelCall carries them, exactly like the R17 reads/SendMail.
//
// ⚠ EVERY ROUTE IS CONFIRM-GATED. Mirroring the R14 TrashItems / R16 market
// pattern: the route refuses outright (400 CONFIRMATION_REQUIRED, NO dispatch)
// unless the browser passes `confirm: true`. Neither a stray click nor a stray
// POST can trash, delete, relabel, or join/leave a list. The two permanent-
// delete writes (DeleteMail / EmptyTrash) carry the same gate; the UI puts its
// own two-step confirm in front of that.
//
// ⚠ ALL SESSION-SCOPED. Every mailMgr write resolves its mailbox from the
// SESSION character (resolveSessionCharacterID); a messageID/labelID the session
// does not own is simply absent from its rows and the write is a silent no-op —
// no arg a browser sends mutates another character's mail. mailingListsMgr
// Join/Leave self-add / self-remove the session char; Create makes a new list
// owned by the session. FAST-MODE educated-guess responses: every handler
// returns null except CreateLabel (labelID), mailingListsMgr.Create (listID),
// and mailingListsMgr.Join (a list-info KeyVal) — the decoders read those.

/** The confirm gate every R86 mail write sits behind (mirrors TrashItems/market). */
function requireMailConfirmation(req, res, message) {
  if ((req.body || {}).confirm === true) {
    return true;
  }
  res.status(400).json({ ok: false, error: "CONFIRMATION_REQUIRED", message });
  return false;
}

/** Coerce a browser-sent messageIDs/labelIDs payload to a clean positive-int list. */

/**
 * Dispatch one confirm-gated mail write and answer a uniform ack. FAST-MODE:
 * the server returns null on every status/trash/label write, so `applied` is
 * true whenever the dispatch did not throw; the panel re-reads the mailbox
 * itself to prove the mutation. A route that needs the return value (label /
 * list creation) reads `outcome.result` directly instead of calling this.
 */

// --- R86 mailing-list WRITES (mailingListsMgr — a DISTINCT service)
// Its 3 write routes, made for no screen of the page's, went on 2026-10-14 (the loop's item 62): nothing
// asked them. The pairs stay writes (bridgeCallPolicy.js), so the generic call refuses them.

// --- R87 notifications + calendar + bookmark WRITES -------------------------
// (notificationMgr / calendarMgr / accessGroupBookmarkMgr)
//
// The Phase-3 "personal + org" writes batch, following the R86 mail pattern.
// Every write is a TOP-LEVEL call on the held session (heldTopLevelCall) and
// every route is CONFIRM-GATED: it refuses outright (400 CONFIRMATION_REQUIRED,
// NO dispatch) unless the browser passes `confirm: true`. A stray click or
// stray POST cannot mark, delete, create, edit, or move anything.
//
// ⚠ SESSION / ACCESS SCOPED — no write mutates a FOREIGN entity:
//   • notificationMgr writes resolve the mailbox from the SESSION character
//     (getSessionCharacterID); a group/id the session does not own is simply
//     absent from its rows, so the write is a silent no-op.
//   • calendarMgr Edit/Delete/Respond/UpdateParticipants all pass through
//     access.canEditOrDeleteEvent(event, session) server-side — a foreign
//     eventID is a permission error, never a foreign mutation. Create*Corp /
//     Create*Alliance / UpdateEventParticipants are role/scope gated (a normal
//     member gets a 403 / CustomNotify — that is CORRECT).
//   • accessGroupBookmarkMgr writes resolve the folder via resolveFolderView
//     against the SESSION character's access level and gate on
//     canWriteFolder / canManageFolder / ACCESS_ADMIN — a foreign folderID is
//     FolderAccessDenied, never a foreign mutation.
//
// ⚠ DESTRUCTIVE PAIRS — reachable + confirm-gated, NEVER fired on the live
// world in this plumbing pass: notifications delete-group / delete-all /
// delete, calendar event/delete, bookmark folder/delete + bookmarks/delete.
//
// FAST-MODE educated-guess responses: every handler returns null except the
// three calendar Create*Event writes (an eventID), bookmark folder/add (the
// folder view payload) and folder/update (an access level int). The decoders
// (web/src/bridge/{notifications,calendar,bookmarks}.ts) read those.

/** The confirm gate every R87 write sits behind (mirrors requireMailConfirmation). */
function requireWriteConfirmation(req, res, message) {
  if ((req.body || {}).confirm === true) {
    return true;
  }
  res.status(400).json({ ok: false, error: "CONFIRMATION_REQUIRED", message });
  return false;
}

/** Coerce a browser-sent id-list payload to a clean positive-int list. */
function bridgeIDList(value) {
  const raw = Array.isArray(value) ? value : [value];
  return [...new Set(raw.map((v) => Number(v) || 0).filter((v) => v > 0))];
}

/**
 * Forward an optional positional-args array for writes whose handler ignores its
 * args (the abyssal / pvp rejection stubs). The browser MAY send `{ args: [...] }`;
 * anything else yields `[]`. Kept deliberately generic — these handlers reject or
 * no-op regardless of what is passed, so there is no per-arg coercion to do.
 */
function bridgeArgs(req) {
  const value = (req.body || {}).args;
  return Array.isArray(value) ? value : [];
}

/**
 * Dispatch one confirm-gated write and answer a uniform ack. FAST-MODE: most of
 * these handlers return null, so `applied` is true whenever the dispatch did not
 * throw; a panel re-reads to prove the mutation. A route that needs the return
 * value (an event/folder id) reads `outcome.result` directly instead.
 */
async function dispatchBridgeWrite(req, res, next, service, method, args) {
  const held = requireHeldBridgeSession(req, res);
  if (!held) {
    return;
  }
  try {
    const outcome = await heldTopLevelCall(held, req.webSessionID, service, method, args, null);
    res.json({ ok: true, applied: true, result: outcome.result ?? null, notifications: outcome.notifications });
  } catch (error) {
    next(error);
  }
}

/**
 * One ACCOUNT-LEVEL call: a call whose subject is the signed-in ACCOUNT, not a
 * character it has brought online.
 *
 * Every other bridge call in this file goes through `requireHeldBridgeSession`,
 * which is right for anything a pilot does — there is a pilot. Character
 * SELECTION and CREATION are the two things that necessarily happen before one
 * exists, and on a brand-new account there is no character to select at all, so
 * a held-session gate there is not a safety rail, it is a locked door with the
 * key inside. `POST /api/bridge/select` already lives outside the gate for
 * exactly this reason, and `/api/bridge/call` already falls back to a
 * userid-only session when the map has no entry (the path the pre-select
 * GetCharacterSelectionData read takes).
 *
 * So: run on the held session when there IS one (a second tab creating an alt
 * while a pilot flies), and on an ephemeral userid-only session when there is
 * not. The account identity is the BFF's own `req.account.accountID` either
 * way — never anything the browser sent — which is what keeps the write landing
 * on the caller's account and no other.
 */
async function accountLevelCall(req, service, method, args, kwargs = null) {
  const held = bridgeSessions.get(req.webSessionID) || null;
  try {
    if (!held && typeof gateway.accountCall === "function") {
      // With no pilot held this is the account's own call, as the retail client makes it before a character is
      // chosen, and the account's login name says which transport the account is on (pilotTransport.js). The
      // name is the BFF's, never the browser's. A process with no game port has no such function: see below.
      return await gateway.accountCall(service, method, args, kwargs, {
        accountID: Number(req.account.accountID),
        userName: String(req.account.username || ""),
      });
    }
    return await gateway.callMethod(
      service,
      method,
      args,
      kwargs,
      { userid: Number(req.account.accountID) },
      held ? held.bridgeSessionID : undefined,
    );
  } catch (error) {
    if (held && error && error.code === "SESSION_NOT_FOUND") {
      forgetBridgeSession(req.webSessionID, held);
    }
    throw error;
  }
}

/**
 * Dispatch a write that SWAPS the session's ACTIVE SHIP. A known target hull
 * is pinned when the route has one; otherwise readiness requires the live
 * flight ship to differ from the pre-write hull. In space, the scene ego must
 * match it too. The write is issued once and an uncertain timeout stays
 * latched, exactly like dock/undock/gate transitions.
 */
async function dispatchShipSwapWrite(req, res, next, service, method, args, targetShipID = null, answer = null, kwargs = null) {
  const held = requireHeldBridgeSession(req, res);
  if (!held) {
    return;
  }
  try {
    const before = await readHeldFlight(held, req.webSessionID);
    const expected = {
      shipID: Number(targetShipID) || null,
      fromShipID: Number(before.flight && before.flight.shipID) || Number(held.activeShipID) || null,
    };
    if (!await acquireRouteTransition(res, held, "board", expected)) {
      return;
    }
    const outcome = await heldTopLevelCall(held, req.webSessionID, service, method, args, kwargs);
    markTransitionAccepted(held);
    const after = await awaitRouteTransition(held, req.webSessionID, "board", expected);
    if (!after.ok) {
      sendTransitionTimeout(res, after, outcome.notifications);
      return;
    }
    // (The generic call's own answer, where that is what asked.)
    res.json(answer !== null ? answer(outcome, after) : {
      ok: true,
      applied: true,
      result: outcome.result ?? null,
      activeShipID: held.activeShipID || null,
      flight: { ...after.flight, transition: after.transition },
      transition: after.transition,
      notifications: [...outcome.notifications, ...after.notifications],
    });
  } catch (error) {
    if (held.transition && held.transition.kind === "board") {
      if (held.transition.phase === "requested") {
        cancelHeldTransition(held);
      } else if (held.transition.phase !== "failed") {
        markTransitionFailed(held, error && error.message);
      }
    }
    next(error);
  }
}

/**
 * Dispatch a write of the page's that takes the pilot to another place (bridgeCallPolicy.js,
 * PAGE_PLACE_CHANGE_CALLS), under the keeping its route kept it under, which is the client's session manager's
 * (sessionMgr.PerformSessionChange): the pilot's flight read for where it is, the change claimed once retail's
 * timer has run (acquireRouteTransition), the call made once, and the answer given once the pilot is usable in its
 * new place (awaitRouteTransition). A timeout stays latched, so that nothing repeats the write. Answered as the
 * generic call answers.
 *
 *   undock   from a station into space. Refused for a pilot already in space, and for a ship that is not the one
 *            the pilot is in: the client undocks its session's own ship (undockingSvc.py 121 to 135). A refusal for
 *            contraband is CONTRABAND_WARNING, in the words of the client's own dialog where the BFF has them, as
 *            its route answered it.
 *   dock     from space into a station. Refused for a pilot not in space, for what is no station (a structure is
 *            docked at by its own service, structureDocking.py 64 to 80, and by the dock route still), and for a
 *            ship that is not the pilot's (movementFunctions.RealDock: CmdDock(itemID, session.shipid)). A dock the
 *            server takes and does not carry out answers nothing all the same, so the keeping waits only the
 *            route's short while (DOCK_SILENT_DECLINE_PROBE_MS), never latches, and answers either way: the change
 *            released where the ship is still in space, which the page reads after.
 *   stargate through a stargate into the next system. Refused for a pilot not in space, for what is no gate's
 *            number and for a ship that is not the pilot's (gateJumpSvc.JumpThroughGate: CmdStargateJump(stargateID,
 *            beaconID, session.shipid)); the far gate the call names, or none, which the server and the game port
 *            work out from the gate itself. Waited for in full and latched on a timeout, and the park bound again in
 *            the new system before the answer, as its route did (reparkAfterArrival: the barrier answers while the
 *            hull is still inert).
 *   cyno     by the ship's jump drive into a fleet member's cyno's system (cynoTravelSvc.py: CmdJumpToFleetModuleBeacon
 *            and CmdGroupJumpToFleetModuleBeacon(charID, beaconID, solarsystemID)). Refused for a pilot not in space and
 *            for a member, a beacon or a system that is no number. Kept as a stargate's jump is (its keeping, latch
 *            and repark), into the beacon's system.
 *   abyss    a filament's solo deploy into its pocket (keyActivationWindow.py 49 to 51: PerformSessionChange('JumpToAbyss',
 *            abyss.deploy_entrance_gate, itemID, gameModeID)). Refused for a pilot not in space and for a filament
 *            that is no number. Kept as a stargate's jump is (its keeping, latch and repark), into the pocket.
 *   abyssExit  the last room's conduit out of the pocket (movementFunctions.RealActivateAbyssalEndGate:
 *            PerformSessionChange('abyssToKnownJump', abyssalMgr.AbyssalEndGateActivation, itemID)). Refused for a
 *            pilot not in space and for a conduit that is no number. Kept as a stargate's jump is, out of the pocket.
 *   abyssEntrance  a trace's jump into its pocket (AbyssJumpWindow.py: PerformSessionChange('JumpToAbyss',
 *            abyss.activate_entrance_gate, itemID)). Refused as abyssExit is; kept as a stargate's jump is, into the
 *            pocket.
 */
async function dispatchPlaceChangeWrite(req, res, next, kind, service, method, args, kwargs) {
  const held = requireHeldBridgeSession(req, res);
  if (!held) {
    return;
  }
  try {
    const before = await readHeldFlight(held, req.webSessionID);
    const shipID = Number(before.flight.shipID) || Number(held.activeShipID) || 0;
    let expected = null;
    let waiting = {};
    if (kind === "undock") {
      if (before.flight.inSpace === true) {
        res.status(409).json({ ok: false, error: "ALREADY_IN_SPACE", message: "The ship is already in space." });
        return;
      }
      // (From a player structure the structure's own service's Undock(structureID, shipID), the ship None where it is
      // the structure, structureDocking.py 26 to 36; from a station the ship's Undock(shipID, ignoreContraband).)
      const fromAStructure = service === "structureDocking";
      if (fromAStructure && (!isPlayerStructureID(Number(args[0])) || Number(args[0]) !== Number(before.flight.structureID))) {
        res.status(400).json({ ok: false, error: "INVALID_STRUCTURE", message: "A pilot undocks from the structure it is docked in." });
        return;
      }
      const undockingShipID = fromAStructure ? Number(args[1] ?? args[0]) : Number(args[0]);
      if (shipID <= 0 || undockingShipID !== shipID) {
        res.status(400).json({ ok: false, error: "INVALID_SHIP", message: "A pilot undocks in the ship it is in." });
        return;
      }
      expected = { shipID, toSolarSystemID: Number(before.flight.solarSystemID) || null };
    } else if (kind === "dock") {
      if (before.flight.inSpace !== true) {
        res.status(409).json({ ok: false, error: "NOT_IN_SPACE", message: "The ship is not in space; undock first." });
        return;
      }
      const stationID = Number(args[0]);
      // (A player structure is docked at by its own service's Dock, structureDocking.py 64 to 80; a station by the park's.)
      const atAStructure = service === "structureDocking";
      if (atAStructure ? !isPlayerStructureID(stationID) : !isClientStationID(stationID)) {
        res.status(400).json(atAStructure
          ? { ok: false, error: "INVALID_STRUCTURE", message: "A player structure is docked at by its number." }
          : { ok: false, error: "INVALID_STATION", message: "A station is docked at by its number." });
        return;
      }
      if (shipID <= 0 || Number(args[1]) !== shipID) {
        res.status(400).json({ ok: false, error: "INVALID_SHIP", message: "A pilot docks the ship it is in." });
        return;
      }
      expected = { stationID, shipID };
      waiting = {
        timeoutMs: Number(options.dockProbeTimeoutMs) ||
          Math.min(DOCK_SILENT_DECLINE_PROBE_MS, Number(options.transitionReadyTimeoutMs) || DOCK_SILENT_DECLINE_PROBE_MS),
        latchOnTimeout: false,
      };
    } else if (kind === "stargate") {
      if (before.flight.inSpace !== true) {
        res.status(409).json({ ok: false, error: "NOT_IN_SPACE", message: "The ship is not in space; undock first." });
        return;
      }
      const fromGateID = Number(args[0]);
      if (!Number.isSafeInteger(fromGateID) || fromGateID <= 0) {
        res.status(400).json({ ok: false, error: "INVALID_GATE", message: "A positive fromGateID is required." });
        return;
      }
      if (shipID <= 0 || Number(args[2]) !== shipID) {
        res.status(400).json({ ok: false, error: "INVALID_SHIP", message: "A pilot jumps in the ship it is in." });
        return;
      }
      expected = { fromSolarSystemID: Number(before.flight.solarSystemID) || null, shipID };
    } else if (kind === "cyno") {
      if (before.flight.inSpace !== true) {
        res.status(409).json({ ok: false, error: "NOT_IN_SPACE", message: "The ship is not in space; undock first." });
        return;
      }
      const [memberID, beaconID, beaconSystemID] = args.map(Number);
      if (![memberID, beaconID, beaconSystemID].every((id) => Number.isSafeInteger(id) && id > 0)) {
        res.status(400).json({ ok: false, error: "INVALID_BEACON", message: "A member, its beacon and the beacon's system are each a positive number." });
        return;
      }
      expected = { fromSolarSystemID: Number(before.flight.solarSystemID) || null, toSolarSystemID: beaconSystemID, shipID };
    } else if (kind === "abyss") {
      if (before.flight.inSpace !== true) {
        res.status(409).json({ ok: false, error: "NOT_IN_SPACE", message: "The ship is not in space; undock first." });
        return;
      }
      const itemID = Number(args[0]);
      if (!Number.isSafeInteger(itemID) || itemID <= 0 || args.length !== 2) {
        res.status(400).json({ ok: false, error: "INVALID_ITEM", message: "A filament is deployed by its number and the game mode's." });
        return;
      }
      expected = { fromSolarSystemID: Number(before.flight.solarSystemID) || null, shipID };
    } else if (kind === "abyssExit" || kind === "abyssEntrance") {
      if (before.flight.inSpace !== true) {
        res.status(409).json({ ok: false, error: "NOT_IN_SPACE", message: "The ship is not in space; undock first." });
        return;
      }
      const conduitID = Number(args[0]);
      if (!Number.isSafeInteger(conduitID) || conduitID <= 0 || args.length !== 1) {
        res.status(400).json({ ok: false, error: "INVALID_GATE", message: "A conduit is activated by its number, and nothing else." });
        return;
      }
      expected = { fromSolarSystemID: Number(before.flight.solarSystemID) || null, shipID };
    } else if (kind === "bridge") {
      if (before.flight.inSpace !== true) {
        res.status(409).json({ ok: false, error: "NOT_IN_SPACE", message: "The ship is not in space; undock first." });
        return;
      }
      const structureID = Number(args[0]);
      if (!isPlayerStructureID(structureID) || args.length !== 1) {
        res.status(400).json({ ok: false, error: "INVALID_STRUCTURE", message: "A jump gate is jumped through by its number, and nothing else." });
        return;
      }
      expected = { fromSolarSystemID: Number(before.flight.solarSystemID) || null, shipID };
    } else {
      throw new Error(`No keeping of a ${kind} is known.`);
    }
    // (A cyno's jump, a jump gate's and a filament's into its pocket are kept as a stargate's: a session into another
    // system, the park bound again there.)
    const keeping = kind === "cyno" || kind === "bridge" || kind === "abyss" || kind === "abyssExit" || kind === "abyssEntrance" ? "stargate" : kind;
    if (!await acquireRouteTransition(res, held, keeping, expected)) {
      return;
    }
    // (By the name the transport knows it by, as the generic call asks any write: bridgeCallPolicy.js, gatewaysNameFor.
    // A structure's Dock and Undock the web gateway's list has not: there the park's CmdDock of the structure is asked,
    // as the dock route asked it until 2026-10-14, and the ship's Undock, which this server takes from a structure.)
    const onTheGamePort = Boolean(gamePortPilots && isGamePortHandle(held.bridgeSessionID));
    const outcome = onTheGamePort || service !== "structureDocking"
      ? await heldTopLevelCall(held, req.webSessionID, service, onTheGamePort ? method : gatewaysNameFor(service, method), args, kwargs)
      : method === "Dock"
        ? await heldTopLevelCall(held, req.webSessionID, "beyonce", "CmdDock", args, kwargs)
        : await heldTopLevelCall(held, req.webSessionID, "ship", "Undock", [shipID, Boolean(kwargs && kwargs.ignoreContraband)], null);
    markTransitionAccepted(held);
    const after = await awaitRouteTransition(held, req.webSessionID, keeping, expected, waiting);
    if (!after.ok && kind === "dock") {
      // The server's silent decline, as the route took it: released (unless another change took its place) and
      // answered, the page reading the flight after.
      if (after.code !== "TRANSITION_SUPERSEDED") {
        cancelHeldTransition(held);
      }
      res.json({
        ok: true,
        service,
        method,
        result: outcome.result ?? null,
        notifications: [...outcome.notifications, ...(after.notifications || [])],
        ...pilotClock(held),
      });
      return;
    }
    if (!after.ok) {
      sendTransitionTimeout(res, after, outcome.notifications);
      return;
    }
    // Arrived through a gate: the park bound again in the new system before the answer, so that the ship can move
    // the moment the page acts on it (reparkAfterArrival).
    if (keeping === "stargate") {
      await reparkAfterArrival(held, after.flight && after.flight.solarSystemID);
    }
    res.json({
      ok: true,
      service,
      method,
      result: outcome.result ?? null,
      notifications: [...outcome.notifications, ...after.notifications],
      ...pilotClock(held),
    });
  } catch (error) {
    if (held.transition && held.transition.kind === (kind === "cyno" || kind === "bridge" || kind === "abyss" || kind === "abyssExit" || kind === "abyssEntrance" ? "stargate" : kind)) {
      // (A dock never latches: it is safe to ask again, and an error releases it, as its route had it.)
      if (held.transition.phase === "requested" || kind === "dock") {
        cancelHeldTransition(held);
      } else if (held.transition.phase !== "failed") {
        markTransitionFailed(held, error && error.message);
      }
    }
    if (kind === "undock" && isContrabandWarning(error)) {
      res.status(409).json({ ok: false, error: "CONTRABAND_WARNING", message: contrabandWarningWords(error) });
      return;
    }
    next(error);
  }
}

// --- notificationMgr WRITES
// Its 7 write routes, made for no screen of the page's, went on 2026-10-14 (the loop's item 62): nothing
// asked them. The pairs stay writes (bridgeCallPolicy.js), so the generic call refuses them.

// --- calendarMgr WRITES
// Its 7 write routes, made for no screen of the page's, went on 2026-10-14 (the loop's item 62): nothing
// asked them. The pairs stay writes (bridgeCallPolicy.js), so the generic call refuses them.

// --- accessGroupBookmarkMgr WRITES
// Its 7 write routes, made for no screen of the page's, went on 2026-10-14 (the loop's item 62): nothing
// asked them. The pairs stay writes (bridgeCallPolicy.js), so the generic call refuses them.

// --- R88 character + social WRITES ------------------------------------------
// (charMgr / charUnboundMgr / LSC)
//
// The Phase-3 "character + social" writes batch, following the R86/R87 pattern.
// Every write is a TOP-LEVEL call on the held session (heldTopLevelCall) and
// every route is CONFIRM-GATED via requireWriteConfirmation (from R87): it
// refuses outright (400 CONFIRMATION_REQUIRED, NO dispatch) unless the browser
// passes `confirm: true`. A stray click / stray POST cannot mutate anything.
//
// ⚠ SCOPE — where the write lands:
//   • charMgr Set*/Log*/Add/Delete/Block/Unblock/*Note all resolve the acting
//     character from the SESSION (sessionCharacterID(session)) server-side. The
//     contact/block/note stores are keyed by the session character, so no
//     browser arg can redirect the mutation at a FOREIGN character's list. A
//     note-about-an-item (SetNote(itemID)) / owner-note is the SESSION char's
//     own note store keyed by that id — session-scoped storage, not a foreign
//     mutation.
//   • charUnboundMgr CancelCharacterDeletePrepare(charId) is guarded by
//     session.userid (cancelCharacterDeletePrepare(charId, userid)); ToggleValidation
//     is a debug-only session flag (a normal session is a no-op returning true).
//   • ⚠ charUnboundMgr UpdateCharacterGender(charId,...) / UpdateCharacterBloodline(charId,...)
//     take a CALLER-SUPPLIED charId and mutate that character record directly with
//     no ownership check on the record write (only the session-mirror of gender is
//     account-scoped). These are character-CREATION-flow writes (a pre-birth doll),
//     but the handler trusts the arg — WRITE-SIDE ARG-INJECTION candidate, flagged
//     in docs/arg-injection-leak-handoff.md. Kept plumbed (server-side fix + QA
//     later); confirm-gated here.
//
// ⚠ EXTRA-CARE writes — reachable + confirm-gated, NEVER fired on the live world
// in this plumbing pass: CreateCharacterWithDoll (creates a whole character),
// LSC.SendMessage (sends an OUTWARD chat message), CancelCharacterDeletePrepare
// (char-lifecycle).
//
// FAST-MODE educated-guess responses: every handler returns null except
// AddOwnerNote (a new noteID), ToggleValidation (a bool) and CreateCharacterWithDoll
// (the new characterID) — dispatchBridgeWrite surfaces `result` for those; the
// decoders (web/src/bridge/{characterProfile,charAccount,chat}.ts) read the acks.

// --- charMgr WRITES (12) — all SESSION-scoped
// Its 12 write routes, made for no screen of the page's, went on 2026-10-14 (the loop's item 62): nothing
// asked them. The pairs stay writes (bridgeCallPolicy.js), so the generic call refuses them.

// --- charUnboundMgr WRITES (5) ----------------------------------------------

/**
 * The world's own character-creation tables, off the retail read
 * charUnboundMgr.GetCharCreationInfo.
 *
 * ⚠ THE AUTHORITY ON WHAT IS CREATABLE. CreateCharacterWithDoll derives race,
 * character typeID, starter corporation, starting station and rookie ship from
 * the BLOODLINE (resolveCharacterCreationBloodlineProfile / the school lookup
 * beside it), so a bloodline this read does not name is one the writer cannot
 * honor. The create route validates against these rows for that reason, rather
 * than trusting the ids the browser sends.
 *
 * Wire shape: {type:"dict"} of "races" -> {type:"list"} of util.KeyVal, and
 * "bloodlines" -> the same. Decoded to plain rows here because the write path
 * needs to reason about them; the READ route ships the raw dict on to the
 * browser untouched, like every other bridge read.
 */
function decodeCharCreationTables(result) {
  const dictEntries =
    result && result.type === "dict" && Array.isArray(result.entries) ? result.entries : [];
  const listOf = (key) => {
    const entry = dictEntries.find((pair) => Array.isArray(pair) && pair[0] === key);
    const value = entry ? entry[1] : null;
    return value && Array.isArray(value.items) ? value.items : [];
  };
  const readField = (row, field) => {
    const entries =
      row && row.args && Array.isArray(row.args.entries) ? row.args.entries : [];
    const entry = entries.find((pair) => Array.isArray(pair) && pair[0] === field);
    return entry ? entry[1] : undefined;
  };
  const asInt = (value) => {
    const numeric = Number(value && typeof value === "object" ? value.value : value);
    return Number.isFinite(numeric) ? Math.trunc(numeric) : 0;
  };
  const asText = (value) => (typeof value === "string" ? value : "");

  return {
    races: listOf("races")
      .map((row) => ({
        raceID: asInt(readField(row, "raceID")),
        raceName: asText(readField(row, "raceName")),
        shipTypeID: asInt(readField(row, "shipTypeID")),
        shipName: asText(readField(row, "shipName")),
      }))
      .filter((race) => race.raceID > 0),
    bloodlines: listOf("bloodlines")
      .map((row) => ({
        bloodlineID: asInt(readField(row, "bloodlineID")),
        bloodlineName: asText(readField(row, "bloodlineName")),
        raceID: asInt(readField(row, "raceID")),
        corporationID: asInt(readField(row, "corporationID")),
      }))
      .filter((bloodline) => bloodline.bloodlineID > 0),
  };
}

// GET /api/bridge/char-creation-info — everything the create-character screen
// needs to offer a choice, from the TWO sources that actually have it.
//
// ACCOUNT-LEVEL, not character-level: this is the screen a player reaches with
// no character online (and, on a fresh account, with no character at all), so it
// must not sit behind a held session. See accountLevelCall.
//
// races + bloodlines come from the retail read (the world's own tables — the
// authority on what CreateCharacterWithDoll will accept) and ship out raw, like
// every other bridge read. ancestries come from the SDE, because this world has
// no ancestry table at all: the writer stores ancestryID verbatim and never
// validates it. Filtering the SDE's ancestries down to the bloodlines this world
// actually has is the browser's job — it has both lists.
app.get("/api/bridge/char-creation-info", requireAuth, async (req, res, next) => {
  try {
    const outcome = await accountLevelCall(req, "charUnboundMgr", "GetCharCreationInfo", []);
    res.json({
      ok: true,
      creationInfo: outcome.result ?? null,
      ancestries: staticData.listAncestries(),
      notifications: outcome.notifications,
    });
  } catch (error) {
    next(error);
  }
});

// Account-level, one-dispatch creation guard. A roster reread resolves an
// ambiguous result without submitting CreateCharacter twice.
app.get("/api/bridge/character/creation-state", requireAuth, async (req, res, next) => {
  try { res.json({ ok: true, ...(await characterCreation.state(req)) }); }
  catch (error) { next(error); }
});

/** A positive int off a JSON body field; 0 when absent or unparseable. */
function creationBodyID(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : 0;
}

// ⚠ EXTRA-CARE (creates a whole character) — confirm-gated.
// POST /api/bridge/character/create-with-doll
//   { name, raceID, genderID, bloodlineID?, ancestryID?, confirm: true }
//
// ACCOUNT-LEVEL (see accountLevelCall): creation necessarily precedes selection,
// and on a new account there is nothing to select, so this cannot sit behind a
// held session. The account it creates on is the BFF's own req.account.accountID
// — the browser never names an account, and the handler itself reads
// session.userid, so a body cannot aim this at someone else's account.
//
// TYPED BODY, NOT RAW ARGS. This used to forward `body.args` verbatim, which was
// fine for a plumbing probe that never fired, but it means the browser composes
// the retail tuple — including the doll payloads. The tuple is built here now,
// from named fields, against the world's own tables:
//
//   • bloodlineID must belong to raceID. An unknown or mismatched one is
//     REFUSED rather than silently corrected, because bloodline is what the
//     writer derives race / corp / station / rookie ship from — quietly
//     creating a different character than the one asked for is worse than
//     saying no. Absent, it is rolled at random within the race.
//   • ancestryID must belong to the resolved bloodline (checked against the SDE
//     rows, since the world has no ancestry table). Absent, rolled at random.
//   • schoolID is sent as 0 so the server picks a school for the race itself
//     (resolveCharacterCreationSchoolIDForRace). School only chooses the starter
//     CORPORATION here — every new character starts at the same station
//     regardless (NEW_CHARACTER_START_OVERRIDE).
//   • The two paperdoll payloads are hard nulls. This client renders no doll,
//     and a null pair is what makes the handler record paperDollState 2 ("no
//     doll") rather than claim an empty one exists.
//
// The 7-arg LEGACY signature is deliberate: resolveCreateCharacterSignature only
// reads args[7] as a raceID for the 8-arg container shapes, and those require
// both doll payloads to be present. With nulls there, a would-be 8th element is
// never read — so passing raceID would be passing a number the handler ignores.
// Race reaches the server through the bloodline, which is where it genuinely
// lives.
//
// The NAME is not pre-validated here. validateCharacterName runs server-side on
// every create and rejects with CharNameInvalid; the screen calls ValidateNameEx
// as the player types so the refusal is not a surprise, and this route lets the
// server have the last word.
app.post("/api/bridge/character/create-with-doll", requireAuth, async (req, res, next) => {
  if (!requireWriteConfirmation(req, res, "This creates a NEW character. This must be confirmed explicitly.")) {
    return;
  }
  const body = req.body || {};
  const name = String(body.name || "").trim().replace(/\s+/g, " ");
  const raceID = creationBodyID(body.raceID);
  const requestedBloodlineID = creationBodyID(body.bloodlineID);
  const requestedAncestryID = creationBodyID(body.ancestryID);
  // 0 (female) is a legal gender, so an absent field defaults to 1 (male) the
  // way the handler's own normalizeCreationGender does rather than to 0.
  const genderID = body.genderID === 0 || body.genderID === "0" ? 0 : 1;

  if (!name) {
    res.status(400).json({ ok: false, error: "NAME_REQUIRED", message: "A character name is required." });
    return;
  }
  if (raceID <= 0) {
    res.status(400).json({ ok: false, error: "RACE_REQUIRED", message: "A race is required." });
    return;
  }

  try {
    const tables = decodeCharCreationTables(
      (await accountLevelCall(req, "charUnboundMgr", "GetCharCreationInfo", [])).result,
    );
    if (!tables.races.some((race) => race.raceID === raceID)) {
      res.status(400).json({ ok: false, error: "RACE_UNKNOWN", message: "That race does not exist on this server." });
      return;
    }

    const raceBloodlines = tables.bloodlines.filter((bloodline) => bloodline.raceID === raceID);
    if (raceBloodlines.length === 0) {
      res.status(409).json({
        ok: false,
        error: "NO_BLOODLINE_FOR_RACE",
        message: "This server has no bloodline for that race.",
      });
      return;
    }
    let bloodline = null;
    if (requestedBloodlineID > 0) {
      bloodline = raceBloodlines.find((row) => row.bloodlineID === requestedBloodlineID) || null;
      if (!bloodline) {
        res.status(400).json({
          ok: false,
          error: "BLOODLINE_INVALID",
          message: "That bloodline does not belong to that race.",
        });
        return;
      }
    } else {
      bloodline = raceBloodlines[Math.floor(Math.random() * raceBloodlines.length)];
    }

    const bloodlineAncestries = staticData
      .listAncestries()
      .filter((ancestry) => ancestry.bloodlineID === bloodline.bloodlineID);
    let ancestryID = 0;
    if (requestedAncestryID > 0) {
      if (!bloodlineAncestries.some((ancestry) => ancestry.ancestryID === requestedAncestryID)) {
        res.status(400).json({
          ok: false,
          error: "ANCESTRY_INVALID",
          message: "That ancestry does not belong to that bloodline.",
        });
        return;
      }
      ancestryID = requestedAncestryID;
    } else if (bloodlineAncestries.length > 0) {
      ancestryID =
        bloodlineAncestries[Math.floor(Math.random() * bloodlineAncestries.length)].ancestryID;
    }

    const args = [name, bloodline.bloodlineID, genderID, ancestryID, null, null, 0];
    const outcome = await characterCreation.create(req, name,
      () => accountLevelCall(req, "charUnboundMgr", "CreateCharacterWithDoll", args));
    const characterID = Number(outcome.result) || 0;
    res.json({
      ok: true,
      applied: characterID > 0,
      result: outcome.result ?? null,
      characterID: characterID > 0 ? characterID : null,
      // What the rolls landed on, so the screen can say what it made.
      bloodlineID: bloodline.bloodlineID,
      ancestryID: ancestryID || null,
      notifications: outcome.notifications,
    });
  } catch (error) {
    next(error);
  }
});

// --- The GM console ---------------------------------------------------------
//
// ⚠⚠ DEV-ONLY, AND THE WIDEST SURFACE IN THIS FILE. slash.SlashCmd runs this
// world's own chat commands (eve.js services/chat/chatCommands.js) — ~150 of
// them, including destructive ones (/suicide), world-spawning ones (/npc) and
// the item-granting ones this route exists for (/giveitem, /gmships,
// /gmweapons, /giveskill). eve.js applies NO role gate to any of them.
//
// It is here because the web client could not otherwise stage its own test
// state: no way to give a pilot a ship, a module or a round of ammunition, so
// features whose subject the test pilot simply does not own could not be
// exercised at all. That is not a hypothetical — the ammo work is blocked on
// exactly this, because the only live pilot flies a mining barge whose modules
// take no charges.
//
// The command is forwarded VERBATIM and deliberately so: this is an operator's
// console, and a BFF that curated the command list would be a worse, staler
// copy of the server's own. What the route does add is the confirmation gate,
// and the refusal to let the generic /call seam reach the same pair.
//
// The reply is the server's own message string (or its "Command failed: …"),
// surfaced untouched — the console shows what the world said, never a guess.
app.post("/api/bridge/gm/slash", requireAuth, async (req, res, next) => {
  if (!requireWriteConfirmation(req, res, "This runs a GM command against the live world. Confirm to continue.")) {
    return;
  }
  const command = String((req.body || {}).command || "").trim();
  if (!command) {
    res.status(400).json({ ok: false, error: "COMMAND_REQUIRED", message: "A command is required." });
    return;
  }
  if (!command.startsWith("/") && !command.startsWith(".")) {
    // The server answers a bare word with its whole command list, which reads as
    // a wall of noise. Say the one thing that is actually wrong instead.
    res.status(400).json({
      ok: false,
      error: "COMMAND_INVALID",
      message: "A GM command starts with / (or . for the container commands).",
    });
    return;
  }
  await dispatchBridgeWrite(req, res, next, "slash", "SlashCmd", [command]);
});

// --- LSC WRITES (1)
// Its 1 write route, made for no screen of the page's, went on 2026-10-14 (the loop's item 62): nothing
// asked them. The pairs stay writes (bridgeCallPolicy.js), so the generic call refuses them.

// --- R89 FINANCIAL WRITES ---------------------------------------------------
// (account / LPSvc / LPStoreMgr / insuranceSvc / bountyProxy / killRightMgr)
//
// The Phase-3 "financial" writes batch, following the R86–R88 pattern. Every
// write is a TOP-LEVEL call on the held session (dispatchBridgeWrite) and every
// route is CONFIRM-GATED via requireWriteConfirmation: it refuses outright
// (400 CONFIRMATION_REQUIRED, NO dispatch) unless the browser passes
// `confirm: true`. A stray click / stray POST cannot move ISK or LP.
//
// ⚠⚠ SAFETY — EVERY write here SPENDS/TRANSFERS ISK or LP, or affects a kill
// right. NONE is ever fired on the live world in the plumbing pass: these routes
// are verified only for reachability + refuses-without-confirm. The ISK/LP
// spenders carry an explicit "this spends/transfers ISK/LP" confirm message.
//
// ⚠ SCOPE — where the money leaves (all session-scoped, no foreign source):
//   • account.GiveCash debits session.characterID; GiveCashFromCorpAccount debits
//     the SESSION's corp wallet (server resolveSessionCorporationID) — the
//     fromAccountKey only picks a division WITHIN that corp. SetContactCost sets
//     the session character's contact price.
//   • LPSvc.TransferLPFromMyWalletToOtherCorp / TransferLPFromMyCorpWalletToOtherCorp
//     resolve the source from the SESSION (character wallet / session.corporationID
//     with a corp-role check); the first arg is the RECEIVER corp, the second the
//     LP issuer namespace — never the source. ExchangeConcordLP is a stub.
//   • LPStoreMgr.TakeOfferForCharacter spends the SESSION char's LP (corpID selects
//     the STORE); TakeOfferForCorporation is a stub.
//   • insuranceSvc.InsureShip debits the session; itemID is the ship to insure.
//   • bountyProxy.AddToBounty debits the session char's wallet; SellKillRight /
//     CancelSellKillRight list/withdraw a kill right the session owns.
//   • killRightMgr.ActivateKillRight / BuyKillRight act on the session character.
// No caller-supplied FOREIGN source was found — nothing appended to
// docs/arg-injection-leak-handoff.md for this batch.
//
// FAST-MODE educated-guess responses: most handlers return null (GiveCash to a
// corp answers a [from,to] balance pair; TakeOfferForCharacter a bool) — the
// decoders (web/src/bridge/{wallet,rewards,lpStore,insurance,bounties,killRights}.ts)
// read the acks. These are EDUCATED GUESSES, never exercised (never fired live).

// --- account WRITES (3) — session-scoped source
// Its 3 write routes, made for no screen of the page's, went on 2026-10-14 (the loop's item 62): nothing
// asked them. The pairs stay writes (bridgeCallPolicy.js), so the generic call refuses them.

// --- LPSvc WRITES (3) — session-scoped source
// Its 3 write routes, made for no screen of the page's, went on 2026-10-14 (the loop's item 62): nothing
// asked them. The pairs stay writes (bridgeCallPolicy.js), so the generic call refuses them.

// --- LPStoreMgr WRITES (2) — session-scoped source
// Its 2 write routes, made for no screen of the page's, went on 2026-10-14 (the loop's item 62): nothing
// asked them. The pairs stay writes (bridgeCallPolicy.js), so the generic call refuses them.

// --- insuranceSvc WRITES (2) — session-scoped source
// Its 2 write routes, made for no screen of the page's, went on 2026-10-14 (the loop's item 62): nothing
// asked them. The pairs stay writes (bridgeCallPolicy.js), so the generic call refuses them.

// --- bountyProxy WRITES (3) — session-scoped source
// Its 3 write routes, made for no screen of the page's, went on 2026-10-14 (the loop's item 62): nothing
// asked them. The pairs stay writes (bridgeCallPolicy.js), so the generic call refuses them.

// --- killRightMgr WRITES (2) — session-scoped source
// Its 2 write routes, made for no screen of the page's, went on 2026-10-14 (the loop's item 62): nothing
// asked them. The pairs stay writes (bridgeCallPolicy.js), so the generic call refuses them.

// --- R106 marketProxy FINANCIAL WRITES (3) — CLOSES THE PLUMBING SWEEP
// Its 3 write routes, made for no screen of the page's, went on 2026-10-14 (the loop's item 62): nothing
// asked them. The pairs stay writes (bridgeCallPolicy.js), so the generic call refuses them.

// --- R90 SHIP + FIGHTER IN-SPACE WRITES -------------------------------------
// (ship / fighterMgr)
//
// The Phase-3 "ship + fighter in-space ops" writes batch, following the R86–R89
// pattern. Every write is a TOP-LEVEL call on the held session
// (dispatchBridgeWrite) and every route is CONFIRM-GATED via
// requireWriteConfirmation: it refuses outright (400 CONFIRMATION_REQUIRED, NO
// dispatch) unless the browser passes `confirm: true`.
//
// ⚡ FAST MODE — Farmer is DOCKED, so most of these return a not-in-space error
// and are NOT live-exercisable. Routes are verified for reachability +
// refuses-without-confirm only; the decoders are educated guesses (QA later).
//
// ⚠⚠ EXTRA-CARE — NEVER fired on the live world even where reachable:
//   • ship.Eject / ship.SafeLogoff — change the pilot's session state.
//   • ship.Jettison / ship.Drop — dump cargo/orbitals to space (could lose items).
//   • fighterMgr.CmdAbandonFighter — abandons a fighter in space.
// Their confirm messages say so explicitly.
//
// ⚠ SCOPE (all session-scoped — no foreign ship/fighter mutation):
//   • Every ship write resolves the ACTIVE ship / capsule from the SESSION
//     (server this._getShipID(session) / ejectSession(session) /
//     getActiveShipRecord(session.characterID)). AssembleShip / FitShips list the
//     packaged ships by session characterID (findCharacterShip / char-scoped
//     multifit lister — ownership-checked). The itemID/objectID-taking ops
//     (Scoop / ScoopToMobileDepotHold / Jettison / LaunchFromShip /
//     LaunchFromContainer / Drop) act on space objects near the session's ship,
//     gated on proximity/owner in the server helpers — no foreign ship boarded.
//   • Every fighterMgr write resolves the controller HOST from the SESSION and
//     validates each fighter against that host before moving it — a fighterID the
//     host does not own is a no-op.
// No caller-supplied FOREIGN source found — nothing appended to
// docs/arg-injection-leak-handoff.md for this batch.

// --- ship WRITES (14) -------------------------------------------------------

// On the game port a jettisoned can is a ball of the pilot's own park, and comes with the ballpark update that
// follows the call's answer: seen 0.9 to 1.7 s after it in three runs on 2026-10-12, where the gateway's scene (the
// server's own) had it at the first look. So a route that looks for the can gives the park as long as a launch
// gives it for its drones (DRONE_ARRIVAL_WAIT_MS), and through the gateway the two short looks it always had.
const JETTISON_CAN_WAIT_MS = 3000;
const JETTISON_CAN_STEP_MS = 250;
const JETTISON_CAN_GATEWAY_WAIT_MS = 400;
const JETTISON_CAN_GATEWAY_STEP_MS = 200;
const jettisonSleep = typeof options.transitionSleep === "function"
  ? options.transitionSleep
  : (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const hostedJettison = createJettisonCustodyHandler({
  now: () => Date.now(),
  readScope: async (req, owner, notifications) => {
    owner.current(false);
    const held = bridgeSessions.get(req.webSessionID);
    if (!held) throw Object.assign(new Error("Hosted session is unavailable."), { code: "JETTISON_SCOPE_CHANGED" });
    const flight = await readHeldFlight(held, req.webSessionID);
    if (Array.isArray(flight.notifications)) notifications.push(...flight.notifications);
    owner.current(false); assertCurrentHeldSession(held, req.webSessionID);
    const assignment = miningOperations.assignment(owner.scope.operationID, owner.scope.pilotID);
    const target = assignment?.currentTarget;
    if (assignment?.role !== "MINER" || assignment.unloadPolicy !== "HAULER_SERVICE" || assignment.stopRequested ||
        !target || target.claimedByOperationID !== owner.scope.operationID || flight.flight?.inSpace !== true ||
        flight.flight.shipID !== held.activeShipID || flight.flight.solarSystemID !== target.systemID)
      throw Object.assign(new Error("The captured ore logistics assignment is unavailable."), { code: "JETTISON_SCOPE_CHANGED" });
    return { ...owner.scope, shipID: held.activeShipID, systemID: target.systemID,
      targetKey: target.targetKey, targetClaimedAt: target.claimedAt };
  },
  readEvidence: async (req, owner, custody, notifications) => {
    owner.current(false);
    const held = bridgeSessions.get(req.webSessionID);
    assertCurrentHeldSession(held, req.webSessionID);
    const readScene = async () => {
      const read = await gateway.readSpaceSnapshot(held.bridgeSessionID, { userid: held.accountID });
      if (Array.isArray(read.notifications)) notifications.push(...read.notifications);
      owner.current(false); assertCurrentHeldSession(held, req.webSessionID);
      return read.space;
    };
    let scene = await readScene();
    const listed = await boundCall(held, req.webSessionID, cargoBindSpec(held, held.activeShipID),
      "ListByFlags", [[...jettisonCustody.SOURCE_FLAGS]], null, notifications);
    if (Array.isArray(listed.notifications)) notifications.push(...listed.notifications);
    owner.current(false); assertCurrentHeldSession(held, req.webSessionID);
    const rows = jettisonCustody.inventoryRows(listed.result);
    let context = jettisonCustody.sceneContext(scene, owner.scope.pilotID);
    const unsettled = custody && jettisonCustody.unresolved(custody);
    const newCans = () => context.ownedContainerIDs.filter(id => !custody.existingContainerIDs.includes(id));
    // The ore gone from the holds and no can of the pilot's that was not there before: on the game port the can
    // has not come yet. Ore that is in the holds still has gone nowhere, and no can is waited for.
    if (unsettled && context && heldOnTheGamePort(held) && Array.isArray(rows) &&
        custody.items.every(item => !rows.some(row => row.itemID === item.itemID))) {
      for (let waited = 0; waited < JETTISON_CAN_WAIT_MS && context && newCans().length === 0; waited += JETTISON_CAN_STEP_MS) {
        await jettisonSleep(JETTISON_CAN_STEP_MS);
        scene = await readScene();
        context = jettisonCustody.sceneContext(scene, owner.scope.pilotID);
      }
    }
    const containers = [];
    if (unsettled && context) {
      const candidates = newCans();
      if (candidates.length <= 8) for (const itemID of candidates) {
        let items = null;
        try {
          const read = await boundCall(held, req.webSessionID, containerBindSpec(itemID), "List", [], null, notifications);
          if (Array.isArray(read.notifications)) notifications.push(...read.notifications);
          items = jettisonCustody.inventoryRows(read.result);
        } catch { /* Unreadable contents remain unknown, never an empty can. */ }
        owner.current(false); assertCurrentHeldSession(held, req.webSessionID);
        containers.push({ itemID, ownerID: owner.scope.pilotID, items });
      }
    }
    return { scene, rows, containers };
  },
  assertDispatch: async (req, owner, custody) => {
    owner.current(true);
    const held = bridgeSessions.get(req.webSessionID);
    assertCurrentHeldSession(held, req.webSessionID);
    const target = miningOperations.assignment(owner.scope.operationID, owner.scope.pilotID)?.currentTarget;
    if (held.activeShipID !== custody.scope.shipID || target?.targetKey !== custody.scope.targetKey ||
        target.claimedAt !== custody.scope.targetClaimedAt || target.systemID !== custody.scope.systemID)
      throw Object.assign(new Error("Jettison scope changed before dispatch."), { code: "JETTISON_SCOPE_CHANGED" });
  },
  dispatch: (req, custody) => heldTopLevelCall(bridgeSessions.get(req.webSessionID), req.webSessionID,
    "ship", "Jettison", [custody.items.map(row => row.itemID)], null),
  register: custody => miningOperations.registerContainer(custody.scope.operationID, custody.scope.pilotID,
    custody.containerID, custody.scope.systemID, custody.scope.targetKey, custody.scope.targetClaimedAt),
});

app.post("/api/bridge/ship/jettison/reconcile", requireAuth, async (req, res) => {
  const held = requireHeldBridgeSession(req, res);
  if (!held) return;
  const owner = botHost.jettisonOwnerForClaim?.(held.characterID, req.get(botHostModule.BOT_HEADER));
  if (!owner) return res.status(409).json({ ok: false, error: "JETTISON_CUSTODY_UNAVAILABLE" });
  await hostedJettison(req, res, owner, true);
});

// ⚠ EXTRA-CARE (dumps cargo to space — items can be lost). Jettison(itemIDs), for a hosted bot of a Mining Operation:
// its can found and given to the operation, or a hosted miner's custody kept. Any other jettison is the page's own
// call since 2026-10-14 (web/src/bridge/shipWrites.ts, jettison: GetShipAccess().Jettison(itemIDs),
// invItemFunctions.py 63, by the generic call), and is refused here.
app.post("/api/bridge/ship/jettison", requireAuth, async (req, res, next) => {
  if (!requireWriteConfirmation(req, res, "This JETTISONS the selected items into space, where anyone can take them. This must be confirmed explicitly.")) {
    return;
  }
  const held = requireHeldBridgeSession(req, res);
  if (!held) return;
  const owner = botHost.jettisonOwnerForClaim?.(held.characterID, req.get(botHostModule.BOT_HEADER));
  if (owner) { await hostedJettison(req, res, owner); return; }
  const association = botHost.operationForClaim?.(held.characterID, req.get(botHostModule.BOT_HEADER));
  if (!association) {
    res.status(409).json({ ok: false, error: "OPERATION_REQUIRED",
      message: "A jettison outside a Mining Operation is the page's own call." });
    return;
  }
  let issued = false;
  try {
    const assignment = miningOperations.assignment(association.operationID, held.characterID);
    if (assignment?.role !== "MINER" || !assignment.currentTarget || assignment.stopRequested) {
      res.status(409).json({ ok: false, error: "OPERATION_TARGET_REQUIRED" }); return;
    }
    const readCans = async () => {
      const scene = (await gateway.readSpaceSnapshot(held.bridgeSessionID, { userid: held.accountID })).space;
      if (!Array.isArray(scene?.entities) || Number(scene.solarSystemID) !== assignment.currentTarget.systemID) {
        throw Object.assign(new Error("Operation can scene is unreadable."), { code: "OPERATION_CONTAINER_SCENE_UNREADABLE" });
      }
      return scene.entities.filter(row => row.kind === "container" && Number(row.ownerID) === held.characterID)
        .map(row => Number(row.itemID)).filter(id => Number.isSafeInteger(id) && id > 0);
    };
    const before = new Set(await readCans());
    issued = true;
    const outcome = await heldTopLevelCall(held, req.webSessionID, "ship", "Jettison", [bridgeIDList((req.body || {}).itemIDs)], null);
    const first = Array.isArray(outcome.result) ? outcome.result[0] : outcome.result?.items?.[0];
    const moved = Array.isArray(first) ? first : Array.isArray(first?.items) ? first.items : null;
    // The can is looked for until it is there, for as long as the pilot's transport may take to show it; a
    // jettison the server answered as moving nothing made none, and is not waited for.
    const [waitMs, stepMs] = heldOnTheGamePort(held)
      ? [JETTISON_CAN_WAIT_MS, JETTISON_CAN_STEP_MS] : [JETTISON_CAN_GATEWAY_WAIT_MS, JETTISON_CAN_GATEWAY_STEP_MS];
    let created = (await readCans()).filter(id => !before.has(id));
    for (let waited = 0; waited < waitMs && created.length === 0 && moved?.length !== 0; waited += stepMs) {
      await jettisonSleep(stepMs);
      created = (await readCans()).filter(id => !before.has(id));
    }
    if (created.length === 0 && moved?.length === 0) {
      res.json({ ok: true, applied: true, result: outcome.result ?? null, notifications: outcome.notifications }); return;
    }
    if (created.length !== 1 || !miningOperations.registerContainer(association.operationID,
        held.characterID, created[0], assignment.currentTarget.systemID)) {
      miningOperations.blockContainerProvenance(association.operationID);
      res.status(409).json({ ok: false, error: "OPERATION_CONTAINER_PROVENANCE_UNCONFIRMED",
        message: "Jettison may have committed, but its exact operation container could not be identified. Stop and reconcile before hauling." });
      return;
    }
    res.json({ ok: true, applied: true, result: outcome.result ?? null, notifications: outcome.notifications });
  } catch (error) {
    if (issued) miningOperations.blockContainerProvenance(association.operationID);
    next(error);
  }
});

// --- fighterMgr WRITES (9)
// Its 9 write routes, made for no screen of the page's, went on 2026-10-14 (the loop's item 62): nothing
// asked them. The pairs stay writes (bridgeCallPolicy.js), so the generic call refuses them.

// --- R91 CONTRACT + FITTING WRITES ------------------------------------------
//
// The Phase-3 "contracts + fittings" writes batch, following the R86–R90 pattern.
// Every write is a TOP-LEVEL call on the held session (heldTopLevelCall via
// dispatchBridgeWrite) and every route is CONFIRM-GATED (requireWriteConfirmation):
// it refuses outright (400 CONFIRMATION_REQUIRED, NO dispatch) unless the browser
// passes `confirm: true`. A stray click or stray POST cannot create, accept,
// complete, delete, or bid on a contract, nor save/rename/delete a fitting.
//
// ⚠ EXTRA-CARE, never fired live in this plumbing pass: AcceptContract / PlaceBid
// (move ISK/items), DeleteContract / DeleteMultipleContracts / DeleteFitting /
// DeleteManyFittings (destroy data), GM_ExpireContract (admin — returns false /
// 403-equivalent for a normal non-GM session; wired + noted).
//
// ⚠ ARG-INJECTION — GUARDED server-side (unlike the contract READS, handoff #11):
//   • contractProxy deleteContract throws unless isIssuedBySession; acceptContract
//     throws unless canAcceptContract (and refuses your own unassigned contract);
//     deleteMultipleContracts loops deleteContract so inherits the guard. PlaceBid /
//     FinishAuction / SplitStack / the two notification deletes are server-side
//     stubs (null/false). GM_ExpireContract is GM-only.
//   • charFittingMgr / corpFittingMgr writes resolve the ownerID
//     (resolveRequestedOwnerID; 0 → the SESSION owner) and then
//     assertSessionCanMutateOwner BEFORE any store mutation — a foreign ownerID is
//     a permission throw, never a foreign mutation.
// Nothing added to arg-injection-leak-handoff.md on the write side — the guards hold.

// --- contractProxy WRITES (11)
// Its 11 write routes, made for no screen of the page's, went on 2026-10-14 (the loop's item 62): nothing
// asked them. The pairs stay writes (bridgeCallPolicy.js), so the generic call refuses them.

// --- charFittingMgr / corpFittingMgr WRITES (5)
// Its 5 write routes, made for no screen of the page's, went on 2026-10-14 (the loop's item 62): nothing
// asked them. The pairs stay writes (bridgeCallPolicy.js), so the generic call refuses them.

// --- R92 IN-SPACE SERVICE WRITES --------------------------------------------
//
// The Phase-3 "in-space services" writes batch, following the R86-R91 pattern:
// allowlist pair + confirm-gated BFF route (dispatchBridgeWrite) + educated-guess
// decoder + basic test. Sixteen writes across four TOP-LEVEL services (sovMgr /
// essMgr / abyssalMgr / pvpFilamentMgr — sm.RemoteSvc / ProxySvc, no bound-object
// step). Farmer is DOCKED so NONE is live-exercisable — reachability + refusal
// only. Every route is confirm-gated (no `confirm:true` => 400, no dispatch).
//
// ⚠ NEVER FIRED LIVE: sov DestroySkyhooks / AcquireSkyhooks (destructive
// sovereignty mutations) and ess RequestUnlockReserveBank (ISK payout).
//
// ⚠ ARG-INJECTION (flagged, kept plumbed — see docs/arg-injection-leak-handoff.md):
// the three sovMgr writes take a CALLER-SUPPLIED solarSystemID / skyhookID list with
// NO session scope check and NO handler-level admin gate. The ESS bank writes resolve
// solarSystemID from the SESSION; the abyssal + pvp actions are server-side
// rejection/no-op stubs (no runtime abyssal content in this world).

// --- sovMgr WRITES (3) — ⚠ caller-supplied scope, no admin gate
// Its 3 write routes, made for no screen of the page's, went on 2026-10-14 (the loop's item 62): nothing
// asked them. The pairs stay writes (bridgeCallPolicy.js), so the generic call refuses them.

// --- essMgr WRITES (5) — session-resolved solarSystemID
// Its 5 write routes, made for no screen of the page's, went on 2026-10-14 (the loop's item 62): nothing
// asked them. The pairs stay writes (bridgeCallPolicy.js), so the generic call refuses them.

// --- abyssalMgr WRITES (5) — server-side rejection/no-op stubs
// Its 5 write routes, made for no screen of the page's, went on 2026-10-14 (the loop's item 62): nothing
// asked them. The pairs stay writes (bridgeCallPolicy.js), so the generic call refuses them. A filament's deploy,
// AbyssalEntranceDeployment, is the page's own write since 2026-10-15 (web/src/bridge/abyssalKeys.ts), solo's a
// session change (dispatchPlaceChangeWrite, "abyss").

// --- pvpFilamentMgr WRITES (3) — server-side rejection/no-op stubs
// Its 3 write routes, made for no screen of the page's, went on 2026-10-14 (the loop's item 62): nothing
// asked them. The pairs stay writes (bridgeCallPolicy.js), so the generic call refuses them.

// --- R93 MISC UTILITY WRITES ------------------------------------------------
//
// The Phase-3 "misc utility" writes batch, following the R86-R92 pattern:
// allowlist pair + confirm-gated BFF route (dispatchBridgeWrite) + educated-guess
// decoder + basic test. Thirteen writes across six TOP-LEVEL services whose READS
// were wired earlier (agentMgr R64 / petitioner R70 / industryManager R15 /
// planetMgr + structureAssetSafety R71 / structureDirectory R63). Every route is
// confirm-gated (no `confirm:true` => 400, no dispatch). Farmer is DOCKED so the
// nav writes return not-in-space and none of the consequential writes is
// live-exercisable — reachability + refusal only.
//
// ⚠ NEVER FIRED LIVE (extra-care): planetMgr.DeleteLaunch (destructive), the three
// structureAssetSafety MOVE writes (relocate assets), and petitioner.CreatePetition
// (opens a support ticket — outward). Reachable + confirm-gated only.
//
// ⚠ ARG-INJECTION (checked): SetStructureDescription is GUARDED server-side
// (canManageStructure throws for a structure the session cannot manage); the
// asset-safety moves resolve the owner from the SESSION (not a caller id);
// DeleteLaunch passes session.characterID to the store. No new unguarded
// caller-supplied-id write in this batch.

// --- agentMgr nav/journal WRITES (4) — docked => not-in-space
// Its 3 write routes, made for no screen of the page's, went on 2026-10-14 (the loop's item 62): nothing
// asked them. The pairs stay writes (bridgeCallPolicy.js), so the generic call refuses them.

// --- petitioner support WRITES (3)
// Its 3 write routes, made for no screen of the page's, went on 2026-10-14 (the loop's item 62): nothing
// asked them. The pairs stay writes (bridgeCallPolicy.js), so the generic call refuses them.

// --- industryManager WRITES (1)
// Its 1 write route, made for no screen of the page's, went on 2026-10-14 (the loop's item 62): nothing
// asked them. The pairs stay writes (bridgeCallPolicy.js), so the generic call refuses them.

// --- planetMgr WRITES (1) — ⚠ DESTRUCTIVE
// Its 1 write route, made for no screen of the page's, went on 2026-10-14 (the loop's item 62): nothing
// asked them. The pairs stay writes (bridgeCallPolicy.js), so the generic call refuses them.

// --- structureDirectory WRITES (1) — canManageStructure-guarded
// Its 1 write route, made for no screen of the page's, went on 2026-10-14 (the loop's item 62): nothing
// asked them. The pairs stay writes (bridgeCallPolicy.js), so the generic call refuses them.

// --- structureAssetSafety MOVE WRITES (3) — ⚠ consequential
// Its 3 write routes, made for no screen of the page's, went on 2026-10-14 (the loop's item 62): nothing
// asked them. The pairs stay writes (bridgeCallPolicy.js), so the generic call refuses them.

// --- R94 FLEET TOP-LEVEL WRITES (fleetObjectHandler / fleetProxy / fleetMgr) --
//
// The LAST Phase-3 top-level writes batch (CLOSES Phase-3 top-level writes; the
// 3 deferred PLEX writes aside), following the R86-R93 pattern: allowlist pair +
// confirm-gated BFF route (dispatchBridgeWrite) + educated-guess decoder
// (fleetWrites.ts) + basic test. Eleven writes across three fleet services whose
// seams were wired earlier (fleetProxy READS R69 / fleetObjectHandler bind R72 +
// bound reads R85). Every route is confirm-gated (no `confirm:true` => 400, no
// dispatch). Farmer is DOCKED + fleetless, so the fleet-management writes return a
// not-in-fleet error and none is live-exercisable — reachability + refusal only.
//
// ⚠ EXTRA-CARE OUTWARD PAIR: fleetMgr.BroadcastToBubble / BroadcastToSystem send a
// message to every fleet member in the session char's bubble / system. Reachable +
// confirm-gated but NEVER broadcast on the live world in this plumbing pass.
// fleetObjectHandler.CreateFleet mints a whole fleet — likewise reachable + gated
// but NEVER fired live.
//
// ⚠ ARG-INJECTION (checked): the advert / management / broadcast writes resolve the
// fleet from the SESSION (session.characterID / session.fleetid), not a caller id.
// ApplyToJoinFleet takes a caller-supplied fleetID — but that is the TARGET public
// advert to apply to (intended fleet-finder semantics), not a foreign-fleet
// mutation; noted in the R94 arg-injection addendum, kept plumbed.

// fleetProxy fleet-finder WRITES ---------------------------------------------

// fleetMgr fleet-management WRITES -------------------------------------------

/**
 * The pilot's fleet left, as the client's fleet service leaves one (fleetSvc.LeaveFleet, 365 to 371):
 * self.fleet.LeaveFleet(), on the fleet's own object, where the client holds one; fleetMgr's ForceLeaveFleet only
 * where it holds none. The game port says whether the object is held (pilots.js fleet); the gateway's session
 * cannot, and asks fleetMgr as it always did. Whatever comes of it, none of the BFF's handles for the fleet is
 * kept: the write may have been made before a failure was heard of.
 */
async function leaveFleetCall(held, webSessionID, args = [], kwargs = null) {
  try {
    const own = gamePortPilots && isGamePortHandle(held.bridgeSessionID) && typeof gamePortPilots.fleet === "function"
      ? gamePortPilots.fleet({ userid: held.accountID }, held.bridgeSessionID)
      : null;
    return own && own.holdsObject === true
      ? await boundCall(held, webSessionID, fleetBindSpec(), "LeaveFleet", args, kwargs)
      : await heldTopLevelCall(held, webSessionID, "fleetMgr", "ForceLeaveFleet", [], null);
  } finally {
    invalidateFleetBoundHandles(held);
  }
}

/**
 * A fleet formed, as the client's fleet service forms one (fleetSvc.CreateFleet, 331 to 342): the handler's
 * CreateFleet, with nothing, which answers the fleet's own object; and Init on that object. The mint is the bind,
 * and its key is its own each time, so that a second forming is of a second fleet and never Init on what the first
 * was bound to. Init goes with nothing said: the game port says the ship's type as the client does (retailCalls.js,
 * fleetInit), and through the gateway the server takes the session's. Whatever comes of it, none of the BFF's
 * handles for a fleet is kept: the pilot's fleet is another one now, or may be.
 */
async function createFleetCall(held, webSessionID) {
  const bindSpec = {
    key: `fleet-create:${Date.now()}:${Math.random().toString(36).slice(2)}`,
    service: "fleetObjectHandler",
    method: "CreateFleet",
    args: [],
    kwargs: null,
  };
  try {
    return await boundCall(held, webSessionID, bindSpec, "Init", [null, null], null);
  } finally {
    invalidateFleetBoundHandles(held);
  }
}

/**
 * A fleet's invitation accepted, as the client accepts one (fleetSvc.OnFleetInvite, 1168 to 1195): AcceptInvite on
 * a Moniker for the fleet the invitation names. The invitation, not the bind, is the authority: the server
 * accepts only where a real invitation for this character names that fleet. The ship's type is never the
 * browser's to say, so none is said here: the game port says the ship's as the client does (retailCalls.js), and
 * through the gateway the server takes the session's. Whatever comes of it, none of the BFF's handles for a fleet
 * is kept: the pilot's fleet is another one now, or may be.
 */
async function acceptFleetInviteCall(held, webSessionID, fleetID) {
  try {
    return await boundCall(held, webSessionID, fleetIDBindSpec(fleetID), "AcceptInvite", [null], null);
  } finally {
    invalidateFleetBoundHandles(held);
  }
}

/**
 * What a call of the page's that turns an invitation down says with it, as the arguments to ask with: nothing
 * (no arguments at all, or none in the list), or the one word, true or false. Null where it is none of those.
 */
function decliningWordOf(args) {
  if (args === undefined || args === null) return [];
  if (!Array.isArray(args) || args.length > 1) return null;
  return args.length === 0 ? [] : typeof args[0] === "boolean" ? [args[0]] : null;
}

/**
 * A fleet's invitation turned down, as the client turns one down (fleetSvc.OnFleetInvite, 1168 to 1199):
 * RejectInvite(True), RejectInvite(False) or RejectInvite(), on a Moniker for the fleet the invitation names.
 * The invitation, not the bind, is the authority: the server forgets only an invitation of the session's own
 * character that names that fleet. `said` is the word as the arguments to ask with (decliningWordOf). Whatever
 * comes of it, none of the BFF's handles for a fleet is kept, as after its route.
 */
async function rejectFleetInviteCall(held, webSessionID, fleetID, said) {
  try {
    return await boundCall(held, webSessionID, fleetIDBindSpec(fleetID), "RejectInvite", said, null);
  } finally {
    invalidateFleetBoundHandles(held);
  }
}

/** The pilot a call of the page's invites: its first argument, a pilot's number or the text of one. Null otherwise. */
function inviteeOf(args) {
  return Array.isArray(args) ? strictPositiveID(args[0]) : null;
}

/**
 * The place a call of the page's invites a pilot to: its second, third and fourth arguments, a wing's, a squad's and
 * a role's number, each nothing where the call says none (the invite menu's first entry says none of them). Null
 * where one is neither.
 */
function invitedPlaceOf(args) {
  if (!Array.isArray(args)) {
    return null;
  }
  const place = [];
  for (const value of [args[1], args[2], args[3]]) {
    if (value === undefined || value === null) {
      place.push(null);
      continue;
    }
    const id = strictPositiveID(value);
    if (id === null) {
      return null;
    }
    place.push(id);
  }
  return { wingID: place[0], squadID: place[1], role: place[2] };
}

/**
 * A pilot invited to the pilot's own fleet, as the client invites one from its menus (fleetSvc.Invite, 351 to
 * 363): self.fleet.Invite(charID, wingID, squadID, role), on the fleet's own object. `place` is the invite menu's
 * (menusvc.FleetInviteMenu, MemberMenu's places), None for each it does not say; the server holds a placed
 * invitation to the inviter's command, as it holds a member's move. `expectedFleetID` is the fleet the caller
 * expects its pilot to be in, where it says one: the call is then made on the object bound by that number, so that
 * the server's check of the inviter runs against that fleet and a held-back invitation cannot follow its pilot into
 * another. Whatever comes of it, none of the BFF's handles for a fleet is kept, as after its route.
 */
async function inviteToFleetCall(held, webSessionID, inviteeCharID, expectedFleetID, place = null) {
  try {
    return await boundCall(held, webSessionID, expectedFleetID === null ? fleetBindSpec() : fleetIDBindSpec(expectedFleetID), "Invite", [inviteeCharID, place?.wingID ?? null, place?.squadID ?? null, place?.role ?? null], null);
  } finally {
    invalidateFleetBoundHandles(held);
  }
}

// --- R95 Phase-4 top-level WRITES — skills + clones + safety
// Its 17 write routes, made for no screen of the page's, went on 2026-10-14 (the loop's item 62): nothing
// asked them. The pairs stay writes (bridgeCallPolicy.js), so the generic call refuses them.

// --- R96 Phase-4 top-level WRITES — corpRegistry batch A
// Its 15 write routes, made for no screen of the page's, went on 2026-10-14 (the loop's item 62): nothing
// asked them. The pairs stay writes (bridgeCallPolicy.js), so the generic call refuses them.

// --- R97 Phase-4 top-level WRITES — corpRegistry batch B
// Its 14 write routes, made for no screen of the page's, went on 2026-10-14 (the loop's item 62): nothing
// asked them. The pairs stay writes (bridgeCallPolicy.js), so the generic call refuses them.

// --- R98 Phase-4 top-level WRITES — corpRegistry batch C
// Its 14 write routes, made for no screen of the page's, went on 2026-10-14 (the loop's item 62): nothing
// asked them. The pairs stay writes (bridgeCallPolicy.js), so the generic call refuses them.

// --- The alliance registry's, the war registry's and the corporation station manager's write routes ------------
//
// Twenty routes of the plumbing's R99 were here (allianceRegistry's ten, warRegistry's nine, and
// corpStationMgr.MoveCorpHQHere), each a confirm-gated dispatchBridgeWrite of its pair, made for no screen of the
// page's ("PLUMBING ONLY — no UI"). Nothing asked them: not the page, not the hosted bots (the page's own flows), not
// eve.js, not the market server. They went on 2026-10-14 (the loop's item 62). The pairs are writes still
// (bridgeCallPolicy.js), so the generic call refuses them; a screen that makes one makes it as the client's own
// call, added to the page's writes.

// --- R100 WB-DOGMA batch A: the 11 Phase-4 BOUND dogma module-op WRITES -------
//
// These ride the SAME dogmaIM.MachoBindObject bind the R74 reads use (dogmaBindSpec
// / boundCall — the real bound two-step; the BFF holds the OID handle, the browser
// never sees it). Unlike the R99 top-level writes above (dispatchBridgeWrite over
// heldTopLevelCall), each of these dispatches as a BOUND method off the dogma bind.
// Ship-module ops — target-drop, module overload / stop-overload, nanite module-
// repair, weapon-bank link/merge — all reversible-ish in-space actions, no ISK, no
// permanent asset destruction. Every route is confirm-gated: without `confirm:true`
// it answers 400 CONFIRMATION_REQUIRED and NOTHING dispatches.
//
// FAST-MODE (R86–R99 pattern): none fired live this batch (operator owns EveJS; no
// server restart). The handlers' returns vary (null / itemID / bool / moduleID list
// / a [success, missingCharges, failed] triple / a weapon-bank state dict); the ack
// carries `result` through untouched for a future ship/fitting UI to decode.
//
// ⚠ ARG-INJECTION: RemoveTargets/ClearTargets and the overload/module-repair ops
// resolve their scene/ship from the SESSION (spaceRuntime.<op>(session, …) /
// _startModuleRepair(session, itemID)). LinkWeapons/MergeModuleGroups accept a
// caller-supplied shipID as args[0] (falling back to _getShipID(session)) — flagged
// in docs/arg-injection-leak-handoff.md for a server-side session-scoping fix + QA;
// kept plumbed + confirm-gated. This BFF passes only the session ship's own module
// ids from a future UI, but the handler does not enforce that.

/** Dispatch one confirm-gated BOUND dogma write off the dogma bind; uniform ack. */
async function dispatchBoundDogmaWrite(req, res, next, method, args) {
  const held = requireHeldBridgeSession(req, res);
  if (!held) {
    return;
  }
  try {
    const outcome = await boundCall(held, req.webSessionID, dogmaBindSpec(), method, args, null);
    res.json({ ok: true, applied: true, result: outcome.result ?? null, notifications: outcome.notifications });
  } catch (error) {
    if (error && error.code === "SESSION_NOT_FOUND") {
      forgetBridgeSession(req.webSessionID, held);
    }
    next(error);
  }
}

// --- Dedicated ammo writes -------------------------------------------------
//
// The raw dogma calls accept a ship id and arbitrary inventory location ids:
//   LoadAmmo(shipID, moduleIDs, chargeItemIDs, ammoLocationID)
//   UnloadAmmo(shipID, moduleIDs, destination, quantity?)
// Those arguments are too broad for a browser route. These dedicated routes
// therefore accept only the semantic places the current client can actually
// operate on: this session's ACTIVE ship cargo or its CURRENT docked station /
// structure hangar. The concrete ids and inventory flags are pinned here after
// a live flight read; caller-supplied ship/location ids are never forwarded.

function strictPositiveID(value) {
  if (
    (typeof value !== "number" && typeof value !== "string")
    || (typeof value === "string" && value.trim() === "")
  ) {
    return null;
  }
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : null;
}

/** A non-empty id list where every member is a positive safe integer. */

/**
 * Read and pin the active ship before an argument-injectable write.
 *
 * held.activeShipID is updated only by the authoritative board/leave flow. The
 * live flight read must agree with it; a mismatch is a transition/stale-tab
 * condition, not permission to silently switch the route to another hull.
 */

/** Resolve cargo or the current dock/structure hangar without accepting an id. */

/**
 * The session's OWN active ship — what every weapon-bank write is pinned to.
 *
 * ⚠ THIS CLOSES A FLAGGED ARG-INJECTION. All seven bank writes take a shipID,
 * and the BFF used to forward whatever the browser sent (see
 * docs/arg-injection-leak-handoff.md). There is no legitimate reason for a
 * browser to name a hull here: banking only ever applies to the ship you are
 * flying, and the server resolves the modules against it. 0 when there is no
 * held session, which the handler refuses on its own.
 */

// --- R101 WB-DOGMA batch B: the 11 remaining Phase-4 BOUND dogma WRITES
// Its 11 write routes, made for no screen of the page's, went on 2026-10-14 (the loop's item 62): nothing
// asked them. The pairs stay writes (bridgeCallPolicy.js), so the generic call refuses them.

// --- R102 WB-ENTITY: the 4 Phase-4 BOUND drone-command WRITES
// Its 3 write routes, made for no screen of the page's, went on 2026-10-14 (the loop's item 62): nothing
// asked them. The pairs stay writes (bridgeCallPolicy.js), so the generic call refuses them.

// --- R102 WB-INV: the 7 Phase-4 BOUND inventory WRITES -----------------------
//
// These ride the invbroker inventory-MANAGER moniker (inventoryManagerBindSpec —
// Moniker("invbroker", (stationID, groupStation)), the TrashItems handle) the R75
// reads use. Label / fit / unfit / container / corp-delivery ops. Each dispatches
// as a BOUND method off that manager bind (the BFF holds the handle). Every route
// is confirm-gated; StripFitting (unfits a whole ship) carries an extra-explicit
// message. FAST-MODE: none fired live (operator owns EveJS). Most handlers return
// null / true / a change list; the ack carries `result` through for a future
// fitting/inventory UI to decode. Args are EDUCATED-GUESS from the handler shapes.
//
// ⚠ ARG-INJECTION: SetLabel has an explicit ItemNotYours owner guard, StripFitting
// is session/bound-scoped, AssembleCargoContainer/BreakPlasticWrap/DeliverToCorp
// Member are server-side no-ops. FitFitting (caller shipID falls back past the
// session-char scope) and DeliverToCorpHangar (caller itemIDs looked up with no
// owner check) mutate caller-supplied item/ship ids with no session-ownership gate
// — flagged in docs/arg-injection-leak-handoff.md (server-side fix + QA later; kept
// plumbed + confirm-gated).

/** Dispatch one confirm-gated BOUND inventory write off the manager bind. */
async function dispatchBoundInventoryWrite(req, res, next, method, args, kwargs = null) {
  const held = requireHeldBridgeSession(req, res);
  if (!held) {
    return;
  }
  try {
    // Sync held station/ship to the live position first so the manager bind
    // targets the CURRENT station (matching /api/bridge/bound-inventory).
    await readHeldFlight(held, req.webSessionID);
    const outcome = await boundCall(held, req.webSessionID, inventoryManagerBindSpec(held), method, args, kwargs);
    res.json({ ok: true, applied: true, result: outcome.result ?? null, notifications: outcome.notifications });
  } catch (error) {
    if (error && error.code === "SESSION_NOT_FOUND") {
      forgetBridgeSession(req.webSessionID, held);
    }
    next(error);
  }
}

// (A saved fitting is applied by the page's own call since 2026-10-14, as the client applies one: FitFitting on
// the ship's own inventory (fittingSvc.LoadFitting, 554 to 618), through the generic call (bridgeCallPolicy.js,
// PAGE_OBJECT_CALLS: "inventory"; web/src/bridge/fitModule.ts, applyFitting). The route that sent it on the
// inventory manager's handle, POST /api/bridge/inventory/fit-fitting, is gone.)

// --- R103 WB-PI: the 4 Phase-4 BOUND planet colony-op WRITES ------------------
//
// These ride the SAME planetMgr.MachoBindObject(planetID) bind (planetBindSpec —
// keyed per planetID) the R77 RB-PI reads use. The browser sends the target
// planetID; the BFF binds it (holding the OID handle server-side, the browser
// never sees it) and dispatches each write as a BOUND method off that handle —
// mirroring dispatchBoundInventoryWrite / dispatchBoundDogmaWrite. Every route is
// confirm-gated; UserAbandonPlanet — which DESTROYS the colony — carries an
// extra-explicit message. FAST-MODE: none fired live (operator owns EveJS). The
// handlers return a serialized colony / a [simTime,runTime] pair / null; the ack
// carries `result` through for a future PI UI to decode. Args are EDUCATED-GUESS
// from the handler shapes (planetID comes from the bind, allowArgs:false).
//
// ⚠ ARG-INJECTION: the planetID is caller-supplied via the bind, BUT every handler
// forces ownerID = getSessionCharacterID(session) (UserAbandonPlanet →
// abandonColony(planetID, session.characterID)). The colony operated on is always
// (planetID, SESSION-char), so — UNLIKE the R77 READ leak #18-#20 where
// GetFullNetworkForOwner took a caller-supplied ownerID and returned a FOREIGN
// owner's colony — these writes cannot reconfigure or abandon another player's
// colony; a caller can only touch its OWN colony on the chosen planet. Owner-gated,
// so NOT the write realization of #18-#20; no handoff-doc flag added.

/** Dispatch one confirm-gated BOUND planet write off the planetMgr planetID bind. */
async function dispatchBoundPlanetWrite(req, res, next, planetID, method, args, kwargs = null) {
  const held = requireHeldBridgeSession(req, res);
  if (!held) {
    return;
  }
  const pid = Number(planetID) || 0;
  if (pid <= 0) {
    res.status(400).json({
      ok: false,
      error: "INVALID_PLANET",
      message: "A positive planetID is required.",
    });
    return;
  }
  try {
    const outcome = await boundCall(held, req.webSessionID, planetBindSpec(pid), method, args, kwargs);
    res.json({ ok: true, applied: true, result: outcome.result ?? null, notifications: outcome.notifications });
  } catch (error) {
    if (error && error.code === "SESSION_NOT_FOUND") {
      forgetBridgeSession(req.webSessionID, held);
    }
    next(error);
  }
}

// (A launchpad's goods are sent up into its planet's customs office by the page's own calls since 2026-10-13,
// as the client's customs window makes them: the office's tax rate asked of the system's orbital registry, and
// invbroker.ImportExportWithPlanet on the office's own inventory naming it, through the generic call
// (bridgeCallPolicy.js, PAGE_OBJECT_CALLS: "inventory"; web/src/bridge/customsWrites.ts). The route that read
// the pilot's flight, asked the rate and made the transfer, POST /api/bridge/planet/customs/export, is gone.)

// --- R104 WB-SCAN: the 9 Phase-4 BOUND probe / scan-control WRITES ------------
//
// These ride the SAME scanMgr.GetSystemScanMgr bind (systemScanBindSpec — the R72
// RB-SCAN gateway) the scan reads use. Unlike planetMgr.MachoBindObject(planetID),
// GetSystemScanMgr takes NO caller args: it always binds the SESSION's OWN current-
// system scan manager (server-derived), so the bind CANNOT be pointed at a foreign
// system — the good security property. The BFF holds the OID handle server-side; the
// browser never sees it. Each write dispatches as a BOUND method off that handle,
// mirroring dispatchBoundInventoryWrite / dispatchBoundPlanetWrite. Every route is
// confirm-gated; DestroyProbe — which destroys a launched probe — carries an extra-
// explicit message. FAST-MODE: none fired live (operator owns EveJS). The handlers
// return null / a directional-scan list (ConeScan) / a recovered-probeID list
// (RecoverProbes); the ack carries `result` through for a future scan UI to decode.
// Args are EDUCATED-GUESS from the handler shapes.
//
// ⚠ ARG-INJECTION: the bind is session-scoped (no caller args), AND every handler
// resolves characterID = this._getCharacterID(session) and operates on
// probeRuntimeState keyed on THAT characterID. The caller-supplied probeIDs
// (SetProbeDestination / SetProbeRangeStep / DestroyProbe / RecoverProbes /
// SetActivityState) only ever SELECT among the session char's OWN probes
// (getCharacterSystemProbes / removeCharacterProbes / synchronizeCharacterProbeGeometry
// are all characterID-scoped), so a foreign probeID launched by another char simply
// MISSES — it cannot mutate or destroy another player's probes. Probes are inherently
// session-scoped; no handoff-doc flag added.

/** Dispatch one confirm-gated BOUND scan write off the session-scoped scanMgr bind. */
async function dispatchBoundScanWrite(req, res, next, method, args, kwargs = null) {
  const held = requireHeldBridgeSession(req, res);
  if (!held) {
    return;
  }
  try {
    const outcome = await boundCall(held, req.webSessionID, systemScanBindSpec(), method, args, kwargs);
    res.json({ ok: true, applied: true, result: outcome.result ?? null, notifications: outcome.notifications });
  } catch (error) {
    if (error && error.code === "SESSION_NOT_FOUND") {
      forgetBridgeSession(req.webSessionID, held);
    }
    next(error);
  }
}

// --- Product scanner state --------------------------------------------------
//
// The routes above deliberately preserve the complete retail call plumbing.
// The Scanner window and the Bot Builder go by this one read: the launcher,
// the probes and whether a scan is under way, as the transport keeps them
// (on the game port, as the client's scan service keeps them, from what the
// server tells: gamePort/pilotScanner.js). No call is behind it.
//
// Until 2026-10-13 four routes beside it (POST /api/bridge/scanner/launch,
// analyze, recover and reconnect) read this, made the client's call with what
// it said and read it again. The page makes those calls itself now, by the
// generic call (bridgeCallPolicy.js, PAGE_WRITE_PAIR_KEYS;
// web/src/bridge/scannerWrites.ts).

app.get("/api/bridge/scanner/state", requireAuth, async (req, res, next) => {
  const held = requireHeldBridgeSession(req, res);
  if (!held) {
    return;
  }
  try {
    const outcome = await readHeldScanner(held, req.webSessionID);
    res.json({ ok: true, scanner: outcome.scanner, notifications: outcome.notifications });
  } catch (error) {
    next(error);
  }
});

// --- R105 Phase-4 BOUND fleet WRITES — WB-FLEET (16) ------------------------
//
// The 16 fleet composition / membership / broadcast writes off the R72
// fleetObjectHandler.MachoBindObject bind (the same bind the R85 bound reads on
// /api/bridge/bound-fleet ride). They back the Fleet Center and bot fleet blocks.
// The separate Latest parity review records the intentionally deferred fleet methods.
//
// Each write dispatches as a BOUND method off fleetBindSpec() (dispatchBoundFleetWrite
// below), mirroring dispatchBoundScanWrite / dispatchBoundInventoryWrite. The BFF holds
// the OID handle; the browser never sees it.
//
// ⚠ OWNERSHIP: most routes bind the SESSION's OWN fleet through fleetBindSpec().
// AcceptInvite / RejectInvite instead bind the fleetID carried by OnFleetInvite, and
// Reconnect binds the saved pre-disconnect fleetID, because the current session has no
// fleetID yet. Those targeted binds are not authority: the runtime requires a matching
// pending invite or an existing member row before changing session state. Every other
// roster mutator is role-gated server-side by the session char's fleet job/role before it
// touches the roster (KickMember/MoveMember/CreateSquad → ensureCommanderOrBoss;
// DisbandFleet/MakeLeader/CreateWing/SetOptions → ensureFleetBoss; the rest →
// ensureFleetMembership); UpdateMemberInfo acts on the SESSION char only (args[0] is a
// shipTypeID, not a memberID). A non-boss cannot kick/disband/promote — no privilege-
// escalation-within-fleet path, so no handoff-doc flag.
//
// Every route is confirm-gated (refuses without `confirm:true`). ⚠ DisbandFleet (destroys
// the whole fleet) and KickMember (removes another char) carry EXTRA-EXPLICIT confirm
// messages. FAST-MODE: none fired live (operator owns EveJS; no server restart) — the
// handlers return true / null / an ack, carried through `result`. Args are EDUCATED-GUESS
// from the fleetObjectHandlerService handler shapes.

/** Dispatch one confirm-gated BOUND fleet write off the session-scoped fleet bind. */
async function dispatchBoundFleetWrite(req, res, next, method, args, kwargs = null) {
  const held = requireHeldBridgeSession(req, res);
  if (!held) {
    return;
  }
  try {
    const outcome = await boundCall(held, req.webSessionID, fleetBindSpec(), method, args, kwargs);
    invalidateFleetBoundHandles(held);
    res.json({ ok: true, applied: true, result: outcome.result ?? null, notifications: outcome.notifications });
  } catch (error) {
    // A rejected response is not proof that the server made no state change.
    invalidateFleetBoundHandles(held);
    if (error && error.code === "SESSION_NOT_FOUND") {
      forgetBridgeSession(req.webSessionID, held);
    }
    next(error);
  }
}

/**
 * Dispatch an invite/reconnect write against an explicitly named fleet. The
 * pending-invite/member check in the runtime is the authority; the bind only
 * selects the record on which that check runs. Never retain this handle across
 * a membership boundary, including an uncertain failed response.
 */

// --- R17 Contracts (contractProxy bridge) -----------------------------------
//
// Like mail and market, the whole contract surface is TOP-LEVEL
// (sm.ProxySvc('contractProxy')) — no bound-object step — so heldTopLevelCall
// carries all of it.
//
// ⚠ THE SERVICE IS "contractProxy". EveJS registers TWO contract services and
// the obvious name is the wrong one: `contractMgr` (contractMgrService.js) is
// 86 lines of DEAD STUBS — GetLoginInfo answers three empty rowsets,
// SearchContracts an empty list, NumOutstandingContracts 0 — every method
// hardcoded empty, never called by the retail client. Naming it would give a
// contracts page that renders perfectly and is permanently empty, which is
// INDISTINGUISHABLE from the genuinely empty world below. Every call here names
// contractProxy; the gateway allowlist refuses `contractMgr` by name.
//
// ⚠ A PUBLIC BROWSE IS LEGITIMATELY EMPTY, AND THAT IS NOT A BUG. There is no
// NPC/seed contract generator anywhere in EveJS — `createContract` exists only
// in contractRuntimeState.js and its own handler, and nothing calls it at
// startup. So SearchContracts answers nothing until a player creates a
// contract. The route reports that as a FACT (`worldHasNoContracts`) so the
// panel can say "no public contracts exist in this world yet" rather than
// looking broken. Do not go hunting for a bug here.
//
// ⚠ SearchContracts IS KWARGS-ONLY. Handle_SearchContracts ignores `args`
// entirely and reads every filter off kwargs. Filters sent positionally are
// silently DROPPED — a browse meant to show couriers would quietly answer
// every contract type instead, with no error.
//
// ⚠ THE COUNT AND THE LIST MUST AGREE. GetLoginInfo reports how many
// contracts are ASSIGNED TO YOU, but NONE of the three "yours" lists contains
// them: GetMyCurrentContractList keys off issuerID (what you issued) and
// acceptorID (what you took on), and GetMyExpiredContractList off
// contractNeedsAttention — an assignee is none of those. The public browse
// cannot show them either, because a contract reserved for you is by definition
// not `availability: PUBLIC`. So a contract handed to you personally was
// COUNTED and then displayed NOWHERE, which reads as a broken panel.
//
// The count's own source is the fix: `assignedToMe` carries the contractIDs it
// counted (buildLoginInfoRows keys off assigneeID against your character, your
// corp AND your alliance), so the route fetches exactly those in full. Deriving
// the list any other way re-derives the predicate and drifts from the number on
// screen — a second unfiltered SearchContracts pages at 100 and drops
// assignments past it, and GetContractListForOwner against your characterID
// misses every corp- and alliance-assigned one.
//
// ⚠ THE WRITES LIVE ELSEWHERE (R91, POST /api/bridge/contracts/*), each
// confirm-gated. This route stays a pure READ. Accepting moves ISK and items,
// and contractRuntimeState guards it server-side (canAcceptContract, plus an
// outright refusal of your own unassigned contract), so the browser cannot talk
// its way into someone else's contract.

/** contractType 3 = courier. availability 0 = public. */
const CONTRACT_TYPE_COURIER = 3;
const CONTRACT_AVAILABILITY_PUBLIC = 0;
/**
 * ⚠ THE REAL PAGE STRIDE, and it is NOT the `maxResults` the envelope reports.
 * searchContracts slices by CONTRACTS_PER_PAGE (100,
 * contractRuntimeState.js:48) while the envelope's `maxResults` carries
 * MAX_CONTRACTS_PER_SEARCH (1000, contractProxyService.js:29). The two
 * constants disagree, so paging by `maxResults` — the obvious reading — would
 * advance startNum by 1000 and SKIP 900 CONTRACTS PER PAGE, silently. Page by
 * this, never by that field.
 */
const CONTRACTS_PAGE_SIZE = 100;

/**
 * How many contracts assigned to you one panel load will fetch in full.
 *
 * Each one is its own GetContract, so the fan-out is BOUNDED rather than
 * trusted to stay small. The route reports when it has been cut short, so the
 * panel can say so rather than quietly showing fewer than the count promised.
 */
const ASSIGNED_CONTRACT_LIMIT = 50;

/** appConst.py conStatusOutstanding and conStatusInProgress; contractPanels.py RESULTS_PER_PAGE. */
const CONTRACT_STATUS_OUTSTANDING = 0;
const CONTRACT_STATUS_IN_PROGRESS = 1;
const OWN_CONTRACTS_PER_PAGE = 100;

/** One field of a contract's row, in either of the forms a row comes in; undefined for what is not a row. */
function contractRowField(row, name) {
  return row && row.type === "packedrow" && row.fields ? row.fields[name] : readMailKeyVal(row, name);
}

/**
 * The page's two lists of the pilot's own contracts, drawn from the two the client's My Contracts panel asks
 * for: the owner's outstanding and the owner's in progress, each of which lists every contract the owner is a
 * party to. What the pilot issued is the first and what the pilot took on the second, each newest first and
 * with the items of its own contracts, in the form the server answers a list in. Null when either answer
 * cannot be read: an empty list would say the pilot has none.
 */
function ownContractLists(characterID, answers) {
  const rows = [];
  const itemsOf = new Map();
  for (const answer of answers) {
    const contracts = readMailKeyVal(answer, "contracts");
    if (!contracts || !Array.isArray(contracts.items)) {
      return null;
    }
    for (const row of contracts.items) {
      const contractID = mailNumber(contractRowField(row, "contractID"));
      if (!(contractID > 0)) {
        return null;
      }
      rows.push({ contractID, row });
    }
    const listed = readMailKeyVal(answer, "items");
    for (const entry of (listed && listed.entries) || []) {
      itemsOf.set(mailNumber(entry[0]), entry);
    }
  }
  rows.sort((left, right) => right.contractID - left.contractID);
  const listOf = (party) => {
    const kept = rows.filter(({ row }) => mailNumber(contractRowField(row, party)) === characterID);
    return {
      ...answers[0],
      args: {
        type: "dict",
        entries: [
          ["contracts", { type: "list", items: kept.map(({ row }) => row) }],
          ["items", { type: "dict", entries: kept.map(({ contractID }) => itemsOf.get(contractID)).filter(Boolean) }],
        ],
      },
    };
  };
  return [listOf("issuerID"), listOf("acceptorID")];
}

/** Those two lists as settled reads, like the two they stand in for: each failed with what failed either of the owner's. */
function ownContractsSettled(characterID, first, second) {
  const failed = [first, second].find((entry) => entry.status === "rejected");
  if (failed) {
    return [failed, failed];
  }
  const lists = ownContractLists(characterID, [first.value.result, second.value.result]);
  if (!lists) {
    const unread = { status: "rejected", reason: { code: "READ_FAILED" } };
    return [unread, unread];
  }
  return lists.map((result) => ({ status: "fulfilled", value: { result } }));
}

function contractsListEmpty(result) {
  const contracts = readMailKeyVal(result, "contracts");
  return !contracts || !Array.isArray(contracts.items) || contracts.items.length === 0;
}

/**
 * The contractIDs carried by one of GetLoginInfo's rowsets.
 *
 * ⚠ A ROWSET LINE IS A BARE ARRAY, not a marshalled row. buildRowset wraps
 * the lines in a `list`, but each line is the plain positional array the
 * handler pushed (`[contractID, issuerID]`) and JSON carries it through as an
 * array. The `list`-wrapped form is accepted too, so a later marshalling change
 * cannot silently empty this: an empty answer here is indistinguishable from
 * "nothing is assigned to you", which is the one thing it must never fake.
 */
function readContractRowsetIDs(result, key) {
  const lines = readMailKeyVal(readMailKeyVal(result, key), "lines");
  const ids = [];
  for (const line of mailListItems(lines)) {
    const cells = Array.isArray(line) ? line : mailListItems(line);
    const contractID = mailNumber(cells[0]);
    if (contractID > 0 && !ids.includes(contractID)) {
      ids.push(contractID);
    }
  }
  return ids;
}

/**
 * GET /api/bridge/contracts?page= — the browse, the player's own, the ones
 * assigned to them, and the summary, in one panel load.
 *
 * Five INDEPENDENT reads (R2's rule): one failure never blanks the rest. A
 * player whose public browse fails still sees their own contracts.
 *
 * Then a SECOND phase, because it cannot start until the first has answered:
 * the summary read is what NAMES the contracts assigned to this character, so
 * the GetContract calls that fetch them can only be issued once it has landed.
 * They then go out together — one extra round trip, not one per contract.
 */
app.get("/api/bridge/contracts", requireAuth, async (req, res, next) => {
  const held = requireHeldBridgeSession(req, res);
  if (!held) {
    return;
  }
  const page = Math.max(0, Number(req.query.page) || 0);
  // contractPanels.py 419: the client lists an owner's contracts by status and never asks GetMyCurrentContractList.
  // On the game port the pilot's own are asked for its way, the outstanding and the ones in progress.
  const asTheClient = Boolean(gamePortPilots && isGamePortHandle(held.bridgeSessionID));
  const ownersWith = (status) => heldTopLevelCall(
    held, req.webSessionID, "contractProxy", "GetContractListForOwner",
    [held.characterID, status, null, null], { num: OWN_CONTRACTS_PER_PAGE, startContractID: null },
  );
  try {
    const [browse, first, second, expired, summary] = await Promise.allSettled([
      // ⚠ KWARGS-ONLY: no positional args at all, or the filters are dropped.
      heldTopLevelCall(held, req.webSessionID, "contractProxy", "SearchContracts", [], {
        contractType: CONTRACT_TYPE_COURIER,
        availability: CONTRACT_AVAILABILITY_PUBLIC,
        startNum: page * CONTRACTS_PAGE_SIZE,
      }),
      // (isAccepted, forCorp). Neither names an owner — the character comes
      // from the session, so there is nothing here to point elsewhere.
      asTheClient ? ownersWith(CONTRACT_STATUS_OUTSTANDING) : heldTopLevelCall(
        held, req.webSessionID, "contractProxy", "GetMyCurrentContractList", [false, false], null,
      ),
      asTheClient ? ownersWith(CONTRACT_STATUS_IN_PROGRESS) : heldTopLevelCall(
        held, req.webSessionID, "contractProxy", "GetMyCurrentContractList", [true, false], null,
      ),
      heldTopLevelCall(
        held, req.webSessionID, "contractProxy", "GetMyExpiredContractList", [false], null,
      ),
      heldTopLevelCall(
        held, req.webSessionID, "contractProxy", "GetLoginInfo", [], null,
      ),
    ]);

    const [outstanding, accepted] = asTheClient ? ownContractsSettled(Number(held.characterID), first, second) : [first, second];
    const settled = [browse, outstanding, accepted, expired, summary];
    for (const entry of settled) {
      if (entry.status === "rejected" && entry.reason && entry.reason.code === "SESSION_NOT_FOUND") {
        next(entry.reason);
        return;
      }
    }

    const codeOf = (entry) =>
      entry.status === "rejected"
        ? String((entry.reason && entry.reason.code) || "READ_FAILED")
        : null;
    const valueOf = (entry) => (entry.status === "fulfilled" ? entry.value.result : null);

    // ⚠ THE FACT, NOT A GUESS. "The browse succeeded and found nothing" is a
    // different statement from "the browse failed", and only the first one
    // justifies telling the player this world has no contracts yet.
    const worldHasNoContracts =
      browse.status === "fulfilled" && contractsListEmpty(browse.value.result);

    // The contracts the summary just COUNTED as assigned to this character,
    // fetched in full so the panel can list what the number refers to. The ids
    // come from the summary read, never from the browser: nothing here can be
    // pointed at a contract the session was not already told about.
    const assignedIDs = readContractRowsetIDs(valueOf(summary), "assignedToMe");
    const fetchedIDs = assignedIDs.slice(0, ASSIGNED_CONTRACT_LIMIT);
    const assignedSettled = await Promise.allSettled(
      fetchedIDs.map((contractID) =>
        heldTopLevelCall(held, req.webSessionID, "contractProxy", "GetContract", [contractID], null),
      ),
    );
    for (const entry of assignedSettled) {
      if (entry.status === "rejected" && entry.reason && entry.reason.code === "SESSION_NOT_FOUND") {
        next(entry.reason);
        return;
      }
    }
    // One contract that could not be fetched must not hide the others, so the
    // successes are kept and the shortfall is reported as its own fact — the
    // same rule the five reads above follow.
    const assignedDetails = assignedSettled
      .filter((entry) => entry.status === "fulfilled")
      .map((entry) => entry.value.result)
      .filter((result) => result !== null && result !== undefined);
    const assignedError =
      codeOf(summary) ||
      (assignedDetails.length < fetchedIDs.length ? "READ_FAILED" : null);

    res.json({
      ok: true,
      characterID: held.characterID,
      page,
      pageSize: CONTRACTS_PAGE_SIZE,
      browse: { result: valueOf(browse), error: codeOf(browse) },
      outstanding: { result: valueOf(outstanding), error: codeOf(outstanding) },
      accepted: { result: valueOf(accepted), error: codeOf(accepted) },
      expired: { result: valueOf(expired), error: codeOf(expired) },
      summary: { result: valueOf(summary), error: codeOf(summary) },
      // Full GetContract bundles, one per contract assigned to this character.
      // `numAssigned` is the count BEFORE the fan-out limit, so the panel can
      // tell "that is all of them" from "that is the first 50 of them".
      assigned: {
        results: assignedDetails,
        numAssigned: assignedIDs.length,
        error: assignedError,
      },
      worldHasNoContracts,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/bridge/contracts/detail?contractID= — one contract in full.
 *
 * GetContract answers null for a contract that does not exist — a definite
 * answer the panel can act on ("that contract is gone"), reported as a 404
 * rather than an empty detail pane.
 */
app.get("/api/bridge/contracts/detail", requireAuth, async (req, res, next) => {
  const held = requireHeldBridgeSession(req, res);
  if (!held) {
    return;
  }
  const contractID = Number(req.query.contractID) || 0;
  if (contractID <= 0) {
    res.status(400).json({
      ok: false,
      error: "CONTRACT_INVALID",
      message: "No contract was named.",
    });
    return;
  }
  try {
    const detail = await heldTopLevelCall(
      held, req.webSessionID, "contractProxy", "GetContract", [contractID], null,
    );
    if (detail.result === null || detail.result === undefined) {
      res.status(404).json({
        ok: false,
        error: "CONTRACT_NOT_FOUND",
        message: "That contract is no longer available.",
      });
      return;
    }
    res.json({ ok: true, contractID, detail: detail.result });
  } catch (error) {
    next(error);
  }
});

// --- R37 Personal Assets (charMgr global-assets bridge) ---------------------
//
// "Where is my stuff, across the whole cluster." Unlike mail/market/contracts,
// this surface is NOT top-level: the retail moniker is
// Moniker('charMgr', (charID, 10002)) via MachoBindObject, and ListStations /
// ListStationItems dispatch on that bound object — so it rides boundCall, the
// same two-step invbroker and agentMgr use.
//
// ⚠ THE SERVER ALREADY ANSWERS "WHERE IS MY STUFF". charMgrGlobalAssets
// resolves every item up its container chain to a dockable ROOT location and
// groups by station (`_buildAssetSnapshot` / `_buildStationRows`). The bridge
// must not re-derive that by walking containers itself — one call is the whole
// feature, and a client-side aggregation would disagree with the server about
// asset-safety wraps, industry-installed items and hidden locations.
//
// ⚠ THE TWO READS SEND DIFFERENT ROW SHAPES, and this is the R32 trap again.
//   * ListStations is a CRowset — `{type:"objectex2", list:[packedrow …]}` —
//     whose rows are the POSITIONAL packedrow variant (`values` parallel to
//     `columns`), because buildDbRowset feeds buildPackedRowFromRowsetLine an
//     ARRAY per row.
//   * ListStationItems is a plain `{type:"list", items:[packedrow …]}` whose
//     rows are the NAME-KEYED variant (`fields`).
// A decoder that commits to either shape silently drops every field of the
// other. Both are read through `readRowField` on the browser side.
//
// ⚠ stationID / solarSystemID / itemID / locationID ARE DECLARED int64 (type
// code 0x14) in the row descriptors. They are ordinary JS numbers here because
// the handler builds them with toInteger(), but a caller must not ASSUME that —
// the gateway renders any genuine BigInt as a BARE DECIMAL STRING, not a
// {type:"long"} wrapper (encodeJsonSafeCallValue). The browser decoder accepts
// both.
//
// READS ONLY. The bound global-assets object implements no write at all.

/** Moniker('charMgr', (charID, 10002)) — the global ASSETS container. */
const CHAR_GLOBAL_ASSETS_CONTAINER_ID = 10002;

function globalAssetsBindSpec(held) {
  return {
    key: `globalAssets:${held.characterID}`,
    service: "charMgr",
    method: "MachoBindObject",
    args: [[held.characterID, CHAR_GLOBAL_ASSETS_CONTAINER_ID]],
    kwargs: null,
  };
}

/**
 * A call on the pilot's own things everywhere: invCache's global container, Moniker('charMgr', (session.charid,
 * const.containerGlobal)), bound for the pilot held. The assets' route and the page's own call both go by it.
 *
 * The held session's flight is read first, and the call made whatever came of that: the server lists the things
 * against the session that asks (the route's note, below), and the web gateway's session has the pilot's place
 * only as a flight read last left it.
 */
async function globalAssetsCall(held, webSessionID, method, args, kwargs) {
  await readHeldFlight(held, webSessionID).catch(() => null);
  return boundCall(held, webSessionID, globalAssetsBindSpec(held), method, args, kwargs);
}

/**
 * Is this ListStations result a SUCCESSFUL, EMPTY read?
 *
 * The CRowset's rows live on `list`. An absent/!array `list` is a shape we did
 * not expect and must NOT be reported as "you own nothing" — the caller only
 * treats `true` as the fact.
 */
function assetStationsEmpty(result) {
  return Boolean(result) && Array.isArray(result.list) && result.list.length === 0;
}

/**
 * GET /api/bridge/assets — every station holding this character's items.
 *
 * ONE bound read. The per-station contents are a separate route so first paint
 * does not fan out one call per station.
 */
app.get("/api/bridge/assets", requireAuth, async (req, res, next) => {
  const held = requireHeldBridgeSession(req, res);
  if (!held) {
    return;
  }
  try {
    // Sync the held session's live position first. The asset snapshot is built
    // AGAINST THE SESSION: charMgrGlobalAssets keys its cache on the session's
    // station/system/constellation/region, `isHiddenPersonalAssetLocation`
    // hides the character's own id, and an unknown location inherits the
    // session's system. This is the same class of dependency that made
    // GetAgents answer 0 for a docked station until the sync was added.
    const stations = await globalAssetsCall(held, req.webSessionID, "ListStations", [], null);
    res.json({
      ok: true,
      characterID: held.characterID,
      stations: stations.result,
      // ⚠ THE FACT, NOT A GUESS. True only when the read SUCCEEDED and the
      // rowset was empty — "you own nothing anywhere" and "the read failed"
      // must never render alike (the worldHasNoContracts precedent).
      ownsNothing: assetStationsEmpty(stations.result),
      error: null,
    });
  } catch (error) {
    if (error && error.code === "SESSION_NOT_FOUND") {
      next(error);
      return;
    }
    // A failed read is reported AS a failed read, with ownsNothing false.
    res.json({
      ok: true,
      characterID: held.characterID,
      stations: null,
      ownsNothing: false,
      error: String((error && error.code) || "READ_FAILED"),
    });
  }
});

/**
 * Per-TYPE charge fitment for every fitted module in a ListByFlags result:
 * `{typeID: {size, groups}}`.
 *
 * Mirrors readTypeVolumes below — a property of the TYPE, read from static
 * dogma, so it costs no bridge call. A module with no charge attributes is
 * simply absent from the map, which reads as "we cannot say what it takes"
 * rather than "it takes nothing".
 */
function readModuleChargeFits(result) {
  const rows = result && Array.isArray(result.items) ? result.items : [];
  const fits = {};
  for (const row of rows) {
    const fields = row && row.type === "packedrow" && row.fields ? row.fields : row;
    const typeID = Number(fields && fields.typeID) || 0;
    if (typeID <= 0 || Object.prototype.hasOwnProperty.call(fits, typeID)) {
      continue;
    }
    const fitment = staticData.getModuleChargeFitment(typeID);
    if (fitment.groups.length > 0) {
      fits[typeID] = fitment;
    }
  }
  return fits;
}

/**
 * Per-type volume (m³) for every type in a ListStationItems result.
 *
 * Reads the NAME-KEYED packedrow variant this handler builds. Types the static
 * tables do not know are simply absent from the map; a volume of nought is
 * there as nought, as the client has it (staticTypeVolume).
 */
function readTypeVolumes(result, packaged = null) {
  const volumes = {};
  for (const row of inventoryListItems(result)) {
    const fields = row && row.type === "packedrow" && row.fields ? row.fields : null;
    const typeID = Number(fields && fields.typeID) || 0;
    if (typeID <= 0) {
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(volumes, typeID)) {
      const volume = staticTypeVolume(typeID);
      if (volume !== null) {
        volumes[typeID] = volume;
      }
    }
    // A packaged stack takes the client's packaged volume, not its type's own (inventorycommon/util.py GetItemVolume,
    // GetPackagedVolume): a packaged Rifter 2,500 m³ where an assembled one is 27,289. Given as "p" and the type where
    // it is another than the type's own, from the client's tables where they could be read.
    const key = `p${typeID}`;
    if (packaged && !Number(fields.singleton) && !Object.prototype.hasOwnProperty.call(volumes, key)) {
      const packed = packagedVolume(typeID, Number(fields.groupID), staticTypeVolume, packaged);
      if (packed !== null && packed !== undefined && packed > 0 && packed !== volumes[typeID]) {
        volumes[key] = packed;
      }
    }
  }
  return volumes;
}

/** The client's packaged volumes (src/clientData/clientConstants.js), or null where they cannot be read. */
function packagedTablesOrNull() {
  return clientConstants.packagedVolumes().catch(() => null);
}

/**
 * GET /api/bridge/assets/station?stationID= — what is at ONE of those stations.
 *
 * Called when the player expands a station. `hasNoItems` is the same fact as
 * `ownsNothing` above, scoped to this station.
 */

/** Read `status` off a util.KeyVal job row (the re-read's verdict). */
function readIndustryJobStatus(row) {
  const entries =
    row && row.args && Array.isArray(row.args.entries) ? row.args.entries : [];
  const entry = entries.find((candidate) => Array.isArray(candidate) && candidate[0] === "status");
  return entry ? Number(entry[1]) || 0 : 0;
}

// R4 Agents & Missions (agentMgr bridge). Agent list is a top-level read on the
// held session (retail agentMgr.GetAgents().Clone()); conversation, briefing,
// and journal use the bound agent (Moniker('agentMgr', agentID)). The browser
// addresses agents/missions by game ID; the BFF holds the agent bound handles.

// Dispatch a top-level (non-bound) call on the held live session. A lost
// persistent session drops the whole held session (as /api/bridge/call).
async function heldTopLevelCall(held, webSessionID, service, method, args, kwargs) {
  return heldRequest(held, webSessionID, isBridgeWritePair(service, method), () => gateway.callMethod(
    service,
    method,
    args,
    kwargs,
    { userid: held.accountID },
    held.bridgeSessionID,
  ));
}

/**
 * Something asked on a held pilot's session, under the checks every held call is under: `request` makes it.
 * `isWrite` says whether it changes anything.
 */
async function heldRequest(held, webSessionID, isWrite, request) {
  try {
    // A command can have entered its readiness read before the export hold.
    // Check again at the write boundary so that command cannot dispatch late.
    if (isWrite && heldOnGamePort(webSessionID)) {
      throw Object.assign(new Error("This pilot is exporting from its colonies. Try again once the pilot is returned."),
        { code: "CHARACTER_IN_USE", statusCode: 409 });
    }
    assertCurrentHeldSession(held, webSessionID);
    return await request();
  } catch (error) {
    if (error && error.code === "SESSION_NOT_FOUND") {
      forgetBridgeSession(webSessionID, held);
    }
    throw error;
  }
}

// Decode agentMgr.GetAgents' marshaled Rowset (header + lines) into plain agent
// rows. Filtering to the docked station happens server-side: GetAgents returns
// the whole ~11k-agent roster, and the retail client itself filters by station
// client-side; the browser only ever needs the handful at Farmer's station.
function decodeStationAgents(result, stationID) {
  const dictEntries =
    result && result.args && Array.isArray(result.args.entries)
      ? result.args.entries
      : [];
  const header = (dictEntries.find(([key]) => key === "header") || [])[1];
  const lines = (dictEntries.find(([key]) => key === "lines") || [])[1];
  const fieldNames = header && Array.isArray(header.items) ? header.items : [];
  const rows = lines && Array.isArray(lines.items) ? lines.items : [];
  const indexOf = (name) => fieldNames.indexOf(name);
  const idx = {
    agentID: indexOf("agentID"),
    agentTypeID: indexOf("agentTypeID"),
    divisionID: indexOf("divisionID"),
    level: indexOf("level"),
    stationID: indexOf("stationID"),
    corporationID: indexOf("corporationID"),
    missionKind: indexOf("missionKind"),
    missionTypeLabel: indexOf("missionTypeLabel"),
  };
  const numericStationID = Number(stationID) || 0;
  const agents = [];
  for (const line of rows) {
    const values = line && Array.isArray(line.items) ? line.items : [];
    const rowStationID = Number(values[idx.stationID]) || null;
    if (numericStationID > 0 && rowStationID !== numericStationID) {
      continue;
    }
    agents.push({
      agentID: Number(values[idx.agentID]) || 0,
      agentTypeID: idx.agentTypeID >= 0 ? Number(values[idx.agentTypeID]) || null : null,
      divisionID: idx.divisionID >= 0 ? Number(values[idx.divisionID]) || null : null,
      level: idx.level >= 0 ? Number(values[idx.level]) || null : null,
      stationID: rowStationID,
      corporationID: idx.corporationID >= 0 ? Number(values[idx.corporationID]) || null : null,
      missionKind: idx.missionKind >= 0 ? String(values[idx.missionKind] || "") || null : null,
      missionTypeLabel:
        idx.missionTypeLabel >= 0 ? String(values[idx.missionTypeLabel] || "") || null : null,
    });
  }
  return agents.filter((agent) => agent.agentID > 0);
}

// List the agents at the docked station (retail agentMgr.GetAgents, filtered).
app.get("/api/bridge/agents", requireAuth, async (req, res, next) => {
  const held = requireHeldBridgeSession(req, res);
  if (!held) {
    return;
  }
  try {
    // Sync the held station to the character's live position first, so a dock
    // at a new station (autopilot arrival) lists THAT station's agents rather
    // than the select-time station's.
    await readHeldFlight(held, req.webSessionID);
    const outcome = await heldTopLevelCall(
      held,
      req.webSessionID,
      "agentMgr",
      "GetAgents",
      [],
      null,
    );
    res.json({
      ok: true,
      stationID: held.stationID,
      agents: decodeStationAgents(outcome.result, held.stationID),
    });
  } catch (error) {
    next(error);
  }
});

// What the retail client's agents service knows of one agent (agents.GetAgentByID, which the mission's
// page and the standings read from). The client reads agentMgr.GetAgents once and keeps the table; to each
// row it adds the faction of the agent's corporation, from its own data (agents.py 89 to 107). So does this:
// one read of the table for the life of this process, through whichever pilot first asks, and the faction
// from the client's own record of the corporation. The division's name is the client's too
// (npcs/divisions.py), so the number of its message goes with the row. Without a client to read, those two
// are null. An agent the server does not list is null.
let agentTableRead = null;
function agentTable(held, webSessionID) {
  if (agentTableRead === null) {
    agentTableRead = heldTopLevelCall(held, webSessionID, "agentMgr", "GetAgents", [], null).then(
      (outcome) => new Map(decodeStationAgents(outcome.result, 0).map((agent) => [agent.agentID, agent])),
      (error) => {
        // Not kept: the next ask reads again.
        agentTableRead = null;
        throw error;
      },
    );
  }
  return agentTableRead;
}

app.get("/api/bridge/agents/:agentID/record", requireAuth, async (req, res, next) => {
  const held = requireHeldBridgeSession(req, res);
  if (!held) {
    return;
  }
  const agentID = Number(req.params.agentID) || 0;
  if (!Number.isSafeInteger(agentID) || agentID <= 0) {
    res.status(400).json({ ok: false, error: "INVALID_AGENT", message: "A positive agentID is required." });
    return;
  }
  try {
    const row = (await agentTable(held, req.webSessionID)).get(agentID) || null;
    if (row === null) {
      res.json({ ok: true, agent: null });
      return;
    }
    const [corporation, division] = await Promise.all([
      row.corporationID ? clientBuiltData.lookup("npcCorporations", row.corporationID) : { row: null },
      row.divisionID ? clientBuiltData.lookup("npcCorporationDivisions", row.divisionID) : { row: null },
    ]);
    const whole = (value) => (Number.isSafeInteger(value) && value > 0 ? value : null);
    // The client's row has the solar system of the agent's station from its own station data
    // (agents.py 96 to 105: GetStationStaticInfo(stationID).solarSystemID), so does this, from the static
    // station table; none for an agent in no station.
    const station = row.stationID ? staticData.getStation(row.stationID) : null;
    res.json({
      ok: true,
      agent: {
        agentID: row.agentID,
        agentTypeID: row.agentTypeID,
        divisionID: row.divisionID,
        level: row.level,
        stationID: row.stationID,
        corporationID: row.corporationID,
        factionID: whole(corporation.row && corporation.row.factionID),
        divisionNameID: whole(division.row && division.row.nameID),
        solarSystemID: whole(station && station.solarSystemID),
      },
    });
  } catch (error) {
    next(error);
  }
});

// Which solar system an agent is in, as the client's agents service asks the server
// (agents.GetSolarSystemOfAgent: one agentMgr.GetSolarSystemOfAgent for each agent, kept from then
// on). The mission's page asks it for any agent that is not a career agent, to decide on its banner
// about reduced rewards. The answer is passed on as it came: a solar system's ID, or nothing.
app.get("/api/bridge/agents/:agentID/solar-system", requireAuth, async (req, res, next) => {
  const held = requireHeldBridgeSession(req, res);
  if (!held) {
    return;
  }
  const agentID = Number(req.params.agentID) || 0;
  if (!Number.isSafeInteger(agentID) || agentID <= 0) {
    res.status(400).json({ ok: false, error: "INVALID_AGENT", message: "A positive agentID is required." });
    return;
  }
  try {
    const outcome = await heldTopLevelCall(held, req.webSessionID, "agentMgr", "GetSolarSystemOfAgent", [agentID], null);
    res.json({ ok: true, agentID, solarSystemID: outcome.result ?? null, notifications: outcome.notifications });
  } catch (error) {
    next(error);
  }
});

// (What is said to an agent is the page's own call since 2026-10-13: agentMgr.DoAction on the agent's object,
// through the generic call, the agent said with `of` (bridgeCallPolicy.js, PAGE_OBJECT_CALLS;
// web/src/bridge/agentWrites.ts). Its route, POST /api/bridge/agents/:agentID/action, is gone. A decline's
// deferred outcome is the web gateway's own to drive, as it was; the game port's pilot is asked the server's
// question on its stream, and answers on the route below.)

// The user's answer to a question the SERVER asked. The server calls the
// client's own services and waits (agents.YesNo before a mission is quit or
// declined); on the game port the question reaches the browser on the pilot's
// event stream as a `question` event, and its answer comes back here. The
// gateway is never asked anything, so a gateway pilot has no question open.
app.post("/api/bridge/questions/:questionID/answer", requireAuth, async (req, res, next) => {
  const held = requireHeldBridgeSession(req, res);
  if (!held) {
    return;
  }
  const answer = req.body ? req.body.answer : undefined;
  if (answer === undefined) {
    res.status(400).json({ ok: false, error: "INVALID_ANSWER", message: "An answer is required." });
    return;
  }
  if (!gamePortPilots || !isGamePortHandle(held.bridgeSessionID)) {
    res.status(404).json({ ok: false, error: "QUESTION_NOT_FOUND", message: "That question is no longer open." });
    return;
  }
  try {
    const outcome = await gamePortPilots.answerClientQuestion(
      held.bridgeSessionID,
      String(req.params.questionID || ""),
      answer,
      { userid: Number(held.accountID) },
    );
    res.json({ ok: true, answered: outcome.answered });
  } catch (error) {
    next(error);
  }
});

// A mission's keywords: agentMgr.GetMissionKeywords(contentID) on the bound
// agent. The retail client asks for them once for each mission and adds them
// to the arguments of everything that agent says about it (agents.py
// PrimeMessageArguments), which is how a mission's text gets its places and
// things. Raw; the browser reads the dict.
app.get("/api/bridge/agents/:agentID/keywords", requireAuth, async (req, res, next) => {
  const held = requireHeldBridgeSession(req, res);
  if (!held) {
    return;
  }
  const agentID = Number(req.params.agentID) || 0;
  const contentID = Number(req.query.contentID);
  if (agentID <= 0) {
    res.status(400).json({ ok: false, error: "INVALID_AGENT", message: "A positive agentID is required." });
    return;
  }
  if (!Number.isSafeInteger(contentID) || contentID <= 0) {
    res.status(400).json({ ok: false, error: "INVALID_CONTENT", message: "A positive contentID is required." });
    return;
  }
  try {
    const outcome = await boundCall(held, req.webSessionID, agentBindSpec(agentID), "GetMissionKeywords", [contentID], null);
    res.json({ ok: true, keywords: outcome.result, notifications: outcome.notifications });
  } catch (error) {
    next(error);
  }
});

// The mission briefing on the bound agent: header + objectives + agent location.
// The three reads are INDEPENDENT (Promise.allSettled) so one failure never
// blanks the rest; each carries its own error code. Raw results are decoded
// browser side.
//
// They are asked in the order the retail client's window asks them as it lays
// itself out (agentDialogueWindow.ReconstructLayout): where the agent is, for
// its header; the briefing; then the objectives.
app.get("/api/bridge/agents/:agentID/briefing", requireAuth, async (req, res, next) => {
  const held = requireHeldBridgeSession(req, res);
  if (!held) {
    return;
  }
  const agentID = Number(req.params.agentID) || 0;
  if (agentID <= 0) {
    res.status(400).json({ ok: false, error: "INVALID_AGENT", message: "A positive agentID is required." });
    return;
  }
  try {
    const spec = agentBindSpec(agentID);
    const [location, briefing, objective] = await Promise.allSettled([
      boundCall(held, req.webSessionID, spec, "GetAgentLocationWrap", [], null),
      boundCall(held, req.webSessionID, spec, "GetMissionBriefingInfo", [], null),
      boundCall(held, req.webSessionID, spec, "GetMissionObjectiveInfo", [], null),
    ]);
    for (const settled of [briefing, objective, location]) {
      if (settled.status === "rejected" && settled.reason && settled.reason.code === "SESSION_NOT_FOUND") {
        next(settled.reason);
        return;
      }
    }
    const settledCode = (settled) =>
      settled.status === "rejected"
        ? String((settled.reason && settled.reason.code) || "READ_FAILED")
        : null;
    const settledValue = (settled) => (settled.status === "fulfilled" ? settled.value.result : null);
    res.json({
      ok: true,
      agentID,
      briefing: settledValue(briefing),
      objective: settledValue(objective),
      location: settledValue(location),
      errors: {
        briefing: settledCode(briefing),
        objective: settledCode(objective),
        location: settledCode(location),
      },
    });
  } catch (error) {
    next(error);
  }
});

// A mission's objectives as the retail client's job board reads them when a mission's page opens, which
// is what the journal's Read Details does (missionentry.py 70, agents.PopupMission, and
// jobboard/client/features/agent_missions/job.py 411): GetMissionObjectiveInfo on the agent's bound
// object, with ignoreLocateCheck=True and nothing else. Raw; the browser decodes it.
app.get("/api/bridge/agents/:agentID/mission-objectives", requireAuth, async (req, res, next) => {
  const held = requireHeldBridgeSession(req, res);
  if (!held) {
    return;
  }
  const agentID = Number(req.params.agentID) || 0;
  if (!Number.isSafeInteger(agentID) || agentID <= 0) {
    res.status(400).json({ ok: false, error: "INVALID_AGENT", message: "A positive agentID is required." });
    return;
  }
  try {
    const outcome = await boundCall(held, req.webSessionID, agentBindSpec(agentID), "GetMissionObjectiveInfo", [], { ignoreLocateCheck: true });
    res.json({ ok: true, agentID, objective: outcome.result, notifications: outcome.notifications });
  } catch (error) {
    next(error);
  }
});

// The mission journal (retail agentMgr.GetMyJournalDetails, top-level): active +
// offered missions for the character. Raw result decoded browser side.
app.get("/api/bridge/journal", requireAuth, async (req, res, next) => {
  const held = requireHeldBridgeSession(req, res);
  if (!held) {
    return;
  }
  try {
    // journal.py reads the journal once and keeps it, and after a mission changes asks that mission's agent for its
    // part. The game port keeps it the same way (pilots.js journalKept). With none kept it is asked for, as before.
    if (gamePortPilots && isGamePortHandle(held.bridgeSessionID)) {
      const kept = await heldRequest(held, req.webSessionID, false, () => gamePortPilots.journalKept({ userid: held.accountID }, held.bridgeSessionID));
      if (kept !== null) {
        res.json({ ok: true, result: kept });
        return;
      }
    }
    const outcome = await heldTopLevelCall(
      held,
      req.webSessionID,
      "agentMgr",
      "GetMyJournalDetails",
      [],
      null,
    );
    res.json({ ok: true, result: outcome.result });
  } catch (error) {
    next(error);
  }
});

// R6 courier-completion reward readout (inventory Step 12): the wallet / LP /
// standings pull reads a panel issues after Complete pays out. These are plain
// TOP-LEVEL server-tier reads on the held session (no bind). The mission
// journal (the fourth Step-12 read) has its own route (/api/bridge/journal) +
// slice, refreshed on the same Complete. The three reads are INDEPENDENT
// (Promise.allSettled) so one failed read never blanks the rest; each carries
// its own error code. Raw retail-shaped results decoded browser side
// (web/src/bridge/rewards.ts).
app.get("/api/bridge/rewards", requireAuth, async (req, res, next) => {
  const held = requireHeldBridgeSession(req, res);
  if (!held) {
    return;
  }
  try {
    const [cash, lp, standings] = await Promise.allSettled([
      heldTopLevelCall(held, req.webSessionID, "account", "GetCashBalance", [0], null),
      heldTopLevelCall(
        held,
        req.webSessionID,
        "LPSvc",
        "GetAllMyCharacterWalletLPBalances",
        [],
        null,
      ),
      heldTopLevelCall(held, req.webSessionID, "standingMgr", "GetCharStandings", [], null),
    ]);
    // A lost live session can't be recovered by any read; surface it so the page
    // returns to character select (as every held call does).
    for (const settled of [cash, lp, standings]) {
      if (settled.status === "rejected" && settled.reason && settled.reason.code === "SESSION_NOT_FOUND") {
        next(settled.reason);
        return;
      }
    }
    const settledCode = (settled) =>
      settled.status === "rejected"
        ? String((settled.reason && settled.reason.code) || "READ_FAILED")
        : null;
    const settledValue = (settled) =>
      settled.status === "fulfilled" ? settled.value.result : null;
    res.json({
      ok: true,
      cash: settledValue(cash),
      lp: settledValue(lp),
      standings: settledValue(standings),
      errors: {
        cash: settledCode(cash),
        lp: settledCode(lp),
        standings: settledCode(standings),
      },
    });
  } catch (error) {
    next(error);
  }
});

// --- R50 Wallet + Corp Wallet -----------------------------------------------
// Two nav tabs, one read. The PERSONAL balance is account.GetCashBalance(0) —
// the SAME allowlisted read the market panel and the R6 reward readout already
// issue (no accountKey/corp args; the corp variant is never passed here). The
// CORP division balances are account.GetWalletDivisionsInfo — R50's single new
// allowlist pair, the read the retail corp-wallet window itself issues
// (corpDivisionsPanel.py), scoped server-side to the session's corporation.
// Division NAMES come from corpRegistry.GetCorporation (already allowlisted,
// decoded here exactly as the corp hangar route does) so the browser never
// renders a bare division flag. Three INDEPENDENT reads (Promise.allSettled): a
// failed corp read never blanks the personal balance and vice versa; each read
// carries its own error code. Amounts ship raw (decoded browser-side in
// web/src/bridge/wallet.ts). ⚠ An empty divisions list is a REAL "no corp
// wallet" answer and is distinct from a read that FAILED (which sets errors.divisions).
app.get("/api/bridge/wallet", requireAuth, async (req, res, next) => {
  const held = requireHeldBridgeSession(req, res);
  if (!held) {
    return;
  }
  try {
    // The PERSONAL ledger, as the retail client reads it (accountsvc.py 116):
    // GetTransactions(accountingKeyCash, year, month, isCorp), with None for
    // this month and False for the pilot's own wallet, a list of KeyVals; and
    // GetEntryTypes, the ref-type -> label static map. The client has no other
    // read of it: account.GetJournal, which this route asked as well until
    // 2026-10-09, is a call the retail client never makes (the server's answer
    // to it is the same entries as a Rowset). The corp branch (isCorp True) is
    // DELIBERATELY never issued here (like R50's corp GetCashBalance). Each read
    // is independent; an empty ledger is a REAL answer, not a failure
    // (worldHasNoContracts precedent), decoded browser-side.
    const [cash, divisions, corporation, transactions, entryTypes] =
      await Promise.allSettled([
        heldTopLevelCall(held, req.webSessionID, "account", "GetCashBalance", [0], null),
        heldTopLevelCall(held, req.webSessionID, "account", "GetWalletDivisionsInfo", [], null),
        heldTopLevelCall(held, req.webSessionID, "corpRegistry", "GetCorporation", [], null),
        heldTopLevelCall(held, req.webSessionID, "account", "GetTransactions", [1000, null, null, false], null),
        heldTopLevelCall(held, req.webSessionID, "account", "GetEntryTypes", [], null),
      ]);
    // A lost live session can't be recovered by any read; surface it so the page
    // returns to character select (as every held call does).
    for (const settled of [cash, divisions, corporation, transactions, entryTypes]) {
      if (settled.status === "rejected" && settled.reason && settled.reason.code === "SESSION_NOT_FOUND") {
        next(settled.reason);
        return;
      }
    }
    const settledCode = (settled) =>
      settled.status === "rejected"
        ? String((settled.reason && settled.reason.code) || "READ_FAILED")
        : null;
    const settledValue = (settled) =>
      settled.status === "fulfilled" ? settled.value.result : null;
    res.json({
      ok: true,
      cash: settledValue(cash),
      divisions: settledValue(divisions),
      // Division ordinal (1..7) -> player-authored name; the browser falls back
      // to a plain "Division N" label when a corporation never renamed one. A
      // division FLAG number is never shown.
      divisionNames:
        corporation.status === "fulfilled"
          ? decodeWalletDivisionNames(corporation.value.result)
          : {},
      // R54 raw ledger shapes (decoded in web/src/bridge/wallet.ts).
      transactions: settledValue(transactions),
      entryTypes: settledValue(entryTypes),
      errors: {
        cash: settledCode(cash),
        divisions: settledCode(divisions),
        corp: settledCode(corporation),
        transactions: settledCode(transactions),
        entryTypes: settledCode(entryTypes),
      },
    });
  } catch (error) {
    next(error);
  }
});

// --- R55 Standings ----------------------------------------------------------
// The reads the retail standings panel issues (charsheet/standingsPanel). The
// base pull is the character's own standings (standingMgr.GetCharStandings) and
// the corporation's (standingMgr.GetCorpStandings) — both plain TOP-LEVEL reads
// scoped server-side off the docked session, no args. Passing `fromID` also asks
// for that entity's drill-down: the standing HISTORY
// (GetStandingTransactions(fromID, characterID)) and the per-member COMPOSITION
// (GetStandingCompositions(fromID, corporationID)) — the toIDs come from the
// server-held session, never the browser. Every read is INDEPENDENT
// (Promise.allSettled): a failed corp read never blanks the character's own
// standings, and each read carries its own error code. An empty list is a REAL
// "no standings" answer, distinct from a FAILED read (worldHasNoContracts
// precedent). ⚠ Raw retail shapes ship out; the browser decodes them
// (web/src/bridge/standings.ts) and resolves every entity id to a name (R7d).
app.get("/api/bridge/standings", requireAuth, async (req, res, next) => {
  const held = requireHeldBridgeSession(req, res);
  if (!held) {
    return;
  }
  const fromID = Number(req.query && req.query.fromID) || 0;
  const wantDetail = fromID > 0;
  try {
    // standingsvc.py 118: a pilot in an NPC corporation is asked for its own standings alone, and its
    // corporation's are taken to be none (idCheckers.IsNPC: above the system's items, below the players').
    const corporationID = Number(held.corporationID) || 0;
    const inNpcCorporation = corporationID > 10000 && corporationID < 90000000;
    // standingsvc.py reads both lists when the character is chosen and keeps them right from the server's
    // notices. The game port keeps them the same way (pilots.js standingsKept), and the two are answered from
    // that. With none kept they are asked for, as before.
    let kept = null;
    if (gamePortPilots && isGamePortHandle(held.bridgeSessionID)) {
      try {
        kept = await gamePortPilots.standingsKept({ userid: held.accountID }, held.bridgeSessionID);
      } catch (error) {
        if (error && error.code === "SESSION_NOT_FOUND") {
          forgetBridgeSession(req.webSessionID, held);
          next(error);
          return;
        }
      }
    }
    const [char, corp, transactions, compositions] = await Promise.allSettled([
      kept ? { result: kept.char } : heldTopLevelCall(held, req.webSessionID, "standingMgr", "GetCharStandings", [], null),
      kept
        ? { result: kept.corp }
        : inNpcCorporation
          ? Promise.resolve({ result: null })
          : heldTopLevelCall(held, req.webSessionID, "standingMgr", "GetCorpStandings", [], null),
      wantDetail
        ? heldTopLevelCall(
            held,
            req.webSessionID,
            "standingMgr",
            "GetStandingTransactions",
            [fromID, held.characterID],
            null,
          )
        : Promise.resolve({ result: null }),
      wantDetail
        ? heldTopLevelCall(
            held,
            req.webSessionID,
            "standingMgr",
            "GetStandingCompositions",
            [fromID, Number(held.corporationID) || 0],
            null,
          )
        : Promise.resolve({ result: null }),
    ]);
    // A lost live session can't be recovered by any read; surface it so the page
    // returns to character select (as every held call does).
    for (const settled of [char, corp, transactions, compositions]) {
      if (settled.status === "rejected" && settled.reason && settled.reason.code === "SESSION_NOT_FOUND") {
        next(settled.reason);
        return;
      }
    }
    const settledCode = (settled) =>
      settled.status === "rejected"
        ? String((settled.reason && settled.reason.code) || "READ_FAILED")
        : null;
    const settledValue = (settled) =>
      settled.status === "fulfilled" ? settled.value.result : null;
    res.json({
      ok: true,
      fromID: wantDetail ? fromID : null,
      char: settledValue(char),
      corp: settledValue(corp),
      transactions: settledValue(transactions),
      compositions: settledValue(compositions),
      errors: {
        char: settledCode(char),
        corp: settledCode(corp),
        // Detail reads are only issued when a fromID was asked for; otherwise
        // they resolve to a null result with no error.
        transactions: wantDetail ? settledCode(transactions) : null,
        compositions: wantDetail ? settledCode(compositions) : null,
      },
    });
  } catch (error) {
    next(error);
  }
});

// --- R56 Character Sheet -----------------------------------------------------
// "Who is this character." Four plain TOP-LEVEL charMgr reads the retail
// charactersheet window issues, each scoped server-side off the docked session:
//   • charMgr.GetPublicInfo3   -> {type:"list", items:[util.KeyVal{name, corp,
//     alliance, security, ...}]} — public identity.
//   • charMgr.GetCharacterDescription -> a plain STRING (the bio).
//   • charMgr.GetHomeStationRow -> util.KeyVal carrying the home stationID: the
//     read the client's character sheet makes (charactersheet.py 59). EveJS
//     answers GetHomeStation, which the client never asks, with the same row.
//   • charMgr.GetCloneInfo     -> util.KeyVal{clones(dict), implants(dict), ...}.
// Every read is issued with NO ARGUMENT so the handler falls through to
// session.characterID — there is no way for the browser to point one at another
// character. Each read is INDEPENDENT (Promise.allSettled): a failed clone read
// never blanks the identity, and each carries its own error code. An empty implant
// set is a REAL "clean clone" answer, distinct from a FAILED read
// (worldHasNoContracts precedent). ⚠ Raw retail shapes ship out; the browser
// decodes them (web/src/bridge/characterSheet.ts) and resolves every entity id to
// a name (R7d) — corp / alliance / home station / implant typeIDs — via /api/names.
/** dogma/const.py attributeImplantness: the slot an implant's type goes in. */
const ATTRIBUTE_IMPLANTNESS = 331;

/**
 * What the Character Sheet reads of the pilot's clone, from what the client's own sheet lists: the implants its
 * skill handler answers (skillsvc.GetImplants), each known by its type and put in the slot its type's own
 * attribute says, which is what the client sorts them by (implantsBoostersPanel.py 43). In the form the page
 * reads a clone in, each implant under the key the server gave it. Null when the answer is not a dict of things
 * with a type: none at all would say the pilot's head is empty.
 */
function cloneOfImplants(result) {
  if (!result || !Array.isArray(result.entries)) {
    return null;
  }
  const keyVal = (entries) => ({ type: "object", name: "util.KeyVal", args: { type: "dict", entries } });
  const slotOf = (typeID) =>
    (typeof staticData.getTypeDogmaAttribute === "function" ? Number(staticData.getTypeDogmaAttribute(typeID, ATTRIBUTE_IMPLANTNESS, 0)) : 0);
  const implants = [];
  for (const [key, implant] of result.entries) {
    const typeID = mailNumber(contractRowField(implant, "typeID"));
    if (!(typeID > 0)) {
      return null;
    }
    implants.push([key, keyVal([["typeID", typeID], ["slot", slotOf(typeID)]])]);
  }
  return keyVal([["implants", { type: "dict", entries: implants }]]);
}

app.get("/api/bridge/character-sheet", requireAuth, async (req, res, next) => {
  const held = requireHeldBridgeSession(req, res);
  if (!held) {
    return;
  }
  // implantsBoostersPanel.py 40: the client's sheet lists what its skill handler answers and never asks
  // charMgr.GetCloneInfo. On the game port the implants are asked for its way.
  const asTheClient = Boolean(gamePortPilots && isGamePortHandle(held.bridgeSessionID));
  try {
    const [publicInfo, description, homeStation, cloneRead] = await Promise.allSettled([
      heldTopLevelCall(held, req.webSessionID, "charMgr", "GetPublicInfo3", [], null),
      heldTopLevelCall(held, req.webSessionID, "charMgr", "GetCharacterDescription", [], null),
      heldTopLevelCall(held, req.webSessionID, "charMgr", "GetHomeStationRow", [], null),
      asTheClient
        ? heldTopLevelCall(held, req.webSessionID, "skillHandler", "GetImplants", [], null)
        : heldTopLevelCall(held, req.webSessionID, "charMgr", "GetCloneInfo", [], null),
    ]);
    let cloneInfo = cloneRead;
    if (asTheClient && cloneRead.status === "fulfilled") {
      const clone = cloneOfImplants(cloneRead.value.result);
      cloneInfo = clone ? { status: "fulfilled", value: { result: clone } } : { status: "rejected", reason: { code: "READ_FAILED" } };
    }
    // A lost live session can't be recovered by any read; surface it so the page
    // returns to character select (as every held call does).
    for (const settled of [publicInfo, description, homeStation, cloneInfo]) {
      if (settled.status === "rejected" && settled.reason && settled.reason.code === "SESSION_NOT_FOUND") {
        next(settled.reason);
        return;
      }
    }
    const settledCode = (settled) =>
      settled.status === "rejected"
        ? String((settled.reason && settled.reason.code) || "READ_FAILED")
        : null;
    const settledValue = (settled) =>
      settled.status === "fulfilled" ? settled.value.result : null;
    res.json({
      ok: true,
      publicInfo: settledValue(publicInfo),
      description: settledValue(description),
      homeStation: settledValue(homeStation),
      cloneInfo: settledValue(cloneInfo),
      errors: {
        publicInfo: settledCode(publicInfo),
        description: settledCode(description),
        homeStation: settledCode(homeStation),
        cloneInfo: settledCode(cloneInfo),
      },
    });
  } catch (error) {
    next(error);
  }
});

// --- R57 plumbing sweep: top-level reads (fittings / kill rights / LP)
// Its read routes, made for no screen of the page's, went on 2026-10-14 (the loop's item 64): nothing asked them.

// --- R65 plumbing sweep: utility READS (insurance / corp+alliance fittings /
// bookmarks) — no UI. Each route batches allowlisted TOP-LEVEL reads on the held
// session; every read scopes off the session (or is public/static reference
// data), so the browser cannot point one at another entity. The raw retail-shaped
// results ship out, decoded browser-side
// (web/src/bridge/{insurance,sharedFittings,bookmarks}.ts).

// The captured notifications of a settled held call. Some reads (e.g. pvpFilamentMgr.
// GetLeaderboard / GetCharacterStatistics) RETURN null and push their payload as a
// notification the gateway drains into the response envelope; those decoders read from
// here, not from `.result`. [] for a rejected read.
function settledReadNotifications(settled) {
  return settled.status === "fulfilled" && Array.isArray(settled.value.notifications)
    ? settled.value.notifications
    : [];
}

// --- R58 plumbing sweep: charMgr social/profile reads (no UI) ----------------
// PLUMBING ONLY: three routes make the charMgr social/profile READS reachable +
// decodable so a later goal builds UI cheaply. No panel/tab/store slice ships.
// Every read is an allowlisted TOP-LEVEL call on the held session; the profile /
// notes / contact reads scope to the logged-in character server-side (arg-less,
// or session-scoped), so the browser cannot point one at another character. The
// raw retail-shaped results ship out; the browser decodes them
// (web/src/bridge/{characterProfile,characterNotes,contactList}.ts).

// A non-negative integer from a query string, or a fallback. Used for the two
// notes reads that take an id argument (GetOwnerNote(noteID) / GetNote(itemID)).
function nonNegativeIntQuery(value, fallback) {
  const numeric = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : fallback;
}

// GET /api/bridge/contact-list — the personal contacts / watchlist / blocked
// owners (charMgr.GetContactList, session-scoped, no args). A single read ->
// util.KeyVal{addresses: Rowset, blocked: Rowset}. Empty for Farmer (no contacts)
// is a REAL empty state, not a failure. ⚠ Contact + blocked-owner IDs are entity
// ids the browser resolves to names (R7d); the raw shape ships out untouched.
app.get("/api/bridge/contact-list", requireAuth, async (req, res, next) => {
  const held = requireHeldBridgeSession(req, res);
  if (!held) {
    return;
  }
  try {
    const outcome = await heldTopLevelCall(
      held,
      req.webSessionID,
      "charMgr",
      "GetContactList",
      [],
      null,
    );
    res.json({ ok: true, contactList: outcome.result });
  } catch (error) {
    next(error);
  }
});

// --- R59 plumbing sweep: comms reads — mail aux / notifications / calendar ----
// PLUMBING ONLY: three routes make the mail-aux, notification, and calendar READS
// reachable + decodable so a later goal builds UI cheaply. No panel/tab/store
// slice ships. Every read is an allowlisted TOP-LEVEL call on the held session,
// scoped to the logged-in character server-side (arg-less, session-scoped, or a
// plain id/month arg the browser supplies), so a browser cannot point one at
// another character's mailbox/notifications/calendar. Each route batches its
// reads with Promise.allSettled (empty ≠ failed; each read carries its own error
// code); a SESSION_NOT_FOUND on any read surfaces via next() so the page returns
// to character select. The raw retail-shaped results ship out; the browser
// decodes them (web/src/bridge/{mailAux,notifications,calendar}.ts).

// GET /api/bridge/notifications — the notificationMgr reads, as THREE independent
// reads (Promise.allSettled):
//   • GetAllNotifications([fromID]) -> a BARE ARRAY of util.KeyVal notification
//     DTOs {notificationID, typeID, senderID, receiverID, processed, created
//     (long), data}. fromID from ?fromID= (default 0 -> all).
//   • GetUnprocessed()             -> the unread subset, same bare-array shape.
//   • GetByGroupID(groupID)        -> the notifications in one group. groupID
//     from ?groupID= (default 0).
// All session-scoped; a characterID<=0 or no notifications yields [] — a REAL
// empty state for Farmer. ⚠ senderID is an entity id kept as data (R7d); the
// per-type `data` payload ships through untouched. The Mark*/Delete* notification
// writers stay refused. Decoded browser-side (web/src/bridge/notifications.ts).
// The page no longer asks it: its Activity Center asks GetAllNotifications(fromID=0) and GetUnprocessed() itself, by
// the generic call, as the client's notification service does (web/src/app/flow.ts, loadActivity). Kept for
// scripts/bff-parity.js.
app.get("/api/bridge/notifications", requireAuth, async (req, res, next) => {
  const held = requireHeldBridgeSession(req, res);
  if (!held) {
    return;
  }
  const fromID = nonNegativeIntQuery(req.query.fromID, 0);
  const groupID = nonNegativeIntQuery(req.query.groupID, 0);
  try {
    const [all, unprocessed, byGroup] = await Promise.allSettled([
      heldTopLevelCall(held, req.webSessionID, "notificationMgr", "GetAllNotifications", [fromID], null),
      heldTopLevelCall(held, req.webSessionID, "notificationMgr", "GetUnprocessed", [], null),
      heldTopLevelCall(held, req.webSessionID, "notificationMgr", "GetByGroupID", [groupID], null),
    ]);
    for (const outcome of [all, unprocessed, byGroup]) {
      if (outcome.status === "rejected" && outcome.reason && outcome.reason.code === "SESSION_NOT_FOUND") {
        next(outcome.reason);
        return;
      }
    }
    const settledCode = (outcome) =>
      outcome.status === "rejected"
        ? String((outcome.reason && outcome.reason.code) || "READ_FAILED")
        : null;
    const settledValue = (outcome) =>
      outcome.status === "fulfilled" ? outcome.value.result : null;
    res.json({
      ok: true,
      requested: { fromID, groupID },
      all: settledValue(all),
      unprocessed: settledValue(unprocessed),
      byGroup: settledValue(byGroup),
      errors: {
        all: settledCode(all),
        unprocessed: settledCode(unprocessed),
        byGroup: settledCode(byGroup),
      },
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/bridge/calendar — the calendar READS across calendarMgr + the
// (top-level, NOT bound) calendarProxy, as FOUR independent reads
// (Promise.allSettled):
//   • calendarMgr.GetResponsesForCharacter() -> {type:"list"} of util.KeyVal
//     {eventID, status} — this character's own event responses (session-scoped).
//   • calendarProxy.GetEventList(month, year) -> [ {type:"list"} of event-row
//     KeyVals, null, null ] — the events visible in one month. month from ?month=
//     (default the current UTC month, 1-12), year from ?year= (default current).
//   • calendarMgr.GetResponsesToEvent(eventID[, ownerID]) -> {type:"list"} of
//     util.KeyVal{characterID, status} — the responses to one event.
//   • calendarProxy.GetEventDetails(eventID, ownerID) -> util.KeyVal{eventText,
//     creatorID} — one event's body. eventID from ?eventID=, ownerID from ?ownerID=.
//     ⚠ GetEventDetails/GetResponsesToEvent are asked ONLY for an event that is
//     named, as the retail client asks them when the pilot opens one
//     (eveCalendarsvc.py 261, 415). With no eventID neither goes out, and each
//     arm answers null with no error: not asked is not a failure.
// ⚠ ownerID/eventID/characterID/creatorID stay as data for later resolution
// (R7d). Decoded browser-side (web/src/bridge/calendar.ts).
// The page no longer asks it: its Activity Center asks calendarProxy.GetEventList for this month and the next, and
// calendarMgr.GetResponsesForCharacter(), itself, by the generic call, as the client's calendar service does
// (web/src/app/flow.ts, loadActivity). Kept for scripts/bff-parity.js.
app.get("/api/bridge/calendar", requireAuth, async (req, res, next) => {
  const held = requireHeldBridgeSession(req, res);
  if (!held) {
    return;
  }
  const now = new Date();
  const month = nonNegativeIntQuery(req.query.month, now.getUTCMonth() + 1);
  const year = nonNegativeIntQuery(req.query.year, now.getUTCFullYear());
  const eventID = nonNegativeIntQuery(req.query.eventID, 0);
  const ownerID = nonNegativeIntQuery(req.query.ownerID, 0);
  const notAsked = Promise.resolve({ result: null });
  try {
    const [responsesForCharacter, eventList, responsesToEvent, eventDetails] =
      await Promise.allSettled([
        heldTopLevelCall(held, req.webSessionID, "calendarMgr", "GetResponsesForCharacter", [], null),
        heldTopLevelCall(held, req.webSessionID, "calendarProxy", "GetEventList", [month, year], null),
        eventID > 0 ? heldTopLevelCall(held, req.webSessionID, "calendarMgr", "GetResponsesToEvent", [eventID, ownerID || null], null) : notAsked,
        eventID > 0 ? heldTopLevelCall(held, req.webSessionID, "calendarProxy", "GetEventDetails", [eventID, ownerID || null], null) : notAsked,
      ]);
    const settled = [responsesForCharacter, eventList, responsesToEvent, eventDetails];
    for (const outcome of settled) {
      if (outcome.status === "rejected" && outcome.reason && outcome.reason.code === "SESSION_NOT_FOUND") {
        next(outcome.reason);
        return;
      }
    }
    const settledCode = (outcome) =>
      outcome.status === "rejected"
        ? String((outcome.reason && outcome.reason.code) || "READ_FAILED")
        : null;
    const settledValue = (outcome) =>
      outcome.status === "fulfilled" ? outcome.value.result : null;
    res.json({
      ok: true,
      requested: { month, year, eventID, ownerID },
      responsesForCharacter: settledValue(responsesForCharacter),
      eventList: settledValue(eventList),
      responsesToEvent: settledValue(responsesToEvent),
      eventDetails: settledValue(eventDetails),
      errors: {
        responsesForCharacter: settledCode(responsesForCharacter),
        eventList: settledCode(eventList),
        responsesToEvent: settledCode(responsesToEvent),
        eventDetails: settledCode(eventDetails),
      },
    });
  } catch (error) {
    next(error);
  }
});

// --- R60 plumbing sweep: lookup / presence / social reads (no UI) -------------
// PLUMBING ONLY: three routes make the lookupSvc SEARCH, onlineStatus presence,
// and LSC/account social READS reachable + decodable so a later goal builds UI
// cheaply. No panel/tab/store slice ships. Every read is an allowlisted
// TOP-LEVEL call on the held session, scoped to the logged-in character
// server-side; each route batches its reads with Promise.allSettled (empty ≠
// failed; each read carries its own error code), and a SESSION_NOT_FOUND on any
// read surfaces via next() so the page returns to character select. The raw
// retail-shaped results ship out; the browser decodes them
// (web/src/bridge/{lookup,presence,social}.ts).

// A trimmed string from a query param, or "". Used for the lookup search term.
function stringQuery(value) {
  return typeof value === "string" ? value.trim() : "";
}

// GET /api/bridge/presence?targetID= — the onlineStatus reads, as TWO
// independent reads (Promise.allSettled). Both scope off the SESSION observer:
//   • GetOnlineStatus(targetID) -> a BARE BOOLEAN (is that character online).
//     targetID from ?targetID= (default 0 -> false; no contact named).
//   • GetInitialState()         -> a Rowset[contactID, online] (the observer's
//     whole contact-presence snapshot; empty for a character with no contacts).
//     ⚠ contactID stays as data for later name resolution (R7d).
// Not Prime(): the client never asks the server for it. Prime is its online
// status service's own method, which asks GetInitialState() once and keeps it
// (comtool/onlineStatus.py 74 to 82).
app.get("/api/bridge/presence", requireAuth, async (req, res, next) => {
  const held = requireHeldBridgeSession(req, res);
  if (!held) {
    return;
  }
  const targetID = nonNegativeIntQuery(req.query.targetID, 0);
  try {
    const [onlineStatus, initialState] = await Promise.allSettled([
      heldTopLevelCall(held, req.webSessionID, "onlineStatus", "GetOnlineStatus", [targetID], null),
      heldTopLevelCall(held, req.webSessionID, "onlineStatus", "GetInitialState", [], null),
    ]);
    for (const outcome of [onlineStatus, initialState]) {
      if (outcome.status === "rejected" && outcome.reason && outcome.reason.code === "SESSION_NOT_FOUND") {
        next(outcome.reason);
        return;
      }
    }
    const settledCode = (outcome) =>
      outcome.status === "rejected"
        ? String((outcome.reason && outcome.reason.code) || "READ_FAILED")
        : null;
    const settledValue = (outcome) =>
      outcome.status === "fulfilled" ? outcome.value.result : null;
    res.json({
      ok: true,
      requested: { targetID },
      onlineStatus: settledValue(onlineStatus),
      initialState: settledValue(initialState),
      errors: {
        onlineStatus: settledCode(onlineStatus),
        initialState: settledCode(initialState),
      },
    });
  } catch (error) {
    next(error);
  }
});

// --- R61 plumbing sweep: corp reads (corpmgr / corp LP; no UI) ----------------
// PLUMBING ONLY: three routes make the corp READS reachable + decodable so a
// later goal builds UI cheaply. No panel/tab/store slice ships. Every read is an
// allowlisted TOP-LEVEL call on the held session; corp-scoped reads default to
// the session corporation (held.corporationID) and char-scoped ones to the
// session character, so a browser cannot point one at another owner. The raw
// retail-shaped results ship out; the browser decodes them
// (web/src/bridge/{corpInfo,corpAssets,corpLp}.ts).

// GET /api/bridge/corp-assets?which=&locationID=&categoryID=&groupID=&typeID=&minimumQuantity=
// — the corpmgr ASSET reads, as THREE independent reads (Promise.allSettled).
// ⚠ ALL THREE RETURN A CRowset WRAPPED IN A CachedMethodCallResult — the browser
// unwraps both layers (web/src/bridge/corpAssets.ts):
//   • GetAssetInventory(corpID, which)  -> the corp's asset LOCATIONS for a bucket
//     (`which`, default "offices").
//   • GetAssetInventoryForLocation(corpID, locationID, which) -> ⚠ ONLY when
//     ?locationID= is given; the ITEMS at one location.
//   • SearchAssets(which, categoryID, groupID, typeID, minimumQuantity) -> matching
//     LOCATIONS. ⚠ ONLY when the request names one of the four filters; without
//     one, `search` is null with no error. ⚠ corporationID comes from the SESSION
//     in the handler, not args.
// corporationID defaults to the session corp. ⚠ Farmer's player corp 98000001 may
// have SPARSE corp assets — an empty CRowset is a legitimate "no corp assets"
// state, not a failure. Location / item / type ids stay data (R7d).
app.get("/api/bridge/corp-assets", requireAuth, async (req, res, next) => {
  const held = requireHeldBridgeSession(req, res);
  if (!held) {
    return;
  }
  const call = (method, args) => heldTopLevelCall(held, req.webSessionID, "corpmgr", method, args, null);
  await answerCorpAssets(held, call, req, res, next);
});

// The corpmgr asset reads behind both corp-asset routes, on whichever held
// session `call` rides. Read-only by construction: three corpmgr reads, nothing
// else.
async function answerCorpAssets(held, call, req, res, next) {
  const corporationID = Number(held.corporationID) || 0;
  const which = stringQuery(req.query.which) || "offices";
  const locationID = nonNegativeIntQuery(req.query.locationID, 0);
  const categoryID = nonNegativeIntQuery(req.query.categoryID, 0);
  const groupID = nonNegativeIntQuery(req.query.groupID, 0);
  const typeID = nonNegativeIntQuery(req.query.typeID, 0);
  const minimumQuantity = nonNegativeIntQuery(req.query.minimumQuantity, 0);
  const wantLocation = locationID > 0;
  // corp_ui_accounts.py 752: the client asks SearchAssets when the pilot presses Search, and at no
  // other time. Here a search is a request that names one of its filters, even as nought.
  const wantSearch = ["categoryID", "groupID", "typeID", "minimumQuantity"].some((name) => req.query[name] !== undefined);
  try {
    const [inventory, locationInventory, search] = await Promise.allSettled([
      call("GetAssetInventory", [corporationID, which]),
      wantLocation
        ? call("GetAssetInventoryForLocation", [corporationID, locationID, which])
        : Promise.resolve({ result: null }),
      wantSearch
        ? call("SearchAssets", [which, categoryID, groupID, typeID, minimumQuantity])
        : Promise.resolve({ result: null }),
    ]);
    for (const outcome of [inventory, locationInventory, search]) {
      if (outcome.status === "rejected" && outcome.reason && outcome.reason.code === "SESSION_NOT_FOUND") {
        next(outcome.reason);
        return;
      }
    }
    const settledCode = (outcome) =>
      outcome.status === "rejected"
        ? String((outcome.reason && outcome.reason.code) || "READ_FAILED")
        : null;
    const settledValue = (outcome) =>
      outcome.status === "fulfilled" ? outcome.value.result : null;
    res.json({
      ok: true,
      requested: {
        corporationID,
        which,
        locationID: wantLocation ? locationID : null,
        filters: { categoryID, groupID, typeID, minimumQuantity },
      },
      inventory: settledValue(inventory),
      locationInventory: settledValue(locationInventory),
      search: settledValue(search),
      errors: {
        inventory: settledCode(inventory),
        // The per-location read is only issued when a locationID was asked for.
        locationInventory: wantLocation ? settledCode(locationInventory) : null,
        search: settledCode(search),
      },
    });
  } catch (error) {
    next(error);
  }
}

// --- R80 plumbing sweep: corpRegistry batch A (member / info core; no UI) -------
// PLUMBING ONLY: three routes make the corpRegistry MEMBER + REGISTRY-META READS
// reachable + decodable so a later goal builds UI cheaply. No panel/tab/store slice
// ships. corpRegistry is retail-bound per corp (eveMoniker.GetCorpRegistry(corpID)),
// but the gateway dispatches these TOP-LEVEL on the held session; every handler
// resolves its corp from the SESSION (resolveCorporationID), and corpRegistry.
// MachoBindObject is NOT allowlisted, so a browser cannot bind a foreign corp. The
// raw retail-shaped results ship out; the browser decodes them
// (web/src/bridge/{corpMembers,corpMemberTracking,corpRegistryMeta}.ts).

// GET /api/bridge/corp-members?page=&memberID=&memberIDs= — the corp ROSTER +
// member-tracking reads, as SIX independent reads (Promise.allSettled; empty ≠
// failed, each its own error code). All SESSION-CORP-SCOPED (args cannot redirect
// the corp; a foreign memberID misses the session corp's member table):
//   • GetMembersPaged(page)          -> one page of the session corp's members
//     (PagedResultSet; page defaults to 1).
//   • GetEveOwners()                 -> name-resolution rows for the corp members.
//   • GetMemberTrackingInfo()        -> member tracking (last-login / location),
//     wrapped in a CachedMethodCallResult.
//   • GetMemberTrackingInfoSimple()  -> the SAME tracking rows, un-cached.
//   • GetMember(memberID)            -> ⚠ ONLY when ?memberID= is given; that member
//     (null when the id is not in the session corp).
//   • GetMembersByIds([memberIDs])   -> ⚠ ONLY when ?memberIDs= (a CSV) is given; the
//     members among those ids (foreign ids drop out). Member / char ids stay data (R7d).
app.get("/api/bridge/corp-members", requireAuth, async (req, res, next) => {
  const held = requireHeldBridgeSession(req, res);
  if (!held) {
    return;
  }
  const page = Math.max(1, nonNegativeIntQuery(req.query.page, 1));
  const memberID = nonNegativeIntQuery(req.query.memberID, 0);
  const memberIDs = String(req.query.memberIDs || "")
    .split(",")
    .map((token) => Number(String(token).trim()))
    .filter((value) => Number.isSafeInteger(value) && value > 0);
  const wantMember = memberID > 0;
  const wantByIds = memberIDs.length > 0;
  try {
    const [
      membersPaged,
      eveOwners,
      trackingInfo,
      trackingSimple,
      member,
      membersByIds,
    ] = await Promise.allSettled([
      heldTopLevelCall(held, req.webSessionID, "corpRegistry", "GetMembersPaged", [page], null),
      heldTopLevelCall(held, req.webSessionID, "corpRegistry", "GetEveOwners", [], null),
      heldTopLevelCall(held, req.webSessionID, "corpRegistry", "GetMemberTrackingInfo", [], null),
      heldTopLevelCall(held, req.webSessionID, "corpRegistry", "GetMemberTrackingInfoSimple", [], null),
      wantMember
        ? heldTopLevelCall(held, req.webSessionID, "corpRegistry", "GetMember", [memberID], null)
        : Promise.resolve({ result: null }),
      wantByIds
        ? heldTopLevelCall(held, req.webSessionID, "corpRegistry", "GetMembersByIds", [memberIDs], null)
        : Promise.resolve({ result: null }),
    ]);
    const settled = [membersPaged, eveOwners, trackingInfo, trackingSimple, member, membersByIds];
    for (const outcome of settled) {
      if (outcome.status === "rejected" && outcome.reason && outcome.reason.code === "SESSION_NOT_FOUND") {
        next(outcome.reason);
        return;
      }
    }
    const settledCode = (outcome) =>
      outcome.status === "rejected"
        ? String((outcome.reason && outcome.reason.code) || "READ_FAILED")
        : null;
    const settledValue = (outcome) =>
      outcome.status === "fulfilled" ? outcome.value.result : null;
    res.json({
      ok: true,
      requested: {
        page,
        memberID: wantMember ? memberID : null,
        memberIDs: wantByIds ? memberIDs : null,
      },
      membersPaged: settledValue(membersPaged),
      eveOwners: settledValue(eveOwners),
      trackingInfo: settledValue(trackingInfo),
      trackingSimple: settledValue(trackingSimple),
      member: settledValue(member),
      membersByIds: settledValue(membersByIds),
      errors: {
        membersPaged: settledCode(membersPaged),
        eveOwners: settledCode(eveOwners),
        trackingInfo: settledCode(trackingInfo),
        trackingSimple: settledCode(trackingSimple),
        member: wantMember ? settledCode(member) : null,
        membersByIds: wantByIds ? settledCode(membersByIds) : null,
      },
    });
  } catch (error) {
    next(error);
  }
});

// --- R81 plumbing sweep: corpRegistry batch B (shares / applications / welcome
// mail; no UI) --------------------------------------------------------------
// PLUMBING ONLY: three routes make the corpRegistry SHARE-LEDGER, APPLICATION and
// WELCOME-MAIL reads reachable + decodable so a later goal builds UI cheaply. No
// panel/tab/store slice ships. Same dispatch as R80 batch A: corpRegistry is retail-
// bound per corp (eveMoniker.GetCorpRegistry(corpID)) but the gateway dispatches these
// TOP-LEVEL on the held session; every handler resolves its corp (or char) from the
// SESSION (resolveCorporationID / resolveCharacterID), and corpRegistry.MachoBindObject
// is NOT allowlisted, so a browser cannot bind a foreign corp. Decoders in
// web/src/bridge/{corpShares,corpMemberQueries,corpApplications}.ts.

// GET /api/bridge/corp-applications — the corp/char APPLICATION reads + the corp
// WELCOME MAIL, as SIX independent reads (Promise.allSettled). ⚠ A small corp with no
// pending applications is a legitimate EMPTY state, not a failure. All SESSION-SCOPED
// (args ignored):
//   • GetApplications()        -> the SESSION corp's incoming applications, a dict
//     {applicantCharID -> list of application packedrows}. (Retail director-gated; eve.js
//     is own-corp only.)
//   • GetOldApplications()     -> the session corp's ARCHIVED applications (a list).
//   • GetMyApplications()      -> the SESSION char's own applications across corps, a
//     dict {corpID -> list of application packedrows}.
//   • GetMyOldApplications()   -> the session char's own ARCHIVED applications (a list).
//   • GetAllianceApplications() -> the session corp's OUTGOING alliance applications, an
//     IndexRowset keyed by allianceID.
//   • GetCorpWelcomeMail()     -> the corp welcome-mail KeyVal (editor charID / change
//     FILETIME / the mail string). FILETIMEs bigint-safe; charIDs stay data (R7d).
app.get("/api/bridge/corp-applications", requireAuth, async (req, res, next) => {
  const held = requireHeldBridgeSession(req, res);
  if (!held) {
    return;
  }
  try {
    const [applications, oldApplications, myApplications, myOldApplications, allianceApplications, welcomeMail] =
      await Promise.allSettled([
        heldTopLevelCall(held, req.webSessionID, "corpRegistry", "GetApplications", [], null),
        heldTopLevelCall(held, req.webSessionID, "corpRegistry", "GetOldApplications", [], null),
        heldTopLevelCall(held, req.webSessionID, "corpRegistry", "GetMyApplications", [], null),
        heldTopLevelCall(held, req.webSessionID, "corpRegistry", "GetMyOldApplications", [], null),
        heldTopLevelCall(held, req.webSessionID, "corpRegistry", "GetAllianceApplications", [], null),
        heldTopLevelCall(held, req.webSessionID, "corpRegistry", "GetCorpWelcomeMail", [], null),
      ]);
    const settled = [applications, oldApplications, myApplications, myOldApplications, allianceApplications, welcomeMail];
    for (const outcome of settled) {
      if (outcome.status === "rejected" && outcome.reason && outcome.reason.code === "SESSION_NOT_FOUND") {
        next(outcome.reason);
        return;
      }
    }
    const settledCode = (outcome) =>
      outcome.status === "rejected"
        ? String((outcome.reason && outcome.reason.code) || "READ_FAILED")
        : null;
    const settledValue = (outcome) =>
      outcome.status === "fulfilled" ? outcome.value.result : null;
    res.json({
      ok: true,
      applications: settledValue(applications),
      oldApplications: settledValue(oldApplications),
      myApplications: settledValue(myApplications),
      myOldApplications: settledValue(myOldApplications),
      allianceApplications: settledValue(allianceApplications),
      welcomeMail: settledValue(welcomeMail),
      errors: {
        applications: settledCode(applications),
        oldApplications: settledCode(oldApplications),
        myApplications: settledCode(myApplications),
        myOldApplications: settledCode(myOldApplications),
        allianceApplications: settledCode(allianceApplications),
        welcomeMail: settledCode(welcomeMail),
      },
    });
  } catch (error) {
    next(error);
  }
});

// --- R82 plumbing sweep: corpRegistry batch C (kills / settings / checks / name
// suggestions; no UI — CLOSES corpRegistry at 34/34) ------------------------
// PLUMBING ONLY: four routes make the corpRegistry KILLBOARD, SETTINGS, MEMBERSHIP-CHECK
// and NAME-SUGGESTION reads reachable + decodable so a later goal builds UI cheaply. No
// panel/tab/store slice ships. Same top-level dispatch as splits A/B: corpRegistry is
// retail-bound per corp (eveMoniker.GetCorpRegistry(corpID)) but the gateway dispatches
// these TOP-LEVEL; corp/char are resolved from the SESSION, and corpRegistry.MachoBindObject
// is NOT allowlisted, so a browser cannot bind a foreign corp. Decoders in
// web/src/bridge/{corpKillboard,corpSettings,corpMembershipChecks,corpNameSuggestions}.ts.

// GET /api/bridge/corp-settings — the SESSION corp's aggression / structure / mail settings,
// as FOUR independent reads (Promise.allSettled). All SESSION-CORP-SCOPED (args ignored):
//   • GetAggressionSettings        -> the friendly-fire enable/disable FILETIME schedule
//     (a named AggressionSettings object).
//   • GetStructureReinforceDefault -> [reinforceWeekday, reinforceHour] (a bare 2-int array).
//   • DoesMyCorpAcceptStructures   -> a 0/1 flag.
//   • DoesCorpRestrictCorpMails    -> a 0/1 flag. FILETIMEs bigint-safe. Decoder in
//     web/src/bridge/corpSettings.ts.
app.get("/api/bridge/corp-settings", requireAuth, async (req, res, next) => {
  const held = requireHeldBridgeSession(req, res);
  if (!held) {
    return;
  }
  try {
    const [aggression, reinforce, acceptStructures, restrictMails] = await Promise.allSettled([
      heldTopLevelCall(held, req.webSessionID, "corpRegistry", "GetAggressionSettings", [], null),
      heldTopLevelCall(held, req.webSessionID, "corpRegistry", "GetStructureReinforceDefault", [], null),
      heldTopLevelCall(held, req.webSessionID, "corpRegistry", "DoesMyCorpAcceptStructures", [], null),
      heldTopLevelCall(held, req.webSessionID, "corpRegistry", "DoesCorpRestrictCorpMails", [], null),
    ]);
    for (const outcome of [aggression, reinforce, acceptStructures, restrictMails]) {
      if (outcome.status === "rejected" && outcome.reason && outcome.reason.code === "SESSION_NOT_FOUND") {
        next(outcome.reason);
        return;
      }
    }
    const settledCode = (outcome) =>
      outcome.status === "rejected"
        ? String((outcome.reason && outcome.reason.code) || "READ_FAILED")
        : null;
    const settledValue = (outcome) =>
      outcome.status === "fulfilled" ? outcome.value.result : null;
    res.json({
      ok: true,
      aggression: settledValue(aggression),
      reinforce: settledValue(reinforce),
      acceptStructures: settledValue(acceptStructures),
      restrictMails: settledValue(restrictMails),
      errors: {
        aggression: settledCode(aggression),
        reinforce: settledCode(reinforce),
        acceptStructures: settledCode(acceptStructures),
        restrictMails: settledCode(restrictMails),
      },
    });
  } catch (error) {
    next(error);
  }
});

// --- R83 plumbing sweep: allianceRegistry batch A (alliance info / members /
// relationships; no UI) -----------------------------------------------------
// PLUMBING ONLY: three routes make the allianceRegistry INFO / MEMBER / RELATIONSHIP
// READS reachable + decodable so a later goal builds UI cheaply. No panel/tab/store
// slice ships. allianceRegistry is retail-bound to an allianceID (like corpRegistry→
// corpID), but the gateway dispatches these TOP-LEVEL on the held session and
// allianceRegistry.MachoBindObject is NOT allowlisted, so a browser cannot BIND a
// foreign alliance. Ownership verified LIVE (Farmer 140000005 / corp 98000001,
// ALLIANCE-LESS): the identity/member/tenure reads are alliance-PUBLIC even for an
// injected foreign allianceID, and GetRelationships is session-scoped (ignores args).
// Decoders: web/src/bridge/{allianceInfo,allianceMembers,allianceRelationships}.ts.

// GET /api/bridge/alliance-info?allianceID=&maxLen= — the alliance IDENTITY reads, as
// THREE independent reads (Promise.allSettled; empty ≠ failed). ?allianceID= targets a
// specific alliance (EVE-PUBLIC identity lookup, safe); omitted → the SESSION alliance
// (null/empty when the caller's corp is alliance-less — a real state). ids stay data (R7d):
//   • GetAlliance([allianceID?]) / GetAlliancePublicInfo([allianceID?]) -> util.KeyVal
//     identity, or null.
//   • GetRankedAlliances([maxLen]) -> the public alliance-browser list (maxLen def 100).
app.get("/api/bridge/alliance-info", requireAuth, async (req, res, next) => {
  const held = requireHeldBridgeSession(req, res);
  if (!held) {
    return;
  }
  const allianceID = nonNegativeIntQuery(req.query.allianceID, 0);
  const maxLen = Math.max(1, nonNegativeIntQuery(req.query.maxLen, 100));
  const allianceArgs = allianceID > 0 ? [allianceID] : [];
  try {
    const [alliance, publicInfo, ranked] = await Promise.allSettled([
      heldTopLevelCall(held, req.webSessionID, "allianceRegistry", "GetAlliance", allianceArgs, null),
      heldTopLevelCall(held, req.webSessionID, "allianceRegistry", "GetAlliancePublicInfo", allianceArgs, null),
      heldTopLevelCall(held, req.webSessionID, "allianceRegistry", "GetRankedAlliances", [maxLen], null),
    ]);
    for (const outcome of [alliance, publicInfo, ranked]) {
      if (outcome.status === "rejected" && outcome.reason && outcome.reason.code === "SESSION_NOT_FOUND") {
        next(outcome.reason);
        return;
      }
    }
    const settledCode = (outcome) =>
      outcome.status === "rejected"
        ? String((outcome.reason && outcome.reason.code) || "READ_FAILED")
        : null;
    const settledValue = (outcome) =>
      outcome.status === "fulfilled" ? outcome.value.result : null;
    res.json({
      ok: true,
      requested: { allianceID: allianceID > 0 ? allianceID : null, maxLen },
      alliance: settledValue(alliance),
      publicInfo: settledValue(publicInfo),
      ranked: settledValue(ranked),
      errors: {
        alliance: settledCode(alliance),
        publicInfo: settledCode(publicInfo),
        ranked: settledCode(ranked),
      },
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/bridge/alliance-members?allianceID=&corporationID=&minDays= — the alliance
// MEMBERSHIP / TENURE / HISTORY reads, as FOUR independent reads (Promise.allSettled).
// ?allianceID= targets a specific alliance (member corps + tenure are EVE-PUBLIC — safe);
// omitted → the SESSION alliance (empty when alliance-less). corp/alliance ids stay data:
//   • GetAllianceMembers([allianceID?])                 -> member-corp Rowset.
//   • GetAllianceMembersOlderThan([allianceID?, minDays]) -> member corpIDs by tenure.
//   • GetDaysInAlliance([allianceID?, corporationID?])  -> integer days (needs BOTH ids).
//   • GetEmploymentRecord([corporationID?])             -> a corp's alliance history.
app.get("/api/bridge/alliance-members", requireAuth, async (req, res, next) => {
  const held = requireHeldBridgeSession(req, res);
  if (!held) {
    return;
  }
  const allianceID = nonNegativeIntQuery(req.query.allianceID, 0);
  const corporationID = nonNegativeIntQuery(req.query.corporationID, 0);
  const minDays = nonNegativeIntQuery(req.query.minDays, 0);
  const membersArgs = allianceID > 0 ? [allianceID] : [];
  const olderThanArgs = [allianceID > 0 ? allianceID : 0, minDays];
  const daysArgs = [allianceID > 0 ? allianceID : 0, corporationID > 0 ? corporationID : 0];
  const employmentArgs = corporationID > 0 ? [corporationID] : [];
  try {
    const [members, olderThan, days, employment] = await Promise.allSettled([
      heldTopLevelCall(held, req.webSessionID, "allianceRegistry", "GetAllianceMembers", membersArgs, null),
      heldTopLevelCall(held, req.webSessionID, "allianceRegistry", "GetAllianceMembersOlderThan", olderThanArgs, null),
      heldTopLevelCall(held, req.webSessionID, "allianceRegistry", "GetDaysInAlliance", daysArgs, null),
      heldTopLevelCall(held, req.webSessionID, "allianceRegistry", "GetEmploymentRecord", employmentArgs, null),
    ]);
    for (const outcome of [members, olderThan, days, employment]) {
      if (outcome.status === "rejected" && outcome.reason && outcome.reason.code === "SESSION_NOT_FOUND") {
        next(outcome.reason);
        return;
      }
    }
    const settledCode = (outcome) =>
      outcome.status === "rejected"
        ? String((outcome.reason && outcome.reason.code) || "READ_FAILED")
        : null;
    const settledValue = (outcome) =>
      outcome.status === "fulfilled" ? outcome.value.result : null;
    res.json({
      ok: true,
      requested: {
        allianceID: allianceID > 0 ? allianceID : null,
        corporationID: corporationID > 0 ? corporationID : null,
        minDays,
      },
      members: settledValue(members),
      olderThan: settledValue(olderThan),
      days: settledValue(days),
      employment: settledValue(employment),
      errors: {
        members: settledCode(members),
        olderThan: settledCode(olderThan),
        days: settledCode(days),
        employment: settledCode(employment),
      },
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/bridge/alliance-relationships — the SESSION alliance's standings dict
// {ownerID -> relationship}. SESSION-ALLIANCE-SCOPED: the handler resolves the alliance
// from the session ONLY and ignores args, so there is no allianceID query param — a
// browser can only ever read its own alliance's standings. Empty {} is a real answer
// (alliance-less session, or an alliance that seeds no standings). ids stay data (R7d).
app.get("/api/bridge/alliance-relationships", requireAuth, async (req, res, next) => {
  const held = requireHeldBridgeSession(req, res);
  if (!held) {
    return;
  }
  try {
    const relationships = await heldTopLevelCall(
      held,
      req.webSessionID,
      "allianceRegistry",
      "GetRelationships",
      [],
      null,
    );
    res.json({ ok: true, relationships: relationships.result });
  } catch (error) {
    next(error);
  }
});

// --- R84 plumbing sweep: allianceRegistry batch B (contacts / applications /
// bulletins / bills / sovereignty config; no UI) — CLOSES allianceRegistry -----
// PLUMBING ONLY: three routes make the allianceRegistry GOVERNANCE / FINANCIAL /
// SOVEREIGNTY reads reachable + decodable so a later goal builds UI cheaply. No
// panel/tab/store slice ships. Same top-level seam as R83, but EVERY read here is
// STRICTLY SESSION-SCOPED and IGNORES args (the handler resolves the alliance from
// resolveAllianceIDFromSession(session), or, for GetBillBalance, from the session
// corp / account key). There is NO allianceID query param because no args path can
// redirect any of these to a foreign alliance — verified LIVE: as Farmer
// (alliance-less) INJECTING allianceID 99000000 every read returned his OWN
// empty/zero state (prime hour 0, not Elysian's 2; bill balance = his own corp's),
// never the foreign alliance's contacts/applications/bulletins/bills. All 7 SAFE,
// nothing flagged. Decoders: web/src/bridge/{allianceGovernance,allianceBills,
// allianceSovereignty}.ts.

// GET /api/bridge/alliance-governance — the SESSION alliance's GOVERNANCE reads, as
// THREE independent reads (Promise.allSettled; empty ≠ failed). ids stay data (R7d):
//   • GetAllianceContacts -> a dict {contactID -> KeyVal(contactID/relationshipID/
//       labelMask)} — the alliance's standings-contact list.
//   • GetApplications -> an IndexRowset (keyed by corporationID) of the alliance's
//       INCOMING corp applications (allianceID/corporationID/applicationText/state/
//       applicationDateTime FILETIME).
//   • GetBulletins -> a list of packed bulletin rows (bulletinID/ownerID/create+edit
//       FILETIME/editCharacterID/title/body/sortOrder).
app.get("/api/bridge/alliance-governance", requireAuth, async (req, res, next) => {
  const held = requireHeldBridgeSession(req, res);
  if (!held) {
    return;
  }
  try {
    const [contacts, applications, bulletins] = await Promise.allSettled([
      heldTopLevelCall(held, req.webSessionID, "allianceRegistry", "GetAllianceContacts", [], null),
      heldTopLevelCall(held, req.webSessionID, "allianceRegistry", "GetApplications", [], null),
      heldTopLevelCall(held, req.webSessionID, "allianceRegistry", "GetBulletins", [], null),
    ]);
    for (const outcome of [contacts, applications, bulletins]) {
      if (outcome.status === "rejected" && outcome.reason && outcome.reason.code === "SESSION_NOT_FOUND") {
        next(outcome.reason);
        return;
      }
    }
    const settledCode = (outcome) =>
      outcome.status === "rejected"
        ? String((outcome.reason && outcome.reason.code) || "READ_FAILED")
        : null;
    const settledValue = (outcome) =>
      outcome.status === "fulfilled" ? outcome.value.result : null;
    res.json({
      ok: true,
      contacts: settledValue(contacts),
      applications: settledValue(applications),
      bulletins: settledValue(bulletins),
      errors: {
        contacts: settledCode(contacts),
        applications: settledCode(applications),
        bulletins: settledCode(bulletins),
      },
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/bridge/alliance-bills — the SESSION alliance's FINANCIAL reads, as TWO
// independent reads (Promise.allSettled). Alliance financials, but only ever the
// caller's OWN alliance / corp (session-scoped; args ignored). ISK amounts + FILETIMEs
// kept bigint-safe as decimal strings in the decoder; ids stay data (R7d):
//   • GetBills -> a list of the alliance's OWED bills (billID/billTypeID/amount/
//       interest/debtorID/creditorID/dueDateTime FILETIME/paid/…).
//   • GetBillBalance -> the SESSION corp's wallet balance (a bare number) for its
//       default account key — what a "pay bill" flow would draw against. 0 when corp-less.
app.get("/api/bridge/alliance-bills", requireAuth, async (req, res, next) => {
  const held = requireHeldBridgeSession(req, res);
  if (!held) {
    return;
  }
  try {
    const [bills, balance] = await Promise.allSettled([
      heldTopLevelCall(held, req.webSessionID, "allianceRegistry", "GetBills", [], null),
      heldTopLevelCall(held, req.webSessionID, "allianceRegistry", "GetBillBalance", [], null),
    ]);
    for (const outcome of [bills, balance]) {
      if (outcome.status === "rejected" && outcome.reason && outcome.reason.code === "SESSION_NOT_FOUND") {
        next(outcome.reason);
        return;
      }
    }
    const settledCode = (outcome) =>
      outcome.status === "rejected"
        ? String((outcome.reason && outcome.reason.code) || "READ_FAILED")
        : null;
    const settledValue = (outcome) =>
      outcome.status === "fulfilled" ? outcome.value.result : null;
    res.json({
      ok: true,
      bills: settledValue(bills),
      balance: settledValue(balance),
      errors: {
        bills: settledCode(bills),
        balance: settledCode(balance),
      },
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/bridge/alliance-sovereignty — the SESSION alliance's SOVEREIGNTY-CONFIG
// reads, as TWO independent reads (Promise.allSettled). Session-scoped; args ignored:
//   • GetCapitalSystemInfo -> KeyVal(currentCapitalSystem / newCapitalSystem /
//       newCapitalSystemValidAfter FILETIME) — the capital-system transition state.
//   • GetPrimeTimeInfo -> KeyVal(currentPrimeHour / newPrimeHour /
//       newPrimeHourValidAfter FILETIME) — the sovereignty prime-hour (small int).
app.get("/api/bridge/alliance-sovereignty", requireAuth, async (req, res, next) => {
  const held = requireHeldBridgeSession(req, res);
  if (!held) {
    return;
  }
  try {
    const [capital, prime] = await Promise.allSettled([
      heldTopLevelCall(held, req.webSessionID, "allianceRegistry", "GetCapitalSystemInfo", [], null),
      heldTopLevelCall(held, req.webSessionID, "allianceRegistry", "GetPrimeTimeInfo", [], null),
    ]);
    for (const outcome of [capital, prime]) {
      if (outcome.status === "rejected" && outcome.reason && outcome.reason.code === "SESSION_NOT_FOUND") {
        next(outcome.reason);
        return;
      }
    }
    const settledCode = (outcome) =>
      outcome.status === "rejected"
        ? String((outcome.reason && outcome.reason.code) || "READ_FAILED")
        : null;
    const settledValue = (outcome) =>
      outcome.status === "fulfilled" ? outcome.value.result : null;
    res.json({
      ok: true,
      capital: settledValue(capital),
      prime: settledValue(prime),
      errors: {
        capital: settledCode(capital),
        prime: settledCode(prime),
      },
    });
  } catch (error) {
    next(error);
  }
});

// --- R63 plumbing sweep: structure directory reads (no UI) -------------------

// A structure becomes a selectable destination only after this pilot's
// access-filtered directory lists it. Never search the operational directory.
function structureIDsFromList(result) {
  if (!result || result.type !== "list" || !Array.isArray(result.items)) {
    throw Object.assign(new Error("Structure access authority is unreadable."),
      { code: "STRUCTURE_ACCESS_UNREADABLE", statusCode: 503 });
  }
  return [...new Set(result.items.map(Number).filter((id) => Number.isSafeInteger(id) && isPlayerStructureID(id)))];
}
function structureServiceIDsFromList(result) {
  if (!result || result.type !== "list" || !Array.isArray(result.items)) {
    throw Object.assign(new Error("Structure service authority is unreadable."),
      { code: "STRUCTURE_SERVICE_UNREADABLE", statusCode: 503 });
  }
  return [...new Set(result.items.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))];
}

// Standalone Training searches by an explicitly account-owned character. The
// read is stateless: it never selects or claims a cockpit. Live travel and
// writes still recheck access on their actual held pilot.
async function dockableAccessCall(req, method, args, characterID = 0) {
  const held = bridgeSessions.get(req.webSessionID);
  if (!characterID && held) return heldTopLevelCall(held, req.webSessionID, "structureDirectory", method, args, null);
  if (!Number.isSafeInteger(characterID) || characterID <= 0) {
    throw Object.assign(new Error("Choose an authenticated pilot to check structure access."),
      { code: "STRUCTURE_PILOT_REQUIRED", statusCode: 409 });
  }
  const character = await store.getCharacterForAccount(req.account.accountID, characterID);
  if (!character) throw Object.assign(new Error("The selected pilot is not owned by this account."),
    { code: "STRUCTURE_PILOT_UNAVAILABLE", statusCode: 403 });
  return gateway.callMethod("structureDirectory", method, args, null, {
    userid: req.account.accountID, characterID,
    corporationID: character.corporationID || 0, corpid: character.corporationID || 0,
    allianceID: character.allianceID || 0,
  });
}

async function accessibleStructureMatches(req, query, characterID = 0) {
  const listed = await dockableAccessCall(req, "GetMyDockableStructures", [0], characterID);
  const ids = structureIDsFromList(listed.result);
  if (ids.length > 200) throw Object.assign(new Error("Too many accessible structures to search safely."),
    { code: "STRUCTURE_SEARCH_LIMIT", statusCode: 409 });
  const matches = [];
  for (let offset = 0; offset < ids.length; offset += STRUCTURE_NAME_LOOKUP_CAP) {
    const batch = ids.slice(offset, offset + STRUCTURE_NAME_LOOKUP_CAP);
    const { records, failed } = await resolveRuntimeStructureNames(req, batch, { publicWithoutHeld: true });
    if (failed.size) throw Object.assign(new Error("Accessible structure names could not be read."),
      { code: "STRUCTURE_SEARCH_UNREADABLE", statusCode: 503 });
    for (const id of batch) {
      const record = records.get(id);
      if (!record?.name || !record.solarSystemID || !record.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())) continue;
      matches.push({ id, kind: "structure", name: record.name, solarSystemID: record.solarSystemID,
        solarSystemName: staticData.getSolarSystemName(record.solarSystemID) });
    }
  }
  return matches.sort((a, b) => a.name.localeCompare(b.name)).slice(0, 25);
}

/**
 * structures/services.py ONLINE_SERVICES_UNRESTRICTED_ACCESS: what a structure does for anyone docked in it,
 * whatever its services say: its docking, which is its hangars, and its fitting.
 */
const STRUCTURE_SERVICES_OF_ANY_GUEST = new Set([1, 2]);
/** structures.SERVICE_INDUSTRY, which stands for any of a structure's industry services (INDUSTRY_SERVICES). */
const STRUCTURE_SERVICE_INDUSTRY = 20;
const STRUCTURE_INDUSTRY_SERVICES = new Set([20, 21, 22, 23, 24, 30, 31, 32, 33, 34, 40, 41, 42, 43]);

/** The services a dict of them names (structureSettings.CharacterGetServices: each service's ID to what it charges). */
function structureServiceIDsFromDict(result) {
  const entries = result && result.type === "dict" && Array.isArray(result.entries) ? result.entries : null;
  const ids = entries === null ? null : entries.map((entry) => (Array.isArray(entry) ? entry[0] : null));
  if (ids === null || ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    throw Object.assign(new Error("Structure service authority is unreadable."),
      { code: "STRUCTURE_SERVICE_UNREADABLE", statusCode: 503 });
  }
  return new Set(ids);
}

/** Whether a held pilot is on the game port, where the server answers it as it answers a retail client. */
const heldOnTheGamePort = (held) => Boolean(gamePortPilots) && isGamePortHandle(held.bridgeSessionID);

/**
 * A structure's services for the held pilot: the server's own answer to
 * structureSettings.CharacterGetServices(structureID), which the retail client's structure services service asks as
 * its pilot docks in a structure and keeps (structureServices.py), and the pilot's transport asks and keeps so.
 *
 * ⚠ ON THE GAME PORT ONLY, which who asks this sees to. The stock web gateway's list has nothing of the structure
 * settings', so through the gateway there is no such answer and what stands on one is refused, deliberately
 * (docs/stock-evejs-integration-policy.md; stockCompatibility.js). On the game port the BFF is a client of the
 * original protocol, and asks what a client asks.
 */
async function structureServicesOnline(held, webSessionID, structureID) {
  const answered = await heldTopLevelCall(held, webSessionID, "structureSettings", "CharacterGetServices", [structureID], null);
  return structureServiceIDsFromDict(answered.result);
}

/**
 * Whether the structure a pilot is docked in has a service for it by the services the server answered, as the
 * client holds it (structureServices.IsServiceAvailableForCharacter, 42 to 45): a service that is among them, and
 * industry where any industry service is. (Its docking and its fitting it has whatever they say, 38: who asks
 * this sees to those two.)
 */
function structureServiceHeld(serviceID, online) {
  return online.has(serviceID) ||
    (serviceID === STRUCTURE_SERVICE_INDUSTRY && [...online].some((id) => STRUCTURE_INDUSTRY_SERVICES.has(id)));
}

/** Every service the structure a pilot is docked in has for it: the two it has for anyone, and each that structureServiceHeld says; in the order of their IDs. */
function structureServicesHeld(online) {
  return [...new Set([...STRUCTURE_SERVICES_OF_ANY_GUEST, ...online, ...(structureServiceHeld(STRUCTURE_SERVICE_INDUSTRY, online) ? [STRUCTURE_SERVICE_INDUSTRY] : [])])]
    .sort((left, right) => left - right);
}

/**
 * The BFF's own check that the structure a pilot is docked in has a service for it, before a route goes on:
 * 409 STRUCTURE_SERVICE_UNAVAILABLE where it has not. (`structureID` is the held pilot's own, which every caller
 * hands in.) On the game port it is held as the client holds it (structureServiceHeld), and nothing is asked for
 * a service a structure has for anyone docked in it. Through the web gateway it is refused whatever the service
 * (structureServicesOnline says why).
 */
async function assertStructureService(held, webSessionID, structureID, serviceID) {
  if (!heldOnTheGamePort(held)) require("./stockCompatibility").structureServices();
  if (STRUCTURE_SERVICES_OF_ANY_GUEST.has(serviceID)) return;
  if (!structureServiceHeld(serviceID, await structureServicesOnline(held, webSessionID, structureID))) {
    throw Object.assign(new Error("The required structure service is unavailable."),
      { code: "STRUCTURE_SERVICE_UNAVAILABLE", statusCode: 409 });
  }
}

async function operationStructureAccessCall(req, method, args, characterID = 0) {
  const held = bridgeSessions.get(req.webSessionID);
  if (!characterID && held) return heldTopLevelCall(held, req.webSessionID, "structureDirectory", method, args, null);
  if (!Number.isSafeInteger(characterID) || characterID <= 0) throw Object.assign(
    new Error("Choose an account pilot to check structure access."), { code: "STRUCTURE_PILOT_REQUIRED", statusCode: 409 });
  const character = await store.getCharacterForAccount(req.account.accountID, characterID);
  if (!character) throw Object.assign(new Error("The selected pilot does not belong to this account."),
    { code: "STRUCTURE_PILOT_UNAVAILABLE", statusCode: 403 });
  return gateway.callMethod("structureDirectory", method, args, null, {
    userid: req.account.accountID, characterID, corporationID: character.corporationID || 0,
    corpid: character.corporationID || 0, allianceID: character.allianceID || 0,
  });
}

app.get("/api/dockable-structures/find", requireAuth, async (req, res, next) => {
  try {
    const q = String(req.query.q || "").trim().slice(0, 120);
    const characterID = Number(req.query.characterID || 0);
    if (q.length < 2) { res.json({ ok: true, matches: [] }); return; }
    const listed = await operationStructureAccessCall(req, "GetMyDockableStructures", [0], characterID);
    const ids = structureIDsFromList(listed.result);
    if (ids.length > 200) throw Object.assign(new Error("Too many accessible structures to search safely."),
      { code: "STRUCTURE_SEARCH_LIMIT", statusCode: 409 });
    const matches = [];
    for (let start = 0; start < ids.length; start += STRUCTURE_NAME_LOOKUP_CAP) {
      const group = ids.slice(start, start + STRUCTURE_NAME_LOOKUP_CAP);
      const { records, failed } = await resolveRuntimeStructureNames(req, group, { publicWithoutHeld: characterID > 0 });
      if (failed.size) throw Object.assign(new Error("Accessible structure names could not be read."),
        { code: "STRUCTURE_SEARCH_UNREADABLE", statusCode: 503 });
      for (const id of group) {
        const record = records.get(id);
        if (!record?.name || !record.solarSystemID || !record.name.toLocaleLowerCase().includes(q.toLocaleLowerCase())) continue;
        matches.push({ kind: "structure", id, name: record.name, solarSystemID: record.solarSystemID,
          solarSystemName: staticData.getSolarSystemName(record.solarSystemID) });
      }
    }
    res.json({ ok: true, matches: matches.sort((a, b) => a.name.localeCompare(b.name)).slice(0, 25) });
  } catch (error) { next(error); }
});

app.get("/api/dockable-structures/pilots", requireAuth, async (req, res, next) => {
  try {
    const characters = await store.listCharactersForAccount(req.account.accountID);
    res.json({ ok: true, pilots: characters.filter(row => row.accountID === req.account.accountID)
      .map(row => ({ characterID: row.characterID, characterName: row.characterName })) });
  } catch (error) { next(error); }
});

app.get("/api/dockable-structures/:id", requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!isPlayerStructureID(id)) { res.status(400).json({ ok: false, error: "INVALID_STRUCTURE" }); return; }
    const characterID = Number(req.query.characterID || 0);
    const checked = await operationStructureAccessCall(req, "CheckMyDockingAccessToStructures", [[id]], characterID);
    if (!structureIDsFromList(checked.result).includes(id)) {
      res.status(409).json({ ok: false, error: "STRUCTURE_DOCK_ACCESS_DENIED" }); return;
    }
    const { records, failed } = await resolveRuntimeStructureNames(req, [id], { publicWithoutHeld: characterID > 0 });
    const record = records.get(id);
    if (failed.has(id) || !record?.name || !record.solarSystemID) {
      res.status(409).json({ ok: false, error: "STRUCTURE_UNRESOLVED" }); return;
    }
    res.json({ ok: true, location: { kind: "structure", id, name: record.name,
      solarSystemID: record.solarSystemID, solarSystemName: staticData.getSolarSystemName(record.solarSystemID) } });
  } catch (error) { next(error); }
});

app.get("/api/dockable-structures/:id/services", requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!isPlayerStructureID(id)) { res.status(400).json({ ok: false, error: "INVALID_STRUCTURE" }); return; }
    const characterID = Number(req.query.characterID || 0);
    // The held pilot's own structure, on the game port: the services it has for the pilot, as the client's service
    // has them of the structure it is docked in, with nothing else asked (the pilot is docked there).
    const held = characterID ? null : bridgeSessions.get(req.webSessionID);
    if (held && held.structureID === id && heldOnTheGamePort(held)) {
      res.json({ ok: true, structureID: id, serviceIDs: structureServicesHeld(await structureServicesOnline(held, req.webSessionID, id)) });
      return;
    }
    const checked = await operationStructureAccessCall(req, "CheckMyDockingAccessToStructures", [[id]], characterID);
    if (!structureIDsFromList(checked.result).includes(id)) {
      res.status(409).json({ ok: false, error: "STRUCTURE_DOCK_ACCESS_DENIED" }); return;
    }
    require("./stockCompatibility").structureServices();
  } catch (error) { next(error); }
});

// --- R66 plumbing sweep: pvp-info READS (bounties / wars / killmail) — no UI
// Its read routes, made for no screen of the page's, went on 2026-10-14 (the loop's item 64): nothing asked them.

// --- R68 plumbing sweep: map / starmap READS (the whole map read set) — no UI
// Its read routes, made for no screen of the page's, went on 2026-10-14 (the loop's item 64): nothing asked them.

// --- R69 plumbing sweep: in-space info-service READS (sov / ESS / pvp-filament /
// Its read routes, made for no screen of the page's, went on 2026-10-14 (the loop's item 64): nothing asked them.

// --- R70 plumbing sweep: character / account / support READS (no UI)
// Its read routes, made for no screen of the page's, went on 2026-10-14 (the loop's item 64): nothing asked them.

// --- R7 Local + Corp chat ---------------------------------------------------
// The browser reads a channel's member roster + recent messages and sends
// messages to Local or Corp on the held session. The BFF holds the connection
// server-side (never in browser JS); the browser addresses channels by name
// only. Wire contract: docs/bridge-wire-contract.md.
//
// ⚠ THE TRANSPORT CHANGED UNDER THESE ROUTES, THEIR SHAPE DID NOT. Until EveJS
// v0.12.8 both routes proxied `POST /_evejs-web/v1/chat/read|send`, which read
// the server's backlog store. That drop deleted those routes, deleted
// `runtime.readChat`/`sendChat` and `gatewayServices/webChatGatewayService.js`,
// and marked every browser-backed session as having left Local
// (`session._localChatDeparted = true`). The reads began answering 404 on every
// companion tick and every chat-ordered behaviour went silently dead.
//
// They are now served by an XMPP client (`src/evejsXmppChat.js`) speaking to the
// same stub server the retail client speaks to, joined as the held character.
// The response envelope is unchanged, so `web/src/bridge/chat.ts`, the Chat
// panel and the fleet companion's order rung all read exactly what they read
// before.
//
// Two honest differences from the backlog-store era:
//   • `notifications` is always empty. The old route drained the gateway's
//     capture buffer as a side effect of asking it for chat; this transport
//     never touches the gateway, and every other bridge call still drains.
//   • READ returns what was said WHILE THIS SESSION WAS LISTENING, plus (for
//     Corp) the join-time backlog the room replays. Local has no history in
//     retail and the stub matches it, so a Local read right after connecting is
//     empty until somebody speaks. The old store-backed read could answer with
//     lines from before the browser existed.

const CHAT_CHANNELS = new Set(["local", "corp"]);

/**
 * The held session's chat connection, opened on first use.
 *
 * ⚠ THE CHARACTER ID COMES OFF THE HELD SESSION AND NOWHERE ELSE. The stub
 * authenticates SASL PLAIN without checking the secret — the JID's local part IS
 * the identity — so the only thing standing between this BFF and impersonating
 * an arbitrary pilot in Local is that this line reads `held.characterID`. It
 * must never take an id from a request.
 */
function heldChatSession(held) {
  if (!held.chat) {
    // ⚠ FROM THE INJECTED GATEWAY CLIENT, NOT IMPORTED DIRECTLY, and that is
    // load-bearing rather than tidy. Chat is a second port on the same EveJS
    // process, so it belongs to the same injected dependency as every other
    // call to that server — which means an app built with a FAKE gateway (every
    // test but the chat one) has no chat at all and cannot open a socket to
    // whatever happens to be listening on the real 5222. Importing the client
    // here instead made a character select in any unrelated test connect to the
    // live game server and put a phantom pilot in somebody's Local.
    if (typeof gateway.createChatSession !== "function") {
      return null;
    }
    held.chat = gateway.createChatSession({
      characterID: held.characterID,
      log: (line) => console.log(line),
      login: heldChatLogin(held),
    });
  }
  return held.chat;
}

/**
 * What a pilot on the game port asks the game server as its chat logs in, the
 * way the retail client's chat service asks it (xmppchatclient/xmppchatsvc.py
 * 247 to 368): the chat's hostname and the server's address, the secret, and
 * the system channels to join. Each is a call on the pilot's own game-port
 * session, made when the chat connection wants it.
 *
 * Null for a pilot on the gateway: it has no such session to ask, and its chat
 * comes in as it always has.
 */
function heldChatLogin(held) {
  const onGamePort = Boolean(gamePortPilots) && isGamePortHandle(held.bridgeSessionID);
  if (!onGamePort || typeof gamePortPilots.chatConnection !== "function") {
    return null;
  }
  const whose = () => [{ userid: held.accountID }, held.bridgeSessionID];
  return {
    connection: () => gamePortPilots.chatConnection(...whose()),
    secret: () => gamePortPilots.chatSecret(...whose()),
    channels: () => gamePortPilots.chatChannels(...whose()),
    // The domains banned in chat, for the client's spam check of each line
    // (chatutil/spam.py 21 to 24).
    taboos: () =>
      (typeof gamePortPilots.chatTaboos === "function" ? gamePortPilots.chatTaboos(...whose()) : []),
    // The session's changes, at which the client's chat service leaves the
    // channels of what changed (xmppchatsvc.py 149 to 164).
    onSessionChange: (listener) =>
      (typeof gamePortPilots.chatSessionChanges === "function"
        ? gamePortPilots.chatSessionChanges(listener, ...whose())
        : () => {}),
  };
}

/** The error a chat route answers with when this app has no chat transport. */
function chatUnavailable(res) {
  res.status(503).json({
    ok: false,
    error: "CHAT_NOT_AVAILABLE",
    message: "This server has no chat transport configured.",
  });
}

/**
 * Put this character in its chat rooms, the way a retail client does at login.
 *
 * ⚠ EAGER, NOT LAZY, AND THAT IS A CORRECTION. The first cut opened the chat
 * connection on the first chat READ, reasoning that a session nobody reads chat
 * for should not appear in anyone's Local. That is not how a pilot works: the
 * retail client connects and joins Local and Corp in the same breath as
 * selecting a character (its own login is two `<presence to='local_…'>` /
 * `to='corp_…'` stanzas about a hundred milliseconds after the bind), and a
 * character who is online but in no room is a pilot nobody in the system can
 * see or talk to. Worse for this project's own purpose: nothing read chat until
 * a companion was actually RUNNING, so an idle-but-online companion could not
 * even be addressed.
 *
 * ⚠ NEVER FAILS THE CALLER. A chat server that is down must not stop a
 * character coming online — this is fire-and-forget by design, and a read is
 * still the thing that reports the failure to whoever asked for chat.
 */
function joinHeldChat(held) {
  const chat = heldChatSession(held);
  if (chat === null) {
    return;
  }
  const context = { solarSystemID: Number(held.solarSystemID) || 0 };
  for (const channel of ["local", "corp"]) {
    chat
      .ensureChannel(channel, context)
      .catch((error) => {
        console.warn(
          `[chat] ${channel} join failed for character ${held.characterID}: ${error.message}`,
        );
      });
  }
}

/**
 * Keep an ALREADY-CONNECTED session in the right rooms as its pilot moves.
 *
 * Called from the flight-status read, which is the one call every session makes
 * continuously and the place `held.solarSystemID` is kept current. Retail's own
 * auto-move (`chatHub.moveLocalSession`) rides on `sendSessionChange`, a capture
 * stub for a browser-backed session, so without this a pilot that jumps keeps
 * listening to the system it left.
 *
 * ⚠ SILENT, AND ONLY FOR A SESSION THAT ALREADY HAS A CONNECTION. It runs on
 * every poll, so it must neither open a connection for a session that never
 * wanted one nor log a line each time a down chat server stays down. The client
 * throttles its own reconnects; the read route is where a failure is reported.
 */
function followHeldChat(held) {
  if (!held.chat) {
    return;
  }
  const context = { solarSystemID: Number(held.solarSystemID) || 0 };
  for (const channel of ["local", "corp"]) {
    held.chat.ensureChannel(channel, context).catch(() => {});
  }
}

function chatContext(held, req) {
  return {
    // The system the held session is in RIGHT NOW, kept current by every
    // flight-status read. Used only to notice that this pilot has MOVED — the
    // room itself is resolved server-side from the session, so nothing here
    // computes a room name. See ensureChannel in src/evejsXmppChat.js.
    solarSystemID: Number(held.solarSystemID) || 0,
    limit: Number(req.query?.limit) || undefined,
  };
}

function normalizeChatChannel(res, value) {
  const channel = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!CHAT_CHANNELS.has(channel)) {
    res.status(400).json({
      ok: false,
      error: "INVALID_CHANNEL",
      message: "channel must be 'local' or 'corp'.",
    });
    return null;
  }
  return channel;
}

app.get("/api/bridge/chat/:channel", requireAuth, async (req, res, next) => {
  const held = requireHeldBridgeSession(req, res);
  if (!held) {
    return;
  }
  const channel = normalizeChatChannel(res, req.params.channel);
  if (!channel) {
    return;
  }
  const session = heldChatSession(held);
  if (session === null) {
    chatUnavailable(res);
    return;
  }
  try {
    const chat = await session.read(channel, chatContext(held, req));
    res.json({ ok: true, chat, notifications: [] });
  } catch (error) {
    next(error);
  }
});

app.post("/api/bridge/chat/:channel/send", requireAuth, async (req, res, next) => {
  const held = requireHeldBridgeSession(req, res);
  if (!held) {
    return;
  }
  const channel = normalizeChatChannel(res, req.params.channel);
  if (!channel) {
    return;
  }
  const message = typeof req.body?.message === "string" ? req.body.message : "";
  if (!message.trim()) {
    res.status(400).json({
      ok: false,
      error: "EMPTY_MESSAGE",
      message: "message must be a non-empty string.",
    });
    return;
  }
  const session = heldChatSession(held);
  if (session === null) {
    chatUnavailable(res);
    return;
  }
  try {
    const chat = await session.send(channel, message, chatContext(held, req));
    res.json({ ok: true, chat, notifications: [] });
  } catch (error) {
    next(error);
  }
});

// R5a flight (manually-stepped space movement): undock -> warp -> jump -> dock,
// each an explicit step the browser issues (no timer loop — the autopilot
// decide-loop is R5b). EveJS's space handlers stay authoritative for every
// move; the BFF only relays the atomic calls the retail client's client-side
// autopilot issues, holding the beyonce bound handle server-side. Movement
// refusals (scrambled, invalid target, docking-approach, lost control, ship
// destroyed) pass through as the handler's own CALL_REFUSED message so the page
// can surface a real reason — never a silent no-op or a fake success.

// beyonce remote park moniker: Moniker('beyonce', solarSystemID) via
// michelle.GetRemotePark(). Keyed by system so a jump (which changes the
// system) rebinds the park for the new system rather than reusing a stale OID.
const BEYONCE_BIND_GROUP = 5;
/**
 * Whether the throttle is opened before a follow or an orbit is sent:
 * beyonce.CmdSetSpeedFraction(1.0) on the ballpark's object first.
 *
 * The retail client's autopilot opens it before its own approach, which is the
 * one with no range (autopilot.py: CmdSetSpeedFraction(1.0), then
 * CmdFollowBall(id, 0.0)). Its menu's approach, keep at range and orbit send the
 * one command and nothing before it (movementFunctions.py), and are recorded so
 * on Tranquility. On the game port the BFF sends what the client sends. Through
 * the gateway each of them opens the throttle first, as it always has.
 */
function throttleOpenedFirst(held, theAutopilotsOwn) {
  const onGamePort = Boolean(gamePortPilots) && isGamePortHandle(held.bridgeSessionID);
  return !onGamePort || theAutopilotsOwn;
}

/**
 * Whether an approach, keep at range or orbit is one the retail client's menu
 * would not send: the ship is flying it already
 * (movementFunctions._IsAlreadyFollowingBallAtRange). Only the pilot's own
 * ballpark can say, so only a game-port pilot's transport is asked
 * (pilots.js alreadyFollowing). Through the gateway the order is always sent.
 */
function alreadyFlying(held, method, targetID, range) {
  if (!gamePortPilots || !isGamePortHandle(held.bridgeSessionID) || typeof gamePortPilots.alreadyFollowing !== "function") return false;
  return gamePortPilots.alreadyFollowing(held.bridgeSessionID, { userid: held.accountID }, method, targetID, range) === true;
}
/** What a route answers for an order that was held back, in place of the call's outcome. */
const HELD_BACK = Object.freeze({ result: null, notifications: Object.freeze([]) });

/**
 * A follow or an orbit the page asks for its pilot (bridgeCallPolicy.js, PAGE_FOLLOW_CALLS), made as the
 * approach's, the keep at range's and the orbit's routes make them: not sent where the ship already flies it,
 * which only a game-port pilot's own ballpark can say; and through the gateway with the throttle opened first.
 * Answered as the call that was asked, with what came of both.
 *
 * The follow with no range is the autopilot's. It is sent whatever the ship is doing, and its throttle is the
 * page's to open, as the client's autopilot opens its own: nothing is added to it here.
 */
async function followCall(held, webSessionID, method, args, kwargs) {
  const [targetID, range] = args;
  if (method === "CmdFollowBall" && range === 0) return heldTopLevelCall(held, webSessionID, "beyonce", method, args, kwargs);
  if (alreadyFlying(held, method, targetID, range)) return HELD_BACK;
  const opened = throttleOpenedFirst(held, false)
    ? await heldTopLevelCall(held, webSessionID, "beyonce", "CmdSetSpeedFraction", [1.0], null)
    : HELD_BACK;
  const made = await heldTopLevelCall(held, webSessionID, "beyonce", method, args, kwargs);
  return { ...made, notifications: [...opened.notifications, ...made.notifications] };
}

/**
 * Why a warp is none the client's menus make, or null where it is one: by the ledger's own judge of the call
 * (retailCalls.js, warping), asked with nothing known of the session. Keywords are given by name, or not at all.
 */
function notAClientsWarp(args, kwargs) {
  if (kwargs !== null && (typeof kwargs !== "object" || Array.isArray(kwargs))) return "A warp's keywords are given by name.";
  const warp = retailForm("beyonce", "CmdWarpToStuff", args, kwargs, {});
  return warp.status === "differs" ? warp.note : null;
}

function parkBindSpec(solarSystemID) {
  return {
    key: `park:${solarSystemID}`,
    service: "beyonce",
    method: "MachoBindObject",
    args: [[Number(solarSystemID), BEYONCE_BIND_GROUP]],
    kwargs: null,
  };
}

/**
 * Re-park beyonce the moment a session change lands, for the system we ARRIVED
 * in — eagerly, instead of waiting for whatever flight command happens next.
 *
 * ⚠ WHY THIS EXISTS: THREE SHIPS. On stargate arrival EveJS clears the
 * session's `beyonceBound` and then waits for the CLIENT to re-bind before it
 * will send the ship any destiny (movement) state — a 480 x 25 ms wait, so
 * about twelve seconds, after which it force-runs a ballpark bootstrap. Nothing
 * server-side ever sets that flag; only an inbound `beyonce` bind or `Cmd*`
 * does. Until one arrives the hull is INERT: it holds the spot it was spawned
 * on and will not answer a movement order.
 *
 * The trap is that nothing else is affected. Lock, launch drones, engage — all
 * are acknowledged with `ok: true` from a session that cannot move, and
 * `/space/snapshot` and `/session/flight-status` read live SCENE truth, so they
 * come back byte-identical to a healthy arrival. A bot has no way to notice. On
 * 2026-09-09/10 three ships arrived on a gate, fought a spawn from a standstill
 * believing they were fine, and only healed the bind at the moment they finally
 * tried to flee — which is the same moment they died. Every one of the three
 * binds landed within a second of the ship's first movement order.
 *
 * Binding is not a movement order and has no effect the player can see; it only
 * restores what the jump took away. `awaitRouteTransition` has just emptied
 * `boundHandles`, so this mints a fresh park for the NEW system rather than
 * reusing the origin's stale OID.
 *
 * ⚠ NEVER LOAD-BEARING. A jump that arrived has arrived. If the re-park fails
 * we are exactly where we were before this function existed — the next flight
 * command binds lazily — so the failure is logged and swallowed, never returned.
 */
/**
 * The retry schedule, in milliseconds BEFORE each attempt. Four tries inside
 * about 1.7 s.
 *
 * ⚠ THE CEILING IS NOT NEGOTIABLE, AND IT IS NOT THE CLIENT'S. The real client
 * gives its ballpark thirty seconds (michelle.py `WaitForBallpark`, 30 tries at
 * 1 s) because it is waiting on a LOCAL object. We are racing a REMOTE deadline:
 * EveJS waits roughly twelve seconds for a bind and then force-runs the ballpark
 * bootstrap itself, which sets `initialStateSent`. A bind that lands after that
 * gets no state — so a late re-park is not a slow success, it is a failure that
 * looks like one. Everything here must finish with room to spare inside that
 * window, which is why the schedule is short and why it must stay short.
 */
const REPARK_BACKOFF_MS = [0, 200, 500, 1000];

/** A bind cannot be retried into a session that no longer exists. */
function isDeadSessionError(error) {
  const code = error && typeof error === "object" ? String(error.code || "") : "";
  return code === "SESSION_NOT_FOUND" || code === "NO_LIVE_SESSION";
}

async function reparkAfterArrival(held, solarSystemID) {
  const system = Number(solarSystemID);
  if (!Number.isSafeInteger(system) || system <= 0 || !held.boundHandles) {
    return;
  }
  const spec = parkBindSpec(system);
  const sleep = typeof options.transitionSleep === "function"
    ? options.transitionSleep
    : (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  for (let attempt = 0; attempt < REPARK_BACKOFF_MS.length; attempt += 1) {
    if (REPARK_BACKOFF_MS[attempt] > 0) {
      await sleep(REPARK_BACKOFF_MS[attempt]);
    }
    const bindPromise = gateway
      .bindObject(spec.service, spec.method, spec.args, spec.kwargs, { userid: held.accountID }, held.bridgeSessionID)
      .then((bound) => bound.boundHandle)
      .catch((error) => {
        // Never leave a failed bind cached, or the next flight command reuses a
        // promise that is already rejected.
        if (held.boundHandles.get(spec.key) === bindPromise) {
          held.boundHandles.delete(spec.key);
        }
        throw error;
      });
    held.boundHandles.set(spec.key, bindPromise);
    try {
      await bindPromise;
      return;
    } catch (error) {
      if (isDeadSessionError(error)) {
        return; // nothing to re-park into; the route's own error path owns this
      }
      if (attempt === REPARK_BACKOFF_MS.length - 1) {
        // ⚠ SAY IT. Giving up here is not harmless: it drops the session back to
        // binding lazily on the next flight command, which is the exact
        // behaviour that left three ships inert on a gate. The run continues —
        // a jump that arrived has arrived — but this line is the only warning
        // anyone gets, so it names the system and the count the way the client
        // does when its own ballpark never came good.
        console.warn(
          `[repark] gave up re-parking beyonce in ${system} after ${REPARK_BACKOFF_MS.length} attempts;` +
            ` the ship will not receive destiny state until its next flight command: ${error && error.message}`,
        );
      }
    }
  }
}

// Read the held session's current flight status (location + ship movement
// state). A lost persistent session drops the held session (the page returns to
// character select), as with every held call.
async function readHeldFlight(held, webSessionID, { adoptShip = false } = {}) {
  try {
    assertCurrentHeldSession(held, webSessionID);
    // The epoch this read is asked under: a read from before a transition says nothing of the ship after it.
    const epochAtRead = Number(held.transitionEpoch) || 0;
    const outcome = await gateway.readFlightStatus(held.bridgeSessionID, {
      userid: held.accountID,
    });
    assertCurrentHeldSession(held, webSessionID);
    // Keep the held session's station in sync with the character's LIVE
    // position. held.stationID is otherwise set only at select, so after the
    // ship docks somewhere new (e.g. an autopilot arrival) the station-scoped
    // reads (agents, inventory bind) would still target the select-time station
    // until a full re-login. Adopt a real docked station here; leave the last
    // station in place while in space (agents/inventory are docked-only). The
    // active ship is a boarding's to change by its own postcondition; a ship the
    // server changed by itself (one destroyed, and the pilot in a capsule) is
    // adopted below, for the flight status's own route alone.
    // The roles the session has in its corporation, where the transport says them (the game port does, as the
    // digits of session.corprole; the gateway does not). Kept here for the routes that go by them, and left out
    // of what the page is handed.
    const { corpRole = null, corporationID, ...flight } = outcome && outcome.flight ? outcome.flight : {};
    held.corpRole = corpRole;
    // The corporation the session is in now, where the transport says it (the game port does, the gateway does
    // not). held.corporationID is otherwise set only at select, so after the pilot joins, leaves or founds a
    // corporation the routes that go by it (the offices' rent, a contract's corporation, the corporation's
    // wallet) would go by the select-time corporation until a full re-login. Left out of what the page is handed.
    if (corporationID !== undefined) held.corporationID = Number(corporationID) || null;
    if (flight.docked === true && Number(flight.stationID) > 0) {
      held.stationID = Number(flight.stationID);
      held.structureID = null;
      held.dockedLocationID = held.stationID;
    } else if (flight.docked === true && isPlayerStructureID(Number(flight.structureID))) {
      held.stationID = null;
      held.structureID = Number(flight.structureID);
      held.dockedLocationID = held.structureID;
    } else if (flight.docked !== true) {
      held.dockedLocationID = null;
      held.structureID = null;
    } else {
      // A docked status without either authoritative location is unknown, not
      // permission to reuse the previously held hangar after a transition.
      held.stationID = null;
      held.structureID = null;
      held.dockedLocationID = null;
    }
    // The solar system the character is in RIGHT NOW. Tracked here because
    // R15's industry deliver/cancel take it as an argument
    // (CompleteJob(jobID, solarSystemID)), and it is otherwise unavailable to a
    // route that never touches the space runtime.
    if (Number(flight.solarSystemID) > 0) {
      held.solarSystemID = Number(flight.solarSystemID);
    }
    // The pilot's chat rooms follow the pilot. This is the one read every
    // session makes continuously, and the place the system id above is kept
    // current, so it is where a jump turns into a Local re-join — retail's own
    // auto-move never fires for a browser-backed session. See followHeldChat.
    followHeldChat(held);
    // A latched ("failed") transition is resolved by exactly this kind of
    // fresh authoritative read — the write either landed (adopt it) or never
    // took (release the latch). Every client polls flight status continuously,
    // so a session recovers within a poll cycle of the world settling instead
    // of demanding a character re-select.
    resolveFailedTransition(held, flight);
    // The ship the session is in, where the server changed it and no transition of ours did. Only the read the
    // page makes to learn where its pilot is adopts it: a route that reads the flight for a guard of its own
    // (the ship it was asked about is still the pilot's) must go on seeing the ship it was asked under, and
    // refuse. The page hears of the new ship and the new epoch from this read, and asks again by them.
    if (adoptShip) adoptObservedShip(held, flight, epochAtRead, routeTransitionNow());
    return {
      ...outcome,
      flight: {
        ...flight,
        transition: publicTransition(held),
      },
    };
  } catch (error) {
    if (error && error.code === "SESSION_NOT_FOUND") {
      forgetBridgeSession(webSessionID, held);
    }
    throw error;
  }
}

// A movement command that already SUCCEEDED must not be reported as a failure
// because the follow-up snapshot read aborted — the gateway is busiest right
// after a movement command, so the after-read is the piece most likely to time
// out. The answer degrades to the before-snapshot (one command stale; every
// client re-polls flight status within a couple of seconds) instead of a 502
// for a command the sim is already executing. A lost session still propagates.
async function readHeldFlightAfterCommand(held, webSessionID, before) {
  try {
    return await readHeldFlight(held, webSessionID);
  } catch (error) {
    if (error && error.code === "SESSION_NOT_FOUND") {
      throw error;
    }
    return {
      ...before,
      flight: { ...before.flight, transition: publicTransition(held) },
      notifications: [],
    };
  }
}

async function readHeldScanner(held, webSessionID) {
  try {
    const outcome = await gateway.readScannerState(held.bridgeSessionID, {
      userid: held.accountID,
    });
    return {
      ...outcome,
      scanner: outcome && outcome.scanner && typeof outcome.scanner === "object"
        ? outcome.scanner
        : {},
    };
  } catch (error) {
    if (error && error.code === "SESSION_NOT_FOUND") {
      forgetBridgeSession(webSessionID, held);
    }
    throw error;
  }
}

function routeTransitionNow() {
  return typeof options.transitionNow === "function" ? Number(options.transitionNow()) : Date.now();
}

function beginRouteTransition(res, held, kind, expected) {
  const begun = beginHeldTransition(held, kind, expected, routeTransitionNow());
  if (begun.ok) {
    return true;
  }
  res.status(409).json({
    ok: false,
    error: begun.code,
    message: begun.message,
    transition: begun.transition || publicTransition(held),
  });
  return false;
}

/**
 * Reserve the next session-changing command and wait out retail's advertised
 * next-mutation timer. Readiness and cooldown are intentionally separate: a
 * ship can already be usable while another dock/jump/board is not legal yet.
 * Only the latter waits here; ordinary warp/module/inventory calls continue
 * once the prior transition's authoritative readiness phase is `ready`.
 */
async function acquireRouteTransition(res, held, kind, expected, beforeBegin = null) {
  if (held.transition && held.transition.phase !== "ready") {
    return beginRouteTransition(res, held, kind, expected);
  }
  if (held.transitionReservation) {
    res.status(409).json({
      ok: false,
      error: "SESSION_CHANGE_IN_PROGRESS",
      message: `Another ${held.transitionReservation.kind} request is waiting for the session-change timer.`,
      transition: publicTransition(held),
    });
    return false;
  }

  const waitMs = Math.max(0, Number(held.cooldownUntilMs || 0) - routeTransitionNow());
  if (waitMs > 0) {
    const reservation = { kind, token: Symbol(kind) };
    held.transitionReservation = reservation;
    try {
      const sleep = typeof options.transitionSleep === "function"
        ? options.transitionSleep
        : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      await sleep(waitMs);
    } finally {
      if (held.transitionReservation === reservation) {
        held.transitionReservation = null;
      }
    }
  }
  if (beforeBegin) await beforeBegin();
  return beginRouteTransition(res, held, kind, expected);
}

/**
 * Wait for an issued session mutation to become USABLE, not for a guessed
 * delay. Space transitions require the destination snapshot's own ship (scene
 * + ego); dock/board require their authoritative location/ship postcondition.
 * A timeout is deliberately uncertain and remains latched, so no route can
 * repeat the write until the player reselects the character.
 */
async function awaitRouteTransition(held, webSessionID, kind, expected, overrides = {}) {
  let lastFlight = {};
  return waitForTransitionReady({
    held,
    kind,
    expected,
    latchOnTimeout: overrides.latchOnTimeout !== false,
    timeoutMs: Number(overrides.timeoutMs) || Number(options.transitionReadyTimeoutMs) || undefined,
    pollMs: Number(options.transitionPollMs) || undefined,
    sleep: options.transitionSleep,
    now: options.transitionNow,
    readFlight: async () => {
      const outcome = await readHeldFlight(held, webSessionID);
      lastFlight = outcome.flight || {};
      return outcome;
    },
    readSpace: async () => {
      if (typeof gateway.readSpaceSnapshot === "function") {
        return gateway.readSpaceSnapshot(held.bridgeSessionID, { userid: held.accountID });
      }
      // Test/minimal gateway compatibility only. Production always has the
      // stronger snapshot route; an older gateway can at least require the
      // authoritative flight location + ship rather than a fixed timer.
      return {
        space: {
          inSpace: lastFlight.inSpace === true,
          ship: lastFlight.inSpace === true && Number(lastFlight.shipID) > 0
            ? { itemID: Number(lastFlight.shipID) }
            : null,
        },
        notifications: [],
      };
    },
  });
}

function sendTransitionTimeout(res, outcome, commandNotifications = []) {
  res.status(504).json({
    ok: false,
    error: outcome.code || "TRANSITION_TIMEOUT",
    message: outcome.message || "The session change did not become ready in time. No command was repeated.",
    flight: outcome.flight || null,
    transition: outcome.transition || null,
    notifications: [...commandNotifications, ...(outcome.notifications || [])],
  });
}

// A dock the sim ACCEPTED seats within a couple of seconds in this emulator;
// this bounds how long the dock route watches for that before reading the
// 200/null answer as retail's silent decline and handing the decision back to
// the client's silent-dock ladder. Overridable via options.dockProbeTimeoutMs,
// and never longer than an injected transitionReadyTimeoutMs (the tests run on
// a virtual clock).
const DOCK_SILENT_DECLINE_PROBE_MS = 6_000;

// --- R13 flight-verb ranges -------------------------------------------------
// Every one of these is a DISTANCE IN METRES, never an identifier. The retail
// defaults: Approach 50 m (the menu form; the autopilot uses 0), Keep at range
// 1000 m floored at 50 m, Orbit 1000 m. The warp-range menu offers a fixed
// ladder, whose default is 0 — NOT 10 km.
const APPROACH_DEFAULT_RANGE_M = 50;
// A sane ceiling so a typo cannot send an absurd follow/orbit range: 1000 km,
// far beyond any sensible hold distance and well inside warp range.
const MAX_FOLLOW_RANGE_M = 1_000_000;
const WARP_RANGE_CHOICES_M = Object.freeze([0, 10000, 20000, 30000, 50000, 70000, 100000]);

/**
 * A follow/orbit range in metres: absent -> the caller's default, otherwise a
 * finite non-negative number clamped up to `floor` and bounded above. Returns
 * null for anything that is not a number at all (the route answers 400).
 */
function normalizeFollowRange(value, fallback, floor) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0 || numeric > MAX_FOLLOW_RANGE_M) {
    return null;
  }
  return Math.max(floor, numeric);
}

/** A warp range in metres: one of the offered choices, or null (400). */
function normalizeWarpRange(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  return WARP_RANGE_CHOICES_M.includes(numeric) ? numeric : null;
}

function requireInSpace(res, flight) {
  if (!flight || flight.inSpace !== true) {
    res.status(409).json({
      ok: false,
      error: "NOT_IN_SPACE",
      message: "The ship is not in space; undock first.",
    });
    return false;
  }
  return true;
}

// Current flight status snapshot for the page's status readout + "Refresh
// flight status" button.
app.get("/api/bridge/flight/status", requireAuth, async (req, res, next) => {
  const held = requireHeldBridgeSession(req, res);
  if (!held) {
    return;
  }
  try {
    const outcome = await readHeldFlight(held, req.webSessionID, { adoptShip: true });
    res.json({ ok: true, flight: outcome.flight, notifications: outcome.notifications });
  } catch (error) {
    next(error);
  }
});

// The refusal the retail client's undock catches and turns into a question
// (ui/station/base.py _DoUndockAttempt): the ship is carrying what the local
// law forbids. OK there undocks again with ignoreContraband set.
const CONTRABAND_WARNING_KEY = "ShipContrabandWarningUndock";

function isContrabandWarning(error) {
  if (!error || error.code !== "CALL_REFUSED") {
    return false;
  }
  // The game-port transport hands the refusal on by name; the gateway only words it.
  return (error.refusal && error.refusal.key === CONTRABAND_WARNING_KEY) ||
    String(error.message || "").includes(CONTRABAND_WARNING_KEY);
}

// What the warning says. The dialog has one parameter, item = (UE_TYPEID,
// typeID), which the client shows as the type's name. The game-port transport
// passes the refusal's values on; without them the item is not named, and
// nothing is made up.
//
// With a client to read, the words are the client's own body for this dialog
// (the dialog table, src/clientData/clientWords.js), its {item} filled in.
// Without one they are this client's.
const UE_TYPEID = 4;

function contrabandWarningWords(error) {
  const entries = error && error.refusal && error.refusal.values && Array.isArray(error.refusal.values.entries)
    ? error.refusal.values.entries
    : [];
  const item = entries.find((entry) => Array.isArray(entry) && entry[0] === "item");
  const typeID = item && Array.isArray(item[1]) && item[1][0] === UE_TYPEID && Number.isSafeInteger(item[1][1]) ? item[1][1] : null;
  const name = typeID === null ? null : staticData.getTypeName(typeID) || `type ${typeID}`;
  const dialog = clientWords.dialog(CONTRABAND_WARNING_KEY);
  const body = dialog && typeof dialog.body === "string" ? dialog.body : null;
  // Only the one tag the dialog is known to carry is filled; a body with any other is not used half-filled.
  // The client's markup goes first (a <br> is a new line, any other tag leaves its words), so that a name is
  // never read as markup.
  if (body !== null && name !== null && (body.match(/\{[^{}]*\}/g) || []).every((tag) => tag === "{item}")) {
    return body.replace(/<br\s*\/?>/gi, "\n").replace(/<\/?[A-Za-z][^<>]*>/g, "").replace(/\{item\}/g, () => name);
  }
  return `Your ship is carrying contraband${name === null ? "" : ` (${name})`}. Undock anyway?`;
}

// (The pilot undocks by the page's own call since 2026-10-14: ship.Undock(shipID, ignoreContraband,
// onlineModules=...) through the generic call, under the BFF's keeping of the session change, as the client's
// session manager makes it (bridgeCallPolicy.js, PAGE_PLACE_CHANGE_CALLS; dispatchPlaceChangeWrite, above;
// web/src/bridge/placeChanges.ts). A refusal for contraband is answered as the route answered it. The route,
// POST /api/bridge/flight/undock, is gone.)

// Warp to a chosen gate/celestial through the bound park.
//
// Two shapes, exactly as retail has two:
//   - no `minRange` in the body  -> beyonce.CmdWarpToStuffAutopilot(destID),
//     the autopilot's own warp (the browser decide-loop uses this one);
//   - `minRange` present         -> beyonce.CmdWarpToStuff("item", destID,
//     minRange=<metres>), the right-click "Warp to → within N km" menu (R13).
//     Retail's own default for that menu is 0, not 10 km.
// `minRange` is a KWARG; the subject string ("item") is positional.
app.post("/api/bridge/flight/warp", requireAuth, async (req, res, next) => {
  const held = requireHeldBridgeSession(req, res);
  if (!held) {
    return;
  }
  const destinationID = Number(req.body && req.body.destinationID) || 0;
  if (destinationID <= 0) {
    res.status(400).json({ ok: false, error: "INVALID_TARGET", message: "A positive destinationID is required." });
    return;
  }
  const rangedWarp = req.body && req.body.minRange !== undefined && req.body.minRange !== null;
  const minRange = rangedWarp ? normalizeWarpRange(req.body.minRange) : 0;
  if (rangedWarp && minRange === null) {
    res.status(400).json({
      ok: false,
      error: "INVALID_RANGE",
      message: "The warp range must be one of the offered distances.",
    });
    return;
  }
  try {
    const before = await readHeldFlight(held, req.webSessionID);
    if (!requireInSpace(res, before.flight)) {
      return;
    }
    const outcome = rangedWarp
      ? await boundCall(
          held,
          req.webSessionID,
          parkBindSpec(before.flight.solarSystemID),
          "CmdWarpToStuff",
          ["item", destinationID],
          { minRange },
        )
      : await boundCall(
          held,
          req.webSessionID,
          parkBindSpec(before.flight.solarSystemID),
          "CmdWarpToStuffAutopilot",
          [destinationID],
          null,
        );
    const after = await readHeldFlightAfterCommand(held, req.webSessionID, before);
    res.json({
      ok: true,
      result: outcome.result,
      flight: after.flight,
      notifications: [...outcome.notifications, ...after.notifications],
    });
  } catch (error) {
    next(error);
  }
});

// (The pilot jumps through a stargate by the page's own call since 2026-10-14: beyonce.CmdStargateJump(the gate,
// its far gate or none, the pilot's ship) through the generic call, under the BFF's keeping of the session change,
// the park bound again in the new system before the answer (dispatchPlaceChangeWrite, "stargate";
// bridgeCallPolicy.js, PAGE_PLACE_CHANGE_CALLS; web/src/bridge/placeChanges.ts). The route,
// POST /api/bridge/flight/jump, is gone.)

// A station and a player structure are docked at by the page's own calls since 2026-10-14, under the keeping of a
// dock (dispatchPlaceChangeWrite, "dock"; web/src/bridge/placeChanges.ts): the park's CmdDock(stationID, shipID) for a
// station, the structure's own structureDocking.Dock(structureID, shipID) for a structure (structureDocking.py 64 to
// 80), which through the gateway is asked as the park's CmdDock. The dock route (POST /api/bridge/flight/dock) is gone,
// and with it its check of a structure's docking access before the call: the server's handler checks it itself
// (structureDockingService.Handle_Dock), as the client goes by.

// Approach a gate/target:
// beyonce.CmdSetSpeedFraction(1.0) + CmdFollowBall(destinationID, range).
// On the game port the throttle is opened only before the autopilot's approach,
// the one with no range, as the client opens it (throttleOpenedFirst).
//
// R13: the range is no longer hardcoded to 0.0. Retail has TWO callers of this
// one method and they differ only in that number — the right-click "Approach"
// menu uses 50 m, and the autopilot's close-the-gap step uses 0.0. So the
// browser passes what it means: the Overview's Approach button sends the 50 m
// default, and the decide-loop sends 0. (Keep at range is the same method again
// at the player's chosen distance — see /flight/keep-at-range below.)
//
// An autopilot-warp lands the ship NEAR a gate but often outside jump range, so
// CmdStargateJump refuses NotWithinMaxJumpDist until the ship follows the gate
// into range. (Both methods were allowlisted in R5a; R13 adds no pair here.)
app.post("/api/bridge/flight/approach", requireAuth, async (req, res, next) => {
  const held = requireHeldBridgeSession(req, res);
  if (!held) {
    return;
  }
  const destinationID = Number(req.body && req.body.destinationID) || 0;
  if (destinationID <= 0) {
    res.status(400).json({ ok: false, error: "INVALID_TARGET", message: "A positive destinationID is required." });
    return;
  }
  const range = normalizeFollowRange(req.body && req.body.range, APPROACH_DEFAULT_RANGE_M, 0);
  if (range === null) {
    res.status(400).json({
      ok: false,
      error: "INVALID_RANGE",
      message: "The approach range must be a distance in metres.",
    });
    return;
  }
  try {
    const before = await readHeldFlight(held, req.webSessionID);
    if (!requireInSpace(res, before.flight)) {
      return;
    }
    const spec = parkBindSpec(before.flight.solarSystemID);
    // The autopilot's approach is sent whatever the ship is doing; the menu's is not sent twice. (An order held
    // back is the menu's on the game port, which opens no throttle either.)
    const alreadySo = range !== 0 && alreadyFlying(held, "CmdFollowBall", destinationID, range);
    if (throttleOpenedFirst(held, range === 0)) {
      await boundCall(held, req.webSessionID, spec, "CmdSetSpeedFraction", [1.0], null);
    }
    const outcome = alreadySo ? HELD_BACK : await boundCall(held, req.webSessionID, spec, "CmdFollowBall", [destinationID, range], null);
    const after = await readHeldFlightAfterCommand(held, req.webSessionID, before);
    res.json({
      ok: true,
      ...(alreadySo ? { alreadySo: true } : {}),
      result: outcome.result,
      flight: after.flight,
      notifications: [...outcome.notifications, ...after.notifications],
    });
  } catch (error) {
    next(error);
  }
});

// --- R103 WB-BEYONCE: the 7 Phase-4 BOUND nav/bookmark WRITES -----------------
//
// These ride the SAME beyonce remote-park bind (parkBindSpec(solarSystemID) —
// Moniker("beyonce", solarSystemID)) the R5a/R13 movement verbs use. The BFF
// reads the session's OWN live flight to recover the current solarSystemID, binds
// the park for that system, and dispatches each write as a BOUND method off that
// handle (mirroring the warp/jump/dock routes above). Every route is confirm-gated
// and requires the ship to be in space. FAST-MODE: none fired live (operator owns
// EveJS). Handlers return null / a bookmark id; the ack carries `result` through
// for a future nav/bookmark UI. Args are EDUCATED-GUESS from the handler shapes.
//
// ⚠ ARG-INJECTION: every handler resolves ship / scene / char from the SESSION
// (spaceRuntime.<op>(session, …) / fleetRuntime.<op>(session, …) / creatorID =
// session.characterID for the bookmark writers). CmdJumpThroughFleet takes a
// fleet-mate's (charID, shipID) but validates them against the SESSION's own fleet
// membership and looks up the bridge scoped to the session char — the legitimate
// cyno-jump mechanism, not a caller-forgeable foreign ship. No foreign-id write —
// no handoff-doc flag.

/**
 * Dispatch one confirm-gated BOUND beyonce write off the park bind. Reads the
 * session's live flight to bind the CURRENT solar system and require in-space;
 * a lost session drops the held session (page returns to character select).
 */
async function dispatchBoundBeyonceWrite(req, res, next, method, args, kwargs = null, transition = null) {
  const held = requireHeldBridgeSession(req, res);
  if (!held) {
    return;
  }
  try {
    const before = await readHeldFlight(held, req.webSessionID);
    if (!requireInSpace(res, before.flight)) {
      return;
    }
    if (method === "CmdGotoPoint" && req.body?.expectedShipID !== undefined
      && Number(req.body.expectedShipID) !== Number(before.flight.shipID)) {
      return res.status(409).json({ ok: false, error: "SHIP_CHANGED", message: "The observed movement ship changed." });
    }
    if (method === "CmdGotoPoint" && req.body?.expectedSolarSystemID !== undefined
      && Number(req.body.expectedSolarSystemID) !== Number(before.flight.solarSystemID)) {
      return res.status(409).json({ ok: false, error: "SYSTEM_CHANGED", message: "The measured movement system changed." });
    }
    const expected = transition
      ? {
          ...transition.expected,
          fromSolarSystemID: Number(before.flight.solarSystemID) || null,
          shipID: Number(before.flight.shipID) || Number(held.activeShipID) || null,
        }
      : null;
    if (transition && !await acquireRouteTransition(res, held, transition.kind, expected)) {
      return;
    }
    const outcome = await boundCall(
      held,
      req.webSessionID,
      parkBindSpec(before.flight.solarSystemID),
      method,
      args,
      kwargs,
    );
    if (transition) {
      markTransitionAccepted(held);
    }
    const after = transition
      ? await awaitRouteTransition(held, req.webSessionID, transition.kind, expected)
      : await readHeldFlight(held, req.webSessionID);
    if (transition && !after.ok) {
      sendTransitionTimeout(res, after, outcome.notifications);
      return;
    }
    res.json({
      ok: true,
      applied: true,
      result: outcome.result ?? null,
      flight: transition ? { ...after.flight, transition: after.transition } : after.flight,
      ...(transition ? { transition: after.transition } : {}),
      notifications: [...outcome.notifications, ...after.notifications],
    });
  } catch (error) {
    if (transition && held.transition && held.transition.kind === transition.kind) {
      if (held.transition.phase === "requested") {
        cancelHeldTransition(held);
      } else if (held.transition.phase !== "failed") {
        markTransitionFailed(held, error && error.message);
      }
    }
    if (error && error.code === "SESSION_NOT_FOUND") {
      forgetBridgeSession(req.webSessionID, held);
    }
    next(error);
  }
}

// CmdJumpThroughFleet(otherCharID, otherShipID, beaconID, solarSystemID) — jump
// through a fleet-mate's cyno bridge. Validated against the session's own fleet
// membership server-side (the (charID, shipID) name the bridge, not a foreign ship
// to hijack). Consumes bridge fuel + transitions the session to a new system.
app.post("/api/bridge/flight/jump-through-fleet", requireAuth, async (req, res, next) => {
  if (!requireWriteConfirmation(req, res, "This jumps your ship through that fleet bridge (changes system). Confirm to continue.")) {
    return;
  }
  const body = req.body || {};
  const otherCharID = Number(body.otherCharID) || 0;
  const otherShipID = Number(body.otherShipID) || 0;
  const beaconID = Number(body.beaconID) || 0;
  const solarSystemID = Number(body.solarSystemID) || 0;
  await dispatchBoundBeyonceWrite(
    req,
    res,
    next,
    "CmdJumpThroughFleet",
    [otherCharID, otherShipID, beaconID, solarSystemID],
    null,
    { kind: "stargate", expected: { toSolarSystemID: solarSystemID } },
  );
});

// --- R23 slice A: targeting + module activation -----------------------------
//
// THE GENERIC IN-SPACE ACTION LAYER. Everything below is deliberately free of
// any notion of mining, combat, salvaging or ewar: a target is a target, a
// module is a module, and the effect name is an ARGUMENT. R23 slice B drives a
// mining laser through these four routes; a later combat goal drives a turret
// through the same four routes with a different module and effect name and
// needs no new BFF surface, no new store slice and no new UI.
//
// If you find yourself about to add "mining" to a name in this section, don't.

/** A dogmaIM target list ({type:"list", items:[…]}) as plain itemIDs. */
function decodeTargetIDList(result) {
  const items =
    result && result.type === "list" && Array.isArray(result.items) ? result.items : [];
  return items
    .map((value) => Number(value && typeof value === "object" ? value.value : value) || 0)
    .filter((value) => value > 0);
}

/**
 * The itemIDs the server says are locked RIGHT NOW. The only authority.
 *
 * Through the gateway that is a call each time. On the game port the pilot's
 * transport answers it as the retail client's target service would: the list
 * the server gave on arriving in space, kept right by the server's own OnTarget
 * notices since (src/gamePort/pilotTargets.js). The server is still the only
 * authority; it is not asked again for what it has already said.
 */
async function readLockedTargetIDs(held, webSessionID) {
  const outcome = await heldTopLevelCall(held, webSessionID, "dogmaIM", "GetTargets", [], null);
  const raw = outcome.result;
  const readable = raw?.type === "list" && Array.isArray(raw.items) && raw.items.every(value => {
    const id = typeof value === "number" ? value : value?.type === "long" ? value.value : null;
    return (typeof id === "number" || typeof id === "string" && /^\d+$/.test(id)) &&
      Number.isSafeInteger(Number(id)) && Number(id) > 0;
  });
  return { ids: decodeTargetIDList(raw), readable, notifications: outcome.notifications };
}

/**
 * The ships that have the pilot's locked RIGHT NOW (dogmaIM.GetTargeters), asked straight after GetTargets as the
 * client's godma.RefreshTargets asks it (2364); the client keeps the answer as its target service's targetedBy, each
 * one OnTarget('otheradd'). On the game port it is answered from the list kept the same way.
 *
 * ⚠ A FAILURE IS UNREADABLE, NEVER A THROW. The lock list beside it is what the Targeting panel reads, and a page
 * must not lose that because this half could not answer.
 */
async function readTargeterIDs(held, webSessionID) {
  try {
    const outcome = await heldTopLevelCall(held, webSessionID, "dogmaIM", "GetTargeters", [], null);
    const raw = outcome.result;
    const readable = raw?.type === "list" && Array.isArray(raw.items);
    return { ids: decodeTargetIDList(raw), readable, notifications: outcome.notifications };
  } catch {
    return { ids: [], readable: false, notifications: [] };
  }
}

/**
 * Confirm the requested module, including an authoritative bank-master mapping.
 * Unrelated growth in the active set is not proof. Missing bank authority is
 * unknown rather than a guessed confirmation of a slave weapon.
 */
function activationLanded(_idsBefore, idsAfter, itemID, banks) {
  return require("./moduleActionEvidence").moduleActive(idsAfter, itemID, banks);
}

/**
 * The module itemIDs the server says are CYCLING right now, read from the space
 * snapshot's ship projection (which reads the ship entity's own active-effect
 * map). There is no separate retail call for this, and the browser must never
 * substitute its own memory of what it clicked.
 */
async function readActiveModuleIDs(held) {
  const outcome = await gateway.readSpaceSnapshot(held.bridgeSessionID, {
    userid: held.accountID,
  });
  const ship = outcome && outcome.space ? outcome.space.ship : null;
  const ids = ship && Array.isArray(ship.activeModuleIDs) ? ship.activeModuleIDs : null;
  return {
    // null (not []) when the snapshot could not answer at all, so the caller can
    // say "unknown" instead of "nothing is running".
    ids: ids === null ? null : ids.map((value) => Number(value) || 0).filter((v) => v > 0),
    banks: ship && ship.weaponBanks && typeof ship.weaponBanks === "object" ? ship.weaponBanks : null,
    notifications: outcome ? outcome.notifications : [],
  };
}

// What is locked right now. The page polls this alongside the space snapshot.
app.get("/api/bridge/targets", requireAuth, async (req, res, next) => {
  const held = requireHeldBridgeSession(req, res);
  if (!held) {
    return;
  }
  try {
    const locked = await readLockedTargetIDs(held, req.webSessionID);
    const targeters = await readTargeterIDs(held, req.webSessionID);
    // A malformed read cannot prove that the caller has no locked targets, nor that nothing has the caller locked.
    res.json({
      ok: true,
      targetIDs: locked.readable ? locked.ids : null,
      targeterIDs: targeters.readable ? targeters.ids : null,
      notifications: [...locked.notifications, ...targeters.notifications],
    });
  } catch (error) {
    next(error);
  }
});

// (A module is switched on and off by the page's own calls since 2026-10-14: dogmaIM.Activate(itemID, effectName,
// target, repeat) and Deactivate(itemID, effectName) through the generic call, as godma makes them (godma.py 2062
// and 2101), the module's default effect named from the game's data (GET /api/types/default-effects) and the
// running modules read after (the state route below, its cycle with the first reading after a stop)
// (bridgeCallPolicy.js, PAGE_WRITE_PAIR_KEYS; web/src/bridge/dogmaWrites.ts). The routes,
// POST /api/bridge/modules/activate and .../deactivate, are gone.)

// Post-dispatch observation only; this route never repeats Deactivate.
app.get("/api/bridge/modules/:itemID/state", requireAuth, async (req, res, next) => {
  const held = requireHeldBridgeSession(req, res);
  if (!held) return;
  try {
    const itemID = Number(req.params.itemID), shipID = Number(req.query.shipID);
    if (!Number.isSafeInteger(itemID) || itemID <= 0 || !Number.isSafeInteger(shipID) || shipID <= 0) {
      res.status(400).json({ ok: false, error: "INVALID_MODULE_SCOPE" }); return;
    }
    await readHeldFlight(held, req.webSessionID);
    if (held.activeShipID !== shipID) {
      res.status(409).json({ ok: false, error: "MODULE_SHIP_CHANGED" }); return;
    }
    const active = await readActiveModuleIDs(held);
    assertCurrentHeldSession(held, req.webSessionID);
    const landed = activationLanded(null, active.ids, itemID, active.banks);
    // The module's cycle, where it is still running and the caller asks (cycle=1): the length of the wait for a stop
    // that comes at the cycle's end, as the deactivate route read it, from the held module's own dogma.
    let cycleMs = null;
    if (landed === true && req.query.cycle === "1") {
      try {
        const { effectiveCycleMs } = require("./moduleShutdownBudget");
        const cycle = await boundCall(held, req.webSessionID, dogmaBindSpec(), "QueryAttributeValue", [itemID, 73], null);
        cycleMs = effectiveCycleMs(cycle.result);
      } catch {
        assertCurrentHeldSession(held, req.webSessionID);
        // An unreadable duration is unknown, never a static type's.
      }
    }
    res.json({ ok: true, itemID, shipID, stopped: landed === null ? null : !landed,
      activeModuleIDs: active.ids, cycleMs, notifications: active.notifications });
  } catch (error) { next(error); }
});

// --- R23 slice B: the mining loop -------------------------------------------
//
// mine -> haul -> refine -> sell. Note what is NOT here: there is no "start
// mining" route and no mining cycle. Mining a rock IS slice A's generic
// lock-then-activate with a mining laser's itemID, flying to the belt is R5a's
// warp and R13's orbit, and selling the minerals is R16's market. Slice B adds
// only what was genuinely missing — a place to see the ore, a way to get it
// home, the survey scanner, and the refinery.
//
// The BROWSER NEVER SIMULATES A CYCLE. It does not predict yield, it does not
// count down a rock, and it does not decide when a hold is full. It asks the
// server and shows the answer.

// The ore/gas/ice hold ladder (server-side flags 134/135/181/182), with the
// ship's ordinary cargo hold as the fallback the mining runtime itself falls
// back to. THESE NUMBERS NEVER LEAVE THIS FILE: the browser is handed a NAME
// per hold ("Ore hold", "Ice hold") and never a flagID (R7d / R9a).
//
// `attributeID` is the hull TYPE's capacity attribute for that hold, as the
// server pairs them (specialShipHoldRegistry.js): generalMiningHoldCapacity
// 1556, specialGasHoldCapacity 1557, specialIceHoldCapacity 3136,
// specialAsteroidHoldCapacity 3227. Cargo has none: every hull has one.
const MINING_HOLDS = Object.freeze([
  Object.freeze({ key: "ore", flag: 134, label: "Ore hold", attributeID: 1556 }),
  Object.freeze({ key: "gas", flag: 135, label: "Gas hold", attributeID: 1557 }),
  Object.freeze({ key: "ice", flag: 181, label: "Ice hold", attributeID: 3136 }),
  Object.freeze({ key: "asteroid", flag: 182, label: "Asteroid hold", attributeID: 3227 }),
  // The fallback: a hull with no specialised hold mines straight into cargo,
  // so a miner flying a frigate must still be able to see and unload the ore.
  Object.freeze({ key: "cargo", flag: ITEM_FLAG_CARGO_HOLD, label: "Cargo hold", attributeID: null }),
]);

// Which of the mining holds a hull HAS is written on its type, and the retail
// client never asks the server: its inventory tree adds a hold node only when
// the ship type's capacity attribute for it is non-zero (inventory/treeData.py,
// GetChildren). Fitting can resize a hold but cannot give a hull one its type
// lacks, so a hold the type does not carry is absent without a read. A type
// the static data does not know (or no type at all) answers null: the caller
// then reads the whole ladder, exactly as it did before it could tell.
function miningHoldsCarriedByHull(shipTypeID) {
  const typeID = Number(shipTypeID) || 0;
  if (typeID <= 0 || typeof staticData.getTypeDogma !== "function" || !staticData.getTypeDogma(typeID)) {
    return null;
  }
  return new Set(MINING_HOLDS
    .filter((hold) => hold.attributeID === null ||
      Number(staticData.getTypeDogmaAttribute(typeID, hold.attributeID, 0)) > 0)
    .map((hold) => hold.key));
}

/** A util.KeyVal capacity reading ({capacity, used}) as plain numbers, or null. */
function decodeCapacityReading(result) {
  const entries =
    result && result.args && Array.isArray(result.args.entries) ? result.args.entries : [];
  const read = (key) => {
    const entry = entries.find((pair) => Array.isArray(pair) && pair[0] === key);
    const value = entry ? entry[1] : undefined;
    const numeric = Number(value && typeof value === "object" ? value.value : value);
    return Number.isFinite(numeric) ? numeric : null;
  };
  const capacity = read("capacity");
  const used = read("used");
  return capacity === null && used === null ? null : { capacity, used };
}

/**
 * One hold's capacity as the retail client reckons it (shipHoldsAsTheClient):
 * its size by godma or the type, and what is used of it summed from its own
 * List. Where either cannot be had, the server is asked, as before.
 */
async function reckonedHoldCapacity(own, flag, listed, asked) {
  const size = await own.capacity(flag);
  if (size === null) return asked();
  let answer;
  try {
    answer = await listed;
  } catch {
    return asked();
  }
  const used = usedOfListed(answer.result, flag, own.packaged);
  return used === null ? asked() : { result: capacityAnswer(Number(size), used) };
}

/**
 * Which of the mining holds a ship carries, and (on the game port) its holds as the client knows them. A hold the
 * hull's type does not carry is not read: it answers what the server would (nothing in it, no capacity), and costs
 * the server nothing. The hull's type only counts when flight status names THIS ship; the gateway reports a null
 * type while a ship change is still settling, and every hold is then read.
 */
async function miningHoldsOfShip(held, webSessionID, shipID, status) {
  const flight = (status && status.flight) || {};
  const carried = Number(flight.shipID) === Number(shipID) ? miningHoldsCarriedByHull(flight.shipTypeID) : null;
  const own = await shipHoldsAsTheClient(held, webSessionID, Number(shipID));
  return { own, carries: (hold) => (own ? own.has(hold.flag) !== false : carried === null || carried.has(hold.key)) };
}

// Read the ship's mining holds. Every hold in the ladder is read independently
// (Promise.allSettled) so one that the hull does not have — or one whose read
// fails — never blanks the rest, and a hold that answers nothing at all is
// simply reported as absent rather than as an empty hold.
app.get("/api/bridge/ship/ore-hold", requireAuth, async (req, res, next) => {
  const held = requireHeldBridgeSession(req, res);
  if (!held) {
    return;
  }
  try {
    const status = await readHeldFlight(held, req.webSessionID);
    const shipID = held.activeShipID;
    if (!shipID) {
      res.status(409).json({ ok: false, error: "NO_ACTIVE_SHIP", message: "No active ship." });
      return;
    }
    const spec = cargoBindSpec(held, shipID);
    // ⚠ THE RETAIL CLIENT NEVER ASKS HOW FULL A HOLD IS (invCache.py 1224,
    // godma.py 871). On the game port a hold's capacity is reckoned as the
    // client reckons it, and the server is asked for the hold's List alone.
    const { own, carries } = await miningHoldsOfShip(held, req.webSessionID, shipID, status);
    const settled = await Promise.allSettled(
      MINING_HOLDS.flatMap((hold) => {
        if (!carries(hold)) return [null, null];
        const listed = boundCall(held, req.webSessionID, spec, "List", [hold.flag], null);
        const asked = () => boundCall(held, req.webSessionID, spec, "GetCapacity", [hold.flag], null);
        return [listed, own ? reckonedHoldCapacity(own, hold.flag, listed, asked) : asked()];
      }),
    );
    for (const entry of settled) {
      if (entry.status === "rejected" && entry.reason && entry.reason.code === "SESSION_NOT_FOUND") {
        next(entry.reason);
        return;
      }
    }
    const holds = MINING_HOLDS.map((hold, index) => {
      const listed = settled[index * 2];
      const capacity = settled[index * 2 + 1];
      // R7d: the shared row decoder carries flagID and locationID, and NEITHER
      // may reach the browser — the whole point of naming the holds here is
      // that the page never learns 134 exists. Only what a player reads about
      // a stack survives: what it is, and how much of it there is.
      if (listed.status === "fulfilled" && listed.value === null) {
        return { key: hold.key, label: hold.label, items: [], capacity: { capacity: 0, used: 0 }, present: false, error: null };
      }
      const rows =
        listed.status === "fulfilled"
          ? decodeInventoryRows(listed.value.result).map((row) => ({
              itemID: row.itemID,
              typeID: row.typeID,
              // WHAT KIND OF THING IT IS — the same two fields /bays publishes,
              // and for the same reason: a stack's category is part of what a
              // player reads about it, not wire detail like flagID. Without
              // them a bot delivering out of the CARGO fallback (a hull with no
              // specialised hold mines straight into cargo) cannot tell the ore
              // it just mined from the mining crystals stowed beside it, and so
              // shipped the crystals ashore with the ore every lap.
              groupID: row.groupID,
              categoryID: row.categoryID,
              quantity: row.quantity,
            }))
          : null;
      const reading =
        capacity.status === "fulfilled" ? decodeCapacityReading(capacity.value.result) : null;
      return {
        // A NAME, never a flag number. The browser has no idea 134 exists.
        key: hold.key,
        label: hold.label,
        // null (not []) when the read failed: "we could not look" is not the
        // same as "the hold is empty", and the page says which.
        items: rows,
        capacity: reading,
        // A hull without this hold answers a zero capacity; say so plainly so
        // the page can leave it out instead of showing an empty 0 / 0 bar.
        present: reading !== null && Number(reading.capacity) > 0,
        error:
          listed.status === "rejected"
            ? String((listed.reason && listed.reason.code) || "READ_FAILED")
            : capacity.status === "rejected"
              ? String((capacity.reason && capacity.reason.code) || "READ_FAILED")
              : null,
      };
    });
    res.json({ ok: true, activeShipID: shipID, stationID: held.stationID, holds });
  } catch (error) {
    next(error);
  }
});

// Unload mined ore into the station hangar. This is R3's invbroker.Add in the
// unfit direction: the DESTINATION (the hangar) is the bound object and the ship
// is the source location — no new server method at all.
//
// Docked-only, because there is nowhere else for it to go.
//
// ── `division` (optional, 1-7): deliver into the CORPORATION hangar instead ──
// Same call, a different bound object and a division flag — which is exactly
// why it belongs here rather than in a route of its own: the proof that the ore
// left the ship is the holds re-read below, and that read does not care where
// the ore went.
//
// THE FALLBACK IS THE POINT. A corporation deposit can be refused for reasons
// the browser cannot see and must not try to predict: no office at this station
// any more, no role for that division, an impounded office. Every one of those
// ends the same way — the load goes into the pilot's OWN hangar, at the station
// they already flew to, and the answer says so. A hauler that stalls with a full
// hold because a role changed is worse than one that lands the ore somewhere
// recoverable, and "somewhere recoverable" is never the corporation's side:
// ore put into a division belongs to the corporation and needs a take role to
// get back, while ore in the pilot's hangar is still theirs.
//
// The fallback is judged by the RE-READ, never by the absence of a throw. A
// division Add that raises may still have moved the item (the same reason the
// transfer route remembers its dispatch error instead of rethrowing it), so
// what is retried into the hangar is what the holds say is still aboard.
app.post("/api/bridge/ship/ore-hold/unload", requireAuth, async (req, res, next) => {
  const held = requireHeldBridgeSession(req, res);
  if (!held) {
    return;
  }
  const body = req.body || {};
  const requested = Array.isArray(body.itemIDs)
    ? body.itemIDs.map((value) => Number(value) || 0).filter((value) => value > 0)
    : [];
  // Absent (or null) means the personal hangar, which is every existing caller.
  // A division that is not one of the seven is a bug in the caller, not a
  // silently-ignored preference: it is refused rather than turned into a
  // personal-hangar unload the script never asked for.
  const wantsDivision = body.division !== undefined && body.division !== null;
  const strictCorp = body.strictCorp === true;
  const division = wantsDivision ? Number(body.division) : 0;
  if (strictCorp && !wantsDivision) {
    res.status(400).json({ ok: false, error: "STRICT_CORP_DIVISION_REQUIRED" });
    return;
  }
  if (wantsDivision && !isValidDivision(division)) {
    res.status(400).json({
      ok: false,
      error: "INVALID_DIVISION",
      message: "A corporation hangar division is required.",
    });
    return;
  }
  if (requested.length === 0) {
    res.status(400).json({
      ok: false,
      error: "NOTHING_SELECTED",
      message: "Choose what to unload first.",
    });
    return;
  }
  try {
    const before = await readHeldFlight(held, req.webSessionID);
    if (!before.flight || before.flight.docked !== true) {
      res.status(409).json({
        ok: false,
        error: "NOT_DOCKED",
        message: "Dock at a station before unloading.",
      });
      return;
    }
    const unloadLocationID = await assertDockedInventoryAccess(held, req.webSessionID, wantsDivision ? 3 : 1);
    if (strictCorp) {
      const association = botHost.operationForClaim?.(held.characterID, req.get(botHostModule.BOT_HEADER));
      const definition = association && miningOperations.definition(association.operationID);
      const intended = [definition?.unloadDestination, definition?.policies?.parking]
        .find(row => row && Number(row.corporationDivision) === division &&
          Number(row.kind === "structure" ? row.id : row.destination?.kind === "structure" ? row.destination.id : row.stationID ?? row.destination?.stationID) === unloadLocationID);
      if (!intended || !Number.isSafeInteger(intended.corporationID) ||
          intended.corporationID !== Number(held.corporationID)) {
        res.status(409).json({ ok: false, error: "STRICT_CORP_DESTINATION_MISMATCH",
          message: "Operation, docked location, corporation and exact division must match before delivery." });
        return;
      }
    }
    const shipID = held.activeShipID;
    if (!shipID) {
      res.status(409).json({ ok: false, error: "NO_ACTIVE_SHIP", message: "No active ship." });
      return;
    }
    const hangarSpec = held.structureID
      ? { ...hangarBindSpec(held), expectedDockedLocationID: unloadLocationID } : hangarBindSpec(held);
    const notifications = [];

    // A 200 is not proof — invbroker can decline a move silently. The answer is
    // what the HOLDS say afterwards: anything still sitting in a mining hold
    // did not move, and is named as such rather than assumed moved.
    const spec = cargoBindSpec(held, shipID);
    const readStillHeld = async () => {
      const stillHeld = new Set();
      for (const hold of MINING_HOLDS) {
        try {
          const listed = await boundCall(held, req.webSessionID, spec, "List", [hold.flag], null);
          for (const row of decodeInventoryRows(listed.result)) {
            stillHeld.add(row.itemID);
          }
        } catch {
          // A hold that cannot be re-read leaves its items unverified; they are
          // reported as not-moved rather than silently counted as moved.
        }
      }
      return stillHeld;
    };
    const addAll = async (itemIDs, destinationSpec, flag) => {
      let refusal = null;
      for (const itemID of itemIDs) {
        try {
          const outcome = await boundCall(
            held,
            req.webSessionID,
            destinationSpec,
            "Add",
            [itemID, shipID],
            { flag },
          );
          notifications.push(...outcome.notifications);
        } catch (error) {
          // Remembered, not rethrown: the re-read decides. Raising here would
          // abandon the rest of the load — and on the corporation branch it
          // would skip the fallback that is the whole point of this route.
          refusal = refusal ?? error;
        }
      }
      return refusal;
    };

    // Which hangar this load is FOR. A division with no office at this station
    // never even attempts the corporation Add — there is nothing to bind.
    let officeID = 0;
    let fellBack = null;
    if (wantsDivision) {
      try {
        officeID = await readCorpOffice(held, req.webSessionID);
      } catch (error) {
        officeID = 0;
        fellBack = String((error && error.code) || "READ_FAILED");
      }
      if (!officeID && fellBack === null) {
        fellBack = "NO_CORP_OFFICE";
      }
    }

    if (strictCorp) {
      if (!officeID) {
        res.status(409).json({ ok: false, error: "CORP_OFFICE_UNAVAILABLE", message: fellBack || "Exact corporation office unavailable." });
        return;
      }
      const officeSpec = held.structureID
        ? { ...corpOfficeBindSpec(officeID), expectedDockedLocationID: unloadLocationID }
        : corpOfficeBindSpec(officeID);
      const readSource = async () => {
        const rows = [];
        for (const hold of MINING_HOLDS) {
          const listed = await boundCall(held, req.webSessionID, spec, "List", [hold.flag], null);
          rows.push(...decodeInventoryRows(listed.result));
        }
        return rows;
      };
      const readDivision = async () => decodeInventoryRows((await boundCall(
        held, req.webSessionID, officeSpec, "List", [corpDivisionFlag(division)], null)).result);
      const sourceBefore = await readSource();
      const destinationBefore = await readDivision();
      const selected = requested.map(itemID => sourceBefore.find(row => row.itemID === itemID));
      if (selected.some(row => !row || !Number.isSafeInteger(row.quantity) || row.quantity <= 0)) {
        res.status(409).json({ ok: false, error: "FREIGHT_SOURCE_UNVERIFIED", message: "Requested freight is not authoritatively present in the mining holds." });
        return;
      }
      await addAll(requested, officeSpec, corpDivisionFlag(division));
      let sourceAfter, destinationAfter;
      try {
        sourceAfter = await readSource();
        destinationAfter = await readDivision();
      } catch {
        res.status(409).json({ ok: false, error: "CORP_TRANSFER_UNCONFIRMED", message: "Transfer was issued; inventories could not be reread. Reconcile before retrying." });
        return;
      }
      const expectedByType = new Map();
      for (const row of selected) expectedByType.set(row.typeID, (expectedByType.get(row.typeID) || 0) + row.quantity);
      const total = (rows, typeID) => rows.filter(row => row.typeID === typeID).reduce((sum, row) => sum + row.quantity, 0);
      const exact = selected.every(row => !sourceAfter.some(after => after.itemID === row.itemID)) &&
        [...expectedByType].every(([typeID, qty]) =>
          total(sourceBefore, typeID) - total(sourceAfter, typeID) === qty &&
          total(destinationAfter, typeID) - total(destinationBefore, typeID) === qty);
      if (!exact) {
        res.status(409).json({ ok: false, error: "CORP_TRANSFER_UNCONFIRMED",
          message: "Exact source loss and corporation-division gain did not match; no personal fallback was attempted. Reconcile before retrying." });
        return;
      }
      res.json({ ok: true, requested, moved: requested, remaining: [], corpDivision: division,
        movedToCorp: requested, fellBack: null, notifications });
      return;
    }

    let deliveredToCorp = [];
    let stillHeld;
    if (officeID) {
      const officeSpec = held.structureID
        ? { ...corpOfficeBindSpec(officeID), expectedDockedLocationID: unloadLocationID }
        : corpOfficeBindSpec(officeID);
      const refusal = await addAll(requested, officeSpec, corpDivisionFlag(division));
      stillHeld = await readStillHeld();
      deliveredToCorp = requested.filter((itemID) => !stillHeld.has(itemID));
      const stranded = requested.filter((itemID) => stillHeld.has(itemID));
      if (stranded.length > 0) {
        // Whatever the corporation would not take goes into the pilot's own
        // hangar. The reason is the refusal the server gave, when it gave one:
        // a role the character lacks answers CrpAccessDenied, and that is worth
        // repeating to the player verbatim rather than flattening to "refused".
        // The MESSAGE, not the transport code. A refused bound call arrives as
        // code "CALL_REFUSED" with the server's own word in the message
        // ("CrpAccessDenied" for a role the character does not hold), and
        // "CALL_REFUSED" on its own tells a player nothing. Untranslated on
        // purpose, exactly as the other refusal passthroughs are: the browser
        // owns the wording.
        fellBack = (refusal && refusal.message) || (refusal && refusal.code) || "CORP_REFUSED";
        await addAll(stranded, hangarSpec, ITEM_FLAG_HANGAR);
        stillHeld = await readStillHeld();
      }
    } else {
      await addAll(requested, hangarSpec, ITEM_FLAG_HANGAR);
      stillHeld = await readStillHeld();
    }

    const moved = requested.filter((itemID) => !stillHeld.has(itemID));
    const movedToCorp = moved.filter((itemID) => deliveredToCorp.includes(itemID));
    res.json({
      ok: true,
      requested,
      moved,
      remaining: requested.filter((itemID) => stillHeld.has(itemID)),
      // WHERE THE LOAD ACTUALLY WENT, which is not always where it was aimed.
      // `corpDivision` is the division that took something (null when nothing
      // did), and `fellBack` names why the rest did not — so a caller can say
      // "it went in your own hangar because you lack the role" instead of
      // reporting a clean delivery to a hangar nobody will check.
      corpDivision: movedToCorp.length > 0 ? division : null,
      movedToCorp,
      fellBack,
      notifications,
    });
  } catch (error) {
    next(error);
  }
});

// --- R40 ship bays ---------------------------------------------------------
//
// EVERY bay a hull can have, by NAME. A "bay" is nothing but an inventory FLAG
// on the ship's own inventory — exactly the mechanism R12 fitting uses for slot
// flags — so enumerating a hull's bays is one GetCapacity per candidate flag.
//
// WHY THIS ROUTE EXISTS AT ALL (the client-first rule). Bound-object calls are
// BFF-only: /api/bridge/call is a TOP-LEVEL proxy and cannot dispatch on a
// bound handle, so the browser physically cannot run the bind-then-List
// two-step. The existing routes each read a fixed slice and none of them
// answers "what bays does THIS ship have": /ship/ore-hold covers the four
// mining holds plus cargo and only for the ACTIVE ship; /drones covers the
// drone bay, again active-ship only; /inventory/container/:itemID binds an
// arbitrary itemID but calls List/GetCapacity with NO flag, which answers for
// one unnamed default hold and can never enumerate the rest. A ship sitting in
// the hangar that the player has not boarded is unreadable today.
//
// It adds NO eve.js allowlist pairs. GetInventoryFromId (the bind), ListByFlags
// and GetCapacity are all ALREADY allowlisted (evejsWebGatewayRuntime.js) and
// already driven from this file — GetInventoryFromId by containerBindSpec,
// GetCapacity by /api/bridge/inventory, ListByFlags by /api/bridge/drones. So
// no gateway restart is required and no new server surface is exposed.
//
// WHICH FLAGS. Only the flags eve.js actually MAPS to a hull attribute are
// asked about. That is not fussiness: _calculateCapacity initialises capacity
// to 1000000.0 and returns it untouched when no branch matches, so asking about
// an unmapped flag (151 specialized material bay, for instance) yields a
// phantom 1,000,000 m³ bay on every hull in the game. Asking only about mapped
// flags means a capacity of 0 always means "this hull has no such bay".
//
// The browser is handed a key and a LABEL per bay by the routes, never a flag
// (R7d/R9a). Since 2026-10-14 the page holds the same values itself, the
// client's own read from its compiled constants, for its own calls that move a
// thing into a bay (web/src/bridge/inventoryWrites.ts, BAY_FLAGS).
const SHIP_BAYS = Object.freeze([
  Object.freeze({ key: "cargo", flag: ITEM_FLAG_CARGO_HOLD, label: "Cargo hold" }),
  // The same flag ITEM_FLAG_DRONE_BAY names for /api/bridge/drones; spelled out
  // here because that constant is declared further down this file and a const
  // cannot be read before its declaration is evaluated.
  Object.freeze({ key: "drone", flag: 87, label: "Drone bay" }),
  Object.freeze({ key: "shipMaintenance", flag: 90, label: "Ship maintenance bay" }),
  Object.freeze({ key: "fuel", flag: 133, label: "Fuel bay" }),
  Object.freeze({ key: "ore", flag: 134, label: "Ore hold" }),
  Object.freeze({ key: "gas", flag: 135, label: "Gas hold" }),
  Object.freeze({ key: "mineral", flag: 136, label: "Mineral hold" }),
  Object.freeze({ key: "salvage", flag: 137, label: "Salvage hold" }),
  Object.freeze({ key: "ship", flag: 138, label: "Ship hold" }),
  Object.freeze({ key: "smallShip", flag: 139, label: "Small ship hold" }),
  Object.freeze({ key: "mediumShip", flag: 140, label: "Medium ship hold" }),
  Object.freeze({ key: "largeShip", flag: 141, label: "Large ship hold" }),
  Object.freeze({ key: "industrialShip", flag: 142, label: "Industrial ship hold" }),
  Object.freeze({ key: "ammo", flag: 143, label: "Ammo hold" }),
  Object.freeze({ key: "commandCenter", flag: 148, label: "Command center hold" }),
  Object.freeze({ key: "planetary", flag: 149, label: "Planetary commodities hold" }),
  Object.freeze({ key: "quafe", flag: 154, label: "Quafe bay" }),
  Object.freeze({ key: "fleet", flag: 155, label: "Fleet hangar" }),
  Object.freeze({ key: "fighter", flag: 158, label: "Fighter bay" }),
  Object.freeze({ key: "corpse", flag: 174, label: "Corpse bay" }),
  Object.freeze({ key: "booster", flag: 176, label: "Booster bay" }),
  Object.freeze({ key: "subsystem", flag: 177, label: "Subsystem bay" }),
  Object.freeze({ key: "ice", flag: 181, label: "Ice hold" }),
  Object.freeze({ key: "asteroid", flag: 182, label: "Asteroid hold" }),
  Object.freeze({ key: "mobileDepot", flag: 183, label: "Mobile depot hold" }),
  Object.freeze({ key: "colony", flag: 185, label: "Colony resources hold" }),
  Object.freeze({ key: "expedition", flag: 188, label: "Expedition hold" }),
]);

/** The type of a ship in the hangar the pilot is docked in, from the hangar's own list; 0 where it is not there. */
async function hangarShipTypeID(held, webSessionID, shipID) {
  let listed;
  try {
    listed = await boundCall(held, webSessionID, hangarBindSpec(held), "List", [ITEM_FLAG_HANGAR], null);
  } catch (error) {
    if (error && error.code === "SESSION_NOT_FOUND") throw error;
    return 0;
  }
  const row = decodeInventoryRows(listed.result).find((entry) => entry.itemID === shipID);
  return row ? row.typeID : 0;
}

/**
 * What it takes to know a ship's bays as the retail client knows them, or null
 * where that cannot be followed: off the game port, with no client to read its
 * tables from, with static tables that know no type's attributes, or for a
 * ship whose type cannot be found.
 *
 * ⚠ THE RETAIL CLIENT ASKS THE SERVER NONE OF THIS. Its inventory tree says
 * which bays a ship has from the ship's TYPE (treeData.py 300 to 363), and a
 * bay's size is godma's value of that bay's attribute for the ship being flown
 * (godma.py 871) and the type's own for any other, which its dogma has not
 * loaded (clientDogmaIM.GetCapacityForItem answers None; invCache.py 1268 on).
 * The ship being flown and its type are the transport's to say, from the
 * session and godma. A ship in the hangar has its type in the hangar's list,
 * which the client holds and this reads.
 */
async function shipHoldsAsTheClient(held, webSessionID, shipID) {
  if (!gamePortPilots || !isGamePortHandle(held.bridgeSessionID) || typeof gamePortPilots.ship !== "function") return null;
  if (typeof staticData.getTypeDogmaAttributeOrDefault !== "function") return null;
  const [holds, packaged] = await Promise.all([clientConstants.holdAttributes(), clientConstants.packagedVolumes()]);
  if (!holds || !packaged) return null;
  const sessionFields = { userid: held.accountID };
  const flown = await gamePortPilots.ship(sessionFields, held.bridgeSessionID);
  const active = Number(flown.shipID) === shipID;
  const typeID = active ? Number(flown.typeID) || 0 : await hangarShipTypeID(held, webSessionID, shipID);
  const type = typeID > 0 ? staticData.getType(typeID) : null;
  if (!type) return null;
  return {
    packaged,
    /** Whether the hull has the bay: true, false, or null for a flag the client's table has not. */
    has: (flag) => shipHasHold(flag, (attributeID) => staticData.getTypeDogmaAttribute(typeID, attributeID, null), Number(type.groupID), holds),
    /** How big the bay is, or null where neither godma nor the type says. */
    async capacity(flag) {
      const attributeID = holds.byFlag.get(flag);
      const live = active ? await gamePortPilots.shipAttribute(attributeID, sessionFields, held.bridgeSessionID) : null;
      if (live !== null) return live;
      // evetypes.GetCapacity for the cargo; a type's attribute, or the attribute's own default, for any other.
      const cargo = flag === holds.cargoFlag && type.capacity !== null && type.capacity !== undefined ? Number(type.capacity) : NaN;
      return Number.isFinite(cargo) ? cargo : staticData.getTypeDogmaAttributeOrDefault(typeID, attributeID, null);
    },
  };
}

// Which bays a ship has, what each one holds, and how full it is.
//
// ABSENT IS NOT EMPTY, AND NEITHER IS UNKNOWN. Three states cross the wire,
// because conflating them is the mistake worldHasNoContracts exists to prevent:
//   present === true   the hull HAS this bay (capacity > 0)
//   present === false  the hull does NOT have it (the server answered 0)
//   present === null   we could not tell — the capacity read itself FAILED
// A 200 on this route is not proof any individual bay was read.
app.get("/api/bridge/ship/:shipID/bays", requireAuth, async (req, res, next) => {
  const held = requireHeldBridgeSession(req, res);
  if (!held) {
    return;
  }
  const shipID = Number(req.params.shipID) || 0;
  if (shipID <= 0) {
    res.status(400).json({ ok: false, error: "INVALID_SHIP", message: "A ship is required." });
    return;
  }
  // ?keys=ore,mineral — read only these bays.
  //
  // ⚠ THIS IS A COST CONTROL, NOT A FILTER FOR TIDINESS. The full read costs one
  // GetCapacity per candidate flag — twenty-seven of them — which is fine once
  // for a panel and far too much for a bot that wants to know how much room the
  // ore hold has before it reaches into a can. Naming the two bays it cares
  // about turns that into two calls. An unknown or empty key list means the
  // whole enumeration, exactly as before.
  const requestedKeys = String(req.query.keys || "")
    .split(",")
    .map((key) => key.trim())
    .filter(Boolean);
  const wanted = requestedKeys.length > 0
    ? SHIP_BAYS.filter((bay) => requestedKeys.includes(bay.key))
    : SHIP_BAYS;
  if (requestedKeys.length > 0 && wanted.length === 0) {
    res.status(400).json({ ok: false, error: "INVALID_BAY", message: "No such ship bay." });
    return;
  }
  // The bind is the SAME call a container binds with — a ship's bays are just
  // its own inventory, so there is no ship-specific bind method.
  const spec = containerBindSpec(shipID);
  try {
    // A bay as the SERVER answers it: one capacity read for its flag. Each is
    // independent: a hull that refuses one bay must not blank the others.
    const asked = async (bay) => {
      let outcome;
      try {
        outcome = await boundCall(held, req.webSessionID, spec, "GetCapacity", [bay.flag], null);
      } catch (error) {
        if (error && error.code === "SESSION_NOT_FOUND") throw error;
        // Could not look. NOT "the hull lacks this bay".
        return { bay, capacity: null, present: null, error: String((error && error.code) || "READ_FAILED") };
      }
      const reading = decodeCapacityReading(outcome.result);
      if (reading === null || reading.capacity === null) {
        return { bay, capacity: reading, present: null, error: "NO_CAPACITY_REPORTED" };
      }
      return { bay, capacity: reading, present: Number(reading.capacity) > 0, error: null };
    };
    // A bay as the CLIENT knows it (shipHoldsAsTheClient): there or not by the
    // hull's type, its size by godma or the type. What is used of it comes with
    // its contents, below. A bay that cannot be known so is asked about.
    const own = await shipHoldsAsTheClient(held, req.webSessionID, shipID);
    const reckoned = async (bay) => {
      const has = own.has(bay.flag);
      if (has === null) return asked(bay);
      if (!has) return { bay, capacity: { capacity: 0, used: 0 }, present: false, error: null };
      const capacity = await own.capacity(bay.flag);
      if (capacity === null) return asked(bay);
      return { bay, capacity: { capacity: Number(capacity), used: null }, present: true, error: null, reckoned: true };
    };
    const readings = await Promise.all(wanted.map((bay) => (own ? reckoned(bay) : asked(bay))));

    // Contents come from ONE ListByFlags over just the bays that exist, rather
    // than a List per bay: the rows carry their own flagID, so a single read
    // fills every bay at once. An absent bay is never asked about.
    const presentReadings = readings.filter((entry) => entry.present === true);
    let byFlag = null;
    let listError = null;
    if (presentReadings.length > 0) {
      try {
        const listed = await boundCall(
          held,
          req.webSessionID,
          spec,
          "ListByFlags",
          [presentReadings.map((entry) => entry.bay.flag)],
          null,
        );
        // What is used of a bay the client's way: the volume of what this very list holds in its flag. A bay
        // with something in it whose volume is not known here has the server say how full it is.
        await Promise.all(readings.map(async (entry, index) => {
          if (!entry.reckoned) return;
          const used = usedOfListed(listed.result, entry.bay.flag, own.packaged);
          if (used === null) readings[index] = await asked(entry.bay);
          else entry.capacity.used = used;
        }));
        byFlag = new Map(presentReadings.map((entry) => [entry.bay.flag, []]));
        for (const row of decodeInventoryRows(listed.result)) {
          const bucket = byFlag.get(row.flagID);
          if (bucket) {
            // R7d: flagID and locationID are wire detail and must NOT reach the
            // browser. Only what a player reads about a stack survives — what
            // it is, how much of it there is, and enough to name and act on it.
            bucket.push({
              itemID: row.itemID,
              typeID: row.typeID,
              groupID: row.groupID,
              categoryID: row.categoryID,
              quantity: row.quantity,
              singleton: row.singleton,
            });
          }
        }
      } catch (error) {
        if (error && error.code === "SESSION_NOT_FOUND") {
          next(error);
          return;
        }
        listError = String(error.code || "READ_FAILED");
      }
    }

    res.json({
      ok: true,
      shipID,
      activeShipID: held.activeShipID || null,
      bays: readings.map((entry) => ({
        key: entry.bay.key,
        label: entry.bay.label,
        present: entry.present,
        capacity: entry.capacity,
        // null is "we could not look"; [] is "we looked, and it is empty".
        // An absent bay has no contents to speak of and stays null.
        items:
          entry.present === true && byFlag !== null ? byFlag.get(entry.bay.flag) || [] : null,
        error: entry.error || (entry.present === true ? listError : null),
      })),
    });
  } catch (error) {
    next(error);
  }
});

/** dogma/const.py attributeMiningScannerUpgrade. */
const ATTRIBUTE_MINING_SCANNER_UPGRADE = 5979;

/**
 * The mining scanner upgrade of the ship being flown, as the retail client reads it before it scans
 * (mining/client/mining_util.py 26): int() of godma's value for the ship's attribute, and null where godma
 * holds none of it (the client's None). Undefined where it cannot be known at all: off the game port, or on a
 * game port that keeps no godma.
 */
async function miningScannerUpgrade(held) {
  if (!gamePortPilots || !isGamePortHandle(held.bridgeSessionID) || typeof gamePortPilots.shipAttribute !== "function") return undefined;
  const value = await gamePortPilots.shipAttribute(ATTRIBUTE_MINING_SCANNER_UPGRADE, { userid: held.accountID }, held.bridgeSessionID);
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : null;
}

// The survey scanner: miningScanMgr.perform_scan() -> [[entityID, yieldTypeID,
// remainingQuantity], …]. Read-only, session-scoped, no arguments. This is how
// the player learns how much ore a rock has left; the browser MERGES it into
// the overview rather than computing anything of its own.
//
// WHEN THE CLIENT ASKS AT ALL (mining/client/asteroid_scanning_service.py 103):
// it reads the ship's mining scanner upgrade from godma; with none (`if not
// tier: return`) it asks nothing and does nothing, and only above nought does it
// ask the server. A fitted Mining Survey Chipset, online, is what gives a ship
// one. On the game port the BFF has godma's value and holds to the same: it
// answers `asked: false` with what godma had, and the server hears nothing. Off
// the game port there is no godma to read, and the scan is asked as it was.
app.get("/api/bridge/mining/scan", requireAuth, async (req, res, next) => {
  const held = requireHeldBridgeSession(req, res);
  if (!held) {
    return;
  }
  try {
    const before = await readHeldFlight(held, req.webSessionID);
    if (!requireInSpace(res, before.flight)) {
      return;
    }
    const upgrade = await miningScannerUpgrade(held);
    if (upgrade !== undefined && !(upgrade > 0)) {
      res.json({ ok: true, asked: false, scannerUpgrade: upgrade, results: null, notifications: [] });
      return;
    }
    const outcome = await heldTopLevelCall(
      held,
      req.webSessionID,
      "miningScanMgr",
      "perform_scan",
      [],
      null,
    );
    res.json({ ok: true, asked: true, scannerUpgrade: upgrade ?? null, results: outcome.result, notifications: outcome.notifications });
  } catch (error) {
    next(error);
  }
});

// IN-SPACE ORE COMPRESSION — the fleet mechanic.
//
// `inSpaceCompressionMgr.CompressItemInSpace(itemID, facilityBallID)` swaps one
// ore stack for its compressed type at the same quantity (~100x less volume in
// this build), using a mining support ship on grid as the facility: a hull
// running an Industrial Core plus a compression module, either your own or a
// FLEET-MATE's, and you have to be inside its range.
//
// ⚠ EVERY GUARD IS THE SERVER'S, AND THAT IS THE POINT. This route sends the
// caller's own itemIDs and the ball they named; `resolveInSpaceCompressionContext`
// then checks in-space, same-scene, live compression typelists (i.e. the modules
// really are running), own-ship-or-same-fleet, and range — and the handler
// refuses any item the caller does not own or that is not in their own ship. So
// there is nothing useful for this route to re-derive, and re-deriving it in a
// second place is how the two copies drift apart.
//
// Confirm-gated like every other write here. One stack per request keeps the
// failure honest: the handler answers a refusal and a not-compressible item with
// the SAME null, so a batch could not say which stack was which. The caller
// re-reads its hold and judges by the stack's type having changed.
function requireExpectedInventoryFlight(res, expected, flight) {
  if (expected === undefined) return true;
  if (!expected || ![expected.shipID, expected.solarSystemID].every(id => Number.isSafeInteger(id) && id > 0) ||
    flight?.inSpace !== true || flight.shipID !== expected.shipID || flight.solarSystemID !== expected.solarSystemID) {
    res.status(409).json({ ok: false, error: "OWN_SHIP_SCOPE_CHANGED", message: "Ship or system authority changed; reread before moving inventory." }); return false;
  }
  return true;
}

// The Abyssal pocket's timer as the pilot was last told it (gamePort/pilots.js keepPocketTimer): the end_time of
// OnAddExpiryDurationForAbyssalContent, as the notice had it, or null. The client is told it once, at the pocket's
// entry; a browser drawing the pilot afresh asks this instead. Through the web gateway nothing is kept: known false.
// With it the pocket's room as last told (pilots.js pocketRoom: OnAbyssalLocationEntered's client_data), or null.
app.get("/api/bridge/pocket-timer", requireAuth, (req, res, next) => {
  const held = requireHeldBridgeSession(req, res);
  if (!held) return;
  try {
    if (!gamePortPilots || !isGamePortHandle(held.bridgeSessionID) || typeof gamePortPilots.pocketTimer !== "function") {
      res.json({ ok: true, known: false, endTime: null, room: null });
      return;
    }
    const fields = { userid: held.accountID };
    const room = typeof gamePortPilots.pocketRoom === "function" ? gamePortPilots.pocketRoom(fields, held.bridgeSessionID) : null;
    res.json({ ok: true, known: true, endTime: gamePortPilots.pocketTimer(fields, held.bridgeSessionID), room });
  } catch (error) {
    next(error);
  }
});

// Why a pilot of this account went offline, where the game server closed its connection with a reason of its own
// (another login of the account: gamePort/pilots.js closedByServer). The page asks as it lets the pilot go, and says
// so, as the retail client puts up its connection-lost notice. Null where the server closed nothing.
app.get("/api/bridge/closed-by-server", requireAuth, (req, res) => {
  const characterID = Number(req.query.characterID);
  if (!Number.isSafeInteger(characterID) || characterID <= 0) {
    res.status(400).json({ ok: false, error: "INVALID_CHARACTER", message: "A character is required." });
    return;
  }
  const closed = gamePortPilots && typeof gamePortPilots.closedByServer === "function"
    ? gamePortPilots.closedByServer(characterID)
    : null;
  res.json({
    ok: true,
    closed: closed && Number(closed.accountID) === Number(req.account.accountID)
      ? { reasonCode: closed.reasonCode, reason: closed.reason, at: closed.at }
      : null,
  });
});

app.get("/api/mining/compression-compatibility", requireAuth, (req, res, next) => {
  const ids = value => typeof value === "string" && /^\d+(?:,\d+)*$/.test(value)
    ? value.split(",").map(Number) : [];
  const typeIDs = ids(req.query.typeIDs), typeListIDs = ids(req.query.typeListIDs);
  if (!typeIDs.length || typeIDs.length > 32 || !typeListIDs.length || typeListIDs.length > 16 ||
    [...typeIDs, ...typeListIDs].some(id => !Number.isSafeInteger(id) || id <= 0)) {
    res.status(400).json({ ok: false, error: "INVALID_COMPRESSION_QUERY", message: "Bounded type and typelist IDs are required." }); return;
  }
  try {
    const compatibility = typeof staticData.getMiningCompressionCompatibility === "function"
      ? staticData.getMiningCompressionCompatibility([...new Set(typeIDs)], [...new Set(typeListIDs)]) : null;
    res.json({ ok: true, compatibility });
  } catch (error) { next(error); }
});

// A stack is compressed in space by the page's own call since 2026-10-14 (web/src/bridge/compressionWrites.ts:
// inSpaceCompressionMgr.CompressItemInSpace, itemCompression.py 9); its support collection reads the flight first,
// as the route did. The route (POST /api/bridge/mining/compress) is gone.

/**
 * A call of the page's on the refinery of where the pilot is docked (bridgeCallPolicy.js, PAGE_OBJECT_CALLS:
 * "refinery"), by the object the reprocessing routes bind, a structure's hangar access asked first as they asked it.
 */
async function refineryCall(held, webSessionID, method, args, kwargs) {
  if (held.structureID) await assertDockedInventoryAccess(held, webSessionID, 4);
  return boundCall(held, webSessionID, reprocessingBindSpec(held), method, args, kwargs);
}

// R3's bound-object machinery, reused: Moniker('reprocessingSvc', stationID).
// Keyed by station so docking somewhere else binds that station's refinery
// rather than reusing a stale OID.
function reprocessingBindSpec(held) {
  const locationID = inventoryLocationID(held);
  return {
    key: `reprocessing:${locationID}`,
    service: "reprocessingSvc",
    method: "MachoBindObject",
    args: [locationID],
    kwargs: null,
  };
}

/** One value out of a util.KeyVal, unwrapping a marshaled long but NOT a
 * nested list/dict (which the caller still needs whole). */
function readKeyValField(entries, key) {
  const entry = entries.find((pair) => Array.isArray(pair) && pair[0] === key);
  const value = entry ? entry[1] : undefined;
  if (value && typeof value === "object" && value.type === "long") {
    return value.value;
  }
  return value;
}

function keyValEntries(value) {
  return value && value.args && Array.isArray(value.args.entries) ? value.args.entries : [];
}

/**
 * GetQuotes' [tax, efficiencyByTypeID, quotesByItemID] triple, as plain data.
 *
 * ⚠ `recoverables` is a LIST of util.KeyVals — NOT a dict of typeID -> amount —
 * and the amount the player actually receives is the `client` field on each
 * (`unrecoverable` is the station's share, which is exactly what the player must
 * not be shown as theirs). Getting this wrong would put a confidently wrong
 * mineral count on screen, so it is read from the real handler's shape
 * (services/station/reprocessingService.js buildRecoverableEntry).
 */
function decodeReprocessingQuotes(result) {
  // A quote's whole amount as the server said it. Nought is an amount: a stack of too few has nothing to process,
  // and that is said as 0. Null where the quote has none, or what it has is no amount.
  const quotedAmount = (said) => {
    const amount = typeof said === "string" && /^\d+$/.test(said) ? Number(said) : said;
    return typeof amount === "number" && amount >= 0 ? amount : null;
  };
  const triple = Array.isArray(result) ? result : [];
  const taxRaw = Number(triple[0]);
  const dictEntries = (value) =>
    value && value.type === "dict" && Array.isArray(value.entries) ? value.entries : [];
  const quotes = [];
  for (const [itemID, quote] of dictEntries(triple[2])) {
    const entries = keyValEntries(quote);
    const numericItemID = Number(itemID) || 0;
    if (numericItemID <= 0) {
      continue;
    }
    const recoverables = readKeyValField(entries, "recoverables");
    const outputs = [];
    const recoverableItems =
      recoverables && recoverables.type === "list" && Array.isArray(recoverables.items)
        ? recoverables.items
        : [];
    for (const recoverable of recoverableItems) {
      const fields = keyValEntries(recoverable);
      const typeID = Number(readKeyValField(fields, "typeID")) || 0;
      // `client` is the player's share. Anything else on the entry is the
      // station's, and must never be presented as what the player gets.
      const quantity = Number(readKeyValField(fields, "client")) || 0;
      if (typeID > 0 && quantity > 0) {
        outputs.push({ typeID, quantity });
      }
    }
    const iskCost = Number(readKeyValField(entries, "totalISKCost"));
    quotes.push({
      itemID: numericItemID,
      typeID: Number(readKeyValField(entries, "typeID")) || null,
      quantityToProcess: quotedAmount(readKeyValField(entries, "quantityToProcess")),
      leftOvers: quotedAmount(readKeyValField(entries, "leftOvers")),
      // What this stack costs in ISK, as the station computed it.
      iskCost: Number.isFinite(iskCost) ? iskCost : null,
      outputs,
    });
  }
  return {
    // null rather than 0 when the server did not give a rate: "we do not know
    // the tax" and "the tax is nothing" are different, and a wrong 0 would
    // understate what this costs.
    taxRate: Number.isFinite(taxRaw) ? taxRaw : null,
    quotes,
  };
}

/**
 * Where each of these items is, of the places the page's refining reaches: the hangar where the pilot is docked,
 * and the mining holds of the ship the pilot is in, the cargo among them. The client's window has each item's own
 * row, and so its place (reprocessing/ui/itemReprocessor.py 19 to 23); the page names the items alone, so the
 * listings are read for them: the hangar's first, and the ship's holds down the ladder only while an item is still
 * to be found. An item that is in none of them, or whose row names no place, has no place here.
 */
async function reprocessingPlacesOf(held, webSessionID, itemIDs, status) {
  const wanted = new Set(itemIDs);
  const places = new Map();
  const allFoundIn = (listed) => {
    for (const row of decodeInventoryRows(listed.result)) {
      if (wanted.has(row.itemID) && row.locationID > 0) places.set(row.itemID, row.locationID);
    }
    return places.size === wanted.size;
  };
  if (allFoundIn(await boundCall(held, webSessionID, hangarBindSpec(held), "List", [ITEM_FLAG_HANGAR], null))) return places;
  const shipID = Number(held.activeShipID) || 0;
  if (shipID <= 0) return places;
  const { carries } = await miningHoldsOfShip(held, webSessionID, shipID, status);
  const spec = cargoBindSpec(held, shipID);
  for (const hold of MINING_HOLDS.filter(carries)) {
    if (allFoundIn(await boundCall(held, webSessionID, spec, "List", [hold.flag], null))) break;
  }
  return places;
}

// What reprocessing these stacks WOULD produce, and what the station will take.
// A pure read: nothing is consumed and nothing is charged by this route. The
// tax comes back first in the retail triple and is passed through as its own
// field, because the page must show it BEFORE the player commits.
app.get("/api/bridge/reprocessing/quote", requireAuth, async (req, res, next) => {
  const held = requireHeldBridgeSession(req, res);
  if (!held) {
    return;
  }
  const itemIDs = String((req.query && req.query.itemIDs) || "")
    .split(",")
    .map((value) => Number(value.trim()) || 0)
    .filter((value) => value > 0);
  if (itemIDs.length === 0) {
    res.status(400).json({
      ok: false,
      error: "NOTHING_SELECTED",
      message: "Choose what to reprocess first.",
    });
    return;
  }
  try {
    const before = await readHeldFlight(held, req.webSessionID);
    if (!before.flight || before.flight.docked !== true) {
      res.status(409).json({
        ok: false,
        error: "NOT_DOCKED",
        message: "Dock at a station to use its refinery.",
      });
      return;
    }
    if (held.structureID) await assertDockedInventoryAccess(held, req.webSessionID, 4);
    // The client's window asks its quote with each item's own row, which its inventory cache has from the listing
    // of where the item is (reprocessing/ui/quotes.py 20). On the game port the transport hands the rows in from
    // the listings the pilot holds: the hangar's is read here, and the ship's holds' where an item is not in it,
    // each answered from what is held where it is. A listing that could not be read fails nothing: the quote is
    // then asked for the items by their IDs alone.
    if (heldOnTheGamePort(held)) {
      await reprocessingPlacesOf(held, req.webSessionID, itemIDs, before).catch((error) => {
        if (error && error.code === "SESSION_NOT_FOUND") throw error;
      });
    }
    const outcome = await boundCall(
      held,
      req.webSessionID,
      reprocessingBindSpec(held),
      "GetQuotes",
      [itemIDs],
      null,
    );
    const decoded = decodeReprocessingQuotes(outcome.result);
    res.json({
      ok: true,
      stationID: held.stationID,
      taxRate: decoded.taxRate,
      quotes: decoded.quotes,
      notifications: outcome.notifications,
    });
  } catch (error) {
    next(error);
  }
});

// Items are reprocessed by the page's own calls since 2026-10-14 (web/src/bridge/reprocessWrites.ts:
// reprocessingSvc.Reprocess on the refinery, itemReprocessor.py 71, one call for each place; refineryCall above), each
// item's place read by the page. The route (POST /api/bridge/reprocessing/reprocess) and its reading of the answer
// are gone.

// Two things about a rock that live in STATIC DATA rather than in the scene, and
// so are stamped onto each ROCK row of a space snapshot before it reaches the
// browser. Non-rock rows pass through untouched, and both fields read null —
// never 0 — when the data cannot answer, because a zero here is a claim.
//
//   • ORE GRADE — dogma attribute 2699 (asteroid meta level) of the rock's ore
//     type: 0-Grade=0, plain=1, II-Grade=2, III=3, IV=4. The gateway's own row
//     carries the ore's typeID but not its grade. See SpaceEntity.oreGrade.
//   • ORE VALUE — ISK per m³, the number behind the retail client's Mining
//     Surveyor "Ore Value" gradient. The client computes it in its own UI from
//     the same static inputs (see staticData.getOreValuePerM3), so this is not a
//     new fact about the world, it is the same arithmetic done once here instead
//     of per rock per tick in the browser. Per m³ and not per unit, because a
//     hold is a volume: it ranks two rocks by what one trip is worth.
const ASTEROID_META_LEVEL_ATTRIBUTE = 2699;

function isRockSpaceEntityRow(row) {
  return Boolean(
    row &&
      typeof row === "object" &&
      (row.beltID || row.miningYieldTypeID || row.kind === "asteroid"),
  );
}

function withOreStaticFields(space) {
  if (!space || typeof space !== "object" || !Array.isArray(space.entities)) {
    return space;
  }
  return {
    ...space,
    entities: space.entities.map((row) => {
      if (!isRockSpaceEntityRow(row)) {
        return row;
      }
      const grade = staticData.getTypeDogmaAttribute(row.typeID, ASTEROID_META_LEVEL_ATTRIBUTE, null);
      // The ore the LASER yields where the row names it, falling back to the
      // rock's own type: an asteroid row already resolves name/typeID to the ore
      // it holds, and the two agree for every ordinary rock.
      //
      // ⚠ GUARDED, ON PURPOSE — the same rule readStaticTable learned the hard
      // way: a static-data gap must not be fatal to the one read every ship in
      // space depends on. An injected staticData that predates this field (a
      // test double, an older deployment) leaves the value UNKNOWN instead of
      // throwing the whole snapshot route into a 500.
      const oreTypeID = Number(row.miningYieldTypeID) || Number(row.typeID) || 0;
      const value =
        oreTypeID > 0 && typeof staticData.getOreValuePerM3 === "function"
          ? staticData.getOreValuePerM3(oreTypeID)
          : null;
      return {
        ...row,
        oreGrade: typeof grade === "number" && Number.isFinite(grade) ? grade : null,
        miningResourceFamily: miningResourceFamily(typeof staticData.getType === "function" ? staticData.getType(oreTypeID) : null),
        oreValuePerM3: typeof value === "number" && Number.isFinite(value) ? value : null,
      };
    }),
  };
}

// R11 space overview + ship HUD. A read-only snapshot of what the ship can see
// right now — the visible entities around it and the active ship's shield /
// armor / hull / capacitor. The browser polls this ~1s while in space with the
// overview open (the retail client re-renders its own overview on the same
// 0.5-1.0s cadence) and computes distance, sorting and filtering itself from
// the returned positions, exactly as the real client does. Read-only: it starts
// no movement; the Warp to / Approach buttons on each row reuse the existing
// atomic-move routes above (/api/bridge/flight/warp and /approach).
app.get("/api/bridge/space/snapshot", requireAuth, async (req, res, next) => {
  const held = requireHeldBridgeSession(req, res);
  if (!held) {
    return;
  }
  try {
    const outcome = await gateway.readSpaceSnapshot(held.bridgeSessionID, {
      userid: held.accountID,
    });
    res.json({
      ok: true,
      space: withOreStaticFields(outcome.space),
      notifications: outcome.notifications,
    });
  } catch (error) {
    if (error && error.code === "SESSION_NOT_FOUND") {
      forgetBridgeSession(req.webSessionID, held);
    }
    next(error);
  }
});

// --- R25 slice A: drones ----------------------------------------------------
//
// The first thing on this bridge that KEEPS FIGHTING after the browser stops
// asking, and that is the whole point. An idle combat drone auto-engages
// whatever shoots the ship it was launched from — the server's own behaviour
// (droneRuntime's incoming-aggression hook, gated on a per-drone `aggressive`
// setting that DEFAULTS ON). So for a miner sitting in a belt the minimum
// viable defence is LAUNCHING. Engage below is for CHOOSING a victim; it is not
// what makes a player defended, and this BFF does not imply that it is.
//
// ⚠ THE SERVICE SPLIT. Launch and scoop are `ship`; every in-space order is
// `entity`. One feature, two services.
//
// ⚠ LAUNCH ANSWERS 200 WHEN IT REFUSES. The server's handler returns an empty
// dict on outright failure and an error tuple per itemID on partial failure —
// bandwidth, the active-drone cap, a wrong bay flag and a vanished stack all
// arrive that way. Nothing here reads a 200 as a launch: every route below
// re-reads the SPACE SNAPSHOT and reports what is actually out there.

// The ship's drone bay flag. Like the mining holds and the slot flags, this
// number NEVER leaves this file — the browser is handed drones by name.
const ITEM_FLAG_DRONE_BAY = 87;

/**
 * The drones the SERVER says are in space under this ship's control.
 *
 * Owner AND controller are both checked. `ownerID` alone would also match a
 * drone this character owns but launched from a hull they have since swapped
 * out of; `controllerID` alone would match a drone flown by this hull for
 * someone else. A drone the panel offers a Recall button for must be both.
 */
async function readDronesInSpace(held) {
  const outcome = await gateway.readSpaceSnapshot(held.bridgeSessionID, {
    userid: held.accountID,
  });
  return { drones: projectDronesInSpace(held, outcome && outcome.space), notifications: outcome ? outcome.notifications : [] };
}

/** Project this pilot's visible drones from a caller-owned scene read. */
function projectDronesInSpace(held, space) {
  const entities = space && Array.isArray(space.entities) ? space.entities : null;
  if (entities === null) {
    // null, not [] — "we could not look" is not "you have no drones in space",
    // and a page that confuses the two invites a player to launch a second set.
    return null;
  }
  const shipID = Number(held.activeShipID) || 0;
  const characterID = Number(held.characterID) || 0;
  const drones = entities
    .filter((row) => row && row.kind === "drone")
    .filter((row) => {
      const owner = Number(row.ownerID) || 0;
      const controller = Number(row.controllerID) || 0;
      return (
        (characterID > 0 && owner === characterID) ||
        (shipID > 0 && controller === shipID)
      );
    })
    .map((row) => ({
      itemID: Number(row.itemID) || 0,
      typeID: Number(row.typeID) || null,
      // A NAME. The panel never renders the itemID it keys rows by (R7d).
      name: typeof row.name === "string" && row.name.length > 0 ? row.name : null,
      // ⚠ OWNED IS NOT FLOWN. The filter above deliberately keeps a drone this
      // CHARACTER owns even when this hull does not control it — that is how an
      // orphaned drone (session lost, ship swapped, pod-and-reboard) stays
      // visible instead of silently becoming someone else's salvage. But Recall
      // and Engage only work on drones under THIS ship's control, so the page
      // has to be able to tell the two apart: a controlled drone gets the order
      // buttons, an uncontrolled one gets Reconnect and Scoop.
      //
      // A BOOLEAN, not the controllerID — the id itself must not reach the
      // browser (R7d), and the only question the page has is this one.
      controlled: shipID > 0 && (Number(row.controllerID) || 0) === shipID,
      reconnectCandidate: reconnectCandidate(row, characterID),
      // A WORD, or null for "we could not tell" — never a raw activity enum.
      activity: typeof row.droneActivity === "string" ? row.droneActivity : null,
      // What it is busy with, so the page can name the rock or the rat.
      targetID: Number(row.targetEntityID) || null,
      shieldRatio: typeof row.shieldRatio === "number" ? row.shieldRatio : null,
      armorRatio: typeof row.armorRatio === "number" ? row.armorRatio : null,
      hullRatio: typeof row.hullRatio === "number" ? row.hullRatio : null,
    }));
  if (held.recoveryDroneIDs instanceof Set && !held.droneRecoveryReady) {
    for (const row of drones) if (row.reconnectCandidate === true) held.recoveryDroneIDs.add(row.itemID);
  }
  return drones;
}

// The whole Drones panel: what is in the bay, what is in space, and the two
// limits the server enforces on a launch.
//
// The LIMITS ADD NO ALLOWLIST PAIR. maxActiveDrones and droneBandwidth are
// ordinary ship dogma attributes, and dogmaIM.ShipGetInfo — allowlisted since
// R6 for the fitting panel — already answers the ship's whole attribute map.
// The raw result is passed through and decoded browser-side, exactly as the
// fitting route does, so the attribute IDs live in one place.
//
// The three reads are INDEPENDENT (allSettled): a bay that cannot be read must
// not blank the drones already flying, and vice versa.
app.get(["/api/bridge/drones", "/api/bridge/script/observation"], requireAuth, async (req, res, next) => {
  const held = requireHeldBridgeSession(req, res);
  if (!held) {
    return;
  }
  try {
    const flight = await readHeldFlight(held, req.webSessionID);
    // Any read can drain a session notification, including a fleet invite.
    // Preserve every successful drain, not just the scene read's response.
    const notifications = Array.isArray(flight.notifications) ? [...flight.notifications] : [];
    const shipID = held.activeShipID;
    if (!shipID) {
      res.status(409).json({ ok: false, error: "NO_ACTIVE_SHIP", message: "No active ship." });
      return;
    }
    const noShip = () =>
      Promise.reject(Object.assign(new Error("No active ship."), { code: "NO_ACTIVE_SHIP" }));
    const observation = req.path === "/api/bridge/script/observation";
    const observationStartedAt = Date.now();
    const scope = observation ? {
      bridgeSessionID: held.bridgeSessionID,
      accountID: held.accountID,
      characterID: held.characterID,
      activeShipID: held.activeShipID,
      solarSystemID: held.solarSystemID,
      transitionEpoch: held.transitionEpoch,
    } : null;
    const readObservation = async () => {
      const outcome = await gateway.readSpaceSnapshot(scope.bridgeSessionID, { userid: scope.accountID });
      if (!outcome || !outcome.space || typeof outcome.space !== "object" || Array.isArray(outcome.space)) {
        throw Object.assign(new Error("Space snapshot is unreadable."), { code: "SPACE_SNAPSHOT_UNREADABLE" });
      }
      return {
        space: outcome.space,
        drones: projectDronesInSpace(scope, outcome.space),
        notifications: outcome.notifications ?? [],
      };
    };
    const godma = await shipAsGodmaHoldsIt(held);
    const [bay, shipInfo, inSpace] = await Promise.allSettled([
      boundCall(
        held,
        req.webSessionID,
        cargoBindSpec(held, shipID),
        "ListByFlags",
        [[ITEM_FLAG_DRONE_BAY]],
        null,
        notifications,
      ),
      godma ? godma.shipInfo : heldTopLevelCall(held, req.webSessionID, "dogmaIM", "ShipGetInfo", [], null),
      shipID ? (observation ? readObservation() : readDronesInSpace(held)) : noShip(),
    ]);
    for (const settled of [bay, shipInfo, inSpace]) {
      if (settled.status === "rejected" && settled.reason && settled.reason.code === "SESSION_NOT_FOUND") {
        next(settled.reason);
        return;
      }
    }
    for (const settled of [bay, shipInfo, inSpace]) notifications.push(...settledReadNotifications(settled));
    if (observation) {
      if (inSpace.status === "rejected") throw inSpace.reason;
      const space = inSpace.value.space;
      if (bridgeSessions.get(req.webSessionID) !== held ||
          Object.keys(scope).some((key) => held[key] !== scope[key]) ||
          (space.ship?.itemID != null && Number(space.ship.itemID) !== Number(shipID)) ||
          (space.solarSystemID != null && Number(space.solarSystemID) !== Number(scope.solarSystemID))) {
        res.status(409).json({ ok: false, error: "OBSERVATION_SCOPE_CHANGED",
          message: "Pilot, ship or scene changed during the observation. Read again." });
        return;
      }
    }
    const settledCode = (settled) =>
      settled.status === "rejected"
        ? String((settled.reason && settled.reason.code) || "READ_FAILED")
        : null;
    // R7d: the shared row decoder carries flagID and locationID and NEITHER may
    // reach the browser. Only what a player reads about a drone stack survives.
    const bayRows =
      bay.status === "fulfilled"
        ? decodeInventoryRows(bay.value.result).map((row) => ({
            itemID: row.itemID,
            typeID: row.typeID,
            quantity: row.quantity,
          }))
        : null;
    // dronesUtil.GetDroneIDsInSpace (32 to 35): the client's drones in space are the ones it knows of that are NOT
    // in the bay. A landed drone is in the bay at once and its ball leaves the scene a moment later, and on the game
    // port the scene is the pilot's own ballpark: asked in between, it still has the ball. With the bay unread
    // there is nothing to take out, and the scene is said as it is.
    const inBay = new Set((bayRows ?? []).map((row) => Number(row.itemID)));
    const dronesOut = inSpace.status === "fulfilled" && Array.isArray(inSpace.value.drones)
      ? inSpace.value.drones.filter((drone) => !inBay.has(Number(drone.itemID)))
      : null;
    res.json({
      ok: true,
      activeShipID: shipID,
      notifications,
      ...(observation ? {
        space: withOreStaticFields(inSpace.value.space),
      } : {}),
      // null (not []) on a failed read: "we could not look in the bay" is not
      // "the bay is empty", and the panel says which.
      bay: bayRows,
      inSpace: dronesOut,
      // Raw, decoded browser-side alongside the fitting panel's attributes.
      shipInfo: shipInfo.status === "fulfilled" ? shipInfo.value.result : null,
      errors: {
        bay: settledCode(bay),
        shipInfo: settledCode(shipInfo),
        inSpace: settledCode(inSpace),
      },
    });
  } catch (error) {
    next(error);
  }
});

// The browser reports that its bounded reconnect/return workflow completed.
// The check ID binds this acknowledgement to the selected held session, and a
// final independent gateway read prevents an early/forged ACK from opening the
// bot handoff gate while a nearby recoverable flight is still present.
app.post("/api/bridge/drone-recovery/ready", requireAuth, async (req, res, next) => {
  const held = requireHeldBridgeSession(req, res);
  if (!held) return;
  if (typeof req.body?.checkID !== "string" || req.body.checkID !== held.droneRecoveryCheckID) {
    res.status(409).json({ ok: false, error: "DRONE_RECOVERY_STALE" });
    return;
  }
  try {
    const status = await readHeldFlight(held, req.webSessionID);
    if (status?.flight?.docked === true && held.recoveryDroneIDs.size > 0) {
      res.status(409).json({ ok: false, error: "DRONE_RECOVERY_UNCONFIRMED",
        message: "The pilot moved before the recovered flight was confirmed home." });
      return;
    }
    if (status?.flight?.docked !== true) {
      if (status?.flight?.inSpace !== true) throw new Error("Pilot location is unreadable.");
      const result = await readDronesInSpace(held);
      if (!recoveryReadyProof(result.drones, held.recoveryDroneIDs)) {
        res.status(409).json({ ok: false, error: "DRONE_RECOVERY_UNCONFIRMED",
          message: "Nearby lost drones have not been confirmed back in the bay." });
        return;
      }
    }
    if (bridgeSessions.get(req.webSessionID) !== held) {
      res.status(409).json({ ok: false, error: "DRONE_RECOVERY_STALE" });
      return;
    }
    held.droneRecoveryReady = true;
    res.json({ ok: true });
  } catch (error) { next(error); }
});

/**
 * The shared tail of every drone mutation: re-read what is actually in space
 * and answer with it.
 *
 * Not one of the four server calls below returns anything a caller can trust.
 * LaunchDrones answers a dict that is empty on failure; CmdEngage,
 * CmdMineRepeatedly and CmdReturnBay answer a dict that is empty on SUCCESS and
 * carries per-drone error tuples otherwise. The snapshot is the authority, and
 * it is the same authority in all four cases.
 */

// Launch from the bay: ship.LaunchDrones([[itemID, qty], …], whoseBehalfID,
// ignoreWarning).
//
// The BFF does NOT pre-check bandwidth or the active-drone cap. The server owns
// both limits, refuses per drone with its own reason, and would have to be
// re-implemented here to guess — so the page shows the limits, sends the
// request, and reports what came back in space.
/** How long a launch on the game port waits for its drones' balls, and how often it looks. */
const DRONE_ARRIVAL_WAIT_MS = 3000;

// Drones are launched by the page's own call since 2026-10-14 (web/src/bridge/boundEntityWrites.ts:
// ship.LaunchDrones, eveMisc.py 29), the drones read before and after by the page, waited for as the route waited for
// them (web/src/app/flow.ts, launchedThenRead). Its route (POST /api/bridge/drones/launch) is gone.

// Drones are set on a target, set to mine and sent home by the page's own calls since 2026-10-14
// (web/src/bridge/boundEntityWrites.ts: entity.CmdEngage, CmdMineRepeatedly and CmdReturnBay, droneFunctions.py 93,
// 151 and 187), the drones read after by the page. Their routes (POST /api/bridge/drones/engage, .../mine and
// .../recall) are gone, with the helper that registered them.

// --- R28 Skills: the character sheet and the training queue ----------------
//
// TWO DIFFERENT SURFACES ON PURPOSE.
//
// The READ is the gateway's v1 GET /skills — a plain-JSON projection that needs
// no bridge session, because reading what a character knows is not an act of
// piloting. It arrives with names, group names, the SP threshold for every
// level of every skill, and the queue's instants as epoch milliseconds against
// `serverNowMs` sampled in the same read. Nothing is decoded here and nothing
// is computed here.
//
// The WRITE is the retail call skillMgr.SaveNewQueue on the HELD session. It
// has to be: the gateway's own POST /skill-queue runs under an
// OFFLINE_COMPANION authorization policy that requires the character to be
// OFFLINE, and a web login that has selected a character is `retail_client`.
// (Measured, not assumed — eve.js server/tests/webGatewaySkills.test.js pins
// both halves.) So the offline command is a companion-app surface for a
// character who is not playing, and this client's player IS playing.
//
// ⚠ A 200 IS NOT PROOF. SaveNewQueue returns null on success AND validates
// before it writes, so the only honest answer to "did the edit take" is the
// re-read below — which comes back through the gateway's snapshot of
// skillQueueRuntime, the same authority the save wrote to.
/**
 * A pilot's skill sheet. On the game port it is made from what the client's skill services keep of the skill
 * handler's answers, kept right by the server's notices (pilots.js skillSheet): the gateway's own sheet is a
 * snapshot no retail client asks for. Where that cannot be made, and on the gateway, it is the gateway's.
 */
async function skillSheetFor(account, characterID, held = null, webSessionID = null) {
  if (held && gamePortPilots && isGamePortHandle(held.bridgeSessionID)) {
    try {
      return await gamePortPilots.skillSheet({ userid: held.accountID }, held.bridgeSessionID);
    } catch (error) {
      if (error && error.code === "SESSION_NOT_FOUND") {
        forgetBridgeSession(webSessionID, held);
        throw error;
      }
    }
  }
  return gateway.getSkills(account.accountID, characterID);
}

/**
 * A pilot's skill sheet for a read the ACCOUNT makes of it: the PI boards, Pilot Training, mining
 * preparation. Such a read does not come from the web session that is flying the pilot, and may be of a pilot
 * nobody is flying.
 *
 * The web gateway's `skills` is the plan's for a pilot who is not online (docs/game-port-transport-plan.md, 2.3).
 * A pilot of this account that is online on this BFF on the game port has a session that keeps what the client's
 * skill services keep, and the sheet is made from that, as the pilot's own Skills window has it (skillSheetFor).
 * If that session cannot say, the gateway is asked, as it was before.
 */
async function accountSkillSheet(accountID, characterID) {
  const flown = [...bridgeSessions.values()].find((held) => held &&
    Number(held.characterID) === Number(characterID) && Number(held.accountID) === Number(accountID)) || null;
  if (flown && gamePortPilots && isGamePortHandle(flown.bridgeSessionID)) {
    try {
      return await gamePortPilots.skillSheet({ userid: flown.accountID }, flown.bridgeSessionID);
    } catch {
      // The pilot's session went, or could not make a sheet: the read is the account's, and falls to the gateway.
    }
  }
  return gateway.getSkills(accountID, characterID);
}

async function answerWithSkillSheet(res, account, characterID, extra = {}, held = null, webSessionID = null) {
  const skills = await skillSheetFor(account, characterID, held, webSessionID);
  if (!skills) {
    res.status(404).json({
      ok: false,
      error: "CHARACTER_NOT_FOUND",
      message: "That character was not found.",
    });
    return;
  }
  res.json({ ok: true, ...extra, skills });
}

/** A roster route's `characterIDs`: comma-separated, junk and repeats dropped. */
function rosterCharacterIDs(value) {
  const characterIDs = [];
  for (const part of String(value || "").split(",")) {
    const characterID = Number(part.trim()) || 0;
    if (characterID > 0 && !characterIDs.includes(characterID)) {
      characterIDs.push(characterID);
    }
  }
  return characterIDs;
}

// An account's characters for the Pilot Hangar, as the selection screen lists them (charUnboundMgr.
// GetCharacterSelectionData), read without logging the account in on the game port. A launcher lists an account's
// characters without a game login; a login closes the account's other client (EveJS's accountLoginClose.js, after
// sessionMgr.CloseUserSessions), so the hangar opening would put off a retail client playing on the account. Asked of
// the gateway as the account and no character. What each pilot is training is read from it too, as the client's
// selection screen reads it (charselData.py GetSkillInTrainingInfo, 185 to 191; web/src/app/knownCharacters.ts).
app.get("/api/roster/characters", requireAuth, async (req, res, next) => {
  try {
    const outcome = await gateway.callMethod(
      "charUnboundMgr",
      "GetCharacterSelectionData",
      [],
      null,
      { userid: Number(req.account.accountID) },
      undefined,
    );
    res.json({ ok: true, result: outcome ? outcome.result ?? null : null });
  } catch (error) {
    next(error);
  }
});

app.get("/api/pilot-training/characters", requireTrainingAuth, async (req, res, next) => {
  try {
    const characters = await store.listCharactersForAccount(req.account.accountID);
    res.json({ ok: true, account: req.account.username, characters: characters.map((character) => ({
      characterID: character.characterID,
      name: character.characterName,
      corporationID: character.corporationID,
      corporationName: character.corporationName,
    })) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/pilot-training/qualification", requireTrainingAuth, async (req, res, next) => {
  try {
    const characterID = Number(req.query.characterID);
    if (!Number.isSafeInteger(characterID) || characterID <= 0) throw Object.assign(new Error("Invalid pilot."), { code: "INVALID_CHARACTER_ID", statusCode: 400 });
    const raw = String(req.query.configurations || "[]");
    if (raw.length > 8192) throw Object.assign(new Error("Configuration too large."), { statusCode: 400 });
    let configurations;
    try { configurations = JSON.parse(raw); } catch { throw Object.assign(new Error("Invalid configuration."), { statusCode: 400 }); }
    const { read } = await readMinerPilot({ store, gateway, data: staticData, account: req.account, readSkills: accountSkillSheet,
      characterID, configurations, role: req.query.role, targetStage: req.query.targetConfigurationID || null });
    const sourceText = String(req.query.equipmentSource || '{"kind":"hangar"}');
    if (sourceText.length > 512) throw Object.assign(new Error("Invalid physical source."), { statusCode: 400 });
    let source;
    try { source = JSON.parse(sourceText); } catch { throw Object.assign(new Error("Invalid physical source."), { statusCode: 400 }); }
    res.json({ ok: true, ...await trainingEquipment.enrich(req.account, read, configurations, source) });
  } catch (error) { next(error); }
});

app.get("/api/pilot-training/miner", requireTrainingAuth, async (req, res, next) => {
  const characterID = Number(req.query.characterID);
  if (!Number.isSafeInteger(characterID) || characterID <= 0) {
    res.status(400).json({ ok: false, error: "INVALID_CHARACTER_ID" });
    return;
  }
  try {
    let selections = {};
    if (req.query.selections !== undefined) {
      try {
        const raw = String(req.query.selections);
        if (raw.length > 4096) throw new Error("Too large");
        selections = JSON.parse(raw);
        if (!selections || typeof selections !== "object" || Array.isArray(selections)) throw new Error("Not an object");
      } catch (error) {
        res.status(400).json({ ok: false, error: "INVALID_TRAINING_CONFIGURATION" });
        return;
      }
    }
    const { read } = await readMinerPilot({ store, gateway, data: staticData, account: req.account, readSkills: accountSkillSheet, characterID, selections, targetStage: req.query.targetStage ?? null });
    res.json({ ok: true, ...read });
  } catch (error) {
    next(error);
  }
});

// A review is read-only. Apply accepts only its account-bound, one-shot review;
// browser-supplied queue entries or account IDs are never dispatched.
app.post("/api/pilot-training/queue/review", requireTrainingAuth, async (req, res, next) => {
  try { res.json({ ok: true, review: await trainingQueues.review(req.account, req.body || {}) }); }
  catch (error) { next(error); }
});
app.post("/api/pilot-training/queue/apply", requireTrainingAuth, async (req, res, next) => {
  try { res.json({ ok: true, outcome: await trainingQueues.apply(req.account, req.body || {}) }); }
  catch (error) { next(error); }
});

// Funding is an independently authenticated account, never inferred from the
// trainee or a browser-supplied account ID. Credentials are never persisted.
async function factoryFunding(body) {
  if (!body.funding) return null;
  const payload = auth.verifySessionToken(body.funding.token);
  if (!payload) throw Object.assign(new Error("Funding authority authentication required."), { code: "FUNDING_AUTH_REQUIRED", statusCode: 401 });
  const account = await store.getAccount(payload.username);
  if (!account || account.banned || account.accountID !== Number(payload.accountID))
    throw Object.assign(new Error("Funding authority is unavailable."), { code: "FUNDING_AUTH_REQUIRED", statusCode: 403 });
  return { account, sessionID: payload.sessionID, characterID: body.funding.characterID };
}
for (const action of ["review", "apply"]) {
  app.post(`/api/pilot-training/onboarding/${action}`, requireTrainingAuth, async (req, res, next) => {
    try {
      const body = req.body || {};
      const authority = await factoryFunding({ funding: body.authority });
      res.json({ ok: true, outcome: await trainingOnboarding[action]({ account: req.account, sessionID: req.webSessionID }, body, authority) });
    } catch (error) { next(error); }
  });
}
app.get("/api/pilot-training/settings-context", requireTrainingAuth, async (req, res, next) => {
  try { res.json({ ok: true, ...await readTrainingSettingsContext({ account: req.account, store, gateway }) }); }
  catch (error) { next(error); }
});
app.get("/api/pilot-training/homes", requireTrainingAuth, async (req, res, next) => {
  try {
    const q = String(req.query.q || "").trim().slice(0, 120);
    const result = staticData.findMapLocations({ q, kind: "station", limit: 25 });
    let structures = [], structureWarning = null;
    if (q.length >= 2 && req.query.characterID) {
      try { structures = await accessibleStructureMatches(req, q, Number(req.query.characterID)); }
      catch { structureWarning = "Accessible structure search is unavailable; NPC stations remain available."; }
    }
    res.json({ ok: true, matches: [...result.matches, ...structures].slice(0, 25),
      capped: result.capped || result.matches.length + structures.length > 25, structureWarning });
  } catch (error) { next(error); }
});
app.get("/api/pilot-training/home", requireTrainingAuth, async (req, res, next) => {
  try {
    const id = Number(req.query.locationID);
    if (!Number.isSafeInteger(id) || id <= 0) throw Object.assign(new Error("Invalid location ID."), { code: "INVALID_LOCATION", statusCode: 400 });
    const station = staticData.getStation(id);
    if (station) {
      res.json({ ok: true, home: { locationID: id, name: station.stationName, systemID: station.solarSystemID || null,
        kind: "NPC_STATION", relocation: "MANUAL_GM_ONLY", capability: "DOCKABLE_STATION" } });
      return;
    }
    if (!isPlayerStructureID(id)) { res.status(400).json({ ok: false, error: "UNSUPPORTED_HOME_LOCATION" }); return; }
    const checked = await dockableAccessCall(req, "CheckMyDockingAccessToStructures", [[id]], Number(req.query.characterID || 0));
    if (!structureIDsFromList(checked.result).includes(id)) {
      res.status(409).json({ ok: false, error: "STRUCTURE_DOCK_ACCESS_DENIED" }); return;
    }
    const { records, failed } = await resolveRuntimeStructureNames(req, [id], { publicWithoutHeld: true });
    const structure = records.get(id);
    if (failed.has(id) || !structure?.name || !structure.solarSystemID) {
      res.status(409).json({ ok: false, error: "STRUCTURE_UNRESOLVED" }); return;
    }
    res.json({ ok: true, home: { locationID: id, name: structure.name, systemID: structure.solarSystemID,
      kind: "PLAYER_STRUCTURE", relocation: "CONFIG_ONLY", capability: "DOCKABLE_STRUCTURE" } });
  } catch (error) { next(error); }
});

app.get("/api/pilot-training/ownership", requireTrainingAuth, async (req, res, next) => {
  try { res.json({ ok: true, ownership: await factorySessions.status(req.account, Number(req.query.characterID)) }); }
  catch (error) { next(error); }
});
for (const action of ["review", "acquire"]) {
  app.post(`/api/pilot-training/skills/${action}`, requireTrainingAuth, async (req, res, next) => {
    try {
      const body = req.body || {};
      const outcome = await factorySkills[action]({ account: req.account, sessionID: req.webSessionID }, body);
      res.json({ ok: true, outcome });
    } catch (error) {
      if (error.cleanup?.some((row) => !row.released)) {
        res.status(409).json({ ok: false, error: "FACTORY_SESSION_RELEASE_FAILED", message: `${error.message} Temporary session release is unconfirmed; refresh ownership before retrying.` });
      } else next(error);
    }
  });
}

app.get("/api/bridge/skills", requireAuth, async (req, res, next) => {
  const held = requireHeldBridgeSession(req, res);
  if (!held) {
    return;
  }
  try {
    await answerWithSkillSheet(res, req.account, held.characterID, {}, held, req.webSessionID);
  } catch (error) {
    next(error);
  }
});

/**
 * Save the whole queue (goal R28).
 *
 * Adding a skill, removing one and reordering are ALL "save this list" — that
 * is how retail models it, and inventing three verbs on top of one server call
 * would only create three ways to disagree with the server. The browser sends
 * the list it wants; the server validates it as a whole (prerequisites, level
 * order, Omega gating, the 50-entry cap, the queue-length limit) and refuses
 * the whole list with ONE of its eleven public codes if any of that fails.
 *
 * The refusal codes pass through UNTRANSLATED as the CALL_REFUSED message —
 * turning `QueueCannotPlaceSkillBeforeRequirements` into a sentence a player
 * can act on is the page's job (R9a), and doing it here would put the wording
 * out of reach of the tests that pin it.
 */
app.post("/api/bridge/skills/queue", requireAuth, async (req, res, next) => {
  const held = requireHeldBridgeSession(req, res);
  if (!held) {
    return;
  }
  const body = req.body || {};
  if (!Array.isArray(body.entries)) {
    res.status(400).json({
      ok: false,
      error: "INVALID_QUEUE",
      message: "A queue is a list of skills to train.",
    });
    return;
  }
  // Shape-check only. What is TRAINABLE is the server's judgement, and this
  // route never pre-refuses on its behalf — a client-side guess about
  // prerequisites or Omega state is exactly the kind of duplicated mechanic
  // that drifts out of step with the emulator.
  const entries = [];
  for (const entry of body.entries) {
    const typeID = Number(entry && entry.typeID) || 0;
    const toLevel = Number(entry && entry.toLevel) || 0;
    if (!Number.isSafeInteger(typeID) || typeID <= 0 || toLevel < 1 || toLevel > 5) {
      res.status(400).json({
        ok: false,
        error: "INVALID_QUEUE_ENTRY",
        message: "Each queued skill needs a skill and a level from 1 to 5.",
      });
      return;
    }
    entries.push([typeID, toLevel]);
  }
  try {
    // On the game port the queue is saved as the client's own queue panel saves one: on the skill handler, with
    // each entry by its place, started, and the queue asked for again after (pilots.js saveSkillQueue).
    const outcome = gamePortPilots && isGamePortHandle(held.bridgeSessionID)
      ? await heldRequest(held, req.webSessionID, true, () => gamePortPilots.saveSkillQueue(entries, { userid: held.accountID }, held.bridgeSessionID))
      : await heldTopLevelCall(
        held,
        req.webSessionID,
        "skillMgr",
        "SaveNewQueue",
        [entries],
        // An empty queue is a PAUSE, not a start: activating nothing would ask
        // the server to begin training a queue that does not exist.
        { activate: entries.length > 0 },
      );
    await answerWithSkillSheet(res, req.account, held.characterID, {
      notifications: outcome.notifications,
    }, held, req.webSessionID);
  } catch (error) {
    next(error);
  }
});

// --- R41 Planets: the character's colonies ---------------------------------
//
// WHERE THIS READ COMES FROM, AND WHY IT IS NOT A BRIDGE CALL.
//
// The emulator's colonies live in the `planetRuntimeState` root table, and the
// gateway's GET /snapshot ALREADY carries them: buildPlanetRuntimeForCharacter
// filters `coloniesByKey` down to rows whose `ownerID` is the requested
// character before the snapshot is serialized. That read is owner-scoped by
// construction and needs no held session — reading what you have built on a
// planet is not an act of piloting, exactly as reading what you have trained
// is not (R28).
//
// So this route adds ZERO entries to the gateway's deny-by-default call
// allowlist. That is not laziness, it is the safer of the two options. The
// planetMgr service DOES expose reads — GetFullNetworkForOwner,
// GetCommandPinsForPlanet, GetExtractorsForPlanet — and every one of them is
// deliberately OWNER-AGNOSTIC, because in the retail client they back the
// in-space planet view where you can see that someone else has a colony:
//
//   Handle_GetFullNetworkForOwner takes the ownerID from `args[1]`, so
//   allowlisting it would let any logged-in browser read ANY character's pin
//   layout on any planet by passing someone else's ID. GetCommandPinsForPlanet
//   and GetExtractorsForPlanet iterate `listColoniesForPlanet` across ALL
//   owners by design.
//
// That is the R38 shape precisely: a convenient read that leaks owner-only data
// for arbitrary IDs, declined. The snapshot answers the same question with the
// ownership check already applied.

const PI_PIN_KIND_BY_GROUP_ID = Object.freeze({
  1026: "extractor",
  1027: "command",
  1028: "factory",
  1029: "storage",
  1030: "launchpad",
  1063: "extractor-control",
});

// EveJS stores instants as Windows FILETIME (100ns ticks since 1601) in
// STRINGS, because they overflow a double. Every instant leaves this route as
// epoch milliseconds next to a `serverNowMs` sampled in the same read, so the
// browser never converts a FILETIME and never compares one clock to another.
const FILETIME_TICKS_PER_MS = 10000n;
const FILETIME_UNIX_EPOCH_OFFSET = 116444736000000000n;

// ⚠ A DURATION IS IN TICKS TOO, AND THIS ONE COST A ROUND TRIP.
//
// An extractor's `cycleTime` is NOT seconds — it is 100ns FILETIME ticks, the
// same unit as the instants. planetRuntimeStore divides it by SECOND_TICKS
// (10,000,000) everywhere it uses it. A live read caught this: the real colony
// on Jita I carries cycleTime 9,000,000,000, which is 900 seconds — a 15-minute
// extractor cycle, exactly what retail PI uses. Copied across as "seconds" it
// would have rendered as a cycle 285 years long, and the tests passed happily
// because the fixture had been written with the same wrong assumption.
const FILETIME_TICKS_PER_SECOND = 10000000;

function cycleTicksToSeconds(value) {
  const ticks = Number(value) || 0;
  if (ticks <= 0) {
    return 0;
  }
  return Math.round(ticks / FILETIME_TICKS_PER_SECOND);
}

function fileTimeToEpochMs(value) {
  if (value === null || value === undefined) {
    return null;
  }
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) {
    return null;
  }
  const ticks = BigInt(text);
  // "0" is EveJS's "never", not 1601 — a launchpad that has never launched
  // carries lastLaunchTime "0". Answer null so the panel says nothing rather
  // than printing a date four centuries ago.
  if (ticks <= FILETIME_UNIX_EPOCH_OFFSET) {
    return null;
  }
  return Number((ticks - FILETIME_UNIX_EPOCH_OFFSET) / FILETIME_TICKS_PER_MS);
}

function planetPinKind(staticDataSource, typeID) {
  const type = staticDataSource.getType(typeID);
  const groupID = Number(type && type.groupID) || 0;
  return PI_PIN_KIND_BY_GROUP_ID[groupID] || "other";
}

function projectPinContents(staticDataSource, contents) {
  if (!contents || typeof contents !== "object" || Array.isArray(contents)) {
    return [];
  }
  return Object.entries(contents)
    .map(([typeIDText, quantity]) => ({
      typeID: Number(typeIDText) || 0,
      typeName: staticDataSource.getTypeName(Number(typeIDText) || 0),
      quantity: Number(quantity) || 0,
    }))
    .filter((entry) => entry.typeID > 0 && entry.quantity > 0)
    .sort((left, right) => right.quantity - left.quantity);
}

/**
 * How much this pin can hold, in m³ — or NULL when the static table cannot say.
 *
 * The emulator asks the same question of the same field: planetRuntimeStore's
 * getPinCapacity reads `type.capacity` and treats a non-finite one as no limit
 * at all. A storage facility is 12,000, a launchpad 10,000, a command centre
 * 500, and a commodity 0 (it holds nothing).
 *
 * ⚠ NULL, NEVER 0. "We could not read the capacity" and "this pin holds
 * nothing" are different statements, and only the second one may ever be
 * divided into. A 0 here would make every unknown pin read as full.
 */
function pinCapacityM3(staticDataSource, typeID) {
  const type = staticDataSource.getType(typeID);
  const capacity = Number(type && type.capacity);
  return Number.isFinite(capacity) && capacity > 0 ? capacity : null;
}

/**
 * How much this pin's contents occupy, in m³ — or NULL when any one of them has
 * no volume in the static table.
 *
 * All-or-nothing on purpose: a partial sum is not a smaller number, it is a
 * WRONG one, and it would be divided by the capacity and shown as a fill
 * percentage. One unnameable commodity makes the whole answer "we cannot say".
 */
function pinUsedM3(staticDataSource, contents) {
  if (!contents || typeof contents !== "object" || Array.isArray(contents)) {
    return null;
  }
  let total = 0;
  for (const [typeIDText, quantity] of Object.entries(contents)) {
    const typeID = Number(typeIDText) || 0;
    const count = Number(quantity) || 0;
    if (typeID <= 0 || count <= 0) {
      continue;
    }
    const type = staticDataSource.getType(typeID);
    const volume = Number(type && type.volume);
    if (!Number.isFinite(volume) || volume <= 0) {
      return null;
    }
    total += volume * count;
  }
  // Rounded to the millilitre: the sum of 0.005 m³ units is otherwise a float
  // with a tail no player wants to see and no caller wants to compare against.
  return Math.round(total * 1000) / 1000;
}

/**
 * One extraction program, or null when this pin has none.
 *
 * NOTHING IS SIMULATED HERE. The cycle time, the quantity per cycle and both
 * instants are the server's own numbers, copied across. Whether the program has
 * run out is not decided here either — the browser compares `expiresAtMs` to
 * `serverNowMs`, so a page left open goes stale visibly instead of lying.
 */
const ECU_NOISE_FACTOR_ATTRIBUTE_ID = 1687;

/**
 * The most one cycle of this program can yield — which is also how much its
 * routes may reserve, and how much they MUST reserve for the game to call the
 * extractor settled. Null when the program or the noise factor is unknown.
 *
 * This is the retail client's EcuPin.GetMaxOutput and the emulator's
 * getPinProducts for an ECU, the same arithmetic on the same numbers:
 * trunc((1 + ecuNoiseFactor) * qtyPerCycle) * cycleSeconds / 900, floored.
 * No extractor type carries ecuNoiseFactor; each uses the attribute's SDE
 * default (0.8), so the default fallback is load-bearing here.
 */
function ecuMaxOutputPerCycle(staticDataSource, pin) {
  const qtyPerCycle = Number(pin && pin.qtyPerCycle) || 0;
  const cycleTicks = Number(pin && pin.cycleTime) || 0;
  if (!(Number(pin && pin.programType) > 0) || qtyPerCycle <= 0 || cycleTicks <= 0) {
    return null;
  }
  const noise = ecuNoiseFactor(staticDataSource, pin);
  if (noise === null) {
    return null;
  }
  const output = Math.trunc((1 + noise) * qtyPerCycle)
    * (cycleTicks / FILETIME_TICKS_PER_SECOND) / 900;
  return output > 0 ? Math.floor(output) : null;
}

/** An extractor control unit's noise (attribute 1687), never below nought, or null where the static data cannot say. */
function ecuNoiseFactor(staticDataSource, pin) {
  const read = staticDataSource && staticDataSource.getTypeDogmaAttributeOrDefault;
  const noise = typeof read === "function"
    ? Number(read(Number(pin && pin.typeID) || 0, ECU_NOISE_FACTOR_ATTRIBUTE_ID, null))
    : NaN;
  return Number.isFinite(noise) ? Math.max(0, noise) : null;
}

function projectExtractionProgram(staticDataSource, pin) {
  const resourceTypeID = Number(pin && pin.programType) || 0;
  const expiresAtMs = fileTimeToEpochMs(pin && pin.expiryTime);
  const installedAtMs = fileTimeToEpochMs(pin && pin.installTime);
  if (!resourceTypeID && expiresAtMs === null && installedAtMs === null) {
    return null;
  }
  return {
    resourceTypeID,
    resourceTypeName: resourceTypeID ? staticDataSource.getTypeName(resourceTypeID) : null,
    cycleTimeSeconds: cycleTicksToSeconds(pin && pin.cycleTime),
    quantityPerCycle: Number(pin && pin.qtyPerCycle) || 0,
    installedAtMs,
    expiresAtMs,
    maxOutputPerCycle: ecuMaxOutputPerCycle(staticDataSource, pin),
    headCount: Array.isArray(pin && pin.heads) ? pin.heads.length : 0,
    // Where the heads are, as the server has them ([head, latitude, longitude]), and the unit's noise: what a
    // client asks the planet a programme's yield with, and what it makes of the answer (clientPlanet
    // .InstallProgram, EcuPin.GetMaxOutput). The page restarts an extractor as the client does, and wants both.
    heads: Array.isArray(pin && pin.heads) ? pin.heads : [],
    noiseFactor: ecuNoiseFactor(staticDataSource, pin),
    // The drill area the program was installed with. It is what sets how long a
    // program runs (the emulator's getProgramLengthFromHeadRadius), and a
    // restart has to send it back: InstallProgram refuses anything that is not
    // a real number inside the drill-area bounds ("completely bonkers radius").
    headRadius: Number.isFinite(Number(pin && pin.headRadius)) && Number(pin.headRadius) > 0
      ? Number(pin.headRadius)
      : null,
  };
}

function projectColony(staticDataSource, colony) {
  const planetID = Number(colony && colony.planetID) || 0;
  const solarSystemID = Number(colony && colony.solarSystemID) || 0;
  const planetTypeID = Number(colony && colony.planetTypeID || colony && colony.typeID) || 0;
  const pins = (Array.isArray(colony && colony.pins) ? colony.pins : []).map((pin) => {
    const typeID = Number(pin && pin.typeID) || 0;
    const kind = planetPinKind(staticDataSource, typeID);
    // ⚠ A FLAG THE EMULATOR DID NOT SET IS NOT `false`. normalizePin only
    // writes hasReceivedInputs / receivedInputsLastCycle onto PROCESS pins, so
    // reading them off an extractor would turn "this pin has no such state"
    // into "this pin is starved". Undefined stays null all the way to the
    // panel, which then says nothing rather than raising a false alarm.
    const flag = (value) => (value === true ? true : value === false ? false : null);
    const schematicID = Number(pin && pin.schematicID) || 0;
    return {
      pinID: Number(pin && pin.pinID) || 0,
      typeID,
      typeName: staticDataSource.getTypeName(typeID),
      kind,
      contents: projectPinContents(staticDataSource, pin && pin.contents),
      // What it can hold and what is in it, so the browser can say "nearly
      // full" without knowing a single type's volume. Either may be null.
      capacityM3: pinCapacityM3(staticDataSource, typeID),
      usedM3: pinUsedM3(staticDataSource, pin && pin.contents),
      // A factory's recipe: the id is for nothing but the name beside it.
      schematicID: schematicID > 0 ? schematicID : null,
      schematicName: schematicID > 0
        ? staticDataSource.getPlanetSchematicName(schematicID)
        : null,
      // Whether the emulator's last simulated cycle fed this processor. The
      // second one is the interesting one: a factory that ran once and has
      // been dry since carries hasReceivedInputs true and this false.
      hasReceivedInputs: flag(pin && pin.hasReceivedInputs),
      receivedInputsLastCycle: flag(pin && pin.receivedInputsLastCycle),
      // Whether the pin is running right now: the retail BasePin.IsActive,
      // activityState > STATE_IDLE (0). A factory set to a recipe with nothing
      // in its buffer sits at 0. Null when the server gave no state.
      active: Number.isFinite(Number(pin && pin.state)) && pin.state !== null && pin.state !== ""
        ? Number(pin.state) > 0
        : null,
      // Instants, epoch ms against the same serverNowMs as everything else.
      // "0" — a pad that has never launched — comes back null, not 1601.
      lastRunAtMs: fileTimeToEpochMs(pin && pin.lastRunTime),
      lastLaunchAtMs: fileTimeToEpochMs(pin && pin.lastLaunchTime),
      program: kind === "extractor-control"
        ? projectExtractionProgram(staticDataSource, pin)
        : null,
    };
  }).filter((pin) => pin.pinID > 0);
  const routes = (Array.isArray(colony && colony.routes) ? colony.routes : []).map((route) => {
    const commodityTypeID = Number(route && route.commodityTypeID) || 0;
    return {
      routeID: Number(route && route.routeID) || 0,
      path: (Array.isArray(route && route.path) ? route.path : []).map((id) => Number(id) || 0),
      commodityTypeID,
      commodityTypeName: commodityTypeID ? staticDataSource.getTypeName(commodityTypeID) : null,
      commodityQuantity: Number(route && route.commodityQuantity) || 0,
    };
  }).filter((route) => route.routeID > 0);
  return {
    planetID,
    // Null, never a stringified id: a planet the static map cannot name is a
    // fact the panel decides how to word (R7d), not a number to print.
    planetName: planetID ? staticDataSource.getPlanetName(planetID) : null,
    solarSystemID,
    solarSystemName: solarSystemID ? staticDataSource.getSolarSystemName(solarSystemID) : null,
    planetTypeID,
    planetTypeName: planetTypeID ? staticDataSource.getTypeName(planetTypeID) : null,
    commandCenterLevel: Number(colony && colony.level) || 0,
    lastSimulatedAtMs: fileTimeToEpochMs(colony && colony.currentSimTime),
    pins,
    linkCount: (Array.isArray(colony && colony.links) ? colony.links : []).length,
    // The links themselves, not just how many. `level` is the upgrade level the
    // emulator multiplies the link's bandwidth by (getLinkBandwidthCapacity:
    // logisticalCapacity × 2^level), so a colony whose routes outgrow their
    // links can be told apart from one that is merely busy. Endpoints are pin
    // ids — for matching against `pins`, never for display.
    links: (Array.isArray(colony && colony.links) ? colony.links : []).map((link) => ({
      endpoint1: Number(link && link.endpoint1) || 0,
      endpoint2: Number(link && link.endpoint2) || 0,
      level: Number(link && link.level) || 0,
    })).filter((link) => link.endpoint1 > 0 && link.endpoint2 > 0),
    routes,
  };
}

/**
 * The colony table a gateway snapshot carries, projected and ordered.
 *
 * ⚠ THE FACT, NOT A GUESS (the worldHasNoContracts rule). "The snapshot carried
 * a colony table and none of it is yours" is a different statement from "this
 * gateway did not report colonies at all", and only the first one justifies
 * telling a player they have no colonies. `coloniesReadable` carries which one
 * happened.
 */
// The two skills that bound a pilot's colonies: Interplanetary Consolidation
// (one colony, plus one a level) and Command Center Upgrades (the highest
// level its command centres reach).
const INTERPLANETARY_CONSOLIDATION_TYPE_ID = 2495;
const COMMAND_CENTER_UPGRADES_TYPE_ID = 2505;

/**
 * { consolidation, commandCenterUpgrades } trained levels, or null when the
 * skill sheet was not read. A skill the sheet lacks is level 0, untrained.
 */
function planetSkillsFrom(skills) {
  if (!skills || !Array.isArray(skills.skills)) return null;
  const levelOf = (typeID) => {
    const row = skills.skills.find((entry) => Number(entry && entry.typeID) === typeID);
    const level = Number(row && row.level);
    return Number.isInteger(level) && level >= 0 && level <= 5 ? level : 0;
  };
  return {
    consolidation: levelOf(INTERPLANETARY_CONSOLIDATION_TYPE_ID),
    commandCenterUpgrades: levelOf(COMMAND_CENTER_UPGRADES_TYPE_ID),
  };
}

function coloniesFromSnapshot(snapshot) {
  const runtime = snapshot && snapshot.planetRuntimeState;
  const coloniesReadable = Boolean(
    runtime && typeof runtime === "object" && !Array.isArray(runtime)
    && runtime.coloniesByKey && typeof runtime.coloniesByKey === "object"
    && !Array.isArray(runtime.coloniesByKey),
  );
  const resourcesByPlanetID = runtime && runtime.resourcesByPlanetID
    && typeof runtime.resourcesByPlanetID === "object"
    ? runtime.resourcesByPlanetID
    : {};
  const colonies = coloniesReadable
    ? Object.values(runtime.coloniesByKey)
      .map((colony) => {
        const projected = projectColony(staticData, colony);
        return {
          ...projected,
          resources: projectPlanetResources(staticData, resourcesByPlanetID[String(projected.planetID)]),
        };
      })
      .filter((colony) => colony.planetID > 0)
      .sort((left, right) => (
        String(left.planetName || "").localeCompare(String(right.planetName || ""))
        || left.planetID - right.planetID
      ))
    : [];
  return { coloniesReadable, colonies };
}

/**
 * What a colonised planet carries, and how rich each resource is (R108 slice 5).
 *
 * The snapshot carries the planet's own resource record beside the colony: the
 * same `qualitiesByTypeID` GetPlanetResourceInfo answers from, with no session
 * needed. `quality` is the server's number as stated — not a percentage, and
 * not rescaled here. Null when the snapshot carried no record for the planet:
 * "unknown" is not "carries nothing".
 */
function projectPlanetResources(staticDataSource, record) {
  if (!record || typeof record !== "object" || !Array.isArray(record.resourceTypeIDs)) {
    return null;
  }
  const qualities = record.qualitiesByTypeID && typeof record.qualitiesByTypeID === "object"
    ? record.qualitiesByTypeID
    : {};
  return record.resourceTypeIDs
    .map((id) => Number(id) || 0)
    .filter((typeID) => typeID > 0)
    .map((typeID) => {
      const quality = Number(qualities[String(typeID)]);
      return {
        typeID,
        typeName: staticDataSource.getTypeName(typeID),
        quality: Number.isFinite(quality) ? quality : null,
      };
    });
}

/**
 * A held pilot's colonies as the retail client reads them: the planets it has
 * colonies on asked of the planet manager (planetSvc.GetMyPlanets), then each
 * planet's own object asked for its colony (clientPlanet.PreparePlanet:
 * GetPlanetInfo) and for what the planet carries (GetPlanetResourceInfo), each
 * with nothing. The answers are made into the stored row the snapshot's colonies
 * are (src/planetInfoColony.js), so that the page is answered in one form.
 *
 * A planet the manager lists on which the pilot has no colony any more answers
 * its own facts alone, and is left out. The manager answering no list at all is
 * "not read", which is not "no colonies".
 */
async function coloniesAsTheClientReads(held, webSessionID) {
  const listed = await heldTopLevelCall(held, webSessionID, "planetMgr", "GetPlanetsForChar", [], null);
  const planetIDs = planetIDsOf(listed.result);
  if (planetIDs === null) {
    return { coloniesReadable: false, colonies: [] };
  }
  const colonies = [];
  for (const planetID of planetIDs) {
    // The colony first: it is what binds the planet's object, as in the client.
    const row = colonyRowOf((await boundCall(held, webSessionID, planetBindSpec(planetID), "GetPlanetInfo", [], null)).result);
    if (row === null) {
      continue;
    }
    const carried = await boundCall(held, webSessionID, planetBindSpec(planetID), "GetPlanetResourceInfo", [], null);
    colonies.push({ ...projectColony(staticData, row), resources: projectPlanetResources(staticData, resourceRecordOf(carried.result)) });
  }
  colonies.sort((left, right) => (
    String(left.planetName || "").localeCompare(String(right.planetName || ""))
    || left.planetID - right.planetID
  ));
  return { coloniesReadable: true, colonies };
}

// The server's own classification of planetary goods: category 42 is Planetary
// Resources (what an extractor pulls up), 43 Planetary Commodities (everything
// a factory makes). By category, never by a list of item ids.
const PLANETARY_CATEGORY_IDS = new Set([42, 43]);
const SHIP_CATEGORY_ID = 6;

/**
 * Every planetary good this pilot owns outside its colonies, and where it sits
 * (R108 slice 5).
 *
 * ⚠ NO SESSION, LIKE THE COLONIES. The gateway snapshot carries every item the
 * character owns, plus the parents of those items, owner-filtered on the server
 * (listItemsForCharacter). Reading stock this way brings nobody online.
 *
 * Each stack is walked up through what holds it (a ship's cargo, a container)
 * to the place it is docked, so a unit is always said with its place. Stacks of
 * one type in one holder are summed: the planner needs "how much, where", not
 * item ids. Corporation-owned goods are not here; the snapshot is filtered to
 * the character as owner.
 *
 * `wanted` (R109): a Set of type ids to keep INSTEAD of the planetary goods,
 * for the Industry Manager, which needs the materials of one build tree.
 * Absent, this is the planetary read exactly as it was.
 */
function stockFromSnapshot(staticDataSource, snapshot, wanted = null) {
  const rawItems = snapshot && snapshot.items;
  const items = Array.isArray(rawItems)
    ? rawItems
    : rawItems && typeof rawItems === "object" ? Object.values(rawItems) : [];
  const byItemID = new Map();
  for (const item of items) {
    const itemID = Number(item && item.itemID) || 0;
    if (itemID > 0) {
      byItemID.set(itemID, item);
    }
  }
  const stacks = new Map();
  for (const item of items) {
    if (!item || !(wanted ? wanted.has(Number(item.typeID)) : PLANETARY_CATEGORY_IDS.has(Number(item.categoryID)))) {
      continue;
    }
    const typeID = Number(item.typeID) || 0;
    const quantity = Number(item.stacksize) > 0 ? Number(item.stacksize) : Number(item.quantity) || 0;
    if (typeID <= 0 || quantity <= 0) {
      continue;
    }
    let holder = "hangar";
    let holderName = null;
    let locationID = Number(item.locationID) || 0;
    // Bounded: a corrupt parent chain must not spin.
    for (let depth = 0; depth < 8 && byItemID.has(locationID); depth += 1) {
      const parent = byItemID.get(locationID);
      if (holder === "hangar") {
        holder = Number(parent.categoryID) === SHIP_CATEGORY_ID ? "ship" : "container";
        holderName = typeof parent.itemName === "string" && parent.itemName.length > 0
          ? parent.itemName
          : staticDataSource.getTypeName(Number(parent.typeID) || 0);
      }
      locationID = Number(parent.locationID) || 0;
    }
    const station = locationID > 0 && typeof staticDataSource.getStation === "function"
      ? staticDataSource.getStation(locationID)
      : null;
    const key = `${typeID}:${locationID}:${holder}:${holderName || ""}`;
    const known = stacks.get(key);
    if (known) {
      known.quantity += quantity;
      continue;
    }
    stacks.set(key, {
      typeID,
      typeName: staticDataSource.getTypeName(typeID),
      quantity,
      locationID: locationID > 0 ? locationID : null,
      // Null when the place is not a station the static map knows (a
      // structure, or somewhere in space): the browser words that, never an id.
      locationName: station && station.stationName ? String(station.stationName) : null,
      holder,
      holderName,
    });
  }
  return [...stacks.values()].sort((left, right) => left.typeID - right.typeID);
}

/**
 * GET /api/bridge/planets — every colony this character owns.
 *
 * ⚠ THE FACT, NOT A GUESS (the worldHasNoContracts rule). "The snapshot carried
 * a colony table and none of it is yours" is a different statement from "this
 * gateway did not report colonies at all", and only the first one justifies
 * telling a player they have no colonies. `coloniesReadable` carries which one
 * happened; a read that throws never reaches here at all.
 */
app.get("/api/bridge/planets", requireAuth, async (req, res, next) => {
  const held = requireHeldBridgeSession(req, res);
  if (!held) {
    return;
  }
  try {
    // A pilot on the game port: its colonies as the retail client reads them, on
    // the pilot's own session and not from the gateway's snapshot of the store.
    if (Boolean(gamePortPilots) && isGamePortHandle(held.bridgeSessionID)) {
      const { coloniesReadable, colonies } = await coloniesAsTheClientReads(held, req.webSessionID);
      res.json({ ok: true, characterID: held.characterID, serverNowMs: Date.now(), coloniesReadable, colonies });
      return;
    }
    const snapshot = await gateway.getSnapshot(req.account.accountID, held.characterID);
    if (!snapshot) {
      res.status(404).json({
        ok: false,
        error: "CHARACTER_NOT_FOUND",
        message: "That character was not found.",
      });
      return;
    }
    const { coloniesReadable, colonies } = coloniesFromSnapshot(snapshot);
    res.json({
      ok: true,
      characterID: held.characterID,
      serverNowMs: Date.now(),
      coloniesReadable,
      colonies,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/roster/planets — the PI Manager's read (R108 slice 3): the colonies
 * of every pilot asked about, with NONE of them selected.
 *
 * ⚠ NO HELD SESSION, AND THAT WAS PROVED, NOT ASSUMED. /api/bridge/planets
 * above takes its character from the tab's selection because it was written
 * that way; the gateway underneath does not need one. GET /snapshot is gated by
 * validateOwnedCharacter alone, and its colony table is filtered by ownerID out
 * of persisted state — no session map, no online flag. Probed live on
 * 2026-09-23 against a logged-out pilot that owned colonies: they came back,
 * owner-filtered, while a pilot on the same account with none came back with a
 * table that was present and empty. Selecting a character is for ACTING on a
 * colony, and that goes through the bot host, never through here.
 *
 * The shape is deliberately the roster's: `characterIDs` from the
 * browser, each asked with the CALLER's accountID so the gateway refuses what
 * the account does not own, and a refused or failed pilot LEFT OUT — the board
 * keeps the reading it had rather than wiping a farmer's colonies on one bad
 * read. Present-with-no-colonies is the positive statement "has not built".
 *
 * EVERY PILOT CARRIES ITS OWN READ INSTANT. `readAtMs` is stamped when THAT
 * pilot's read landed, not once for the answer: several pilots read in
 * parallel are still several moments, and a board that merged them under one
 * stamp would present them as a snapshot they never were. The envelope's
 * `serverNowMs` is a different thing — the clock sample taken as the answer
 * leaves, which is what the browser corrects its own clock against. Folding
 * the two together would skew that correction by however long the slowest
 * read took.
 *
 * THE SAME SNAPSHOT CARRIES THE PILOT'S STOCK (R108 slice 5). `stock` is every
 * planetary good the pilot owns outside its colonies, with where it sits, and
 * each colony carries its planet's resource qualities — so the planner needs
 * no second read and no session. See stockFromSnapshot.
 */
const ROSTER_PLANETS_MAX_IDS = 12;

app.get("/api/roster/planets", requireAuth, async (req, res, next) => {
  const characterIDs = rosterCharacterIDs(req.query.characterIDs);
  if (characterIDs.length === 0) {
    res.json({ ok: true, pilots: [] });
    return;
  }
  if (characterIDs.length > ROSTER_PLANETS_MAX_IDS) {
    res.status(400).json({
      ok: false,
      error: "TOO_MANY_CHARACTERS",
      message: `Ask about at most ${ROSTER_PLANETS_MAX_IDS} pilots at a time.`,
    });
    return;
  }
  try {
    const pilots = await Promise.all(
      characterIDs.map(async (characterID) => {
        let snapshot = null;
        try {
          snapshot = await gateway.getSnapshot(req.account.accountID, characterID);
        } catch (error) {
          // Not ours, not there, or the gateway stumbled. Say nothing about this
          // pilot; the board keeps the reading it had.
          void error;
          return null;
        }
        const readAtMs = Date.now();
        if (!snapshot) {
          return null;
        }
        const character = snapshot.characters && typeof snapshot.characters === "object"
          ? snapshot.characters[String(characterID)]
          : null;
        const corporationID = Number(character && character.corporationID) || 0;
        let skills = null;
        try {
          skills = await accountSkillSheet(req.account.accountID, characterID);
        } catch (error) {
          // The colonies still stand; only the slot count goes unknown.
          void error;
        }
        return {
          characterID,
          readAtMs,
          // Which corporation's hangars this pilot could read, if it were online.
          corporationID: corporationID > 0 ? corporationID : null,
          ...coloniesFromSnapshot(snapshot),
          stock: stockFromSnapshot(staticData, snapshot),
          planetSkills: planetSkillsFrom(skills),
        };
      }),
    );
    res.json({
      ok: true,
      serverNowMs: Date.now(),
      pilots: pilots.filter((pilot) => pilot !== null),
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/pi/customs-export — send the ticked colonies' launchpad goods up
 * into their own customs offices, so a hauler can collect them from one place
 * per planet instead of chasing containers through space.
 *
 * ⚠ THIS ONE ROUTE DOES NOT SPEAK THE GATEWAY. Every other write here goes
 * through the web gateway, and the gateway's allowlist does not carry
 * invbroker.ImportExportWithPlanet — the call the retail client makes when a
 * player launches from a colony to its customs office. It carries the
 * command-centre launch (planetMgr.UserLaunchCommodities, which drops a
 * container in space) and nothing else. So this route opens the GAME PORT and
 * makes the retail call itself (src/gameClient.js, src/piCustomsExport.js).
 * Nothing is patched on the server, and no new gateway pair is asked for.
 *
 * ⚠ IT EVICTS WHOEVER HOLDS THE PILOT, SO IT CHECKS FIRST AND HANDS BACK
 * AFTER. A character may be in game on ONE session: the select this route
 * makes logs out the session that held it. So
 *   • a pilot a server bot is flying is REFUSED, with the bot named — stopping
 *     a run mid-script to launch its own cargo is never what was meant;
 *   • a pilot ANOTHER tab holds is REFUSED, for the same reason;
 *   • the CALLER's own pilot is re-selected the moment the hop is done, on the
 *     same web session, so the tab has it back. That is the only eviction this
 *     route causes and it undoes it.
 * A pilot nobody holds — the ordinary case, because the haul's bot has not
 * started yet — costs nothing at all.
 *
 * ⚠ NO CONNECTION WHEN THERE IS NOTHING TO SEND. The colonies are read first,
 * out of the gateway snapshot (coloniesFromSnapshot — no session, nobody
 * brought online), and a pilot whose ticked launchpads are all empty is
 * answered without the game port ever being opened. Clicking Haul twice does
 * not log anybody out twice.
 *
 * The answer is per planet, in the order asked, each saying what happened to
 * it: `exported` with the unit count, or a `reason` and the server's own words.
 * One planet's refusal never stops another's — a pad a route drained between
 * the read and the call is an ordinary race, and the rest of the haul is still
 * worth launching.
 */
const PI_CUSTOMS_EXPORT_MAX_PLANETS = 24;
const PI_CUSTOMS_EXPORT_RESTORE_ATTEMPTS = 21;
const PI_CUSTOMS_EXPORT_RESTORE_POLL_MS = 100;

app.post("/api/pi/customs-export", requireAuth, async (req, res, next) => {
  if (!requireWriteConfirmation(req, res, "This launches those colonies' launchpad goods into their customs offices, which charge export tax, and briefly logs the pilot out of this tab. Confirm to continue.")) {
    return;
  }
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const characterID = Number(body.characterID) || 0;
  const planetIDs = bridgeIDList(body.planetIDs);
  if (!Number.isSafeInteger(characterID) || characterID <= 0 || planetIDs.length === 0) {
    res.status(400).json({
      ok: false,
      error: "INVALID_REQUEST",
      message: "A pilot and at least one planet are required.",
    });
    return;
  }
  if (planetIDs.length > PI_CUSTOMS_EXPORT_MAX_PLANETS) {
    res.status(400).json({
      ok: false,
      error: "TOO_MANY_PLANETS",
      message: `Launch from at most ${PI_CUSTOMS_EXPORT_MAX_PLANETS} colonies at a time.`,
    });
    return;
  }
  try {
    const character = await store.getCharacterForAccount(req.account.accountID, characterID);
    if (!character) {
      res.status(404).json({ ok: false, error: "CHARACTER_NOT_FOUND" });
      return;
    }
    // A pilot on the game port: the haul's own run sends each colony's
    // launchpads up at its customs office, on the pilot's session, as the
    // retail client's customs window does (/api/bridge/planet/customs/export).
    // Nothing is sent from here, so nobody is logged in, logged out or read.
    if (typeof gateway.getSelectTransport === "function" && gateway.getSelectTransport({
      accountID: Number(req.account.accountID),
      characterID,
      userName: String(req.account.username || ""),
    }) === "gameport") {
      res.json({
        ok: true,
        atTheOffices: true,
        connected: false,
        handedBack: null,
        planets: planetIDs.map((planetID) => ({
          planetID,
          planetName: null,
          solarSystemID: 0,
          solarSystemName: null,
          officeID: null,
          exported: false,
          units: 0,
          reason: "at-the-office",
          message: null,
        })),
      });
      return;
    }
    // Reserve before any asynchronous ownership or snapshot read, including
    // exports for an offline pilot. Selection, bot handoff and another export
    // must not acquire this pilot while the game connection is being prepared.
    if (characterOperations.has(characterID) || sessionOperations.has(req.webSessionID)) {
      res.status(409).json({ ok: false, error: "CHARACTER_IN_USE", message: "A pilot ownership change is already in progress." });
      return;
    }
    const reservation = Symbol("customs-export");
    characterOperations.set(characterID, reservation);
    sessionOperations.set(req.webSessionID, reservation);
    let releasedCaller = false;
    let holding = false;
    let handedBack = null;
    try {
      // ONE HULL, ONE DRIVER — the same rule /api/bridge/select keeps, for the
      // same reason: the select below would take the ship out from under them.
      if (botHost.claimedBy(characterID) !== null) {
        res.status(409).json({
          ok: false,
          error: "CHARACTER_IN_USE_BY_BOT",
          message: "A server bot is flying this pilot. Stop the bot first.",
        });
        return;
      }
      const held = bridgeSessions.get(req.webSessionID) ?? null;
      const heldHere = held !== null && Number(held.characterID) === characterID;
      let callerRecoveryProof = null;
      const dockedIdentity = (flight) => {
        const shipID = Number(flight?.shipID);
        const stationID = Number(flight?.stationID) || null;
        const structureID = Number(flight?.structureID) || null;
        if (flight?.docked !== true || !Number.isSafeInteger(shipID) || shipID <= 0 ||
            !((Number.isSafeInteger(stationID) && stationID > 0) ||
              (Number.isSafeInteger(structureID) && structureID > 0))) return null;
        return { shipID, stationID, structureID };
      };
      if (await isCharacterHeld(characterID, req.webSessionID, null, reservation)) {
        res.status(409).json({
          ok: false,
          error: "CHARACTER_IN_USE",
          message: "Another tab is flying this pilot. Log it out there first.",
        });
        return;
      }
      const snapshot = await gateway.getSnapshot(req.account.accountID, characterID);
      const { coloniesReadable, colonies } = coloniesFromSnapshot(snapshot);
      if (!coloniesReadable) {
        res.status(502).json({ ok: false, error: "CUSTOMS_EXPORT_UNREADABLE", message: "The pilot's colonies could not be read. Nothing was launched." });
        return;
      }
      // ⚠ THE PLAN DECIDES WHETHER ANYBODY IS LOGGED OUT. The hop is what costs a
      // session, and it only happens when a ticked launchpad is holding something
      // -- so the plan is read FIRST and a pilot with nothing to send is never
      // released at all. Without this the tab's pilot blinked out and back on
      // every Haul, including the ones that had nothing to launch.
      const plan = planCustomsExports(colonies, planetIDs);
      const willConnect = plan.some((entry) => entry.pads.length > 0);
      holding = heldHere && willConnect;
      if (holding) {
        gamePortHolds.set(req.webSessionID, Date.now() + GAME_PORT_HOLD_MS);
      }
      const assertNoTransition = () => {
        if (held.transitionReservation || (held.transition && held.transition.phase !== "ready")) {
          throw Object.assign(new Error("Finish the pilot's session change before exporting from its colonies."),
            { code: "SESSION_CHANGE_IN_PROGRESS", statusCode: 409 });
        }
      };
      if (willConnect) {
        if (heldHere) {
          assertNoTransition();
          if (hasPendingRecovery(held, characterID)) {
            res.status(409).json({ ok: false, error: "DRONE_RECOVERY_PENDING", message: "Finish this pilot's lost-drone recovery before exporting from its colonies." });
            return;
          }
          const status = await readHeldFlight(held, req.webSessionID);
          assertNoTransition();
          if (status?.flight?.docked !== true) {
            res.status(409).json({ ok: false, error: "CUSTOMS_EXPORT_REQUIRES_DOCKED", message: "Dock this pilot before exporting from its colonies." });
            return;
          }
          const identity = dockedIdentity(status.flight);
          if (identity && held.droneRecoveryReady === true &&
              Number(held.activeShipID) === identity.shipID && Number(held.accountID) === Number(req.account.accountID)) {
            callerRecoveryProof = identity;
          }
        } else {
          // A BFF handle is not the only way to fly a pilot. Refuse an existing
          // retail/other controller too, rather than letting TCP select evict it.
          const status = await gateway.getCharacterStatus(req.account.accountID, characterID);
          if (status?.characterID !== characterID || status.online !== false || status.controlState !== "offline") {
            res.status(409).json({ ok: false, error: "CHARACTER_IN_USE", message: "This pilot is online or its ownership could not be confirmed. Log it out before exporting." });
            return;
          }
          const saved = snapshot?.characters?.[String(characterID)];
          const stationID = Number(saved?.stationID ?? saved?.stationid);
          const structureID = Number(saved?.structureID ?? saved?.structureid);
          if (!(Number.isSafeInteger(stationID) && stationID > 0) && !(Number.isSafeInteger(structureID) && structureID > 0)) {
            res.status(409).json({ ok: false, error: "CUSTOMS_EXPORT_REQUIRES_DOCKED", message: "Dock this pilot before exporting from its colonies." });
            return;
          }
        }
      }
      const assertExportOwnership = (expectedHeld = releasedCaller ? null : held) => {
        const payload = auth.verifySessionToken(readSessionToken(req));
        if (characterOperations.get(characterID) !== reservation || sessionOperations.get(req.webSessionID) !== reservation ||
            (bridgeSessions.get(req.webSessionID) ?? null) !== expectedHeld ||
            botHost.claimedBy(characterID) !== null || payload?.sessionID !== req.webSessionID ||
            Number(payload.accountID) !== Number(req.account.accountID)) {
          throw Object.assign(new Error("The original pilot session can no longer be safely restored."),
            { code: "CHARACTER_IN_USE", statusCode: 409 });
        }
      };
      const confirmOffline = async (attempts = 1) => {
        for (let attempt = 0; attempt < attempts; attempt++) {
          assertExportOwnership();
          const heldElsewhere = await isCharacterHeld(characterID, req.webSessionID, null, reservation);
          assertExportOwnership();
          if (heldElsewhere) break;
          const status = await gateway.getCharacterStatus(req.account.accountID, characterID);
          assertExportOwnership();
          if (status?.characterID === characterID && status.online === false && status.controlState === "offline") return;
          if (attempt + 1 < attempts) {
            await new Promise((resolve) => setTimeout(resolve, PI_CUSTOMS_EXPORT_RESTORE_POLL_MS));
          }
        }
        throw Object.assign(new Error("This pilot is online or its ownership could not be confirmed. Log it out before exporting."),
          { code: "CHARACTER_IN_USE", statusCode: 409 });
      };
      let outcome;
      try {
        if (holding) {
          // One client session per web login, as the select route puts it: the
          // game port is about to take this character, so let go of it here first.
          await releaseHeldBridgeSession(req.webSessionID, { confirmed: true });
          releasedCaller = true;
        }
        outcome = await runCustomsExport({
          accountName: req.account.username,
          characterID,
          colonies,
          planetIDs,
          plan,
          createClient: gameClientFactory,
          // Login can take seconds. Recheck immediately before the takeover-capable
          // select, even though the pilot was offline when the plan was read.
          beforeSelect: () => confirmOffline(),
          log: (line) => console.log(`[PI customs export] character ${characterID}: ${line}`),
        });
      } finally {
        // Restore a definitely released caller even if game login/select failed.
        // The reservation and fresh auth/ownership checks keep rollback from
        // replacing a newer controller or resurrecting an expired login.
        if (releasedCaller) {
          try {
            // Local close precedes the server's socket cleanup. Wait briefly for
            // authoritative offline status; never select over an online driver.
            await confirmOffline(PI_CUSTOMS_EXPORT_RESTORE_ATTEMPTS);
            assertExportOwnership();
            await selectHeldCharacter(req.webSessionID, req.account, characterID);
            handedBack = true;
            // This caller completed recovery before the docked hop. Carry that
            // proof only across a fresh return to the same pilot, hull and dock.
            // Ordinary selection and an unknown/changed return remain gated.
            const restored = bridgeSessions.get(req.webSessionID);
            if (callerRecoveryProof && Number(restored?.characterID) === characterID &&
                Number(restored.accountID) === Number(req.account.accountID) &&
                Number(restored.activeShipID) === callerRecoveryProof.shipID) {
              try {
                assertExportOwnership(restored);
                const returned = dockedIdentity((await readHeldFlight(restored, req.webSessionID))?.flight);
                assertExportOwnership(restored);
                if (returned && returned.shipID === callerRecoveryProof.shipID &&
                    returned.stationID === callerRecoveryProof.stationID && returned.structureID === callerRecoveryProof.structureID) {
                  restored.droneRecoveryReady = true;
                }
              } catch (error) {
                errorLogger(error);
              }
            }
          } catch (error) {
            errorLogger(error);
            handedBack = false;
          }
        }
      }
      res.json({
        ok: true,
        connected: outcome.connected,
        handedBack,
        planets: outcome.results.map((entry) => ({
          planetID: entry.planetID,
          planetName: entry.planetName,
          solarSystemID: entry.solarSystemID,
          solarSystemName: entry.solarSystemName,
          officeID: entry.officeID,
          exported: entry.exported,
          units: entry.units,
          reason: entry.reason,
          message: entry.message,
        })),
      });
    } finally {
      if (holding) gamePortHolds.delete(req.webSessionID);
      if (sessionOperations.get(req.webSessionID) === reservation) sessionOperations.delete(req.webSessionID);
      if (characterOperations.get(characterID) === reservation) characterOperations.delete(characterID);
    }
  } catch (error) {
    next(error);
  }
});

/**
 * R109 slice 4 -- what the roster pilots hold of ONE build tree's materials.
 *
 * The roster planets read above, with its stock walk pointed at a list of type
 * ids instead of the planetary goods. The same rules hold: the gateway
 * snapshot answers for any pilot the signed-in account owns, with NO session
 * and nobody brought online; a pilot that is not ours, or that the gateway
 * cannot read, is left out of the answer rather than reported as empty; every
 * pilot carries its own read instant.
 *
 * POST, because a capital's tree names a few hundred types.
 */
const ROSTER_STOCK_MAX_TYPES = 2000;

app.post("/api/roster/stock", requireAuth, async (req, res, next) => {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const characterIDs = rosterCharacterIDs(Array.isArray(body.characterIDs) ? body.characterIDs.join(",") : "");
  const typeIDs = new Set();
  for (const value of Array.isArray(body.typeIDs) ? body.typeIDs : []) {
    const typeID = Number(value) || 0;
    if (Number.isSafeInteger(typeID) && typeID > 0) {
      typeIDs.add(typeID);
    }
  }
  if (characterIDs.length > ROSTER_PLANETS_MAX_IDS) {
    res.status(400).json({
      ok: false,
      error: "TOO_MANY_CHARACTERS",
      message: `Ask about at most ${ROSTER_PLANETS_MAX_IDS} pilots at a time.`,
    });
    return;
  }
  if (typeIDs.size > ROSTER_STOCK_MAX_TYPES) {
    res.status(400).json({
      ok: false,
      error: "TOO_MANY_TYPES",
      message: `Ask about at most ${ROSTER_STOCK_MAX_TYPES} kinds of item at a time.`,
    });
    return;
  }
  if (characterIDs.length === 0 || typeIDs.size === 0) {
    res.json({ ok: true, serverNowMs: Date.now(), pilots: [] });
    return;
  }
  try {
    const pilots = await Promise.all(
      characterIDs.map(async (characterID) => {
        let snapshot = null;
        try {
          snapshot = await gateway.getSnapshot(req.account.accountID, characterID);
        } catch (error) {
          // Not ours, not there, or the gateway stumbled: say nothing about it.
          void error;
          return null;
        }
        const readAtMs = Date.now();
        if (!snapshot) {
          return null;
        }
        const character = snapshot.characters && typeof snapshot.characters === "object"
          ? snapshot.characters[String(characterID)]
          : null;
        const corporationID = Number(character && character.corporationID) || 0;
        return {
          characterID,
          readAtMs,
          corporationID: corporationID > 0 ? corporationID : null,
          stock: stockFromSnapshot(staticData, snapshot, typeIDs),
        };
      }),
    );
    res.json({ ok: true, serverNowMs: Date.now(), pilots: pilots.filter((pilot) => pilot !== null) });
  } catch (error) {
    next(error);
  }
});

// --- R71 plumbing sweep: Phase-1 DATA finisher (PI + asset-safety + strays)
// Its read routes, made for no screen of the page's, went on 2026-10-14 (the loop's item 64): nothing asked them.

// --- R5b Travel: client-side route solver static data ----------------------
// The browser autopilot's route solver is client-side (roadmap §7 / G2): the
// system-adjacency graph it runs BFS over is read-only static reference data
// (like station names), served here from src/staticData.js. This is NOT a
// gateway/bridge call and NOT a server-side travel job — no live bridge session
// is touched. Requires the web login session (as every /api route does).
/** appConst.factionTriglavian. */
const FACTION_TRIGLAVIAN = 500026;
app.get("/api/map/graph", requireAuth, async (req, res, next) => {
  try {
    const graph = staticData.getSolarSystemGraph();
    // Each system's security as it was made, for the route the client's autopilot plots, which goes by it
    // (web/src/nav/autopilotRoute.ts). A system with none in the data is left out.
    const security = {};
    // And the systems of the Triglavian Collective, which the client's star map takes for no destination from outside
    // them (idCheckers.IsTriglavianSystem: the system's factionID, appConst.factionTriglavian 500026).
    const triglavian = [];
    // And each system's constellation and region, by which the client's pathfinder takes a constellation or a region
    // on the avoidance list for its systems, and its route window names where each place is (mapSvc.ExpandItems and
    // GetParent, from cfg.mapSystemCache).
    const within = {};
    for (const id of Object.keys(graph.systems)) {
      const system = staticData.getSolarSystem(Number(id));
      if (system && typeof system.security === "number") {
        security[id] = system.security;
      }
      if (system && Number(system.factionID) === FACTION_TRIGLAVIAN) {
        triglavian.push(Number(id));
      }
      if (system && Number(system.constellationID) > 0 && Number(system.regionID) > 0) {
        within[id] = [Number(system.constellationID), Number(system.regionID)];
      }
    }
    res.json({
      ok: true,
      source: "static-data",
      systemCount: Object.keys(graph.systems).length,
      edgeCount: graph.edges.length,
      systems: graph.systems,
      edges: graph.edges,
      security,
      triglavian,
      within,
    });
  } catch (error) {
    next(error);
  }
});

// The security of solar systems, by ID, from the static reference data: the level each system was made
// with, which is what the retail client keeps with its own static data and shows beside a place's name.
// An ID that is no system's is null (as is a level that is not a number, which JSON writes as null).
// Bounded: at most 200 a request.
const SECURITY_REQUEST_LIMIT = 200;
app.post("/api/map/security", requireAuth, (req, res) => {
  const asked = Array.isArray(req.body && req.body.ids) ? req.body.ids : [];
  const ids = asked.filter((id) => Number.isSafeInteger(id) && id > 0).slice(0, SECURITY_REQUEST_LIMIT);
  const security = {};
  for (const id of ids) {
    const system = staticData.getSolarSystem(id);
    security[id] = system && typeof system.security === "number" ? system.security : null;
  }
  res.json({ ok: true, security });
});

// Resolve a picked destination (a courier destination is a station; the route
// solver works on systems) to its solar system, from static reference data —
// the same client-local resolution the select route does for station identity.
app.get("/api/map/resolve/:id", requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id) || 0;
    if (id <= 0) {
      res.status(400).json({ ok: false, error: "INVALID_ID", message: "A positive id is required." });
      return;
    }
    const station = staticData.getStation(id);
    if (station) {
      const solarSystemID = Number(station.solarSystemID) || null;
      res.json({
        ok: true,
        id,
        kind: "station",
        stationID: id,
        stationName: String(station.stationName || `Station ${id}`),
        // (Its type, which the client's star map takes for no destination where it is a deprecated station's:
        // idCheckers.IsDeprecatedStation.)
        stationTypeID: Number(station.stationTypeID) || null,
        solarSystemID,
        systemName: solarSystemID ? staticData.getSolarSystemName(solarSystemID) : null,
      });
      return;
    }
    const system = staticData.getSolarSystem(id);
    if (system) {
      res.json({
        ok: true,
        id,
        kind: "system",
        stationID: null,
        stationName: null,
        solarSystemID: id,
        systemName: staticData.getSolarSystemName(id),
      });
      return;
    }
    // R38 — the static tables have no answer, but a player structure is a legal
    // destination and is runtime data. This is the SECOND consumer of the one
    // shared structure resolver (the first is /api/names); Travel and the
    // flight readout reach a structure name through here. A structure that
    // cannot be resolved still falls through to kind:"unknown" below, so the
    // honest fallback is unchanged when the lookup genuinely fails.
    let structureLookupFailed = false;
    if (isPlayerStructureID(id)) {
      const { records, failed } = await resolveRuntimeStructureNames(req, [id]);
      structureLookupFailed = failed.has(id);
      const record = records.get(id);
      const structureName = record ? record.name : null;
      if (typeof structureName === "string") {
        // GetStructureInfo carries the structure's solar system in the SAME
        // payload as the name, so Travel gets a routable system for free.
        const solarSystemID = record.solarSystemID;
        res.json({
          ok: true,
          id,
          kind: "structure",
          structureID: id,
          structureName,
          // A structure is dockable, so the existing station-shaped consumers
          // (which read stationID/stationName) keep working unchanged rather
          // than every caller having to learn a new shape.
          stationID: id,
          stationName: structureName,
          solarSystemID,
          systemName: solarSystemID ? staticData.getSolarSystemName(solarSystemID) : null,
          // Stated rather than implied: this resolved, so the caller may cache it.
          lookupFailed: false,
        });
        return;
      }
    }
    // ⚠ THE FACT, NOT A GUESS. "Nothing in the world bears this ID" and "we
    // could not ask" both land on kind:"unknown", but only the first justifies
    // the client caching the miss. `lookupFailed` separates them so a structure
    // we simply could not reach is retried instead of being written off.
    res.json({
      ok: true,
      id,
      kind: "unknown",
      stationID: null,
      stationName: null,
      solarSystemID: null,
      systemName: null,
      lookupFailed: structureLookupFailed,
    });
  } catch (error) {
    next(error);
  }
});

// Read-only static station identity by ID (goal R6b): the same client-local
// resolution the select route returns for the docked station, exposed so the
// web app can refresh the Station panel's identity (name / system / region /
// type / security) after the docked station changes (autopilot arrival, manual
// dock) without a full page reload. Read-only static reference data like
// /api/map/graph and /api/map/resolve — NOT a gateway/bridge call.
app.get("/api/map/station/:id", requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id) || 0;
    if (id <= 0) {
      res.status(400).json({ ok: false, error: "INVALID_ID", message: "A positive id is required." });
      return;
    }
    // Only resolve a real station record (buildStationStatic otherwise returns a
    // "Station <id>" fallback for any positive ID); an unknown ID is a 404.
    if (!staticData.getStation(id)) {
      res.status(404).json({ ok: false, error: "STATION_NOT_FOUND" });
      return;
    }
    res.json({ ok: true, source: "static-data", station: buildStationStatic(id) });
  } catch (error) {
    next(error);
  }
});

// A solar system's region and its NPC stations with their celestialIndex and orbitIndex (staticData.getSystemStations:
// the client's own map data, cfg.GetLocationsLocalBySystem), for the multibuy's station list. Static reference data.
app.get("/api/map/system-stations/:id", requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id) || 0;
    if (id <= 0) {
      res.status(400).json({ ok: false, error: "INVALID_ID", message: "A positive id is required." });
      return;
    }
    const system = staticData.getSolarSystem(id);
    res.json({ ok: true, regionID: system && Number(system.regionID) > 0 ? Number(system.regionID) : null, stations: staticData.getSystemStations(id) });
  } catch (error) {
    next(error);
  }
});

// Map name search (goal R7a): let a player set a travel destination by NAME
// instead of a raw EVE ID. Searches the static solar-system + station tables by
// name and returns capped matches the client hands to startRoute (the R5b route
// solver + autopilot). Read-only static reference data — like /api/map/graph and
// /api/agents/find, NOT a gateway/bridge call. Filters by q (min 2 chars) and an
// optional kind (system|station; default both); caps server-side (default 50 /
// max 200) so a broad query never dumps the whole table.
app.get("/api/map/find", requireAuth, async (req, res, next) => {
  try {
    const q = typeof req.query.q === "string" ? req.query.q : "";
    const kind = typeof req.query.kind === "string" ? req.query.kind : undefined;
    const limit = req.query.limit !== undefined ? Number(req.query.limit) : undefined;
    const result = staticData.findMapLocations({ q, kind, limit });
    res.json({
      ok: true,
      source: "static-data",
      q: result.q,
      kind: result.kind,
      total: result.total,
      capped: result.capped,
      limit: result.limit,
      count: result.matches.length,
      matches: result.matches,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * R16 market ITEM SEARCH — how a player picks what to trade.
 *
 * The browser never knows a typeID and must never ask the player for one
 * (R7d), so the market panel searches the static type table by NAME, exactly as
 * /api/map/find searches systems and stations. Read-only static reference data;
 * NOT a gateway/bridge call, so it works before (and independently of) the
 * market daemon.
 *
 * Only PUBLISHED types that belong to a market group are offered: the table
 * also holds test objects and internal placeholders that no market will ever
 * list, and offering one would produce a server refusal the player could make
 * no sense of.
 */
/**
 * R17 mail RECIPIENT SEARCH — how a player picks who to write to.
 *
 * ⚠ THIS IS THE ONE PLACE THE NAMES RULE RUNS BACKWARDS. R7d says the player
 * never sees a numeric ID; composing a message needs the opposite direction —
 * a name typed by the player turned into the characterID SendMail's args[0]
 * wants. Asking the player for an ID would be exactly what R7d forbids, so the
 * name is searched here and the id is carried invisibly.
 *
 * Read-only static reference data, like /api/map/find and /api/market/find —
 * NOT a gateway/bridge call, so it works independently of the live session. The
 * caller's own character is excluded: the server treats a self-addressed
 * message as a sender copy with no recipient, so offering it would be offering
 * a message that goes nowhere.
 */
app.get("/api/characters/find", requireAuth, async (req, res, next) => {
  try {
    const q = typeof req.query.q === "string" ? req.query.q : "";
    const limit = req.query.limit !== undefined ? Number(req.query.limit) : undefined;
    const held = req.webSessionID ? bridgeSessions.get(req.webSessionID) : null;
    const result = staticData.findCharacters({
      q,
      limit,
      excludeCharacterID: held ? held.characterID : 0,
    });
    res.json({
      ok: true,
      source: "static-data",
      q: result.q,
      total: result.total,
      capped: result.capped,
      limit: result.limit,
      count: result.matches.length,
      matches: result.matches,
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/market/find", requireAuth, async (req, res, next) => {
  try {
    const q = typeof req.query.q === "string" ? req.query.q : "";
    const limit = req.query.limit !== undefined ? Number(req.query.limit) : undefined;
    const result = staticData.findMarketTypes({ q, limit });
    res.json({
      ok: true,
      source: "static-data",
      q: result.q,
      total: result.total,
      capped: result.capped,
      limit: result.limit,
      count: result.matches.length,
      matches: result.matches,
    });
  } catch (error) {
    next(error);
  }
});

// The ore families for the bot editor's ore picker: the distinct type GROUPS
// of published Asteroid-category types (goal: mine-ore-priority). Static
// reference data, like /api/market/find — no gateway call.
app.get("/api/ore/families", requireAuth, async (req, res, next) => {
  try {
    const families = staticData.listOreFamilies();
    res.json({
      ok: true,
      source: "static-data",
      count: families.length,
      families,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * R83 — BROWSING THE MARKET BY GROUP.
 *
 * The panel could only be reached by TYPING a name, which is fine when you know
 * what you want and useless when you do not. Both of these are STATIC reference
 * data (the same class as /api/market/find): no gateway call, so browsing works
 * even when the market daemon itself is not answering, and a player can find out
 * what exists before asking what it costs.
 *
 * `parent` absent or 0 returns the ROOTS. An unknown group returns an empty list
 * rather than a 404 — "this group holds nothing" is a real answer the panel
 * renders, and a 404 would make an ordinary empty branch look like a failure.
 */
app.get("/api/market/groups", requireAuth, async (req, res, next) => {
  try {
    const parent = req.query.parent !== undefined ? Number(req.query.parent) : 0;
    const groups = staticData.getMarketGroupChildren(parent);
    res.json({
      ok: true,
      source: "static-data",
      parent: Number.isFinite(parent) ? parent : 0,
      count: groups.length,
      groups,
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/market/group-types", requireAuth, async (req, res, next) => {
  try {
    const group = Number(req.query.group) || 0;
    const result = staticData.getMarketGroupTypes(group);
    res.json({
      ok: true,
      source: "static-data",
      group,
      total: result.total,
      capped: result.capped,
      count: result.types.length,
      types: result.types,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * R38 — PLAYER-STRUCTURE NAMES. The one runtime name read, shared by every
 * name path in this BFF.
 *
 * ⚠ WHY THIS EXISTS AT ALL. Every other name in this app comes from the static
 * SDE, which is why /api/names and /api/map/resolve were both able to be
 * honest "read-only static reference data, NOT a gateway call". A player-owned
 * Upwell structure breaks that assumption: it is created at runtime, lives only
 * in the game store, and appears in NO static table. Both static paths
 * therefore answered "unknown" for a structure that very much has a name, and
 * a docked Astrahus rendered as "an unnamed place".
 *
 * ⚠ THIS IS THE ONLY PLACE A STRUCTURE NAME IS FETCHED. Both /api/names (the
 * batch path Assets/overview/contracts/market use) and /api/map/resolve/:id
 * (the path Travel and the flight readout use) call through here. Resolving a
 * structure name anywhere else — or teaching a panel to call the gateway
 * itself — reintroduces exactly the duplicated mechanic this goal exists to
 * avoid.
 *
 * THE READ: structureDirectory.GetStructureInfo(structureID) -> util.KeyVal.
 * For a structure the caller's corp owns it returns the full directory record;
 * for one it does not own, the public eight-key payload. BOTH carry `itemName`,
 * which is the only field taken here — so this works for any structure, owned
 * or not, docked at or not. Verified live against structure 1030000000001
 * ("Perimeter - asdf", an Astrahus).
 *
 * ⚠ null IS A REAL ANSWER, NOT A FAILURE. GetStructureInfo returns null for a
 * structure that does not exist — confirmed live for an unknown ID, for an NPC
 * station ID, and for 0. That is a DEFINITIVE "this is not a player structure",
 * safe for the client to cache forever. It is categorically different from "we
 * could not ask" (no character online, gateway error), which must NOT be cached
 * as a name-less result or the panel would be stuck on the fallback for the
 * rest of the session. `failed` carries that second case out separately —
 * the `worldHasNoContracts` rule: assert the negative only when the read
 * actually succeeded.
 */

// Retail's structure ID floor. NPC stations live in the 60,000,000 range; every
// player-deployed Upwell structure is allocated above 1e12. Below this, a miss
// in the static station table is a genuine unknown and never worth a round trip.
const STRUCTURE_ID_FLOOR = 1000000000000;

// A names batch can legitimately carry hundreds of IDs, but only a handful can
// ever be structures. GetStructureInfo is per-structure (see the allowlist note
// on why the batch GetStructures is deliberately NOT reachable), so this bounds
// the fan-out a single request can provoke.
const STRUCTURE_NAME_LOOKUP_CAP = 25;

// Structure names change only when someone renames the structure, so a short
// TTL removes the per-panel-load round trip without letting a rename go stale
// for long. Only DEFINITIVE outcomes are cached — never a failure.
//
// ⚠ PROCESS-WIDE, NOT PER-SESSION, AND THAT IS DELIBERATE. A structure's name
// is public: Handle_GetStructureInfo applies no access check and hands its
// public payload — itemName included — to any session that asks, owner or not.
// So one account's cached name tells another account nothing it could not
// fetch for itself, and sharing the cache means the second viewer of a
// structure pays no round trip. Nothing owner-only is cached here: only the
// name, system and type are kept, never the services/fuel/timer fields the
// owner branch also returns.
const STRUCTURE_NAME_TTL_MS = 60000;
const structureNameCache = new Map();

function isPlayerStructureID(id) {
  return Number.isSafeInteger(id) && id >= STRUCTURE_ID_FLOOR;
}

/** idCheckers.IsStation (eve/common/script/sys/idCheckers.py 29 to 30): minStation to maxStation, inventorycommon/const.py 59 and 62. */
function isClientStationID(id) {
  return Number.isSafeInteger(id) && id >= 60000000 && id <= 63999999;
}

function readCachedStructureName(structureID, now) {
  const hit = structureNameCache.get(structureID);
  if (!hit || hit.expiresAt <= now) {
    structureNameCache.delete(structureID);
    return undefined;
  }
  return { name: hit.name, solarSystemID: hit.solarSystemID, typeID: hit.typeID };
}

/**
 * Resolve player-structure IDs on the caller's live session.
 *
 * Returns `{ records, failed }` where `records` maps a structureID to
 * `{ name, solarSystemID, typeID }` — `name` null when the server said "no such
 * structure" — and `failed` holds the IDs that could not be asked about at all.
 * An ID never appears in both.
 *
 * ⚠ The system and type come out of the SAME KeyVal as the name. A caller that
 * needs a structure's system must read it from here rather than making a second
 * call; GetStructureInfo already carries it.
 */
async function resolveRuntimeStructureNames(req, structureIDs, options = {}) {
  const records = new Map();
  const failed = new Set();
  const wanted = [...new Set(structureIDs.filter(isPlayerStructureID))];
  if (wanted.length === 0) {
    return { records, failed };
  }

  const now = Date.now();
  const toFetch = [];
  for (const structureID of wanted) {
    const cached = readCachedStructureName(structureID, now);
    if (cached !== undefined) {
      records.set(structureID, cached);
    } else {
      toFetch.push(structureID);
    }
  }
  if (toFetch.length === 0) {
    return { records, failed };
  }

  // No character online means no session to ask on. That is a FAILURE to look
  // up, not a finding that the structure is nameless — the caller must be able
  // to tell those apart, so these go to `failed` and nothing is cached.
  const held = bridgeSessions.get(req.webSessionID) || null;
  if (!held && !options.publicWithoutHeld) {
    for (const structureID of toFetch) {
      failed.add(structureID);
    }
    return { records, failed };
  }

  const remember = (structureID, record) => {
    records.set(structureID, record);
    structureNameCache.set(structureID, { ...record, expiresAt: now + STRUCTURE_NAME_TTL_MS });
  };

  for (const structureID of toFetch.slice(0, STRUCTURE_NAME_LOOKUP_CAP)) {
    try {
      const outcome = held
        ? await heldTopLevelCall(held, req.webSessionID, "structureDirectory", "GetStructureInfo", [structureID], null)
        : await gateway.callMethod("structureDirectory", "GetStructureInfo", [structureID], null,
          { userid: req.account.accountID });
      const result = outcome && outcome.result;
      if (result === null || result === undefined) {
        // The definitive "not a player structure" — cacheable.
        remember(structureID, { name: null, solarSystemID: null, typeID: null });
        continue;
      }
      const entries = keyValEntries(result);
      const itemName = readKeyValField(entries, "itemName");
      // A structure row with a blank name is a nameless structure (null), not a
      // failed lookup — the empty string must never reach a panel as a label.
      const name =
        typeof itemName === "string" && itemName.trim().length > 0 ? itemName : null;
      remember(structureID, {
        name,
        solarSystemID: Number(readKeyValField(entries, "solarSystemID")) || null,
        typeID: Number(readKeyValField(entries, "typeID")) || null,
      });
    } catch (_error) {
      // Refusal, transport error, reaped session: we do not know. Not cached.
      failed.add(structureID);
    }
  }
  // Anything past the cap was never asked about — also "we do not know".
  for (const structureID of toFetch.slice(STRUCTURE_NAME_LOOKUP_CAP)) {
    failed.add(structureID);
  }
  return { records, failed };
}

// Batch name resolution (goal R7c): the names-everywhere UI pass turns raw IDs
// into names across every tab, so a list of many IDs (an inventory of typeIDs,
// a guest list of corp IDs, ...) resolves in ONE round-trip. POST /api/names
// takes { items: [{kind, id}] } and returns { names: { "kind:id": name } } over
// the existing static getters. Each item is echoed (a name string, or null for a
// definitive unknown the client caches); the batch is capped server-side so an
// oversized request can't scan the whole item table.
//
// R38: no longer PURELY static. Static resolution runs first and answers
// everything it can; only the `station`/`structure` items it could not name AND
// whose ID is above the player-structure floor fall through to the runtime read
// above. A request with no such items still makes zero gateway calls, so the
// common case is unchanged. `unresolved` names the keys whose lookup could not
// be completed — the client must not cache those as "unknown".
// The kinds that can legally denote a place a player structure could be. A
// structure arrives as "station" from every existing caller (Assets asks for
// the location it found an item at, and does not know the difference); the
// explicit "structure" kind is for callers that do.
const STRUCTURE_NAME_KINDS = new Set(["station", "structure"]);
// The names of a player's corporation, alliance or character (the client's
// cfg.eveowners). The static tables name the NPCs' owners. One they cannot
// name, with a player owner's ID, is asked of the game server as the client
// asks it, config.GetMultiOwnersEx, by the game-port transport, which keeps
// every row it is answered (pilots.js ownersNamed). A row's type says what the
// owner is: a corporation, an alliance, a faction, or a character's own type.
const MIN_PLAYER_OWNER_ID = 90000000;
/** const.ownerSystem, and the client's own word for it (eveCfg.py 24, 583, 1186). */
const OWNER_SYSTEM_ID = 1;
const OWNER_SYSTEM_NAME_LABEL = "UI/Chat/ChatEngine/EveSystem";
const OWNER_TYPE = Object.freeze({ corporation: 2, alliance: 16159, faction: 30 });
const OWNER_NAME_KINDS = Object.freeze({
  corporation: (typeID) => typeID === OWNER_TYPE.corporation,
  alliance: (typeID) => typeID === OWNER_TYPE.alliance,
  character: (typeID) => typeID > 0 && !Object.values(OWNER_TYPE).includes(typeID),
  owner: (typeID) => typeID > 0,
  // An owner's group, by name (a mailing list's access lists): any owner's row, its type's group named.
  ownerGroup: (typeID) => typeID > 0,
});

// The retail client's text for localisation labels, for messages by their
// number and for dialogs by their name, as templates: the {parameters} are left in, for the browser to fill
// with the values the server sent and the names it keeps. `available` is
// false when no client install is configured (EVEJS_CLIENT_ROOT); a label or
// a number the client does not have is null. Bounded: at most 200 of each a
// request.
const WORDS_LABEL_LIMIT = 200;
app.post("/api/words", requireAuth, (req, res) => {
  const asked = Array.isArray(req.body && req.body.labels) ? req.body.labels : [];
  const labels = asked.filter((label) => typeof label === "string" && label.length > 0 && label.length <= 200).slice(0, WORDS_LABEL_LIMIT);
  const numbered = Array.isArray(req.body && req.body.messageIDs) ? req.body.messageIDs : [];
  const messageIDs = numbered.filter((messageID) => Number.isSafeInteger(messageID) && messageID > 0).slice(0, WORDS_LABEL_LIMIT);
  // A dialog by its name: its title and its body, and what kind of dialog it is.
  const named = Array.isArray(req.body && req.body.dialogs) ? req.body.dialogs : [];
  const dialogs = named.filter((name) => typeof name === "string" && /^\w{1,100}$/.test(name)).slice(0, WORDS_LABEL_LIMIT);
  res.json({
    ok: true,
    available: clientWords.available(),
    words: clientWords.templates(labels),
    messages: messageIDs.length > 0 ? clientWords.messages(messageIDs) : {},
    dialogs: dialogs.length > 0 ? clientWords.dialogs(dialogs) : {},
  });
});

// A mission as the retail client's own data has it (evemissions/client/data.py
// get_mission): the message IDs of its name, its briefing and what its agent
// says, its content template, and what else the record holds. The client's job
// board words a mission's page from this and asks the server for none of it.
// `available` is false when the table could not be read (no client install, or
// no Python to host the client's loader); a mission the client does not have is
// null.
app.get("/api/client-data/missions/:missionID", requireAuth, async (req, res, next) => {
  const missionID = Number(req.params.missionID);
  if (!Number.isSafeInteger(missionID) || missionID <= 0) {
    res.status(400).json({ ok: false, error: "INVALID_MISSION", message: "A positive missionID is required." });
    return;
  }
  try {
    const found = await clientBuiltData.lookup("missions", missionID);
    res.json({ ok: true, available: found.available, mission: found.row });
  } catch (error) {
    next(error);
  }
});

// Each kind of a wallet journal's entries with the message its line is worded by, as the client's own data has it
// (eveaccounting/data.py get_entry_format_localization_id: the entry type's entryJournalMessageID). The client's
// FmtWalletEntry words a line by it, unless the kind has none or is worded by hand (walletEntryFormat.py 22 to 26).
// `available` is false when the table could not be read (no client install, or no Python to host the client's
// loader); `journalMessageIDs` is then empty.
app.get("/api/client-data/accounting-entry-types", requireAuth, async (req, res, next) => {
  try {
    const table = await clientBuiltData.table("accountingEntryTypes");
    const journalMessageIDs = {};
    for (const [entryTypeID, row] of Object.entries(table || {})) {
      const messageID = row && Number(row.entryJournalMessageID);
      if (Number.isSafeInteger(messageID) && messageID > 0) journalMessageIDs[entryTypeID] = messageID;
    }
    res.json({ ok: true, available: Boolean(table), journalMessageIDs });
  } catch (error) {
    next(error);
  }
});

// Each NPC corporation's faction, as the client's own data has it (npcs/npccorporations.py get_corporation_faction_id:
// the corporation's factionID), what its overview's Faction column names for a thing an NPC owns (overviewWindow.py
// 967 to 975). `available` is false when the table could not be read (no client install, or no Python to host the
// client's loader); `factions` is then empty.
app.get("/api/client-data/corporation-factions", requireAuth, async (req, res, next) => {
  try {
    const table = await clientBuiltData.table("npcCorporations");
    const factions = {};
    for (const [corporationID, row] of Object.entries(table || {})) {
      const factionID = row && Number(row.factionID);
      if (Number.isSafeInteger(factionID) && factionID > 0) factions[corporationID] = factionID;
    }
    res.json({ ok: true, available: Boolean(table), factions });
  } catch (error) {
    next(error);
  }
});

// The skills each type needs and at what level, as the client's own data has them (evetypes/skills.py
// get_dogma_required_skills: the requiredSkillsForTypes table), for the types asked and every skill they lead to, so
// that whoever asks walks them as the client's skill service walks them (skillsvc.py 534 to 595). A type that needs
// none has {}. `available` is false when the table could not be read (no client install, or no Python to host the
// client's loader); `required` is then empty. At most 50 types are asked at once. `order` has each type's needs as
// [[skill, level], ...] in the order the client's table iterates them (its requiredSkill1, 2, 3...), which `required`'s
// object loses on the way: the client's skill plan validation walks them in it.
// The skills that need each of these skills at each level (skillPlanUtil.GetSkillsRequiring: the requiredSkillsIndex
// table's row for the skill, its level's market category 150, every meta group's types together), for the skill plan
// editor's remove lock (EditableSkillPlanController.CanRemoveSkillRequirement). A skill no skill needs has {}.
// `available` is false when the table could not be read. At most 100 skills at once.
app.get("/api/client-data/skills-requiring", requireAuth, async (req, res, next) => {
  try {
    const asked = [];
    for (const part of String((req.query && req.query.typeIDs) || "").split(",")) {
      const typeID = Number(part);
      if (Number.isSafeInteger(typeID) && typeID > 0 && !asked.includes(typeID)) asked.push(typeID);
    }
    const rows = asked.length === 0 ? {} : await clientBuiltData.rows("requiredSkillsIndex", asked.slice(0, 100));
    const requiring = {};
    if (rows) {
      for (const typeID of asked.slice(0, 100)) {
        const row = rows[String(typeID)];
        const byLevel = {};
        if (row && typeof row === "object") {
          for (const [level, byCategory] of Object.entries(row)) {
            const skills = byCategory && typeof byCategory === "object" ? byCategory["150"] : null;
            if (!skills || typeof skills !== "object") continue;
            byLevel[level] = Object.values(skills).flatMap((types) => (Array.isArray(types) ? types.map(Number).filter(Number.isSafeInteger) : []));
          }
        }
        requiring[typeID] = byLevel;
      }
    }
    res.json({ ok: true, available: Boolean(rows), requiring });
  } catch (error) {
    next(error);
  }
});

// The certified skill plans and the career paths, as the client's own data has them (skillPlanFSDLoader.get_skill_plans,
// careerpath.get_career_paths): each plan's id, name and description messages, career path, faction, NPC corporation
// division, skill requirements ([typeID, level] in order) and milestones ({typeID, level: null for a type}); the career
// paths in the order the client's table iterates them, each its id and name and description messages. `available`
// is false where a table could not be read.
app.get("/api/client-data/certified-skill-plans", requireAuth, async (req, res, next) => {
  try {
    const [plans, careers] = await Promise.all([clientBuiltData.table("skillPlans"), clientBuiltData.table("careerPaths")]);
    if (!plans || !careers) {
      res.json({ ok: true, available: false, plans: [], careerPaths: [] });
      return;
    }
    const numberOrNull = (value) => (Number.isSafeInteger(Number(value)) && value !== null && value !== undefined ? Number(value) : null);
    res.json({
      ok: true,
      available: true,
      plans: Object.entries(plans).map(([planID, plan]) => ({
        planID: Number(planID),
        nameID: numberOrNull(plan.nameID),
        descriptionID: numberOrNull(plan.descriptionID),
        careerPathID: numberOrNull(plan.careerPathID),
        factionID: numberOrNull(plan.factionID),
        npcCorporationDivision: numberOrNull(plan.npcCorporationDivision),
        requirements: (Array.isArray(plan.skillRequirements) ? plan.skillRequirements : []).map((skill) => [Number(skill.typeID), Number(skill.level)]),
        milestones: (Array.isArray(plan.milestones) ? plan.milestones : []).map((milestone) => ({ typeID: Number(milestone.typeID), level: numberOrNull(milestone.level) })),
      })),
      careerPaths: (Array.isArray(careers["#order"]) ? careers["#order"] : []).map((careerPathID) => ({
        careerPathID,
        nameID: numberOrNull(careers[String(careerPathID)] && careers[String(careerPathID)].nameID),
        descriptionID: numberOrNull(careers[String(careerPathID)] && careers[String(careerPathID)].descriptionID),
      })),
    });
  } catch (error) {
    next(error);
  }
});

// Every skill type, by the server's static data: its type, name, group and group's name, and whether it is published.
// The skill plan editor's catalogue (skillsvc._ConstructSkillControllers: the skill category's types, published or
// held, by group) is made of it.
app.get("/api/static/skill-catalogue", requireAuth, (req, res, next) => {
  try {
    res.json({ ok: true, skills: staticData.listSkillTypes ? staticData.listSkillTypes() : [] });
  } catch (error) {
    next(error);
  }
});

app.get("/api/client-data/required-skills", requireAuth, async (req, res, next) => {
  try {
    const asked = [];
    for (const part of String((req.query && req.query.typeIDs) || "").split(",")) {
      const typeID = Number(part);
      if (Number.isSafeInteger(typeID) && typeID > 0 && !asked.includes(typeID)) asked.push(typeID);
    }
    const table = await clientBuiltData.table("requiredSkillsForTypes");
    const required = {};
    const order = {};
    const walk = (typeID) => {
      if (Object.prototype.hasOwnProperty.call(required, typeID)) return;
      const row = table && Array.isArray(table[typeID]) ? table[typeID] : [];
      const skills = {};
      const inOrder = [];
      for (const [skillID, level] of row) {
        const skill = Number(skillID);
        const atLevel = Number(level);
        if (Number.isSafeInteger(skill) && skill > 0 && Number.isSafeInteger(atLevel)) {
          skills[skill] = atLevel;
          inOrder.push([skill, atLevel]);
        }
      }
      required[typeID] = skills;
      order[typeID] = inOrder;
      for (const [skill] of inOrder) walk(skill);
    };
    if (table) for (const typeID of asked.slice(0, 50)) walk(typeID);
    res.json({ ok: true, available: Boolean(table), required, order });
  } catch (error) {
    next(error);
  }
});

// A type's base price and whether it is published, as the client's own data has them (evetypes.GetBasePrice and
// IsPublished: the typeBasePrices and typePublished tables; and GetPortionSize, typePortionSizes, by which the
// market's average falls back to the base price), for the types asked: what a skill book bought directly
// costs (characterskills/common/purchase.py get_direct_purchase_price: the base price and 30 in a hundred more) and
// whether it is sold so (evetypes.IsSkillAvailableForPurchase, with the type list of books for sale). A type the
// client's data lacks has null. `available` is false when a table could not be read. At most 50 types at once.
app.get("/api/client-data/type-prices", requireAuth, async (req, res, next) => {
  try {
    const asked = [];
    for (const part of String((req.query && req.query.typeIDs) || "").split(",")) {
      const typeID = Number(part);
      if (Number.isSafeInteger(typeID) && typeID > 0 && !asked.includes(typeID)) asked.push(typeID);
    }
    const [prices, published, portions, dynamicTypes] = await Promise.all([
      clientBuiltData.table("typeBasePrices"), clientBuiltData.table("typePublished"), clientBuiltData.table("typePortionSizes"),
      clientBuiltData.table("typeDynamic"),
    ]);
    const basePrice = {};
    const isPublished = {};
    const portionSize = {};
    // evetypes.GetGroupID: each type's group, as the static tables have it (a skill's group picks its icon:
    // skills/skillConst.py ICON_BY_GROUPID). And evetypes.GetCategoryID, its category (a saved fitting's cargo
    // entry is an implant by it: shipfitting/fitting.py _IsImplant).
    const groupID = {};
    const categoryID = {};
    // evetypes.IsDynamicType: bool of the type's isDynamicType, false where the type has none; null where the table
    // could not be read.
    const dynamic = {};
    for (const typeID of asked.slice(0, 50)) {
      dynamic[typeID] = dynamicTypes ? Boolean(Number(dynamicTypes[typeID] || 0)) : null;
      const type = typeof staticData.getType === "function" ? staticData.getType(typeID) : null;
      groupID[typeID] = type && Number.isSafeInteger(Number(type.groupID)) ? Number(type.groupID) : null;
      categoryID[typeID] = type && Number.isSafeInteger(Number(type.categoryID)) ? Number(type.categoryID) : null;
      const price = prices ? Number(prices[typeID]) : NaN;
      basePrice[typeID] = prices && prices[typeID] !== undefined && Number.isFinite(price) ? price : null;
      isPublished[typeID] = published && published[typeID] !== undefined ? Boolean(Number(published[typeID])) : null;
      const portion = portions ? Number(portions[typeID]) : NaN;
      portionSize[typeID] = portions && portions[typeID] !== undefined && Number.isFinite(portion) ? portion : null;
    }
    res.json({ ok: true, available: Boolean(prices && published), basePrice, published: isPublished, portionSize, groupID, categoryID, dynamic });
  } catch (error) {
    next(error);
  }
});

// A shopping list read as the client's multibuy window reads one from the clipboard (buyMultiFromBase
// ImportShoppingList; textImporting.importMultibuy, src/clientData/importMultibuy.js): the market's types it names,
// each with its quantity, in the order the client adds them, and the lines it could not read. The names are the
// market's types' English names (getMarketTypeNames). No session: the market's names do not vary by player.
const MULTIBUY_IMPORT_MAX_TEXT = 100_000;
let multibuyImport = null;
app.post("/api/client-data/multibuy-import", requireAuth, (req, res, next) => {
  const text = req.body && typeof req.body.text === "string" ? req.body.text : null;
  if (text === null || text.length > MULTIBUY_IMPORT_MAX_TEXT) {
    res.status(400).json({ ok: false, error: "INVALID_REQUEST", message: `A list is text of at most ${MULTIBUY_IMPORT_MAX_TEXT} characters.` });
    return;
  }
  try {
    if (multibuyImport === null) multibuyImport = createMultibuyImport(staticData.getMarketTypeNames());
    res.json({ ok: true, ...multibuyImport.getTypesAndQty(text) });
  } catch (error) {
    next(error);
  }
});

// A list of skills read as the client's skill plan editor reads one from the clipboard (ImportSkillsFromClipboard;
// textImporting.importSkillplan GetSkillsAndLevelsFromText, src/clientData/importSkillplan.js): each line's skill and
// level, in order, and the lines it could not read. The names are the skill types' English ones (getSkillImportNames).
// No session: they do not vary by player.
let skillplanImport = null;
app.post("/api/client-data/skillplan-import", requireAuth, (req, res, next) => {
  const text = req.body && typeof req.body.text === "string" ? req.body.text : null;
  if (text === null || text.length > MULTIBUY_IMPORT_MAX_TEXT) {
    res.status(400).json({ ok: false, error: "INVALID_REQUEST", message: `A list is text of at most ${MULTIBUY_IMPORT_MAX_TEXT} characters.` });
    return;
  }
  try {
    if (skillplanImport === null) skillplanImport = createSkillplanImport(staticData.getSkillImportNames(), (typeID) => staticData.isSkillType(typeID));
    res.json({ ok: true, ...skillplanImport.getSkillsAndLevelsFromText(text) });
  } catch (error) {
    next(error);
  }
});

// A fitting read from text as the client's fitting window reads one from the clipboard (fittingSvc
// ImportFittingFromClipboard; shipfitting/importFittingUtil.py, src/clientData/importFitting.js): the ship's type, the
// fitting's name, its entries and the lines it could not read; or ImportingErrorFromClipboard where the client's
// reading fails. The names are the types' English ones (getFittingImportNames). No session: they do not vary by player.
app.post("/api/client-data/fitting-import", requireAuth, (req, res, next) => {
  const text = req.body && typeof req.body.text === "string" ? req.body.text : null;
  if (text === null || text.length > MULTIBUY_IMPORT_MAX_TEXT) {
    res.status(400).json({ ok: false, error: "INVALID_REQUEST", message: `A fitting is text of at most ${MULTIBUY_IMPORT_MAX_TEXT} characters.` });
    return;
  }
  try {
    const { names, listed } = staticData.getFittingImportNames();
    res.json({ ok: true, ...readFitting(text, { names, listed, typeOf: (typeID) => staticData.getType(typeID), dogmaOf: (typeID) => staticData.getTypeDogma(typeID) }) });
  } catch (error) {
    next(error);
  }
});

// An alpha clone's skills and their highest levels for a race, as the client's clone grade storage has them
// (clonegrade.CloneGradeStorage()[raceID]; src/clientData/clientBuiltData.js cloneGrades): a skill not listed is 0.
// The client goes by them for an alpha (clone_grade_svc.get_max_skill_level). `available` false where the client's
// data could not be read. No session: they do not vary by player.
// Dogma effects' names, as the numbers of their messages (dogma.data.get_effect_display_name: the effect's
// displayNameID), for the effects asked; null for an effect with none. `available` false where the client's data
// could not be read. No session: they do not vary by player.
// The fitting browser's hulls (src/clientData/hullBrowser.js): every hull the market sells, its special edition
// ships, each hull's group, faction, meta group, category and whether it is published, the same of each type asked (a saved
// fitting's hull; null for a type the client does not have), and each race's name as the number of its message.
// `available` false where the client's data could not be read. No session: they do not vary by player.
app.get("/api/client-data/hull-browser", requireAuth, async (req, res, next) => {
  try {
    const asked = [];
    for (const part of String((req.query && req.query.typeIDs) || "").split(",")) {
      const typeID = Number(part);
      if (Number.isSafeInteger(typeID) && typeID > 0 && !asked.includes(typeID)) asked.push(typeID);
    }
    const names = ["marketGroupParents", "typeMarketGroups", "typePublished", "typeGroups", "typeFactions", "typeMetaGroups", "raceNameIDs", "groupCategories"];
    const read = await Promise.all(names.map((name) => clientBuiltData.table(name)));
    if (read.some((table) => !table)) {
      res.json({ ok: true, available: false });
      return;
    }
    const tables = Object.fromEntries(names.map((name, at) => [name, read[at]]));
    res.json({ ok: true, available: true, ...hullBrowserData(tables, asked.slice(0, 500)) });
  } catch (error) {
    next(error);
  }
});

// A ship's traits as the client's data has them (infobubbles: get_info_bubble_type_bonuses), for the types asked: its
// bonuses per skill, its role bonuses and its other bonuses, each {bonus, importance, nameID, unitID} (traits.py
// TraitsContainer); null for a type with none (infobubbles.has_traits). With them, each unit's name as the number of its
// message (dogma/units.py get_display_name). `available` is false when the client's data could not be read. At most 50.
app.get("/api/client-data/ship-traits", requireAuth, async (req, res, next) => {
  try {
    const asked = [];
    for (const part of String((req.query && req.query.typeIDs) || "").split(",")) {
      const typeID = Number(part);
      if (Number.isSafeInteger(typeID) && typeID > 0 && !asked.includes(typeID)) asked.push(typeID);
    }
    const [bonuses, unitNames] = await Promise.all([clientBuiltData.infoBubbleTypeBonuses(), clientBuiltData.table("unitDisplayNames")]);
    if (!bonuses) {
      res.json({ ok: true, available: false, traits: {}, unitNameIDs: {} });
      return;
    }
    const bonusOf = (value) => ({
      bonus: Number.isFinite(Number(value && value.bonus)) && value.bonus !== undefined && value.bonus !== null ? Number(value.bonus) : null,
      importance: Number(value && value.importance) || 0,
      nameID: Number(value && value.nameID) || null,
      unitID: Number(value && value.unitID) || null,
    });
    const listOf = (value) => (Array.isArray(value) ? value.map(bonusOf) : []);
    const traits = {};
    const units = new Set();
    for (const typeID of asked.slice(0, 50)) {
      const entry = bonuses[String(typeID)];
      if (!entry || typeof entry !== "object") {
        traits[typeID] = null;
        continue;
      }
      const skills = Object.entries(entry.types && typeof entry.types === "object" ? entry.types : {})
        .map(([skillTypeID, list]) => ({ skillTypeID: Number(skillTypeID), bonuses: listOf(list) }));
      traits[typeID] = { skills, role: listOf(entry.roleBonuses), misc: listOf(entry.miscBonuses) };
      for (const bonus of [...skills.flatMap((skill) => skill.bonuses), ...traits[typeID].role, ...traits[typeID].misc]) {
        if (bonus.unitID !== null) units.add(bonus.unitID);
      }
    }
    const unitNameIDs = {};
    for (const unitID of units) unitNameIDs[unitID] = unitNames && unitNames[String(unitID)] !== undefined ? Number(unitNames[String(unitID)]) || null : null;
    res.json({ ok: true, available: true, traits, unitNameIDs });
  } catch (error) {
    next(error);
  }
});

// The compare tool's types (comparisonWindow.py, comparableType.py), from the client's own tables: each type's dogma
// attributes as dogma/data.py get_type_attributes lists them (its typeDogma rows in their order, then its mass,
// capacity, volume and radius from its types record: evetypes.GetMass and the rest), its group and category
// (evetypes.GetGroupID, GetCategoryIDByGroup), whether it is published and whether it is a dynamic type
// (evetypes.IsDynamicType); the records of the attributes they carry, of the two the tool adds itself (the estimated
// price, attributeEstimatedPrice 5617, and the clone grade's, attributeCloneGradeRestriction 5618) and of those a value
// names (unitAttributeID, 119); each unit's name's message (units.get_display_name). At most 50 types at once.
// Dogma attributes as the client draws one by itself (skillsPanelUtil.AttributeCont): its name, the number of its
// message (dogma/data.py get_attribute_display_name: displayNameID), and its picture's res: path
// (get_attribute_icon_id, then fsdBuiltData iconIDs GetIconFile). At most 32 at once.
app.get("/api/client-data/attribute-display", requireAuth, async (req, res, next) => {
  try {
    const asked = [];
    for (const part of String((req.query && req.query.attributeIDs) || "").split(",")) {
      const attributeID = Number(part);
      if (Number.isSafeInteger(attributeID) && attributeID > 0 && !asked.includes(attributeID)) asked.push(attributeID);
    }
    const [attributeRows, iconFiles] = await Promise.all([
      clientBuiltData.table("dogmaAttributes"),
      clientBuiltData.table("iconFiles"),
    ]);
    if (!attributeRows) {
      res.json({ ok: true, available: false, attributes: {} });
      return;
    }
    const whole = (value) => (value !== null && value !== undefined && Number.isSafeInteger(Number(value)) ? Number(value) : null);
    const attributes = {};
    for (const attributeID of asked.slice(0, 32)) {
      const row = attributeRows[String(attributeID)];
      if (!row || typeof row !== "object") {
        attributes[attributeID] = null;
        continue;
      }
      const iconID = whole(row.iconID);
      const iconFile = iconID !== null && iconFiles ? iconFiles[String(iconID)] : null;
      attributes[attributeID] = { displayNameID: whole(row.displayNameID), iconFile: typeof iconFile === "string" ? iconFile : null };
    }
    res.json({ ok: true, available: true, attributes });
  } catch (error) {
    next(error);
  }
});

// The expert systems as the client's data has them (expertSystems/data.py ExpertSystem): by type, its days, whether
// it is hidden or retired, and the skills it gives with their levels (skillsGranted, in the order the client's loader
// iterates its dict).
app.get("/api/client-data/expert-systems", requireAuth, async (req, res, next) => {
  try {
    const rows = await clientBuiltData.table("expertSystems");
    if (!rows) {
      res.json({ ok: true, available: false, expertSystems: {} });
      return;
    }
    const expertSystems = {};
    for (const [key, row] of Object.entries(rows)) {
      const typeID = Number(key);
      if (!Number.isSafeInteger(typeID) || typeID <= 0 || !row || typeof row !== "object") continue;
      // (The table keeps skillsGranted as [[skill, level], ...] in the loader's order: innerOrder.)
      const granted = Array.isArray(row.skillsGranted) ? row.skillsGranted : row.skillsGranted && typeof row.skillsGranted === "object" ? Object.entries(row.skillsGranted) : [];
      expertSystems[typeID] = {
        durationDays: Number(row.durationDays) || 0,
        hidden: Boolean(Number(row.esHidden || 0)),
        retired: Boolean(Number(row.esRetired || 0)),
        skills: granted.map(([skill, level]) => [Number(skill), Number(level) || 0]).filter(([skill]) => skill > 0),
        // associatedShipTypes: the ships it goes with, in its list's order.
        ships: (Array.isArray(row.associatedShipTypes) ? row.associatedShipTypes : []).map(Number).filter((typeID) => typeID > 0),
      };
    }
    res.json({ ok: true, available: true, expertSystems });
  } catch (error) {
    next(error);
  }
});

// The certificates filed under skill groups (certificateSvc.GetCertificatesByGroupID), each with its skills and the
// level each grade asks of them (src/staticData.js getSkillGroupCertificates). At most 64 groups at once.
app.get("/api/client-data/skill-group-certificates", requireAuth, (req, res, next) => {
  try {
    const asked = String((req.query && req.query.groupIDs) || "").split(",").map(Number).filter((groupID) => Number.isSafeInteger(groupID) && groupID > 0).slice(0, 64);
    res.json({ ok: true, certificates: staticDataModule.getSkillGroupCertificates(asked) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/client-data/type-attributes", requireAuth, async (req, res, next) => {
  try {
    const asked = [];
    for (const part of String((req.query && req.query.typeIDs) || "").split(",")) {
      const typeID = Number(part);
      if (Number.isSafeInteger(typeID) && typeID > 0 && !asked.includes(typeID)) asked.push(typeID);
    }
    const wanted = asked.slice(0, 50);
    const [dogmaRows, typeRows, attributeRows, unitNames, groupCategories] = await Promise.all([
      clientBuiltData.rows("typeDogma", wanted),
      clientBuiltData.rows("types", wanted),
      clientBuiltData.table("dogmaAttributes"),
      clientBuiltData.table("unitDisplayNames"),
      clientBuiltData.table("groupCategories"),
    ]);
    if (!dogmaRows || !typeRows || !attributeRows) {
      res.json({ ok: true, available: false, types: {}, attributes: {}, unitNameIDs: {} });
      return;
    }
    const number = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);
    const whole = (value) => (value !== null && value !== undefined && Number.isSafeInteger(Number(value)) ? Number(value) : null);
    const recordOf = (attributeID) => {
      const row = attributeRows[String(attributeID)];
      if (!row || typeof row !== "object") return null;
      return {
        name: typeof row.name === "string" ? row.name : null,
        displayNameID: whole(row.displayNameID),
        tooltipDescriptionID: whole(row.tooltipDescriptionID),
        unitID: whole(row.unitID),
        iconID: whole(row.iconID),
        published: Boolean(Number(row.published || 0)),
        displayWhenZero: Boolean(Number(row.displayWhenZero || 0)),
        highIsGood: Boolean(Number(row.highIsGood || 0)),
        dataType: whole(row.dataType),
        defaultValue: number(row.defaultValue),
      };
    };
    const types = {};
    const attributes = {};
    const units = new Set();
    const keep = (attributeID) => {
      if (Object.hasOwn(attributes, attributeID)) return;
      const record = recordOf(attributeID);
      attributes[attributeID] = record;
      if (record && record.unitID !== null) units.add(record.unitID);
    };
    keep(5617);
    keep(5618);
    for (const typeID of wanted) {
      const type = typeRows[String(typeID)];
      if (!type || typeof type !== "object") {
        types[typeID] = null;
        continue;
      }
      const dogma = dogmaRows[String(typeID)];
      const listed = dogma && Array.isArray(dogma.dogmaAttributes) ? dogma.dogmaAttributes : [];
      const rows = listed
        .map((row) => [whole(row && row.attributeID), number(row && row.value)])
        .filter(([attributeID]) => attributeID !== null && attributeID > 0);
      rows.push([4, number(type.mass)], [38, number(type.capacity)], [161, number(type.volume)], [162, number(type.radius)]);
      for (const [attributeID, value] of rows) {
        keep(attributeID);
        const record = attributes[attributeID];
        if (record && record.unitID === 119 && value !== null && Number.isSafeInteger(Math.trunc(value))) keep(Math.trunc(value));
      }
      const groupID = whole(type.groupID);
      const categoryID = groupID !== null && groupCategories && groupCategories[String(groupID)] !== undefined ? whole(groupCategories[String(groupID)]) : null;
      types[typeID] = {
        attributes: rows,
        groupID,
        categoryID,
        published: Boolean(Number(type.published || 0)),
        dynamic: Boolean(Number(type.isDynamicType || 0)),
      };
    }
    const unitNameIDs = {};
    for (const unitID of units) unitNameIDs[unitID] = unitNames && unitNames[String(unitID)] !== undefined ? Number(unitNames[String(unitID)]) || null : null;
    res.json({ ok: true, available: true, types, attributes, unitNameIDs });
  } catch (error) {
    next(error);
  }
});

// What the page's own dogma reckons a type's item with (the Fitting window's simulation: FittingDogmaLocation on
// baseDogmaLocation), from the client's own tables, for at most 50 types at once:
//   each type      its attributes as dogma/data.py get_type_attributes lists them (its typeDogma rows in their order,
//                  then its mass, capacity, volume and radius), its effects (its typeDogma dogmaEffects, in their
//                  order), its group and category, and the skills it requires (get_dogma_required_skills: the item's
//                  reqSkills, which a location's required-skill modifiers go by)
//   each effect    of those types: its category, the attribute a fitting's chance goes by
//                  (fittingUsageChanceAttributeID), its modifierInfo (null where it has none: the compiler makes
//                  it a neutral effect, baseEffectCompiler SetupDogmaEffects), and the attributes it goes by for its
//                  cycle, drain, range, falloff and tracking; each type's default effect besides
//   each attribute the types carry, the effects name, and those asked (attributeIDs, at most 200): what Attribute and
//                  itemAttributeFactory go by (stackable, dataType, defaultValue, highIsGood, the cap and floor
//                  attributes, whether it is a charged one), and the cap and floor attributes' own records
app.get("/api/client-data/dogma-types", requireAuth, async (req, res, next) => {
  try {
    const listed = (name, most) => {
      const out = [];
      for (const part of String((req.query && req.query[name]) || "").split(",")) {
        const id = Number(part);
        if (Number.isSafeInteger(id) && id > 0 && !out.includes(id)) out.push(id);
      }
      return out.slice(0, most);
    };
    const wanted = listed("typeIDs", 50);
    const askedAttributes = listed("attributeIDs", 200);
    const [dogmaRows, typeRows, attributeRows, groupCategories, requiredSkills] = await Promise.all([
      clientBuiltData.rows("typeDogma", wanted),
      clientBuiltData.rows("types", wanted),
      clientBuiltData.table("dogmaAttributes"),
      clientBuiltData.table("groupCategories"),
      clientBuiltData.table("requiredSkillsForTypes"),
    ]);
    if (!dogmaRows || !typeRows || !attributeRows) {
      res.json({ ok: true, available: false, types: {}, effects: {}, attributes: {} });
      return;
    }
    const number = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);
    const whole = (value) => (value !== null && value !== undefined && Number.isSafeInteger(Number(value)) ? Number(value) : null);
    const types = {};
    const effectIDs = [];
    const attributeIDs = new Set(askedAttributes);
    for (const typeID of wanted) {
      const type = typeRows[String(typeID)];
      if (!type || typeof type !== "object") {
        types[typeID] = null;
        continue;
      }
      const dogma = dogmaRows[String(typeID)];
      const rows = (dogma && Array.isArray(dogma.dogmaAttributes) ? dogma.dogmaAttributes : [])
        .map((row) => [whole(row && row.attributeID), number(row && row.value)])
        .filter(([attributeID]) => attributeID !== null && attributeID > 0);
      rows.push([4, number(type.mass)], [38, number(type.capacity)], [161, number(type.volume)], [162, number(type.radius)]);
      for (const [attributeID] of rows) attributeIDs.add(attributeID);
      const effectRowsOfType = dogma && Array.isArray(dogma.dogmaEffects) ? dogma.dogmaEffects : [];
      const effects = effectRowsOfType
        .map((row) => whole(row && row.effectID))
        .filter((effectID) => effectID !== null && effectID > 0);
      // The type's default effect (baseDogmaStaticSvc.LoadTypeEffects: the effect marked isDefault; the last one where
      // more are).
      let defaultEffectID = null;
      for (const row of effectRowsOfType) if (row && Number(row.isDefault || 0) && whole(row.effectID)) defaultEffectID = whole(row.effectID);
      for (const effectID of effects) if (!effectIDs.includes(effectID)) effectIDs.push(effectID);
      const groupID = whole(type.groupID);
      const required = requiredSkills && Array.isArray(requiredSkills[String(typeID)]) ? requiredSkills[String(typeID)] : [];
      // The ship groups and types it may be fitted to (baseDogmaStaticSvc GetCanFitShipGroups and GetCanFitShipTypes):
      // the values of its attributes whose data type is a group (dgmAttrCatGroup, 12: get_attribute_list_by_data_type)
      // named canFitShipGroup..., and a type (dgmAttrCatType, 11) named canFitShipType... or fitsToShipType.
      const fitsShipGroups = [];
      const fitsShipTypes = [];
      // The charge groups it takes (GetChargeGroupAttributes: those of the group data type named chargeGroup...).
      const chargeGroups = [];
      for (const [attributeID, value] of rows) {
        const record = attributeRows[String(attributeID)];
        const name = record && typeof record.name === "string" ? record.name : "";
        const category = record ? whole(record.dataType) : null;
        if (value === null) continue;
        if (category === 12 && name.startsWith("canFitShipGroup")) fitsShipGroups.push(value);
        else if (category === 12 && name.startsWith("chargeGroup")) chargeGroups.push(value);
        else if (category === 11 && (name === "fitsToShipType" || name.startsWith("canFitShipType"))) fitsShipTypes.push(value);
      }
      types[typeID] = {
        attributes: rows,
        effects,
        defaultEffectID,
        fitsShipGroups,
        fitsShipTypes,
        chargeGroups,
        groupID,
        categoryID: groupID !== null && groupCategories && groupCategories[String(groupID)] !== undefined ? whole(groupCategories[String(groupID)]) : null,
        requiredSkills: required.map(([skillID]) => whole(skillID)).filter((skillID) => skillID !== null && skillID > 0),
      };
    }
    const effectRows = effectIDs.length > 0 ? await clientBuiltData.rows("dogmaEffects", effectIDs) : {};
    const effects = {};
    for (const effectID of effectIDs) {
      const row = effectRows ? effectRows[String(effectID)] : null;
      if (!row || typeof row !== "object") {
        effects[effectID] = null;
        continue;
      }
      const modifiers = Array.isArray(row.modifierInfo) && row.modifierInfo.length > 0
        ? row.modifierInfo.map((info) => ({
          func: typeof info.func === "string" ? info.func : null,
          domain: typeof info.domain === "string" ? info.domain : null,
          modifiedAttributeID: whole(info.modifiedAttributeID),
          modifyingAttributeID: whole(info.modifyingAttributeID),
          operation: whole(info.operation),
          skillTypeID: whole(info.skillTypeID),
          groupID: whole(info.groupID),
        }))
        : null;
      for (const info of modifiers || []) {
        if (info.modifiedAttributeID) attributeIDs.add(info.modifiedAttributeID);
        if (info.modifyingAttributeID) attributeIDs.add(info.modifyingAttributeID);
      }
      const chanceAttributeID = whole(row.fittingUsageChanceAttributeID);
      if (chanceAttributeID) attributeIDs.add(chanceAttributeID);
      // The attributes the effect goes by: its cycle, what it drains, its range, falloff and tracking.
      const named = {};
      for (const field of ["durationAttributeID", "dischargeAttributeID", "rangeAttributeID", "falloffAttributeID", "trackingSpeedAttributeID"]) {
        named[field] = whole(row[field]) || null;
        if (named[field]) attributeIDs.add(named[field]);
      }
      effects[effectID] = { category: whole(row.effectCategory), chanceAttributeID: chanceAttributeID || null, modifiers, ...named };
    }
    const attributes = {};
    const keep = (attributeID) => {
      if (Object.hasOwn(attributes, attributeID)) return;
      const row = attributeRows[String(attributeID)];
      if (!row || typeof row !== "object") {
        attributes[attributeID] = null;
        return;
      }
      const record = {
        stackable: Boolean(Number(row.stackable || 0)),
        dataType: whole(row.dataType),
        defaultValue: number(row.defaultValue),
        highIsGood: Boolean(Number(row.highIsGood || 0)),
        maxAttributeID: whole(row.maxAttributeID) || null,
        minAttributeID: whole(row.minAttributeID) || null,
        chargeRechargeTimeID: whole(row.chargeRechargeTimeID) || null,
      };
      attributes[attributeID] = record;
      if (record.maxAttributeID) keep(record.maxAttributeID);
      if (record.minAttributeID) keep(record.minAttributeID);
    };
    for (const attributeID of attributeIDs) keep(attributeID);
    res.json({ ok: true, available: true, types, effects, attributes });
  } catch (error) {
    next(error);
  }
});

// Types' meta level, meta group and tech level from the client's types records (evetypes.GetMetaLevel, GetMetaGroupID,
// GetTechLevel: null where a record has none), and each meta group's name as the number of its message
// (metaGroups.get_name): what the assets search's metalevel, metagroup and techlevel keywords read
// (assetSearchUtil.py 437 to 475). With them each type's market group, whether it is published, its group and its
// category (evetypes.GetMarketGroupID, IsPublished, GetGroupID, GetCategoryIDByGroup): what a type's menu offers by
// (menusvc.GetMenuFromItemIDTypeID) and what the market's quickbar fades a type by (QuickbarItem.Load). At most 500.
// The public gateway (gamePort/publicGateway.js): one of the client's own eve_public requests made for the page's
// pilot as its client makes it (send_character_request: the pilot's account as the authenticated user, the pilot as
// the active identity), and the gateway's answer: {statusCode, statusMessage, typeName, payload}, the payload decoded
// by the client's own message of that type. The requests are those the page makes; a write among them only with
// confirm said. The pilot is the held session's, never the page's to name.
const PUBLIC_GATEWAY_READS = new Set([
  // skills/skillplan/grpc/message_bus/skillPlanRequestsMessenger.py
  "eve_public.character.skill.plan.GetAllRequest",
  "eve_public.character.skill.plan.GetRequest",
  "eve_public.character.skill.plan.GetActiveRequest",
  // skills/skillplan/grpc/message_bus/milestoneRequestsMessenger.py
  "eve_public.character.skill.plan.milestone.GetAllRequest",
  // corpSkillPlanRequestsMessenger.py, corpMilestoneRequest.py
  "eve_public.corporation.skill.plan.GetAllRequest",
  "eve_public.corporation.skill.plan.GetRequest",
  "eve_public.corporation.skill.plan.milestone.GetAllRequest",
  "eve_public.character.skill.plan.GetSharedRequest",
  "eve_public.corporation.skill.plan.GetSharedRequest",
]);
const PUBLIC_GATEWAY_WRITES = new Set([
  "eve_public.character.skill.plan.DeleteRequest",
  "eve_public.character.skill.plan.SetActiveRequest",
  "eve_public.character.skill.plan.SetSkillRequirementsRequest",
  "eve_public.character.skill.plan.CreateRequest",
  "eve_public.character.skill.plan.SetNameRequest",
  "eve_public.character.skill.plan.SetDescriptionRequest",
  "eve_public.character.skill.plan.milestone.DeleteRequest",
  "eve_public.character.skill.plan.milestone.CreateRequest",
  "eve_public.corporation.skill.plan.SetSkillRequirementsRequest",
  "eve_public.corporation.skill.plan.DeleteRequest",
  "eve_public.corporation.skill.plan.milestone.DeleteRequest",
  "eve_public.corporation.skill.plan.CreateRequest",
  "eve_public.corporation.skill.plan.SetNameRequest",
  "eve_public.corporation.skill.plan.SetDescriptionRequest",
  "eve_public.corporation.skill.plan.SetCategoryRequest",
  "eve_public.corporation.skill.plan.milestone.CreateRequest",
]);
let publicGatewayClient = null;
/** The one public gateway client: the page's requests and each pilot's notices go on its connections. */
function sharedPublicGateway() {
  if (!publicGatewayClient) publicGatewayClient = createPublicGateway({ url: publicGatewayUrl(process.env, gameEndpoint(process.env).host) });
  return publicGatewayClient;
}
app.post("/api/public-gateway/request", requireAuth, async (req, res, next) => {
  try {
    const body = req.body || {};
    const request = typeof body.request === "string" ? body.request : "";
    const write = PUBLIC_GATEWAY_WRITES.has(request);
    if (!write && !PUBLIC_GATEWAY_READS.has(request)) {
      res.status(400).json({ ok: false, error: "GATEWAY_REQUEST_REFUSED", message: `${request || "That"} is no request the page makes on the public gateway.` });
      return;
    }
    if (write && body.confirm !== true) {
      res.status(403).json({ ok: false, error: "GATEWAY_WRITE_REFUSED", message: `${request} is a write: it is made only with confirm said.` });
      return;
    }
    const held = requireHeldBridgeSession(req, res);
    if (!held) return;
    const payload = body.payload && typeof body.payload === "object" && !Array.isArray(body.payload) ? body.payload : {};
    let answer;
    try {
      answer = await sharedPublicGateway().request({ userID: held.accountID, characterID: held.characterID }, request, payload);
    } catch (error) {
      if (!String(error && error.code).startsWith("GATEWAY_")) throw error;
      res.status(502).json({ ok: false, error: error.code, message: error.message });
      return;
    }
    res.json({ ok: true, ...answer });
  } catch (error) {
    next(error);
  }
});

app.get("/api/client-data/type-meta", requireAuth, async (req, res, next) => {
  try {
    const asked = [];
    for (const part of String((req.query && req.query.typeIDs) || "").split(",")) {
      const typeID = Number(part);
      if (Number.isSafeInteger(typeID) && typeID > 0 && !asked.includes(typeID)) asked.push(typeID);
    }
    const wanted = asked.slice(0, 500);
    const [typeRows, metaGroupNames, groupCategories] = await Promise.all([
      clientBuiltData.rows("types", wanted), clientBuiltData.table("metaGroupNameIDs"), clientBuiltData.table("groupCategories"),
    ]);
    if (!typeRows || !metaGroupNames) {
      res.json({ ok: true, available: false, types: {}, metaGroupNameIDs: {} });
      return;
    }
    const whole = (value) => (value !== null && value !== undefined && Number.isSafeInteger(Number(value)) ? Number(value) : null);
    const types = {};
    for (const typeID of wanted) {
      const type = typeRows[String(typeID)];
      types[typeID] = type && typeof type === "object"
        ? {
          metaLevel: whole(type.metaLevel),
          metaGroupID: whole(type.metaGroupID),
          techLevel: whole(type.techLevel),
          marketGroupID: whole(type.marketGroupID),
          published: Boolean(Number(type.published || 0)),
          // evetypes.GetDescriptionID: the message the type's description is (GetDescription words it).
          descriptionID: whole(type.descriptionID),
          groupID: whole(type.groupID),
          categoryID: whole(type.groupID) !== null && groupCategories && groupCategories[String(type.groupID)] !== undefined ? whole(groupCategories[String(type.groupID)]) : null,
        }
        : null;
    }
    const metaGroupNameIDs = {};
    for (const [metaGroupID, nameID] of Object.entries(metaGroupNames)) metaGroupNameIDs[metaGroupID] = whole(nameID);
    res.json({ ok: true, available: true, types, metaGroupNameIDs });
  } catch (error) {
    next(error);
  }
});

app.get("/api/client-data/effect-names", requireAuth, async (req, res, next) => {
  try {
    const asked = [];
    for (const part of String((req.query && req.query.effectIDs) || "").split(",")) {
      const effectID = Number(part);
      if (Number.isSafeInteger(effectID) && effectID > 0 && !asked.includes(effectID)) asked.push(effectID);
    }
    const names = await clientBuiltData.table("effectDisplayNames");
    const displayNameIDs = {};
    for (const effectID of asked.slice(0, 50)) {
      const messageID = names ? Number(names[effectID]) : NaN;
      displayNameIDs[effectID] = Number.isSafeInteger(messageID) && messageID > 0 ? messageID : null;
    }
    res.json({ ok: true, available: Boolean(names), displayNameIDs });
  } catch (error) {
    next(error);
  }
});

app.get("/api/client-data/clone-grade", requireAuth, async (req, res, next) => {
  const raceID = Number(req.query && req.query.raceID);
  if (!Number.isSafeInteger(raceID) || raceID <= 0) {
    res.status(400).json({ ok: false, error: "INVALID_REQUEST", message: "A race is a whole number." });
    return;
  }
  try {
    const grades = typeof clientBuiltData.cloneGrades === "function" ? await clientBuiltData.cloneGrades() : null;
    res.json({ ok: true, available: grades !== null, levels: grades ? grades[String(raceID)] ?? {} : {} });
  } catch (error) {
    next(error);
  }
});

// The global config the game server gave the pilot's client as it logged in (machoNet's, which
// globalConfig/getFunctions.py GetGlobalConfigValue reads: the login's config_vals), for the names asked, each its
// value as given or null where it gave none. The client goes by these for what the server has switched on or off
// (IsSkillPurchaseEnabled and the rest). A pilot on the web gateway has none here: `available` false, and whoever
// asks goes by the client's defaults. At most 16 names, each a plain name.
app.get("/api/bridge/global-config", requireAuth, (req, res, next) => {
  const held = requireHeldBridgeSession(req, res);
  if (!held) {
    return;
  }
  const names = [...new Set(String((req.query && req.query.names) || "").split(",").filter((name) => /^[A-Za-z0-9_]{1,64}$/.test(name)))].slice(0, 16);
  if (!gamePortPilots || !isGamePortHandle(held.bridgeSessionID) || typeof gamePortPilots.globalConfigValues !== "function") {
    res.json({ ok: true, available: false, values: {} });
    return;
  }
  try {
    res.json({ ok: true, available: true, values: gamePortPilots.globalConfigValues(names, { userid: held.accountID }, held.bridgeSessionID) });
  } catch (error) {
    next(error);
  }
});

// How the retail client words each kind of notification (notificationSvc.py FormatNotifications): for each type
// the labels of notificationUtil's table, or the formatter it has and the labels that formatter is made with, as
// the client's own code answers (src/clientData/clientNotificationFormats.js). `formats` is null where they could
// not be read (no client install, or no Python to host the client's code).
app.get("/api/client-data/notification-formats", requireAuth, async (req, res, next) => {
  try {
    res.json({ ok: true, formats: await clientNotificationFormats.formats() });
  } catch (error) {
    next(error);
  }
});

app.post("/api/names", requireAuth, async (req, res, next) => {
  try {
    const items = Array.isArray(req.body && req.body.items) ? req.body.items : [];
    const result = staticData.resolveNames({ items });
    const names = { ...result.names };

    // Owner 1, the EVE System: the client names it itself in its table of owners, by its own word, whoever asks for
    // it, and asks no one (eveCfg.py LoadEveOwners, 583: OWNER_NAME_OVERRIDES, UI/Chat/ChatEngine/EveSystem). So
    // here, from the install, where the static tables have it not and there is an install to read.
    for (const [key, value] of Object.entries(names)) {
      const separator = key.indexOf(":");
      if (value === null && Number(key.slice(separator + 1)) === OWNER_SYSTEM_ID && Object.hasOwn(OWNER_NAME_KINDS, key.slice(0, separator)) && key.slice(0, separator) !== "ownerGroup") {
        const word = clientWords.templates([OWNER_SYSTEM_NAME_LABEL])[OWNER_SYSTEM_NAME_LABEL];
        if (typeof word === "string" && word !== "") names[key] = word;
      }
    }

    // Only the static misses that could be a player structure are candidates —
    // a name the SDE already answered is never re-asked, and an ID below the
    // structure floor is a genuine static unknown.
    const candidates = [];
    for (const [key, value] of Object.entries(names)) {
      if (value !== null) {
        continue;
      }
      const separator = key.indexOf(":");
      const kind = key.slice(0, separator);
      const id = Number(key.slice(separator + 1)) || 0;
      if (STRUCTURE_NAME_KINDS.has(kind) && isPlayerStructureID(id)) {
        candidates.push({ key, id });
      }
    }

    const unresolved = [];
    let runtimeUsed = false;
    if (candidates.length > 0) {
      runtimeUsed = true;
      const { records, failed } = await resolveRuntimeStructureNames(
        req,
        candidates.map((candidate) => candidate.id),
      );
      for (const candidate of candidates) {
        if (failed.has(candidate.id)) {
          // Stays null in `names`, but named here so the client leaves it
          // uncached and retries rather than believing it is nameless.
          unresolved.push(candidate.key);
          continue;
        }
        const record = records.get(candidate.id);
        if (record && typeof record.name === "string") {
          names[candidate.key] = record.name;
        }
      }
    }

    // A player's corporation, alliance or character the static tables could
    // not name. With no pilot online yet there is no one to ask as: that is
    // not knowing, so the page asks again. A pilot on the gateway has no such
    // call, and the name stays the static tables' "unknown", as it was.
    const owners = [];
    for (const [key, value] of Object.entries(names)) {
      const separator = key.indexOf(":");
      const kind = key.slice(0, separator);
      const id = Number(key.slice(separator + 1)) || 0;
      if (value === null && Object.hasOwn(OWNER_NAME_KINDS, kind) && id >= MIN_PLAYER_OWNER_ID) {
        owners.push({ key, kind, id });
      }
    }
    // A named item's own name (the client's cfg.evelocations: a ship, a container, uix.GetItemName): the static
    // tables have none, and it is asked of the game server as the client asks it, config.GetMultiLocationsEx, by the
    // game-port transport, which keeps each row it is answered or told of (pilots.js locationsNamed). Off the game
    // port, or with no pilot on, it is not known, and the page asks again.
    const namedItems = [];
    for (const [key, value] of Object.entries(names)) {
      const separator = key.indexOf(":");
      if (value === null && key.slice(0, separator) === "evelocation") namedItems.push({ key, id: Number(key.slice(separator + 1)) || 0 });
    }
    let locationsAsked = false;
    if (namedItems.length > 0) {
      const held = gamePortPilots ? bridgeSessions.get(req.webSessionID) || null : null;
      if (!held || !isGamePortHandle(held.bridgeSessionID)) {
        unresolved.push(...namedItems.map((item) => item.key));
      } else {
        locationsAsked = true;
        try {
          const named = await heldRequest(held, req.webSessionID, false, () => gamePortPilots.locationsNamed(
            namedItems.map((item) => item.id), { userid: held.accountID }, held.bridgeSessionID));
          for (const item of namedItems) {
            const name = named.get(item.id);
            if (typeof name === "string" && name !== "") names[item.key] = name;
          }
        } catch (_error) {
          unresolved.push(...namedItems.map((item) => item.key));
        }
      }
    }

    let ownersAsked = false;
    if (owners.length > 0 && gamePortPilots) {
      const held = bridgeSessions.get(req.webSessionID) || null;
      if (!held) {
        unresolved.push(...owners.map((owner) => owner.key));
      } else if (isGamePortHandle(held.bridgeSessionID)) {
        ownersAsked = true;
        try {
          const named = await heldRequest(held, req.webSessionID, false, () => gamePortPilots.ownersNamed(
            owners.map((owner) => owner.id), { userid: held.accountID }, held.bridgeSessionID));
          for (const owner of owners) {
            const row = named.get(owner.id);
            if (row && row.name && OWNER_NAME_KINDS[owner.kind](row.typeID)) {
              names[owner.key] = owner.kind === "ownerGroup" ? staticData.getKnownTypeGroupName(row.typeID) : row.name;
            }
          }
        } catch (_error) {
          // Refused, or the session gone: not known, and not cached as nameless.
          unresolved.push(...owners.map((owner) => owner.key));
        }
      }
    }

    res.json({
      ok: true,
      // Named on the wire so a consumer can see whether a live session was
      // involved at all, rather than inferring it.
      source: ["static-data", ...(runtimeUsed ? ["runtime-structures"] : []), ...(ownersAsked ? ["game-server-owners"] : []), ...(locationsAsked ? ["game-server-locations"] : [])].join("+"),
      count: Object.keys(names).length,
      capped: result.capped,
      limit: result.limit,
      names,
      unresolved,
    });
  } catch (error) {
    next(error);
  }
});

// Corporations' tickers, as the client's cfg.corptickernames has them: an NPC corporation's from the static tables
// (the client fills those from its own data and asks for none), a player corporation's asked of the game server by
// the game-port transport, which keeps each it is answered (pilots.js corpTickersNamed): in one call, or in one for
// each where `each` is said, as the client's own askings go. A ticker that could not be asked (no pilot on the game
// port, or the call refused) is named in `unresolved`; null is the server's answer of none.
app.post("/api/corp-tickers", requireAuth, async (req, res, next) => {
  try {
    const asked = Array.isArray(req.body && req.body.corpIDs) ? req.body.corpIDs : [];
    const corpIDs = [...new Set(asked.filter((corpID) => Number.isSafeInteger(corpID) && corpID > 0))].slice(0, 200);
    const each = Boolean(req.body && req.body.each === true);
    const tickers = {};
    const unresolved = [];
    const players = [];
    for (const corpID of corpIDs) {
      if (corpID >= 1000000 && corpID < 2000000) {
        const corporation = staticData.getCorporation(corpID);
        tickers[corpID] = corporation && corporation.tickerName ? String(corporation.tickerName) : null;
      } else {
        players.push(corpID);
      }
    }
    if (players.length > 0) {
      const held = bridgeSessions.get(req.webSessionID) || null;
      if (!held || !gamePortPilots || !isGamePortHandle(held.bridgeSessionID)) {
        unresolved.push(...players);
      } else {
        try {
          const named = await heldRequest(held, req.webSessionID, false, () => gamePortPilots.corpTickersNamed(
            players, each, { userid: held.accountID }, held.bridgeSessionID));
          for (const corpID of players) tickers[corpID] = named.get(corpID) ?? null;
        } catch (_error) {
          unresolved.push(...players);
        }
      }
    }
    res.json({ ok: true, tickers, unresolved });
  } catch (error) {
    next(error);
  }
});

// Alliances' tickers, as the client's cfg.allianceshortnames has them: asked of the game server by the game-port
// transport, which keeps each it is answered, those michelle primed as the balls came among them (pilots.js
// allianceTickersNamed): in one call, or in one for each where `each` is said, as the overview's Get makes one. A
// ticker that could not be asked (no pilot on the game port, or the call refused) is named in `unresolved`; null is
// the server's answer of none.
app.post("/api/alliance-tickers", requireAuth, async (req, res, next) => {
  try {
    const asked = Array.isArray(req.body && req.body.allianceIDs) ? req.body.allianceIDs : [];
    const allianceIDs = [...new Set(asked.filter((allianceID) => Number.isSafeInteger(allianceID) && allianceID > 0))].slice(0, 200);
    const each = Boolean(req.body && req.body.each === true);
    const tickers = {};
    const unresolved = [];
    if (allianceIDs.length > 0) {
      const held = bridgeSessions.get(req.webSessionID) || null;
      if (!held || !gamePortPilots || !isGamePortHandle(held.bridgeSessionID)) {
        unresolved.push(...allianceIDs);
      } else {
        try {
          const named = await heldRequest(held, req.webSessionID, false, () => gamePortPilots.allianceTickersNamed(
            allianceIDs, each, { userid: held.accountID }, held.bridgeSessionID));
          for (const allianceID of allianceIDs) tickers[allianceID] = named.get(allianceID) ?? null;
        } catch (_error) {
          unresolved.push(...allianceIDs);
        }
      }
    }
    res.json({ ok: true, tickers, unresolved });
  } catch (error) {
    next(error);
  }
});

/**
 * R24 slice C — MODULE CYCLE TIMES, from static reference data.
 *
 * How long a module takes to run one cycle is attribute **73** (`duration`, in
 * milliseconds), and it is already sitting in the static dogma table:
 * Miner I / Miner II = 15000, Modulated Strip Miner II = 45000. `staticData`
 * has exposed `getTypeDogmaAttribute` since it was written and nothing has ever
 * called it — this is the first caller. ZERO bridge calls: like /api/names and
 * /api/map/graph this is read-only reference data that cannot vary by player,
 * so it never needs a round trip to EveJS.
 *
 * ⚠ WHAT THIS NUMBER IS NOT. It is the BASE duration on the type, before the
 * pilot's skills, the ship's role bonuses, rigs, implants or heat. The server
 * computes the EFFECTIVE duration (it is what it puts in an `OnGodmaShipEffect`
 * cycle event), but there is still no allowlisted call that returns effective
 * per-module attributes — the same wall that blocks DPS. So this route answers
 * `baseCycleMs`, named `base` all the way to the screen, and the page prefers
 * the server's own figure whenever a cycle event has told it one. A number
 * presented as the truth when it is only the starting point is worse than no
 * number at all.
 */
const CYCLE_TIME_TYPE_LIMIT = 500;
const ATTRIBUTE_DURATION = 73;

// A GET, deliberately: this is an idempotent read of unchanging reference data
// with no player context in it at all. Nothing here mutates, so nothing here
// should look like it might.
app.get("/api/types/cycle-times", requireAuth, async (req, res, next) => {
  try {
    const requested = String((req.query && req.query.typeIDs) || "")
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    const seen = new Set();
    const baseCycleMs = {};
    for (const raw of requested) {
      const typeID = Number(raw) || 0;
      if (typeID <= 0 || seen.has(typeID)) {
        continue;
      }
      seen.add(typeID);
      if (seen.size > CYCLE_TIME_TYPE_LIMIT) {
        break;
      }
      const value = Number(staticData.getTypeDogmaAttribute(typeID, ATTRIBUTE_DURATION, null));
      // null, never 0: a module with no duration attribute does not cycle, and
      // "0 ms" would read as an instant one.
      baseCycleMs[String(typeID)] = Number.isFinite(value) && value > 0 ? value : null;
    }
    res.json({
      ok: true,
      source: "static-data",
      // Named on the wire, not just in a comment: every consumer is forced to
      // acknowledge that this is the base figure.
      baseCycleMs,
      capped: requested.length > CYCLE_TIME_TYPE_LIMIT,
      limit: CYCLE_TIME_TYPE_LIMIT,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * What the page's combat classifier wants to know of a type, from static reference data: its group and category,
 * its effects and attributes, and how much it holds and measures (nav/combatUtilities.ts, for the types of what
 * is fitted and what is in the hold). A retail client has all of it in its own static data.
 *
 * Until 2026-10-11 this was GET /api/bridge/combat-utility-types, under the bridge's path though it makes no call
 * of the server's. It refused a request of more than 100 types, one with anything in it that was no type's
 * number, and one with none; and it left out a type the tables did not know. Here, as the other static reads:
 * what is no type's number is passed over, a type is answered for once, and null is a real answer (the tables
 * have not both the type and its dogma), so that "not known" is told from "not asked".
 *
 * No gateway call and no live session: this cannot vary by player.
 */
const COMBAT_UTILITY_TYPE_LIMIT = 500;

app.get("/api/types/combat-utility", requireAuth, async (req, res, next) => {
  try {
    const asked = [];
    for (const part of String((req.query && req.query.typeIDs) || "").split(",")) {
      const typeID = Number(part);
      if (Number.isSafeInteger(typeID) && typeID > 0 && !asked.includes(typeID)) {
        asked.push(typeID);
      }
    }
    const types = {};
    for (const typeID of asked.slice(0, COMBAT_UTILITY_TYPE_LIMIT)) {
      const type = staticData.getType(typeID);
      const dogma = staticData.getTypeDogma(typeID);
      types[String(typeID)] = type && dogma
        ? {
          typeID,
          groupID: type.groupID,
          categoryID: staticData.getTypeCategoryID(typeID),
          effects: dogma.effects,
          attributes: dogma.attributes,
          capacity: Number.isFinite(type.capacity) ? type.capacity : null,
          volume: Number.isFinite(type.volume) ? type.volume : null,
        }
        : null;
    }
    res.json({
      ok: true,
      source: "static-data",
      types,
      // Said, not hidden: a type past the limit is not in the answer at all,
      // and a caller that asked for it must not take that for "not known".
      capped: asked.length > COMBAT_UTILITY_TYPE_LIMIT,
      limit: COMBAT_UTILITY_TYPE_LIMIT,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * A type's volume, from static reference data.
 *
 * A retail client has every type's volume in its own static data, and shows it beside whatever lists items. The
 * page has none: the routes here that list items send each type's volume beside the server's answer. Where the
 * page asks the server itself (bridge/assetReads.ts), it asks the volumes here, once for a type, as it asks a
 * type's cycle time. Null is a real answer: the tables have no volume for the type, and the page shows none.
 *
 * No gateway call and no live session: this cannot vary by player.
 */
const TYPE_VOLUME_TYPE_LIMIT = 500;

// GET /api/types/compressed?typeIDs=... answers { compressedTypeIDs }: each type's compressed form, or null where it
// has none, as the server compresses (staticData.getCompressedTypeID, the server's own reprocessing table). The
// client has it in its own static data (itemcompression/data.py) and offers to compress in space only a type that has
// one (menucheckers/itemCheckers.py, OfferCompressInSpace). A type the table cannot speak of is left out of the
// answer, and is not "none". Not a bridge call, and no live session: it cannot vary by player.
app.get("/api/types/compressed", requireAuth, (req, res, next) => {
  try {
    const asked = [];
    for (const part of String((req.query && req.query.typeIDs) || "").split(",")) {
      const typeID = Number(part);
      if (Number.isSafeInteger(typeID) && typeID > 0 && !asked.includes(typeID)) {
        asked.push(typeID);
      }
    }
    const compressedTypeIDs = {};
    for (const typeID of asked.slice(0, TYPE_VOLUME_TYPE_LIMIT)) {
      const compressed = typeof staticData.getCompressedTypeID === "function" ? staticData.getCompressedTypeID(typeID) : undefined;
      if (compressed !== undefined) {
        compressedTypeIDs[String(typeID)] = compressed;
      }
    }
    res.json({ ok: true, source: "static-data", compressedTypeIDs, capped: asked.length > TYPE_VOLUME_TYPE_LIMIT, limit: TYPE_VOLUME_TYPE_LIMIT });
  } catch (error) {
    next(error);
  }
});

// The client type lists that hold each of some types, of those asked (staticData.getTypeListsHolding: the client's
// evetypes.GetTypeIDsByListID), for a check the client makes against a list: a filament's game mode's hulls
// (abyss/game_mode.py is_ship_allowed). A type or a list the tables lack answers null.
app.get("/api/types/type-lists", requireAuth, (req, res, next) => {
  const ids = (value) => typeof value === "string" && /^\d+(?:,\d+)*$/.test(value) ? [...new Set(value.split(",").map(Number))] : [];
  const typeIDs = ids(req.query.typeIDs);
  const listIDs = ids(req.query.listIDs);
  if (!typeIDs.length || typeIDs.length > 32 || !listIDs.length || listIDs.length > 16 ||
    [...typeIDs, ...listIDs].some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    res.status(400).json({ ok: false, error: "INVALID_TYPE_LIST_QUERY", message: "Bounded type and type list IDs are required." });
    return;
  }
  try {
    const lists = {};
    for (const typeID of typeIDs) {
      lists[String(typeID)] = typeof staticData.getTypeListsHolding === "function" ? staticData.getTypeListsHolding(typeID, listIDs) : null;
    }
    res.json({ ok: true, source: "static-data", lists });
  } catch (error) {
    next(error);
  }
});

// A dungeon's ship restrictions, from a gate of it or all of it, as the client's Ship Restrictions window shows them
// (evedungeons/client/ship_restrictions_window.py set_dungeon; staticData.getDungeonShipRestrictions, the client's
// GetDungeonShipRestrictions): the dungeon's name's message, the gate's type list, the published ship types let
// through with their groups, and the published ones of those groups that are not (the window's restricted ones).
// The groups are the client's ship tree's where the client's data can be read (evetypes.GetShipGroupID, the type's
// isisGroupID; the groups' names' messages from its infoBubbleGroups: clientBuiltData), a type with none left out as
// the window's _validate_type leaves it; else the inventory groups, and `shipTree` false.
app.get("/api/dungeons/ship-restrictions", requireAuth, async (req, res, next) => {
  const dungeonID = Number(req.query.dungeonID);
  const gateID = req.query.gateID === undefined || req.query.gateID === "" ? null : Number(req.query.gateID);
  if (!Number.isSafeInteger(dungeonID) || dungeonID <= 0 || (gateID !== null && (!Number.isSafeInteger(gateID) || gateID <= 0))) {
    res.status(400).json({ ok: false, error: "INVALID_DUNGEON", message: "A dungeon is asked for by its number, and a gate of it by its own." });
    return;
  }
  try {
    const restrictions = typeof staticData.getDungeonShipRestrictions === "function" ? staticData.getDungeonShipRestrictions(dungeonID, gateID) : null;
    if (!restrictions) {
      res.json({ ok: true, found: false });
      return;
    }
    const [shipGroups, treeGroups] = await Promise.all([
      clientBuiltData.table("typeShipGroups").catch(() => null),
      typeof clientBuiltData.infoBubbleGroups === "function" ? clientBuiltData.infoBubbleGroups().catch(() => null) : null,
    ]);
    const shipTree = Boolean(shipGroups && treeGroups);
    const groupOf = (typeID, type) => (shipTree ? Number(shipGroups[String(typeID)]) || 0 : Number(type.groupID) || 0);
    // A published ship (the types' isisGroupID is set on some that are no ships; the client takes a group's types from
    // its ship tree, which has ships alone: shipTreeSvc.GetShipTypeIDsByGroupID).
    const shown = (typeID) => {
      const type = staticData.getType(typeID);
      const groupID = type && type.published === true && Number(type.categoryID) === 6 ? groupOf(typeID, type) : 0;
      return groupID > 0 ? { typeID: Number(typeID), groupID } : null;
    };
    const allowed = restrictions.allowedShipTypes.map(shown).filter(Boolean);
    const allowedIDs = new Set(allowed.map((entry) => entry.typeID));
    const groups = new Set(allowed.map((entry) => entry.groupID));
    const groupTypeIDs = shipTree
      ? Object.keys(shipGroups).filter((typeID) => groups.has(Number(shipGroups[typeID]))).map(Number)
      : [...groups].flatMap((groupID) => typeof staticData.getTypesInGroup === "function" ? staticData.getTypesInGroup(groupID).map((type) => Number(type.typeID)) : []);
    const restricted = groupTypeIDs.map(shown).filter((entry) => entry && !allowedIDs.has(entry.typeID));
    const groupNames = {};
    if (shipTree) {
      for (const groupID of groups) {
        const group = treeGroups[String(groupID)];
        if (group) groupNames[String(groupID)] = { nameID: group.nameID, iconSmall: group.iconSmall };
      }
    }
    res.json({ ok: true, found: true, dungeonNameID: restrictions.dungeonNameID, typeListID: restrictions.typeListID, shipTree, groups: groupNames, allowed, restricted });
  } catch (error) {
    next(error);
  }
});

// An objective chain as the client reads it without asking the server (objectives/common/objectives_data.py, read with
// the client's own loaders: clientBuiltData): the chain, the types of its objectives, the types of their tasks, and the
// types of each type list its context's parameters name (staticData.getTypeIDsByListID, the client's
// evetypes.GetTypeIDsByListID), for the Abyssal info panel (abyssal_service.py ABYSS_OBJECTIVE_CHAIN_ID). found false
// where the client's data cannot be read or has no such chain.
app.get("/api/objectives/chain", requireAuth, async (req, res, next) => {
  const chainID = Number(req.query.chainID);
  if (!Number.isSafeInteger(chainID) || chainID <= 0) {
    res.status(400).json({ ok: false, error: "INVALID_OBJECTIVE_CHAIN", message: "An objective chain is asked for by its number." });
    return;
  }
  try {
    const [chains, objectiveTypes, taskTypes] = await Promise.all([
      clientBuiltData.table("objectiveChains").catch(() => null),
      clientBuiltData.table("objectiveTypes").catch(() => null),
      clientBuiltData.table("objectiveTaskTypes").catch(() => null),
    ]);
    const chain = chains && Object.hasOwn(chains, String(chainID)) ? chains[String(chainID)] : null;
    if (!chain || !objectiveTypes || !taskTypes) {
      res.json({ ok: true, found: false });
      return;
    }
    const objectives = {};
    const tasks = {};
    for (const objective of Array.isArray(chain.objectives) ? chain.objectives : []) {
      const objectiveType = objectiveTypes[String(objective && objective.objectiveType)];
      if (!objectiveType) continue;
      objectives[String(objective.objectiveType)] = objectiveType;
      for (const task of Array.isArray(objectiveType.tasks) ? objectiveType.tasks : []) {
        const taskType = taskTypes[String(task && task.taskType)];
        if (taskType) tasks[String(task.taskType)] = taskType;
      }
    }
    const typeLists = {};
    for (const parameter of Array.isArray(chain.contextParameters) ? chain.contextParameters : []) {
      const listID = Number(parameter && parameter.defaultValue);
      if (parameter && parameter.parameterType === "eveTypeListIdType" && Number.isSafeInteger(listID) && listID > 0 &&
        typeof staticData.getTypeIDsByListID === "function") {
        typeLists[String(listID)] = staticData.getTypeIDsByListID(listID);
      }
    }
    res.json({ ok: true, found: true, chainID, chain, objectiveTypes: objectives, taskTypes: tasks, typeLists });
  } catch (error) {
    next(error);
  }
});

app.get("/api/types/volumes", requireAuth, async (req, res, next) => {
  try {
    const asked = [];
    for (const part of String((req.query && req.query.typeIDs) || "").split(",")) {
      const typeID = Number(part);
      if (Number.isSafeInteger(typeID) && typeID > 0 && !asked.includes(typeID)) {
        asked.push(typeID);
      }
    }
    const volumes = {};
    // And each type's packaged volume (inventorycommon/util.py GetPackagedVolume: the client's own override for the
    // type, else for its group, else the type's own; src/clientData/holdCapacity.js), where the client's tables can be
    // read; null where they cannot, or the type is not known. The multibuy window's volume is so reckoned.
    const packagedTables = await packagedTablesOrNull();
    const packaged = {};
    for (const typeID of asked.slice(0, TYPE_VOLUME_TYPE_LIMIT)) {
      volumes[String(typeID)] = staticTypeVolume(typeID);
      const type = typeof staticData.getType === "function" ? staticData.getType(typeID) : null;
      const packed = packagedTables && type ? packagedVolume(typeID, Number(type.groupID), staticTypeVolume, packagedTables) : null;
      packaged[String(typeID)] = typeof packed === "number" && Number.isFinite(packed) ? packed : null;
    }
    res.json({
      ok: true,
      source: "static-data",
      volumes,
      packaged,
      // Said, not hidden: a type past the limit is not in the answer at all,
      // and a caller that asked for it must not take that for "has none".
      capped: asked.length > TYPE_VOLUME_TYPE_LIMIT,
      limit: TYPE_VOLUME_TYPE_LIMIT,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * A module type's overload effect, from static reference data.
 *
 * The retail client overloads a module by naming the ID of the module's own
 * effect of the overload category: its module button finds it among the
 * module's effects (shipmodulebutton.py 231), and godma sends
 * Overload(itemID, effectID) with it (godma.py 2075; recorded on Tranquility as
 * Overload(moduleID, 3001)). The page knows a module's type and nothing of its
 * effects, so it asks here, once for a type, as it asks a type's cycle time.
 * Null is a real answer: the type has no overload effect, and the client has
 * no overload button for such a module.
 *
 * No gateway call and no live session: this cannot vary by player.
 */
const OVERLOAD_EFFECT_TYPE_LIMIT = 500;

/**
 * A module type's default effect, by name, from the game's data (staticData.getDefaultEffectName): what the client
 * names in every Activate and Deactivate it makes, and what the page names in its own since 2026-10-14
 * (web/src/bridge/dogmaWrites.ts). Null for a type with none or more than one. No call of the server's.
 */
app.get("/api/types/default-effects", requireAuth, async (req, res, next) => {
  try {
    const asked = [];
    for (const part of String((req.query && req.query.typeIDs) || "").split(",")) {
      const typeID = Number(part);
      if (Number.isSafeInteger(typeID) && typeID > 0 && !asked.includes(typeID)) {
        asked.push(typeID);
      }
    }
    const defaultEffect = {};
    for (const typeID of asked.slice(0, OVERLOAD_EFFECT_TYPE_LIMIT)) {
      defaultEffect[String(typeID)] = staticData.getDefaultEffectName(typeID);
    }
    res.json({
      ok: true,
      source: "static-data",
      defaultEffect,
      // Said, not hidden: a type past the limit is not in the answer at all.
      capped: asked.length > OVERLOAD_EFFECT_TYPE_LIMIT,
      limit: OVERLOAD_EFFECT_TYPE_LIMIT,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * A type's passive effects, as the client's dogma static service filters them (GetPassiveFilteredEffectsByType), from
 * static reference data: what the client asks to tell a booster a skill accelerator (dogma/effects IsBoosterSkillAccelerator).
 * Null for a type the tables do not know. No gateway call and no live session: it cannot vary by player.
 */
const PASSIVE_EFFECT_TYPE_LIMIT = 500;
app.get("/api/types/passive-effects", requireAuth, async (req, res, next) => {
  try {
    const asked = [];
    for (const part of String((req.query && req.query.typeIDs) || "").split(",")) {
      const typeID = Number(part);
      if (Number.isSafeInteger(typeID) && typeID > 0 && !asked.includes(typeID)) {
        asked.push(typeID);
      }
    }
    const effects = {};
    for (const typeID of asked.slice(0, PASSIVE_EFFECT_TYPE_LIMIT)) {
      effects[String(typeID)] = typeof staticData.getPassiveFilteredEffects === "function" ? staticData.getPassiveFilteredEffects(typeID) : null;
    }
    res.json({ ok: true, source: "static-data", effects, capped: asked.length > PASSIVE_EFFECT_TYPE_LIMIT, limit: PASSIVE_EFFECT_TYPE_LIMIT });
  } catch (error) {
    next(error);
  }
});

app.get("/api/types/overload-effects", requireAuth, async (req, res, next) => {
  try {
    const asked = [];
    for (const part of String((req.query && req.query.typeIDs) || "").split(",")) {
      const typeID = Number(part);
      if (Number.isSafeInteger(typeID) && typeID > 0 && !asked.includes(typeID)) {
        asked.push(typeID);
      }
    }
    const overloadEffectID = {};
    for (const typeID of asked.slice(0, OVERLOAD_EFFECT_TYPE_LIMIT)) {
      overloadEffectID[String(typeID)] = staticData.getOverloadEffectID(typeID);
    }
    res.json({
      ok: true,
      source: "static-data",
      overloadEffectID,
      // Said, not hidden: a type past the limit is not in the answer at all,
      // and a caller that asked for it must not take that for "has none".
      capped: asked.length > OVERLOAD_EFFECT_TYPE_LIMIT,
      limit: OVERLOAD_EFFECT_TYPE_LIMIT,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * Whether a module type can be switched on at all, from static reference data:
 * the eve.js server's own test (staticData.getTypeActivatable), so the page can
 * leave a passive module alone instead of asking the server and being told
 * "... cannot be activated." The group says what a module is FOR; this says
 * whether it is something a pilot switches on. Null is a real answer: the
 * tables have no dogma for the type, which is "not known", never "passive".
 *
 * No gateway call and no live session: this cannot vary by player.
 */
const TYPE_ACTIVATION_TYPE_LIMIT = 500;

app.get("/api/types/activation", requireAuth, async (req, res, next) => {
  try {
    const asked = [];
    for (const part of String((req.query && req.query.typeIDs) || "").split(",")) {
      const typeID = Number(part);
      if (Number.isSafeInteger(typeID) && typeID > 0 && !asked.includes(typeID)) {
        asked.push(typeID);
      }
    }
    const activatable = {};
    for (const typeID of asked.slice(0, TYPE_ACTIVATION_TYPE_LIMIT)) {
      activatable[String(typeID)] = staticData.getTypeActivatable(typeID);
    }
    res.json({
      ok: true,
      source: "static-data",
      activatable,
      // Said, not hidden: a type past the limit is not in the answer at all,
      // and a caller that asked for it must not take that for "passive".
      capped: asked.length > TYPE_ACTIVATION_TYPE_LIMIT,
      limit: TYPE_ACTIVATION_TYPE_LIMIT,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * PI PLANNER — the planetary production recipe table, from static reference
 * data.
 *
 * Every recipe a colony factory can run lives in the gameStore's
 * `planetSchematics` table (68 rows), and it never varies by player, by
 * colony or by planet: schematic 65 makes Superconductors from Plasmoids and
 * Water everywhere in New Eden, forever. So unlike
 * /api/colonies, which projects one player's live pins, this route carries NO
 * colony, no planetID, no character context at all — it is the recipe BOOK,
 * not a page out of anyone's copy of it, which is also why it needs no
 * gateway call and no held session to answer.
 *
 * Raw `cycleTime` is renamed to `cycleTimeSeconds` on the wire on purpose: the
 * gameStore rows carry 1800 and 3600, which are seconds, and this repo has
 * already shipped a duration field once with the unit left to the reader's
 * imagination and watched a 285-year cycle render with every test agreeing.
 * Naming the unit is the guard this time.
 *
 * Every one of the 68 real rows carries exactly one `outputs` entry, but nothing
 * requires that of the table, so a row that does not is not something a
 * planner can turn into a recipe card — it is SKIPPED rather than guessed at.
 */
app.get("/api/pi/schematics", requireAuth, async (req, res, next) => {
  try {
    const typeNameOrNull = (typeID) => {
      const type = staticData.getType(typeID);
      const name = type && type.name;
      // null, never a stringified id (R7d) — a raw resource this reader has
      // not been taught to name is a fact the caller has to see, not a
      // "Type 2268" typo waiting to happen on screen.
      return typeof name === "string" && name.length > 0 ? name : null;
    };

    const schematics = [];
    for (const row of staticData.getAllPlanetSchematics()) {
      const rawOutputs = Array.isArray(row && row.outputs) ? row.outputs : [];
      if (rawOutputs.length !== 1) {
        continue;
      }
      const outputTypeID = Number(rawOutputs[0] && rawOutputs[0].typeID) || 0;
      const outputQuantity = Number(rawOutputs[0] && rawOutputs[0].quantity) || 0;
      if (outputTypeID <= 0 || outputQuantity <= 0) {
        continue;
      }

      const inputs = (Array.isArray(row.inputs) ? row.inputs : [])
        .map((input) => ({
          typeID: Number(input && input.typeID) || 0,
          typeName: typeNameOrNull(Number(input && input.typeID) || 0),
          quantity: Number(input && input.quantity) || 0,
        }))
        .filter((input) => input.typeID > 0 && input.quantity > 0);

      schematics.push({
        schematicID: Number(row.schematicID) || 0,
        name: typeof row.name === "string" && row.name.length > 0 ? row.name : null,
        cycleTimeSeconds: Number(row.cycleTime) || 0,
        factoryTypeIDs: (Array.isArray(row.pinTypeIDs) ? row.pinTypeIDs : [])
          .map((typeID) => Number(typeID) || 0)
          .filter((typeID) => typeID > 0),
        inputs,
        output: {
          typeID: outputTypeID,
          typeName: typeNameOrNull(outputTypeID),
          quantity: outputQuantity,
        },
      });
    }

    // Keyed by every typeID this table names anywhere, inputs and outputs
    // alike — a raw resource only ever shows up as an input, and the planner
    // still needs its tier to explain why it cannot be manufactured further.
    const commodities = {};
    for (const schematic of schematics) {
      commodities[String(schematic.output.typeID)] = {
        typeName: schematic.output.typeName,
        tier: staticData.getCommodityTier(schematic.output.typeID),
      };
      for (const input of schematic.inputs) {
        commodities[String(input.typeID)] = {
          typeName: input.typeName,
          tier: staticData.getCommodityTier(input.typeID),
        };
      }
    }

    res.json({
      ok: true,
      source: "static-data",
      schematics,
      commodities,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * NPC THREAT DOGMA — the static half of the drone-boat block's target priority.
 *
 * POST /api/types/dogma takes `{ typeIDs, attributeIDs }` and answers the RAW
 * attribute values each of those types carries. The drone-boat combat block
 * (docs/drone-boat-block-spec.md section 6) has to know, for a rat it can see
 * on the grid, whether that rat scrams (504 `entityWarpScrambleChance`, with
 * 103 `warpScrambleRange` as its reach), webs (20 `speedFactor`, negative), or
 * runs ewar (931 neut / 932 damp / 935 paint) — and every one of those numbers
 * is already sitting in the SDE's typeDogma table this BFF reads for charges.
 *
 * ZERO BRIDGE CALLS, no live session, no upstream server change. Like
 * /api/names, /api/ore/families and /api/types/cycle-times this is read-only
 * reference data that cannot vary by player, so the grid's NEW types cost one
 * round trip each and the caller caches everything it has already seen.
 *
 * ⚠ IT RETURNS NUMBERS AND NOTHING ELSE. No `isTackle`, no class, no ranking.
 * The classifier is one pure browser module (§6's table), and a second opinion
 * living here would be a second thing to keep in step with that table. The
 * route is deliberately dumb, and it stays that way.
 *
 * ⚠ A POST where its twin /api/types/cycle-times is a GET, only because the
 * request is TWO lists: a grid's worth of typeIDs crossed with the attribute
 * set overflows a sane query string. Nothing here mutates anything.
 */
// Read off the REAL module, not the injectable `staticData`, so the cap the
// route enforces is a fixed number a test double cannot move.
const TYPE_DOGMA_TYPE_LIMIT = staticDataModule.TYPE_ATTRIBUTES_MAX_TYPES;
const TYPE_DOGMA_ATTRIBUTE_LIMIT = staticDataModule.TYPE_ATTRIBUTES_MAX_ATTRIBUTES;

app.post("/api/types/dogma", requireAuth, async (req, res, next) => {
  const body = req.body || {};
  const { typeIDs, attributeIDs } = body;
  if (!Array.isArray(typeIDs) || !Array.isArray(attributeIDs)) {
    res.status(400).json({
      ok: false,
      error: "INVALID_REQUEST",
      message: "typeIDs and attributeIDs must both be arrays.",
    });
    return;
  }
  // ⚠ REJECTED, NOT TRUNCATED — the opposite of what /api/names does with an
  // oversized batch, and on purpose. A NAME that falls past a cap shows up as a
  // raw id on screen and the player shrugs; a TYPE that falls past this one
  // comes back carrying no attributes at all, which is exactly what a type with
  // no threat attributes looks like. The classifier would read it as "harmless"
  // and the block would park a drone boat next to a scram. A short answer here
  // cannot be told from a true one, so it must never be sent.
  if (typeIDs.length > TYPE_DOGMA_TYPE_LIMIT || attributeIDs.length > TYPE_DOGMA_ATTRIBUTE_LIMIT) {
    res.status(400).json({
      ok: false,
      error: "TOO_MANY_IDS",
      message:
        `At most ${TYPE_DOGMA_TYPE_LIMIT} typeIDs and ` +
        `${TYPE_DOGMA_ATTRIBUTE_LIMIT} attributeIDs per request.`,
    });
    return;
  }
  try {
    const result = staticData.readTypeAttributes({ typeIDs, attributeIDs });
    res.json({
      ok: true,
      source: "static-data",
      count: Object.keys(result.attributes).length,
      limit: TYPE_DOGMA_TYPE_LIMIT,
      attributeLimit: TYPE_DOGMA_ATTRIBUTE_LIMIT,
      // Keyed typeID -> attributeID -> value. An id the tables do not know is
      // present with an EMPTY object, never missing and never null, so the
      // caller caches "asked, got nothing" the way it does for /api/names.
      attributes: result.attributes,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * R15 industry RECIPES — the static half of the industry panel.
 *
 * Every NAME the panel needs is already reachable through /api/names: a
 * blueprint and its product are ordinary types ("type"), and a facility is a
 * station ("station") in a system ("system"). What /api/names cannot answer is
 * the RECIPE — which activities a blueprint supports, what each one consumes,
 * how long it takes, and what it produces. That comes from the 5,081 blueprint
 * definitions in static data, and it is what the install preview is built from.
 *
 * Read-only reference data (like /api/map/graph or /api/agents/find), NOT a
 * gateway call: none of it varies by player, so it never needs a round-trip to
 * EveJS. The player's OWN numbers — efficiencies, runs left, whether a
 * blueprint is busy — come from the live read instead.
 */
const INDUSTRY_DEFINITIONS_MAX = 500;

app.post("/api/industry/blueprints", requireAuth, async (req, res, next) => {
  try {
    const requested = Array.isArray(req.body && req.body.blueprintTypeIDs)
      ? req.body.blueprintTypeIDs
      : [];
    const unique = [];
    const seen = new Set();
    for (const value of requested) {
      const typeID = Number(value) || 0;
      if (typeID > 0 && !seen.has(typeID)) {
        seen.add(typeID);
        unique.push(typeID);
      }
    }
    const capped = unique.length > INDUSTRY_DEFINITIONS_MAX;
    const slice = capped ? unique.slice(0, INDUSTRY_DEFINITIONS_MAX) : unique;
    const definitions = {};
    for (const typeID of slice) {
      const definition = staticData.getIndustryBlueprint(typeID);
      // A definitive null is echoed too, so the client can cache the miss.
      definitions[String(typeID)] = definition
        ? {
            blueprintTypeID: definition.blueprintTypeID,
            blueprintName: definition.blueprintName,
            productTypeID: definition.productTypeID,
            productName: definition.productName,
            maxProductionLimit: definition.maxProductionLimit,
            activities: definition.activities || {},
          }
        : null;
    }
    res.json({
      ok: true,
      source: "static-data",
      count: slice.length,
      capped,
      limit: INDUSTRY_DEFINITIONS_MAX,
      definitions,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * R109 BUILD TREE — the recipe book seen from the product side.
 *
 * /api/industry/blueprints answers "what does this blueprint do". The Industry
 * Manager asks the reverse, all the way down: "what makes this, and what makes
 * each of its materials". Both routes below are static reference data, like the
 * one above: no gateway call, no session, nothing that varies by player.
 *
 * The index is built once per rows array (static data caches its rows, so that
 * is once per process) and kept off the request path.
 */
const INDUSTRY_CLOSURE_PRODUCTS_MAX = 50;
const industryRecipeIndexes = new WeakMap();

function industryRecipeIndex() {
  const rows = typeof staticData.getAllIndustryBlueprints === "function"
    ? staticData.getAllIndustryBlueprints()
    : [];
  const key = Array.isArray(rows) ? rows : [];
  let index = industryRecipeIndexes.get(key);
  if (!index) {
    index = industryRecipes.buildIndustryRecipeIndex(key);
    industryRecipeIndexes.set(key, index);
  }
  return index;
}

/** Name, group and category for one type, or null when static data has no row. */
function industryTypeInfo(typeID) {
  const type = typeof staticData.getType === "function" ? staticData.getType(typeID) : null;
  if (!type) {
    return null;
  }
  const name = typeof type.name === "string" && type.name.length > 0 ? type.name : null;
  const groupID = Number(type.groupID) || null;
  const categoryID = Number(type.categoryID) || null;
  const categoryName = categoryID && typeof staticData.getCategoryName === "function"
    ? staticData.getCategoryName(categoryID)
    : null;
  return {
    name,
    groupID,
    groupName: typeof type.groupName === "string" && type.groupName.length > 0 ? type.groupName : null,
    categoryID,
    categoryName: typeof categoryName === "string" && categoryName.length > 0 ? categoryName : null,
    volume: Number.isFinite(Number(type.volume)) ? Number(type.volume) : null,
  };
}

app.post("/api/industry/recipe-closure", requireAuth, async (req, res, next) => {
  try {
    const requested = Array.isArray(req.body && req.body.productTypeIDs)
      ? req.body.productTypeIDs
      : [];
    if (requested.length > INDUSTRY_CLOSURE_PRODUCTS_MAX) {
      res.status(400).json({
        ok: false,
        error: "TOO_MANY_PRODUCTS",
        message: `Ask about at most ${INDUSTRY_CLOSURE_PRODUCTS_MAX} products at a time.`,
      });
      return;
    }
    const closure = industryRecipes.recipeClosure(industryRecipeIndex(), requested);
    const types = {};
    for (const typeID of closure.typeIDs) {
      // A definitive null is sent too, so the client can tell "asked, unknown"
      // from "never asked".
      types[String(typeID)] = industryTypeInfo(typeID);
    }
    // Per skill a manufacturing recipe asks for: its time bonus per level
    // (dogma 1982), when it has one. The server shortens a manufacturing job by
    // these (industryParityHelpers.js resolveRequiredSkillTimeModifier); only a
    // negative value counts there, so only those are sent.
    const skillTimePercent = {};
    for (const recipe of closure.recipes) {
      if (recipe.activity !== "manufacturing") continue;
      for (const skill of recipe.skills || []) {
        const key = String(skill.typeID);
        if (key in skillTimePercent || typeof staticData.getTypeDogmaAttribute !== "function") continue;
        const value = Number(staticData.getTypeDogmaAttribute(skill.typeID, 1982, null));
        if (Number.isFinite(value) && value < 0) skillTimePercent[key] = value;
      }
    }
    res.json({
      ok: true,
      source: "static-data",
      recipes: closure.recipes,
      types,
      skillTimePercent,
      missing: closure.missing,
      capped: closure.capped,
      limit: closure.limit,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * R109 slice 6 -- what invention odds are made of, from static data.
 *
 * The server works an invention chance as (base) x (1 + sum over the activity's
 * skills of level x 1/30, or 1/40 for a skill in client type list 799) x (the
 * decryptor's multiplier), capped at 1
 * (server/src/services/industry/industryRuntimeState.js computeInventionProbability).
 * This route hands the browser the two facts it cannot derive: which skills are
 * on list 799, read from the same table the server matches against, and every
 * decryptor with the four attributes the server reads off it (1112 chance
 * multiplier, 1113 material efficiency, 1114 time efficiency, 1124 extra runs).
 */
const DECRYPTOR_GROUP_ID = 1304;
const LOWER_INVENTION_SKILL_TYPE_LIST_ID = 799;

app.get("/api/industry/invention-terms", requireAuth, async (req, res, next) => {
  try {
    const list = typeof staticData.getClientTypeList === "function"
      ? staticData.getClientTypeList(LOWER_INVENTION_SKILL_TYPE_LIST_ID)
      : null;
    const lowerRateSkillTypeIDs = Array.isArray(list && list.includedTypeIDs)
      ? list.includedTypeIDs.map((typeID) => Number(typeID) || 0).filter((typeID) => typeID > 0)
      : [];
    const attribute = (typeID, attributeID, fallback) => {
      const value = Number(staticData.getTypeDogmaAttribute(typeID, attributeID, null));
      return Number.isFinite(value) ? value : fallback;
    };
    const decryptors = (typeof staticData.getTypesInGroup === "function" ? staticData.getTypesInGroup(DECRYPTOR_GROUP_ID) : [])
      .map((type) => ({
        typeID: Number(type.typeID) || 0,
        name: typeof type.name === "string" && type.name.length > 0 ? type.name : null,
        probabilityMultiplier: attribute(type.typeID, 1112, 1),
        materialEfficiency: Math.trunc(attribute(type.typeID, 1113, 0)),
        timeEfficiency: Math.trunc(attribute(type.typeID, 1114, 0)),
        maxRuns: Math.trunc(attribute(type.typeID, 1124, 0)),
      }))
      .filter((decryptor) => decryptor.typeID > 0)
      .sort((a, b) => (a.name || "").localeCompare(b.name || "") || a.typeID - b.typeID);
    res.json({ ok: true, source: "static-data", lowerRateSkillTypeIDs, decryptors });
  } catch (error) {
    next(error);
  }
});

// Saved PI expansion plans. Same four routes as PI plans.
app.get("/api/pi/expansions", requireAuth, (req, res, next) => {
  try {
    res.json({ ok: true, plans: piExpansions.list() });
  } catch (error) {
    sendPiExpansionError(res, error, next);
  }
});
app.post("/api/pi/expansions", requireAuth, (req, res, next) => {
  try {
    res.json({ ok: true, plan: piExpansions.create(req.body || {}) });
  } catch (error) {
    sendPiExpansionError(res, error, next);
  }
});
app.post("/api/pi/expansions/:planID", requireAuth, (req, res, next) => {
  try {
    const { baseRev, ...fields } = req.body || {};
    res.json({ ok: true, plan: piExpansions.update(req.params.planID, fields, baseRev) });
  } catch (error) {
    sendPiExpansionError(res, error, next);
  }
});
app.post("/api/pi/expansions/:planID/delete", requireAuth, (req, res, next) => {
  try {
    res.json({ ok: true, removed: piExpansions.remove(req.params.planID) });
  } catch (error) {
    sendPiExpansionError(res, error, next);
  }
});

/**
 * GET /api/pi/planets-near?systemID=&jumps= -- every planet within that many
 * stargate jumps, with what each carries. Static map data, no session: where a
 * colony could go is a fact about the map, not about any pilot.
 */
app.get("/api/pi/planets-near", requireAuth, (req, res, next) => {
  try {
    const near = staticData.getPlanetsNear(Number(req.query.systemID) || 0, Number(req.query.jumps) || 0);
    if (!near) {
      res.status(404).json({ ok: false, error: "SYSTEM_NOT_FOUND", message: "That solar system is not on the map." });
      return;
    }
    res.json({ ok: true, ...near });
  } catch (error) {
    next(error);
  }
});

// R109 slice 3 -- saved Industry Manager plans. Same four routes as PI plans.
app.get("/api/industry/plans", requireAuth, (req, res, next) => {
  try {
    res.json({ ok: true, plans: industryPlans.list() });
  } catch (error) {
    sendIndustryPlanError(res, error, next);
  }
});
app.post("/api/industry/plans", requireAuth, (req, res, next) => {
  try {
    res.json({ ok: true, plan: industryPlans.create(req.body || {}) });
  } catch (error) {
    sendIndustryPlanError(res, error, next);
  }
});
app.post("/api/industry/plans/:planID", requireAuth, (req, res, next) => {
  try {
    const { baseRev, ...fields } = req.body || {};
    res.json({ ok: true, plan: industryPlans.update(req.params.planID, fields, baseRev) });
  } catch (error) {
    sendIndustryPlanError(res, error, next);
  }
});
app.post("/api/industry/plans/:planID/delete", requireAuth, (req, res, next) => {
  try {
    res.json({ ok: true, removed: industryPlans.remove(req.params.planID) });
  } catch (error) {
    sendIndustryPlanError(res, error, next);
  }
});

app.get("/api/industry/blueprints/search", requireAuth, async (req, res, next) => {
  try {
    const result = industryRecipes.searchIndustryBlueprints(
      industryRecipeIndex(),
      typeof req.query.q === "string" ? req.query.q : "",
      req.query.limit,
    );
    res.json({
      ok: true,
      source: "static-data",
      matches: result.matches.map((match) => {
        const product = industryTypeInfo(match.productTypeID);
        return { ...match, productName: product ? product.name : null };
      }),
      total: result.total,
      capped: result.capped,
      limit: result.limit,
    });
  } catch (error) {
    next(error);
  }
});

// Agent Finder (goal R6a): list agents from the static agentAuthority reference
// table so the player can find a courier agent to travel to (the per-station
// GetAgents roster is unreliable for this). Read-only static reference data —
// like /api/map/graph, NOT a gateway/bridge call. Filters server-side by kind
// (default courier) + optional level and caps the result so the ~11k-agent
// dataset never crosses the wire whole; the client sorts by jumps from the
// current system (distancesFrom, a single client-side BFS) and renders a page.
app.get("/api/agents/find", requireAuth, async (req, res, next) => {
  try {
    const kind = typeof req.query.kind === "string" ? req.query.kind : "courier";
    const level = req.query.level !== undefined ? Number(req.query.level) : null;
    const limit = req.query.limit !== undefined ? Number(req.query.limit) : undefined;
    const result = staticData.findAgents({ kind, level, limit });
    res.json({
      ok: true,
      source: "static-data",
      kind: result.kind,
      level: result.level,
      total: result.total,
      capped: result.capped,
      limit: result.limit,
      count: result.agents.length,
      agents: result.agents,
    });
  } catch (error) {
    next(error);
  }
});

// ── Player Bot Builder library (goal D2) ───────────────────────────────────
// PLATFORM-WIDE CRUD over data/bot-scripts.json. requireAuth still gates every
// route — you must be signed in — but the library is no longer partitioned by
// account: every script is visible to every account, and req.account is used
// only to record who WROTE a new one. The store enforces size, quota, and the
// optimistic revision. This is WEB-APP data — it never touches eve.js.
//
// ⚠ Script visibility is global; AUTHORITY IS NOT. Nothing here grants any right
// over a character or a running bot. The bot-start route below proves character
// ownership separately (`getCharacterForAccount`), and botHost keeps its own
// per-account filter on listing and stopping bots. Do not fold those checks into
// this lookup.
app.get("/api/botscripts", requireAuth, (req, res, next) => {
  try {
    res.json({ ok: true, scripts: botScripts.list() });
  } catch (error) {
    next(error);
  }
});
app.get("/api/botscripts/:scriptID", requireAuth, (req, res, next) => {
  try {
    const record = botScripts.get(req.params.scriptID);
    if (!record) {
      res.status(404).json({ ok: false, error: "BOTSCRIPT_NOT_FOUND", message: "That bot could not be found." });
      return;
    }
    res.json({
      ok: true,
      scriptID: record.scriptID,
      authorAccountID: record.authorAccountID,
      authorName: record.authorName,
      rev: record.rev,
      name: record.name,
      updatedAt: record.updatedAt,
      categoryID: record.categoryID,
      doc: record.doc,
    });
  } catch (error) {
    next(error);
  }
});
app.post("/api/botscripts", requireAuth, (req, res, next) => {
  try {
    const body = req.body || {};
    const result = botScripts.create(
      req.account.accountID,
      req.account.username,
      body.doc,
      body.categoryID,
    );
    res.json({ ok: true, ...result });
  } catch (error) {
    sendBotScriptError(res, error, next);
  }
});
// Filing bots in a category (null = Uncategorized). Declared before
// "/api/botscripts/:scriptID" so "category" is never read as a script id.
app.post("/api/botscripts/category", requireAuth, (req, res, next) => {
  try {
    const body = req.body || {};
    const result = botScripts.setCategory(body.scriptIDs, body.categoryID);
    res.json({ ok: true, ...result });
  } catch (error) {
    sendBotScriptError(res, error, next);
  }
});
app.post("/api/botscripts/:scriptID", requireAuth, (req, res, next) => {
  try {
    const body = req.body || {};
    const result = botScripts.update(req.params.scriptID, body.doc, body.baseRev, body.categoryID);
    res.json({ ok: true, ...result });
  } catch (error) {
    sendBotScriptError(res, error, next);
  }
});
app.post("/api/botscripts/:scriptID/delete", requireAuth, (req, res, next) => {
  try {
    const removed = botScripts.remove(req.params.scriptID);
    res.json({ ok: true, removed });
  } catch (error) {
    next(error);
  }
});

// ── Bot library categories ─────────────────────────────────────────────────
// Folders over the same shared library, kept in the same file. Deleting a
// category never deletes a bot: its bots become Uncategorized.
app.get("/api/botcategories", requireAuth, (req, res, next) => {
  try {
    res.json({ ok: true, categories: botScripts.listCategories() });
  } catch (error) {
    next(error);
  }
});
app.post("/api/botcategories", requireAuth, (req, res, next) => {
  try {
    const result = botScripts.createCategory((req.body || {}).name);
    res.json({ ok: true, ...result });
  } catch (error) {
    sendBotScriptError(res, error, next);
  }
});
app.post("/api/botcategories/:categoryID", requireAuth, (req, res, next) => {
  try {
    const body = req.body || {};
    if (body.name !== undefined) {
      botScripts.renameCategory(req.params.categoryID, body.name);
    }
    if (body.index !== undefined) {
      botScripts.moveCategory(req.params.categoryID, body.index);
    }
    res.json({ ok: true });
  } catch (error) {
    sendBotScriptError(res, error, next);
  }
});
app.post("/api/botcategories/:categoryID/delete", requireAuth, (req, res, next) => {
  try {
    const result = botScripts.removeCategory(req.params.categoryID);
    res.json({ ok: true, ...result });
  } catch (error) {
    sendBotScriptError(res, error, next);
  }
});

// ── Saved Planetary Industry plans (R108) ──────────────────────────────────
// CRUD over pi_plans in data/companion.sqlite. A plan is intent -- commodity,
// quantity, note, active or done -- and the browser re-plans it from live
// stock. Global like the bot library; requireAuth only proves a sign-in.
app.get("/api/pi/plans", requireAuth, (req, res, next) => {
  try {
    res.json({ ok: true, plans: piPlans.list() });
  } catch (error) {
    sendPiPlanError(res, error, next);
  }
});
app.post("/api/pi/plans", requireAuth, (req, res, next) => {
  try {
    res.json({ ok: true, plan: piPlans.create(req.body || {}) });
  } catch (error) {
    sendPiPlanError(res, error, next);
  }
});
app.post("/api/pi/plans/:planID", requireAuth, (req, res, next) => {
  try {
    const { baseRev, ...fields } = req.body || {};
    res.json({ ok: true, plan: piPlans.update(req.params.planID, fields, baseRev) });
  } catch (error) {
    sendPiPlanError(res, error, next);
  }
});
app.post("/api/pi/plans/:planID/delete", requireAuth, (req, res, next) => {
  try {
    res.json({ ok: true, removed: piPlans.remove(req.params.planID) });
  } catch (error) {
    sendPiPlanError(res, error, next);
  }
});

const MINING_OPERATION_STATUS = {
  MINING_OPERATION_INVALID: 400,
  MINING_OPERATION_NOT_FOUND: 404,
  MINING_OPERATION_ACTIVE: 409,
};
function sendMiningOperationError(res, error, next) {
  const status = error && MINING_OPERATION_STATUS[error.code];
  if (status) {
    res.status(status).json({ ok: false, error: error.code, message: error.message });
    return;
  }
  next(error);
}

function operationPayload() {
  return {
    operations: miningOperations.list(botHost.listAll()),
    targetBoard: miningTargetBoard.list(),
    capabilities: {
      hostedRunPolicy: config.hostedRunPolicy,
      profileFamilies: familyCapabilities(),
      targetClasses: {
        BELT: { executable: true, note: "Current-system belt discovery and mining are supported." },
        ORE_ANOMALY: { executable: true, note: "Current-system scanner sites only; explicit Ore Anomaly profiles." },
        ICE: { executable: true, note: "Current-system ice sites; online Ice Harvesters required. No Mining Drones." },
        GAS: { executable: false, note: "Scanner classification exists, but no gas-site travel block exists." },
      },
      reach: {
        CURRENT_SYSTEM: { executable: true },
        CURRENT_AND_ADJACENT: {
          executable: false,
          note: "Modeled; v0.1 executes in the anchor system and never invents remote scanner data.",
        },
      },
      defender: {
        executable: true,
        note: "Standard Defender only: operation-owned targets and shared combat. Custom defender routines are unsupported.",
      },
      operationOwnedContainers: {
        executable: false,
        note: "Existing global leased container claims remain authoritative.",
      },
    },
  };
}

app.get("/api/mining-operations", requireAuth, (req, res, next) => {
  try {
    res.json({ ok: true, ...operationPayload() });
  } catch (error) {
    next(error);
  }
});

app.get("/api/mining-operations/resources", requireAuth, (req, res, next) => {
  try { res.json({ ok: true, resources: staticData.listMiningResources() }); } catch (error) { next(error); }
});

function canonicalOperationArea(area) {
  const systemID = Number(area?.anchorSystemID);
  const system = Number.isSafeInteger(systemID) && systemID > 0
    ? staticData.getSolarSystem(systemID) : null;
  if (!system) {
    const error = new Error("Choose a known anchor solar system from the map catalog.");
    error.code = "MINING_OPERATION_INVALID";
    throw error;
  }
  const canonicalName = String(system.solarSystemName || "");
  if (area.anchorSystemName && String(area.anchorSystemName).trim() !== canonicalName) {
    const error = new Error("Anchor system name and ID do not identify the same solar system.");
    error.code = "MINING_OPERATION_INVALID";
    throw error;
  }
  return { ...area, anchorSystemID: systemID, anchorSystemName: canonicalName };
}

app.get("/api/mining-operations/routines", requireAuth, (req, res, next) => {
  try {
    const classes = String(req.query.classes || "BELT").split(",").filter((kind) => EXECUTABLE_TARGET_CLASSES.includes(kind));
    const unloadPolicy = req.query.unloadPolicy === "SELF_UNLOAD" ? "SELF_UNLOAD" : "HAULER_SERVICE";
    const definition = { unloadPolicy };
    const routines = botScripts.list().map((summary) => {
      const script = botScripts.get(summary.scriptID);
      const audit = script ? auditMiningScript(script.doc) : null;
      const roles = {};
      for (const role of ["MINER", "HAULER", "DEFENDER"]) {
        const reason = operationRoutineCompatibility(definition, role, audit, classes);
        roles[role] = { compatible: reason === null, reason };
      }
      return { scriptID: summary.scriptID, name: summary.name, rev: summary.rev, roles };
    });
    res.json({ ok: true, routines });
  } catch (error) { next(error); }
});

app.get("/api/mining-operations/accounts/:accountName/pilots", requireAuth, async (req, res, next) => {
  try {
    const accountName = String(req.params.accountName || "").trim();
    const account = accountName ? await store.getAccount(accountName) : null;
    if (!account || account.banned) {
      res.status(404).json({ ok: false, error: "ACCOUNT_NOT_FOUND", message: "That account is unavailable." });
      return;
    }
    const characters = await store.listCharactersForAccount(account.accountID);
    res.json({ ok: true, pilots: characters.map((row) => ({
      accountName,
      characterID: Number(row.characterID),
      characterName: String(row.characterName || `Pilot ${row.characterID}`),
    })) });
  } catch (error) { next(error); }
});

app.post("/api/mining-operations", requireAuth, (req, res, next) => {
  try {
    const existingID = req.body && req.body.operationID;
    if (existingID) {
      const runtime = miningOperations.runtimeFor(existingID);
      if (runtime && !["DRAFT", "STOPPED"].includes(runtime.state)) {
        res.status(409).json({ ok: false, error: "MINING_OPERATION_ACTIVE", message: "Stop the operation before editing it." });
        return;
      }
    }
    const input = req.body || {};
    validateResourcePolicy(input, input.policies?.resourcePolicy?.mode === "PREFER_LIST" ? staticData.listMiningResources() : []);
    const definition = miningOperationStore.save({ ...input, area: canonicalOperationArea(input.area) });
    res.json({ ok: true, definition, ...operationPayload() });
  } catch (error) {
    sendMiningOperationError(res, error, next);
  }
});

app.post("/api/mining-operations/:operationID/delete", requireAuth, (req, res, next) => {
  try {
    const outcome = miningOperations.remove(req.params.operationID);
    if (!outcome.ok) {
      res.status(MINING_OPERATION_STATUS[outcome.code] || 404).json(outcome);
      return;
    }
    res.json({ ok: true, ...operationPayload() });
  } catch (error) {
    next(error);
  }
});

function prepareMiningOperationLaunch(definition) {
  try {
    normalizePolicies(definition.policies, staticData.getStation, staticData.getSolarSystem);
    validateResourcePolicy(definition, definition.policies?.resourcePolicy?.mode === "PREFER_LIST" ? staticData.listMiningResources() : []);
  }
  catch (error) { return { ok: false, code: "MINING_OPERATION_INVALID", message: error.message }; }
  const selectedExecutable = definition.area.targetClasses.filter((kind) => EXECUTABLE_TARGET_CLASSES.includes(kind));
  if (selectedExecutable.length === 0 || selectedExecutable.length !== definition.area.targetClasses.length) return { ok: false, code: "NO_EXECUTABLE_TARGET_CLASS",
    message: `The selected target classes are modeled but not executable yet: ${definition.area.targetClasses.join(", ")}.` };
  const scripts = new Map();
  const audits = new Map();
  for (const member of definition.members) {
    const mode = member.routineMode || (member.automationID ? "CUSTOM" : "STANDARD");
    if (member.role === "DEFENDER" && mode !== "STANDARD") return { ok: false, code: "INCOMPATIBLE_OPERATION_ROUTINE",
      message: `${member.characterName}: DEFENDER requires the Standard Defender profile.` };
    let script;
    if (mode === "STANDARD") {
      if (!standardProfileFor(definition, member)) return { ok: false, code: "STANDARD_OPERATION_PROFILE_UNAVAILABLE",
        message: `${member.characterName}: No Standard profile exists for this target class, unload policy, and role. Choose a compatible Custom routine.` };
      const destination = definition.unloadDestination;
      const station = destination?.kind === "structure" ? null : destination && staticData.getStation(destination.stationID);
      const validStructure = destination?.kind === "structure" && isPlayerStructureID(destination.id) &&
        Boolean(destination.name) && staticData.getSolarSystemName(destination.solarSystemID) === destination.solarSystemName;
      const validStation = station && station.stationName === destination.stationName &&
        staticData.getSolarSystemName(Number(station.solarSystemID)) === destination.systemName;
      if ((!validStation && !validStructure) ||
          (destination.corporationDivision != null &&
            (!Number.isSafeInteger(destination.corporationDivision) || destination.corporationDivision < 1 || destination.corporationDivision > 7))) {
        return { ok: false, code: "STANDARD_UNLOAD_DESTINATION_REQUIRED",
          message: "Standard mining operations need a resolved unload destination and a personal or exact corporation hangar. Edit the operation destination before Start." };
      }
      script = buildStandardProfile(definition, member);
    } else {
      script = botScripts.get(member.automationID);
    }
    if (!script) return { ok: false, code: "INCOMPATIBLE_OPERATION_ROUTINE",
      message: `${member.characterName}: The referenced operation routine is unavailable.` };
    scripts.set(member.characterID, script);
    audits.set(member.characterID, auditMiningScript(script.doc));
  }
  const minerAudits = definition.members.filter((member) => member.role === "MINER")
    .map((member) => audits.get(member.characterID)).filter(Boolean);
  const commonClasses = selectedExecutable.filter((kind) => minerAudits.length > 0 &&
    minerAudits.every((audit) => audit.targetClasses.includes(kind)));
  if (commonClasses.length === 0) return { ok: false, code: "INCOMPATIBLE_OPERATION_ROUTINE",
    message: "The member routines do not share an executable operation target class." };
  for (const member of definition.members) {
    const reason = operationRoutineCompatibility(definition, member.role, audits.get(member.characterID), commonClasses);
    if (reason) return { ok: false, code: "INCOMPATIBLE_OPERATION_ROUTINE", message: `${member.characterName}: ${reason}` };
  }
  const planHash = createHash("sha256").update(JSON.stringify({ definition, scripts: [...scripts] })).digest("hex");
  const warnings = [];
  if (definition.policies?.parking.mode !== undefined && definition.policies.parking.mode !== "STAY_IN_PLACE") {
    const destination = definition.policies.parking.destination;
    warnings.push(`On manual Stop: ${definition.policies.parking.mode} at ${destination.kind === "structure" ? destination.name : destination.stationName}. Parking uses the remaining run grant; stop before it expires. Cans left in space are not collected as part of Stop.`);
  }
  return { ok: true, scripts, audits, commonClasses, planHash, warnings };
}

app.get("/api/mining-operations/preparation-options", requireAuth, async (req,res,next) => {
  try {
    const account = await store.getAccount(String(req.query.accountName || ""));
    const characterID=Number(req.query.characterID), providerCharacterID=Number(req.query.providerCharacterID || characterID);
    if (!account || account.banned || !await store.getCharacterForAccount(account.accountID,characterID))
      throw Object.assign(new Error("Account-owned pilot unavailable."),{code:"CHARACTER_NOT_FOUND",statusCode:409});
    const source = req.query.sourceKind==="corp" ? {kind:"corp",corporationID:Number(req.query.corporationID),division:Number(req.query.division)} : {kind:"hangar"};
    const definitions=await require("./provisioningRoutes").readProvisioningDefinitions({store,gateway,data:staticData,
      accountID:account.accountID,providerCharacterID});
    res.json({ok:true,definitions,pilot:{characterID,control:{state:"UNKNOWN"},quality:"UNAVAILABLE"},
      candidateSource:{...source,quality:"UNAVAILABLE",query:"UNKNOWN",take:"UNKNOWN",rows:[],revalidateOnApply:true}});
  } catch(error) { next(error); }
});
async function withMiningPreparationPlan(definition,plan,req) {
  if (!plan.ok) return plan;
  const held=bridgeSessions.get(req.webSessionID);
  const preparation=await miningPreparation.plan(definition,held ? {characterID:held.characterID,accountID:Number(held.accountID)} : null);
  return {...plan,preparation,planHash:createHash("sha256").update(JSON.stringify([plan.planHash,preparation.planHash])).digest("hex")};
}
app.get("/api/mining-operations/:operationID/launch-plan", requireAuth, async (req, res, next) => {
  try {
    const definition = miningOperations.definition(req.params.operationID);
    if (!definition) { res.status(404).json({ ok: false, error: "MINING_OPERATION_NOT_FOUND" }); return; }
    const plan = await withMiningPreparationPlan(definition,prepareMiningOperationLaunch(definition),req);
    if (!plan.ok) { res.status(409).json({ ok: false, error: plan.code, message: plan.message }); return; }
    res.json({ ok: true, planHash: plan.planHash, warnings: plan.warnings, preparation: plan.preparation,
      members: definition.members.map((member) => ({
      characterID: member.characterID, routineMode: member.routineMode || (member.automationID ? "CUSTOM" : "STANDARD"),
      script: plan.scripts.get(member.characterID),
    })) });
  } catch (error) { next(error); }
});

app.post("/api/mining-operations/:operationID/start", requireAuth, async (req, res, next) => {
  try {
    const definition = miningOperations.definition(req.params.operationID);
    if (!definition) {
      res.status(404).json({ ok: false, error: "MINING_OPERATION_NOT_FOUND", message: "That Mining Operation no longer exists." });
      return;
    }
    try { canonicalOperationArea(definition.area); } catch (error) {
      res.status(409).json({ ok: false, error: "MINING_OPERATION_INVALID", message: error.message });
      return;
    }
    const plan = await withMiningPreparationPlan(definition,prepareMiningOperationLaunch(definition),req);
    if (!plan.ok) { res.status(409).json({ ok: false, error: plan.code, message: plan.message }); return; }
    if (plan.preparation.state!=="READY") {
      res.status(409).json({ok:false,error:"OPERATION_EQUIPMENT_NOT_READY",preparation:plan.preparation,message:"Review member equipment/source before Start."});return;
    }
    if (req.body?.planHash !== plan.planHash) {
      res.status(409).json({ ok: false, error: "OPERATION_LAUNCH_PLAN_STALE",
        message: "The operation profile or destination changed since preflight. Review and Start again." });
      return;
    }
    const parkingStructure = definition.policies?.parking?.destination?.kind === "structure"
      ? definition.policies.parking.destination : null;
    if (parkingStructure) {
      // Check every intended member before begin() changes operation state or
      // the first bot starts. The held-session check in botHost still repeats
      // this against the actual ship and access state immediately before work.
      for (const member of definition.members) {
        const account = await store.getAccount(member.accountName);
        const character = account && !account.banned
          ? await store.getCharacterForAccount(account.accountID, member.characterID) : null;
        if (!character) {
          res.status(409).json({ ok: false, error: "PARKING_STRUCTURE_PILOT_UNAVAILABLE",
            message: `${member.characterName}: account-owned pilot is unavailable for structure preflight.` });
          return;
        }
        const checked = await gateway.callMethod("structureDirectory", "CheckMyDockingAccessToStructures", [[parkingStructure.id]], null, {
          userid: account.accountID, characterID: character.characterID,
          corporationID: character.corporationID || 0, corpid: character.corporationID || 0,
          allianceID: character.allianceID || 0,
        });
        if (!structureIDsFromList(checked.result).includes(parkingStructure.id)) {
          res.status(409).json({ ok: false, error: "PARKING_STRUCTURE_ACCESS_DENIED",
            message: `${member.characterName}: docking access to the parking structure is unavailable. No member was started.` });
          return;
        }
        if (definition.policies.parking.mode === "RETURN_HOME_UNLOAD_DOCK" &&
            definition.policies.parking.corporationDivision !== null) {
          const context = { userid: account.accountID, characterID: character.characterID,
            corporationID: character.corporationID || 0, corpid: character.corporationID || 0,
            allianceID: character.allianceID || 0 };
          try {
            const [services, offices] = await Promise.all([
              require("./stockCompatibility").structureServices(),
              gateway.callMethod("officeManager", "GetMyCorporationsOffices", [], null, context),
            ]);
            if (!structureIDsFromList(services.result).includes(3) ||
                !decodeOfficeRows(offices.result).some((office) => office.stationID === parkingStructure.id)) {
              res.status(409).json({ ok: false, error: "PARKING_STRUCTURE_CORP_HANGAR_UNAVAILABLE",
                message: `${member.characterName}: parking structure lacks an accessible corporation office. No member was started.` });
              return;
            }
          } catch {
            res.status(409).json({ ok: false, error: "PARKING_STRUCTURE_CORP_PREFLIGHT_UNREADABLE",
              message: `${member.characterName}: corporation hangar authority is unreadable. No member was started.` });
            return;
          }
        }
      }
    }
    const deliveryStructure = definition.unloadDestination?.kind === "structure"
      ? definition.unloadDestination : null;
    if (deliveryStructure) {
      for (const member of definition.members.filter((row) =>
        (row.routineMode || (row.automationID ? "CUSTOM" : "STANDARD")) === "STANDARD")) {
        const account = await store.getAccount(member.accountName);
        const character = account && !account.banned
          ? await store.getCharacterForAccount(account.accountID, member.characterID) : null;
        if (!character) {
          res.status(409).json({ ok: false, error: "DELIVERY_STRUCTURE_PILOT_UNAVAILABLE",
            message: `${member.characterName}: account-owned pilot is unavailable for structure delivery preflight.` });
          return;
        }
        const context = { userid: account.accountID, characterID: character.characterID,
          corporationID: character.corporationID || 0, corpid: character.corporationID || 0,
          allianceID: character.allianceID || 0 };
        try {
          const access = await gateway.callMethod("structureDirectory", "CheckMyDockingAccessToStructures", [[deliveryStructure.id]], null, context);
          if (!structureIDsFromList(access.result).includes(deliveryStructure.id)) {
            res.status(409).json({ ok: false, error: "DELIVERY_STRUCTURE_ACCESS_DENIED",
              message: `${member.characterName}: docking access to the delivery structure is unavailable. No member was started.` });
            return;
          }
          if (member.role !== "DEFENDER" && deliveryStructure.corporationDivision !== null) {
            if (character.corporationID !== deliveryStructure.corporationID) {
              res.status(409).json({ ok: false, error: "DELIVERY_CORPORATION_MISMATCH",
                message: `${member.characterName}: the configured strict destination belongs to a different corporation. No member was started.` });
              return;
            }
            const [services, offices] = await Promise.all([
              require("./stockCompatibility").structureServices(),
              gateway.callMethod("officeManager", "GetMyCorporationsOffices", [], null, context),
            ]);
            if (!structureIDsFromList(services.result).includes(3) ||
                !decodeOfficeRows(offices.result).some((office) => office.stationID === deliveryStructure.id)) {
              res.status(409).json({ ok: false, error: "DELIVERY_STRUCTURE_CORP_HANGAR_UNAVAILABLE",
                message: `${member.characterName}: the destination structure has no accessible office service and corporation office. No member was started.` });
              return;
            }
          }
        } catch (error) {
          res.status(409).json({ ok: false, error: "DELIVERY_STRUCTURE_PREFLIGHT_UNREADABLE",
            message: `${member.characterName}: structure service or corporation office authority is unreadable. No member was started.` });
          return;
        }
      }
    }
    const { scripts, audits, commonClasses } = plan;
    if (JSON.stringify(miningOperations.definition(definition.operationID))!==JSON.stringify(definition)) {
      res.status(409).json({ok:false,error:"OPERATION_LAUNCH_PLAN_STALE",message:"Operation configuration changed during preflight. Review and Start again."});return;
    }
    const operationRunID = randomUUID();
    const begin = miningOperations.begin(definition.operationID, commonClasses, operationRunID);
    if (!begin.ok) {
      res.status(MINING_OPERATION_STATUS[begin.code] || 409).json(begin);
      return;
    }
    const grants = req.body && typeof req.body.grants === "object" ? req.body.grants : {};
    const results = [];
    for (const member of definition.members) {
      const script = scripts.get(member.characterID);
      const audit = audits.get(member.characterID);
      let failure = null;
      if (!script || !audit) failure = "The referenced saved automation no longer exists.";
      else failure = operationRoutineCompatibility(definition, member.role, audit, commonClasses);
      if (failure) {
        miningOperations.memberFailed(definition.operationID, member.characterID, { code: "MEMBER_NOT_EXECUTABLE", message: failure });
        results.push({ characterID: member.characterID, ok: false, error: "MEMBER_NOT_EXECUTABLE", message: failure });
        continue;
      }
      const account = await store.getAccount(member.accountName);
      const character = account && !account.banned
        ? await store.getCharacterForAccount(account.accountID, member.characterID)
        : null;
      if (!account || account.banned || !character) {
        failure = "The pilot is not owned by the saved account, or that account is unavailable.";
        miningOperations.memberFailed(definition.operationID, member.characterID, { code: "CHARACTER_NOT_FOUND", message: failure });
        results.push({ characterID: member.characterID, ok: false, error: "CHARACTER_NOT_FOUND", message: failure });
        continue;
      }
      let callerSessionID = null;
      let callerHeld = null;
      const ownHeld = bridgeSessions.get(req.webSessionID);
      if (ownHeld && Number(ownHeld.characterID) === member.characterID) {
        callerSessionID = req.webSessionID;
        callerHeld = ownHeld;
      }
      if (hasPendingRecovery(callerHeld, member.characterID)) {
        failure = "This pilot's lost-drone recovery must finish before server handoff.";
        miningOperations.memberFailed(definition.operationID, member.characterID, { code: "DRONE_RECOVERY_PENDING", message: failure });
        results.push({ characterID: member.characterID, ok: false, error: "DRONE_RECOVERY_PENDING", message: failure });
        continue;
      }
      if (characterOperations.has(member.characterID) || (callerSessionID !== null && sessionOperations.has(callerSessionID))) {
        failure = "This pilot is changing sessions. Try this member again shortly.";
        miningOperations.memberFailed(definition.operationID, member.characterID, { code: "CHARACTER_IN_USE", message: failure });
        results.push({ characterID: member.characterID, ok: false, error: "CHARACTER_IN_USE", message: failure });
        continue;
      }
      const reservation = {kind:"mining-operation-handoff",operationID:definition.operationID,operationRunID};
      characterOperations.set(member.characterID, reservation);
      if (callerSessionID !== null) sessionOperations.set(callerSessionID, reservation);
      let released = false;
      let outcome;
      try {
        outcome = await botHost.start({
          account,
          characterID: member.characterID,
          kind: "script",
          scriptID: script.scriptID,
          scriptName: script.name,
          scriptRev: script.rev,
          doc: script.doc,
          grant: grants[String(member.characterID)],
          callerSessionID,
          operationID: definition.operationID,
          operationRole: member.role,
          operationControllerAccountID: Number(req.account.accountID),
          operationRunID,
          operationPreparation: plan.preparation.members.find(m=>m.characterID===member.characterID).intent,
          deferMain: true,
          beforeStart: callerSessionID === null ? null : async () => {
            const held = bridgeSessions.get(callerSessionID);
            if (held && Number(held.characterID) === member.characterID) {
              if (hasPendingRecovery(held, member.characterID)) {
                throw Object.assign(new Error("Lost-drone recovery is still pending."), { code: "DRONE_RECOVERY_PENDING" });
              }
              const status = await readHeldFlight(held, callerSessionID);
              if (status?.flight?.docked !== true) {
                if (status?.flight?.inSpace !== true || !(Number(held.activeShipID) > 0) ||
                    Number(status.flight.shipID) !== Number(held.activeShipID)) {
                  throw Object.assign(new Error("Pilot or ship could not be confirmed before handoff."), { code: "DRONE_HANDOFF_UNSAFE" });
                }
                let rows = null;
                try { rows = (await readDronesInSpace(held)).drones; } catch { /* unknown is unsafe */ }
                if (!handoffFlightReady(rows)) {
                  throw Object.assign(new Error("Return controlled drones before operation handoff."), { code: "DRONE_HANDOFF_UNSAFE" });
                }
              }
              await releaseHeldBridgeSession(callerSessionID, { confirmed: true });
              released = true;
            }
          },
          parkingStructureID: definition.policies?.parking?.destination?.kind === "structure"
            ? definition.policies.parking.destination.id : null,
        });
        if (
          !outcome.ok &&
          released &&
          callerSessionID !== null &&
          !bridgeSessions.has(callerSessionID) &&
          botHost.claimedBy(member.characterID) === null &&
          Number(callerHeld?.accountID) === Number(account.accountID)
        ) {
          try {
            const payload = auth.verifySessionToken(readSessionToken(req));
            if (payload?.sessionID === callerSessionID && Number(payload.accountID) === Number(account.accountID)) {
              if (!await restoreHeldCaller(callerSessionID, account, member.characterID, reservation))
                outcome.message = `${outcome.message || "This member could not start."} Browser ownership was not restored; review the pilot's current owner.`;
            }
          } catch (error) {
            errorLogger(error);
            outcome.message = `${outcome.message || "This member could not start."} Bring this pilot online again; its browser session could not be restored.`;
          }
        }
      } finally {
        if (characterOperations.get(member.characterID) === reservation) characterOperations.delete(member.characterID);
        if (callerSessionID !== null && sessionOperations.get(callerSessionID) === reservation) sessionOperations.delete(callerSessionID);
      }
      if (!outcome.ok) {
        miningOperations.memberFailed(definition.operationID, member.characterID, { code: outcome.code, message: outcome.message || outcome.code });
        results.push({ characterID: member.characterID, ok: false, error: outcome.code, message: outcome.message });
      } else {
        miningOperations.memberStarted(definition.operationID, member.characterID, outcome.bot.botID);
        results.push({ characterID: member.characterID, ok: true, bot: outcome.bot });
      }
    }
    await activatePreparedOperation(definition,operationRunID);
    miningOperations.finishLaunch(definition.operationID);
    res.json({ ok: true, results, ...operationPayload() });
  } catch (error) {
    next(error);
  }
});

const miningOperationStopper = createMiningOperationStopper({ operations: miningOperations, botHost });
app.post("/api/mining-operations/:operationID/extend", requireAuth, async (req, res, next) => {
  try {
    const extension = await extendMiningOperation({ operations: miningOperations, botHost, operationID: req.params.operationID,
      controllerAccountID: Number(req.account.accountID), minutes: req.body?.minutes });
    // Partial per-member results are not a transport failure; never auto-retry a write.
    res.json({ ok: true, extension, ...operationPayload() });
  } catch (error) { next(error); }
});
app.post("/api/mining-operations/:operationID/stop", requireAuth, async (req, res, next) => {
  try {
    const definition = miningOperations.definition(req.params.operationID);
    if (!definition) {
      res.status(404).json({ ok: false, error: "MINING_OPERATION_NOT_FOUND" });
      return;
    }
    if (miningOperations.runtimeFor(definition.operationID)?.state === "ASSEMBLING") {
      res.status(409).json({ ok: false, error: "OPERATION_START_IN_PROGRESS", message: "Pilot acquisition is still finishing. Retry Stop when assembly completes." });
      return;
    }
    const policy = normalizePolicies(definition.policies, staticData.getStation, staticData.getSolarSystem);
    const pending = miningOperationStopper.stop({ ...definition, policies: policy });
    if (policy.parking.mode !== "STAY_IN_PLACE") {
      void pending.catch(errorLogger);
      res.status(202).json({ ok: true, ...operationPayload() });
      return;
    }
    const failures = await pending;
    res.status(failures.length > 0 ? 409 : 200).json({ ok: failures.length === 0, failures, ...operationPayload() });
  } catch (error) {
    next(error);
  }
});

function requireMiningOperationClaim(req, res) {
  const held = requireHeldBridgeSession(req, res);
  if (!held) return null;
  const association = botHost.operationForClaim(held.characterID, req.get(botHostModule.BOT_HEADER));
  if (!association) {
    res.status(409).json({ ok: false, error: "MINING_OPERATION_CLAIM_REQUIRED" });
    return null;
  }
  return { held, association };
}

app.get("/api/mining-operations/support-context", requireAuth, async (req, res, next) => {
  try {
    const claim = requireMiningOperationClaim(req, res);
    if (!claim) return;
    const operationID = claim.association.operationID;
    const assignment = miningOperations.assignment(operationID, claim.held.characterID);
    if (!assignment?.support) return res.json({ ok: true, assignment, fleets: [] });
    const fleets = await botHost.readOperationFleets(operationID);
    const current = requireMiningOperationClaim(req, res);
    if (!current) return;
    if (current.held !== claim.held || current.association.operationID !== operationID) {
      return res.status(409).json({ ok: false, error: "OPERATION_CLAIM_CHANGED" });
    }
    res.json({ ok: true, assignment: miningOperations.assignment(operationID, claim.held.characterID), fleets });
  } catch (error) { next(error); }
});
app.post("/api/mining-operations/support-status", requireAuth, (req, res, next) => {
  try {
    const claim = requireMiningOperationClaim(req, res);
    if (!claim) return;
    const applied = miningOperations.observeSupport(claim.association.operationID, claim.held.characterID, req.body);
    res.status(applied ? 200 : 409).json({ ok: applied, error: applied ? undefined : "SUPPORT_REPORT_REFUSED" });
  } catch (error) { next(error); }
});
app.post("/api/mining-operations/support-stop", requireAuth, require("./miningSupportStopRoute").createMiningSupportStopHandler({
  requireClaim: requireMiningOperationClaim,
  assignment: (operationID, characterID) => miningOperations.assignment(operationID, characterID),
  readSpace: async held => (await gateway.readSpaceSnapshot(held.bridgeSessionID, { userid: held.accountID })).space,
  stop: operationID => {
    const definition = miningOperations.definition(operationID);
    const policy = normalizePolicies(definition.policies, staticData.getStation, staticData.getSolarSystem);
    // Do not await cleanup from the very runner being stopped.
    void miningOperationStopper.stop({ ...definition, policies: policy }).catch(errorLogger);
  },
}));

app.get("/api/mining-operations/assignment/current", requireAuth, (req, res, next) => {
  try {
    const held = requireHeldBridgeSession(req, res);
    if (!held) return;
    const secret = req.get(botHostModule.BOT_HEADER);
    if (!botHost.authorizesClaim(held.characterID, secret)) {
      res.status(409).json({ ok: false, error: "BOT_CLAIM_REQUIRED" });
      return;
    }
    // Ordinary hosted scripts probe once and receive null. Operation runners
    // carry the same private host capability plus their stable association.
    const association = botHost.operationForClaim(held.characterID, secret);
    const assignment = association
      ? miningOperations.assignment(association.operationID, held.characterID)
      : null;
    res.json({ ok: true, assignment });
  } catch (error) {
    next(error);
  }
});

app.post("/api/mining-operations/target/reserve", requireAuth, (req, res, next) => {
  try {
    const claim = requireMiningOperationClaim(req, res);
    if (!claim) return;
    const candidates = Array.isArray(req.body?.candidates) ? req.body.candidates : [req.body || {}];
    if (candidates.some(candidate => !candidate || Number(candidate.systemID) !== Number(claim.held.solarSystemID))) {
      return res.status(409).json({ ok: false, error: "SITE_SYSTEM_AUTHORITY_MISMATCH", message: "Target selection requires the pilot's current-system observation." });
    }
    miningOperations.reconcileBots(botHost.listAll());
    const outcome = miningOperations.reserveCandidates(claim.association.operationID, claim.held.characterID, candidates);
    res.json({ ok: true, ...outcome });
  } catch (error) {
    next(error);
  }
});

app.post("/api/mining-operations/target/activate", requireAuth, (req, res, next) => {
  try {
    const claim = requireMiningOperationClaim(req, res);
    if (!claim) return;
    const applied = miningOperations.activateTarget(claim.association.operationID, claim.held.characterID, String(req.body?.targetKey || ""));
    res.json({ ok: true, applied });
  } catch (error) {
    next(error);
  }
});

app.post("/api/mining-operations/target/depleted", requireAuth, (req, res, next) => {
  try {
    const claim = requireMiningOperationClaim(req, res);
    if (!claim) return;
    const applied = miningOperations.depleteTarget(
      claim.association.operationID,
      claim.held.characterID,
      String(req.body?.targetKey || ""),
      req.body?.evidence || {},
    );
    res.json({ ok: true, applied });
  } catch (error) {
    next(error);
  }
});

app.post("/api/mining-operations/member/ready", requireAuth, (req, res, next) => {
  try {
    const claim = requireMiningOperationClaim(req, res);
    if (!claim) return;
    res.json({ ok: true, applied: miningOperations.markReady(claim.association.operationID, claim.held.characterID) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/mining-operations/member/drain-complete", requireAuth, (req, res, next) => {
  try {
    const claim = requireMiningOperationClaim(req, res);
    if (!claim) return;
    res.json({
      ok: true,
      applied: miningOperations.finishDrain(
        claim.association.operationID,
        claim.held.characterID,
        String(req.body?.targetKey || ""),
      ),
    });
  } catch (error) {
    next(error);
  }
});

// ── Server-side bots (src/botHost.js) ───────────────────────────────────────
// A bot the SERVER flies: it keeps running when the tab that started it goes
// away. Start names a saved Bot Builder script, OR (kind: "companion") carries
// a fleet companion's own typed request — the host runs either on a session of
// its own. Everything is account-scoped through requireAuth, same as the
// script library above.
const BOT_START_STATUS = {
  BOTSCRIPT_INVALID: 400,
  BOTSCRIPT_REVISION_REQUIRED: 400,
  BOTCOMPANION_INVALID: 400,
  BOT_GRANT_REQUIRED: 400,
  BOT_GRANT_INVALID: 400,
  BOT_GRANT_STALE: 409,
  BOT_GRANT_EXPIRED: 409,
  BOT_SCRIPT_CHANGED: 409,
  BOT_RESTART_REQUIRES_CONFIRMATION: 409,
  BOT_SUBBOT_GRANT_UNAVAILABLE: 409,
  BOT_ALREADY_RUNNING: 409,
  CHARACTER_IN_USE: 409,
  CHARACTER_OWNERSHIP_UNVERIFIED: 409,
  PILOT_RELEASE_UNVERIFIED: 409,
  DRONE_RETURN_UNCONFIRMED: 409,
  DRONE_HANDOFF_UNSAFE: 409,
  DRONE_RECOVERY_PENDING: 409,
  CONTROL_SETTLEMENT_UNCONFIRMED: 409,
  BOT_STACK_UNAVAILABLE: 500,
  BOT_START_FAILED: 502,
};

app.get("/api/bots", requireAuth, (req, res, next) => {
  try {
    res.json({ ok: true, bots: botHost.list(req.account.accountID), hostedRunPolicy: config.hostedRunPolicy });
  } catch (error) {
    next(error);
  }
});

// ── Shared belt memory (goal: mine-ore-priority) ────────────────────────────
// In-process only, keyed by solar-system NAME then belt NAME (see
// src/beltMemory.js for why belt entity ids are not usable). No gateway call
// either way — this is BFF-local bookkeeping every account's bots share.
app.get("/api/bots/belt-memory", requireAuth, (req, res, next) => {
  try {
    const system = typeof req.query.system === "string" ? req.query.system.trim() : "";
    if (!system) {
      res.status(400).json({ ok: false, error: "INVALID_SYSTEM", message: "A system name is required." });
      return;
    }
    res.json({ ok: true, system, belts: beltMemory.dryBelts(system) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/bots/belt-memory", requireAuth, (req, res, next) => {
  try {
    const body = req.body || {};
    const system = typeof body.system === "string" ? body.system.trim() : "";
    const beltName = typeof body.beltName === "string" ? body.beltName.trim() : "";
    if (!system || !beltName) {
      res.status(400).json({
        ok: false,
        error: "INVALID_BELT",
        message: "A system name and a belt name are required.",
      });
      return;
    }
    let groupID = null;
    if (body.groupID !== null && body.groupID !== undefined) {
      const numeric = Number(body.groupID);
      if (!Number.isSafeInteger(numeric) || numeric <= 0) {
        res.status(400).json({
          ok: false,
          error: "INVALID_GROUP",
          message: "groupID must be null or a positive integer.",
        });
        return;
      }
      groupID = numeric;
    }
    beltMemory.markDry(system, beltName, groupID);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

// ── Shared loot memory (goal: stop flying to wrecks with nothing in them) ────
// In-process only, keyed by solar-system id then the can's own itemID (which,
// unlike a belt, IS a stable handle for as long as the wreck exists). No
// gateway call either way — BFF-local bookkeeping every account's pilots share.
//
// ⚠ WHY THIS CANNOT BE ANSWERED FROM A READ INSTEAD. The server refuses to list
// a wreck's contents from beyond 2,500 m, and the slim item's `isEmpty` — the
// field the retail client draws its hollow-wreck icon from — rides
// `DoDestinyUpdate`, the one notification the web gateway suppresses. A pilot
// therefore learns a wreck is empty by flying to it. This route is how it only
// has to happen once per wreck instead of once per wreck per pilot.
app.get("/api/bots/loot-memory", requireAuth, (req, res, next) => {
  try {
    const system = Number(req.query.system) || 0;
    if (!Number.isSafeInteger(system) || system <= 0) {
      res.status(400).json({
        ok: false,
        error: "INVALID_SYSTEM",
        message: "A solar system id is required.",
      });
      return;
    }
    res.json({ ok: true, system, itemIDs: lootMemory.emptiedItemIDs(system) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/bots/loot-memory", requireAuth, (req, res, next) => {
  try {
    const body = req.body || {};
    const system = Number(body.system) || 0;
    const itemID = Number(body.itemID) || 0;
    if (
      !Number.isSafeInteger(system) ||
      system <= 0 ||
      !Number.isSafeInteger(itemID) ||
      itemID <= 0
    ) {
      res.status(400).json({
        ok: false,
        error: "INVALID_CONTAINER",
        message: "A solar system id and a container itemID are required.",
      });
      return;
    }
    lootMemory.markEmptied(system, itemID);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

// Active exclusivity is separate from the durable "already emptied" memory.
// The session identity comes from authentication, never the request body.
app.get("/api/bots/loot-memory/claims", requireAuth, (req, res) => {
  const held = requireHeldBridgeSession(req, res);
  if (!held) return;
  const system = Number(req.query.system);
  const runID = typeof req.query.runID === "string" ? req.query.runID : "";
  if (!Number.isSafeInteger(system) || system <= 0 || held.solarSystemID !== system || !runID) {
    res.status(409).json({ ok: false, error: "CLAIM_SCOPE_UNKNOWN" });
    return;
  }
  res.json({ ok: true, itemIDs: lootMemory.claimedItemIDs(system, req.webSessionID, runID) });
});

app.post("/api/bots/loot-memory/claim", requireAuth, (req, res) => {
  const held = requireHeldBridgeSession(req, res);
  if (!held) return;
  const { runID, renewOnly } = req.body || {};
  const system = Number(req.body?.system), itemID = Number(req.body?.itemID);
  if (typeof runID !== "string" || !runID || !Number.isSafeInteger(system) || system <= 0 ||
      !Number.isSafeInteger(itemID) || itemID <= 0 || system !== held.solarSystemID) {
    res.status(409).json({ ok: false, error: "CLAIM_SCOPE_UNKNOWN" });
    return;
  }
  res.json({ ok: true, claimed: lootMemory.claimContainer(req.webSessionID, runID, system, itemID, renewOnly === true) });
});

app.post("/api/bots/loot-memory/release", requireAuth, (req, res) => {
  const runID = req.body?.runID;
  if (typeof runID !== "string" || !runID) {
    res.status(400).json({ ok: false, error: "INVALID_RUN" });
    return;
  }
  lootMemory.releaseClaims(req.webSessionID, runID);
  res.json({ ok: true });
});

// Shared support facts use fresh own-fleet/space reads; they never perform game writes.
registerMiningSupportAnchorRoutes({
  app, requireAuth, requireHeld: requireHeldBridgeSession,
  currentSession: sessionID => sessionID === undefined ? bridgeSessions : bridgeSessions.get(sessionID),
  readFleet: async (held, sessionID) => {
    invalidateFleetBoundHandles(held);
    const result = await boundCall(held, sessionID, fleetBindSpec(), "GetInitState", [], null);
    return result.result;
  },
  readSpace: async held => (await gateway.readSpaceSnapshot(held.bridgeSessionID, { userid: held.accountID })).space,
  board: miningSupportAnchorBoard, sessionLost: forgetBridgeSession,
});

// ── Shared squad board (goal: coordinate fire) ──────────────────────────────
// In-process only, keyed by the FLEET id the BFF resolved from that fleet's own
// GetInitState (see initStateFleetID). No gateway call either way — this is BFF-
// local bookkeeping that lets pilots on one grid shoot the same ship, and it
// touches nothing in the world. See src/squadBoard.js.
//
// ⚠ THE KEY IS NEVER TAKEN FROM THE REQUEST. A browser-supplied fleetID would
// let any signed-in account read what another fleet is shooting (and call a
// primary into it), which is the arg-injection shape this codebase refuses
// everywhere else. Both routes use `held.fleetID`, which only a bound-fleet read
// on THIS session can set — so a session that has not read its fleet yet gets a
// typed refusal telling it to, rather than a guess.
function requireSessionFleetID(req, res) {
  const held = requireHeldBridgeSession(req, res);
  if (!held) {
    return null;
  }
  if (!held.fleetID) {
    res.status(409).json({
      ok: false,
      error: "FLEET_UNKNOWN",
      message: "This character is not in a fleet, or its fleet has not been read yet.",
    });
    return null;
  }
  return held;
}

// ── The bot flight recorder (goal: per-character bot log) ───────────────────
// Lines arrive from whichever runner is flying the character — a tab or a
// server bot, which drives the same stack over loopback — and land in that
// CHARACTER's log. See src/botLogStore.js for the rotation rule.
//
// ⚠ THE CHARACTER IS THE SESSION'S, NEVER THE BODY'S. Same rule as the squad
// board: a body-supplied characterID would let any signed-in account write
// lines into another pilot's log (or read one), so both routes take the
// character from the held session and a session with no character is refused.
app.post("/api/bots/bot-log", requireAuth, (req, res, next) => {
  try {
    const held = requireHeldBridgeSession(req, res);
    if (!held) {
      return;
    }
    const entries = Array.isArray((req.body || {}).entries) ? req.body.entries : null;
    if (entries === null) {
      res.status(400).json({ ok: false, error: "INVALID_ENTRIES", message: "entries must be a list." });
      return;
    }
    const written = botLogStore.append(held.characterID, entries.slice(0, 500));
    res.json({ ok: true, written });
  } catch (error) {
    next(error);
  }
});

app.get("/api/bots/bot-log", requireAuth, (req, res, next) => {
  try {
    const held = requireHeldBridgeSession(req, res);
    if (!held) {
      return;
    }
    const which =
      req.query.which === "previous" || req.query.which === "previous2"
        ? req.query.which
        : "current";
    res.json({
      ok: true,
      characterID: held.characterID,
      which,
      lines: botLogStore.read(held.characterID, which),
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/bots/squad-board", requireAuth, (req, res, next) => {
  try {
    const held = requireSessionFleetID(req, res);
    if (!held) {
      return;
    }
    res.json({ ok: true, fleetID: held.fleetID, primary: squadBoard.primary(held.fleetID) });
  } catch (error) {
    next(error);
  }
});

// Call a primary for the session's fleet, or clear the standing call with a null
// targetID. The caller is the SESSION's character, never a body field: a call is
// only ever made in your own name.
app.post("/api/bots/squad-board", requireAuth, (req, res, next) => {
  try {
    const held = requireSessionFleetID(req, res);
    if (!held) {
      return;
    }
    const body = req.body || {};
    if (body.targetID === null || body.targetID === undefined) {
      squadBoard.clear(held.fleetID);
      res.json({ ok: true, fleetID: held.fleetID, primary: null });
      return;
    }
    const targetID = strictPositiveID(body.targetID);
    if (targetID === null) {
      res.status(400).json({
        ok: false,
        error: "INVALID_TARGET",
        message: "targetID must be null or a positive id.",
      });
      return;
    }
    const primary = squadBoard.call(held.fleetID, targetID, held.characterID);
    res.json({ ok: true, fleetID: held.fleetID, primary });
  } catch (error) {
    next(error);
  }
});

// Which characters a server bot is flying, and how each ship is doing —
// WITHOUT auth, deliberately: the login and character screens mark bot-flown
// pilots and show their vitals BEFORE any sign-in exists. Exposure is game
// state only (character IDs, bot phase, shield/armor/hull, hold fill — no
// account names, script ids, bot ids, or any control), on a server whose
// login already accepts any password (see the LAN note above /api/login).
// Everything that inspects or DRIVES a bot stays behind requireAuth.
app.get("/api/bots/active", (req, res, next) => {
  try {
    res.json({ ok: true, characterIDs: botHost.activeCharacterIDs(), bots: botHost.activeBots() });
  } catch (error) {
    next(error);
  }
});

// GET /api/bots/corp-assets?characterID=&locationID= -- the PI board's corp
// hangar read THROUGH A SERVER BOT: the same corpmgr reads as
// /api/bridge/corp-assets, made on the game session a running bot of the
// CALLER's account holds for that pilot.
//
// ⚠ A READ BESIDE THE BOT, NEVER A HAND ON IT. The host hands out only the
// bot's web session id (botHost.readableSessionOf), for its own account and
// only while the run is live. Nothing here selects, releases, stops or goes
// through the bot's flow; the vitals sampler already makes reads on this same
// session while the bot acts.
//
// ⚠ A LOST SESSION IS THE BOT'S TO FIND. heldTopLevelCall forgets the held
// handle on SESSION_NOT_FOUND; a read made here must never drop a bot's
// handle, so it calls the gateway directly and just answers the refusal.
app.get("/api/bots/corp-assets", requireAuth, async (req, res, next) => {
  const characterID = Number(req.query.characterID || 0);
  if (!Number.isSafeInteger(characterID) || characterID <= 0) {
    res.status(400).json({ ok: false, error: "INVALID_CHARACTER", message: "A positive characterID is required." });
    return;
  }
  const webSessionID = botHost.readableSessionOf(characterID, req.account.accountID);
  const held = webSessionID ? bridgeSessions.get(webSessionID) || null : null;
  if (!held || Number(held.characterID) !== characterID) {
    res.status(409).json({
      ok: false,
      error: "NO_BOT_SESSION",
      message: "No server bot of this account is flying this pilot.",
    });
    return;
  }
  const call = (method, args) =>
    gateway.callMethod("corpmgr", method, args, null, { userid: held.accountID }, held.bridgeSessionID);
  await answerCorpAssets(held, call, req, res, next);
});

// GET /api/bots/corp-division-names?characterID= -- what the seven corporation
// hangar divisions are CALLED, read on the game session a running bot of the
// CALLER's account holds for that pilot. The PI window's Haul picker learns the
// names this way when no pilot of that corporation is online in the tab.
//
// The same rules as /api/bots/corp-assets above: a read beside the bot, never
// a hand on it, and a lost session is the bot's to find, so the gateway is
// called directly and never through heldTopLevelCall.
app.get("/api/bots/corp-division-names", requireAuth, async (req, res, next) => {
  const characterID = Number(req.query.characterID || 0);
  if (!Number.isSafeInteger(characterID) || characterID <= 0) {
    res.status(400).json({ ok: false, error: "INVALID_CHARACTER", message: "A positive characterID is required." });
    return;
  }
  const webSessionID = botHost.readableSessionOf(characterID, req.account.accountID);
  const held = webSessionID ? bridgeSessions.get(webSessionID) || null : null;
  if (!held || Number(held.characterID) !== characterID) {
    res.status(409).json({
      ok: false,
      error: "NO_BOT_SESSION",
      message: "No server bot of this account is flying this pilot.",
    });
    return;
  }
  try {
    const outcome = await gateway.callMethod(
      "corpRegistry", "GetCorporation", [], null, { userid: held.accountID }, held.bridgeSessionID,
    );
    const names = decodeDivisionNames(outcome && outcome.result);
    const divisions = [];
    for (let division = 1; division <= CORP_DIVISION_COUNT; division += 1) {
      divisions.push({ division, name: names[division] || null });
    }
    res.json({ ok: true, corporationID: Number(held.corporationID) || null, divisions });
  } catch (error) {
    if (error && error.code === "SESSION_NOT_FOUND") {
      res.status(409).json({ ok: false, error: "NO_BOT_SESSION", message: "The bot's session has ended." });
      return;
    }
    next(error);
  }
});

app.post("/api/bots/start", requireAuth, async (req, res, next) => {
  try {
    const body = req.body || {};
    const characterID = Number(body.characterID || 0);
    // Absent = "script", matching botHost's own default for an unmarked
    // request — the same compatibility rule a persisted roster row with no
    // `kind` field gets on resume.
    const kind = body.kind === "companion" ? "companion" : "script";
    if (!Number.isSafeInteger(characterID) || characterID <= 0) {
      res.status(400).json({ ok: false, error: "INVALID_CHARACTER", message: "A positive characterID is required." });
      return;
    }
    // The character must be the caller's — the same ownership read select does.
    // Identical for both kinds: owning the character is the one gate that
    // never differs by what is about to fly it.
    //
    // A pilot this web session holds was shown to be the account's when it was
    // chosen, by that same read. It is not made again: the read is the web
    // gateway's snapshot of one character, and of a pilot who is online here it
    // is a read the cutover means the BFF to stop making (the plan's Phase 5;
    // src/gatewayLedger.js counts it as "online").
    const heldHere = bridgeSessions.get(req.webSessionID) || null;
    const chosenHere = heldHere !== null && Number(heldHere.characterID) === characterID;
    const character = chosenHere || await store.getCharacterForAccount(req.account.accountID, characterID);
    if (!character) {
      res.status(404).json({ ok: false, error: "CHARACTER_NOT_FOUND" });
      return;
    }

    let record = null;
    if (kind === "script") {
      const scriptID = String(body.scriptID || "");
      record = botScripts.get(scriptID);
      if (!record) {
        res.status(404).json({ ok: false, error: "BOTSCRIPT_NOT_FOUND", message: "That bot could not be found." });
        return;
      }
    }
    // A companion has no library entry to look up here — its "record" is the
    // request in the body, and botHost.start() is the one place that decodes
    // and trusts it (decodeFleetCompanionRequestValue).

    if (hasPendingRecovery(bridgeSessions.get(req.webSessionID), characterID)) {
      res.status(409).json({ ok: false, error: "DRONE_RECOVERY_PENDING",
        message: "Finish this pilot's lost-drone recovery before server handoff." });
      return;
    }

    // Reserve only the await window, not another ownership registry. The host
    // validates the grant and claims the hull before releasing this caller's
    // live session. A failed start may restore it only after a fresh authority
    // check proves that nobody else took the character.
    if (characterOperations.has(characterID) || sessionOperations.has(req.webSessionID)) {
      res.status(409).json({ ok: false, error: "CHARACTER_IN_USE", message: "A pilot ownership change is already in progress." });
      return;
    }
    const reservation = Symbol("bot-handoff");
    characterOperations.set(characterID, reservation);
    sessionOperations.set(req.webSessionID, reservation);
    let releasedCaller = false;
    let transferred = false;
    try {
      const assertReservation = () => {
        if (characterOperations.get(characterID) !== reservation || sessionOperations.get(req.webSessionID) !== reservation)
          throw Object.assign(new Error("This hosted Start reservation is no longer current."), { code: "CHARACTER_IN_USE" });
      };
      const transferReservation = owner => {
        // Injected legacy hosts need no handoff capability. The production host
        // always supplies its newly minted private claim, never a public botID.
        if (!owner) return;
        assertReservation();
        if (!botHost.authorizesClaim(characterID, owner.claimSecret))
          throw Object.assign(new Error("The hosted claim did not acquire this Start."), { code: "CHARACTER_IN_USE" });
        characterOperations.delete(characterID);
        transferred = true;
        // The caller session stays fenced until this request ends. Character
        // authority is now the existing hosted claim, including failure cleanup.
      };
      const beforeStart = async owner => {
        assertReservation();
        const held = bridgeSessions.get(req.webSessionID);
        if (!held || Number(held.characterID) !== characterID) { transferReservation(owner); return; }
        if (hasPendingRecovery(held, characterID)) {
          throw Object.assign(new Error("Lost-drone recovery is still pending."), { code: "DRONE_RECOVERY_PENDING" });
        }
        const status = await readHeldFlight(held, req.webSessionID);
        assertReservation();
        if (bridgeSessions.get(req.webSessionID) !== held || Number(held.accountID) !== Number(req.account.accountID))
          throw Object.assign(new Error("The caller's pilot session changed before handoff."), { code: "CHARACTER_IN_USE" });
        if (status?.flight?.docked !== true) {
          if (status?.flight?.inSpace !== true) {
            throw Object.assign(new Error("Pilot location could not be confirmed before handoff."), { code: "DRONE_HANDOFF_UNSAFE" });
          }
          if (!(Number(held.activeShipID) > 0) || Number(status.flight.shipID) !== Number(held.activeShipID)) {
            throw Object.assign(new Error("The active ship changed before drone handoff could be checked."), { code: "DRONE_HANDOFF_UNSAFE" });
          }
          let rows = null;
          try { rows = (await readDronesInSpace(held)).drones; } catch { /* unreadable is unsafe */ }
          if (!handoffFlightReady(rows)) {
            throw Object.assign(new Error("Return controlled drones to the bay before server handoff."), { code: "DRONE_HANDOFF_UNSAFE" });
          }
        }
        assertReservation();
        await releaseHeldBridgeSession(req.webSessionID, { confirmed: true });
        releasedCaller = true;
        assertReservation();
        transferReservation(owner);
      };
      const outcome =
        kind === "companion"
          ? await botHost.start({
            account: req.account,
            characterID,
            kind: "companion",
            request: body.request,
            grant: body.grant,
            callerSessionID: req.webSessionID,
            probeReservation: reservation,
            beforeStart,
          })
          : await botHost.start({
            account: req.account,
            characterID,
            kind: "script",
            scriptID: record.scriptID,
            scriptName: record.name,
            scriptRev: record.rev,
            doc: record.doc,
            grant: body.grant,
            callerSessionID: req.webSessionID,
            probeReservation: reservation,
            beforeStart,
          });
      if (!outcome.ok) {
        let message = outcome.message;
        if (releasedCaller && !bridgeSessions.has(req.webSessionID) && !botHost.claimedBy(characterID)) {
          let restoreReservation = reservation;
          if (transferred) {
            restoreReservation = null;
            if (!characterOperations.has(characterID) && sessionOperations.get(req.webSessionID) === reservation) {
              restoreReservation = Symbol("bot-restore");
              characterOperations.set(characterID, restoreReservation);
              sessionOperations.set(req.webSessionID, restoreReservation);
            }
          }
          try {
            const payload = auth.verifySessionToken(readSessionToken(req));
            if (restoreReservation !== null && payload.sessionID === req.webSessionID && Number(payload.accountID) === Number(req.account.accountID)) {
              if (!await restoreHeldCaller(req.webSessionID, req.account, characterID, restoreReservation))
                message = `${message} Browser ownership was not restored; review the pilot's current owner.`;
            }
          } catch (error) {
            errorLogger(error);
            message = `${message} Browser ownership could not be safely restored; select the pilot again after checking its current session.`;
          } finally {
            if (restoreReservation !== reservation && restoreReservation !== null) {
              if (characterOperations.get(characterID) === restoreReservation) characterOperations.delete(characterID);
              if (sessionOperations.get(req.webSessionID) === restoreReservation) sessionOperations.delete(req.webSessionID);
            }
          }
        }
        res.status(BOT_START_STATUS[outcome.code] || 500).json({ ok: false, error: outcome.code, message });
        return;
      }
      res.json({ ok: true, bot: outcome.bot });
    } finally {
      if (characterOperations.get(characterID) === reservation) characterOperations.delete(characterID);
      if (sessionOperations.get(req.webSessionID) === reservation) sessionOperations.delete(req.webSessionID);
    }
  } catch (error) {
    next(error);
  }
});

app.post("/api/bots/:botID/reconnect", requireAuth, (req, res, next) => {
  try {
    const outcome = botHost.reconnect(req.params.botID, req.account.accountID);
    res.status(outcome.ok ? 202 : 409).json(outcome.ok ? { ok: true, bot: outcome.bot }
      : { ok: false, error: outcome.code, message: outcome.message });
  } catch (error) { next(error); }
});

app.post("/api/bots/:botID/stop", requireAuth, async (req, res, next) => {
  try {
    const outcome = await botHost.stop(req.params.botID, req.account.accountID);
    if (!outcome.ok) {
      res.status(BOT_START_STATUS[outcome.code] || 404).json({
        ok: false,
        error: outcome.code || "BOT_NOT_FOUND",
        message: outcome.message || "No such bot.",
        bot: outcome.bot,
      });
      return;
    }
    res.json({ ok: true, bot: outcome.bot });
  } catch (error) {
    next(error);
  }
});

// ── Icon cache admin (the Settings panel) ───────────────────────────────────
// Two ways to fill data/icon-cache so type icons serve locally instead of the
// lettered fallback tile:
//   1. AUTO-FILL (opt-in, OFF by default): a miss on the icon route is fetched
//      from images.evetech.net BY THE BFF, saved, and then served — icons fill
//      in as you browse, downloading only what you actually look at. The BROWSER
//      still only ever talks to /icon-cache, so R27's "browser never touches an
//      external image host" rule holds; the BFF is the one reaching the CDN,
//      exactly as scripts/cache-icons.js already does.
//   2. BULK PULL: spawn scripts/cache-icons.js to pre-download a whole source —
//      the gamestore set (fast) or every published type (comprehensive).
// Off by default keeps the R27 "named tile is the normal case" contract intact
// until someone opts in here.
const ICON_SETTINGS_PATH = path.join(config.dataDir, "icon-settings.json");
const ICON_CACHE_SOURCES = new Set(["gamestore", "all-types"]);
const ICON_REMOTE_VARIATIONS = new Set(["icon", "bp", "bpc"]);

let iconSettings = { autoDownload: false };
try {
  const parsed = JSON.parse(fs.readFileSync(ICON_SETTINGS_PATH, "utf8"));
  iconSettings = { autoDownload: parsed && parsed.autoDownload === true };
} catch {
  // No settings file yet — the off-by-default stands.
}
function saveIconSettings() {
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(ICON_SETTINGS_PATH, `${JSON.stringify(iconSettings, null, 2)}\n`);
  } catch {
    // Best-effort; the toggle still applies in-memory for this run.
  }
}

let iconCacheJob = {
  running: false,
  source: null,
  progress: "",
  startedAt: null,
  finishedAt: null,
  lastResult: null,
};

function countCachedIcons() {
  let count = 0;
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".png")) count += 1;
    }
  };
  walk(config.iconCacheDir);
  return count;
}

// AUTO-FILL — sits in front of the icon static mount below. On a miss (auto-fill
// on), fetch the icon from the CDN, save it, and fall through to let the static
// mount serve the now-present file. ANY failure just falls through, so the R27
// 404 contract is preserved unchanged when auto-fill is off or the CDN misses.
app.get(/^\/icon-cache\/types\/(\d+)\/([a-z]+)\/(\d+)\.png$/, async (req, res, next) => {
  if (!iconSettings.autoDownload) {
    next();
    return;
  }
  const size = Number(req.params[0]);
  const variation = String(req.params[1]);
  const typeID = Number(req.params[2]);
  if (!ICON_REMOTE_VARIATIONS.has(variation) || !Number.isInteger(typeID) || typeID <= 0) {
    next();
    return;
  }
  const target = path.join(config.iconCacheDir, "types", String(size), variation, `${typeID}.png`);
  if (fs.existsSync(target)) {
    next();
    return;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const url = staticDataModule.getRemoteTypeIconUrl(typeID, size, variation);
    if (url) {
      const response = await fetch(url, { signal: controller.signal });
      const ctype = String(response.headers.get("content-type") || "");
      if (response.ok && ctype.startsWith("image/")) {
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length > 0) {
          fs.mkdirSync(path.dirname(target), { recursive: true });
          const tmp = `${target}.tmp-${process.pid}`;
          fs.writeFileSync(tmp, bytes);
          fs.renameSync(tmp, target);
        }
      }
    }
  } catch {
    // Fall through to the static 404 on any CDN/write failure.
  } finally {
    clearTimeout(timer);
  }
  next();
});

app.get("/api/icons/status", requireAuth, (req, res) => {
  res.json({
    ok: true,
    cachedCount: countCachedIcons(),
    autoDownload: iconSettings.autoDownload,
    running: iconCacheJob.running,
    source: iconCacheJob.source,
    progress: iconCacheJob.progress,
    startedAt: iconCacheJob.startedAt,
    finishedAt: iconCacheJob.finishedAt,
    lastResult: iconCacheJob.lastResult,
  });
});

app.post("/api/icons/settings", requireAuth, (req, res) => {
  const autoDownload = Boolean(req.body && req.body.autoDownload);
  iconSettings = { autoDownload };
  saveIconSettings();
  res.json({ ok: true, autoDownload });
});

app.post("/api/icons/cache", requireAuth, (req, res) => {
  if (iconCacheJob.running) {
    res.status(409).json({ ok: false, error: "ICON_CACHE_BUSY", message: "An icon pull is already running." });
    return;
  }
  const source = String((req.body && req.body.source) || "all-types");
  if (!ICON_CACHE_SOURCES.has(source)) {
    res.status(400).json({ ok: false, error: "ICON_CACHE_BAD_SOURCE", message: "source must be 'gamestore' or 'all-types'." });
    return;
  }
  let child;
  try {
    child = spawn(process.execPath, ["scripts/cache-icons.js", "--source", source, "--delay-ms", "50"], {
      cwd: config.repoRoot,
      env: process.env,
      windowsHide: true,
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: "ICON_CACHE_SPAWN_FAILED", message: String((error && error.message) || error) });
    return;
  }
  iconCacheJob = {
    running: true,
    source,
    progress: "Starting…",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    lastResult: null,
  };
  const onData = (buf) => {
    const lines = String(buf).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (lines.length) iconCacheJob.progress = lines[lines.length - 1].slice(0, 200);
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  child.on("error", (error) => {
    iconCacheJob.running = false;
    iconCacheJob.finishedAt = new Date().toISOString();
    iconCacheJob.lastResult = `Error: ${error.message}`;
  });
  child.on("close", (code) => {
    iconCacheJob.running = false;
    iconCacheJob.finishedAt = new Date().toISOString();
    iconCacheJob.lastResult = code === 0 ? "Done." : `Exited with code ${code}.`;
  });
  res.json({ ok: true, started: true, source });
});

// ⚠ ORDER IS LOAD-BEARING BELOW THIS LINE. The icon cache MUST stay above the
// SPA catch-all, and it MUST keep `fallthrough: false` (R27). That flag is the
// only reason a missing icon answers 404: without it the request falls through
// to the catch-all, the browser receives index.html with a 200, `<img onerror>`
// never fires, and every uncached icon becomes a permanently broken image.
// The client's own textures by their res: path, for the page to draw what the client draws with them (a skill
// group's icon, a skill book's mark): /client-res/ui/texture/... answers the PNG the install's index names for
// res:/ui/texture/..., or 404 (src/clientData/clientTextures.js). No session: the install's pictures do not vary by
// player. Above the catch-all, for the same reason as the icon cache below.
app.get(/^\/client-res\/(ui\/texture\/[A-Za-z0-9_./-]+\.png)$/, (req, res) => {
  const file = clientTextures.fileFor(`res:/${req.params[0]}`);
  if (!file) {
    res.status(404).end();
    return;
  }
  res.set("Cache-Control", "public, max-age=2592000, immutable");
  res.type("png").sendFile(file, (error) => {
    if (error && !res.headersSent) res.status(404).end();
  });
});

app.use(config.iconCacheUrlPath, express.static(config.iconCacheDir, {
  fallthrough: false,
  immutable: true,
  maxAge: "30d",
}));

// R45: the Svelte SPA build is the ONLY app, and it is served at the root.
// Its asset URLs are root-absolute (vite.config.ts `base: "/"`) — the base and
// this mount point must always agree, or the document loads and its assets
// 404 into the catch-all below as a 200 text/html, which renders blank.
const webAppDir = path.join(config.repoRoot, "public", "dist");

// The app used to live at /dist/. Send that bookmark to the canonical root
// rather than serving a second copy at a second URL. 302, not 301, so the
// redirect is never baked into a browser cache we cannot reach.
app.get(/^\/dist\/?$/, (req, res) => {
  res.redirect("/");
});

// The hashed build assets must FAIL CLOSED, exactly like the icon cache above,
// and for the same reason. Without `fallthrough: false` a request for a bundle
// that is not on disk falls into the catch-all and comes back as `index.html`
// with a 200 and `text/html` — so a browser holding a stale index.html asks for
// the previous hash, is handed a document, and dies on `Unexpected token '<'`
// instead of getting a clean 404 it could recover from. Measured on 2026-07-21:
// a rebuild replaced index-CR6BU842.js, and the deleted name still answered 200.
// The comment above this block already described this failure; the code did not
// prevent it. Vite hashes every filename, so a long immutable cache is safe.
app.use("/assets", express.static(path.join(webAppDir, "assets"), {
  fallthrough: false,
  immutable: true,
  maxAge: "30d",
}));

app.get(["/goblin-factory", "/goblin-factory/"], (_req, res) => res.redirect(308, "/pilot-training"));
app.use(express.static(webAppDir));
app.get(/.*/, (req, res) => {
  res.sendFile(path.join(webAppDir, "index.html"));
});

app.use((error, req, res, next) => {
  void next;
  errorLogger(error);
  const statusCode =
    Number.isFinite(error && error.statusCode) && error.statusCode >= 400
      ? error.statusCode
      : 500;
  const refusal = dialogRefusalOf(error);
  res.status(statusCode).json({
    ok: false,
    error: error && error.code ? error.code : error.message || "SERVER_ERROR",
    message: error && error.message ? error.message : "Server error",
    ...(refusal ? { refusal } : {}),
  });
});

/**
 * What the server refused a pilot's call with, where it said (a game-port pilot's UserError): its message key, the
 * name of the dialog the client puts up for it, and the values for that dialog (exc.msg and exc.dict, which the
 * client hands to prompt_player_fsd_dialog: eve_exception_handler.handle_exception). Null for any other failure.
 */
function dialogRefusalOf(error) {
  const refusal = error && error.refusal;
  if (!refusal || typeof refusal.key !== "string" || !/^\w{1,100}$/.test(refusal.key)) return null;
  return { key: refusal.key, values: refusal.values ?? null };
}

return app;
}

function startServer(options = {}) {
  const appToStart = options.app || createApp(options);
  const host = options.host || config.host;
  const port = options.port === undefined ? config.port : Number(options.port);
  const server = http.createServer(appToStart);
  server.listen(port, host, () => {
    const address = server.address();
    const activePort = address && typeof address === "object" ? address.port : port;
    if (options.silent !== true) {
      console.log(`EveJS Web POC listening on http://${host}:${activePort}`);
      console.log(`Using EveJS gateway: ${process.env.EVEJS_GATEWAY_URL || "http://127.0.0.1:26002/_evejs-web/v1"}`);
      const said = `EVEJS_PILOT_TRANSPORT=${process.env.EVEJS_PILOT_TRANSPORT || "gameport (the default)"}` +
        ` overrides=${process.env.EVEJS_PILOT_TRANSPORT_OVERRIDES || "none"}`;
      if (appToStart.locals.gamePortPilots) {
        const game = gameEndpoint(process.env);
        console.log(`Pilot transport: ${said} (pilots log in on the game port, ${game.host}:${game.port}; EVEJS_PILOT_TRANSPORT=gateway is the way back)`);
      } else {
        console.log(`Pilot transport: ${said} (pilots log in through the web gateway)`);
      }
      console.log(hostedBotReach(process.env) === "loopback"
        ? "Hosted bots: EVEJS_HOSTED_BOT_REACH=loopback (they ask this BFF over HTTP, as before)"
        : "Hosted bots: ask this BFF in its own process (EVEJS_HOSTED_BOT_REACH=loopback is the way back)");
    }
    // The ready-made starter bots go into the library once, on first boot.
    // Deliberately here and not from a read: the store's reads never write, and
    // the seed is gated on a stored marker rather than on the library looking
    // empty — a starter the player DELETED must stay deleted, not reappear at
    // the next restart. A failure to seed is logged and otherwise ignored; it
    // must never stop the server coming up.
    try {
      appToStart.locals.botScripts.seedStarterBots();
    } catch (error) {
      console.error(error);
    }
    // Bots that were running when the server last stopped come back now —
    // AFTER listen, because every server bot drives this server over loopback.
    if (options.resumeServerBots !== false) {
      void appToStart.locals.botHost?.resume().catch((error) => console.error(error));
    }
  });
  // One socket for a tab, carrying the routes' operations with no HTTP hop of their own (the plan's Phase 6a;
  // src/pilotSocket.js). It stands beside the routes: a tab that never opens it is served as before.
  const pilotSocket = attachPilotSocket(server, appToStart, {
    verify: (token) => appToStart.locals.verifySessionToken?.(token),
    onError: (error) => console.warn(`[pilot-socket] ${error && error.message}`),
  });
  server.pilotSocket = pilotSocket;
  // An open socket is a connection, and a server that is closing waits for every connection to end: left open,
  // the tabs' sockets would keep it from ever having closed. They are closed as the closing begins.
  const closeServer = server.close.bind(server);
  server.close = (callback) => {
    void pilotSocket.close();
    return closeServer(callback);
  };
  // A pilot on the game port is a connection held by this process. When the
  // server stops, each is closed, which logs the pilot off as a closed client would.
  server.on("close", () => appToStart.locals.gamePortPilots?.shutdown?.());
  return server;
}

const app = createApp();
const server = require.main === module ? startServer({ app }) : null;

module.exports = {
  app,
  createApp,
  server,
  startServer,
};
