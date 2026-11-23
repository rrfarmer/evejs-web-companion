import test from 'node:test';
import assert from 'node:assert/strict';
import {readFactoryAccount,readFactoryWorld} from './factoryClient.ts';
import {continueNewTrainee,pendingTraineeKey} from './newTrainee.ts';
import {authenticatedJson,installPageContext,worldID} from '../app/context.ts';
import {installTrainingAdapter,readTrainingActiveShip,readTrainingWorld} from '../adapters/training.ts';
import {readSelectedTrainee,rememberSelectedTrainee,trainingWorldStorage} from './worldStorage.ts';
import {worldRoute} from '../../shared/backendScope.ts';
import type {Session} from '../../../../web/src/plugin-api/index.ts';

test('Training account form reads the roster after recovering a legacy account entry',async()=>{
 const saved=new Map([[pendingTraineeKey,JSON.stringify({username:'Trainee',characterName:'Old form prefill'})]]);
 const storage={getItem:(key:string)=>saved.get(key)??null,setItem:(key:string,value:string)=>{saved.set(key,value);},removeItem:(key:string)=>{saved.delete(key);}};
 const calls:string[]=[];
 const result=await continueNewTrainee({username:'Trainee',password:'fixture',confirmation:'fixture'},storage,{
  create:async()=>{throw Error('Account create must not be sent again');},
  recover:async username=>{calls.push('recover');return {status:'ACCOUNT_RECOVERED',account:{username,accountID:1}};},
  login:async account=>{calls.push('login');return {account,token:'fixture-token'};},
  roster:async options=>{calls.push('roster');assert.equal(options.token,'fixture-token');return {account:'Trainee',characters:[]};},
 });
 assert.deepEqual(calls,['recover','login','roster']);
 assert.deepEqual(result,{account:'Trainee',characters:[],requestOptions:{token:'fixture-token'}});
 assert.equal(saved.size,0);
});

test('Training roster reuses the actual workspace account authorization without Login or pilot Select',async()=>{
 const options={token:'cockpit-token',baseUrl:'https://fixture.invalid',fetch:async()=>{throw Error('Unexpected transport');}};
 const session={id:'real-page',store:{get:()=>({session:{username:'Pilot'}})},flow:{sessionToken:()=>options.token,requestOptions:()=>options}} as unknown as Session;
 installPageContext({sessions:[session]});
 let name='Pilot',reads=0;
 installTrainingAdapter({authenticatedJson:async(path,asked)=>{assert.equal(path,'/api/pilot-training/characters');assert.equal(asked,options);reads++;return {account:name,characters:[{characterID:7,name:'Pilot'}]};},runHosted:async()=>{throw Error('No host acquisition');}});
 try {
  const result=await readFactoryAccount('pilot');
  assert.equal(result.requestOptions,options);assert.equal(result.characters[0]?.characterID,7);assert.equal(reads,1);
  name='Other account';await assert.rejects(readFactoryAccount('pilot'),/identity changed/);
 } finally {installPageContext({});installTrainingAdapter(null);}
});

test('Training uses the account response to scope a roster refresh with one plugin request',async()=>{
 const scope='wc-install:'+'a'.repeat(64);
 const accounts=['Miner1','Miner2'].map((username,i)=>({accountID:i+1,username,options:{token:username}}));
 const paths:string[]=[];
 installPageContext({readAccounts:()=>accounts,fetch:async(input,init)=>{
  const path=String(input);
  paths.push(path);
  const token=new Headers(init?.headers).get('authorization');
  const account=accounts.find(a=>`Bearer ${a.options.token}`===token);
  assert.ok(account);
  if(path==='/api/plugins/uoc/center/account')return Response.json({ok:true,account:{accountID:account.accountID,username:account.username},worldID:scope});
  assert.equal(path,'/api/pilot-training/characters');
  return Response.json({ok:true,account:account.username,characters:[{characterID:100+account.accountID,name:account.username}]});
 }});
 installTrainingAdapter({authenticatedJson,worldID,runHosted:async()=>assert.fail('A roster refresh must not acquire a pilot.')});
 try{
  assert.equal(await readFactoryWorld(),scope);
  for(const {username} of accounts)assert.equal((await readFactoryAccount(username)).account,username);
  assert.deepEqual(paths,['/api/plugins/uoc/center/account','/api/pilot-training/characters','/api/pilot-training/characters']);
 }finally{installTrainingAdapter(null);installPageContext({});}
});

