import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { compile, compileModule } from "svelte/compiler";
import { installPageContext, runHosted } from "../restored/app/context.ts";
import { openPageAccount } from "../restored/app/api.ts";
import { setKnownCharacterStorage } from "../../../web/src/app/knownCharacters.ts";
import { createTrainingAccountPass } from "../training/accountPass.ts";
import type { VerifiedOperationPilot } from "../restored/app/apiTypes.ts";
import { createDistributionStore, type DistributionView } from "../logistics/store.ts";
import type { Operation } from "../logistics/model.ts";
import type { UocBackendRequest } from "../shared/backendScope.ts";

// Run the actual client effects and onMount/teardown in Node. These checks need
// neither rendered markup nor a service. The route and card tests render the views.
function clientModule(code: string, file: URL) {
  const js = code.replace(/(from |import )(['"])([^'"]+)\2/g, (_match, prefix, _quote, path: string) => {
    const url = /\.(svelte|css)$/.test(path) ? "data:text/javascript,export default null"
      : path === "svelte" ? new URL("index-client.js", import.meta.resolve("svelte")).href
      : path.startsWith(".") ? new URL(path, file).href : import.meta.resolve(path);
    return prefix + JSON.stringify(url);
  });
  return import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));
}
async function mount<T = unknown>(path: string, props: Record<string, unknown>, expose = "") {
  const file = new URL(path, import.meta.url), source = readFileSync(file, "utf8");
  const script = source.slice(0, source.indexOf("</script>")) + expose + "\n</script>";
  const view = await clientModule(compile(script, { filename: fileURLToPath(file), generate: "client", discloseVersion: false }).js.code, file);
  const root = await clientModule(compileModule(
    "export function mount(View, initial) { const props = $state(initial); let view; const close = $effect.root(() => { view = View(null, props); }); return {props, close, view}; }",
    { filename: "polling-test.svelte.js", generate: "client" }).js.code, file);
  const result: { props: Record<string, unknown>; close(): Promise<void>; view: T } = root.mount(view.default, props);
  await turn();
  return result;
}

test("MCC Stop, Retry Stop and Return Home use the run refreshed on return", async t => {
  const page = tab(t), commands: unknown[] = [];
  let runID = "old-run", stopFreight: string | null = null;
  const fetcher: typeof fetch = async (input, init) => {
    const path = new URL(String(input), "http://test.invalid").pathname;
    if (path.endsWith("/stop")) {
      assert.equal(init?.method, "POST");
      const command = JSON.parse(String(init.body));
      commands.push(command);
      stopFreight = command.mode;
      return Response.json({ mode: stopFreight, live: true });
    }
    if (path.endsWith("/launch")) return Response.json({ receipt: null });
    if (path.endsWith("/delivery-receipts")) return Response.json({ result: { runID, deliveredUnits: 10 } });
    if (path.endsWith("/resources")) return Response.json({ resources: [] });
    if (path === "/api/bots") return Response.json({ hostedRunPolicy: policy });
    assert.equal(path, "/api/plugins/uoc/mining-operations");
    return Response.json({ capabilities: {}, targetBoard: [], operations: [{ definition: { operationID: "fleet" },
      runtime: { operationID: "fleet", operationRunID: runID, state: stopFreight ? "STOPPING" : "ACTIVE", stopFreight, history: [], members: [] } }] });
  };
  const panel = await mount<{ stop(id: string, mode: string): Promise<void>; controls(): { ready: boolean; retry: string | null } }>(
    "../restored/ui/MiningOperations.svelte", { accountName: "Operator", access: { token: "fixture", fetch: fetcher } },
    "export { stop }; export function controls() { return { ready: !disconnected && busy === null && !!activeRunID, retry: selectedRun?.stopFreight }; }");
  await page.hide(false);
  await page.hide(true);
  runID = "current-run";
  await page.hide(false);
  assert.deepEqual(panel.view.controls(), { ready: true, retry: null });
  await panel.view.stop("fleet", "COLLECT_FREIGHT");
  const { ready, retry } = panel.view.controls();
  assert.ok(ready && retry);
  await panel.view.stop("fleet", retry);
  await page.hide(true);
  runID = "next-run"; stopFreight = null;
  await page.hide(false);
  assert.deepEqual(panel.view.controls(), { ready: true, retry: null });
  await panel.view.stop("fleet", "RETURN_HOME");
  assert.deepEqual(commands, [
    { operationRunID: "current-run", mode: "COLLECT_FREIGHT" },
    { operationRunID: "current-run", mode: "COLLECT_FREIGHT" },
    { operationRunID: "next-run", mode: "RETURN_HOME" },
  ]);
  await panel.close();
});
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
function tab(t: TestContext) {
  const doc = Object.assign(new EventTarget(), { hidden: true }), win = new EventTarget();
  for (const [key, value] of [["document", doc], ["window", win], ["location", new URL("http://test.invalid/uoc/")]] as const) {
    const old = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value, configurable: true });
    t.after(() => { if (old) Object.defineProperty(globalThis, key, old); else Reflect.deleteProperty(globalThis, key); });
  }
  t.after(() => installPageContext({}));
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: Date.now() });
  return {
    async hide(hidden: boolean) { doc.hidden = hidden; doc.dispatchEvent(new Event("visibilitychange")); await turn(); },
    async event(name: string) { win.dispatchEvent(new Event(name)); await turn(); },
    async advance(ms: number) { t.mock.timers.tick(ms); await turn(); },
  };
}
const policy = { maxRuntimeMinutes: 60, defaultRuntimeMinutes: 30, durationChoices: [30,60] };

