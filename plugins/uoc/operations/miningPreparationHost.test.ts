import test from 'node:test';import assert from 'node:assert/strict';
import {createMiningPreparationRun} from './miningPreparationHost.ts';
type DroneFixture = {
  bay?: number;
  otherBay?: number;
  controlled?: readonly { typeID: number; quantity: number }[];
  detached?: number;
  effectiveCapacity?: number | null;
  bayCapacity?: number;
  reportedUsed?: number;
  stock?: number;
  stockStacks?: number[];
  otherPilotTakesStock?: boolean;
  lost?: "with-transfer" | "before-transfer";
};
const miningDrone = 10246;
const lightDrone = 2203;
function fixture(options:{lost?:boolean;equipment?:string;dropPolicy?:boolean;unknownSupplies?:boolean;corporateError?:string;ambiguous?:boolean;unavailable?:boolean;pending?:boolean;unresolved?:boolean;surplus?:boolean;stock?:number;take?:boolean;wrongDivision?:boolean;wrongOfficeLocation?:boolean;stationID?:number;
  staleReviews?: number; lostBeforeReceipt?: boolean; staleAfterTransfer?: boolean;
  beforeStaleResponse?: () => Promise<void>;
  drones?: DroneFixture;
}={}){
 const target={typeID:3,name:'Mining charge',target:4000,mode:'CARRIED_SPARES',eligibleFlags:[5,143],required:false};
 const locationID=options.stationID??600;
 let saved:any=null,aboard=3200,stock=options.stock??10000,transfers=0;let finish!:()=>void;const done=new Promise<void>(resolve=>{finish=resolve;});const reports:any[]=[],requests:string[]=[],sources:unknown[]=[];
 let reviewNumber = 0;
 const submittedReviews: string[] = [];
 const receipts = new Set<string>();
 const drone = options.drones;
 let droneBay = drone?.bay ?? 2;
 const stockStacks = new Map((drone?.stockStacks ?? [drone?.stock ?? 124]).map((qty, index) => [710 + index, qty]));
 const droneTransfers: { itemID: number; qty: number }[] = [];
 const deployed = (drone?.controlled ?? []).flatMap(({ typeID, quantity }) =>
   Array.from({ length: quantity }, () => ({ typeID, controlled: true })));
 for (let index = 0; index < (drone?.detached ?? 0); index++)
   deployed.push({ typeID: miningDrone, controlled: false });
 const {name:_,...extra}=target;
 const setup={operationID:'op',operationRunID:'generation',role:'MINER',preparation:{source:{kind:'hangar'},fittingID:4,suppliesRequired:true,replenishSupplies:true,supplies:[{...extra,required:true}]}};
 const run:any={botID:'prepare-native',characterID:10,held:{characterID:10},resumed:false,setup,baseUrl:'http://fixture',report:(r:any)=>{reports.push(r);if(['stopped','error','paused'].includes(r.status))finish();},fetch:async(input:any,init:any)=>{
  const p=new URL(input).pathname,b=init?.body?JSON.parse(init.body):null;requests.push(p);let body:any;
  if(p==='/api/plugins/uoc/world')body={worldID:'world'};
  else if(p==='/api/bridge/provisioning/options')body={corporationID:31,providerCharacterID:10,definitionCorporationID:30,definitionStatus:'READY',fittings:options.ambiguous?[{fittingID:4},{fittingID:4}]:[{fittingID:4}],pending:options.pending?[{operationID:'other'}]:[]};
  else if(p==='/api/bridge/provisioning/review'&&options.unavailable)return new Response(JSON.stringify({ok:false,error:'PROVISIONING_FITTING_UNAVAILABLE',message:'Native fitting read unavailable'}),{status:409});
  else if(p==='/api/bridge/provisioning/review'){
   sources.push(b.source);
   assert.equal(b.supplyPolicy.fittedMinimum,true);
   assert.equal(b.supplyPolicy.fittingDronesAsSupplies,setup.preparation.replenishSupplies===true);
   const corp=b.source.kind==='corp';
   if(corp&&options.corporateError)return Response.json({ok:false,error:options.corporateError},{status:403});
   if(corp){assert.equal(b.corporationID,30);assert.equal(b.source.corporationID,31);}
   const descriptor=options.wrongDivision?{...b.source,division:b.source.division===7?1:7}:b.source;
   body={reviewID:`review-${++reviewNumber}`,reviewHash:'hash',context:{characterID:10,shipID:50,shipTypeID:22544,locationID,corporationID:31},
    contract:{name:'Fit',definitionFingerprint:'exact-fit',definition:{characterID:10,fittingID:b.fittingID},supplies:options.dropPolicy?[]:[target],
     ...(drone?{shipTypeID:22544,operational:[[87,miningDrone,5]]}:{})},
    status:{equipment:options.equipment??(drone && droneBay !== 5 ? 'MODIFIED' : 'VERIFIED'),...(options.surplus?{equipmentMatch:'REQUIRED_WITH_SURPLUS_EQUIPMENT'}:{}),
     supplies:options.unknownSupplies?'UNKNOWN':aboard<4000?'LOW':'FULL',targets:[{...target,current:aboard,deficit:4000-aboard}]},
    canApply:true,source:{pin:{descriptor,ownerID:corp?31:10,dockedLocationID:options.wrongOfficeLocation?locationID+1:locationID,
      office:corp?'corpOffice:700':null,locationID:corp?701:locationID,flag:corp?114+b.source.division:4},
     access:{query:true,take:options.take??true},available:[{typeID:3,quantity:stock}]}};
  }
  else if(p==='/api/bridge/provisioning/replenish'){
   assert.deepEqual(b,{reviewID:`review-${reviewNumber}`,reviewHash:'hash',confirm:true});
   submittedReviews.push(b.reviewID);
   if (submittedReviews.length <= (options.staleReviews ?? 0)) {
      await options.beforeStaleResponse?.();
      return Response.json({ ok: false, error: "REVIEW_REQUIRED" }, { status: 409 });
   }
   if (options.lostBeforeReceipt) throw Error("lost acknowledgement before a receipt was visible");
   transfers++;
   const quantity=Math.min(stock,4000-aboard);
   aboard+=quantity;stock-=quantity;
   receipts.add(b.reviewID);
   if (options.staleAfterTransfer)
     return Response.json({ ok: false, error: "REVIEW_REQUIRED" }, { status: 409 });
   if(options.lost)throw Error('lost acknowledgement');
   body={state:'COMPLETE'};
  }
  else if(p==='/api/bridge/provisioning/reconcile'){
   if (!receipts.has(b.operationID))
     return Response.json({ ok: false, error: "OPERATION_NOT_OWNED" }, { status: 409 });
   body={state:options.unresolved?'PENDING':'RECONCILED'};
  }
  else if (drone && p === "/api/bridge/flight/status") {
    body = { flight: { docked: true, inSpace: false, stationID: locationID, shipID: 50, solarSystemID: 300 } };
  }
  else if (drone && p === "/api/bridge/drones") {
    body = {
      activeShipID: 50,
      bay: [
        ...(droneBay > 0 ? [{ itemID: 501, typeID: miningDrone, quantity: droneBay }] : []),
        ...(drone.otherBay ? [{ itemID: 502, typeID: lightDrone, quantity: drone.otherBay }] : []),
      ],
      inSpace: deployed.map((row, index) => ({ ...row, itemID: 550 + index })),
      errors: { bay: null, inSpace: null },
      shipInfo: { type: "dict", entries: [[50, { type: "object", name: "util.KeyVal", args: {
        type: "dict", entries: [["attributes", { type: "dict", entries: [[283,
          drone.effectiveCapacity === null ? null : (drone.effectiveCapacity ?? 50),
        ]] }]],
      } }]] },
    };
  }
  else if (drone && p === "/api/bridge/ship/50/bays") {
    body = { shipID: 50, activeShipID: 50, bays: [{ key: "drone", error: null,
      capacity: { capacity: drone.bayCapacity ?? 50, used: drone.reportedUsed ?? 5 * (droneBay + (drone.otherBay ?? 0)) },
    }] };
  }
  else if (drone && p === "/api/names") body = { names: { ["type:" + miningDrone]: "Mining Drone I" } };
  else if (drone && p === "/api/types/volumes") body = { volumes: { [miningDrone]: 5, [lightDrone]: 5 } };
  else if (drone && p === "/api/bridge/call") {
    if (b.method === "InvalidateLocationCache") {
      assert.equal(b.service, "invCache");
      assert.ok([50, 700, locationID].includes(b.args[0]));
      body = { result: null };
    } else {
      const corp = setup.preparation.source.kind === "corp";
      assert.equal(b.method, "List");
      assert.equal(b.of, corp ? 700 : "hangar");
      assert.deepEqual(b.kwargs, { flag: corp ? 121 : 4 });
      body = { result: { type: "list", items: [...stockStacks].filter(([, quantity]) => quantity > 0)
        .map(([itemID, quantity]) => ({ itemID, quantity, typeID: miningDrone,
          ownerID: corp ? 31 : 10, locationID: corp ? 701 : locationID, flagID: corp ? 121 : 4,
        })) } };
    }
  }
  else if (drone && p === "/api/bridge/inventory/transfer") {
    const [itemID] = b.itemIDs;
    const quantity = stockStacks.get(itemID)!;
    assert.ok(b.qty > 0 && b.qty <= quantity);
    assert.deepEqual(b.from, setup.preparation.source.kind === "corp" ? { kind: "corp", division: 7 } : { kind: "hangar" });
    assert.deepEqual(b.to, { kind: "shipBay", bay: "drone" });
    // Web Companion's expectedScope belongs to in-space transfers.
    assert.equal(Object.hasOwn(b, "expectedScope"), false);
    droneTransfers.push({ itemID, qty: b.qty });
    if (drone.otherPilotTakesStock && itemID === 710) {
      stockStacks.delete(itemID);
      return Response.json({ ok: false, error: "ITEMS_NOT_AT_SOURCE" }, { status: 409 });
    }
    if (drone.lost === "before-transfer") throw Error("The transfer reply was lost");
    stockStacks.set(itemID, quantity - b.qty);
    droneBay += b.qty;
    if (drone.lost === "with-transfer") throw Error("The transfer reply was lost");
    body = { applied: true };
  }
  else throw Error(p);return new Response(JSON.stringify({ok:true,...body}),{status:200});
 }};
 const definition=createMiningPreparationRun({document:()=>({read:()=>saved,write:v=>{saved=structuredClone(v);}})});
 return {definition,run,reports,requests,sources,done,submittedReviews,droneTransfers,get droneBay(){return droneBay;},get saved(){return saved;},get transfers(){return transfers;},get aboard(){return aboard;}};
}
test('MCC validates actual equipment and uses only shared native personal supply replenishment',async()=>{
 const f=fixture(),handle=await f.definition.start(f.run);await f.done;await handle.stop();
 assert.equal(f.transfers,1);
 assert.deepEqual(f.sources,[{kind:'hangar'},{kind:'hangar'}]);
 assert.equal(f.reports.at(-1).readout.state,'VERIFIED');
 assert.equal(f.reports.at(-1).readout.targets[0].current,4000);
 assert.ok(!f.requests.some(p=>/provision-ship/.test(p)));
 assert.equal(f.saved.phase,'COMPLETE');
});
test('lost replenishment ACK is reconciled without another inventory dispatch',async()=>{const f=fixture({lost:true}),handle=await f.definition.start(f.run);await f.done;await handle.stop();assert.equal(f.transfers,1);assert.ok(f.requests.includes('/api/bridge/provisioning/reconcile'));assert.equal(f.reports.at(-1).readout.state,'VERIFIED');});

