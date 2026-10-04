import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
const base=new URL('.',pathToFileURL(process.argv[2]));
const {McpHost}=await import(new URL('host.js',base));
const {DeterministicLiveSimulator,LIVE_REGISTRY_OPERATIONS}=await import(new URL('live.js',base));
const clean=original=>{const value=structuredClone(original);if(value?.result?.content?.[0]?.text)try{value.result.content[0].text=JSON.parse(value.result.content[0].text);}catch{}return value;};
const authority={parameterIdentity:'parameter-object',ownerRef:'device:1',ownerIdentity:'device-object',trackRef:'track:1',trackIdentity:'track-object',siblings:[{ref:'parameter:1',objectIdentity:'parameter-object'}]};
const records=[{},null,{kind:'mixer-set',payload:{ref:'track:1',volume:0.5}},{kind:'rename',payload:{kind:'takeLane'},clipRef:'take:1'},{kind:'rename',payload:{kind:['clip']},clipRef:'clip:1'},{kind:'rename',payload:{},clipRef:'track:1'},{kind:'rename',payload:{kind:{toString:1}},clipRef:'track:1'},{kind:'device-edit',payload:{operation:'device.rename',args:{ref:'device:1'}}},{kind:'device-edit',payload:{operation:1,args:{}}},{kind:'clip-delete',payload:{operation:'clip.delete',ref:'clip:1'}},{kind:'clip-delete',payload:{}},{parameterRef:'parameter:1',authority},{parameters:[{ref:'parameter:1',authority},{ref:'parameter:2',authority:{...authority,parameterIdentity:'second'}}]},{parameters:[]},{parameters:'x'}];
for(const kind of ['mixer-set','mixer-extended','chain-mixer','chain-set','routing-set','clip-set','clip-action','clip-view','duplicate','audio-set','track-set','scene-set','song-set','tuning','device-view','rack-view','device-delete','data-set','simpler','browser-load','scene-delete','track-delete','locator-delete'])records.push({kind,payload:{operation:kind+'.change',ref:'object:1',value:0.5}});
const host=new McpHost(),previews=[];
for(const name of Object.keys(host.previewChanges))for(const record of records.filter(v=>v!==null)) {
 const row={name,record};try{const value=host.previewChanges[name](record);if(value===undefined)row.missing=true;else row.result=value;}catch(e){row.error=e.message;}previews.push(row);
}
const flights=[];
for(const options of [{},{capture:true},{keyOnly:true},{abortFirst:true},{abortSecond:true},{abortFirst:true,abortSecond:true},{differentKey:true},{differentArgs:true},{differentTool:true},{fail:true},{retireFail:true},{retiresOnItsOwn:true},{resultError:true},{nullResult:true},{textResult:true},{noKey:true},{preAborted:true}]) {
 const sim=new DeterministicLiveSimulator(),retired=[];sim.retiresOnItsOwn=options.retiresOnItsOwn;
 sim.retireTransactionAsync=async(id,ctx)=>{retired.push({id,deadline:typeof ctx?.deadlineMs==='number'});if(options.retireFail)throw Error('retirement failed');};
 const host=new McpHost(sim),controllers=[new AbortController(),new AbortController()];
 if(options.preAborted)controllers[0].abort();
 let resolve,reject;const gate=new Promise((a,b)=>{resolve=a;reject=b;}),seen=[];
 const execute=async signal=>{seen.push({signal:!!signal,aborted:signal?.aborted===true});return await gate;};
 const args=options.noKey?{}:{idempotencyKey:'key-1234',...(options.keyOnly?{}:options.capture?{captureId:'capture-1'}:{transactionId:'transaction-1'})};
 const a=host.singleFlightMutation('tool',1,args,execute,controllers[0].signal).then(clean,e=>({error:e.message}));
 const b=host.singleFlightMutation(options.differentTool?'other':'tool',2,{...args,...(options.differentKey?{idempotencyKey:'other-key'}:{}),...(options.differentArgs?{confirmation:'different'}:{})},execute,controllers[1].signal).then(clean,e=>({error:e.message}));
 const active=host.activeAsyncOperations;
 if(options.abortFirst)controllers[0].abort();if(options.abortSecond)controllers[1].abort();
 for(let i=0;i<8;i++)await Promise.resolve();
 const outcome=options.nullResult?null:{jsonrpc:'2.0',id:1,result:{content:[{type:'text',text:options.textResult?'unparsed text':JSON.stringify({state:'applied',idempotent:false})}],isError:options.resultError===true}};
 if(options.fail)reject(Error('execution failed'));else resolve(outcome);
 const results=await Promise.all([a,b]);for(let i=0;i<8;i++)await Promise.resolve();
 flights.push({options,seen,active,results,retired,after:host.activeAsyncOperations});
}
const history=[];
const valid={begin:{label:'Producer changes',timeoutMs:1000},end:{stepId:'undo-step-fixture'},undo:{confirmation:'undo-in-live',idempotencyKey:'history-key'},redo:{confirmation:'redo-in-live',idempotencyKey:'history-key'}};
const defaults={'undo.step.begin':{open:true,stepId:'undo-step-fixture',expiresAt:9999999999999},'undo.step.end':{open:false,ended:true},'song.undo':{done:true,canUndo:false,canRedo:true},'song.redo':{done:true,canUndo:true,canRedo:false}};
async function request(tool,args,options={}) {
 const sim=new DeterministicLiveSimulator(),calls=[],status={...sim.status(),operations:[...LIVE_REGISTRY_OPERATIONS],...options.statusPatch};
 sim.status=()=>structuredClone(status);
 sim.refreshStatusAsync=async ctx=>{calls.push({refresh:true});return sim.status();};
 sim.invokeAsync=async(invocation,ctx)=>{calls.push({invocation,context:{deadline:typeof ctx?.deadlineMs==='number',...(ctx?.transactionId?{transactionId:ctx.transactionId}:{}),...(ctx?.idempotencyKey?{idempotencyKey:ctx.idempotencyKey}:{}),...(ctx?.signal?{signal:true}:{})}});if(options.fail)throw Error('request failed: exact refusal');return structuredClone(options.result??defaults[invocation.operation]);};
 const host=new McpHost(sim);const call=()=>tool==='begin'?host.liveUndoStepBeginAsync(1,args):tool==='end'?host.liveUndoStepEndAsync(1,args):host.liveSongHistoryAsync(1,args,tool==='redo');
 let result=await call();let repeat;if(options.repeat)repeat=await call();if(options.close)await host.closeOpenUndoStep();
 history.push({tool,args,options,result:clean(result),...(repeat===undefined?{}:{repeat:clean(repeat)}),calls});
}
for(const [tool,args] of Object.entries(valid)) {
 await request(tool,args);await request(tool,args,{repeat:true});await request(tool,args,{close:true});
 for(const value of [null,{},[],false,0,'x'])await request(tool,value);
 for(const key of Object.keys(args))for(const value of [null,{},[],false,0,'','x',1,1000,3600001])await request(tool,{...args,[key]:value});
 for(const options of [{fail:true},{statusPatch:{connected:false}},{statusPatch:{operations:[]}},{result:{}},{result:{open:true,stepId:'short',expiresAt:0}},{result:{done:'yes',canUndo:'unknown'}},{result:{reason:'other-step',stepId:'undo-step-fixture'}}])await request(tool,args,options);
}
fs.writeFileSync(new URL('host-mutations-oracle.json',import.meta.url),JSON.stringify({previews,flights,history}));
console.log({previews:previews.length,flights:flights.length,history:history.length});