for (const [component, statusPath, interval] of [
  ["MiningOperations", "/api/plugins/uoc/mining-operations", 3000],
  ["CivilianWorkers", "/api/plugins/uoc/civilian/checkpoints", 3000],
  ["DistributionCenter", "/api/plugins/uoc/logistics", 4000],
] as const) {
  test(component + " aborts hidden reads, refreshes on return and owns a single timer", async t => {
    const page = tab(t), reads: AbortSignal[] = [], writes: string[] = [];
    let hold = false;
    const fetcher: typeof fetch = async (input, init) => {
      const path = new URL(String(input), "http://test.invalid").pathname;
      if (init?.method === "POST") writes.push(path);
      if (path === statusPath) {
        const signal = init?.signal;
        assert.ok(signal);
        reads.push(signal);
        if (hold) await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once:true }));
      }
      const bodies: Record<string, unknown> = {
        "/api/plugins/uoc/center/account": { account: { accountID: 1, username: "Operator" }, worldID:"test" },
        "/api/plugins/uoc/mining-operations": { operations: [], targetBoard: [], capabilities: {} },
        "/api/mining-operations/resources": { resources: [] },
        "/api/bots": { bots: [], hostedRunPolicy: policy },
        "/api/plugins/uoc/civilian/checkpoints": { history: [], recovery: [] },
        "/api/pilot-training/characters": { account: "Operator", characters: [] },
        "/api/plugins/uoc/world": { worldID:"test" },
        "/api/plugins/uoc/logistics": { operations: [], roster: [] },
      };
      assert.ok(path in bodies, path);
      return Response.json(bodies[path]);
    };
    const access = { token: "fixture", fetch: fetcher };
    installPageContext({ readAccounts: () => [{ accountID:1, username:"Operator", options:access }] });
    const view = await mount("../restored/ui/" + component + ".svelte", {
      accountName:"Operator", operatorAccount:"Operator", access, accounts:["Operator"], watchedAccounts:["Operator"], profiles:[], refreshKey:0,
    });
    await page.advance(12_000);
    assert.equal(reads.length,0);
    await page.hide(false);
    assert.equal(reads.length,1);
    hold = true;
    await page.advance(interval);
    assert.equal(reads.length,2);
    await page.hide(true);
    assert.equal(reads[1]!.aborted,true);
    await page.advance(12_000);
    assert.equal(reads.length,2);
    hold = false;
    for (let i=0; i<3; i++) {
      const before: number = reads.length;
      await page.hide(false);
      await page.event("pageshow");
      assert.equal(reads.length,before+1);
      await page.advance(interval-1);
      assert.equal(reads.length,before+1);
      await page.advance(1);
      assert.equal(reads.length,before+2);
      await page.hide(true);
    }
    const cached: number = reads.length;
    await page.event("pagehide");
    await page.hide(false);
    await page.advance(interval);
    assert.equal(reads.length,cached);
    await page.event("pageshow");
    assert.equal(reads.length,cached+1);
    await view.close();
    const count=reads.length;
    await page.hide(false);
    await page.advance(12_000);
    assert.equal(reads.length,count);
    assert.deepEqual(writes,[]);
  });
}

