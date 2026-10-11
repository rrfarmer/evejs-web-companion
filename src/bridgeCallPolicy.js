"use strict";

// Authoritative classification for the generic browser call boundary.
//
// PLUMBING_SWEEP_WRITE_METHODS is the 301-pair Phase 3/4 write inventory in
// docs/plumbing-worklist.md (152 top-level + 149 bound). The earlier map covers
// the mutators wired before that sweep, and FEATURE_WRITE_METHODS covers writes
// added afterward. Dedicated BFF routes confirmation-gate these calls; the
// generic /api/bridge/call route must never be a second, ungated way to invoke
// them.

function freezeMethodMap(methodsByService) {
  const frozen = {};
  for (const [service, methods] of Object.entries(methodsByService)) {
    frozen[service] = Object.freeze([...methods]);
  }
  return Object.freeze(frozen);
}

const PLUMBING_SWEEP_WRITE_METHODS = freezeMethodMap({
  beyonce: ["CmdGotoPoint", "CmdGotoBookmark", "CmdAbandonLoot", "CmdFleetTagTarget", "CmdJumpThroughFleet", "BookmarkLocation", "BookmarkScanResult"],
  marketProxy: ["PlacePlexSellOrder", "ModifyPlexCharOrder", "BuyMultipleItems"],
  mailMgr: ["MarkAsRead", "MarkAsUnread", "MoveToTrash", "MoveFromTrash", "MoveAllToTrash", "MarkAllAsRead", "DeleteMail", "EmptyTrash", "CreateLabel", "EditLabel", "DeleteLabel", "AssignLabels", "RemoveLabels"],
  mailingListsMgr: ["Create", "Join", "Leave"],
  contractProxy: ["CreateContract", "AcceptContract", "CompleteContract", "DeleteContract", "DeleteMultipleContracts", "PlaceBid", "FinishAuction", "SplitStack", "DeleteNotification", "DeleteContractNotification", "GM_ExpireContract"],
  charFittingMgr: ["SaveManyFittings", "DeleteFitting", "DeleteManyFittings", "UpdateNameAndDescription"],
  corpFittingMgr: ["SaveManyFittings"],
  sovMgr: ["SetSovHubFuelAccessGroup", "DestroySkyhooks", "AcquireSkyhooks"],
  essMgr: ["AttemptLinkToMainBank", "AttemptLinkToReserveBank", "RequestMainBankUnlink", "RequestReserveBankUnlink", "RequestUnlockReserveBank"],
  abyssalMgr: ["AbyssalEntranceDeployment", "AbyssalEntranceGateActivation", "AbyssalGateActivation", "AbyssalEndGateActivation", "ClientIsReady"],
  pvpFilamentMgr: ["JoinPVPQueue", "LeavePVPQueue", "AbyssalPVPEndGateActivation"],
  agentMgr: ["RemoveOfferFromJournal", "GotoLocation", "WarpToLocation", "WarpToAgentInSpace"],
  petitioner: ["CreatePetition", "PetitionerChat", "CancelPetition"],
  industryManager: ["CompleteManyJobs"],
  planetMgr: ["DeleteLaunch", "UserUpdateNetwork", "UserLaunchCommodities", "UserTransferCommodities", "UserAbandonPlanet"],
  structureDirectory: ["SetStructureDescription"],
  structureAssetSafety: ["MovePersonalAssetsToSafety", "MoveCorpAssetsToSafety", "MoveSafetyWrapToStructure"],
  fleetObjectHandler: ["CreateFleet", "CreateWing", "CreateSquad", "MoveMember", "KickMember", "MakeLeader", "LeaveFleet", "DisbandFleet", "SetOptions", "SetMotdEx", "UpdateMemberInfo", "SendBroadcast", "Invite", "MassInvite", "AcceptInvite", "RejectInvite", "Reconnect"],
  fleetProxy: ["ApplyToJoinFleet", "AddFleetFinderAdvert", "RemoveFleetFinderAdvert", "UpdateAdvertInfo"],
  fleetMgr: ["ForceLeaveFleet", "AddToWatchlist", "RemoveFromWatchlist", "RegisterForDamageUpdates", "BroadcastToBubble", "BroadcastToSystem"],
  entity: ["CmdReturnHome", "CmdSalvage", "CmdAbandonDrone", "CmdReconnectToDrones"],
  dogmaIM: ["RemoveTargets", "ClearTargets", "Overload", "OverloadRack", "StopOverload", "StopOverloadRack", "InitiateModuleRepair", "InitiateModuleRepairMany", "StopModuleRepair", "LinkWeapons", "MergeModuleGroups", "PeelAndLink", "UnlinkModule", "LinkAllWeapons", "UnlinkAllModules", "DestroyWeaponBank", "LaunchProbes", "ChangeDroneSettings", "InjectSkillIntoBrain", "InjectImplant", "DestroyImplant", "UseBooster"],
  invbroker: ["SetLabel", "StripFitting", "FitFitting", "AssembleCargoContainer", "BreakPlasticWrap", "DeliverToCorpHangar", "DeliverToCorpMember"],
  scanMgr: ["SignalTrackerRegister", "SetProbeDestination", "SetProbeRangeStep", "ConeScan", "RequestScans", "ReconnectToLostProbes", "DestroyProbe", "RecoverProbes", "SetActivityState"],
  notificationMgr: ["MarkGroupAsProcessed", "MarkAllAsProcessed", "MarkAsProcessed", "DeleteGroupNotifications", "DeleteAllNotifications", "DeleteNotifications", "LogNotificationInteraction"],
  calendarMgr: ["CreatePersonalEvent", "CreateCorporationEvent", "CreateAllianceEvent", "EditPersonalEvent", "DeleteEvent", "SendEventResponse", "UpdateEventParticipants"],
  accessGroupBookmarkMgr: ["AddFolder", "UpdateFolder", "DeleteFolder", "BookmarkStaticLocation", "UpdateBookmark", "DeleteBookmarks", "MoveBookmarksToFolderAndSubfolder"],
  charMgr: ["SetCharacterDescription", "SetActivityStatus", "LogSettings", "AddContact", "DeleteContacts", "EditContactsRelationshipID", "BlockOwners", "UnblockOwners", "SetNote", "AddOwnerNote", "EditOwnerNote", "RemoveOwnerNote"],
  charUnboundMgr: ["CancelCharacterDeletePrepare", "ToggleValidation", "CreateCharacterWithDoll", "UpdateCharacterGender", "UpdateCharacterBloodline"],
  LSC: ["SendMessage"],
  account: ["SetContactCost", "GiveCash", "GiveCashFromCorpAccount"],
  LPSvc: ["ExchangeConcordLP", "TransferLPFromMyWalletToOtherCorp", "TransferLPFromMyCorpWalletToOtherCorp"],
  LPStoreMgr: ["TakeOfferForCharacter", "TakeOfferForCorporation"],
  insuranceSvc: ["InsureShip", "UnInsureShip"],
  bountyProxy: ["AddToBounty", "SellKillRight", "CancelSellKillRight"],
  killRightMgr: ["ActivateKillRight", "BuyKillRight"],
  ship: ["Eject", "LeaveShip", "BoardStoredShip", "StoreVessel", "AssembleShip", "FitShips", "ConfigureShip", "Scoop", "ScoopToMobileDepotHold", "Jettison", "LaunchFromShip", "LaunchFromContainer", "Drop", "SafeLogoff"],
  fighterMgr: ["LoadFightersToTube", "UnloadTubeToFighterBay", "LaunchFightersFromTubes", "RecallFightersToTubes", "ExecuteMovementCommandOnFighters", "CmdActivateAbilitySlots", "CmdDeactivateAbilitySlots", "CmdAbandonFighter", "CmdScoopAbandonedFighterFromSpace"],
  skillHandler: ["CharStartTrainingSkill", "AbortTraining", "ApplyFreeSkillPoints", "ExtractSkills", "InjectSkillpoints", "SplitSkillInjector", "CombineSkillInjector", "InjectSkillIntoBrain"],
  jumpCloneSvc: ["InstallCloneInStation", "InstallCloneInStructure", "CloneJump", "DestroyInstalledClone", "SetJumpCloneName", "OfferShipCloneInstallation", "AcceptShipCloneInstallation", "CancelShipCloneInstallation"],
  crimewatch: ["SetSafetyLevel"],
  corpRegistry: ["AddBulletin", "UpdateBulletin", "UpdateBulletinOrder", "DeleteBulletin", "CreateLabel", "EditLabel", "DeleteLabel", "AssignLabels", "RemoveLabels", "AddCorporateContact", "EditCorporateContact", "RemoveCorporateContacts", "EditContactsRelationshipID", "UpdateTitle", "UpdateTitles", "UpdateMember", "UpdateMembers", "UpdateCorporation", "UpdateCorporationAbilities", "UpdateLogo", "UpdateDivisionNames", "SetAccountKey", "SetCorpWelcomeMail", "SetStructureReinforceDefault", "RegisterNewAggressionSettings", "RegisterNewAcceptStructureSettings", "RegisterNewCorpMailRestrictionSettings", "DeleteTitle", "ExecuteActions", "MoveCompanyShares", "MovePrivateShares", "PayoutDividend", "KickOutMember", "KickOutMembers", "ResignFromCEO", "InsertApplication", "InsertInvitation", "UpdateApplicationOffer", "AddCorporation", "CreateAlliance", "ApplyToJoinAlliance", "DeleteAllianceApplication", "DeclareWarAgainst"],
  allianceRegistry: ["SetRelationship", "DeleteRelationship", "AddAllianceContact", "AddBulletin", "UpdateApplication", "PayBill", "SetPrimeHour", "SetCapitalSystem", "DeclareExecutorSupport", "UpdateAlliance"],
  warRegistry: ["CreateWarAllyOffer", "RetractWarAllyOffer", "CreateSurrenderNegotiation", "AcceptAllyNegotiation", "DeclineAllyOffer", "AcceptSurrender", "DeclineSurrender", "RetractMutualWar", "SetOpenForAllies"],
  corpStationMgr: ["MoveCorpHQHere"],
});