test("a stale Division review with no Core receipt allows one fresh review and one transfer", async () => {
  const f = fixture({ staleReviews: 1 });
  const source = { kind: "corp", corporationID: 31, division: 7 };
  f.run.setup.preparation.source = source;
  const handle = await f.definition.start(f.run);
  await f.done;
  await handle.stop();
  assert.deepEqual(f.submittedReviews, ["review-1", "review-2"]);
  assert.deepEqual(f.sources, [source, source, source]);
  assert.equal(f.transfers, 1);
  assert.equal(f.aboard, 4000);
  assert.equal(f.saved.phase, "COMPLETE");
  assert.equal(f.reports.at(-1).readout.state, "VERIFIED");
});

test("repeated confirmed stale reviews leave an advisory without blocking on a nonexistent receipt", async () => {
  const f = fixture({ staleReviews: 3 });
  const handle = await f.definition.start(f.run);
  await f.done;
  await handle.stop();
  assert.deepEqual(f.submittedReviews, ["review-1", "review-2"]);
  assert.equal(f.transfers, 0);
  assert.equal(f.saved, null);
  const report = f.reports.at(-1);
  assert.equal(report.status, "stopped");
  assert.equal(report.readout.state, "DEGRADED");
  assert.match(report.readout.reason, /went stale again/);
});

