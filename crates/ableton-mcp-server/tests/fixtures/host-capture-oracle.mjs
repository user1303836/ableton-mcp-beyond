// Execute the authoritative host methods with deterministic mapper faults and disposable media.
import fs from 'node:fs';
import {mkdtemp,writeFile,rm,access} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import ts from 'typescript';
const base=new URL('.',pathToFileURL(process.argv[2]));
const {McpHost}=await import(new URL('host.js',base));
const {DeterministicLiveSimulator,LIVE_PROTOCOL_VERSION}=await import(new URL('live.js',base));
const operations=['inspect','start','stop','status','emergency-stop','cleanup'].map(s=>'audio.capture.'+s);
const status={connected:true,adapter:'remote-script',epoch:1,protocol:LIVE_PROTOCOL_VERSION,capabilities:['session.read','audio.capture.resampling'],operations,provenance:'real-live'};
const plan={supported:true,fence:'a'.repeat(64),destinationTrackRef:'track:capture',captureMode:'session-slot-resampling',prior:{route:'Ext. In',arm:false,monitoring:'auto',position:0}};
const valid={setName:'Disposable',sourceSlotRef:'clip-slot:source:0',destinationSlotRef:'clip-slot:capture:0',durationSeconds:1,consent:'ephemeral-analysis-and-delete'};
const record={id:'audio_capture_fixture',captureId:'capture_fixture',epoch:1,setName:'Disposable',sourceSlotRef:valid.sourceSlotRef,destinationSlotRef:valid.destinationSlotRef,destinationTrackRef:plan.destinationTrackRef,fence:plan.fence,prior:plan.prior,durationMs:1,outputSafety:{},confirmation:'confirm',expiresAt:Date.now()+60000,state:'uncertain'};
const cleanStatus={state:'cleaned',active:false,playbackStopped:true,captureId:record.captureId,sourceSlotRef:record.sourceSlotRef,destinationSlotRef:record.destinationSlotRef,destinationTrackRef:record.destinationTrackRef};
function clean(value,root=''){if(value===undefined)return null;value=JSON.parse(JSON.stringify(value));function walk(v){if(!v||typeof v!=='object')return;if(v?.result?.content?.[0]?.text)try{v.result.content[0].text=JSON.parse(v.result.content[0].text)}catch{}for(const[k,x]of Object.entries(v)){if(typeof x==='string'){if(root&&x.includes(root))v[k]=x.replaceAll(root,'$root').replaceAll('$root\\','$root/');else if(x.startsWith('audio_capture_'))v[k]='$transaction';else if(x.startsWith('capture_'))v[k]='$capture';else if(k==='confirmation'&&x.length===43)v[k]='$confirmation';}if(['expiresAt','startedAt'].includes(k))v[k]='$time';if(['observedAt','analyzedAt','diagnosedAt','createdAt','capturedAt'].includes(k))v[k]='$iso';if(k==='diagnosisId')v[k]='$diagnosis';walk(v[k]);}}if(value?.result?.content?.[0]?.text)try{value.result.content[0].text=JSON.parse(value.result.content[0].text)}catch{}walk(value);return value;}
function ctx(c){return c?{deadline:c.deadlineMs!==undefined,...(c.signal?{signal:true}:{}),...(c.idempotencyKey?{idempotencyKey:c.idempotencyKey}:{}),...(c.transactionId?{transactionId:c.transactionId}:{})}:null;}
const test=fs.readFileSync(new URL('../../../../apps/mcp-server/test/audio-capture-host.test.ts',import.meta.url),'utf8');
const translated=ts.transpileModule(test.slice(test.indexOf('function wav('),test.indexOf('function ready(')),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
const makeFixture=Function('DeterministicLiveSimulator','LIVE_PROTOCOL_VERSION','writeFile','join',translated+';return fixture;')(DeterministicLiveSimulator,LIVE_PROTOCOL_VERSION,writeFile,join);
const temporary=await mkdtemp(join(tmpdir(),'capture-oracle-'));const f=await makeFixture(temporary);const snapshot=JSON.parse(JSON.stringify(f.state).replaceAll(temporary,'$root'));await rm(temporary,{recursive:true,force:true});
function mock(o={}){const calls=[];let n=0;const sim=new DeterministicLiveSimulator();const snap=structuredClone(o.snapshot??snapshot);const statuses=o.statuses??[cleanStatus];const adapter={status:()=>({...status,...o.status}),snapshot:()=>structuredClone(snap),get:r=>sim.get(r),invoke:()=>{throw Error('async only')},subscribe:()=>()=>{},reconnect:()=>adapter.status(),snapshotAsync:async(c,r)=>{calls.push(clean({method:'snapshot',request:r??null,context:ctx(c)}));if(o.snapshotError)throw Error('snapshot unavailable');return structuredClone(snap)},discoverAsync:async()=>({epoch:1,kind:'track',items:[],truncated:false,revision:'capture'}),getAsync:async r=>sim.get(r),invokeAsync:async(i,c)=>{calls.push(clean({method:'invoke',invocation:i,context:ctx(c)}));if(o.errors?.[i.operation])throw Error(o.errors[i.operation]);if(i.operation==='audio.capture.inspect')return Object.hasOwn(o,'plan')?o.plan:plan;if(i.operation==='audio.capture.status'){const next=statuses[Math.min(n++,statuses.length-1)];if(next?.error)throw Error(next.error);return structuredClone(next)}if(i.operation==='audio.capture.cleanup')return o.cleaned??{cleaned:true};return {stopped:true}},refreshStatusAsync:async c=>{calls.push({method:'status',context:ctx(c)});if(o.statusError)throw Error('status unavailable');return adapter.status()},reconnectAsync:async()=>adapter.status(),close:async()=>{}};return{host:new McpHost(adapter),calls};}
const rows=[];
async function run(tool,args,o={}){const {host,calls}=mock(o);let result;try{result=await host[tool](1,args)}catch(e){result={error:e.message}}rows.push({tool,args:args??null,omitted:args===undefined,options:o,result:clean(result),calls});}
for(const [tool,good]of [['liveAudioCapturePreviewAsync',valid],['liveAudioCaptureApplyAsync',{transactionId:'missing',confirmation:'confirm',idempotencyKey:'capture-key'}],['liveAudioCaptureEmergencyStopAsync',{confirmation:'emergency-stop-and-clean',captureId:record.captureId,sourceSlotRef:record.sourceSlotRef,destinationSlotRef:record.destinationSlotRef}]]){const cases=[null,[],{},0,false,'x',good,{...good,extra:true}];for(const key of Object.keys(good)){const omitted={...good};delete omitted[key];cases.push(omitted);for(const value of [null,[],{},false,0,-1,.5,1,9,9.1,'','x','a'.repeat(257)])cases.push({...good,[key]:value});}if(tool.includes('Preview'))for(const outputSafety of [null,{},[],{safe:true,provenance:'hardware',scope:'x'}, {safe:false,provenance:'hardware'},{safe:true,provenance:'unknown'},{safe:true,provenance:'simulator'},{safe:true,provenance:'hardware',extra:1}])cases.push({...good,outputSafety});for(const args of cases)await run(tool,args);}
for(const args of [undefined,null,{},[],0,false,'x',{extra:1}])await run('liveAudioCaptureStatusAsync',args);
for(const patch of [{connected:false},{epoch:null},{provenance:'fake-live'},{provenance:'simulator'},{provenance:'unknown'},{capabilities:[]},...operations.map(op=>({operations:operations.filter(v=>v!==op)}))])for(const tool of ['liveAudioCapturePreviewAsync','liveAudioCaptureStatusAsync','liveAudioCaptureEmergencyStopAsync'])await run(tool,tool.includes('Preview')?valid:tool.includes('Status')?{}:{confirmation:'emergency-stop-and-clean',captureId:record.captureId,sourceSlotRef:record.sourceSlotRef,destinationSlotRef:record.destinationSlotRef},{status:patch});
for(const p of [null,{},[],{...plan,supported:false},{...plan,fence:''},{...plan,fence:'a'.repeat(65)},{...plan,prior:null},{...plan,destinationTrackRef:''},{...plan,captureMode:null},{...plan,prior:{}}])await run('liveAudioCapturePreviewAsync',valid,{plan:p});
for(const clip of [undefined,null,{},[],{ref:'c',name:'clip',length:1,isAudio:true,filePath:'/secret.wav',unknown:'hidden'},{filePath:''},{filePath:4}])await run('liveAudioCaptureStatusAsync',{}, {statuses:[{...cleanStatus,recoveryToken:'secret',clip}]});
for(const value of [null,0,false,[],['one',2],'ab'])await run('liveAudioCaptureStatusAsync',{}, {statuses:[value]});
const recovery=[];
async function recover(label,options={},patch={}){const{host,calls}=mock(options);const transaction={...structuredClone(record),...patch};const result=await host.recoverAudioCapture(transaction);recovery.push({label,options,patch,result,calls,record:clean(transaction)});}
await recover('cleaned');await recover('idle',{statuses:[{state:'idle'}]});await recover('idle-dispatched',{statuses:[{state:'idle'}]},{startDispatched:true});await recover('idle-token',{statuses:[{state:'idle'}]},{mapperToken:'token'});
for(const key of ['captureId','sourceSlotRef','destinationSlotRef'])await recover('foreign-'+key,{statuses:[{...cleanStatus,[key]:'foreign'}]});
await recover('residual',{statuses:[{...cleanStatus,residual:['bad','bad','',null,4,'other']}]});
await recover('active',{statuses:[{...cleanStatus,state:'active',active:true,playbackStopped:false},cleanStatus]});
await recover('active-error',{statuses:[{...cleanStatus,state:'active',active:true,playbackStopped:false},cleanStatus],errors:{'audio.capture.emergency-stop':'stop failed'}});
await recover('active-foreign',{statuses:[{...cleanStatus,state:'active'}, {...cleanStatus,captureId:'foreign'}]});
await recover('status-null',{statuses:[null]});
await recover('status-error',{statuses:[{error:'unavailable'}]});await recover('final-error',{statuses:[cleanStatus,{error:'unavailable'}]});
await recover('final-foreign',{statuses:[cleanStatus,{...cleanStatus,captureId:'foreign'}]});
for(const patch of [{active:true},{playbackStopped:false},{state:'idle'},{clip:{}},{residual:['last']}])await recover('final-'+Object.keys(patch)[0],{statuses:[cleanStatus,{...cleanStatus,...patch}]});
await recover('snapshot-error',{snapshotError:true});
for(const key of ['playing','arrangementRecord','sessionRecord']){const s=structuredClone(snapshot);s.playback.transport[key]=true;await recover('playback-'+key,{snapshot:s});}
for(const key of ['playingTargets','firedTargets']){const s=structuredClone(snapshot);s.playback[key]=[{trackRef:'track:other',clipSlotRef:'clip-slot:other:0',sceneRef:'scene:other',sceneIndex:0,clipRef:null}];await recover('playback-'+key,{snapshot:s});}
for(const patch of [{armed:true},{monitoringState:'in'},{routing:{inputType:'other'}},{clipSlots:[]},{clipSlots:[{ref:record.destinationSlotRef,parentRef:record.destinationTrackRef,sceneIndex:0,empty:false,clipRef:'other'}]}]){const s=structuredClone(snapshot);Object.assign(s.tracks.at(-1),patch);await recover('destination-'+Object.keys(patch)[0],{snapshot:s});}
const missing=structuredClone(snapshot);missing.tracks.pop();await recover('destination-missing',{snapshot:missing});
await recover('no-prior',{}, {prior:{}});const armed=structuredClone(snapshot);armed.tracks.at(-1).armed=true;await recover('no-prior-armed',{snapshot:armed},{prior:{}});
for(const state of ['other','cleaned'])for(const clip of [undefined,{}, {ref:'clip:captured'}, {ref:'clip:captured',filePath:'relative.wav'}])for(const rawPrimaryUnlinked of [false,true])await recover('authority',{statuses:[{...cleanStatus,state,clip},cleanStatus]}, {rawPrimaryUnlinked});
const waiting=[];
for(const [label,statuses,expired]of [['expired',[cleanStatus],true],['failed',[{state:'failed'}],false],['ready',[{state:'captured',playbackStopped:true,clip:{ref:'clip:captured',filePath:'/capture.wav'}}],false],['poll',[{state:'stopped',playbackStopped:true},{state:'captured',playbackStopped:true,clip:{ref:'clip:captured',filePath:'/capture.wav'}}],false],['null',[null],false]]){
 const {host,calls}=mock({statuses});let result;try{result=await host.waitForCapturedMedia(host.asyncAdapter(),undefined,expired?0:Date.now()+1000)}catch(e){result={error:e.message}}waiting.push({label,statuses,expired,result,calls});
}
const workflows=[];let waveBase64;
for(const scenario of ['normal','late-asd','invalid-wave','missing-media','mapper-residual','before-start','after-start','bad-start-token','before-stop','after-stop','before-cleanup','after-cleanup','final-arm','raw-replacement','range-start','epoch','expired','bad-confirmation']){
 const root=await mkdtemp(join(tmpdir(),'capture-oracle-flow-'));const f=await makeFixture(root);const calls=[];const original=f.adapter.invokeAsync;let failed=false,epoch=1;
 f.adapter.refreshStatusAsync=async c=>{calls.push({method:'status',context:ctx(c)});return{...f.adapter.status(),epoch}};
 f.adapter.snapshotAsync=async(c,r)=>{calls.push(clean({method:'snapshot',request:r??null,context:ctx(c)},root));return structuredClone(f.state)};
 f.adapter.invokeAsync=async(i,c)=>{
  calls.push(clean({method:'invoke',invocation:i,context:ctx(c)},root));const op=i.operation.split('.').at(-1);
  if(!failed&&scenario==='before-'+op){failed=true;throw Error('injected '+op+' failure: '+root)}
  if(!failed&&scenario==='range-start'&&op==='start'){failed=true;throw RangeError('bounded '+root)}
  const result=await original(i,c);
  if(op==='stop'){
   if(!waveBase64)waveBase64=fs.readFileSync(f.mediaPath).toString('base64');
   if(scenario==='invalid-wave')await writeFile(f.mediaPath,'not-a-wave');
   if(scenario==='missing-media')await rm(f.mediaPath);
   if(scenario==='mapper-residual')f.capture().residual=['destination-route-changed-externally'];
  }
  if(op==='cleanup'){
   if(scenario==='late-asd')await writeFile(f.mediaPath+'.asd',Buffer.alloc(128,3));
   if(scenario==='final-arm')f.state.tracks.at(-1).armed=true;
   if(scenario==='raw-replacement')await writeFile(f.mediaPath,Buffer.from(waveBase64,'base64'));
  }
  if(!failed&&scenario==='after-'+op){failed=true;throw Error('injected '+op+' failure: '+root)}
  if(scenario==='bad-start-token'&&op==='start')return{};
  return result;
 };
 const host=new McpHost(f.adapter);const results=[];const preview=await host.liveAudioCapturePreviewAsync(1,valid);results.push(clean(preview,root));const body=JSON.parse(preview.result.content[0].text);const r=host.audioCaptureTransactions.get(body.transactionId);r.durationMs=1;
 if(scenario==='epoch')epoch=2;if(scenario==='expired')r.expiresAt=0;
 for(const [id,key]of [[2,'capture-key'],[3,'capture-key'],[4,'other-key']]){results.push(clean(await host.liveAudioCaptureApplyAsync(id,{transactionId:body.transactionId,confirmation:scenario==='bad-confirmation'?'bad':body.confirmation,idempotencyKey:key}),root));}
 results.push(clean(await host.liveAudioCaptureStatusAsync(5,{}),root));
 workflows.push({scenario,results,record:clean(r,root),calls,media:fs.existsSync(f.mediaPath),companion:fs.existsSync(f.mediaPath+'.asd'),capture:clean(f.capture(),root),destination:clean(f.state.tracks.at(-1),root)});
 await rm(root,{recursive:true,force:true});
}
const concurrent=[];
for(const scenario of ['shared','one-cancelled','both-cancelled','before-status','preaborted','wrong-key']){
 const root=await mkdtemp(join(tmpdir(),'capture-oracle-concurrent-'));const f=await makeFixture(root);const calls=[];const invoke=f.adapter.invokeAsync;let applying=false;
 f.adapter.refreshStatusAsync=async c=>{calls.push({method:'status',context:ctx(c)});if(applying&&scenario==='before-status')await new Promise(r=>setTimeout(r,30));return f.adapter.status()};
 f.adapter.snapshotAsync=async(c,r)=>{calls.push(clean({method:'snapshot',request:r??null,context:ctx(c)},root));return structuredClone(f.state)};
 f.adapter.invokeAsync=async(i,c)=>{calls.push(clean({method:'invoke',invocation:i,context:ctx(c)},root));return invoke(i,c)};
 const host=new McpHost(f.adapter);const preview=await host.liveAudioCapturePreviewAsync(1,valid);const body=JSON.parse(preview.result.content[0].text);const record=host.audioCaptureTransactions.get(body.transactionId);record.durationMs=50;applying=true;
 const args={transactionId:body.transactionId,confirmation:body.confirmation,idempotencyKey:'shared-key'};const first=new AbortController(),second=new AbortController();if(scenario==='preaborted')first.abort();
 const a=host.liveAudioCaptureApplyAsync(2,args,first.signal);const inflight=record.inflight;
 const b=['before-status','preaborted'].includes(scenario)?Promise.resolve(undefined):host.liveAudioCaptureApplyAsync(3,{...args,idempotencyKey:scenario==='wrong-key'?'other-key':args.idempotencyKey},second.signal);
 if(['one-cancelled','both-cancelled','before-status'].includes(scenario))setTimeout(()=>{first.abort();if(scenario==='both-cancelled')second.abort()},5);
 const results=await Promise.all([a,b]);await inflight;
 concurrent.push({scenario,results:clean(results,root),record:clean(record,root),calls,capture:clean(f.capture(),root),media:fs.existsSync(f.mediaPath),companion:fs.existsSync(f.mediaPath+'.asd')});await rm(root,{recursive:true,force:true});
}
fs.writeFileSync(new URL('host-capture-oracle.json',import.meta.url),JSON.stringify({status,plan,valid,record,snapshot,waveBase64,rows,recovery,waiting,workflows,concurrent}));console.log({rows:rows.length,recovery:recovery.length,workflows:workflows.length,concurrent:concurrent.length});