test('Training reads the selected offline pilot’s ship from character selection data',async()=>{
 const options={token:'miner-account'},paths:string[]=[];
 let name:string|null='Impairor';
 const character=(id:number,shipName:string|null,shipTypeID:number)=>({type:'object',name:'util.KeyVal',args:{type:'dict',entries:[
  ['characterID',id],['shipName',shipName],['shipTypeID',shipTypeID],
 ]}});
 installTrainingAdapter({authenticatedJson:async(path,asked,body)=>{
  assert.equal(asked,options);
  paths.push(path);
  if(path==='/api/roster/characters')return {result:[{type:'list',items:[]},null,{type:'list',items:[
   character(12,'Omen',2006),character(77,name,596),
  ]},{type:'list',items:[]}]};
  assert.equal(path,'/api/names');
  assert.deepEqual(body,{items:[{kind:'type',id:596}]});
  return {names:{'type:596':'Impairor'}};
 },runHosted:async()=>assert.fail('A display read must not acquire a pilot.')});
 try{
  assert.equal(await readTrainingActiveShip(77,options),'Impairor');
  assert.deepEqual(paths,['/api/roster/characters']);
  assert.equal(await readTrainingActiveShip(78,options),null);
  name=null;
  assert.equal(await readTrainingActiveShip(77,options),'Impairor');
  assert.deepEqual(paths,['/api/roster/characters','/api/roster/characters','/api/roster/characters','/api/names']);
 }finally{installTrainingAdapter(null);}
});

test("Training accepts the authenticated WC76 installation identity from the backend world route", async () => {
 const savedDirectory = process.env.EVEJS_PLUGIN_DATA_DIR;
 process.env.EVEJS_PLUGIN_DATA_DIR = "fixture/wc76/plugins/uoc";
 const request = { account:{accountID:1,username:"West"}, method:"GET", path:"/world", query:{}, params:{}, body:null };
 try {
  const reply=await worldRoute(request);
  const fixture=reply.body as {worldID:string};
  assert.match(fixture.worldID,/^wc-install:[a-f0-9]{64}$/);
  const calls:string[]=[];
  installPageContext({fetch:async (url, init) => {
   assert.equal(new Headers(init?.headers).get("authorization"),"Bearer west-account");
   assert.equal(String(url),"/api/plugins/uoc/world");
   calls.push(String(url));
   return Response.json(reply.body);
  }});
  installTrainingAdapter({authenticatedJson,worldID,runHosted:async()=>assert.fail("A world read must not acquire a pilot.")});
  assert.deepEqual(await readTrainingWorld({token:"west-account"}),{worldID:fixture.worldID});
  assert.equal(calls.length,1);

  const invalid=["wc-install:bad","f".repeat(63),"fixture:"+"f".repeat(64),null];
  for(const id of invalid){
   installTrainingAdapter({authenticatedJson,worldID:async()=>id,runHosted:async()=>assert.fail("No pilot acquisition.")});
   assert.deepEqual(await readTrainingWorld({token:"west-account"}),{worldID:null});
  }
 } finally {
  if(savedDirectory===undefined)delete process.env.EVEJS_PLUGIN_DATA_DIR;
  else process.env.EVEJS_PLUGIN_DATA_DIR=savedDirectory;
  installTrainingAdapter(null);
  installPageContext({});
 }
});

test("the selected trainee reopens under the same world and exact authenticated roster", async () => {
 const values=new Map<string,string>();
 const storage={getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value);}};
 let scope:string|null="wc-install:"+"a".repeat(64);
 const trainee={account:"BWorker",characterID:24};
 const token={token:"trainee-account"};
 rememberSelectedTrainee(trainingWorldStorage(storage,()=>scope),trainee);
 const calls:string[]=[];
 installPageContext({readAccounts:()=>[{accountID:2,username:trainee.account,options:token}]});
 installTrainingAdapter({authenticatedJson:async(path,options)=>{
  assert.equal(path,"/api/pilot-training/characters");
  assert.equal(options,token);
  calls.push(path);
  return {account:trainee.account,characters:[{characterID:24,name:"FixtureMiner4"},{characterID:25,name:"FixtureMiner5"}]};
 },runHosted:async()=>assert.fail("Restoring the trainee's card must not acquire a pilot.")});
 try {
  const reopened=readSelectedTrainee(trainingWorldStorage(storage,()=>scope));
  assert.deepEqual(reopened,trainee);
  const roster=await readFactoryAccount(reopened!.account);
  assert.equal(roster.characters.find(p=>p.characterID===reopened!.characterID)?.name,"FixtureMiner4");
  assert.equal(calls.length,1);
  assert.ok([...values.values()].every(value=>!value.includes(token.token)));
  scope="wc-install:"+"b".repeat(64);
  assert.equal(readSelectedTrainee(trainingWorldStorage(storage,()=>scope)),null);
  scope=null;
  assert.equal(readSelectedTrainee(trainingWorldStorage(storage,()=>scope)),null);
 } finally {
  installTrainingAdapter(null);
  installPageContext({});
 }
});