test("Stop settles a refused preparation without a second Apply", async () => {
  let applyCalled!: () => void;
  let answer!: () => void;
  const applying = new Promise<void>((resolve) => { applyCalled = resolve; });
  const allowResponse = new Promise<void>((resolve) => { answer = resolve; });
  const f = fixture({
    staleReviews: 1,
    async beforeStaleResponse() {
      applyCalled();
      await allowResponse;
    },
  });
  const handle = await f.definition.start(f.run);
  await applying;
  const stopping = handle.stop();
  answer();
  await stopping;
  assert.equal(f.saved, null);
  assert.equal(f.transfers, 0);
  assert.deepEqual(f.submittedReviews, ["review-1"]);
  assert.equal(f.reports.at(-1).phase, "Mining preparation settled");
});

test("lost Apply response and absent receipt keep the original pending attempt fenced", async () => {
  const f = fixture({ lostBeforeReceipt: true });
  const handle = await f.definition.start(f.run);
  await f.done;
  await handle.stop();
  assert.deepEqual(f.submittedReviews, ["review-1"]);
  assert.equal(f.transfers, 0);
  assert.equal(f.saved.phase, "PENDING");
  assert.equal(f.reports.at(-1).status, "paused");
  assert.match(f.reports.at(-1).why, /lost acknowledgement.*OPERATION_NOT_OWNED/);
});

