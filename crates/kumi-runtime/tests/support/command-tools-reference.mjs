// Regenerate after `npm run build -w @kumi/runtime`; body comes from the current TypeScript source.
import {readFileSync,writeFileSync,unlinkSync,mkdtempSync,readdirSync,existsSync,rmSync} from 'node:fs';
import ts from 'typescript';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
const root=new URL('../../../../',import.meta.url);
const original=new URL('packages/runtime/src/integrations/ableton/index.ts',root);
const file=new URL('packages/runtime/dist/src/integrations/ableton/index.command-oracle.js',root);
let source=ts.transpileModule(readFileSync(original,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
source=source.replace('import { setTimeout as delay } from "node:timers/promises";','const delay=async(_ms,_value,{signal})=>signal.throwIfAborted();');
if(source.includes('setTimeout as delay'))throw Error('delay hook changed');
source=source.replace('async function act(kind, input, originalSignal)', 'async function realAct(kind, input, originalSignal)');
const marker='    return {\n        async start(signal) {\n            if (closed || started)';if(!source.includes(marker))throw Error('source hook changed');
source=source.replace(marker,`    async function act(kind,input,signal){signal.throwIfAborted();return options.testAction(kind.tool,input);}
    return {
        async _ready(config){await tools.refresh(new AbortController().signal);available=config.available!==false;lost=config.lost===true;currentEpoch=config.noEpoch?undefined:7;for(const [ref,kind]of config.refs??[])refs.set(ref,kind);for(const ref of config.shorts??[])shorten(ref,'ref');},
        _live:liveCommand,_plugin:pluginTool,
        _state(){return{epoch:currentEpoch??null,lease:observationGeneration,refs:[...refs],known:[...known],cursors:[...cursors]};},
        async start(signal){if(closed||started)`);
writeFileSync(file,source);
const wrap=value=>({content:[{type:'text',text:JSON.stringify(value)}],...(value&&typeof value==='object'&&!Array.isArray(value)?{structuredContent:value}:{})});
const baseTracks=[{ref:'7:track:0',name:'Bass',kind:'midi',isFrozen:false,isVisible:true},{ref:'7:track:1',name:'Drums',kind:'audio',isFrozen:true,isVisible:true}];
const menus=[{path:['Edit','Freeze Track'],enabled:true,key:'f',modifiers:1048576},{path:['Edit','Unfreeze Track'],enabled:true},{path:['Edit','Flatten Track'],enabled:true},{path:['Edit','Group Tracks'],enabled:true},{path:['Edit','Ungroup Tracks'],enabled:true},{path:['File','Save Live Set'],enabled:true},{path:['Edit','Duplicate'],enabled:true},{path:['Create','Consolidate'],enabled:true}];
const cases=[];
const {HandsError}=await import(new URL('packages/runtime/dist/src/hands/index.js',root));
try{const{createAbletonIntegration}=await import(file.href);
async function run(label,config,ops){
 const library=mkdtempSync(join(tmpdir(),'command-oracle-'));let changed=false;const calls=[],actions=[],events=[],handsCalls=[],actCalls=[];const counts={};
 const hands=new Proxy({}, {get(_target,method){if(method==='then')return undefined;if(method==='close')return()=>{};return async(...args)=>{const plain=args.map((a,i)=>method==='trusted'?a:(a&&typeof a==='object'&&'signal'in a?Object.fromEntries(Object.entries(a).filter(([k])=>k!=='signal')):a instanceof AbortSignal?undefined:a));if(method==='trusted'&&plain.length===0)plain.push(false);while(plain.length&&plain.at(-1)===undefined)plain.pop();handsCalls.push([method,...plain]);const at=counts[method]??0;counts[method]=at+1;const reply=config.hands?.[method]?.[at]??config.hands?.[method]?.at(-1);if(reply?.throw){throw new HandsError(reply.throw,'failed');}if(method==='menu'||method==='keys')changed=true;if(reply!==undefined)return structuredClone(reply);return method==='trusted'?true:method==='menus'?structuredClone(menus):method==='dialog'?{open:false}:{ok:true};}}});
 const endpoint={pid:null,serverInfo:{name:'fixture',version:'1.0.73'},async list(){return{tools:['live_status','live_discover','live_device_read'].map(name=>({name,inputSchema:{type:'object'}}))}},async call(name,args,signal){signal.throwIfAborted();calls.push({name,args:structuredClone(args)});if(config.throwRead)throw Error(config.throwRead);
  if(name==='live_device_read')return config.deviceRead??wrap({names:config.names??['Cutoff','Drive']});
  if(args.kind==='device')return config.deviceDiscovery??wrap({items:[{ref:'7:device:0:0',name:config.deviceName??'Unknown Synth'}]});
  if(args.kind==='parameter')return config.parameterRead??wrap({items:config.parameters??[{ref:'7:parameter:0:0:0',name:'Device On'},{ref:'7:parameter:0:0:1',name:'Cutoff',displayValue:'1 kHz'}]});
  const items=args.kind==='track'?(changed?(config.after??config.tracks??baseTracks):(config.tracks??baseTracks)):[];
  return wrap({epoch:7,kind:args.kind,items,revision:'r1',truncated:false});},onCatalogChanged(){return()=>{}},onDisconnect(){return()=>{}},stderrStatus(){return{bytes:0,truncated:false}},async close(){}};
 const integration=createAbletonIntegration({connect:async()=>endpoint,onConnection(){},onAction:r=>actions.push(r),onChange:r=>events.push({...r,id:'<id>'}),now:()=>new Date('2026-10-03T12:00:00Z'),generation:'connection',userLibrary:library,hands:config.disabled?false:{open:async()=>config.noHands?undefined:hands},testAction:async(name,args)=>{actCalls.push([name,args]);if(config.actThrow)throw config.observationThrow?new (await import(new URL('packages/runtime/dist/src/integrations/ableton/context.js',root))).ObservationError(config.actThrow):Error(config.actThrow);return config.act??{text:'selected',isError:false};}});
 await integration.start(new AbortController().signal);await integration._ready(config);const results=[];
 for(const op of ops){const controller=new AbortController();if(op.abort)controller.abort();let result;try{result=await integration[op.plugin?'_plugin':'_live'](op.input,controller.signal)}catch(e){result={error:e.name==='AbortError'?'cancelled':e.message}}results.push({result,state:integration._state()});}
 await integration.close();const folder=join(library,'Kumi','Wavetables');const files=existsSync(folder)?readdirSync(folder).sort().map(name=>({name,sha256:createHash('sha256').update(readFileSync(join(folder,name))).digest('hex')})):[];cases.push(JSON.parse(JSON.stringify({label,config,ops,calls,handsCalls,actCalls,actions,events,results,files}).replaceAll(library,'<library>')));rmSync(library,{recursive:true,force:true});
}
for(const input of [{},{command:'unknown'},{command:4},{menu:[1,null]},{keys:[]},{command:'freeze_track'},{command:'group_tracks'},{command:'consolidate'}])await run('validation-'+JSON.stringify(input),{},[{input}]);
for(const config of [{available:false},{lost:true},{noEpoch:true},{disabled:true},{noHands:true},{hands:{trusted:[false]}},{hands:{trusted:[{throw:'trusted failed'}]}}])await run('not-ready',config,[{input:{keys:['cmd+s']}}]);
for(const command of ['freeze_track','unfreeze_track','flatten_track','ungroup_tracks'])for(const track of ['Bass','Drums','Missing'])await run(command+'-'+track,{},[{input:{command,track}}]);
for(const config of [{},{hands:{keys:[{ok:false}]}},{hands:{keys:[{ok:false,error:'bad'}]}},{hands:{keys:[{throw:'keys failed'}]}},{after:[...baseTracks,{ref:'7:track:2',name:'Bass'}]},{after:[]}])await run('keys',config,[{input:{keys:['cmd+s',3,'return']}}]);
for(const config of [{},{hands:{menu:[{ok:false,error:'disabled'}]}},{hands:{menu:[{ok:false}]}},{hands:{menu:[{ok:true,title:'Saved'}]}},{hands:{menus:[[],menus]}},{hands:{menus:[[]]}},{hands:{dialog:[{open:true,title:'Save',buttons:['OK','Cancel']}]}},{hands:{dialog:[{throw:'closed'}]}}])await run('menu',config,[{input:{menu:['FILE','Save Live Set']}}]);
for(const config of [{},{hands:{answer:[{ok:false}]}},{hands:{answer:[{ok:false}],dialog:[{open:true,buttons:['Yes','No']}]}},{hands:{answer:[{ok:false}],dialog:[{open:true,buttons:['']}]}},{hands:{dialog:[{open:true,title:'Next'}]}}])await run('answer',config,[{input:{answer:'OK'}}]);
for(const clip of ['selected','7:clip:0:0','7:arrangement_clip:0:0'])await run('clip-'+clip,{},[{input:{command:'consolidate',clip}}]);
for(const config of [{},{actThrow:'stale action',observationThrow:true,hands:{tracks:[{ok:false,error:'old'}]}},{actThrow:'upstream action',hands:{tracks:[{ok:false,error:'old'}]}},{hands:{tracks:[{ok:false,error:'no-track',missing:['Bass']}]}},{hands:{tracks:[{ok:false,error:'old-helper'}]}},{act:{text:'No selection',isError:true}},{tracks:[{...baseTracks[0],isVisible:false}]},{tracks:[{...baseTracks[0],kind:'group'}]}])await run('select-track',config,[{input:{menu:['Duplicate'],track:'Bass'}}]);
for(const config of [{},{hands:{tracks:[{ok:false,error:'old-helper'}]}}])await run('select-many',config,[{input:{command:'group_tracks',tracks:['Bass','Drums']}}]);
await run('retry-menu-cache',{},[{input:{menu:['Save Live Set']}},{input:{menu:['Duplicate']}}]);
await run('aborted',{},[{input:{keys:['return']},abort:true}]);
const seed={refs:[['7:device:0:0','device']]};
for(const input of [{},{device:1},{device:'stale'},{device:'7:device:0:0'}])await run('plugin-validate',seed,[{input,plugin:true}]);
for(const config of [{},{names:['Cutoff',null,9,'Drive'],parameters:[{name:'Drive'}, {name:'Cutoff',ref:4,displayValue:''}]},{deviceName:'Serum'},{deviceRead:{isError:true,content:[{type:'text',text:'only a plug-in'}]}},{deviceRead:{isError:true,content:[{type:'text',text:'Nope'}]}},{deviceRead:wrap({names:{}})},{deviceDiscovery:wrap({items:{}})},{parameterRead:wrap({items:[null]})},{parameterRead:wrap({items:[],nextCursor:'again'})},{throwRead:'Bridge failed'}])await run('plugin-guide',{...seed,...config},[{input:{device:'7:device:0:0'},plugin:true}]);
for(const wavetable of [[],true,{keyframes:[]},{keyframes:[null]},{keyframes:[{harmonics:{length:4294967296}}]},{keyframes:[{harmonics:{length:'Infinity'}}]},{from_audio:[]}])await run('wavetable-invalid',seed,[{input:{device:'7:device:0:0',action:'wavetable',wavetable},plugin:true}]);
for(const wavetable of [{count:1},{name:'  A / bad:*?\"<>| name  ',count:1,keyframes:[{shape:'sine'}]},{name:'Pulse',count:2,keyframes:[{shape:'pulse',width:.13},{shape:'square'}]},{name:'Silence',count:1,keyframes:[{shape:'unknown'}]},{name:'Harmonics',count:1,keyframes:[{harmonics:[1,.5,-.25]}]},{name:'Coerced',count:1,keyframes:[{harmonics:'123'}]},{name:'Object',count:1,keyframes:[{harmonics:{length:2,0:1,1:.2}}]},{name:'Invalid',count:2,keyframes:[{harmonics:['x']},{shape:'sine'}]},{name:'Infinite',count:2,keyframes:[{harmonics:['Infinity']},{shape:'sine'}]}])await run('wavetable-write',seed,[{input:{device:'7:device:0:0',action:'wavetable',wavetable},plugin:true},{input:{device:'7:device:0:0',action:'wavetable',wavetable},plugin:true}]);
writeFileSync(new URL('command-tools-oracle.json',import.meta.url),JSON.stringify({cases})+'\n');console.log(cases.length+' source command/plug-in sequences');
}finally{unlinkSync(file)}