// Writes introduced before the exhaustive Phase 3/4 plumbing sweep. Each pair
// already has a purpose-built route with confirmation and/or operation-specific
// validation in src/server.js.
const EARLIER_WRITE_METHODS = freezeMethodMap({
  charUnboundMgr: ["SelectCharacterID"],
  invbroker: ["Add", "MultiMerge", "StackAll", "MultiAdd", "TrashItems", "DestroyFitting"],
  dogmaIM: ["SetModuleOnline", "TakeModuleOffline", "AddTarget", "RemoveTarget", "CancelAddTarget", "Activate", "Deactivate", "LoadAmmo", "UnloadAmmo", "CreateNewbieShip"],
  ship: ["Board", "Undock", "LaunchDrones", "ScoopDrone"],
  agentMgr: ["DoAction"],
  beyonce: ["CmdWarpToStuffAutopilot", "CmdWarpToStuff", "CmdSetSpeedFraction", "CmdFollowBall", "CmdStargateJump", "CmdDock", "CmdOrbit", "CmdAlignTo", "CmdStop"],
  structureJumpBridgeMgr: ["CmdJumpThroughStructureStargate"],
  industryManager: ["InstallJob", "CompleteJob", "CancelJob"],
  industryMonitor: ["ConnectJob", "DisconnectJob"],
  marketProxy: ["PlaceBuyOrder", "PlaceMultiSellOrder", "CancelCharOrder", "ModifyCharOrder"],
  mailMgr: ["SendMail"],
  reprocessingSvc: ["Reprocess"],
  inSpaceCompressionMgr: ["CompressItemInSpace"],
  entity: ["CmdEngage", "CmdReturnBay", "CmdMineRepeatedly"],
  skillMgr: ["SaveNewQueue"],
  fleetObjectHandler: ["Init"],
});

