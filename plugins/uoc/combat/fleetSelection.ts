export interface FleetPilotSelection {characterID:number;accountName:string}
/** A fleet uses one positively rostered pilot per account and one selected owner. */
export function validateFleetSelection(pilots:readonly FleetPilotSelection[],chosen:readonly number[],ownerID:number,agentID:number|null,count:number,automatic=false):void{
 if(pilots.length<2||pilots.length>8||pilots.length!==chosen.length||pilots.some(p=>!Number.isSafeInteger(p.characterID)||p.characterID<=0||!p.accountName.trim())||new Set(pilots.map(p=>p.characterID)).size!==pilots.length||new Set(pilots.map(p=>p.accountName.trim().toLowerCase())).size!==pilots.length||pilots.some((p,i)=>p.characterID!==chosen[i]))throw Error('Select two to eight pilots on distinct accounts.');
 if(!pilots.some(p=>p.characterID===ownerID)||(!automatic&&(!Number.isSafeInteger(agentID)||!agentID||agentID<=0))||![1,2].includes(count))throw Error('Choose the mission owner, Security agent and mission count.');
}
