import test from 'node:test';
import assert from 'node:assert/strict';
import {createTrainingAccountPass} from './accountPass.ts';
import {createPilotReach} from '../../../web/src/app/pilotReach.ts';

test('unknown account uses existing-only login and creates no account',async()=>{
  const urls:string[]=[];const pass=createTrainingAccountPass(async(url)=>{urls.push(String(url));return Response.json({ok:false,error:'UNKNOWN_EVEJS_ACCOUNT',message:'Unknown EveJS account.'},{status:401});});
  await assert.rejects(pass.optionsFor('typo'),/Unknown EveJS account/);await pass.release();assert.deepEqual(urls,['/api/pilot-training/login']);
});
test('concurrent account reads share login and release only minted tokens',async()=>{
  const calls:any[]=[];const pass=createTrainingAccountPass(async(url,init)=>{calls.push([String(url),init]);return Response.json(String(url).endsWith('/login')?{ok:true,sessionToken:'owned',account:{username:'hr'}}:{ok:true});});
  const held:any={store:{station:{get:()=>({online:{characterID:1}})}},flow:{requestOptions:()=>({token:'held'})}};
  const reach=createPilotReach({held:()=>[held],known:()=>[{characterID:1,accountName:'cockpit'},{characterID:2,accountName:'hr'}],accounts:()=>[],pass});
  assert.equal((await reach.ownerOptions(1)).token,'held');
  const answers=await Promise.all([reach.accountOptions('hr'),reach.ownerOptions(2)]);assert.deepEqual(answers.map(x=>x.token),['owned','owned']);
  pass.forget('hr');await reach.release();await reach.release();
  assert.deepEqual(calls.map(x=>x[0]),['/api/pilot-training/login','/api/logout']);assert.equal(new Headers(calls[1][1].headers).get('authorization'),'Bearer owned');assert.equal(calls[0][1].credentials,'omit');
});
test('release waits for a forgotten in-flight login and revokes only its token',async()=>{
 let finish!:(v:Response)=>void;const calls:any[]=[];
 const pass=createTrainingAccountPass(async(url,init)=>{calls.push([String(url),init]);return String(url).endsWith('/login')?await new Promise<Response>(r=>finish=r):Response.json({ok:true});});
 const request=pass.optionsFor('hr');pass.forget('hr');const released=pass.release();finish(Response.json({ok:true,sessionToken:'late',account:{username:'hr'}}));
 await assert.rejects(request,/closed/);await released;assert.deepEqual(calls.map(c=>c[0]),['/api/pilot-training/login','/api/logout']);assert.equal(new Headers(calls[1][1].headers).get('authorization'),'Bearer late');
});
