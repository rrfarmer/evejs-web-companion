import {checkPluginRun,createPluginRunGrant,startPluginRun,type ApiOptions,type JsonValue} from '../../../../web/src/plugin-api/index.ts';
import {authenticatedJson} from '../app/context.ts';
import {civilianSetup,readCivilianProfile,type CivilianProfile} from '../../civilian/profile.ts';
export {civilianSetup};
export type CivilianReview = CivilianProfile;

const profilesPath = '/api/plugins/uoc/civilian/profiles';
async function readProfiles(path: string, options: ApiOptions, body?: unknown) {
 const response = await authenticatedJson(path, options, body);
 if (!Array.isArray(response.profiles)) throw Error('Saved Civilian profiles are unreadable.');
 const workerAccounts: string[] = Array.isArray(response.workerAccounts) ? response.workerAccounts.filter((name:unknown)=>typeof name==="string") : [];
 return {profiles:response.profiles.map(readCivilianProfile) as CivilianProfile[], workerAccounts};
}
export const listCivilianProfiles = (options: ApiOptions) => readProfiles(profilesPath, options);
export const saveCivilianProfile = async (profile: CivilianProfile, options: ApiOptions) => (await readProfiles(profilesPath, options, profile)).profiles;
export const removeCivilianProfile = async (characterID: number, options: ApiOptions) => (await readProfiles(`${profilesPath}/${characterID}/remove`, options, {})).profiles;
export async function startCivilianRun(plan:CivilianReview,options:ApiOptions){
 const id=plan.pilot.characterID,[account,status,bots]=await Promise.all([authenticatedJson('/api/pilot-training/characters',options),authenticatedJson(`/api/pilot-training/ownership?characterID=${id}`,options),authenticatedJson('/api/bots',options)]);
 if(account.account?.toLowerCase()!==plan.pilot.accountName.toLowerCase()||!account.characters?.some((p:any)=>p.characterID===id)||status.ownership?.characterID!==id||status.ownership.owner!=='OFF'||status.ownership.online!==false||!Array.isArray(bots.bots)||bots.bots.some((b:any)=>!b.endedAt))throw Error('The exact Civilian pilot/account must be independently offline and free; no existing owner is displaced.');
 if(plan.parking.mode==='SELECTED'&&plan.parking.destination.kind==='structure'){const d=plan.parking.destination,r=await authenticatedJson(`/api/dockable-structures/${d.id}?characterID=${id}`,options);if(r.location?.id!==d.id||r.location.kind!=='structure'||r.location.solarSystemID!==d.solarSystemID)throw Error('Selected Upwell access changed for this pilot.');}
 const maximum = bots.hostedRunPolicy?.maxRuntimeMinutes;
 if(!Number.isSafeInteger(maximum)||maximum<1)throw Error("The server's operation time limit is unavailable.");
 const runtime = plan.policy==='COUNT' ? Math.min(maximum,4320) : plan.runtime;
 if(runtime>maximum)throw Error(`The saved time limit exceeds this server's ${maximum} minute maximum.`);
 const kind=plan.mode==='mining'?'civilian-mining':'civilian-distribution',setup=civilianSetup({...plan,runtime}),check=await checkPluginRun('uoc',kind,setup,options);return startPluginRun(id,'uoc',kind,check.setup,createPluginRunGrant(check.policy,runtime),options);
}

/** Read the exact held pilot's original plugin journal; this never dispatches a mission action. */
export async function inspectCivilianCheckpoint(characterID:number,options:ApiOptions){
 if(!Number.isSafeInteger(characterID)||characterID<=0)throw Error('Choose an account-owned pilot.');
 const {trainingAdapterContext}=await import('./training.ts');
 const result=await trainingAdapterContext().runHosted(characterID,'civilian-checkpoint',{},options),v=result.readout as any;
 if(result.phase!=='Civilian checkpoint inspected'||v?.characterID!==characterID||v.scope!=='STORED_ONLY'||v.nativeReconciled!==false||!Object.hasOwn(v,'mining')||!Object.hasOwn(v,'distribution'))throw Error(result.why??'Civilian checkpoint is unavailable.');
 return {characterID,mining:v.mining,distribution:v.distribution,scope:'STORED_ONLY' as const,nativeReconciled:false as const};
}