const FEATURE_WRITE_METHODS = freezeMethodMap({
  repairSvc: ["RepairItems"],
  officeManager: ["RentOffice", "UnrentOffice"],
  // Direct acquisition belongs only to the reviewed Factory route. Keep the
  // generic bridge closed even if a future runtime allowlist grows.
  // SaveNewQueue is the client's own saving of a queue, on its skill handler (skillQueueSvc.py 153). The game
  // port carries it; the web gateway's list has skillMgr's and not this.
  skillHandler: ["PurchaseSkills", "SaveNewQueue"],
  // ⚠⚠ THE GM CONSOLE. slash.SlashCmd runs any of this world's ~150 chat
  // commands — /giveitem, /gmships, /giveskill, /npc, /suicide. It is a WRITE by
  // any measure, and listing it here is what keeps the generic /api/bridge/call
  // route from being a second, unconfirmed way to fire one.
  slash: ["SlashCmd"],
  // The customs office's transfer (taxed, and it moves a colony's goods). The
  // game port carries it; the web gateway's list has not got it.
  invbroker: ["ImportExportWithPlanet"],
});

function flattenMethodMap(methodsByService) {
  return Object.entries(methodsByService).flatMap(([service, methods]) =>
    methods.map((method) => `${service}.${method}`),
  );
}