test("Bot Host keeps the original run while hidden and reads its receipt on return", async t => {
  const page=tab(t);
  await page.hide(false);
  let started=false, finished=false, reads=0;
  const posts:string[]=[];
  let pending:AbortSignal|null|undefined;
  const row=()=>({botID:"original",characterID:40,kind:"plugin",status:finished?"stopped":"running",
    endedAt:finished?"now":null,phase:finished?"Done":"Working",plugin:{pluginID:"uoc",run:"training-inspect",readout:{}}});
  const fetcher:typeof fetch=async(input,init)=>{
    const path=String(input);
    if(init?.method==="POST")posts.push(path);
    if(path.endsWith("/service"))return Response.json({available:false});
    if(path.includes("/ownership?"))return Response.json({ownership:{characterID:40,owner:"OFF",online:false}});
    if(path.endsWith("/check"))return Response.json({ok:true,setup:{},policy:{riskClasses:[],restartSafe:false}});
    if(path==="/api/bots/start"){started=true;return Response.json({ok:true,bot:row()});}
    assert.equal(path,"/api/bots");
    if(started){
      reads++;
      if(!finished){
        pending=init?.signal;
        await new Promise((_resolve,reject)=>pending?.addEventListener("abort",()=>reject(pending?.reason),{once:true}));
      }
    }
    return Response.json({bots:started?[row()]:[],hostedRunPolicy:policy});
  };
  const result=runHosted(40,"training-inspect",{},{token:"Operator",fetch:fetcher});
  await turn();
  assert.equal(started,true);
  await page.advance(250);
  assert.equal(reads,1);
  await page.hide(true);
  assert.ok(pending?.aborted);
  await page.advance(601_000);
  assert.equal(reads,1);
  finished=true;
  await page.hide(false);
  assert.equal((await result).botID,"original");
  await page.advance(3600);
  assert.equal(reads,2);
  assert.equal(posts.filter(p=>p==="/api/bots/start").length,1);
  assert.ok(posts.every(p=>p.endsWith("/check")||p==="/api/bots/start"));
});

test("account change, UOC navigation and unmount detach the exact owner-service observer", async t => {
  const page=tab(t);
  await page.hide(false);
  const view=await mount("ModulePage.svelte",{page:"training",operatorAccount:"Alpha"});
  const starts:string[]=[], reads:string[]=[];
  const submitted=new Set<number>();
  let pending:AbortSignal|null|undefined;
  const fetcher:typeof fetch=async(input,init)=>{
    const path=String(input),token=new Headers(init?.headers).get("authorization")!;
    assert.match(path,/\/training\/\d+\/service$/);
    const id=Number(path.split("/").at(-2));
    if(init?.method==="POST"){
      starts.push(token);submitted.add(id);
      return Response.json({task:{taskID:"task-"+id,characterID:id,kind:"inspect",ownerBotID:"owner",domain:"training",endedAt:null}});
    }
    if(!submitted.has(id))return Response.json({available:true,ownerBotID:"owner"});
    reads.push(token);pending=init?.signal;
    return new Promise((_resolve,reject)=>pending?.addEventListener("abort",()=>reject(pending?.reason),{once:true}));
  };
  for(const [i,account] of ["Alpha","Beta","Beta"].entries()){
    const result=runHosted(50+i,"training-inspect",{},{token:account,fetch:fetcher});
    const detached=assert.rejects(result,{name:"AbortError"});
    await turn();
    await page.advance(1200);
    assert.equal(reads.at(-1),"Bearer "+account);
    if(i===0)view.props.operatorAccount="Beta";
    else if(i===1)view.props.page="distribution";
    else await view.close();
    await detached;
    assert.ok(pending?.aborted);
    const count=reads.length;
    await page.advance(12_000);
    assert.equal(reads.length,count);
  }
  assert.deepEqual(starts,["Bearer Alpha","Bearer Beta","Bearer Beta"]);
});

test("leaving a screen preserves a dispatched owner command and drops the queued request for that screen", async t => {
  const page = tab(t);
  await page.hide(false);
  const view = await mount("ModulePage.svelte", { page: "training", operatorAccount: "Lead" });
  const methods: string[] = [];
  let finish!: () => void;
  const fetcher: typeof fetch = async (path, init) => {
    assert.equal(path, "/api/plugins/uoc/training/62/service");
    methods.push(init!.method!);
    if (init!.method === "GET") return Response.json({ available: true, ownerBotID: "owner" });
    await new Promise<void>(resolve => { finish = resolve; });
    assert.ok(!init?.signal?.aborted, "the dispatched command must still receive its response");
    return Response.json({ task: { characterID: 62, ownerBotID: "owner", taskID: "original", domain: "training", kind: "inspect" } });
  };
  const options = { token: "fixture", fetch: fetcher };
  const first = assert.rejects(runHosted(62, "training-inspect", {}, options), { name: "AbortError" });
  const queued = assert.rejects(runHosted(62, "training-inspect", { later: true }, options), { name: "AbortError" });
  await turn();
  assert.deepEqual(methods, ["GET", "POST"]);
  await view.close();
  finish();
  await Promise.all([first, queued]);
  await page.advance(3600);
  assert.deepEqual(methods, ["GET", "POST"]);
});