test("a stale-review response with an existing movement receipt is reconciled without another Apply", async () => {
  const f = fixture({ staleAfterTransfer: true });
  const handle = await f.definition.start(f.run);
  await f.done;
  await handle.stop();
  assert.deepEqual(f.submittedReviews, ["review-1"]);
  assert.equal(f.transfers, 1);
  assert.equal(f.saved.receipt.state, "RECONCILED");
  assert.equal(f.reports.at(-1).readout.state, "VERIFIED");
});

async function prepare(f: ReturnType<typeof fixture>) {
  const handle = await f.definition.start(f.run);
  await f.done;
  await handle.stop();
  return f.reports.at(-1);
}

test("MCC fills the three missing Mining Drone I from Division 7 before replenishing charges", async () => {
  const f = fixture({ drones: {} });
  f.run.setup.preparation.source = { kind: "corp", corporationID: 31, division: 7 };
  const report = await prepare(f);
  assert.deepEqual(f.droneTransfers, [{ itemID: 710, qty: 3 }]);
  assert.equal(f.droneBay, 5);
  assert.deepEqual(f.submittedReviews, ["review-2"]);
  assert.equal(f.transfers, 1);
  assert.equal(report.readout.state, "VERIFIED");
  assert.equal(report.readout.targets.find((item: any) => item.typeID === miningDrone).deficit, 0);
  assert.ok(!f.requests.some((path) => path.includes("provision-ship")));
});