const PLUMBING_SWEEP_WRITE_PAIR_KEYS = Object.freeze(
  flattenMethodMap(PLUMBING_SWEEP_WRITE_METHODS),
);
const EARLIER_WRITE_PAIR_KEYS = Object.freeze(flattenMethodMap(EARLIER_WRITE_METHODS));
const FEATURE_WRITE_PAIR_KEYS = Object.freeze(flattenMethodMap(FEATURE_WRITE_METHODS));
const BRIDGE_WRITE_PAIR_KEYS = Object.freeze([
  ...PLUMBING_SWEEP_WRITE_PAIR_KEYS,
  ...EARLIER_WRITE_PAIR_KEYS,
  ...FEATURE_WRITE_PAIR_KEYS,
]);
const bridgeWritePairKeySet = new Set(BRIDGE_WRITE_PAIR_KEYS);

if (bridgeWritePairKeySet.size !== BRIDGE_WRITE_PAIR_KEYS.length) {
  throw new Error("Duplicate service/method pair in bridge write policy.");
}

function isBridgeWritePair(service, method) {
  return (
    typeof service === "string" &&
    typeof method === "string" &&
    bridgeWritePairKeySet.has(`${service}.${method}`)
  );
}

/**
 * The writes the page makes for its pilot by the generic call, where each had a route of its own (the plan's
 * Phase 6b). A retail client makes its writes as it makes its reads: by the call. A write comes onto this list
 * when its route has been read for what it did besides the call, and each such thing is either the page's to
 * do now or was nothing but the confirmation, which the page still gives (`confirm` on the call). A write that
 * is not on it is made by its route alone, as before.
 *
 *   skillHandler.AbortTraining   the queue panel's Pause. Its route confirmed and called, with nothing.
 *   skillHandler.SaveNewQueue    the queue saved whole. Its route (POST /api/bridge/skills/queue) checked the
 *                                entries' shape, saved, and answered the sheet: the page spells the queue and
 *                                reads its own sheet after. The handler saves the session's own character's
 *                                queue and takes no one's name. Carried on the game port alone.
 *   skillHandler.ApplyFreeSkillPoints   free points put into one skill. Its route confirmed and called, with
 *                                the skill and the points the page sent. The handler spends the points of
 *                                the session's own character on a skill of its own, caps them at what the
 *                                skill can take, and takes no one's name. Carried by either transport.
 *   crimewatch.SetSafetyLevel    the ship's safety level set. Its route confirmed, checked the level was one
 *                                of the three, and called. The handler sets the level of the session's own
 *                                character, takes any number as one of the three, and takes no one's name.
 *                                The asking before a lower level is the page's selector's, as it is the
 *                                client's. Carried by either transport.
 *   contractProxy.AcceptContract a contract taken on. Its route confirmed and called, with the contract's ID
 *                                made a number and `forCorp` made true or false. The handler takes the
 *                                session's own character as who accepts; for the corporation, only where the
 *                                character has its Contract Manager role. Carried by either transport.
 *   planetMgr.DeleteLaunch       a planetary launch's record removed. Its route confirmed and called, with
 *                                the launch's ID made a number. The handler removes the record alone, and
 *                                only a launch of the session's own character. Carried by either transport.
 *   fleetProxy.ApplyToJoinFleet  a fleet applied to. Its route confirmed and called, with the fleet's ID made a
 *                                number and `autoAccept` made true or false. The handler takes the session's
 *                                own character as who applies, and only to a fleet advertised to it; the
 *                                flag rides the invitation it makes. Carried by either transport.
 *   fleetMgr.BroadcastToBubble   a broadcast to the fleet's members in the pilot's bubble. Its route confirmed
 *                                and called, with the item made a number. The handler broadcasts for the
 *                                session's own character in its own fleet, takes only a name it knows, holds
 *                                the scope to a number, and hands the item and the type on to the members
 *                                as they came, as it does a client's. Carried by either transport.
 *   dogmaIM.Overload,            a module overloaded, and cooled. Each route confirmed and called, on a dogma
 *   dogmaIM.StopOverload         object the BFF bound for itself, with the module and an effect's ID made
 *                                numbers (the page named no effect). The handler acts on the ship the session
 *                                is flying and on a module fitted to it, and takes no one's name; the effect
 *                                only picks among the module's own. Asked of the service by its name here:
 *                                the game port makes it on the dogma location godma keeps, as the client
 *                                does, and the gateway as it is asked.
 *   dogmaIM.InitiateModuleRepair, a module's repair begun, and ended. Each route confirmed and called on the
 *   dogmaIM.StopModuleRepair     BFF's own dogma object, with the module made a number. The handler begins
 *                                only for a damaged module the session's character owns, fitted to the ship
 *                                it is flying and not running, and takes the paste from that ship's hold; it
 *                                ends only a repair that session began, and mends the module then. Asked of
 *                                the service by its name, as the overload is.
 *   dogmaIM.LinkAllWeapons,      a ship's weapons linked into banks, and every bank broken. Each route
 *   dogmaIM.UnlinkAllModules     confirmed and called with the ship the BFF held as the session's, never one
 *                                of the page's naming, because the handler acted on whatever ship it was
 *                                handed. It holds every bank call to the ship the session is flying now (fixed
 *                                in eve.js on 2026-10-10), so the page names the ship, as a client does. Asked
 *                                of the service by its name, as the overload is.
 *   dogmaIM.LoadAmmo,            ammunition put into modules and taken out of them. Each route took a word for
 *   dogmaIM.UnloadAmmo           the place (the hold, or the hangar) and named the ship and the place itself,
 *                                because the handlers took the ship, the place the charges lie and the place
 *                                they go from the caller as they came. They hold each to where the session is
 *                                now (fixed in eve.js on 2026-10-10), so the page names them, as a client does.
 *                                Asked of the service by its name.
 *   beyonce.CmdFleetTagTarget    a fleet's tag on a thing in space, set or taken off. The route checked
 *                                `confirm` and that the pilot was in space, and made the call on a ballpark
 *                                handle. The handler acts on the session's own fleet, for its creator or a
 *                                commander of it, and drops the call of anyone else. Asked of beyonce by its
 *                                name; the game port makes it on the ballpark's own object.
 *   entity.CmdSalvage            drones sent to salvage a wreck, or any wreck. The route checked `confirm` and
 *                                made the call on an entity handle. The handler acts for the session's own
 *                                ship and on drones that ship controls, and answers for each drone that could
 *                                not. Asked of entity by its name; the game port makes it on a Moniker made
 *                                for the order, as a client does.
 *   beyonce.CmdGotoPoint         the ship sent to a point. The route checked `confirm`, that the point was three
 *                                finite numbers, that the pilot was in space, and that its ship and system were
 *                                the ones the point was measured in, and made the call on a ballpark handle. The
 *                                handler flies the session's own ship. The page reads its pilot's flight first
 *                                and makes the same three refusals. Asked of beyonce by its name; the game port
 *                                makes it on the ballpark's own object.
 *   planetMgr.UserUpdateNetwork  a colony's network changed. The route checked `confirm` and that the planet was
 *                                one, and made the call on the planet's own object. The handler changes the
 *                                colony the session's own character has on that planet, and no other. It is a
 *                                call on an object: the page says which planet with `of` (PAGE_OBJECT_CALLS).
 *   planetMgr.UserLaunchCommodities  what a colony's command centre holds, launched. The route checked `confirm`
 *                                and that the planet was one, and made the call on the planet's own object. The
 *                                handler launches from the colony the session's own character has on that
 *                                planet, debits that character's wallet, and refuses a pin that is no command
 *                                centre or is not ready. On the planet's object too, with `of`.
 *   ship.LeaveShip               the pilot's ship left, docked. The route checked `confirm`, made the call, and
 *                                answered once the pilot's flight said another ship, keeping the BFF's own word
 *                                for the pilot's ship. The handler does nothing with the ship named: it puts
 *                                the session's own character in a capsule where the session is docked. It is
 *                                made under the same watch of the swap (PAGE_SHIP_SWAP_CALLS).
 *   dogmaIM.CreateNewbieShip     a corvette boarded, docked. The route checked `confirm` and made the call with
 *                                no arguments, under the BFF's watch of the swap. The handler reads its two
 *                                arguments only to log them: it puts the session's own character in a corvette
 *                                where the session is docked, and refuses in space and aboard one. Made under
 *                                the same watch, and by the service's name, as the client asks it.
 *   officeManager.RentOffice     an office rented where the pilot is docked. The route checked `confirm`, that
 *                                the pilot was docked in a station on the game port, the renting role as the
 *                                BFF holds the session's roles, the price's form, and that the corporation
 *                                had no office there. The handler takes nothing from its argument: it rents
 *                                for the session's own corporation, where the session is, at its own price,
 *                                and refuses a session without the role or the ISK. The page goes by its
 *                                listing of the offices and its flight for what the route checked.
 *   officeManager.UnrentOffice   that office given up. The route checked `confirm`, the same of where the
 *                                pilot was, a director's role, and that there was an office. The handler
 *                                gives up the session's own corporation's office where the session is, and
 *                                refuses one who is no director.
 */
