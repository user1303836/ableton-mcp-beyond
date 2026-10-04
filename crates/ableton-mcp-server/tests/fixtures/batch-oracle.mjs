// Rebuild with TS_REFERENCE_ROOT pointing at the compiled TypeScript reference.
import {writeFileSync} from 'node:fs';import {resolve} from 'node:path';import {fileURLToPath,pathToFileURL} from 'node:url';
const root=process.env.TS_REFERENCE_ROOT??fileURLToPath(new URL('../../../..',import.meta.url));
const {DeterministicLiveSimulator}=await import(pathToFileURL(resolve(root,'apps/mcp-server/dist/src/live.js')));
const {BatchTransactionManager,fingerprint}=await import(pathToFileURL(resolve(root,'apps/mcp-server/dist/src/transactions/batch.js')));
const sim=new DeterministicLiveSimulator();const track=sim.state.tracks[0],device=track.devices[0],parameter=device.parameters[0],clip=track.clips[0],scene=sim.state.scenes[0];
const ops=[{kind:'mixer.set',trackRef:track.ref,volume:.4,mute:true},{kind:'device.parameter.set',deviceRef:device.ref,parameterRef:parameter.ref,value:parameter.min},{kind:'clip.set',clipRef:clip.ref,muted:true,colorIndex:5},{kind:'track.rename',trackRef:track.ref,name:'Drum Bus'},{kind:'scene.rename',sceneRef:scene.ref,name:'First'},{kind:'track.create',name:'New MIDI',trackKind:'midi'},{kind:'routing.arm',trackRef:track.ref,armed:true}];
const validation=[];
async function add(name,request,patch){const sim=new DeterministicLiveSimulator();if(patch)applyPatch(sim.state,patch);const m=new BatchTransactionManager(sim);const row={name,request,...(patch?{patch}:{})};try{row.result=await m.previewAsync(request);delete row.result.transactionId;delete row.result.expiresAt;}catch(e){row.error=e.message;}validation.push(row);}
function applyPatch(state,patch){for(const [path,value]of patch){const keys=path.split('.');let parent=state;for(const key of keys.slice(0,-1))parent=parent[key];if(value==='$delete')delete parent[keys.at(-1)];else parent[keys.at(-1)]=structuredClone(value);}}
for(const op of ops){await add(`valid:${op.kind}`,{operations:[op]});for(const field of Object.keys(op))for(const value of [undefined,null,false,true,-1,0,.5,1,69,70,128,'','x',[],{}]){const changed={...op,[field]:value};if(value===undefined)delete changed[field];await add(`${op.kind}:${field}:${JSON.stringify(value)}`,{operations:[changed]});}await add(`extra:${op.kind}`,{operations:[{...op,extra:true}]});}
for(const request of [null,[],{},false,{operations:[]},{operations:ops,extra:true},{operations:new Array(33).fill(ops[0])},{operations:[ops[0],ops[0]]},{operations:[ops[5],ops[5]]},{operations:ops}])await add(`request:${JSON.stringify(request)}`,request);
for(const patch of [[['tracks.0.objectIdentity','$delete']],[['tracks.0.mixer.sendIdentities',null]],[['tracks.0.devices.0.enabled',false]],[['tracks.0.devices.0.parameters.0.automatable',false]],[['tracks.0.devices.0.parameters.0.objectIdentity','$delete']],[['tracks.0.armed',null]],[['tracks.0.clips.0.isAudio',true]],[['tracks.0.clips.0.muted',null]]])await add(`authority:${JSON.stringify(patch)}`,{operations:ops},patch);
const scenarios=[];
async function scenario(name,operations,actions,fault={}){
 const sim=new DeterministicLiveSimulator();let tx,deny=false,readCount=0,executions=0,replays=0;const ledger=new Map();const calls=[];
 const adapter={status:()=>sim.status(),snapshot:()=>sim.snapshot(),get:r=>sim.get(r),invoke:i=>sim.invoke(i),subscribe:l=>sim.subscribe(l),reconnect:()=>sim.reconnect(),snapshotAsync:async()=>{readCount++;const result=sim.snapshot();if(fault.denyRead===readCount)deny=true;return result;},getAsync:async r=>sim.get(r),invokeAsync:async(i,c)=>{calls.push(structuredClone(i));const key=`${c?.transactionId}:${c?.idempotencyKey}:${JSON.stringify(i)}`;if(ledger.has(key)){replays++;return structuredClone(ledger.get(key));}const result=sim.invoke(i);ledger.set(key,structuredClone(result));executions++;if(fault.lostAt===executions)throw Error('remote adapter request state uncertain after dispatch timeout');return result;},reconnectAsync:async()=>sim.reconnect(),close:async()=>{}};
 const manager=new BatchTransactionManager(adapter,()=>{if(deny)throw Error('policy denied');});const steps=[];
 for(const action of [{method:'preview'},...actions]){
  const row={action};try{let result;switch(action.method){case'preview':result=await manager.previewAsync({operations});tx=result.transactionId;break;case'apply':result=await manager.applyAsync(tx,action.confirmation??'apply',action.key??'batch-apply');break;case'undo':result=await manager.undoAsync(tx,action.confirmation??'undo',action.key??'batch-undo');break;case'edit':sim.simulateExternalEdit(action.ref,action.property,action.value);break;case'patch':applyPatch(sim.state,action.patch);break;case'deny':deny=action.value;break;case'release':result=manager.release(tx);break;case'finalize':result=manager.finalize(tx);break;case'reconnect':sim.reconnect();break;}
  if(result!==undefined){result=structuredClone(result);if(result&&typeof result==='object'){if(result.transactionId)result.transactionId='$transaction';delete result.expiresAt;}row.result=result;}
  }catch(e){row.error=e.message;}row.stateHash=fingerprint(sim.state);steps.push(row);
 }
 scenarios.push({name,operations,actions,fault,steps,calls,executions,replays});
}
await scenario('all kinds exact undo',ops,[{method:'apply'},{method:'apply'},{method:'undo'},{method:'undo'},{method:'finalize'}]);
await scenario('multiple creations with owned rename',[ops[3],ops[5],{kind:'track.create',name:'New Audio',trackKind:'audio'},ops[0]],[{method:'apply'},{method:'undo'}]);
await scenario('clean mid batch refusal compensates',[ops[0],ops[1]],[{method:'edit',ref:parameter.ref,property:'value',value:parameter.max},{method:'apply'},{method:'apply'}]);
await scenario('lost apply acknowledgement',[ops[0],ops[3]],[{method:'apply'},{method:'apply',key:'wrong'},{method:'apply'},{method:'undo'}],{lostAt:1});
await scenario('lost undo acknowledgement',[ops[0],ops[3]],[{method:'apply'},{method:'undo'},{method:'undo',key:'wrong'},{method:'undo'}],{lostAt:3});
await scenario('lost rollback acknowledgement',[ops[0],ops[1]],[{method:'edit',ref:parameter.ref,property:'value',value:parameter.max},{method:'apply'},{method:'apply'}],{lostAt:2});
await scenario('human edit blocks undo',[ops[0]],[{method:'apply'},{method:'patch',patch:[['tracks.0.mixer.volume',.2]]},{method:'undo'},{method:'finalize'}]);
await scenario('created track changed blocks deletion',[ops[5]],[{method:'apply'},{method:'patch',patch:[['tracks.1.name','Human edit']]},{method:'undo'}]);
await scenario('release only applied',[ops[0]],[{method:'release'},{method:'apply'},{method:'release'},{method:'undo'},{method:'apply'}]);
await scenario('epoch fence',[ops[0]],[{method:'reconnect'},{method:'apply'}]);
await scenario('policy denied after awaited preview',[ops[0]],[{method:'apply'},{method:'deny',value:false},{method:'apply'},{method:'deny',value:true},{method:'undo'}],{denyRead:1});
await scenario('policy denied after awaited apply view',[ops[0]],[{method:'apply'},{method:'deny',value:false},{method:'apply'}],{denyRead:2});
writeFileSync(new URL('./batch-oracle.json',import.meta.url),JSON.stringify({validation,scenarios})+'\n');console.log(JSON.stringify({validation:validation.length,scenarios:scenarios.length}));
