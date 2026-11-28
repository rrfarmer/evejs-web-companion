import assert from "node:assert/strict";
import test from "node:test";
import type { FoundAgent } from "../shared/types.ts";
import { filterCivilianAgents, loadCivilianAgents } from "../civilianAgents.ts";

function agent(id: number, level: number | null, fields: Partial<FoundAgent> = {}): FoundAgent {
  return {
    agentID: id, name: `Agent ${id}`, level, divisionID: 23, agentTypeID: 2,
    missionKind: "mining", missionTypeLabel: null, corporationID: 20, factionID: null,
    stationID: 100, stationName: "Refinery", solarSystemID: 200, solarSystemName: "Haatomo",
    ...fields,
  };
}

test("the WC74 exact and maximum level rules include only usable directory rows", () => {
  const rows = [
    agent(1, 1), agent(2, 2), agent(3, 3), agent(4, 4), agent(5, 5),
    agent(6, null), agent(7, 3, { stationID: null }), agent(0, 1),
  ];
  const filters = { level: 4, corporationID: null, query: "" };
  assert.deepEqual(filterCivilianAgents(rows, { ...filters, levelRule: "max" }).map((row) => row.agentID), [1, 2, 3, 4]);
  assert.deepEqual(filterCivilianAgents(rows, { ...filters, levelRule: "exact" }).map((row) => row.agentID), [4]);
});

test("corporation and text filters can narrow by station or system", () => {
  const rows = [
    agent(1, 1),
    agent(2, 1, { stationName: "Trade Hub" }),
    agent(3, 1, { corporationID: 21 }),
  ];
  const filters = { level: 1, levelRule: "exact" as const, corporationID: 20 };
  assert.deepEqual(filterCivilianAgents(rows, { ...filters, query: " REFInery " }).map((row) => row.agentID), [1]);
  assert.deepEqual(filterCivilianAgents(rows, { ...filters, query: "haatomo" }).map((row) => row.agentID), [1, 2]);
});

test("directory fetch uses the signed-in token and the upstream read-only endpoint", async () => {
  const requests: string[] = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    requests.push(String(input));
    assert.equal(init?.method, "GET");
    assert.equal(init?.credentials, "omit");
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer directory-fixture");
    return Response.json({
      ok: true,
      agents: [agent(1, 1, { corporationName: "Deep Core Mining Inc." })],
      capped: true,
      total: 2,
    });
  };
  const options = { token: "directory-fixture", fetch: fakeFetch };
  const mining = await loadCivilianAgents("mining", options);
  await loadCivilianAgents("distribution", options);
  assert.deepEqual(requests, ["/api/agents/find?kind=mining&limit=5000", "/api/agents/find?kind=courier&limit=5000"]);
  assert.equal(mining.agents[0]?.corporationName, "Deep Core Mining Inc.");
  assert.equal(mining.total, 2);
  assert.equal(mining.capped, true);
});

test("missing corporation names are resolved once per exact owner before building filters",async()=>{
 const requests:{url:string;body:any}[]=[];
 const fetcher:typeof fetch=async(input,init)=>{
  const url=String(input);requests.push({url,body:init?.body?JSON.parse(String(init.body)):null});
  assert.equal(new Headers(init?.headers).get("authorization"),"Bearer current-account");
  if(init?.method==="GET")return Response.json({ok:true,agents:[agent(1,1),agent(2,2),agent(3,1,{corporationID:21})],total:3,capped:false});
  assert.equal(url,"/api/names");return Response.json({ok:true,capped:false,names:{"owner:20":"Roden Shipyards","owner:21":"Deep Core Mining Inc."}});
 };
 const result=await loadCivilianAgents("mining",{token:"current-account",fetch:fetcher});
 assert.deepEqual(requests[1]!.body,{items:[{kind:"owner",id:20},{kind:"owner",id:21}]});
 assert.deepEqual(result.agents.map(a=>a.corporationName),["Roden Shipyards","Roden Shipyards","Deep Core Mining Inc."]);
 assert.equal(requests.length,2);
});