const PAGE_WRITE_PAIR_KEYS = Object.freeze(["skillHandler.AbortTraining", "skillHandler.SaveNewQueue", "skillHandler.ApplyFreeSkillPoints", "crimewatch.SetSafetyLevel", "contractProxy.AcceptContract", "planetMgr.DeleteLaunch", "fleetProxy.ApplyToJoinFleet", "fleetMgr.BroadcastToBubble", "dogmaIM.Overload", "dogmaIM.StopOverload", "dogmaIM.InitiateModuleRepair", "dogmaIM.StopModuleRepair", "dogmaIM.LinkAllWeapons", "dogmaIM.UnlinkAllModules", "dogmaIM.LoadAmmo", "dogmaIM.UnloadAmmo", "beyonce.CmdFleetTagTarget", "entity.CmdSalvage", "beyonce.CmdGotoPoint", "planetMgr.UserUpdateNetwork", "planetMgr.UserLaunchCommodities", "ship.LeaveShip", "dogmaIM.CreateNewbieShip", "officeManager.RentOffice", "officeManager.UnrentOffice"]);
const pageWritePairKeySet = new Set(PAGE_WRITE_PAIR_KEYS);
for (const pair of PAGE_WRITE_PAIR_KEYS) {
  if (!bridgeWritePairKeySet.has(pair)) throw new Error(`${pair} is among the page's writes and is no write.`);
}

