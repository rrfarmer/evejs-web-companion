import assert from "node:assert/strict";
import test from "node:test";
import { listCivilianHosted, listVerifiedOperationPilots, listWorkspaceOperationPilots, openDefaultFarmerAccount, openRegisteredFarmerAccount } from "./api.ts";
import { authenticatedJson, farmerAccounts, installPageContext, matchAccountName, ownerOptions, runHosted, UocRequestError, workspaceAccounts } from "./context.ts";
import type { Session } from "../../../../web/src/plugin-api/index.ts";
import { createTrainingAccountPass } from "../../training/accountPass.ts";
import type { AuthenticatedAccount } from "./context.ts";
import type { UocBackendRequest } from "../../shared/backendScope.ts";
import { listCombatOperations } from "../adapters/combat.ts";
import { loadMiningOperations } from "../adapters/mining.ts";
import { centerRoster, centerReview } from "../adapters/provisioning.ts";
import { installTrainingAdapter } from "../adapters/training.ts";
import { readFactoryAccount } from "../training/factoryClient.ts";
import { createMiningOperationRoutes } from "../../operations/miningRoutes.ts";
import { rememberCharacters, setKnownCharacterStorage } from "../../../../web/src/app/knownCharacters.ts";

const worldID = "a".repeat(64);
const policy = { maxRuntimeMinutes: 120, defaultRuntimeMinutes: 60, durationChoices: [60, 120] };
const fleet = {
  operationID: "saved-fleet", name: "1st Mining Fleet (restart)", revision: 2,
  createdAt: "2026-11-12", updatedAt: "2026-11-12",
  area: { anchorSystemID: 300, anchorSystemName: "Sibot", reach: "CURRENT_SYSTEM", targetClasses: ["BELT"] },
  targetPolicy: "ANY_ELIGIBLE", unloadPolicy: "SELF_UNLOAD", unloadDestination: { stationID: 600, stationName: "Home", corporationDivision: null },
  members: Array.from({length: 9}, (_, i) => ({
    characterID: 100 + i, characterName: "Pilot " + i, accountName: "Actor" + i, role: "MINER", automationID: "",
  })),
};

