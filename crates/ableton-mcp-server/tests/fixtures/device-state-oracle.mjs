// Run after tsc -p apps/mcp-server/tsconfig.json. Calls the unchanged TS module.
import fs from 'node:fs';
import { buildDeviceStateFile as build,validateDeviceStateFile as validate,planDeviceStateRecall as plan,morphValue,DeviceStateTransactionManager } from '../../../../apps/mcp-server/dist/src/transactions/device-state.js';
import {DeterministicLiveSimulator} from '../../../../apps/mcp-server/dist/src/live.js';
import {fingerprint} from '../../../../apps/mcp-server/dist/src/transactions/batch.js';
import {installExecutionLedger} from '../../../../apps/mcp-server/dist/test/helpers/execution-ledger.js';
const clone=structuredClone;
const parameter=(ref,name,value=0.5)=>({ref,objectIdentity:'identity:'+ref,name,value,min:0,max:1,quantization:0,automatable:true,enabled:true,revision:1});
const device=(ref,name='Utility')=>({ref,objectIdentity:'identity:'+ref,name,className:'Utility',kind:'audio-effect',enabled:true,parameters:[parameter(ref+':gain','Gain'),{...parameter(ref+':switch','Switch',0),quantization:1}]});
const base={tracks:[{ref:'track:t',objectIdentity:'track-id',devices:[device('device:d')]}]};
const state=build(base,'device:d','base');state.savedAt='$time';
const attempt=fn=>{try{return{result:fn()}}catch(e){return{error:e.message,...(e.deviceStateReport?{report:e.deviceStateReport}:{})}}};
const builds=[],validations=[],plans=[],morph=[];
const addBuild=(name,edit=()=>{},ref='device:d')=>{const snapshot=clone(base);edit(snapshot);const result=attempt(()=>build(snapshot,ref,'saved'));if(result.result)result.result.savedAt='$time';builds.push({name,snapshot,ref,...result});};
addBuild('basic');addBuild('missing-reference',()=>{},'device:absent');
for(const value of ['',null,42,'x'.repeat(257)])addBuild('name-'+JSON.stringify(value),s=>s.tracks[0].devices[0].name=value);
for(const value of ['',null,42,'x'.repeat(257),'Other'])addBuild('class-'+JSON.stringify(value),s=>s.tracks[0].devices[0].className=value);
for(const [field,values] of Object.entries({ref:['',null,3],name:['',null,3],value:[null,'0.5'],min:[null,'0'],max:[null,'1'],quantization:[null,'1',-1]}))for(const value of values)addBuild('parameter-'+field+JSON.stringify(value),s=>s.tracks[0].devices[0].parameters[0][field]=value);
addBuild('no-parameters',s=>s.tracks[0].devices[0].parameters=[]);
addBuild('over-limit',s=>s.tracks[0].devices[0].parameters=Array.from({length:1025},(_,i)=>parameter('p:'+i,'P'+i)));
addBuild('nested-duplicates',s=>{const d=s.tracks[0].devices[0];d.name='Rack';d.kind='rack';d.chains=[{name:'Same',devices:[device('d:a'),device('d:b')]},{name:'Same',devices:[device('d:c')]}];d.drumPads=[{name:'Pad',chains:[{name:'Chain',devices:[device('d:d')]},{devices:[device('d:e')]}]}];});
const validation=(name,edit)=>{const file=clone(state);edit(file);validations.push({name,file,...attempt(()=>validate(file))});};
for(const data of [null,[],42,{}, {schema:'wrong'}])validations.push({name:'shape-'+JSON.stringify(data),file:data,...attempt(()=>validate(data))});
for(const [key,values]of Object.entries({name:['',null,'x'.repeat(65),'renamed'],savedAt:['',null,'arbitrary non-date'],digest:['',null,'A'.repeat(64),'f'.repeat(64)]}))for(const value of values)validation(key+JSON.stringify(value),f=>f[key]=value);
for(const [key,values]of Object.entries({name:['',null],className:[null,'',42],kind:['',null,'x'.repeat(65)]}))for(const value of values)validation('identity-'+key+JSON.stringify(value),f=>f.device.identity[key]=value);
validation('missing-class',f=>delete f.device.identity.className);validation('missing-privacy',f=>delete f.privacy);validation('privacy-no-profile',f=>f.privacy={});validation('privacy-renamed',f=>f.privacy.profile='custom');validation('missing-parameters',f=>delete f.parameters);validation('empty-parameters',f=>f.parameters=[]);validation('count-drift',f=>f.device.parameterCount=1);validation('fraction-count',f=>f.device.parameterCount=2.5);
for(const [field,values]of Object.entries({path:['',null,'x'.repeat(513)],name:['',null,'x'.repeat(257)],value:[null,'0',-1,2],min:[null,2],max:[null,-1],quantization:[null,-1,'1']}))for(const value of values)validation('row-'+field+JSON.stringify(value),f=>f.parameters[0][field]=value);
validation('duplicate-path',f=>f.parameters[1].path=f.parameters[0].path);validation('extra-privacy-fields',f=>f.privacy.extra='ignored');validation('extra-row-field',f=>f.parameters[0].extra='digest-covered');
const addPlan=(name,edit=()=>{},options={})=>{const snapshot=clone(base);edit(snapshot);plans.push({name,snapshot,file:state,options,...attempt(()=>plan(snapshot,state,'device:d',options))});};
addPlan('basic');for(const field of ['className','kind','name'])addPlan('wrong-'+field,s=>s.tracks[0].devices[0][field]='Other');
for(const partial of [false,true])for(const change of ['missing','bounds','quantization','read-only','disabled','device-disabled'])addPlan(`${change}-${partial}`,s=>{const d=s.tracks[0].devices[0];if(change==='missing')d.parameters.pop();if(change==='bounds')d.parameters[1].max=2;if(change==='quantization')d.parameters[1].quantization=0;if(change==='read-only')d.parameters[1].automatable=false;if(change==='disabled')d.parameters[1].enabled=false;if(change==='device-disabled')d.enabled=false;},{allowPartialLayout:partial});
for(const amount of [-1,0,0.25,0.5,1,2,null])addPlan('morph-live-'+amount,s=>{s.tracks[0].devices[0].parameters[0].value=0.1;},{morphFrom:{kind:'live'},amount});
addPlan('missing-amount',()=>{},{morphFrom:{kind:'live'}});
for(const kind of ['normal','missing','wrong-class','different-bounds']){const file=clone(state);file.parameters[0].value=0.1;if(kind==='missing')file.parameters.shift();if(kind==='wrong-class')file.device.identity.className='Other';if(kind==='different-bounds')file.parameters[0].max=2;addPlan('morph-file-'+kind,()=>{},{morphFrom:{kind:'file',file},amount:0.5});}
let seed=123456789;const random=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/2**32);
for(let i=0;i<800;i++){const min=(random()-.5)*100,max=min+random()*100,from=min+random()*(max-min),to=min+random()*(max-min),amount=random(),q=[0,.01,.1,.5,1,2,10][i%7];const args=[from,to,amount,min,max,q];morph.push({args,result:morphValue(...args)});}
for(const raw of [0.49999999999999994,0.5,-0.5,-0.5000000000000001,1.5,-1.5,Number.MAX_VALUE,Number.MIN_VALUE])for(const q of [0,1,.1]){const args=[raw,raw,0,-10,10,q];morph.push({args,result:morphValue(...args)});}
const scenarios=[];
async function scenario(name,actions,fault={}){
 const sim=new DeterministicLiveSimulator();const d=sim.state.tracks[0].devices[0];d.parameters.push({...clone(d.parameters[0]),ref:'parameter:second',objectIdentity:'simulator:second',name:'Second',value:.7});const file=build(sim.snapshot(),d.ref,'recovery');d.parameters[0].value=.1;d.parameters[1].value=.2;
 let failVerification=false;const read=sim.snapshotAsync.bind(sim);sim.snapshotAsync=async(...args)=>{if(failVerification){failVerification=false;throw new Error('snapshot unavailable');}return read(...args);};
 const ledger=installExecutionLedger(sim,(_invocation,execution)=>{if(fault.verificationAt===execution)failVerification=true;if(fault.identityAt===execution)d.parameters[0].objectIdentity='external:replacement';if(fault.lostAt?.includes(execution))throw new Error('remote adapter request state uncertain after dispatch timeout');});
 let forgedCalls=0;if(fault.forged){const invoke=sim.invokeAsync.bind(sim);sim.invokeAsync=async(...args)=>{forgedCalls++;if(forgedCalls===1){sim.simulateExternalEdit(d.parameters[0].ref,'value',.5);throw new Error('remote adapter request state uncertain after dispatch timeout');}return invoke(...args);};}
 const manager=new DeviceStateTransactionManager(sim);let id;const steps=[];
 for(const action of actions){const row={action};try{let result;switch(action.method){case'preview':result=await manager.previewAsync(plan(sim.snapshot(),file,d.ref,action.options??{}),action.mode??'recall',action.options?.amount);id=result.transactionId;break;case'apply':result=await manager.applyAsync(id,action.confirmation??'apply',action.key??'apply');break;case'undo':result=await manager.undoAsync(id,action.confirmation??'undo',action.key??'undo');break;case'edit':sim.simulateExternalEdit(d.parameters[action.index].ref,action.property??'value',action.value);break;case'identity':d.parameters[action.index].objectIdentity=action.value;break;case'reconnect':sim.reconnect();break;case'finalize':result=manager.finalize(id);break;}
 if(result!==undefined){result=clone(result);if(result.transactionId)result.transactionId='$transaction';delete result.expiresAt;row.result=result;}}catch(e){row.error=e.message;}
 row.stateHash=fingerprint(sim.state);steps.push(row);
 }
 scenarios.push({name,fault,steps,calls:ledger.calls.map(c=>c.invocation),executions:ledger.executions,replays:ledger.replays});
}
const p={method:'preview'},a={method:'apply'},u={method:'undo'};
await scenario('apply-replay-undo-finalize',[p,a,a,u,u,{method:'finalize'},a]);
await scenario('morph-live',[{method:'preview',mode:'morph',options:{morphFrom:{kind:'live'},amount:.5}},a,u]);
await scenario('lost-apply-and-undo',[p,a,{method:'apply',key:'different'},a,u,{method:'undo',key:'different'},u,u],{lostAt:[1,3]});
await scenario('lost-compensation',[p,{method:'edit',index:1,value:.95},a,a,a],{lostAt:[2]});
await scenario('matching-value-not-dispatched',[p,a,a,u],{forged:true});
await scenario('acknowledged-verification-failed',[p,a,a,u],{verificationAt:1});
await scenario('replaced-parameter',[p,a,a,u,{method:'finalize'}],{identityAt:1});
await scenario('changed-before-apply',[p,{method:'edit',index:0,value:.8},a,a,u]);
await scenario('epoch-changed',[p,{method:'reconnect'},a]);
await scenario('confirmation-and-finalize',[p,{method:'apply',confirmation:'no'},{method:'undo',confirmation:'no'},{method:'finalize'},a,{method:'undo',key:'undo'},a]);
fs.writeFileSync('crates/ableton-mcp-server/tests/fixtures/device-state-oracle.json',JSON.stringify({builds,validations,plans,morph,scenarios},null,2)+'\n');
console.log(JSON.stringify({builds:builds.length,validations:validations.length,plans:plans.length,morph:morph.length,scenarios:scenarios.length}));
