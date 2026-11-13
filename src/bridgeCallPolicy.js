"use strict";

// Authoritative classification for the generic browser call boundary.
//
// PLUMBING_SWEEP_WRITE_METHODS is the 301-pair Phase 3/4 write inventory in
// docs/plumbing-worklist.md (152 top-level + 149 bound). The earlier map covers
// the mutators wired before that sweep, and FEATURE_WRITE_METHODS covers writes
// added afterward. The generic /api/bridge/call makes one of these only where it
// is one of the page's own writes (PAGE_WRITE_PAIR_KEYS, below), said to be a
// pilot's and meant; any other it refuses (403 BRIDGE_WRITE_REFUSED). A few have
// a route of their own still, confirmation-gated; most have none since
// 2026-10-14 (the loop's item 62): a screen that comes to want one makes the
// client's own call, added to the page's writes.

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
  mailMgr: ["MarkAsRead", "MarkAsUnread", "MoveToTrash", "MoveFromTrash", "MoveAllToTrash", "MarkAllAsRead", "DeleteMail", "EmptyTrash", "MarkAsReadByLabel", "MoveToTrashByLabel", "MoveAllFromTrash", "CreateLabel", "EditLabel", "DeleteLabel", "AssignLabels", "RemoveLabels", "MarkAsReadByList", "MoveToTrashByList"],
  mailingListsMgr: ["Create", "Join", "Leave", "Delete", "SetMembersClear", "SetMembersMuted", "SetMembersOperator", "KickMembers", "SetDefaultAccess", "SetEntitiesAccess", "ClearEntityAccess", "SaveWelcomeMail", "SendWelcomeMail", "ClearWelcomeMail"],
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
  charMgr: ["SetCharacterDescription", "SetActivityStatus", "LogSettings", "AddContact", "EditContact", "DeleteContacts", "EditContactsRelationshipID", "BlockOwners", "UnblockOwners", "CreateLabel", "EditLabel", "DeleteLabel", "AssignLabels", "RemoveLabels", "SetNote", "AddOwnerNote", "EditOwnerNote", "RemoveOwnerNote"],
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
  skillHandler: ["CharStartTrainingSkill", "AbortTraining", "ApplyFreeSkillPoints", "ApplyFreeSkillPointsToSkills", "ExtractSkills", "InjectSkillpoints", "SplitSkillInjector", "CombineSkillInjector", "InjectSkillIntoBrain"],
  jumpCloneSvc: ["InstallCloneInStation", "InstallCloneInStructure", "CloneJump", "DestroyInstalledClone", "SetJumpCloneName", "OfferShipCloneInstallation", "AcceptShipCloneInstallation", "CancelShipCloneInstallation"],
  crimewatch: ["SetSafetyLevel", "StartDuelChallenge", "RespondToDuelChallenge"],
  corpRegistry: ["AddBulletin", "UpdateBulletin", "UpdateBulletinOrder", "DeleteBulletin", "CreateLabel", "EditLabel", "DeleteLabel", "AssignLabels", "RemoveLabels", "AddCorporateContact", "EditCorporateContact", "RemoveCorporateContacts", "EditContactsRelationshipID", "UpdateTitle", "UpdateTitles", "UpdateMember", "UpdateMembers", "UpdateCorporation", "UpdateCorporationAbilities", "UpdateLogo", "UpdateDivisionNames", "SetAccountKey", "SetCorpWelcomeMail", "SetStructureReinforceDefault", "RegisterNewAggressionSettings", "RegisterNewAcceptStructureSettings", "RegisterNewCorpMailRestrictionSettings", "DeleteTitle", "ExecuteActions", "MoveCompanyShares", "MovePrivateShares", "PayoutDividend", "KickOutMember", "KickOutMembers", "ResignFromCEO", "InsertApplication", "InsertInvitation", "UpdateApplicationOffer", "AddCorporation", "CreateAlliance", "ApplyToJoinAlliance", "DeleteAllianceApplication", "DeclareWarAgainst"],
  // The recruitment proxy's ad writes (base_corporation CreateRecruitmentAd / UpdateRecruitmentAd / DeleteRecruitmentAd).
  corpRecProxy: ["CreateRecruitmentAd", "UpdateRecruitmentAd", "DeleteRecruitmentAd"],
  // CorporationVotes.InsertVote (a vote cast) and CreateVote (InsertVoteCase: Run For CEO, Propose Vote).
  voteManager: ["InsertVote", "InsertVoteCase"],
  // A mutual war's invitation (mutualWarInvites.SendInvite / WithdrawInvite).
  mutualWarInviteMgr: ["SendInviteByPlayer", "WithdrawInviteByPlayer", "RespondToInviteByPlayer", "SetInvitesBlockedByPlayer"],
  allianceRegistry: ["SetRelationship", "DeleteRelationship", "AddAllianceContact", "AddBulletin", "UpdateApplication", "PayBill", "SetPrimeHour", "SetCapitalSystem", "DeclareExecutorSupport", "UpdateAlliance", "DeleteMember", "DeleteBulletin", "UpdateBulletinOrder"],
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
  beyonce: ["CmdWarpToStuffAutopilot", "CmdWarpToStuff", "CmdSetSpeedFraction", "CmdFollowBall", "CmdStargateJump", "CmdDock", "CmdOrbit", "CmdAlignTo", "CmdStop", "CmdJumpToFleetModuleBeacon", "CmdGroupJumpToFleetModuleBeacon", "CmdBridgeToFleetModuleBeacon"],
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
  // Original invCache596-605: local client cache mutation, never a server RPC.
  invCache: ["InvalidateLocationCache"],
  // pvptradesvc.StartTradeSession38, invControllers.AddItems489 and pvptradewnd67-164.
  trademgr: ["InitiateTrade", "Abort", "Add", "MultiAdd", "OfferMoney", "MakeOffer"],
  // Compiled medals.py31-53/108-116: native creation service and decoration award callback.
  corporationSvc: ["CreateMedal", "GiveMedalToCharacters"],
  // xmppchatsvc.py 1197-1208 / 1257-1261: native private conversations and elevated invitations.
  XmppChatMgr: ["CreatePrivateChannel", "AddCharacterToChannel"],
  // all_cso.py 250-278: alliance contacts and their separately scoped labels.
  allianceRegistry: ["EditAllianceContact", "RemoveAllianceContacts", "EditContactsRelationshipID", "CreateLabel", "EditLabel", "DeleteLabel", "AssignLabels", "RemoveLabels"],
  // RepairItems is the server's own name for a repair, which the gateway's list has. The other two are the
  // client's, on the shop's Moniker (base_repairshop.py 65 to 70).
  repairSvc: ["RepairItems", "RepairItemsInStation", "RepairItemsInStructure"],
  officeManager: ["RentOffice", "UnrentOffice", "TrashImpoundedOffice"],
  // A fitting saved, and one of the same name saved over (fittingSvc.PersistFitting, 302 and 304): the fitting display's
  // Save of a fitting not saved yet (Save Fit As). The game port carries both; the web gateway's list has neither.
  charFittingMgr: ["SaveFitting", "UpdateFitting"],
  // The same saves on the corporation's and the alliance's fitting managers, and the name and description changed
  // there (fittingSvc.GetFittingMgr, 85 to 92): the fitting display's Save for Corporation and Save for Alliance. The
  // game port carries them; the web gateway's list has none.
  corpFittingMgr: ["SaveFitting", "UpdateFitting", "UpdateNameAndDescription", "DeleteFitting", "DeleteManyFittings"],
  allianceFittingMgr: ["SaveFitting", "UpdateFitting", "UpdateNameAndDescription", "DeleteFitting", "DeleteManyFittings"],
  // PurchaseSkills is the client's own buying of skill books (characterskills/client/purchase.py 100), from its
  // books window; a page's write since 2026-10-16 (the Factory route it was kept for went with Pilot Training).
  // SaveNewQueue is the client's own saving of a queue, on its skill handler (skillQueueSvc.py 153). The game
  // port carries it; the web gateway's list has skillMgr's and not this.
  skillHandler: ["PurchaseSkills", "SaveNewQueue"],
  // A character setting saved and deleted at the server, by the client's character settings service
  // (characterSettingsSvc.py 44 to 58). The game port carries both; the web gateway's list has neither.
  charMgr: ["SaveCharacterSetting", "DeleteCharacterSetting"],
  // ⚠⚠ THE GM CONSOLE. slash.SlashCmd runs any of this world's ~150 chat
  // commands — /giveitem, /gmships, /giveskill, /npc, /suicide. It is a WRITE by
  // any measure, and listing it here is what keeps the generic /api/bridge/call
  // route from being a second, unconfirmed way to fire one.
  slash: ["SlashCmd"],
  // The customs office's transfer (taxed, and it moves a colony's goods). The
  // game port carries it; the web gateway's list has not got it.
  // PasswordHandlerCallWrapper (invCache1442-1477) submits scalar EnterPassword on the same inventory.
  invbroker: ["ImportExportWithPlanet", "EnterPassword"],
  // A pilot's dock at a player structure and its undock from one, by the
  // client's structure docking service (structureDocking.py 69 and 36). The game
  // port carries both; through the web gateway, whose list has neither, the
  // park's CmdDock and the ship's Undock are asked in their place.
  structureDocking: ["Dock", "Undock"],
  // A bookmark folder's subfolders made, renamed and deleted, a folder put online or offline for the pilot, a
  // shared folder disconnected from, bookmarks copied into a folder, and a folder added to those the pilot knows, by
  // the client's bookmark service (bookmarkSvc.py 565, 572, 589, 483, 460, 701 and 357). The game port carries them;
  // the web gateway's list has none of the seven.
  accessGroupBookmarkMgr: ["CreateSubfolder", "UpdateSubfolder", "DeleteSubfolder", "UpdateKnownFolderState", "RemoveFromKnownFolders", "CopyBookmarksToFolderAndSubfolder", "AddToKnownFolders"],
  // The ship turned toward a direction: a probe result's Align To (scanSvc.AlignToPosition, 459 to 465), on the
  // ballpark's object. The game port carries it; the web gateway's list has it not.
  beyonce: ["CmdGotoDirection"],
  // An acceleration gate activated (movementFunctions.RealActivateAccelerationGate, 553): the keeper's, by its
  // name. The game port carries it; the web gateway's list has nothing of the keeper's.
  keeper: ["ActivateAccelerationGate"],
  // An expert system taken out (expertSystemSvc.RemoveExpertSystem: expertSystemMgr.RemoveMyExpertSystem, after the
  // client's question). The game port carries it; the web gateway's list has nothing of the expert systems'.
  expertSystemMgr: ["RemoveMyExpertSystem"],
  // The redeem window's claim of the account's tokens (redeemsvc.py 103): items into a hangar, or skill points and
  // ISK onto the character. The game port carries it; the web gateway's list has nothing of the user service's.
  userSvc: ["ClaimRedeemTokens"],
  // The day's claim of the account's daily login campaign (loginCampaignService.py 199), which puts a redeem token in
  // the account's queue. The game port carries it; the web gateway's list has nothing of the login campaign's.
  loginCampaignManager: ["claim_reward"],
  // The day's claim of the account's seasonal login campaign (seasonalLoginCampaignService.py 84): redeem tokens in
  // the account's queue. The game port carries it; the web gateway's list has nothing of the seasonal campaign's.
  seasonalLoginCampaignManager: ["claim_reward"],
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
 *   skillHandler.ApplyFreeSkillPointsToSkills   free points spread over skills' levels
 *                                (skillQueueSvc.ApplyFreeSkillPointsToSkills, 608 to 613: the Apply Skill Points
 *                                window's Confirm, from the skill requirement window): the levels one list of
 *                                (typeID, level). The handler spends the points of the session's own character on
 *                                its own skills, as far as they go, and takes no one's name; it answers the free
 *                                points left.
 *   skillHandler.PurchaseSkills  GetSkillHandler().PurchaseSkills(skill_type_ids) (characterskills/client/purchase.py
 *                                100), from the books window's Buy and Inject, the skill requirement window's Buy
 *                                and train: the skills as one list. The handler buys for the session's own
 *                                character, judges each skill again (sold, not injected) and the cost against its
 *                                wallet, and takes no one's name.
 *   dogmaIM.InjectSkillIntoBrain skills.InjectSkillIntoBrain (skillsvc.py 775 to 793): GetDogmaLM().
 *                                InjectSkillIntoBrain(itemIDs), from a skill book dropped from an inventory onto the
 *                                skill queue (skillQueuePanelNew.DoDropData): the books' item ids, one list. The
 *                                handler (skillbookRuntime.injectSkillbookItems) injects for the session's own
 *                                character, refuses an item not its own or no published skill (ItemNotASkill) and a
 *                                skill it has (CharacterAlreadyKnowsSkill), and takes no one's name.
 *   expertSystemMgr.RemoveMyExpertSystem  the expert systems page's Remove (PageController.remove_selected, after
 *                                prompt_remove_expert_system's Yes): the system's type. The handler
 *                                (expertSystemRuntime.removeExpertSystemFromCharacter) takes it from the session's own
 *                                character and takes no one's name.
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
 *   fleetMgr.AddToWatchlist,     the pilot's watchlist added to and taken from (fleetSvc.AddFavorite, 669, and
 *   fleetMgr.RemoveFromWatchlist RemoveFavorite, 719), from the fleet's menu for a member since 2026-10-15: the
 *                                pilots added or the one taken, and every favourite after it, the client's set.
 *                                The handler keeps the list for the session's own character in its own fleet,
 *                                and of that fleet's members only. Carried by either transport.
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
 *   dogmaIM.LinkWeapons,         one weapon grouped with another, by a drop on its slot with Shift held
 *   dogmaIM.MergeModuleGroups    (clientDogmaLocation.LinkWeapons, 751 to 782): the ship, the bank's master and the
 *                                module, or the master of the bank the module is in. Held to the ship the session
 *                                is flying.
 *   dogmaIM.OverloadRack,        a rack overloaded and stopped from its module button's menu (shipmodulebutton
 *   dogmaIM.StopOverloadRack     695 and 699: godma.OverloadRack, StopOverloadRack), the module named.
 *   dogmaIM.InitiateModuleRepairMany  the button's Repair All (shipmodulebutton 516: godma.RepairManyModules), the
 *                                ship's damaged modules named in a list.
 *   dogmaIM.PeelAndLink          a bank dragged onto another weapon on the HUD with Shift held
 *                                (clientDogmaLocation.LinkWeapons 778): the ship, the master and the bank's master.
 *   dogmaIM.DestroyWeaponBank    a bank broken up, as the client breaks one before a grouped weapon is put into a
 *                                container off its slot (clientDogmaLocation.UnloadModuleToContainer, 1086), the
 *                                ship and the bank's master named. Held to the ship the session is flying.
 *   dogmaIM.UnlinkModule         one module taken out of a bank, as the client takes one out before a grouped
 *                                weapon is unfitted from its slot (fittingSlotController.UnfitModule, 234:
 *                                UngroupModule, clientDogmaLocation 785), the ship and the bank's master named.
 *                                Held to the ship the session is flying, as the other bank calls are.
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
 *   beyonce.CmdGotoDirection     the ship turned toward a probe result's place (scanSvc.AlignToPosition, 459 to
 *                                465): the place less the ship's own position. The page reads its pilot's flight
 *                                first and sends nothing for a pilot not in space. The handler turns the session's
 *                                own ship. The game port makes it on the ballpark's own object.
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
 *   slash.SlashCmd               a GM's command, as the client's GM menus and its chat send one. The route
 *                                checked `confirm`, that there was a line and that it began with a stroke or a
 *                                dot, and sent it as it stood; its comment kept the pair from this call, which
 *                                then took no `confirm`. The handler runs the line as the world's own chat
 *                                commands, for the session that asked and whatever the line names, and asks
 *                                for no role: on this server any pilot may type the same in chat. The page's
 *                                console is an operator's, and says so.
 *   repairSvc.RepairItemsInStation    a repair paid for at a station's shop, as the client asks one. The route
 *                                asked the server's own RepairItems with no payment named, after reading the
 *                                pilot's flight. The handler repairs what of the items named is the session's
 *                                own character's and is where the session is docked, for the payment named,
 *                                from that character's wallet; it refuses a session that is docked nowhere,
 *                                and modules paid for in part.
 *   repairSvc.RepairItemsInStructure  the same in a structure, where nothing is paid. The handler asks for the
 *                                structure's repair service for itself.
 *   fleetObjectHandler.LeaveFleet  the pilot's fleet left, on the fleet's own object. The route checked
 *                                `confirm`; asked the object where the pilot's connection holds one, and
 *                                fleetMgr's ForceLeaveFleet where it holds none; and kept none of the BFF's
 *                                handles for the fleet after, whatever came of it. The handler takes nothing:
 *                                it takes the session's own character out of the fleet the object is for,
 *                                and refuses one who is no member of it. It is made as the route made it
 *                                (PAGE_OBJECT_CALLS, "fleet").
 *   beyonce.CmdWarpToStuffAutopilot  the ship sent into warp as the client's autopilot warps: the route
 *                                (flight/warp, with no range) asked no `confirm`, and checked that the pilot was
 *                                in space, which the page reads for itself. The server's handler
 *                                (beyonceService.Handle_CmdWarpToStuffAutopilot, read to its closing brace) takes
 *                                one number of the caller and nothing else: a thing of the session's own scene,
 *                                which the session's own ship is flown to, to stop ten kilometres off.
 *   beyonce.CmdWarpToStuff       the ship sent into warp: to a scan result, a bookmark, a launch, a thing and
 *                                a fleet member (bridge/movementWrites.ts). The routes asked no `confirm`. They checked that the
 *                                pilot was in space, which the page reads for itself before it asks. The server
 *                                flies the session's own ship in the session's own system: to a thing of its
 *                                scene; a site of that system by its label or its instance's number; a moon's
 *                                mining point there; a bookmark, a launch or an operation of the session's own
 *                                character; a member of its fleet; AND TO A POINT THE CALLER GIVES (an object of
 *                                x, y and z in the number's place, under a subject the handler does not know),
 *                                which no client sends. With fleet=True it goes on to its fleet's followers
 *                                (_warpFleetFollowers, not read further). So the BFF holds a page's warp to what
 *                                the client's menus make (src/server.js, notAClientsWarp, by the ledger's
 *                                judge): anything else is refused, and not sent.
 *   beyonce.CmdAlignTo           the ship aligned to a thing. The route asked no `confirm`. It checked that
 *                                the thing was a number above nought and that the pilot was in space, made the
 *                                call on a ballpark handle with the thing by name and no bookmark, and read
 *                                the pilot's flight after it for the panel. The handler aligns the session's
 *                                own ship in the session's own system, does nothing for a session with no
 *                                ship in space, and refuses nothing. The page reads its pilot's flight before
 *                                and after, and makes the route's two refusals. Asked of beyonce by its name;
 *                                the game port makes it on the ballpark's own object.
 *   beyonce.CmdGotoBookmark      the ship sent to a bookmark of the pilot's: Approach Location, from a
 *                                bookmark's menu in the Locations window (bridge/movementWrites.ts). No route
 *                                made it. The handler takes one number of the caller: a bookmark of the session's
 *                                own character, refused where it is none (BookmarkNotAvailable), and flies the
 *                                session's own ship after the thing it is of, in its scene, or to its point. The
 *                                page reads its pilot's flight first. Asked of beyonce by its name; the game port
 *                                makes it on the ballpark's own object.
 *   beyonce.CmdFollowBall        the ship sent after a thing, to stop at a range of it: the menu's approach and
 *                                keep at range, and the autopilot's approach with no range. Its two routes
 *                                asked no `confirm`. They checked that the thing was a number above nought,
 *                                made the range a distance (a default where none was said, a floor of fifty
 *                                metres for keep at range, a million at most), refused a pilot not in space,
 *                                and read the pilot's flight after for the panel: all of which the page does
 *                                for itself. Two things they did are the BFF's still (PAGE_FOLLOW_CALLS). The
 *                                handler flies the session's own ship, does nothing for a session with no
 *                                ship in space, and refuses the same follow sent again within a second
 *                                (ThrottleGeneric, which the page has words for).
 *   beyonce.CmdSetSpeedFraction  the throttle set. No route asked it for the page: the approach's opened it
 *                                before the autopilot's follow, as the client's autopilot does, and the page
 *                                asks it there itself now. The handler sets the session's own ship's speed.
 *   beyonce.CmdOrbit             the ship set to orbit a thing at a range. Its route asked no `confirm`. It
 *                                checked the thing and the range as the follow's routes did, with a thousand
 *                                metres where no range was said, rounded a range of ten metres or more to a
 *                                whole number, refused a pilot not in space, and read the pilot's flight
 *                                after: all of which the page does for itself, cutting the range as the
 *                                client's int() cuts it. The hold-back and the gateway's throttle are the
 *                                BFF's still (PAGE_FOLLOW_CALLS). The handler flies the session's own ship,
 *                                and refuses the same orbit sent again within a second (ThrottleGeneric).
 *   beyonce.CmdStop              the ship stopped. Its route asked no `confirm`, refused a pilot not in space,
 *                                made the call on a ballpark handle with nothing, and read the pilot's flight
 *                                after for the panel; it held nothing back and opened no throttle. The page
 *                                reads the flight before and after itself. The handler stops the session's own
 *                                ship, tells one stopped in warp that it is in warp, and refuses a second
 *                                stop within a second (ThrottleGeneric).
 *   beyonce.CmdJumpToFleetModuleBeacon  the ship jumped to a fleet member's cyno: the fleet menu's Jump To
 *                                (menusvc.JumpToMember, 2643 to 2650; cynoTravelSvc.py 30 to 37:
 *                                bp.CmdJumpToFleetModuleBeacon(charID, beaconID, solarsystemID) through
 *                                sessionMgr.PerformSessionChange('jump')), the member, its beacon and its system as
 *                                the fleet told them (OnFleetJumpBeaconModuleChange). No route made it. A change of
 *                                place (PAGE_PLACE_CHANGE_CALLS). The handler checks the beacon, the drive, the
 *                                range and the fuel.
 *   beyonce.CmdGroupJumpToFleetModuleBeacon  the same jump taking the fleet's members in range along: the fleet
 *                                menu's Conduit Jump To (menusvc.GroupJumpToMember; cynoTravelSvc.py 97 to 104).
 *                                A change of place.
 *   beyonce.CmdBridgeToFleetModuleBeacon  a bridge opened to a fleet member's cyno for the fleet to jump through:
 *                                the fleet menu's Bridge To (menusvc.BridgeToMember; cynoTravelSvc.py 57 to 63:
 *                                bp.CmdBridgeToFleetModuleBeacon(charID, beaconID, solarsystemID), no change of
 *                                session: the ship opening it stays).
 *   fleetObjectHandler.CreateFleet  a fleet formed, the pilot its boss. The route checked `confirm`, bound
 *                                through the call (it answers the fleet's own object), asked Init on what was
 *                                bound, with nothing said, and kept none of the BFF's handles for a fleet
 *                                after. The handler takes nothing and makes a fleet nobody is in; Init puts
 *                                the session's own character in it. The page cannot hold what the call
 *                                answers, so it is made as the route made it (PAGE_OBJECT_CALLS, "fleet").
 *                                A client asks it from no session that is in a fleet.
 *   fleetObjectHandler.AcceptInvite  a fleet's invitation accepted. The route checked `confirm` and that the
 *                                fleet named was a number above nought, bound that fleet's object by its
 *                                number, asked AcceptInvite on it with no type of ship said, and kept none
 *                                of the BFF's handles for a fleet after. The handler accepts only where a real
 *                                invitation for the session's own character names that fleet, and refuses a
 *                                character that is in a fleet, a fleet that is full, and a place that is not
 *                                there. The page says which fleet (PAGE_OBJECT_CALLS, "fleetByNumber"). A
 *                                client asks it from no session that is in a fleet.
 *   fleetObjectHandler.Invite    a pilot invited to the pilot's own fleet. The route checked `confirm`, took
 *                                the invitee, a wing, a squad and a role, bound the session's own fleet (or,
 *                                with an `expectedFleetID`, the fleet of that number), asked Invite on it, and
 *                                kept none of the BFF's handles for a fleet after. The handler takes the
 *                                inviter from the session, which must be a member of the fleet bound; it
 *                                refuses an invitee that is in a fleet and a place that is not there, and
 *                                **seats the invitee in whatever role it is told, a plain member's telling
 *                                too**: so the page's call names the invitee alone, and the BFF says None
 *                                for the other three whatever it came with (PAGE_OBJECT_CALLS,
 *                                "fleetExpected"). A client asks none for its own character.
 *   fleetObjectHandler.RejectInvite  a fleet's invitation turned down. The route checked `confirm`, that the
 *                                fleet named was a number above nought and that `alreadyInFleet`, where it
 *                                was said, was true or false; bound that fleet's object by its number, asked
 *                                RejectInvite on it with that word or with nothing, and kept none of the
 *                                BFF's handles for a fleet after. The handler forgets the session's own
 *                                character's invitation where it names that fleet, and tells the inviter;
 *                                with none it answers false. The word decides only which reason the inviter
 *                                is told. The page says which fleet (PAGE_OBJECT_CALLS, "fleetByNumber").
 *   beyonce.BookmarkScanResult   a probe result bookmarked where the sensor suite has no site of it
 *                                (bookmarkSvc.ACLBookmarkScanResult, 623 to 631): the system, the label and the
 *                                note, the result's own ID, the folder and the time, the subfolder by keyword.
 *                                The handler finds the result's site by its label in the session's system, and
 *                                holds the folder to what the session's own character may write to. The game port
 *                                makes it on the ballpark's own object.
 *   beyonce.BookmarkLocation     a place in space bookmarked. The route checked `confirm`, read the pilot's
 *                                flight before and after and refused a pilot not in space, made the thing, the
 *                                folder and the time numbers and the name and the note text, and asked it on
 *                                the BFF's bound beyonce, with the subfolder by keyword only where one was
 *                                said. The handler looks for the thing in the session's own scene, and holds
 *                                the folder to what the session's own character may write to. The page asks
 *                                it by the service's name, the subfolder by keyword every time as the client
 *                                says it; the game port makes it on the park's object and refuses it with no
 *                                park, and through the gateway the server refuses a docked pilot's.
 *   dogmaIM.AddTarget, RemoveTarget, CancelAddTarget   a target locked, let go, and a lock called off. The
 *                                lock's route read the pilot's flight and refused a pilot not in space, asked
 *                                AddTarget by the service's name, and read what was locked after; the
 *                                unlock's asked CancelAddTarget and then RemoveTarget, both every time, and
 *                                read after. Each handler takes the target and acts for the session's own
 *                                ship. The page asks each by the service's name and makes the read itself,
 *                                and of the two that let go it asks the one the client would, by what it has
 *                                of the target. Every lock let go at once is its route's still.
 *   ship.ScoopDrone              a drone scooped into the ship's bay. The route checked `confirm` and that
 *                                the drones were a list of numbers above nought, read the pilot's flight to
 *                                hold the BFF's word for its ship to the ship flown and refused a pilot not
 *                                in space, asked ScoopDrone by the service's name, and read the drones in
 *                                space after. The handler takes the drones, acts for the session's own ship,
 *                                and says of each drone it will not scoop why. The page asks it by the
 *                                service's name and reads its drones after, as it does for a salvage.
 *   industryManager.CompleteJob  a finished job delivered, and
 *   industryManager.CancelJob    a job stopped. Each route (the stop's checked `confirm`) read the pilot's
 *                                flight for the solar system the pilot is in, sent the job with that, and
 *                                read the job after (GetJob) to say whether its status had moved. The
 *                                client sends the job's own solar system, from the job's row. Neither
 *                                handler reads the system: each takes the job, lets its owner act (or one
 *                                with the corporation's leave), refuses in a sentence of its own a job not
 *                                found, not ready or past stopping, and answers the job as it is after.
 *                                The page asks each by the service's name, with the system its own read of
 *                                the job has, and goes by the job answered.
 *   industryMonitor.ConnectJob   the Industry window's job's monitor, opened and let go (industrySvc.py 305 to
 *   industryMonitor.DisconnectJob 313): ConnectJob(job.dump()), answered (monitorID, available), once for the job
 *                                monitored; DisconnectJob(monitorID, or None) at the window's close. Until
 *                                2026-10-14 the preview route (POST /api/bridge/industry/preview) opened it and the
 *                                window's events route (.../window) had the transport let it go; the page makes
 *                                the job's dump itself (web/src/bridge/industryMonitor.ts).
 *   industryManager.InstallJob   the window's Start (submitButton.py 221): InstallJob(job.dump()), answered the
 *                                job's number (industrySvc.py 139 to 144). Until 2026-10-14 a route (POST
 *                                /api/bridge/industry/install) reckoned the job, made its dump and read the job and
 *                                the blueprint after; the page makes it as it makes the preview's.
 *
 * And the scanner's four, since 2026-10-13. Each was a route (POST /api/bridge/scanner/launch, analyze, recover
 * and reconnect, all over one helper, runAuthoritativeScannerWrite) that read the pilot's scanner for the
 * launcher, the probes and their places, refused where there was none, made the call with them and read the
 * scanner after. The page reads its scanner itself (GET /api/bridge/scanner/state, the transport's own keeping
 * with no call behind it), refuses as the client's scan service refuses, and makes the client's call
 * (web/src/bridge/scannerWrites.ts):
 *
 *   dogmaIM.LaunchProbes         scanSvc.FindModuleAndLaunchProbes (487 to 498): dogmaLM.LaunchProbes(moduleID,
 *                                numProbes). The handler (dogmaService/moduleOperation.js,
 *                                _resolveValidatedProbeLaunchContext) takes the module and the number: the module
 *                                must be the session's own character's, in the session's own ship, a probe
 *                                launcher and online, with that many scanner probes loaded, and eight out at
 *                                most. Nothing of another's is reached by either.
 *   scanMgr.RequestScans         scanSvc.RequestScans (193 to 198), on the system's scan manager: the idle
 *                                probes by their numbers, or None. The handler moves and scans with the
 *                                session's own character's probes among those sent, and drops the rest.
 *   scanMgr.RecoverProbes        scanSvc.AskServerToRecallProbes (340 to 341), on the same object: the probes'
 *                                numbers. The handler takes back the session's own character's among them and
 *                                answers which.
 *   scanMgr.ReconnectToLostProbes scanSvc.ReconnectToLostProbes (269 to 285), on the same object, with nothing.
 *   scanMgr.SetProbeDestination  scanSvc.SetProbeDestination (169 to 171), since 2026-10-15: a probe sent to its
 *                                place in a formation (probeTracker.ProbeGoToPoint). The client's own list's, kept
 *                                and not sent on the game port, as the range step below.
 *   scanMgr.SetProbeRangeStep    scanSvc.SetProbeRangeStep (173 to 175), since 2026-10-15: the probe's menu's Scan
 *                                Range (SetScanRange_Check, 410). The client's own list's, never the server's: on
 *                                the game port the transport keeps it as the client's scan service does and sends
 *                                nothing (src/gamePort/pilots.js, callBoundMethod); through the web gateway it goes
 *                                to the server's handler, which keeps it for the session's own probes.
 *   scanMgr.ConeScan             directionalScanSvc.DirectionalScan (47), since 2026-11-09: the directional
 *                                scanner's sweep, on the same object, (scanAngle, scanRange, x, y, z). The
 *                                handler (exploration/scanMgrService.js) scans from the session's own ship in the
 *                                session's own system and takes no item from the caller: the angle, the range and
 *                                the direction only shape the cone.
 *
 * And a module put online and taken offline, since 2026-10-13. The route (POST /api/bridge/fitting/state) sent
 * the module with the ship the BFF held the pilot to be flying; the page sends the ship its own read of the
 * fitting is of (web/src/bridge/dogmaWrites.ts, setModuleOnline):
 *
 *   dogmaIM.SetModuleOnline      clientDogmaLocation.OnlineModule (698 to 711): SetModuleOnline(the ship the
 *   dogmaIM.TakeModuleOffline    module is in, moduleID); OfflineModule (713 to 723): TakeModuleOffline, the
 *                                same two. The handler (dogmaService/moduleOperation.js, _setModuleOnlineState)
 *                                takes both of the caller: the module must be the session's own character's
 *                                and lie in that ship, so a ship or a module of another's is found by neither.
 *   ship.Jettison                GetShipAccess().Jettison(itemIDs) (invItemFunctions.py 63), the items as one list,
 *                                on the ship's Moniker for the solar system. Its route keeps a hosted bot's of a
 *                                Mining Operation (the can found and given to the operation, a miner's custody);
 *                                any other went by it until 2026-10-14 (web/src/bridge/shipWrites.ts).
 *   ship.AssembleShip            GetShipAccess().AssembleShip(itemIDs, name=name, subSystems=subSystems)
 *                                (invItemFunctions.py 197), from a packaged ship's menu in the hangar: Assemble Ship,
 *                                and Board Ship's first step. The handler assembles the session's own character's
 *                                packaged ships in the hangar where it is docked and no other's.
 *   ship.FitShips                GetShipAccess().FitShips(shipTypeID=, fitInfo=, itemLocationID=, cargoItemsByType=,
 *                                fitRigs=, name=, numToFit=, itemContainerID=) (fittingSvc.py 510), from the multifit
 *                                window's Fit. The handler takes the place only where the session is docked there, and
 *                                assembles and fits the session's own character's packaged ships of the hull there.
 *   dogmaIM.Activate             godma.Activate (2062), from the module's button (shipmodulebutton.py 1348):
 *   dogmaIM.Deactivate           Activate(itemID, effectName, target, repeat); Deactivate(itemID, effectName)
 *                                (2101). Routes until 2026-10-14 (POST /api/bridge/modules/activate and
 *                                .../deactivate); the page names the module's default effect from the game's data
 *                                (GET /api/types/default-effects) and reads the running modules after
 *                                (web/src/bridge/dogmaWrites.ts).
 *
 * And an agent's two, since 2026-10-13. Each was a route (POST /api/bridge/agents/:agentID/action and
 * .../remove-offer) that made the one call on the object bound for that agent and handed the answer on. The page
 * asks each on the agent's object, saying which agent with `of` (web/src/bridge/agentWrites.ts; PAGE_OBJECT_CALLS,
 * below):
 *
 *   agentMgr.DoAction                agentDialogueWindow.ExecuteAgentAction (427 to 428):
 *                                    GetAgentMoniker(agentID).DoAction(actionID), None to open a conversation.
 *   agentMgr.RemoveOfferFromJournal  agents.RemoveOfferFromJournal (782 to 784): the same object, with nothing.
 *
 * And lost drones reconnected to, since 2026-10-13. The route (POST /api/bridge/entity/drones/reconnect) made
 * the call and read the drones in space after; the page makes the call and reads its drones itself
 * (web/src/bridge/boundEntityWrites.ts, reconnectToDrones):
 *
 *   entity.CmdReconnectToDrones  droneFunctions._ReconnectToDroneCandidates (244 to 259):
 *                                eveMoniker.GetEntityAccess().CmdReconnectToDrones(droneCandidates). The handler
 *                                (droneRuntime.commandReconnectToDrones) takes the drones of the caller and
 *                                passes over any that is not the session's own character's, or is controlled.
 *
 * And a market order taken down, since 2026-10-13. The route (POST /api/bridge/market/cancel) read the pilot's
 * orders and wallet, made the call with the order and a region of nought, and read both again for its verdict.
 * The page reads both itself, names the region off the order's own row, and makes the call
 * (web/src/bridge/marketOrderWrites.ts, cancelOrder):
 *
 *   marketProxy.CancelCharOrder  marketsvc.CancelOrder (281 to 283): GetMarketProxy().CancelCharOrder(orderID,
 *                                regionID), both off the order's row (quote.py 302). The handler
 *                                (marketProxyService.Handle_CancelCharOrder) reads the order's number alone,
 *                                loads that order for the session's own character, and refuses another's.
 *
 * And a module fitted and unfitted, since 2026-10-13: the first of the page's own calls on an inventory's own
 * object (PAGE_OBJECT_CALLS, below: "inventory"). Each was a route (POST /api/bridge/fitting/fit and .../unfit)
 * that named the slot's flag, read the ship's slots, made the one call on the inventory it had bound and read the
 * slots again. The page names the flag, reads its slots itself, and makes the call
 * (web/src/bridge/fitModule.ts):
 *
 *   invbroker.Add                clientDogmaLocation.TryFit (669 to 673): the ship's own inventory's
 *                                Add(itemID, the place the item lies in, qty=1, flag=the slot's); and
 *                                fittingSlotController.UnfitModule (217 to 243): the hangar's inventory's
 *                                Add(moduleID, shipID, flag=flagHangar) docked, the ship's own Add(moduleID,
 *                                shipID, qty=None, flag=flagCargo) in space.
 *   invbroker.MultiAdd           fittingUtil.TryFit (117 to 157) and the fitting screen's FitModule (tryFit.py
 *                                125 to 135): a module fitted to no slot of the ship's, the server to pick,
 *                                shipInv.moniker.MultiAdd(itemIDs, sourceID, flag=flagAutoFit).
 *
 * And a launchpad's goods sent up into its planet's customs office, since 2026-10-13: the route (POST
 * /api/bridge/planet/customs/export) read the pilot's flight, asked the office's tax rate and made the transfer
 * naming it. The page asks the rate itself, as a read, and makes the transfer (web/src/bridge/customsWrites.ts):
 *
 *   invbroker.ImportExportWithPlanet  importExportUI.ConfirmCommodityTransfer (537 to 558), on the office's own
 *                                inventory: ImportExportWithPlanet(spaceportPinID, importData, exportData,
 *                                taxRate), the rate as planetOrbitalRegistryBroker.GetTaxRate answered it (382 to
 *                                385). The web gateway's list has it not, and refuses it there as it refused the
 *                                route.
 *
 * And a stack dropped on a stack, since 2026-10-13, where the page holds the place's rows (the corporation's hangar
 * is still the route's, POST /api/bridge/inventory/merge): the page makes the call and reads the place again
 * (web/src/bridge/inventoryWrites.ts):
 *
 *   invbroker.MultiMerge         invCache's container's MultiMerge (1100 to 1124), from the drop (item.py 958 on)
 *                                through the target's container's controller (invControllers.py 327 to 335):
 *                                MultiMerge([(source, destination, qty)], the source's place).
 *
 * And items trashed, since 2026-10-13: the route (POST /api/bridge/inventory/trash) listed the place, sent
 * TrashItems on the inventory manager and listed the place again. The page makes the call and reads the place
 * again (web/src/bridge/inventoryWrites.ts):
 *
 *   invbroker.TrashItems         invItemFunctions.TrashInvItems (602 to 626): GetInventoryMgr().TrashItems(
 *                                itemsToTrash, locationID), the place as invCache.GetStationIDOfItem names it.
 *
 * And a saved fitting applied, since 2026-10-14: the route (POST /api/bridge/inventory/fit-fitting) sent it on the
 * inventory manager's handle. The page makes the call on the ship's own inventory (web/src/bridge/fitModule.ts):
 *
 *   invbroker.FitFitting         fittingSvc.LoadFitting (554 to 618): invCache.GetInventoryFromId(activeShip).
 *                                FitFitting(activeShip, shipTypeID, itemsToFit, the station or structure,
 *                                fittingObjKeyVal, cargoItemsByType, fitRigs). Its handler refuses a ship that
 *                                is not the pilot's (FakeItemNotFound, asked live on 2026-10-14).
 *
 * And Stack All of the hangar or the ship's hold, since 2026-10-14: the route (POST /api/bridge/inventory/stack)
 * sent it on the place's binding. The page makes the call (web/src/bridge/inventoryWrites.ts):
 *
 *   invbroker.StackAll           invControllers.StackAll (382 to 388): the container's own
 *                                StackAll(self.locationFlag), asked by invCache's container only where it
 *                                lists two stacks of a type (invCache.py 1065 to 1093). Its handler merges per
 *                                type, owner and flag, each merge by the custody's own check.
 *
 * And a rig destroyed, since 2026-10-14: the route (POST /api/bridge/fitting/destroy-rig) read the slots, sent it on
 * the ship's binding and read the slots again. The page makes the call (web/src/bridge/fitModule.ts):
 *
 *   invbroker.DestroyFitting     fittingSlotController.Unfit (262): the ship's own inventory's
 *                                DestroyFitting(moduleID), once the pilot has said OK. Its handler
 *                                (fittingOperations.Handle_DestroyFitting) refuses what is in no rig slot,
 *                                holds the ship to the session's access, and answers None.
 *
 * And a mail sent, since 2026-10-14: the route (POST /api/bridge/mail/send) held the message to its own limits, made
 * the call and read the sender's mailbox again. The page makes it (web/src/bridge/mailWrites.ts), held to the
 * compose window's own checks, and goes by the number answered, as the client does:
 *
 *   mailMgr.SendMail             mailSvc.SendMail (959 to 993), through eveMisc.CSPAChargedAction: SendMail(
 *                                toCharacterIDs, toListID, toCorpOrAllianceID, title, body, isReplyTo,
 *                                isForwardedFrom). Its handler (mailMgrService.Handle_SendMail) sends as the
 *                                session's own character and answers the message's number, or None.
 *
 * And drones launched, since 2026-10-14: the route (POST /api/bridge/drones/launch) read the drones before, made the
 * call and read them again until a new one showed. The page does the same (web/src/bridge/boundEntityWrites.ts;
 * web/src/app/flow.ts, launchedThenRead):
 *
 *   ship.LaunchDrones            eveMisc.LaunchFromShip (29): GetShipAccess().LaunchDrones([(itemID, quantity),
 *                                ...], None, False). Its handler (shipService, droneRuntime) launches from the
 *                                session's own ship and answers each stack's new drones, or an error per drone.
 *
 * And orders placed and repriced, since 2026-10-14: three routes (POST /api/bridge/market/buy, .../sell and
 * .../modify) read the wallet, made the call and read the wallet and the orders again. The page reads them itself
 * and makes the calls (web/src/bridge/marketOrderWrites.ts); the broker's fee rate it cannot work out goes as None,
 * and the game port names the client's (src/gamePort/retailCalls.js):
 *
 *   marketProxy.PlaceBuyOrder        marketsvc.BuyStuff (256 to 268): PlaceBuyOrder(stationID, typeID, price,
 *                                    quantity, orderRange, minVolume, duration, useCorp, expectedBrokersFee).
 *   marketProxy.PlaceMultiSellOrder  marketsvc.SellMulti (275 to 276): PlaceMultiSellOrder(itemList, useCorp,
 *                                    duration, expectedBrokersFee), each item a KeyVal (sellMulti.py 483 to 501).
 *   marketProxy.BuyMultipleItems     marketsvc.BuyMulti (270 to 273), the client's multibuy window's Buy
 *                                    (buyMultiFromBase.py 296 to 311): BuyMultipleItems(stationID, itemList, useCorp),
 *                                    each item a KeyVal of the station, type, price, quantity, least fill and how far
 *                                    the price is from the type's average (marketutil/orderInfo.py GetBuyItemInfo). Its
 *                                    handler buys for the session's own character, or its corporation where it is
 *                                    asked and may, at the station named, each at the price named or below.
 *   marketProxy.ModifyCharOrder      marketsvc.ModifyOrder (285 to 289): ModifyCharOrder(order.orderID, newPrice,
 *                                    and seven more off the order's row). Its handler loads the order for the
 *                                    session's own character, and refuses another's, as the cancel's does.
 *
 * And the drones' three orders, since 2026-10-14: three routes (POST /api/bridge/drones/engage, .../mine and
 * .../recall) read that the pilot was in space, made the call on an entity handle and read the drones in space after.
 * The page makes the calls as it makes the salvage (web/src/bridge/boundEntityWrites.ts) and reads the drones itself;
 * each is asked of entity by its name, and the game port makes it on a Moniker made for the order (retailCalls.js):
 *
 *   entity.CmdEngage             droneFunctions.EngageTarget (93): CmdEngage(droneIDs, targetID).
 *   entity.CmdMineRepeatedly     droneFunctions.MineRepeatedly (151): CmdMineRepeatedly(droneIDs, targetID).
 *   entity.CmdReturnBay          droneFunctions.ReturnToDroneBay (187): CmdReturnBay(droneIDs).
 *                                The handlers act for the session's own ship and on drones that ship controls,
 *                                and answer for each drone that could not.
 *
 * And ore compressed in space, since 2026-10-14: a route (POST /api/bridge/mining/compress) read that the pilot was
 * in space, held the call to a hosted bot's observed ship and system, and made it. The page makes it
 * (web/src/bridge/compressionWrites.ts), and its support collection reads the flight first:
 *
 *   inSpaceCompressionMgr.CompressItemInSpace   itemCompression.CompressItemInSpace (9): CompressItemInSpace(
 *                                    itemID, compressionFacilityBallID), answered None or the six of what was made.
 *
 * And a character setting, since 2026-10-15: the wallet's Auto Payment tab (personalPaySettingsPanel.py
 * SubmitPersonalAutomaticPaymentSettings) saves its own, by the character settings service; the game port works
 * each into the settings it keeps, as the service does:
 *
 *   charMgr.SaveCharacterSetting     characterSettingsSvc.Save (44 to 50): SaveCharacterSetting(settingKey, value),
 *                                    the value a string of at most 102400; an empty one is deleted instead.
 *   charMgr.DeleteCharacterSetting   characterSettingsSvc.Delete (52 to 58): DeleteCharacterSetting(settingKey), for
 *                                    a setting the service keeps.
 *
 * And Give Money, since 2026-10-15: the transfer window of an owner's menu in the People & Places window
 * (web/src/bridge/giveMoney.ts). The ISK given is the session's own character's; the game port gives the amount as
 * a float and the reason as the client's edit gives it (retailCalls.js):
 *
 *   account.GiveCash             transferMoneyWnd.py Confirm (148): GiveCash(toID, amount, reason,
 *                                toAccountKey=None) for a character; answered None, or the two balances for a
 *                                corporation.
 *
 * And a place bookmarked, since 2026-10-15: the bookmark window (web/src/ui/BookmarkWindow.svelte) from the Locations
 * window's Add Location and an agent's Save Location... A thing in space goes by the park (beyonce.BookmarkLocation,
 * a page write already); a region, a constellation, a system or a station by the bookmark manager:
 *
 *   accessGroupBookmarkMgr.BookmarkStaticLocation   bookmarkSvc.ACLBookmarkLocation (612): BookmarkStaticLocation(
 *                                itemID, folderID, name, comment, expiry, subfolderID=subfolderID), into a folder the
 *                                session's character may use.
 *
 * And a bookmark's menu in the Locations window, since 2026-10-15: Edit Location and Remove Location.
 *
 *   accessGroupBookmarkMgr.UpdateBookmark    bookmarkSvc.UpdateACLBookmark (646): UpdateBookmark(bookmarkID, folderID,
 *                                name, note, subfolderID, newFolderID, expiryCancel).
 *   accessGroupBookmarkMgr.DeleteBookmarks   bookmarkSvc.DeleteBookmarks (664): DeleteBookmarks(folderID, bookmarks),
 *                                the bookmarks a set; answered the ones deleted.
 *                                Both act for the session's character in a folder it may use.
 *
 * And the Locations window's folders and subfolders, since 2026-10-15: a folder's and a subfolder's menus
 * (bookmarksPanel.py BookmarkACLFolderMenu, 320 to 338, and BookmarkSubfolderMenu, 408 to 417), and Create Subfolder
 * at the window's bottom, with the subfolder window (web/src/ui/SubfolderWindow.svelte):
 *
 *   accessGroupBookmarkMgr.CreateSubfolder   bookmarkSvc.CreateSubfolder (565): CreateSubfolder(folderID,
 *                                subfolderName); answered the subfolder.
 *   accessGroupBookmarkMgr.UpdateSubfolder   bookmarkSvc.UpdateSubfolder (572): UpdateSubfolder(folderID,
 *                                subfolderID, subfolderName); answered whether it was there.
 *   accessGroupBookmarkMgr.DeleteSubfolder   bookmarkSvc.DeleteSubfolder (589): DeleteSubfolder(folderID,
 *                                subfolderID), the bookmarks in it with it; answered the ones deleted.
 *   accessGroupBookmarkMgr.UpdateKnownFolderState   bookmarkSvc.UpdateFolderActiveState (483):
 *                                UpdateKnownFolderState(folderID, isActive), Online Folder and Offline Folder;
 *                                answered the folder, its bookmarks and its subfolders.
 *   accessGroupBookmarkMgr.DeleteFolder      bookmarkSvc.DeleteBookmarkFolder (453): DeleteFolder(folderID), the
 *                                folder and all in it.
 *                                Each acts for the session's character, in a folder it may write to (a subfolder's),
 *                                knows (its state) or administers (its deletion).
 *
 * And the folder window, since 2026-10-15 (web/src/ui/FolderWindow.svelte, after bookmarkContainerWindow.py): Create
 * Folder at the Locations window's bottom, and a folder's Edit Folder.
 *
 *   accessGroupBookmarkMgr.AddFolder         bookmarkSvc.CreateBookmarkFolder (426): AddFolder(isPersonal,
 *                                folderName, description, adminGroupID, manageGroupID, useGroupID, viewGroupID);
 *                                answered the folder, made the session's character's.
 *   accessGroupBookmarkMgr.UpdateFolder      bookmarkSvc.UpdateBookmarkFolder (441): UpdateFolder(folderID,
 *                                folderName, description, adminGroupID, manageGroupID, useGroupID, viewGroupID), a
 *                                personal folder of the session's character's or one it administers; answered its
 *                                access after.
 *
 * And a shared folder's Disconnect from Folder, since 2026-10-15 (bookmarksPanel.py ForgetFolder, after
 * ConfirmForgetFolder):
 *
 *   accessGroupBookmarkMgr.RemoveFromKnownFolders   bookmarkSvc.RemoveFromKnownFolders (460):
 *                                RemoveFromKnownFolders(folderID), the folder taken off those the session's
 *                                character knows; the folder itself stays.
 *
 * And bookmarks moved or copied into a folder or a subfolder, since 2026-10-15: dropped there in the Locations window
 * (bookmarksPanel.py DropInPlacesFolder; bookmarkSvc.MoveOrCopyBookmarks, 678 to 711), each source folder's at once:
 *
 *   accessGroupBookmarkMgr.MoveBookmarksToFolderAndSubfolder   (690): (oldFolderID, folderID, subfolderID,
 *                                bookmarks), the bookmarks a set; answered the rows moved and a message or None.
 *   accessGroupBookmarkMgr.CopyBookmarksToFolderAndSubfolder   (701): the same, for a copy (Shift held at the drop,
 *                                or a source folder the pilot may not move from); answered the new bookmarks by
 *                                number and a message or None.
 *                                Both for the session's character, from a folder it may read into one it may use.
 *
 * And a folder the pilot does not know added to those it knows, since 2026-10-15: Add Folder in the Locations
 * window's Folders with Admin Access (bookmarksPanel.py ShowMenuAdminFolders, then LinkedBookmarkFolderWindow's Add
 * Folder):
 *
 *   accessGroupBookmarkMgr.AddToKnownFolders   bookmarkSvc.AddToKnownFolders (357): AddToKnownFolders(folderID,
 *                                isActive), online or offline; answered the folder, its bookmarks and its subfolders,
 *                                for the session's character and a folder it may see.
 *
 * And an Abyssal filament used, since 2026-10-15 (web/src/ui/KeyActivationWindow.svelte, after keyActivationWindow.py):
 *
 *   abyssalMgr.AbyssalEntranceDeployment   abyssal_service.deploy_entrance_gate (51 to 54):
 *                                AbyssalEntranceDeployment(item_id, game_mode_id), by the service's name, the
 *                                filament and the game mode; the server takes only a filament of the session's
 *                                character's, in its ship (INVALID_OWNER, KEY_NOT_FOUND). Solo's is a session change
 *                                (PAGE_PLACE_CHANGE_CALLS, below).
 *
 * And a gate activated, since 2026-10-16 (web/src/bridge/gateActivation.ts, the menu's Activate Gate):
 *
 *   abyssalMgr.AbyssalGateActivation   movementFunctions.RealActivateAbyssalGate (569): (itemID,
 *                                violateSafetyTimer=True), a pocket's Transfer Conduit, the session's ship to the next
 *                                room; the server takes only a conduit of the session's own run.
 *   abyssalMgr.AbyssalEndGateActivation   RealActivateAbyssalEndGate (579): (itemID), the last room's conduit out, the
 *                                session back into known space (PAGE_PLACE_CHANGE_CALLS, below).
 *   keeper.ActivateAccelerationGate   RealActivateAccelerationGate (553): (itemID, violateSafetyTimer=1), an
 *                                acceleration gate within 2,500 m of the session's ship, which it warps on.
 *
 * And a trace jumped through, since 2026-10-16 (its jump window, ui/KeyActivationWindow.svelte as AbyssJumpWindow.py's):
 *
 *   abyssalMgr.AbyssalEntranceGateActivation   abyssal_service.activate_entrance_gate (56 to 59): (item_id), the
 *                                trace, the session into its pocket (PAGE_PLACE_CHANGE_CALLS, below); the server
 *                                takes only a trace the session's fleet may enter.
 *
 * And a saved fitting deleted, since 2026-10-16 (the fitting window's browser, its menu's Delete Fitting):
 *
 *   charFittingMgr.DeleteFitting   fittingSvc.DeleteFitting (433 to 439): (ownerID, fittingID), on the owner's fitting
 *                                manager, the pilot's own for a fitting of its own; the server refuses an owner the
 *                                session may not change (charFittingMgrService assertSessionCanMutateOwner).
 *   charFittingMgr.UpdateNameAndDescription   fittingSvc.ChangeNameAndDescription (710 to 724), the fitting
 *                                display's Save: (fittingID, ownerID, name, description), on the pilot's own fitting
 *                                manager for a fitting of its own; the server refuses an owner the session may not
 *                                change, as above.
 *   charFittingMgr.SaveFitting, UpdateFitting   fittingSvc.PersistFitting (268 to 313), the fitting display's Save of
 *                                a fitting not saved yet (Save Fit As): (ownerID, fitting), and the second with the
 *                                fitting's number by keyword, on the pilot's own fitting manager; the server refuses an
 *                                owner the session may not change, as above.
 *   corpFittingMgr.SaveFitting, UpdateFitting, UpdateNameAndDescription
 *   allianceFittingMgr.SaveFitting, UpdateFitting, UpdateNameAndDescription
 *                                the same, on the corporation's and the alliance's fitting managers (the fitting
 *                                display's Save for Corporation and Save for Alliance, fittingMgmtCont.SaveForOwner);
 *                                the server refuses them without the fitting manager's role, and the alliance's
 *                                to any corporation but its executor (fittingStore assertSessionCanMutateOwner).
 *   corpFittingMgr.DeleteFitting, allianceFittingMgr.DeleteFitting
 *                                fittingSvc.DeleteFitting (433 to 439) of the corporation's or the alliance's fitting,
 *                                where fittingUtil.CanDeleteFit lets the pilot (its role, its corporation the
 *                                alliance's executor); the server refuses the same, as above.
 *   charFittingMgr.DeleteManyFittings, corpFittingMgr.DeleteManyFittings, allianceFittingMgr.DeleteManyFittings
 *                                fittingSvc.DeleteManyFittings (441 to 460), the browser's Delete Fitting with many
 *                                selected: (ownerID, fittingIDs), on each owner's fitting manager, for the fittings
 *                                fittingUtil.GetDeletableNodes lets go; the server refuses an owner the session may
 *                                not change, as above.
 * And Redeem Items: the redeem window's claim of what the account may redeem (web/src/bridge/redeemWrites.ts), for
 * the session's own character, to the station it is docked in or its home station:
 *
 *   userSvc.ClaimRedeemTokens    redeemsvc.py ClaimRedeemTokens (103): ClaimRedeemTokens(tokens, charID,
 *                                useHomeStation=bool), the tokens a list of (tokenID, massTokenID); answered the
 *                                errors and what was made. The game port fetches the tokens afresh after it.
 *
 * And Daily Login Rewards: the day's claim of the account's login campaign (web/src/bridge/loginRewardWrites.ts):
 *
 *   loginCampaignManager.claim_reward   loginCampaignService.py claim_reward (199): claim_reward(), with nothing;
 *                                answered the reward and the progress after it, or None where nothing may be
 *                                claimed. The reward is a redeem token in the account's queue.
 *   seasonalLoginCampaignManager.claim_reward   seasonalLoginCampaignService.py claim_reward (84): claim_reward(), with
 *                                nothing; answered True or False. The day's alpha reward, and its omega reward for
 *                                an omega clone, are redeem tokens in the account's queue.
 *
 * And the Notepad: the pilot's own notes (web/src/ui/Notepad.svelte; neocom/notepad.py):
 *
 *   charMgr.AddOwnerNote      AddOwnerNote(label, note): a note of the pilot's own, "N:" a note, "S:" the notepad's
 *                                settings (its Folders); answered the new noteID.
 *   charMgr.EditOwnerNote     EditOwnerNote(noteID, label, note): that note written back (SaveNote, SetSetting).
 *   charMgr.RemoveOwnerNote   RemoveOwnerNote(noteID): that note gone (a folder's notes deleted, a setting's spare part).
 */
const PAGE_WRITE_PAIR_KEYS = Object.freeze([
  "charMgr.AddOwnerNote", "charMgr.EditOwnerNote", "charMgr.RemoveOwnerNote",
  "invCache.InvalidateLocationCache", "invbroker.EnterPassword", "trademgr.Add", "trademgr.MultiAdd", "trademgr.OfferMoney", "trademgr.MakeOffer", "trademgr.InitiateTrade", "trademgr.Abort", "account.GiveCashFromCorpAccount", "corpRegistry.InsertInvitation", "corpRegistry.UpdateApplicationOffer", "corpRegistry.SetAccountKey", "corpRegistry.AddCorporation", "corpRegistry.AddBulletin", "corpRegistry.UpdateTitles", "voteManager.InsertVote", "voteManager.InsertVoteCase", "corpRegistry.UpdateLogo", "corpRegistry.UpdateCorporationAbilities", "structureAssetSafety.MoveCorpAssetsToSafety", "structureAssetSafety.MoveSafetyWrapToStructure", "officeManager.TrashImpoundedOffice", "corpRegistry.UpdateMembers", "corpRecProxy.CreateRecruitmentAd", "corpRecProxy.DeleteRecruitmentAd", "corpRegistry.InsertApplication", "corpRecProxy.UpdateRecruitmentAd", "corpRegistry.SetCorpWelcomeMail", "corpRegistry.UpdateCorporation", "corpRegistry.DeclareWarAgainst", "mutualWarInviteMgr.SendInviteByPlayer", "warRegistry.CreateSurrenderNegotiation", "warRegistry.AcceptSurrender", "warRegistry.DeclineSurrender", "mutualWarInviteMgr.WithdrawInviteByPlayer", "mutualWarInviteMgr.RespondToInviteByPlayer", "mutualWarInviteMgr.SetInvitesBlockedByPlayer", "warRegistry.RetractMutualWar", "allianceRegistry.UpdateAlliance", "corpRegistry.CreateAlliance", "allianceRegistry.AddBulletin", "allianceRegistry.DeclareExecutorSupport", "corpRegistry.ApplyToJoinAlliance", "corpRegistry.DeleteAllianceApplication", "allianceRegistry.UpdateApplication", "allianceRegistry.DeleteMember", "corpRegistry.DeleteBulletin", "corpRegistry.UpdateBulletinOrder", "allianceRegistry.DeleteBulletin", "allianceRegistry.UpdateBulletinOrder", "warRegistry.SetOpenForAllies", "warRegistry.CreateWarAllyOffer", "warRegistry.RetractWarAllyOffer", "warRegistry.AcceptAllyNegotiation", "warRegistry.DeclineAllyOffer", "corporationSvc.CreateMedal", "corporationSvc.GiveMedalToCharacters", "XmppChatMgr.CreatePrivateChannel", "XmppChatMgr.AddCharacterToChannel", "allianceRegistry.AddAllianceContact", "allianceRegistry.EditAllianceContact", "allianceRegistry.RemoveAllianceContacts", "allianceRegistry.EditContactsRelationshipID", "allianceRegistry.CreateLabel", "allianceRegistry.EditLabel", "allianceRegistry.DeleteLabel", "allianceRegistry.AssignLabels", "allianceRegistry.RemoveLabels", "corpRegistry.UpdateMember", "corpRegistry.KickOutMember", "corpRegistry.KickOutMembers", "corpRegistry.ResignFromCEO", "corpRegistry.MoveCompanyShares", "corpRegistry.AddCorporateContact", "corpRegistry.EditCorporateContact", "corpRegistry.RemoveCorporateContacts", "corpRegistry.EditContactsRelationshipID", "corpRegistry.CreateLabel", "corpRegistry.EditLabel", "corpRegistry.DeleteLabel", "corpRegistry.AssignLabels", "corpRegistry.RemoveLabels", "skillHandler.AbortTraining", "skillHandler.SaveNewQueue", "skillHandler.ApplyFreeSkillPoints", "skillHandler.ApplyFreeSkillPointsToSkills", "skillHandler.PurchaseSkills", "dogmaIM.InjectSkillIntoBrain", "expertSystemMgr.RemoveMyExpertSystem", "crimewatch.SetSafetyLevel", "crimewatch.StartDuelChallenge", "crimewatch.RespondToDuelChallenge", "contractProxy.AcceptContract", "planetMgr.DeleteLaunch", "fleetProxy.ApplyToJoinFleet", "fleetMgr.BroadcastToBubble", "fleetMgr.AddToWatchlist", "fleetMgr.RemoveFromWatchlist", "dogmaIM.Overload", "dogmaIM.StopOverload", "dogmaIM.InitiateModuleRepair", "dogmaIM.StopModuleRepair", "dogmaIM.LinkAllWeapons", "dogmaIM.UnlinkAllModules", "dogmaIM.UnlinkModule", "dogmaIM.DestroyWeaponBank", "dogmaIM.LinkWeapons", "dogmaIM.MergeModuleGroups", "dogmaIM.OverloadRack", "dogmaIM.StopOverloadRack", "dogmaIM.InitiateModuleRepairMany", "dogmaIM.PeelAndLink", "dogmaIM.LoadAmmo", "dogmaIM.UnloadAmmo", "beyonce.CmdFleetTagTarget", "entity.CmdSalvage", "beyonce.CmdGotoPoint", "beyonce.CmdGotoDirection", "planetMgr.UserUpdateNetwork", "planetMgr.UserLaunchCommodities", "ship.LeaveShip", "dogmaIM.CreateNewbieShip", "officeManager.RentOffice", "officeManager.UnrentOffice", "slash.SlashCmd", "repairSvc.RepairItemsInStation", "repairSvc.RepairItemsInStructure", "fleetObjectHandler.LeaveFleet", "fleetObjectHandler.UpdateMemberInfo", "beyonce.CmdAlignTo", "beyonce.CmdFollowBall", "beyonce.CmdSetSpeedFraction", "beyonce.CmdOrbit", "beyonce.CmdStop", "fleetObjectHandler.CreateFleet", "fleetObjectHandler.AcceptInvite", "fleetObjectHandler.Invite", "fleetObjectHandler.RejectInvite", "beyonce.BookmarkLocation", "beyonce.BookmarkScanResult", "dogmaIM.AddTarget", "dogmaIM.RemoveTarget", "dogmaIM.CancelAddTarget", "ship.ScoopDrone", "industryManager.CompleteJob", "industryManager.CancelJob", "industryMonitor.ConnectJob", "industryMonitor.DisconnectJob", "industryManager.InstallJob", "beyonce.CmdWarpToStuff", "beyonce.CmdWarpToStuffAutopilot", "agentMgr.WarpToLocation", "dogmaIM.LaunchProbes", "scanMgr.RequestScans", "scanMgr.RecoverProbes", "scanMgr.ReconnectToLostProbes", "scanMgr.SetProbeDestination", "scanMgr.SetProbeRangeStep", "scanMgr.ConeScan", "dogmaIM.SetModuleOnline", "dogmaIM.TakeModuleOffline", "dogmaIM.Activate", "dogmaIM.Deactivate", "agentMgr.DoAction", "agentMgr.RemoveOfferFromJournal", "entity.CmdReconnectToDrones", "entity.CmdEngage", "entity.CmdMineRepeatedly", "entity.CmdReturnBay", "inSpaceCompressionMgr.CompressItemInSpace", "ship.Board", "invbroker.DestroyFitting", "mailMgr.SendMail", "ship.LaunchDrones", "reprocessingSvc.Reprocess", "structureDocking.Dock", "structureDocking.Undock", "marketProxy.CancelCharOrder", "marketProxy.PlaceBuyOrder", "marketProxy.PlaceMultiSellOrder", "marketProxy.BuyMultipleItems", "marketProxy.ModifyCharOrder", "ship.Jettison", "ship.AssembleShip", "ship.Undock", "beyonce.CmdDock", "beyonce.CmdStargateJump", "invbroker.Add", "invbroker.MultiAdd", "invbroker.ImportExportWithPlanet", "invbroker.MultiMerge", "invbroker.TrashItems", "invbroker.FitFitting", "invbroker.StackAll", "invbroker.SetLabel", "invbroker.AssembleCargoContainer", "mailMgr.MarkAsRead", "mailMgr.MarkAsUnread", "mailMgr.MoveToTrash", "mailMgr.MoveFromTrash", "mailMgr.DeleteMail", "mailMgr.MarkAllAsRead", "mailMgr.MarkAsReadByLabel", "mailMgr.MoveAllToTrash", "mailMgr.MoveToTrashByLabel", "mailMgr.MoveAllFromTrash", "mailMgr.EmptyTrash", "mailMgr.CreateLabel", "mailMgr.EditLabel", "mailMgr.DeleteLabel", "mailMgr.AssignLabels", "mailMgr.RemoveLabels", "mailingListsMgr.Create", "mailingListsMgr.Join", "mailingListsMgr.Leave", "mailMgr.MarkAsReadByList", "mailMgr.MoveToTrashByList", "mailingListsMgr.Delete", "mailingListsMgr.SetMembersClear", "mailingListsMgr.SetMembersMuted", "mailingListsMgr.SetMembersOperator", "mailingListsMgr.KickMembers", "mailingListsMgr.SetDefaultAccess", "mailingListsMgr.SetEntitiesAccess", "mailingListsMgr.ClearEntityAccess", "mailingListsMgr.SaveWelcomeMail", "mailingListsMgr.SendWelcomeMail", "mailingListsMgr.ClearWelcomeMail", "charMgr.AddContact", "charMgr.EditContact", "charMgr.DeleteContacts", "charMgr.BlockOwners", "charMgr.UnblockOwners", "charMgr.EditContactsRelationshipID", "charMgr.CreateLabel", "charMgr.EditLabel", "charMgr.DeleteLabel", "charMgr.AssignLabels", "charMgr.RemoveLabels", "notificationMgr.DeleteNotifications", "notificationMgr.MarkAsProcessed", "notificationMgr.MarkGroupAsProcessed", "notificationMgr.MarkAllAsProcessed", "notificationMgr.DeleteGroupNotifications", "notificationMgr.DeleteAllNotifications", "account.GiveCash", "charMgr.SaveCharacterSetting", "charMgr.DeleteCharacterSetting", "accessGroupBookmarkMgr.BookmarkStaticLocation", "accessGroupBookmarkMgr.UpdateBookmark", "accessGroupBookmarkMgr.DeleteBookmarks", "beyonce.CmdGotoBookmark", "accessGroupBookmarkMgr.CreateSubfolder", "accessGroupBookmarkMgr.UpdateSubfolder", "accessGroupBookmarkMgr.DeleteSubfolder", "accessGroupBookmarkMgr.UpdateKnownFolderState", "accessGroupBookmarkMgr.DeleteFolder", "accessGroupBookmarkMgr.AddFolder", "accessGroupBookmarkMgr.UpdateFolder", "accessGroupBookmarkMgr.RemoveFromKnownFolders", "accessGroupBookmarkMgr.MoveBookmarksToFolderAndSubfolder", "accessGroupBookmarkMgr.CopyBookmarksToFolderAndSubfolder", "accessGroupBookmarkMgr.AddToKnownFolders", "agentMgr.GotoLocation", "fleetObjectHandler.KickMember", "fleetObjectHandler.MakeLeader", "fleetObjectHandler.SendBroadcast", "fleetObjectHandler.MoveMember", "beyonce.CmdJumpToFleetModuleBeacon", "beyonce.CmdGroupJumpToFleetModuleBeacon", "beyonce.CmdBridgeToFleetModuleBeacon", "structureJumpBridgeMgr.CmdJumpThroughStructureStargate", "abyssalMgr.AbyssalEntranceDeployment", "abyssalMgr.AbyssalGateActivation", "abyssalMgr.AbyssalEndGateActivation", "keeper.ActivateAccelerationGate", "abyssalMgr.AbyssalEntranceGateActivation", "charFittingMgr.DeleteFitting", "charFittingMgr.UpdateNameAndDescription", "charFittingMgr.SaveFitting", "charFittingMgr.UpdateFitting", "ship.FitShips", "corpFittingMgr.SaveFitting", "corpFittingMgr.UpdateFitting", "corpFittingMgr.UpdateNameAndDescription", "allianceFittingMgr.SaveFitting", "allianceFittingMgr.UpdateFitting", "allianceFittingMgr.UpdateNameAndDescription", "corpFittingMgr.DeleteFitting", "allianceFittingMgr.DeleteFitting", "charFittingMgr.DeleteManyFittings", "corpFittingMgr.DeleteManyFittings", "allianceFittingMgr.DeleteManyFittings", "userSvc.ClaimRedeemTokens", "loginCampaignManager.claim_reward", "seasonalLoginCampaignManager.claim_reward"]);
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
 *   ship.Board                 menuFunctions.Board (190 to 209): PerformSessionChange('board', ship.Board, itemID,
 *                              session.shipid or session.stationid), docked or in space: the pilot in the ship it
 *                              names from then on, which the swap is held to (swapTargetOf), as its route held it.
 */
const PAGE_SHIP_SWAP_CALLS = Object.freeze(new Set(["ship.LeaveShip", "dogmaIM.CreateNewbieShip", "ship.Board"]));
for (const pair of PAGE_SHIP_SWAP_CALLS) {
  if (!pageWritePairKeySet.has(pair)) throw new Error(`${pair} is among the page's swaps of the pilot's ship and is none of its writes.`);
}

/** Whether this write of the page's puts the pilot in another ship. */
function swapsThePilotsShip(service, method) {
  return typeof service === "string" && typeof method === "string" && PAGE_SHIP_SWAP_CALLS.has(`${service}.${method}`);
}

/**
 * The ship a swap of the page's puts the pilot in, where the call names it: ship.Board's first argument. Null for
 * the others, which name none (the swap then waits for the pilot's ship to be another).
 */
function swapTargetOf(service, method, args) {
  if (service !== "ship" || method !== "Board" || !Array.isArray(args)) return null;
  const shipID = Number(args[0]);
  return Number.isSafeInteger(shipID) && shipID > 0 ? shipID : null;
}

/**
 * The page's own writes that take the pilot to another place, each by the kind of session change it is. The client
 * makes each through its session manager (sessionMgr.PerformSessionChange): not while another change is under way,
 * nor before the last one's timer has run, and the session is another one after it. That keeping is the client's
 * network layer's, which for a pilot of the page's is the BFF: so such a write is made under the BFF's keeping of
 * the change, as its route made it (src/server.js, dispatchPlaceChangeWrite): the change claimed, the call made
 * once, and answered once the pilot is usable in its new place; a timeout latched, so that nothing repeats it.
 *
 *   ship.Undock      ui/station/base.py _DoUndockAttempt (488 to 521): the session from a station into space.
 *                    (A ship boarded is the session's change too, 'board'; it is kept as a swap of the pilot's
 *                    ship, PAGE_SHIP_SWAP_CALLS, as its route kept it.)
 *   structureDocking.Undock   structureDocking.Undock (26 to 51): the session from a player structure into space,
 *                    the structure's own service, with the structure the pilot is docked in. Kept as a station's
 *                    undock is. Through the web gateway, whose list has no structureDocking, the ship's Undock is
 *                    asked in its place, which this server takes from a structure too.
 *   beyonce.CmdDock  movementFunctions.RealDock (503 to 518): the session from space into a station. A dock the
 *                    server takes and does not carry out answers nothing, so its keeping waits only a short while
 *                    and never latches, as its route's did. A structure is docked at by its own service, which the
 *                    page does not make yet.
 *   structureDocking.Dock   structureDocking.Dock (64 to 80): the session from space into a player structure, the
 *                    structure's own service once the ship is within 2,500 m. Kept as a station's dock is. Through
 *                    the web gateway, whose list has no structureDocking, the park's CmdDock of the structure is
 *                    asked, as the dock route asked it until 2026-10-14.
 *   beyonce.CmdStargateJump  gateJumpSvc.JumpThroughGate (98 to 127) and autopilot.py 358: the session from one
 *                    system into the next through a stargate. Its keeping binds the park again in the new system
 *                    before it answers, as its route's did (reparkAfterArrival).
 *   beyonce.CmdJumpToFleetModuleBeacon, beyonce.CmdGroupJumpToFleetModuleBeacon  cynoTravelSvc.py 30 to 37 and 97 to
 *                    104: the session from one system into a fleet member's cyno's, by the ship's jump drive. Kept
 *                    as a stargate's jump is, into the beacon's system (a cyno).
 *   structureJumpBridgeMgr.CmdJumpThroughStructureStargate  autopilot.py 349 and menusvc.py 2106: the session from one
 *                    system into the next through an Ansiblex jump gate, by the service's name with the Ansiblex. Kept
 *                    as a stargate's jump is (a bridge).
 *   abyssalMgr.AbyssalEntranceDeployment  keyActivationWindow.py 49 to 54: a filament's deploy, through
 *                    sessionMgr.PerformSessionChange('JumpToAbyss', ...) where its game mode jumps on deploy, which is
 *                    solo's alone (abyss/game_mode.py: should_jump_on_deploy); the others deploy a trace and the pilot
 *                    stays, no session change. Solo's is kept as a stargate's jump is, into the pocket (an abyss).
 *   abyssalMgr.AbyssalEndGateActivation  movementFunctions.RealActivateAbyssalEndGate (578 to 580): the last room's
 *                    conduit out, through PerformSessionChange('abyssToKnownJump', ...), the session from the pocket
 *                    back into known space. Kept as a stargate's jump is (an abyss exit).
 *   abyssalMgr.AbyssalEntranceGateActivation  AbyssJumpWindow.py 37 to 40: a trace's jump, through
 *                    PerformSessionChange('JumpToAbyss', ...), the session into the trace's pocket. Kept as a stargate's
 *                    jump is (an abyss entrance).
 */
const PAGE_PLACE_CHANGE_CALLS = Object.freeze(new Map([["ship.Undock", "undock"], ["structureDocking.Undock", "undock"], ["beyonce.CmdDock", "dock"], ["structureDocking.Dock", "dock"], ["beyonce.CmdStargateJump", "stargate"], ["beyonce.CmdJumpToFleetModuleBeacon", "cyno"], ["beyonce.CmdGroupJumpToFleetModuleBeacon", "cyno"], ["structureJumpBridgeMgr.CmdJumpThroughStructureStargate", "bridge"], ["abyssalMgr.AbyssalEntranceDeployment", "abyss"], ["abyssalMgr.AbyssalEndGateActivation", "abyssExit"], ["abyssalMgr.AbyssalEntranceGateActivation", "abyssEntrance"]]));
for (const pair of PAGE_PLACE_CHANGE_CALLS.keys()) {
  if (!pageWritePairKeySet.has(pair)) throw new Error(`${pair} is among the page's changes of place and is none of its writes.`);
}

/**
 * The kind of session change this write of the page's is ("undock", "dock", "stargate"), or null for one that changes
 * no place. A filament's deploy is one for solo's game mode alone (GameModeID.SOLO, 1), which jumps on deploy.
 */
function placeChangeOf(service, method, args) {
  if (typeof service !== "string" || typeof method !== "string") return null;
  const kind = PAGE_PLACE_CHANGE_CALLS.get(`${service}.${method}`) ?? null;
  if (kind === "abyss") return Array.isArray(args) && Number(args[1]) === 1 ? kind : null;
  return kind;
}

/**
 * The page's own orders that send the ship after a thing, which the BFF makes as their routes made them
 * (src/server.js, followCall), since each of the two things turns on the pilot's transport:
 *
 *   held back    where the ship already flies the order. The client's menu sends nothing then
 *                (movementFunctions._IsAlreadyFollowingBallAtRange), going by its own ballpark, which for a
 *                pilot on the game port is the BFF's. Through the gateway nothing can say, and the order is sent.
 *   the throttle opened first, through the gateway, as its routes always did there. On the game port the menu's
 *                order goes alone, as the client sends it.
 *
 * Neither is done for the follow with no range, which is the autopilot's: it is sent whatever the ship is doing,
 * and the page opens its throttle itself, as the client's autopilot does.
 *
 *   beyonce.CmdFollowBall      the approach and keep at range.
 *   beyonce.CmdOrbit           the orbit. One of nought is an orbit like any other: both are done for it.
 */
const PAGE_FOLLOW_CALLS = Object.freeze(new Set(["beyonce.CmdFollowBall", "beyonce.CmdOrbit"]));
for (const pair of PAGE_FOLLOW_CALLS) {
  if (!pageWritePairKeySet.has(pair)) throw new Error(`${pair} is among the page's follows and is none of its writes.`);
}

/** Whether this write of the page's sends the ship after a thing. */
function ordersAFollow(service, method) {
  return typeof service === "string" && typeof method === "string" && PAGE_FOLLOW_CALLS.has(`${service}.${method}`);
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
 *   scanMgr.RequestScans,           "scanManager": the scanner's three WRITES on that same object (scanSvc.py 195,
 *   scanMgr.RecoverProbes,          341 and 279), each one of the page's own writes (above). Through the web
 *   scanMgr.ReconnectToLostProbes   gateway they go by the bind their routes went by (src/server.js,
 *                                   systemScanCall).
 *   scanMgr.SetProbeDestination,    "scanManager" too, the same way; the game port's transport answers them itself.
 *   scanMgr.SetProbeRangeStep
 *   scanMgr.ConeScan                "scanManager" too: the directional scanner's sweep, a page write (above).
 *   charMgr.ListStations            "assets": a READ, the stations that hold something of the pilot's
 *                                   (invCache.py 833, for the assets window). The object is the pilot's own
 *                                   global container, Moniker('charMgr', (session.charid, const.containerGlobal)),
 *                                   which the BFF binds for the pilot it holds: there is nothing to say which,
 *                                   and a call that says is none. The handler takes nothing from the caller and
 *                                   lists the things of the session's own character (src/server.js,
 *                                   globalAssetsCall).
 *   charMgr.ListStationItems        "assets": a READ, what of the pilot's is at one station (invCache.py 849,
 *                                   for the assets window), on the same container. The handler lists the
 *                                   things of the session's own character and picks those at the station
 *                                   sent: a station names nothing of another's.
 *   charMgr.ListIncludingContainers "assets": a READ, everything of the pilot's, containers' contents too
 *                                   (invCache.py 880, for the assets window's search), on the same container,
 *                                   with nothing sent. The handler lists the session's own character's things.
 *   fleetObjectHandler.LeaveFleet   "fleet": a WRITE, the pilot's fleet left (fleetSvc.LeaveFleet, 365 to 371). The
 *                                   object is the fleet service's self.fleet: what CreateFleet answered, or the
 *                                   Moniker that accepted an invite. A session is in one fleet, so the call names
 *                                   none. Where the pilot's connection holds no such object the client asks
 *                                   fleetMgr's ForceLeaveFleet by name instead, and so does the BFF in this
 *                                   call's place: only it knows which the connection holds (src/server.js,
 *                                   leaveFleetCall).
 *   fleetObjectHandler.KickMember   "fleet": a WRITE, a member kicked (fleetSvc.KickMember, 607 to 612:
 *                                   self.fleet.KickMember(charID), from the fleet's menu for a member,
 *                                   menusvc.py FleetMenu, once its Confirm is chosen), on the fleet's own
 *                                   object, from the address book's character menu since 2026-10-15. The server
 *                                   takes the session's fleet and the member named, and refuses a pilot who is no
 *                                   commander over that member (FleetNotCommanderOrBoss).
 *   fleetObjectHandler.MakeLeader   "fleet": a WRITE, the fleet's boss handed on (fleetSvc.MakeLeader, 601 to
 *                                   605: self.fleet.MakeLeader(charID), once ConfirmMakeFleetBoss is answered
 *                                   yes), on the same object. The server refuses a pilot who is not the fleet's
 *                                   boss (FleetNotCreator).
 *   fleetObjectHandler.MoveMember   "fleet": a WRITE, a member given another place (fleetSvc.MoveMember, 513 to 520:
 *                                   self.fleet.MoveMember(charID, wingID, squadID, role), from the fleet's menu for
 *                                   a member, Move Fleet Member, evefleet.client.MemberMenu), on the same object,
 *                                   since 2026-10-15. The server takes the session's fleet and refuses a move the
 *                                   pilot's command does not allow.
 *   fleetObjectHandler.SendBroadcast  "fleet": a WRITE, a broadcast to the whole fleet (fleetSvc.SendGlobalBroadcast,
 *                                   983 to 990: self.fleet.SendBroadcast(name, self.broadcastScope, itemID,
 *                                   typeID), after the client's own checks and wait), on the same object: from
 *                                   the fleet's menu for the pilot's own, Broadcast Travel To Me, since
 *                                   2026-10-15. The server takes the session's fleet and sends OnFleetBroadcast to
 *                                   the members the scope reaches; it keeps the same wait itself.
 *   fleetObjectHandler.CreateFleet  "fleet": a WRITE, a fleet formed (fleetSvc.CreateFleet, 331 to 342). The
 *                                   client asks it of the handler by name, with nothing, and what it answers is
 *                                   the fleet's own object, on which it then asks Init and reads the fleet. The
 *                                   page cannot hold that object, and a session forms one fleet: so the call
 *                                   names none, and the BFF makes it and the Init on what it answered, as its
 *                                   route did (src/server.js, createFleetCall).
 *
 * And one on a fleet the call names by the fleet's number, which is not the session's own:
 *
 *   fleetObjectHandler.AcceptInvite "fleetByNumber": a WRITE, an invitation accepted (fleetSvc.OnFleetInvite,
 *                                   1168 to 1195): GetFleet(fleetID).AcceptInvite(shipTypeID), on a Moniker
 *                                   for the fleet the invitation named, which the page was told and says
 *                                   with `of`. The bind selects a fleet and proves nothing: the handler
 *                                   accepts only a real invitation for the session's own character. The
 *                                   ship's type is not the page's to say (src/server.js,
 *                                   acceptFleetInviteCall).
 *   fleetObjectHandler.RejectInvite "fleetByNumber": a WRITE, an invitation turned down (the same, 1180, 1184
 *                                   and 1198): RejectInvite(True), RejectInvite(False) or RejectInvite() on
 *                                   that same Moniker. The word is the page's to say, or none
 *                                   (src/server.js, rejectFleetInviteCall).
 *
 * And one on the pilot's own fleet, which the call may say the number of all the same:
 *
 *   fleetObjectHandler.Invite       "fleetExpected": a WRITE, a pilot invited (fleetSvc.Invite, 351 to 363):
 *                                   self.fleet.Invite(charID, wingID, squadID, role), on the fleet's own
 *                                   object. With no `of` it is made on the session's own fleet. With one, on
 *                                   the object bound by that number, as the route's `expectedFleetID` had it:
 *                                   the server's check of the inviter runs against that fleet, so that an
 *                                   invitation held back in the lane cannot follow its pilot into another
 *                                   (src/server.js, inviteToFleetCall).
 *
 * And one on an agent's own object, of which there are many: the call says which agent.
 *
 *   agentMgr.WarpToLocation         "agent": a WRITE, the ship warped to a mission's marked spot
 *                                   (movementFunctions.WarpToBookmark, 414 to 416):
 *                                   GetAgentMoniker(agentID).WarpToLocation(locationType, locationNumber,
 *                                   warpRange, fleet, referringAgentID, formation settings). The server's
 *                                   handler (agentMgrService.Handle_WarpToLocation, read to its closing brace,
 *                                   and resolveMissionLocationTarget) takes the type, the range and the other
 *                                   agent of the caller, and the agent the object was bound for: it finds the
 *                                   session's own character's mission with that agent, or that agent's base,
 *                                   and flies the session's own ship there. It answers nothing either way.
 *   agentMgr.GotoLocation           "agent": a WRITE, the ship sent to a mission's marked spot (Approach Location,
 *                                   movementFunctions.ApproachLocation, 397 to 407):
 *                                   GetAgentMoniker(agentID).GotoLocation(locationType, locationNumber,
 *                                   referringAgentID), from the Locations window's Agent Missions since
 *                                   2026-10-15. The server's handler (agentMgrService.Handle_GotoLocation) takes
 *                                   the type and the other agent of the caller and the agent the object was bound
 *                                   for, finds the session's own character's mission's spot, and flies the
 *                                   session's own ship after it or to its point. It answers nothing.
 *   agentMgr.DoAction               "agent": a WRITE, what is said to an agent (agentDialogueWindow.py 427 to
 *                                   428): GetAgentMoniker(agentID).DoAction(actionID). The handler answers for
 *                                   the session's own character with the agent the object was bound for, and
 *                                   takes the action's number of the caller.
 *   agentMgr.RemoveOfferFromJournal "agent": a WRITE, an offer taken out of the journal (agents.py 782 to 784), on
 *                                   the same object, with nothing: the session's own character's offer from
 *                                   that agent.
 *
 * And one on an inventory's own object, of which there are many: the call says which.
 *
 *   invbroker.Add                   "inventory": a WRITE, a thing moved into an inventory (a module fitted or
 *                                   unfitted: clientDogmaLocation.py 669 to 673, fittingSlotController.py 217 to
 *                                   243). The client asks an inventory by the thing it is of,
 *                                   invCache.GetInventoryFromId(itemID), or by const.containerHangar for the
 *                                   hangar of where it is docked: `of` is a thing's number, or "hangar". The
 *                                   BFF binds it as its routes bound it, and reads the pilot's place again
 *                                   before the write as it does for every inventory write (src/server.js,
 *                                   inventoryCall and boundCall). The server's handler
 *                                   (invBrokerService.Handle_Add) takes the item, the place it is said to lie
 *                                   in and the flag of the caller: asked live on 2026-10-13 for a stack that
 *                                   was another pilot's, in the hangar of the station both were docked in, it
 *                                   refused (FakeItemNotFound) and moved nothing.
 *   invbroker.MultiAdd              "inventory": a WRITE, things moved into an inventory together (a module
 *                                   fitted to no slot of the ship's: fittingUtil.py 157, tryFit.py 135). Its
 *                                   handler (Handle_MultiAdd) moves each item by the same path as Add's, and
 *                                   with it the same check of whose the item is (read, not asked live:
 *                                   _moveSourceItemToDestination and _ensureInventoryCustodyTransferAccess).
 *   invbroker.ImportExportWithPlanet  "inventory": a WRITE, a launchpad's goods sent up into the customs
 *                                   office whose inventory it is (importExportUI.py 549). Its handler takes
 *                                   the colony from the session's own character and the pin, checks the office
 *                                   is that colony's planet's and charges the session's own wallet (read
 *                                   2026-10-09, at the route's making); a rate that is not the office's is
 *                                   refused, TaxChanged.
 *   invbroker.MultiMerge            "inventory": a WRITE, one stack merged into another in the inventory the
 *                                   target lies in (item.py's drop, invCache.py 1124). Its handler
 *                                   (Handle_MultiMerge, read 2026-10-13) moves nothing of a stack in a hangar
 *                                   that is not the session's own character's, holds a ship's or a container's
 *                                   inventory to whose it is, and takes a stack from elsewhere by Add's rules.
 *
 * And one on the inventory manager of where the pilot is, which the call does not name (eveMoniker.GetInventoryMgr:
 * the solar system's where the session has one, else the station's):
 *
 *   reprocessingSvc.Reprocess       "refinery", on the refinery of where the pilot is docked, which the call
 *                                   does not name (Moniker('reprocessingSvc', session.structureid or
 *                                   session.stationid)): a WRITE, items reprocessed (itemReprocessor.py 71), one
 *                                   call for each place they lie in. Its handler takes the session's own items
 *                                   and charges the station's tax; the BFF asks a structure's hangar access first,
 *                                   as the route asked it (since 2026-10-14; until then POST
 *                                   /api/bridge/reprocessing/reprocess).
 *   invbroker.TrashItems            "inventoryManager": a WRITE, items destroyed (invItemFunctions.py 618). Its
 *                                   handler (invBroker/trash.js, read 2026-10-13) destroys only the session's
 *                                   own character's items, or a director's corporation items in the office
 *                                   here, never the ship the pilot is in, a fitted module or a thing in space,
 *                                   all of one owner; it answers None, or its refusals.
 *   invbroker.SetLabel              "inventoryManager": a WRITE, an item named (menuFunctions.SetName, 343: a ship's
 *                                   Change Name, the name asked in the ship naming window). Its handler names only
 *                                   the session's own character's items, or a corporation's container in a hangar
 *                                   its roles may take from, and tells the session the name (OnCfgDataChanged).
 *   invbroker.AssembleCargoContainer "inventoryManager": a WRITE, a packaged container assembled (menusvc
 *                                   AssembleContainer, 3561 to 3564: AssembleCargoContainer(itemID, None, 0.0); the
 *                                   item's double click, item.py 838 and 839). Its handler (invBroker/packaging.js,
 *                                   read 2026-10-18) assembles only the session's own character's container in the
 *                                   hangar where it is docked or in the cargo of its own ship there, or a
 *                                   corporation's in a hangar its roles may take from; elsewhere it answers None.
 *
 * A write among them is one of the page's own writes. A read is listed here only once its handler has been read
 * for what it takes from the caller: a planet's reads once answered with another owner's colony.
 */
// Native invCacheContainer.GetItem calls GetSelfInvItem on this inventory.
const PAGE_OBJECT_CALLS = Object.freeze({ "invbroker.EnterPassword": "inventory", "invbroker.GetSelfInvItem": "inventory", "invbroker.GetPriceForItems": "inventory", "trademgr.Add": "trade", "trademgr.MultiAdd": "trade", "trademgr.OfferMoney": "trade", "trademgr.MakeOffer": "trade", "trademgr.List": "trade", "trademgr.Abort": "trade", "account.GiveCashFromCorpAccount": "corporationExpected", "corpRegistry.InsertInvitation": "corporationExpected", "corpRegistry.UpdateApplicationOffer": "corporationExpected", "corpRegistry.SetAccountKey": "corporationExpected", "corporationSvc.CreateMedal": "corporationExpected", "corporationSvc.GiveMedalToCharacters": "corporationExpected", "corpRegistry.KickOutMember": "corporationExpected", "corpRegistry.KickOutMembers": "corporationExpected", "corpRegistry.ResignFromCEO": "corporationExpected", "planetMgr.UserUpdateNetwork": "planet", "planetMgr.UserLaunchCommodities": "planet", "planetMgr.GetProgramResultInfo": "planet", "scanMgr.GetFullState": "scanManager", "scanMgr.RequestScans": "scanManager", "scanMgr.RecoverProbes": "scanManager", "scanMgr.ReconnectToLostProbes": "scanManager", "scanMgr.SetProbeDestination": "scanManager", "scanMgr.SetProbeRangeStep": "scanManager", "scanMgr.ConeScan": "scanManager", "agentMgr.WarpToLocation": "agent", "agentMgr.GotoLocation": "agent", "agentMgr.DoAction": "agent", "agentMgr.RemoveOfferFromJournal": "agent", "invbroker.Add": "inventory", "invbroker.MultiAdd": "inventory", "invbroker.ImportExportWithPlanet": "inventory", "invbroker.MultiMerge": "inventory", "invbroker.TrashItems": "inventoryManager", "invbroker.SetLabel": "inventoryManager", "invbroker.AssembleCargoContainer": "inventoryManager", "invbroker.FitFitting": "inventory", "invbroker.StackAll": "inventory", "invbroker.List": "inventory", "invbroker.DestroyFitting": "inventory", "reprocessingSvc.Reprocess": "refinery", "charMgr.ListStations": "assets", "charMgr.ListStationItems": "assets", "charMgr.ListIncludingContainers": "assets", "fleetObjectHandler.LeaveFleet": "fleet", "fleetObjectHandler.UpdateMemberInfo": "fleet", "fleetObjectHandler.KickMember": "fleet", "fleetObjectHandler.MakeLeader": "fleet", "fleetObjectHandler.SendBroadcast": "fleet", "fleetObjectHandler.MoveMember": "fleet", "fleetObjectHandler.CreateFleet": "fleet", "fleetObjectHandler.AcceptInvite": "fleetByNumber", "fleetObjectHandler.Invite": "fleetExpected", "fleetObjectHandler.RejectInvite": "fleetByNumber", "warStatisticMgr.GetBaseInfo": "war", "warStatisticMgr.GetKills": "war", "warStatisticMgr.GetKillsByGroup": "war", "officeManager.TrashImpoundedOffice": "officeAt" });
/**
 * The objects there are many of, which a call says which of with `of`: a planet, a fleet that is not the
 * session's own (the one an invitation names), an agent, and an inventory (a thing's own, or the hangar's). A
 * scan manager and the pilot's own fleet are the session's. Corporation awards/departure/expulsion
 * names its originating corporation too, so an old pending action cannot affect a new corporation.
 */
// (An office's object: Moniker('officeManager', stationID), a station the call names - officeManager.TrashImpoundAtStation.)
const OBJECTS_THE_PAGE_NAMES = Object.freeze(new Set(["planet", "fleetByNumber", "agent", "inventory", "corporationExpected", "trade", "war", "officeAt"]));
/**
 * The objects the session has one of that a call may say the number of all the same, to be held to it: the
 * pilot's own fleet, where the invitation is to that fleet and no other. With no `of` it is the session's own.
 */
const OBJECTS_THE_PAGE_MAY_NAME = Object.freeze(new Set(["fleetExpected"]));
for (const pair of Object.keys(PAGE_OBJECT_CALLS)) {
  if (bridgeWritePairKeySet.has(pair) && !pageWritePairKeySet.has(pair)) throw new Error(`${pair} is among the page's calls on an object, is a write, and is none of the page's writes.`);
}

/** What the object of this call of the page's is (including an originating corporation registry), or null where it is made on none. */
function objectOfPageCall(service, method) {
  if (typeof service !== "string" || typeof method !== "string") return null;
  // (A pair has a full stop in it, and nothing an object has of itself is named so.)
  return PAGE_OBJECT_CALLS[`${service}.${method}`] ?? null;
}

/**
 * The page's own calls that the web gateway's list has under another name. The page asks as the client asks; the
 * game port makes the client's call; and through the gateway the same is asked by the one name its list has.
 *
 *   repairSvc.RepairItemsInStation, RepairItemsInStructure   RepairItems, the server's own name for both: it looks
 *       at where the session is docked and does the one or the other, with the same arguments.
 */
const GATEWAYS_NAMES = Object.freeze({ "repairSvc.RepairItemsInStation": "RepairItems", "repairSvc.RepairItemsInStructure": "RepairItems" });

/** The name a call of the page's goes by through the web gateway: its own, but for the few its list has otherwise. */
function gatewaysNameFor(service, method) {
  return (typeof service === "string" && typeof method === "string" && Object.hasOwn(GATEWAYS_NAMES, `${service}.${method}`))
    ? GATEWAYS_NAMES[`${service}.${method}`]
    : method;
}

/** Whether a call on an object of this kind says which one, with `of`. */
function pageNamesTheObject(kind) {
  return OBJECTS_THE_PAGE_NAMES.has(kind);
}

/** Whether a call on an object of this kind may say which one with `of`, and need not. */
function pageMayNameTheObject(kind) {
  return OBJECTS_THE_PAGE_MAY_NAME.has(kind);
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
  PAGE_FOLLOW_CALLS,
  PAGE_OBJECT_CALLS,
  PAGE_PLACE_CHANGE_CALLS,
  PAGE_SHIP_SWAP_CALLS,
  PAGE_WRITE_PAIR_KEYS,
  PLUMBING_SWEEP_WRITE_METHODS,
  PLUMBING_SWEEP_WRITE_PAIR_KEYS,
  SAFE_BROWSER_SESSION_FIELDS,
  gatewaysNameFor,
  isBridgeWritePair,
  isPageWritePair,
  objectOfPageCall,
  ordersAFollow,
  pageMayNameTheObject,
  pageNamesTheObject,
  pickSafeBrowserSessionFields,
  placeChangeOf,
  swapsThePilotsShip,
  swapTargetOf,
};