/** Whether the page makes this write itself, by the generic call. */
function isPageWritePair(service, method) {
  return typeof service === "string" && typeof method === "string" && pageWritePairKeySet.has(`${service}.${method}`);
}

/**
 * The page's own writes that put the pilot in another ship. A client's session changes ship when the server says
 * so, and it holds its next session change back for a time. The BFF keeps its own word for the pilot's ship,
 * which its other routes go by; so such a write is made under the BFF's watch of the swap, as its route made it
 * (src/server.js, dispatchShipSwapWrite): answered once the pilot's flight says another ship, and refused while
 * another swap is under way.
 *
 *   ship.LeaveShip             station.TryLeaveShip: the pilot in its capsule from then on.
 *   dogmaIM.CreateNewbieShip   station.CreateNewbieShip: the pilot in a corvette from then on.
 */
const PAGE_SHIP_SWAP_CALLS = Object.freeze(new Set(["ship.LeaveShip", "dogmaIM.CreateNewbieShip"]));
for (const pair of PAGE_SHIP_SWAP_CALLS) {
  if (!pageWritePairKeySet.has(pair)) throw new Error(`${pair} is among the page's swaps of the pilot's ship and is none of its writes.`);
}

/** Whether this write of the page's puts the pilot in another ship. */
function swapsThePilotsShip(service, method) {
  return typeof service === "string" && typeof method === "string" && PAGE_SHIP_SWAP_CALLS.has(`${service}.${method}`);
}