test("all five centers use verified Farmer accounts and MCC shows shared definitions in a fresh tab", async () => {
  const owner = {accountID: 17, username: "CorpHR"}, other = {accountID: 18, username: "ActivePilot"};
  const key = "mining-definitions:" + JSON.stringify([worldID]);
  const snapshot = {version: 1, definitions: [structuredClone(fleet)]};
  const mining = createMiningOperationRoutes({
    document: name => ({read: () => name === key ? snapshot : null, write: () => assert.fail("Saved definitions are read-only")}),
    getWorldScope: () => worldID, isOperationActive: () => false,
  });
  const calls: Array<{path: string; user: string}> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input), "http://fixture");
    const token = new Headers(init?.headers).get("authorization");
    const account = token === "Bearer account-only" ? owner : token === "Bearer cockpit" ? other : null;
    assert.ok(account, "A verified Farmer token is required");
    const prefix = "/api/plugins/uoc", p = url.pathname;
    assert.equal(init?.method, "GET", "Opening a center or picking a pilot must be passive");
    calls.push({path:p, user:account.username});
    const characters = [{characterID: account.accountID, name: account.username + " Pilot", corporationID: 77}];
    if(p === prefix + "/center/account") return Response.json({ok:true,account,worldID});
    if(p === "/api/pilot-training/characters") return Response.json({ok:true,account:account.username,characters});
    if(p === "/api/bots") return Response.json({ok:true,bots:[],hostedRunPolicy:policy});
    if(p === "/api/plugins/uoc/world") return Response.json({ok:true,worldID});
    if(p === "/api/pilot-training/ownership") return Response.json({ownership:{characterID:account.accountID,online:account===other,owner:account===other?"BROWSER":"OFF"}});
    if(p === prefix + "/provisioning/17/service") return Response.json({available:false});
    if(p === "/api/ship-provisioning/review") return Response.json({definitions:{status:"READY",providerCharacterID:17,corporationID:77,contracts:[]},pendingNative:[]});
    if(p === prefix + "/combat-operations") return Response.json({operations:[],hostedRunPolicy:policy});
    if(p === prefix + "/civilian/checkpoints") return Response.json({history:[],recovery:[]});
    if(p === prefix + "/logistics") return Response.json({operations:[],roster:[]});
    if(p === prefix + "/mining-operations/saved-fleet/launch") return Response.json({receipt:null});
    if(p === prefix + "/mining-operations"){
      const reply = await mining["GET /mining-operations"]!({account,worldID,method:"GET",path:p,params:{},query:{},body:null} as UocBackendRequest);
      return Response.json(reply.body,{status:reply.status??200});
    }
    assert.fail("Unexpected request " + p);
  };
  const cockpit = { token: "cockpit", fetch: fetcher };
  const session = {
    store:{get:()=>({session:{username:other.username}, station:{online:{characterID:18}}})},
    flow:{sessionToken:()=>cockpit.token,requestOptions:()=>cockpit},
  } as unknown as Session;
  const pass = createTrainingAccountPass(async () => assert.fail("Existing authorizations must win over account sign-in"));
  installPageContext({ sessions:[session], readAccounts:()=>[{...owner, options:{token:"account-only",fetch:fetcher}}], accountPass:pass });
  installTrainingAdapter({authenticatedJson,runHosted});
  try {
    assert.deepEqual(farmerAccounts(), ["ActivePilot","CorpHR"]);
    assert.equal((await openDefaultFarmerAccount())?.account, "ActivePilot");
    assert.equal((await openDefaultFarmerAccount("CorpHR"))?.account, "CorpHR");
    assert.equal((await openDefaultFarmerAccount("ExpiredPreference"))?.account, "ActivePilot");
    const workspace = await listWorkspaceOperationPilots();
    assert.deepEqual(workspace.errors, []);
    assert.deepEqual(workspace.pilots.map(row => [row.accountName, row.characterID, row.availability]),
      [["ActivePilot", 18, "WC_SESSION"], ["CorpHR", 17, "AVAILABLE"]]);
    const current = await openRegisteredFarmerAccount(other.username);
    assert.deepEqual((await loadMiningOperations(current.options)).operations[0]?.definition,fleet);
    assert.equal((await listVerifiedOperationPilots(other.username))[0]?.availability,"WC_SESSION");
    // Historical owner spelling is a lookup key. The verified token keeps canonical identity.
    const original = await openRegisteredFarmerAccount("corphr");
    assert.equal(original.account,"CorpHR");
    const loaded = await loadMiningOperations(original.options);
    assert.deepEqual(loaded.operations[0]?.definition,fleet);
    assert.deepEqual(snapshot.definitions,[fleet]);
    assert.equal((await listVerifiedOperationPilots(original.account))[0]?.characterID,17);
    assert.equal((await listCombatOperations(original.options)).hostedRunPolicy?.maxRuntimeMinutes,120);
    assert.equal((await readFactoryAccount(original.account)).characters[0]?.characterID,17);
    assert.equal((await centerRoster(original.options.token)).pilots[0]?.characterID,17);
    const selected = await centerReview(original.options.token,{characterID:17,providerCharacterID:17,fittingID:0,sourceKind:"hangar",corporationID:77,division:1});
    assert.equal(selected.applyReview.canApply,false);
    assert.deepEqual((await listCivilianHosted(original.options)).bots,[]);
    assert.deepEqual(await authenticatedJson("/api/plugins/uoc/logistics", await ownerOptions(original.account)),{operations:[],roster:[]});
    // A fresh tab can enter MCC with only a different verified account and no Cockpit session.
    installPageContext({readAccounts:()=>[{...other,options:{token:"cockpit",fetch:fetcher}}]});
    const tab = await openDefaultFarmerAccount();
    assert.ok(tab);
    assert.deepEqual((await loadMiningOperations(tab.options)).operations[0]?.definition,fleet);
    assert.deepEqual(calls.filter(row=>row.path==="/api/plugins/uoc/mining-operations").map(row=>row.user),["ActivePilot","CorpHR","ActivePilot"]);
  } finally {
    installTrainingAdapter(null);
    installPageContext({});
  }
});

