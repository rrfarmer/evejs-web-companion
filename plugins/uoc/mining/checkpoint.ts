import fs from "node:fs";
import path from "node:path";
import type { MiningMissionState, MiningMissionReceipt } from "./miningMission.ts";

interface Row { scriptHash: string; state: MiningMissionState; receipt: MiningMissionReceipt | null }
interface DocumentStore { read(): unknown; write(value: unknown): void }
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const keyFor = (accountID: number, characterID: number) => `${accountID}:${characterID}`;

/** Durable, fail-closed custody journal. One backend process owns this file. */
export function createMiningMissionRuns({ filePath, storage }: { filePath: string; storage?: DocumentStore }) {
  let records: Record<string, Row> = {};
  try {
    // The original JSON remains available as migration evidence after the first SQLite commit.
    const parsed: unknown = storage?.read() ?? JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!parsed || typeof parsed !== "object" || (parsed as any).version !== 1 ||
        !(parsed as any).records || typeof (parsed as any).records !== "object" || Array.isArray((parsed as any).records))
      throw new Error("Invalid Mining Mission journal; recovery evidence must be preserved.");
    records = (parsed as {records: Record<string, Row>}).records;
    for (const [key,row] of Object.entries(records)) {
      if (!/^\d+:\d+$/.test(key) || !row || typeof row !== "object" || typeof row.scriptHash !== "string" ||
          !row.state || row.state.version !== 2 || !Number.isSafeInteger(row.state.revision) || row.state.revision < 1 ||
          !Number.isSafeInteger(row.state.characterID) || key.split(":")[1] !== String(row.state.characterID) ||
          typeof row.state.epoch !== "string" || !["ready","request","review","accept","outbound","entry","mining","return","bank","unload","complete","done"].includes(row.state.phase) ||
          !(row.receipt === null || (typeof row.receipt === "object" && typeof row.receipt.id === "string" &&
            row.receipt.dispatched === true && row.state.pending?.id === row.receipt.id &&
            typeof row.receipt.acknowledged === "boolean" && typeof row.receipt.missionCompleted === "boolean")))
        throw new Error("Invalid Mining Mission record; recovery evidence must be preserved.");
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  function put(key: string, row: Row) {
    const next = {...records, [key]: clone(row)};
    if (storage) {
      storage.write({ version: 1, records: next });
      records = next;
      return;
    }
    fs.mkdirSync(path.dirname(filePath), {recursive:true});
    const temp = `${filePath}.${process.pid}.tmp`;
    const fd = fs.openSync(temp, "w");
    try { fs.writeFileSync(fd, JSON.stringify({version:1, records:next})); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(temp,filePath);
    records = next;
  }
  return {
    issueFor(accountID: number, characterID: number, scriptHash: string) {
      const row=records[keyFor(accountID,characterID)];
      return row && row.state.phase !== "done" && row.scriptHash !== scriptHash
        ? {code:"MINING_MISSION_RECOVERY_REQUIRED", state:"RECOVERY_REQUIRED", reason:"An unfinished Mining Mission belongs to another script revision."} : null;
    },
    open({accountID,characterID,scriptHash,epoch,assertCurrent}: {accountID:number;characterID:number;scriptHash:string;epoch:string;assertCurrent:()=>boolean}) {
      if (![accountID,characterID].every(n=>Number.isSafeInteger(n)&&n>0) || !scriptHash || !epoch) throw new Error("Invalid Mining Mission custody identity.");
      const key=keyFor(accountID,characterID);
      const check=()=>{if(assertCurrent()!==true) throw new Error("Mining Mission custody changed.");};
      const read=()=>{
        check(); const row=records[key];
        if(row && row.state.phase!=="done" && row.scriptHash!==scriptHash)
          throw Object.assign(new Error("RECOVERY_REQUIRED: An unfinished Mining Mission belongs to another script revision."),{code:"MINING_MISSION_RECOVERY_REQUIRED"});
        return row;
      };
      return {characterID,epoch,assertCurrent:check,
        read(){const row=read();return {state:row ? clone(row.state):null,receipt:row?.receipt ? clone(row.receipt):null};},
        async save(state: MiningMissionState){
          const row=read();
          if(state.version!==2 || state.characterID!==characterID || !Number.isSafeInteger(state.revision) || state.revision<1)
            throw new Error("Invalid Mining Mission checkpoint identity.");
          if(state.epoch!==epoch) throw new Error("Stale Mining Mission run.");
          if(row && state.revision===row.state.revision && JSON.stringify(state)===JSON.stringify(row.state)) return;
          if(state.revision!==(row ? row.state.revision+1 : 1)) throw new Error("Stale Mining Mission checkpoint.");
          check(); put(key,{scriptHash,state,receipt:row?.state.pending?.id===state.pending?.id ? row?.receipt ?? null : null});
        },
        async dispatch(id:string){
          const row=read();
          if(!row?.state.pending || row.state.pending.id!==id || row.state.epoch!==epoch || row.receipt)
            throw new Error("RECOVERY_REQUIRED: Consequential Mining Mission action is unresolved or stale; no replay.");
          check(); put(key,{...row,receipt:{id,dispatched:true,acknowledged:false,missionCompleted:false}});
        },
        async acknowledge(id:string,missionCompleted=false){
          const row=read();
          if(row?.state.pending?.id!==id || row.receipt?.id!==id || row.state.epoch!==epoch)
            throw new Error("RECOVERY_REQUIRED: Mining Mission receipt no longer belongs to this owner.");
          check();put(key,{...row,receipt:{id,dispatched:true,acknowledged:true,missionCompleted:missionCompleted===true}});
        },
      };
    },
  };
}