/**
 * The page's own calls that the client makes on an object of the service's for a thing it names (its
 * Moniker(service, what)), by what that thing is. Such a call says which with `of`, and the BFF makes it on the
 * object bound for it. Without one it is no call, and no other call takes one.
 *
 *   planetMgr.UserUpdateNetwork     "planet": eveMoniker.GetPlanet(planetID), which the client's planet keeps.
 *   planetMgr.UserLaunchCommodities "planet": the same object, from the command centre's own window.
 *   planetMgr.GetProgramResultInfo  "planet": a READ, what a programme will yield, asked of the same object before
 *                                   one is installed (clientPlanet.InstallProgram). The handler reads the planet's
 *                                   own resources and the session's own colony, and nothing of anyone else's.
 *
 *
 * And one the client makes on an object another call answered, of which the session has only one:
 *
 *   scanMgr.GetFullState            "scanManager": a READ, the sites of the system the session is in
 *                                   (sensorSuiteService.py 718 and 722). The object is scanSvc.GetScanMan(), which
 *                                   GetSystemScanMgr() answered and the client keeps while it is in that system.
 *                                   There is nothing to say which: such a call takes no `of`, and with one is no
 *                                   call. The handler takes nothing from the caller and answers for the session's
 *                                   own system.
 *
 * A write among them is one of the page's own writes. A read is listed here only once its handler has been read
 * for what it takes from the caller: a planet's reads once answered with another owner's colony.
 */
const PAGE_OBJECT_CALLS = Object.freeze({ "planetMgr.UserUpdateNetwork": "planet", "planetMgr.UserLaunchCommodities": "planet", "planetMgr.GetProgramResultInfo": "planet", "scanMgr.GetFullState": "scanManager" });
/** The objects there are many of, which a call says which of with `of`. A scan manager is the session's own. */
const OBJECTS_THE_PAGE_NAMES = Object.freeze(new Set(["planet"]));
for (const pair of Object.keys(PAGE_OBJECT_CALLS)) {
  if (bridgeWritePairKeySet.has(pair) && !pageWritePairKeySet.has(pair)) throw new Error(`${pair} is among the page's calls on an object, is a write, and is none of the page's writes.`);
}

/** What the object of this call of the page's is ("planet", "scanManager"), or null where it is made on none. */
function objectOfPageCall(service, method) {
  if (typeof service !== "string" || typeof method !== "string") return null;
  // (A pair has a full stop in it, and nothing an object has of itself is named so.)
  return PAGE_OBJECT_CALLS[`${service}.${method}`] ?? null;
}

/** Whether a call on an object of this kind says which one, with `of`. */
function pageNamesTheObject(kind) {
  return OBJECTS_THE_PAGE_NAMES.has(kind);
}

// Presentation preference only. Identity, authority, character, corporation,
// role, ship and location fields are all created or retained server-side.
const SAFE_BROWSER_SESSION_FIELDS = Object.freeze([
  "languageID",
  "languageId",
  "languageid",
  "language",
]);

function pickSafeBrowserSessionFields(sessionFields) {
  if (!sessionFields || typeof sessionFields !== "object" || Array.isArray(sessionFields)) {
    return {};
  }
  const safe = {};
  for (const key of SAFE_BROWSER_SESSION_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(sessionFields, key)) {
      continue;
    }
    const value = sessionFields[key];
    if (typeof value === "string") {
      safe[key] = value;
    }
  }
  return safe;
}

module.exports = {
  BRIDGE_WRITE_PAIR_KEYS,
  EARLIER_WRITE_METHODS,
  EARLIER_WRITE_PAIR_KEYS,
  FEATURE_WRITE_METHODS,
  FEATURE_WRITE_PAIR_KEYS,
  PAGE_OBJECT_CALLS,
  PAGE_SHIP_SWAP_CALLS,
  PAGE_WRITE_PAIR_KEYS,
  PLUMBING_SWEEP_WRITE_METHODS,
  PLUMBING_SWEEP_WRITE_PAIR_KEYS,
  SAFE_BROWSER_SESSION_FIELDS,
  isBridgeWritePair,
  isPageWritePair,
  objectOfPageCall,
  pageNamesTheObject,
  pickSafeBrowserSessionFields,
  swapsThePilotsShip,
};
