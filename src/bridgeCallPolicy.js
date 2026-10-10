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
 */
const PAGE_WRITE_PAIR_KEYS = Object.freeze(["skillHandler.AbortTraining", "skillHandler.SaveNewQueue", "skillHandler.ApplyFreeSkillPoints"]);
const pageWritePairKeySet = new Set(PAGE_WRITE_PAIR_KEYS);
for (const pair of PAGE_WRITE_PAIR_KEYS) {
  if (!bridgeWritePairKeySet.has(pair)) throw new Error(`${pair} is among the page's writes and is no write.`);
}

/** Whether the page makes this write itself, by the generic call. */
function isPageWritePair(service, method) {
  return typeof service === "string" && typeof method === "string" && pageWritePairKeySet.has(`${service}.${method}`);
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
  PAGE_WRITE_PAIR_KEYS,
  PLUMBING_SWEEP_WRITE_METHODS,
  PLUMBING_SWEEP_WRITE_PAIR_KEYS,
  SAFE_BROWSER_SESSION_FIELDS,
  isBridgeWritePair,
  isPageWritePair,
  pickSafeBrowserSessionFields,
};