test("only drones controlled by the held ship count toward its fitting", async () => {
  const f = fixture({
    drones: { bay: 1, controlled: [{ typeID: miningDrone, quantity: 1 }], detached: 3 },
  });
  const report = await prepare(f);
  assert.deepEqual(f.droneTransfers, [{ itemID: 710, qty: 3 }]);
  assert.equal(f.droneBay, 4);
  assert.equal(report.readout.targets.find((item: any) => item.typeID === miningDrone).current, 5);
});

test("a 35 m³ bay with four returning drones leaves no room at an effective 50 m³", async () => {
  const f = fixture({
    drones: { otherBay: 5, controlled: [{ typeID: lightDrone, quantity: 4 }], reportedUsed: 35 },
  });
  const report = await prepare(f);
  assert.deepEqual(f.droneTransfers, []);
  assert.equal(report.readout.state, "DEGRADED");
  assert.match(report.readout.reason, /no room for more Mining Drone I/);
  assert.match(report.readout.reason, /Mining Drone I: 3 still needed/);
});

test("the active hull's effective Dogma wins over a lower type capacity and counts reservations once", async () => {
  const f = fixture({
    drones: {
      otherBay: 5,
      controlled: [{ typeID: lightDrone, quantity: 4 }],
      effectiveCapacity: 70,
      bayCapacity: 50,
      reportedUsed: 55,
    },
  });
  await prepare(f);
  assert.deepEqual(f.droneTransfers, [{ itemID: 710, qty: 3 }]);
});

test("unverifiable live capacity cannot authorize a Drone Bay transfer", async () => {
  const f = fixture({ drones: { effectiveCapacity: null } });
  const report = await prepare(f);
  assert.deepEqual(f.droneTransfers, []);
  assert.match(report.readout.reason, /effective Drone Bay capacity could not be verified/);
});

test("split stock is used only up to its available quantity and the remaining deficit is reported", async () => {
  const f = fixture({ drones: { stockStacks: [1, 1] } });
  f.run.setup.preparation.source = { kind: "corp", corporationID: 31, division: 7 };
  const report = await prepare(f);
  assert.deepEqual(f.droneTransfers, [{ itemID: 710, qty: 1 }, { itemID: 711, qty: 1 }]);
  assert.equal(f.droneBay, 4);
  assert.equal(report.readout.state, "DEGRADED");
  assert.match(report.readout.reason, /Mining Drone I: 1 still needed \(4\/5 aboard, 0 available in Corporation Division 7\)/);
});

test("Review alone shows the drone shortage and sends no transfer", async () => {
  const f = fixture({ drones: {} });
  f.run.setup.reviewOnly = true;
  const report = await prepare(f);
  assert.deepEqual(f.droneTransfers, []);
  assert.match(report.readout.reason, /Mining Drone I: 3 still needed/);
});