test("expired and missing authority return Pilot Hangar guidance, with no login or foreign fallback", async () => {
  const calls: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    assert.equal(String(input), "/api/plugins/uoc/center/account");
    const header = new Headers(init?.headers).get("authorization")!;
    calls.push(header);
    if(header === "Bearer new") return Response.json({account:{accountID:1,username:"CorpHR"},worldID});
    return Response.json({ok:false,error:"AUTH_REQUIRED"},{status:401});
  };
  let accounts: AuthenticatedAccount[] = [
    {accountID:1,username:"CorpHR",options:{token:"expired",fetch:fetcher}},
    {accountID:2,username:"Other",options:{token:"unrelated",fetch:fetcher}},
  ];
  installPageContext({readAccounts:()=>accounts});
  try {
    await assert.rejects(openRegisteredFarmerAccount("CorpHR"), (error:unknown) =>
      error instanceof UocRequestError && error.status===401 && /No saved WC account/.test(error.message));
    assert.deepEqual(farmerAccounts(),["Other"]);
    await assert.rejects(openRegisteredFarmerAccount("KnownOnly"),/No saved WC account/);
    assert.deepEqual(calls,["Bearer expired"]);
    accounts = [{accountID:1,username:"CorpHR",options:{token:"new",fetch:fetcher}},...accounts];
    assert.equal((await openRegisteredFarmerAccount("corphr")).account,"CorpHR");
    assert.deepEqual(calls,["Bearer expired","Bearer new"]);
  } finally { installPageContext({}); }
});

test("a stale workspace session does not prevent opening operations through another pilot", async () => {
  const calls: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const authorization = new Headers(init?.headers).get("authorization")!;
    calls.push(authorization);
    assert.equal(String(input), "/api/plugins/uoc/center/account");
    assert.equal(init?.method, "GET");
    return authorization === "Bearer stale-lead"
      ? Response.json({ok:false,error:"AUTH_REQUIRED"},{status:401})
      : Response.json({account:{accountID:2,username:"Wingman"},worldID});
  };
  installPageContext({readAccounts:()=>[
    {accountID:1,username:"Lead",options:{token:"stale-lead",fetch:fetcher}},
    {accountID:2,username:"Wingman",options:{token:"live",fetch:fetcher}},
  ]});
  try {
    assert.equal((await openDefaultFarmerAccount("Lead"))?.account, "Wingman");
    assert.deepEqual(calls, ["Bearer stale-lead", "Bearer live"]);
  } finally { installPageContext({}); }
});

