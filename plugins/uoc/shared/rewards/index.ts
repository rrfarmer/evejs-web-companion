import type { PluginRunContext } from "../../../../web/src/plugin-api/backend.ts";
import { isListValue, readKeyVal, readRowField, unwrapLong, type JsonValue } from "../wire.ts";
import { captureMissionRewards, compareMissionRewards, type MissionRewardReadout, type MissionRewardSnapshot } from "./compare.ts";
export type { MissionRewardReadout, MissionRewardSnapshot } from "./compare.ts";

const positive = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n > 0;
const numericID = (value: unknown): number | null => { const n = unwrapLong(value); return n !== null && n > 0n && n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : null; };
const npcCorporation = (id: number) => id >= 1_000_000 && id < 2_000_000;
/** corpRegistry.GetCorporation: packed/KeyVal or its native header/line wrapper. */
function corporationID(value: JsonValue): number | null {
  const direct = numericID(readRowField(value, "corporationID")); if (direct !== null) return direct;
  const native=value as any;
  const fields=native?.type==="object"&&native.name==="util.Row"&&native.args?.type==="dict"&&Array.isArray(native.args.entries)?native.args.entries:null;
  const field=(key:string):JsonValue|undefined=>{if(!fields)return readKeyVal(value,key);
    const matches=fields.filter((r:any)=>Array.isArray(r)&&r.length===2&&r[0]===key);return matches.length===1?matches[0][1]:undefined;};
  const header = field("header"), line = field("line");
  if (!isListValue(header) || !isListValue(line) || header.items.length !== line.items.length) return null;
  if(header.items.filter(x=>x==="corporationID").length!==1)return null;
  const index = header.items.indexOf("corporationID"); return index >= 0 ? numericID(line.items[index]) : null;
}
/** Each read stays on the core-held pilot's existing BFF session. Never selects or mutates. */
export async function captureReward(run: Pick<PluginRunContext, "characterID" | "held" | "fetch" | "baseUrl">,
  characterID: number, agentID: number, agentCorporationID: number | null): Promise<MissionRewardSnapshot> {
  const safeCorporation = positive(agentCorporationID) ? agentCorporationID : null;
  const unknown = () => captureMissionRewards({ characterID, agentID, corporationID: safeCorporation, cash: null, lp: null, journal: null, memberCorporationID: null, corporationLp: null });
  if (!positive(characterID) || !positive(agentID) || run.characterID !== characterID || run.held.characterID !== characterID || run.held.character?.characterID !== characterID) return unknown();
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>(resolve => { timer = setTimeout(() => { abort.abort(); resolve(null); }, 3500); });
  const read = async (service: string, method: string, args: readonly JsonValue[]): Promise<JsonValue> => {
    if (abort.signal.aborted) return null;
    const request = async (): Promise<JsonValue> => { try {
      const response = await run.fetch(new URL("/api/bridge/call", run.baseUrl), { method: "POST", signal: abort.signal,
        headers: { "content-type": "application/json" }, body: JSON.stringify({ service, method, args, pilot: true }) });
      if (!response.ok) return null;
      const data = await response.json() as { ok?: boolean; result?: JsonValue };
      return data.ok === false ? null : data.result ?? null;
    } catch { return null; } };
    return (await Promise.race([request(), timeout])) ?? null;
  };
  const collect = async (): Promise<MissionRewardSnapshot> => {
    const [cash, lp, journal, corpBefore] = await Promise.all([
      read("account", "GetCashBalance", [0]), read("LPSvc", "GetAllMyCharacterWalletLPBalances", []),
      read("account", "GetTransactions", [1000, null, null, false]), read("corpRegistry", "GetCorporation", []),
    ]);
    const heldCorp = numericID(run.held.character?.corporationID), before = corporationID(corpBefore);
    // HeldPilot is a presentation snapshot and may omit corporationID after
    // relocation. The session-scoped native corporation read is authoritative;
    // bracket the LP read with it, and reject any explicit identity conflict.
    if (!safeCorporation || !before || heldCorp!==null&&before!==heldCorp || npcCorporation(before))
      return captureMissionRewards({ characterID, agentID, corporationID: safeCorporation, cash, lp, journal });
    const [corporationLp, corpAfter] = await Promise.all([
      read("LPSvc", "GetAllMyCorporationWalletLPBalances", []), read("corpRegistry", "GetCorporation", []),
    ]);
    const stable = corporationID(corpAfter) === before;
    return captureMissionRewards({ characterID, agentID, corporationID: safeCorporation, cash, lp, journal,
      memberCorporationID: stable ? before : null, corporationLp: stable ? corporationLp : null });
  };
  try { return await collect(); }
  finally { if (timer !== undefined) clearTimeout(timer); abort.abort(); }
}
/** Call only after the caller has verified the exact mission's Complete receipt. */
export function compareRewards(before: MissionRewardSnapshot, after: MissionRewardSnapshot, missionKey: string): MissionRewardReadout {
  return compareMissionRewards(before, after, { characterID: before.characterID, agentID: before.agentID, missionKey, completed: true });
}
