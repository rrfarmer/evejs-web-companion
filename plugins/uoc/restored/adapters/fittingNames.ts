import type {ApiOptions} from '../../../../web/src/plugin-api/index.ts';
type Read=(path:string,options:ApiOptions,body?:unknown)=>Promise<any>;
/** Display metadata only; the exact fitting fingerprint still owns qualification. */
export async function fittingNames(choices:readonly any[],options:ApiOptions,read:Read):Promise<any[]> {
 const ids=[...new Set<number>(choices.map(x=>x.goalTypeID).filter(x=>Number.isSafeInteger(x)&&x>0))];
 const groups=new Map<number,number>(),names:Record<string,string>={};
 try {
  for(let at=0;at<ids.length;at+=100){
   const chunk=ids.slice(at,at+100),meta=await read(`/api/client-data/type-meta?typeIDs=${chunk.join(',')}`,options);
   if(meta?.available===true)for(const id of chunk){const g=meta.types?.[id]?.groupID;if(Number.isSafeInteger(g)&&g>0)groups.set(id,g);}
  }
  const items=[...ids.map(id=>({kind:'type',id})),...[...new Set(groups.values())].map(id=>({kind:'group',id}))];
  for(let at=0;at<items.length;at+=100){const result=await read('/api/names',options,{items:items.slice(at,at+100)});for(const [key,value] of Object.entries(result?.names??{}))if(typeof value==='string'&&value.trim())names[key]=value;}
 }catch{/* An unavailable display catalogue cannot prove names or groups. */}
 return choices.map(x=>({...x,hullName:names[`type:${x.goalTypeID}`]??`Ship ${x.goalTypeID}`,hullGroupID:groups.get(x.goalTypeID)??null,hullGroupName:names[`group:${groups.get(x.goalTypeID)}`]??null}));
}
