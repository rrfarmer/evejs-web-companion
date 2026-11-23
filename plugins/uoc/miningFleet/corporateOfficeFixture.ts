/** The Farmer office endpoint and held corporation RPCs used by MCC tests. */
export function officeList(stationIDs: readonly number[] = [600]) {
  return {ok:true,stationIDs,divisions:Array.from({length:7},(_,i)=>({division:i+1,name:null})),error:null};
}

export function corporationRow(method:string, characterID:number, corporationID:number, rolesAtOther=1048576n) {
  if(method==="GetCorporation")return {type:"object",name:"util.Row",args:{type:"dict",entries:[
    ["header",{type:"list",items:["corporationID","stationID"]}],
    ["line",{type:"list",items:[corporationID, null]}],
  ]}};
  if(method==="GetMember")return {type:"packedrow",fields:{characterID,corporationID,baseID:null,titleMask:0,
    roles:0,rolesAtHQ:0,rolesAtBase:0,rolesAtOther:{type:"long",value:String(rolesAtOther)}}};
  throw Error("Unexpected corporation read: "+method);
}

export function titlesRowset(rows: readonly {titleID:number;corporationID:number;roles?:unknown;
  rolesAtHQ?:unknown;rolesAtBase?:unknown;rolesAtOther?:unknown}[]) {
  return {type:"objectex2",header:[
    [{type:"token",value:"carbon.common.script.sys.crowset.CIndexedRowset"}],
    {type:"dict",entries:[["idName","titleID"],["columnName","titleID"]]},
  ],list:[],dict:rows.map(fields=>[fields.titleID,{type:"packedrow",
    fields:{roles:0,rolesAtHQ:0,rolesAtBase:0,rolesAtOther:0,...fields}}])};
}