test("standalone UOC lists saved pilots passively and authorizes only the chosen account", async () => {
  const storage = new Map<string, string>([["evejs-web-known-characters:v1", JSON.stringify([
    {accountName:"SavedMiner",characterID:101,characterName:"Miner One",shipName:"Venture",skillPoints:null,balance:null,lastSeen:1},
    {accountName:"SavedCourier",characterID:102,characterName:"Courier One",shipName:"Magnate",skillPoints:null,balance:null,lastSeen:1},
  ])]]);
  setKnownCharacterStorage({ getItem: key => storage.get(key) ?? null, setItem: (key, value) => { storage.set(key, value); } });
  rememberCharacters("SavedWithoutRoster", []);
  const calls: string[] = [], authorized: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const path = String(input);
    calls.push(path);
    assert.equal(init?.credentials, "omit");
    const header = new Headers(init?.headers).get("authorization");
    if (path === "/api/pilot-training/login") {
      assert.equal(init?.method, "POST");
      assert.equal(header, null);
      const {username, password} = JSON.parse(String(init?.body));
      assert.equal(password, undefined);
      authorized.push(username);
      return Response.json({ok:true,account:{username},sessionToken:`local-${username}`});
    }
    if (path === "/api/logout") return Response.json({ok:true});
    assert.equal(init?.method, "GET");
    assert.equal(header, "Bearer local-SavedCourier");
    if (path === "/api/plugins/uoc/center/account") return Response.json({account:{accountID:12,username:"SavedCourier"},worldID});
    if (path === "/api/pilot-training/characters") return Response.json({account:"SavedCourier",characters:[{characterID:102,name:"Courier One"}]});
    if (path === "/api/bots") return Response.json({ok:true,bots:[]});
    if (path === "/api/pilot-training/ownership?characterID=102") return Response.json({ownership:{characterID:102,owner:"OFF",online:false}});
    assert.fail(`Unexpected request ${path}`);
  };
  const pass = createTrainingAccountPass(fetcher);
  installPageContext({accountPass:{...pass,optionsFor:async name=>({...await pass.optionsFor(name),fetch:fetcher})}});
  try {
    assert.deepEqual(workspaceAccounts().sort(), ["SavedCourier","SavedMiner","SavedWithoutRoster"]);
    const {pilots} = await listWorkspaceOperationPilots();
    assert.equal(pilots.find(row=>row.characterID===101)?.availability, "UNCHECKED");
    const candidate = pilots.find(row=>row.characterID===102);
    assert.equal(candidate?.accountName, "SavedCourier");
    assert.equal(candidate?.availability, "UNCHECKED");
    assert.deepEqual(calls, []);
    await assert.rejects(ownerOptions("UnknownOutsideRoster"), /No saved WC account/);
    assert.deepEqual(calls, []);
    assert.equal((await listVerifiedOperationPilots(candidate!.accountName))[0]?.availability, "AVAILABLE");
    assert.equal((await openDefaultFarmerAccount("SavedCourier"))?.account, "SavedCourier");
    assert.equal((await ownerOptions("SavedCourier")).token, "local-SavedCourier");
    assert.deepEqual(authorized, ["SavedCourier"]);
    assert.equal(calls.some(path=>path === "/api/bridge/select" || path === "/api/login"), false);
  } finally {
    installPageContext({});
    setKnownCharacterStorage(null);
    await pass.release();
  }
});

test("a saved account name does not grant access to the workspace roster", async () => {
  const storage = new Map<string, string>();
  setKnownCharacterStorage({ getItem: key => storage.get(key) ?? null, setItem: (key, value) => { storage.set(key, value); } });
  rememberCharacters("KnownOnly", []);
  rememberCharacters("RosterQA", []);
  const fetcher: typeof fetch = async () => assert.fail("Reading picker choices must not call the server");
  installPageContext({ readAccounts: () => [{ accountID: 71, username: "RosterQA", options: { token: "verified", fetch: fetcher } }] });
  try {
    assert.deepEqual(farmerAccounts(), ["RosterQA"]);
    assert.equal(matchAccountName(farmerAccounts(), "rosterqa"), "RosterQA");
    assert.equal(matchAccountName(["Pilot", "PILOT"], "pilot"), undefined);
    assert.equal(matchAccountName(["Pilot", "PILOT"], "PILOT"), "PILOT");
    await assert.rejects(openRegisteredFarmerAccount("KnownOnly"), /No saved WC account/);
    rememberCharacters("rosterqa", []);
    await assert.rejects(ownerOptions("rosterqa"), /No saved WC account/);
    assert.equal((await ownerOptions("RosterQA")).token, "verified");
  } finally {
    installPageContext({});
    setKnownCharacterStorage(null);
  }
});