test("switching to an unavailable linked account never polls the preceding operator", async t => {
  tab(t);
  const calls: string[] = [];
  const fetcher: typeof fetch = async (_path, init) => {
    const token = new Headers(init?.headers).get("authorization")!;
    calls.push(token);
    return token === "Bearer lead-ok"
      ? Response.json({ account: { accountID: 1, username: "Lead" }, worldID: "test" })
      : Response.json({ error: "AUTH_REQUIRED" }, {status: 401});
  };
  installPageContext({ readAccounts: () => [
    { accountID: 1, username: "Lead", options: {token: "lead-ok", fetch: fetcher} },
    { accountID: 2, username: "Next", options: {token: "next-expired", fetch: fetcher} },
  ] });
  assert.equal((await openPageAccount("Lead"))?.account, "Lead");
  await assert.rejects(openPageAccount("Next", "Lead"), {status: 401});
  assert.deepEqual(calls, ["Bearer lead-ok", "Bearer next-expired"]);
});

test("losing the last linked account waits for reconnection or an explicit choice of saved accounts", async t => {
  tab(t);
  const page = await mount<{ isDisconnected(): boolean; useSavedAccounts(): void }>("StandalonePage.svelte",
    { sessions: [], activeSession: null }, "export {useSavedAccounts}; export function isDisconnected() { return disconnected; }");
  assert.equal(page.view.isDisconnected(), false, "direct links can use saved accounts");
  for (const name of ["Lead", "Wingman"]) {
    const pilot = { accountName: name, characterID: 1, token: "fixture" };
    Object.assign(page.props, { sessions: [pilot], activeSession: pilot });
    await turn();
    assert.equal(page.view.isDisconnected(), false);
    Object.assign(page.props, { sessions: [], activeSession: null });
    await turn();
    assert.equal(page.view.isDisconnected(), true);
  }
  page.view.useSavedAccounts();
  await turn();
  assert.equal(page.view.isDisconnected(), false);
  await page.close();
});

test("Distribution asks once before starting All items and starts selected freight directly", async t => {
  const page = tab(t);
  const prefix = "/api/plugins/uoc/logistics";
  const starts: string[] = [];
  const prompts: string[] = [];
  let approved = false;
  window.confirm = (message = "") => {
    prompts.push(message);
    return approved;
  };
  const account = { accountID: 1, username: "Operator" };
  const fetcher: typeof fetch = async (input, init) => {
    const path = new URL(String(input), "http://test.invalid").pathname;
    if (path.endsWith("/center/account")) return Response.json({ account, worldID: "test" });
    if (init?.method === "POST") starts.push(path);
    return Response.json({ ok: true, operations: [], roster: [] });
  };
  installPageContext({ readAccounts: () => [{ ...account, options: { token: "fixture", fetch: fetcher } }] });
  const panel = await mount<{ start(op: Operation): void }>(
    "../restored/ui/DistributionCenter.svelte", { operatorAccount: account.username }, "export { start };",
  );
  t.after(() => panel.close());
  await page.hide(false);
  async function start(mode: Operation["config"]["mode"], allItems: boolean) {
    panel.view.start({
      id: mode, execution: null,
      config: {
        name: "Freight run", mode, allItems, corporationID: 9,
        source: { kind: "station", destinationID: 601, systemID: 1, division: 7, name: "Source Station" },
        destination: { kind: "structure", destinationID: 802, systemID: 2, division: 1, name: "Delivery Hub" },
        items: mode === "MANUAL" && allItems ? [] : [{ typeID: 34, quantity: 2 }],
        fillPercent: 0, waitMinutes: 0,
      },
    });
    await turn();
  }

  await start("MANUAL", true);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0]!, /Division 7 at Source Station.*Division 1 at Delivery Hub/);
  assert.match(prompts[0]!, /containers.*contents/i);
  assert.match(prompts[0]!, /stock set aside/i);
  assert.match(prompts[0]!, /assembled ships stay/i);
  assert.deepEqual(starts, []);

  approved = true;
  await start("MANUAL", true);
  await start("COLLECTION", true);
  assert.equal(prompts.length, 3);
  assert.match(prompts[2]!, /reserves.*new arrivals/i);
  assert.deepEqual(starts, [prefix + "/MANUAL/start", prefix + "/COLLECTION/start"]);

  approved = false;
  starts.length = 0;
  for (const mode of ["MANUAL", "COLLECTION", "SUPPLY"] as const) await start(mode, false);
  assert.equal(prompts.length, 3);
  assert.deepEqual(starts, [prefix + "/MANUAL/start", prefix + "/COLLECTION/start", prefix + "/SUPPLY/start"]);
});

