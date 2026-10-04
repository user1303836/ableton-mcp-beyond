// Source-generated bridge transcripts. The retained synthetic bridge owns Live state;
// only the wait clock advances instantly. Production rendering and audio code run unchanged.
import {readFileSync,writeFileSync,unlinkSync,mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';import {tmpdir} from 'node:os';import {pathToFileURL} from 'node:url';
const root=process.env.KUMI_TS_REFERENCE??new URL('../../../..',import.meta.url).pathname;
const original=pathToFileURL(join(root,'packages/runtime/dist/src/integrations/ableton/index.js'));
const module=new URL('index.rendering-oracle.js',original),fixtureOriginal=pathToFileURL(join(root,'packages/runtime/dist/test/fixtures/synthetic-bridge.js')),fixtureModule=new URL('synthetic-rendering-oracle.js',fixtureOriginal);
const scratch=mkdtempSync(join(tmpdir(),'kumi-rendering-oracle-'));let clock=100000;globalThis.renderClock=()=>clock;const oldNow=Date.now;Date.now=()=>clock;
globalThis.renderDelay=async(ms,_,{signal}={})=>{signal?.throwIfAborted();clock+=Math.max(1,Math.trunc(ms));await Promise.resolve();signal?.throwIfAborted();};
let source=readFileSync(original,'utf8').replace('import { setTimeout as delay } from "node:timers/promises";','const delay=(...args)=>globalThis.renderDelay(...args);');
const marker='    return {\n        async start(signal) {\n            if (closed || started)';if(!source.includes(marker))throw Error('source hook changed');
source=source.replace(marker,`    return {
      async _ready(c){await tools.refresh(new AbortController().signal);available=c.available??true;lost=c.lost??false;currentEpoch=c.noEpoch?undefined:7;currentTempo=c.noTempo?undefined:120;currentSet='fixture';project={identity:'fixture',name:'Fixture Set',...(c.path?{path:c.path}:{})};},
      _audition:audition,_hear:hearInSet,_goal:openGoal,_restore:restoreAfterCrash,_reset(c){if(!c)rounds={count:0,best:undefined};},_bump(){observationGeneration++;},
      _state(){return {changes:[...changes.values()].map(e=>e.record),round:rounds.count,best:rounds.best,rendering,earsRefused};},
      async start(signal){if(closed||started)`);writeFileSync(module,source);
let fixtureSource=readFileSync(fixtureOriginal,'utf8').replace('../../src/integrations/ableton/index.js','../../src/integrations/ableton/index.rendering-oracle.js').replace('const integration = createAbletonIntegration({','const integration = createAbletonIntegration({now:()=>new Date(0),generation:"connection",').replace('        integration, requests,','        endpoint, integration, requests,');
if(!fixtureSource.includes('endpoint, integration, requests'))throw Error('fixture hook changed');writeFileSync(fixtureModule,fixtureSource);
function wav(kind){const frames=48000*12,data=Buffer.alloc(44+frames*4);data.write('RIFF');data.writeUInt32LE(data.length-8,4);data.write('WAVEfmt ',8);data.writeUInt32LE(16,16);data.writeUInt16LE(1,20);data.writeUInt16LE(2,22);data.writeUInt32LE(48000,24);data.writeUInt32LE(192000,28);data.writeUInt16LE(4,32);data.writeUInt16LE(16,34);data.write('data',36);data.writeUInt32LE(frames*4,40);let seed=7;for(let i=0;i<frames;i++){seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;const value=kind==='silence'?0:kind==='noise'?(seed>>>0)%16001-8000:i%436<218?8000:-8000;data.writeInt16LE(value,44+i*4);data.writeInt16LE(value,46+i*4);}const file=join(scratch,kind+'.wav');writeFileSync(file,data);return file;}
const audio={square:wav('square'),noise:wav('noise'),silence:wav('silence')};
const normalize=value=>JSON.parse(JSON.stringify(value,(key,value)=>key==='seconds'&&typeof value==='number'?Math.round(value*1e6)/1e6:value).replaceAll(scratch,'$AUDIO').replaceAll(join(tmpdir(),'kumi-ears','connecti'),'$EARS').replace(/Kumi · render (\d+) [a-f0-9]{4}/g,'Kumi · render $1 <tag>').replace(/Kumi · Goal best [a-f0-9]{3}/g,'Kumi · Goal best <tag>').replace(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/g,'<uuid>').replace(/"a[0-9a-f]{8}"/g,'"<audition>"').replace(/\bc\d+\b/g,'<change>'));
const earsSource=readFileSync(join(root,'packages/runtime/dist/test/ears.test.js'),'utf8');
const {EARS_ITEM,EARS_VERSION}=await import(pathToFileURL(join(root,'packages/runtime/dist/src/ears/device.js')));
const capture=eval('('+earsSource.slice(earsSource.indexOf('function capture('),earsSource.indexOf('\ntest(',earsSource.indexOf('function capture(')))+')');
const fakeEars=eval('('+earsSource.slice(earsSource.indexOf('function fakeEars('),earsSource.indexOf('\nconst reference',earsSource.indexOf('function fakeEars(')))+')');
const sounds=Object.fromEntries(Object.entries(audio).map(([name,path])=>{const bytes=readFileSync(path);const sound=new Float32Array((bytes.length-44)/4);for(let i=0;i<sound.length;i++)sound[i]=bytes.readInt16LE(44+i*4)/32768;return[name,sound];}));
const cases=[];const signal=()=>new AbortController().signal;
const both={candidates:[{track:'Fixture Bass',label:'Saw'},{track:'Fixture Drums',label:'Noise'}],fromBeat:8,beats:2,reference:audio.square,focus:'sound'};
try{const{bridge}=await import(fixtureModule.href);
async function run(label,config,operations){
 const restoreFile=join(scratch,'restore.json');try{unlinkSync(restoreFile);}catch{};
 const earsCalls=[];let b;const armed=new Map();
 const ears=config.ears?fakeEars(()=>b,path=>sounds[/tracks 1 /.test(path)?'noise':'square'],{silent:config.ears==='silent'}):undefined;
 const earsSetup=ears?{open:async()=>{const link=await ears.open();const wrapped={...link};
  for(const method of ['taps','stop'])wrapped[method]=(...args)=>{const result=link[method](...args);earsCalls.push({method,args,result:result??null});return result;};
  wrapped.waitFor=async(match,ms,signal)=>{let result;if(config.ears==='silent'){clock+=ms;result=undefined;}else result=await link.waitFor(match,ms,signal);earsCalls.push({method:'waitFor',args:[ms],result:result??null});return result;};
  for(const method of ['arm','write','transport','close'])wrapped[method]=async(...args)=>{let recipe;
   if(method==='arm')armed.set(args[0].id,{requests:b.requests.length,position:b.position,playing:b.transport.playing});
   if(method==='write'){const at=armed.get(args[0].id);const jump=b.requests.slice(at.requests).filter(r=>r.name==='live_transport_preview'&&typeof r.args.position==='number').at(-1)?.args.position;recipe={...at,jump,kind:/tracks 1 /.test(args[0].path)?'noise':'square'};}
   const result=await link[method](...args);earsCalls.push({method,args:args.filter(v=>!(v instanceof AbortSignal)),result:result??null,...(recipe?{capture:recipe}:{})});return result;};return wrapped;}}:undefined;
 b=bridge({transport:true,version:config.version??'1.0.73',renders:(source)=>config.noFiles?undefined:config.silent?audio.silence:source==='Fixture Drums'?audio.noise:audio.square,restoreFile,lateRecord:config.lateRecord,noPlayOnRecord:config.noPlayOnRecord,fast:false,extraTracks:config.extraTracks,ears:earsSetup,audioClip:config.audioClip?audio.square:undefined});
 const calls=[],releases=[],responses=[],results=[];let controller,refused=false;
 const originalCall=b.endpoint.call.bind(b.endpoint);b.endpoint.call=async(name,args,sig)=>{const target=name==='live_transaction_release'?releases:calls;target.push({name,args:structuredClone(args)});let response;try{if(config.cancelOn===name&&!refused){refused=true;controller.abort();}if((config.refuseParameter&&name==='live_device_parameter_preview'&&args.deviceRef?.endsWith(':d0')&&args.values?.some(v=>v.parameterRef.endsWith(':0')))||(config.refuseMainBack&&name==='live_mixer_preview'&&args.volume>0))response={reply:{isError:true,content:[{type:'text',text:'fixture refused'}],structuredContent:{message:'fixture refused'}}};else response={reply:await originalCall(name,args,sig)};if((config.noMainLevel||Object.hasOwn(config,'mainMixer'))&&name==='live_discover'&&args.kind==='main-track'){const body=response.reply.structuredContent;if(config.noMainLevel)delete body.items[0].mixer.volume;else body.items[0].mixer=config.mainMixer;response.reply.content=[{type:'text',text:JSON.stringify(body)}];}}catch(error){response={throw:error.name==='AbortError'?'cancelled':error.message};}if(name!=='live_transaction_release')responses.push(structuredClone(response));if(response.throw)throw response.throw==='cancelled'?new DOMException('This operation was aborted','AbortError'):Error(response.throw);return response.reply;};
 await b.integration.start(signal());await b.integration._ready(config);const tools=(await b.endpoint.list()).tools;
 if(config.arm)b.arm(1);if(config.playing)b.startPlayback(200);if(config.fail)b.failNext(config.fail);if(config.undoRefused)b.refuseUndo(config.undoRefused);
 if(config.pending){writeFileSync(restoreFile,JSON.stringify(config.pending));b.main.volume=0;}
 let goal;const expanded=[];
 for(const given of operations){const op=structuredClone(given);controller=new AbortController();if(op.abort)controller.abort();let value;
  try{
   if(op.type==='reset'){b.integration._reset(op.continuing??false);value=null;}
   if(op.type==='bump'){b.integration._bump();value=null;}
   if(op.type==='audition'){value=await b.integration._audition(op.request,controller.signal);if(typeof value!=='string')value.seconds=0;}
   if(op.type==='hear')value=await b.integration._hear(op.request,controller.signal);
   if(op.type==='restore')value=(await b.integration._restore(op.identity,op.path,controller.signal))??null;
   if(op.type==='open'){goal=await b.integration._goal(op.request,controller.signal);value=typeof goal==='string'?goal:{slots:goal.slots,screens:goal.screens};}
   if(op.type==='generation'){op.trials??=goal.slots.map(slot=>({slot:slot.name,knobs:slot.knobs.filter(k=>!k.device.endsWith(':Limiter')),values:slot.knobs.filter(k=>!k.device.endsWith(':Limiter')).map(k=>op.change??k.value),...(op.fresh?{fresh:true}:{})}));const v=await goal.generation(op.trials,controller.signal,op.options);value={...v,scores:Object.fromEntries(v.scores),gaps:Object.fromEntries(v.gaps),frozen:Object.fromEntries([...v.frozen].map(([k,v])=>[k,[...v]])),structural:Object.fromEntries(v.structural)};}
   if(op.type==='add')value=await goal.add(op.candidate,controller.signal);
   if(op.type==='settle'||op.type==='keep'){op.slot??=goal.slots[0].name;op.knobs??=goal.slots[0].knobs;op.values??=op.knobs.map(k=>k.value);value=(await goal[op.type==='keep'?'keepBest':'settle'](op.slot,op.knobs,op.values,controller.signal))??null;}
   if(op.type==='tidy')value=await goal.tidy(op.top??[],controller.signal);
   if(op.type==='close')value=await goal.close();
  }catch(error){value={error:error.name==='AbortError'?'cancelled':error.message};}
  await new Promise(resolve=>setImmediate(resolve));expanded.push(op);results.push(structuredClone({value,state:b.integration._state(),main:b.main.volume,tracks:b.trackNames(),armed:b.armed(),playing:b.transport.playing,recording:b.transport.arrangementRecord,restore: (()=>{try{return JSON.parse(readFileSync(restoreFile,'utf8'));}catch{return null;}})()}));
 }
 const item={label,config,operations:expanded,calls,responses,releases,events:b.records,actions:b.actions,auditions:b.auditions,results,tools,earsCalls};await b.integration.close();cases.push(normalize(item));console.log(label,calls.length);
}
await run('two-candidates-and-second-round',{arm:true},[{type:'audition',request:both},{type:'reset',continuing:true},{type:'audition',request:{...both,candidates:[both.candidates[1]]}},{type:'reset'},{type:'audition',request:{...both,candidates:[both.candidates[0]]}}]);
for(const fromBeat of [0,2,32])for(const noPlayOnRecord of [false,true])await run('transport-'+fromBeat+'-'+noPlayOnRecord,{noPlayOnRecord},[{type:'audition',request:{...both,fromBeat,candidates:[both.candidates[0]]}}]);
for(const lateRecord of [10,30])await run('late-pass-'+lateRecord,{lateRecord},[{type:'audition',request:{...both,fromBeat:32,candidates:[both.candidates[0]]}}]);
for(const fail of ['back-to-arrangement','live_routing_preview','live_session_structure_apply','live_mixer_preview','live_recording_apply'])await run('refused-'+fail,{fail},[{type:'audition',request:both}]);
for(const cancelOn of ['live_recording_apply','live_mixer_apply','live_routing_apply'])await run('cancel-'+cancelOn,{cancelOn},[{type:'audition',request:both}]);
await run('silent',{silent:true},[{type:'audition',request:both}]);await run('no-files',{noFiles:true},[{type:'audition',request:both}]);
await run('mix',{},[{type:'audition',request:{...both,candidates:[{track:'the whole mix',mix:true}],focus:'section'}},{type:'open',request:{...both,candidates:[{track:'the whole mix',mix:true}]}}]);
await run('session-clip',{audioClip:true},[{type:'audition',request:{...both,candidates:[{track:'Fixture Bass',clip:'scene:0'}],fromBeat:undefined}}]);
await run('no-reference',{},[{type:'audition',request:{...both,reference:undefined}}]);
for(const config of [{version:'1.0.48'},{available:false},{lost:true},{noEpoch:true},{noTempo:true}])await run('gate',config,[{type:'audition',request:both},{type:'hear',request:{tracks:['Fixture Bass']}},{type:'open',request:both}]);
for(const pending of [{set:'fixture',volume:.85,at:1,scratch:['old render']},{set:'other',volume:.5,at:1},{set:'old',path:'/fixture/song.als',volume:.85,at:1}])await run('restore',{pending},[{type:'restore',identity:'fixture',path:'/fixture/song.als'}]);
for(const request of [{tracks:['Fixture Bass'],fromBeat:8,beats:2},{tracks:[],mix:true,fromBeat:8,beats:2},{tracks:['Missing'],fromBeat:0},{tracks:['Fixture Bass'],fromBeat:0,beats:2}])await run('hear',{},[{type:'hear',request}]);
const synth={name:'Synth',className:'Synth',params:[{name:'Tone',value:.5,min:0,max:1},{name:'Drive',value:.2,min:0,max:1}]};const candidate={track:'Candidate',label:'Candidate'};const goalRequest={...both,candidates:[candidate],fromBeat:8,beats:2};
await run('held-goal-cache-settle-best',{extraTracks:[{name:'Candidate',devices:[synth]}],arm:true},[{type:'open',request:goalRequest},{type:'generation'},{type:'generation'},{type:'generation',change:.7},{type:'generation',change:.7,fresh:true},{type:'settle'},{type:'keep'},{type:'keep'},{type:'tidy',top:['Candidate']},{type:'close'}]);
await run('goal-screen',{extraTracks:[{name:'Candidate',devices:[synth]}]},[{type:'open',request:{...goalRequest,beats:16}},{type:'generation',options:{screen:true}},{type:'generation',options:{screen:true}},{type:'generation'},{type:'close'}]);
await run('ears-both',{ears:true},[{type:'audition',request:both}]);
await run('ears-silent-fallback',{ears:'silent'},[{type:'audition',request:{...both,candidates:[both.candidates[0]]}},{type:'audition',request:{...both,candidates:[both.candidates[0]]}}]);
await run('ears-old-bridge',{ears:true,version:'1.0.72'},[{type:'audition',request:{...both,candidates:[both.candidates[0]]}}]);
await run('ears-hear-playing',{ears:true,playing:true},[{type:'hear',request:{tracks:['Fixture Bass','Fixture Drums'],seconds:2}}]);
await run('ears-mix',{ears:true},[{type:'audition',request:{...both,candidates:[{track:'the whole mix',mix:true}],focus:'section'}}]);
await run('ears-refused-load',{ears:true,fail:'live_browser_load_preview'},[{type:'audition',request:{...both,candidates:[both.candidates[0]]}}]);
await run('main-unknown',{noMainLevel:true},[{type:'audition',request:both}]);
await run('main-restore-refused',{refuseMainBack:true},[{type:'audition',request:both}]);
await run('scratch-undo-refused',{undoRefused:'modified after apply'},[{type:'audition',request:both}]);
await run('main-left-silent',{pending:{set:'fixture',volume:.65,at:1}},[{type:'audition',request:both}]);
await run('goal-refused-knob',{extraTracks:[{name:'Candidate',devices:[synth]}],refuseParameter:true},[{type:'open',request:goalRequest},{type:'generation',change:.7},{type:'bump'},{type:'generation',change:.7},{type:'close'}]);
await run('goal-add-and-tidy',{extraTracks:[{name:'Candidate',devices:[synth]}]},[{type:'open',request:goalRequest},{type:'add',candidate:{track:'track:2',label:'Drums'}},{type:'add',candidate:{track:'track:2'}},{type:'add',candidate:{track:'not a track'}},{type:'generation'},{type:'tidy',top:['Candidate']},{type:'close'}]);
await run('goal-ears-held',{ears:true,extraTracks:[{name:'Candidate',devices:[synth]}]},[{type:'open',request:goalRequest},{type:'generation'},{type:'generation',change:.7},{type:'close'}]);
for(const mainMixer of [false,42,'mixer',[],null,{}, {volume:'loud'}])await run('main-malformed-'+JSON.stringify(mainMixer),{mainMixer},[{type:'audition',request:both}]);
for(const ears of [false,true])await run('empty-candidates-'+ears,{ears},[{type:'audition',request:{...both,candidates:[]}}]);
writeFileSync(new URL('rendering-oracle.json'  ,import.meta.url),JSON.stringify({cases})+'\n');console.log(cases.length+' source rendering sequences');
}finally{Date.now=oldNow;unlinkSync(module);unlinkSync(fixtureModule);rmSync(scratch,{recursive:true,force:true});}