test("stock taken by another pilot leaves a concrete shortage without replaying the missing stack", async () => {
  const f = fixture({ drones: { stockStacks: [2, 1], otherPilotTakesStock: true } });
  const report = await prepare(f);
  assert.equal(report.status, "stopped");
  assert.deepEqual(f.droneTransfers, [{ itemID: 710, qty: 2 }, { itemID: 711, qty: 1 }]);
  assert.equal(f.droneBay, 3);
  assert.match(report.readout.reason, /Mining Drone I: 2 still needed \(3\/5 aboard, 0 available/);
});

test("a lost drone transfer reply uses the exact readback and never repeats the move", async () => {
  const moved = fixture({ drones: { lost: "with-transfer" } });
  assert.equal((await prepare(moved)).readout.state, "VERIFIED");
  assert.equal(moved.droneBay, 5);
  assert.deepEqual(moved.droneTransfers, [{ itemID: 710, qty: 3 }]);

  const unknown = fixture({ drones: { stockStacks: [2, 2], lost: "before-transfer" } });
  const result = await prepare(unknown);
  assert.equal(result.status, "error");
  assert.match(result.why, /transfer of Mining Drone I could not be confirmed/);
  assert.deepEqual(unknown.droneTransfers, [{ itemID: 710, qty: 2 }]);
  assert.equal(unknown.transfers, 0);
});

test('a wrong fitting or omitted configured supply policy cannot authorize a write',async()=>{for(const options of [{equipment:'MODIFIED'},{dropPolicy:true},{unavailable:true},{ambiguous:true}]){const f=fixture(options),handle=await f.definition.start(f.run);await f.done;await handle.stop();assert.equal(f.transfers,0);assert.equal(f.reports.at(-1).status,'stopped');assert.equal(f.reports.at(-1).readout.state,'DEGRADED');}});
test('optional restocking defaults off and legacy required shortages do not block departure',async()=>{
 const f=fixture();delete (f.run.setup.preparation as any).replenishSupplies;
 const handle=await f.definition.start(f.run);await f.done;await handle.stop();
 assert.equal(f.transfers,0);assert.equal(f.reports.at(-1).readout.state,'DEGRADED');
 assert.match(f.reports.at(-1).readout.reason,/departure is permitted/);
});

test('readiness Review verifies the fit without restocking even when top-up is enabled',async()=>{
 const f=fixture();Object.assign(f.run.setup,{reviewOnly:true,verifyEquipment:true});
 const handle=await f.definition.start(f.run);await f.done;await handle.stop();
 assert.equal(f.transfers,0);assert.equal(f.saved,null);
 assert.equal(f.reports.at(-1).readout.equipment,'VERIFIED');
 assert.equal(f.reports.at(-1).readout.state,'DEGRADED');
});

test('as-is preparation skips fitting reads and transfers',async()=>{
 const f=fixture({equipment:'MODIFIED'});delete (f.run.setup.preparation as any).fittingID;
 const handle=await f.definition.start(f.run);await f.done;await handle.stop();
 assert.equal(f.transfers,0);assert.deepEqual(f.requests,['/api/plugins/uoc/world']);assert.equal(f.reports.at(-1).readout.equipment,'AS IS');
});

test('strict Combat fitting review and genuine pending custody remain fenced',async()=>{
 for(const [options,role,expected,reason] of [
  [{equipment:'MODIFIED'},'COMBAT','error',/differs/],
  [{pending:true},'MINER','error',/custody/],
  [{lost:true,unresolved:true},'MINER','paused',/PREPARATION_UNRESOLVED/],
 ] as const){
  const f=fixture(options);Object.assign(f.run.setup,{role,verifyEquipment:role==='COMBAT'});
  const handle=await f.definition.start(f.run);await f.done;await handle.stop();
  assert.equal(f.transfers,role==='MINER'&&expected==='paused'?1:0);
  assert.equal(f.reports.at(-1).status,expected);assert.match(f.reports.at(-1).why,reason);
  if(expected==='paused')assert.equal(f.saved.phase,'PENDING');
 }
});

test('unreadable optional supplies remain a warning without stock changes',async()=>{
 const f=fixture({unknownSupplies:true});delete f.run.setup.preparation.replenishSupplies;
 const handle=await f.definition.start(f.run);await f.done;await handle.stop();
 assert.equal(f.transfers,0);assert.equal(f.reports.at(-1).status,'stopped');assert.equal(f.reports.at(-1).readout.state,'DEGRADED');
});

test('saved fitting tops up only the deficit from the selected division at each preparation station',async()=>{
 for(const [stationID,division] of [[600,1],[601,7]] as const){
  const f=fixture({stationID}),source={kind:'corp',corporationID:31,division};
  f.run.setup.preparation.source=source;delete f.run.setup.preparation.supplies;
  const handle=await f.definition.start(f.run);await f.done;await handle.stop();
  assert.equal(f.transfers,1);
  assert.equal(f.aboard,4000);
  assert.deepEqual(f.sources,[source,source]);
  assert.equal(f.reports.at(-1).readout.context.locationID,stationID);
  assert.equal(f.reports.at(-1).readout.state,'VERIFIED');
 }
});

test('read-only readiness resolves a saved division and reports how much stock is missing',async()=>{
 const f=fixture({stock:150});
 f.run.setup.reviewOnly=true;
 f.run.setup.preparation.source={kind:'corp',division:7};delete f.run.setup.preparation.supplies;
 const handle=await f.definition.start(f.run);await f.done;await handle.stop();
 assert.deepEqual(f.sources,[{kind:'corp',corporationID:31,division:7}]);
 assert.equal(f.transfers,0);
 assert.match(f.reports.at(-1).readout.reason,/Corporation Division 7.*Mining charge: 150 available, 800 needed/);
});

test('unavailable office, rights or wrong division cannot lead to personal fallback or a transfer',async()=>{
 for(const [options,reason] of [
  [{corporateError:'NO_CORP_OFFICE'},/no office at the pilot's preparation station/],
  [{corporateError:'CORPORATION_QUERY_DENIED'},/lacks Query access/],
  [{take:false},/Take access is unavailable/],
  [{wrongDivision:true},/office or division does not match/],
  [{wrongOfficeLocation:true},/office or division does not match/],
 ] as const){
  const f=fixture(options),source={kind:'corp',corporationID:31,division:7};
  f.run.setup.preparation.source=source;
  const handle=await f.definition.start(f.run);await f.done;await handle.stop();
  assert.deepEqual(f.sources,[source]);
  assert.equal(f.transfers,0);
  assert.equal(f.reports.at(-1).readout.state,'DEGRADED');
  assert.equal(f.reports.at(-1).readout.sourceLabel,'Corporation Division 7');
  assert.match(f.reports.at(-1).readout.reason,reason);
 }
});

test('unresolved fleet corporation and a changed pilot corporation leave corporate top-up disabled',async()=>{
 for(const source of [{kind:'corp',division:7},{kind:'corp',corporationID:32,division:7}]){
  const f=fixture();f.run.setup.preparation.source=source;
  const handle=await f.definition.start(f.run);await f.done;await handle.stop();
  assert.equal(f.transfers,0);
  assert.deepEqual(f.sources,[]);
  assert.match(f.reports.at(-1).readout.reason,/No shared player corporation|belongs to a different corporation/);
 }
});

test('compatible additional modules are reported as an advisory',async()=>{
 const f=fixture({surplus:true});Object.assign(f.run.setup,{reviewOnly:true});
 const handle=await f.definition.start(f.run);await f.done;await handle.stop();
 assert.equal(f.transfers,0);assert.equal(f.reports.at(-1).status,'stopped');
 assert.equal(f.reports.at(-1).readout.equipment,'VERIFIED');assert.match(f.reports.at(-1).readout.reason,/additional modules or rigs/);
});

test('verified Review retains scoped historical preparation without overwriting the native mutation journal',async()=>{
 const f=fixture();Object.assign(f.run.setup,{reviewOnly:true,verifyEquipment:true});let evidence:any=null;
 const definition=createMiningPreparationRun({document:()=>({read:()=>null,write(){throw Error('Review must not replace the inventory journal');}}),evidenceDocument:()=>({read:()=>evidence,write:v=>{evidence=structuredClone(v);}})});
 const handle=await definition.start(f.run);await f.done;await handle.stop();
 assert.equal(f.transfers,0);assert.equal(evidence.world,'world');assert.equal(evidence.botID,'prepare-native');assert.equal(evidence.readout.role,'MINER');assert.equal(evidence.readout.shipID,50);assert.equal(evidence.readout.equipment,'VERIFIED');assert.equal(evidence.readout.state,'DEGRADED');
});