test("Distribution adds a pilot from another Hangar account and reopens the same fleet after switching accounts", async t => {
  const tabState = tab(t);
  await tabState.hide(false);
  const characters = { Alpha: {characterID: 11, name: "Miner"}, Beta: {characterID: 22, name: "Hauler"} };
  type Name = keyof typeof characters;
  const known = Object.entries(characters).map(([accountName, c]) => ({accountName, characterID:c.characterID,
    characterName:c.name, shipName:null, skillPoints:null, balance:null, lastSeen:1}));
  setKnownCharacterStorage({getItem:key=>key==="evejs-web-known-characters:v1"?JSON.stringify(known):null, setItem(){}});
  t.after(() => setKnownCharacterStorage(null));
  let operator: Name = "Alpha", data: unknown = null;
  const store = createDistributionStore(() => ({ read: () => structuredClone(data), write: v => { data=structuredClone(v); } }));
  const registrations: {account:Name;body:Record<string,unknown>}[] = [], logins: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const path = new URL(String(input), "http://fixture.invalid").pathname;
    if (path === "/api/pilot-training/login") {
      const {username} = JSON.parse(String(init?.body));
      logins.push(username);
      return Response.json({account:{username},sessionToken:username+"-offline"});
    }
    if (path === "/api/logout") return Response.json({ok:true});
    const token = new Headers(init?.headers).get("authorization");
    const name = (Object.keys(characters) as Name[]).find(n=>token==="Bearer "+n+"-linked"||token==="Bearer "+n+"-offline");
    assert.ok(name, "every request uses an explicit WC account");
    const pilot = characters[name], account={username:name,accountID:pilot.characterID+100}, worldID="fleet-test";
    if (path.endsWith("/center/account")) return Response.json({account,worldID});
    if (path === "/api/pilot-training/characters") return Response.json({account:name,characters:[{...pilot,corporationID:9}]});
    if (path.endsWith("/ownership")) return Response.json({ownership:{characterID:pilot.characterID,owner:"OFF",online:false}});
    if (path === "/api/bots") return Response.json({bots:[],hostedRunPolicy:policy});
    if (path === "/api/roster/characters") return Response.json({result:null});
    if (path === "/api/plugins/uoc/logistics") return Response.json(store.view(worldID));
    assert.equal(path,"/api/plugins/uoc/logistics/roster");
    const body=JSON.parse(String(init?.body));
    registrations.push({account:name,body});
    const request:UocBackendRequest={method:"POST",path,body,account,worldID,params:{},query:{}};
    const result=await store.routes["POST /logistics/roster"](request);
    return Response.json(result.body,{status:result.status});
  };
  const pass=createTrainingAccountPass(fetcher);
  t.after(()=>pass.release());
  installPageContext({fetch:fetcher,accountPass:pass,
    readPagePilots:()=>[{accountName:operator,characterID:characters[operator].characterID,token:operator+"-linked"}]});
  const panel=()=>mount<{addHauler(pilot:VerifiedOperationPilot):void; roster():DistributionView["roster"]; readIssue():string}>(
    "../restored/ui/DistributionCenter.svelte",{operatorAccount:operator},
    "export {addHauler}; export function roster(){return view.roster} export function readIssue(){return issue}");
  const first=await panel();
  const picked:VerifiedOperationPilot={characterID:22,characterName:"Old display name",accountName:"Alpha",
    availability:"AVAILABLE",corporationName:null,shipName:null,reason:"Verified"};
  first.view.addHauler(picked);
  await turn();
  assert.match(first.view.readIssue(),/missing from the current roster for Alpha/);
  assert.deepEqual(registrations,[]);
  first.view.addHauler({...picked,accountName:"Beta"});
  await turn();
  assert.deepEqual(logins,["Beta"]);
  assert.deepEqual(registrations,[{account:"Beta",body:{characterID:22,name:"Hauler",shipName:null,corporationID:9}}]);
  assert.equal(first.view.roster()[0]?.characterID,22);
  await first.close();
  operator="Beta";
  const reopened=await panel();
  assert.deepEqual(reopened.view.roster(),[{characterID:22,name:"Hauler",corporationID:9,hosted:null,trip:null}]);
  assert.deepEqual(logins,["Beta"]);
  await reopened.close();
});
