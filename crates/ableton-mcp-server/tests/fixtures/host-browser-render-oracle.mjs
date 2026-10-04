import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
const base=new URL('.',pathToFileURL(process.argv[2]));
const {McpHost}=await import(new URL('host.js',base));
const {DeterministicLiveSimulator,LIVE_REGISTRY_OPERATIONS}=await import(new URL('live.js',base));
const context=c=>c===undefined?null:{...(c.deadlineMs===undefined?{}:{deadlineSeconds:Math.round((c.deadlineMs-Date.now())/250)/4}),...(c.signal===undefined?{}:{signal:true})};
const clean=v=>{if(v?.result?.content?.[0]?.type==='text')try{v.result.content[0].text=JSON.parse(v.result.content[0].text)}catch{}return v};
const item=(name,id,category='instruments',path='Library/Instruments')=>({id,objectIdentity:'object-'+id,name,category,path,isDevice:true,extra:'discard'});
const items=[item('Bass','b'),item('Bass Amp','ba','audio_effects'),item('SubBass','sub'),item('bass','lower'),item('Bassist','ist'),item('Amplifier','amp','audio_effects','Library/Bass Amp'),item('Apple','z'),item('Apple','a'),item('','empty'),item('😀','emoji'),item('\ue000','private'),item('İSTANBUL','istanbul'),item('ΟΣ','greek'),item('Custom','custom','packs','x/subbass/sub')];
const defaults={'browser.search':{items},'render.offline':{filePath:'/tmp/offline.wav',frames:44100,sampleRate:44100,name:'overridden',trackRef:'wrong',fromBeat:100,toBeat:101}};
const cases=[];
async function run(label,steps,options={}){
 const sim=new DeterministicLiveSimulator(),calls=[],status=sim.status();status.operations=[...LIVE_REGISTRY_OPERATIONS];
 Object.assign(sim.state.tracks[0],{mediaKind:'audio'});
 if(options.statusPatch)Object.assign(status,options.statusPatch);
 if(options.trackPatch)Object.assign(sim.state.tracks[0],options.trackPatch);
 const snapshot=sim.snapshotAsync.bind(sim),invoke=sim.invokeAsync.bind(sim);let step={};
 sim.status=()=>structuredClone(status);
 sim.refreshStatusAsync=async c=>{calls.push({kind:'refresh',context:context(c)});if(step.fail==='refresh')throw Error('request failed: offline');return sim.status()};
 sim.snapshotAsync=async (c,r)=>{calls.push({kind:'snapshot',context:context(c),request:r??null});if(step.fail==='snapshot')throw Error('request failed: no snapshot');return snapshot(c,r)};
 sim.invokeAsync=async (i,c)=>{
  calls.push({kind:'invoke',invocation:i,context:context(c)});
  if(step.fail==='invoke')throw Error('request failed: exact refusal');
  if(step.returnCount!==undefined)return {items:Array.from({length:step.returnCount},(_,n)=>item('Bass',String(n)))};
  if(Object.hasOwn(step,'returns'))return structuredClone(step.returns);
  return Object.hasOwn(defaults,i.operation)?structuredClone(defaults[i.operation]):invoke(i,c);
 };
 const host=new McpHost(sim),results=[];
 for(step of steps){
  if(step.statusPatch)Object.assign(status,step.statusPatch);
  if(step.trackPatch)Object.assign(sim.state.tracks[0],step.trackPatch);
  calls.length=0;
  const controller=new AbortController();if(step.abort)controller.abort();
  try{results.push({result:clean(await host[step.tool==='render'?'liveRenderOfflineAsync':'liveBrowserSearchAsync'](1,step.args,controller.signal)),calls:structuredClone(calls)})}catch(e){results.push({error:e.message,calls:structuredClone(calls)})}
 }
 cases.push({label,steps,...options,results});
}
const render={trackRef:'track:2',fromBeat:0,toBeat:4,expectedName:'Bass'};
// Discover the simulator's audio-track authority rather than inventing a test-only reference.
const reference=new DeterministicLiveSimulator().snapshot().tracks[0];render.trackRef=reference.ref;render.expectedName=reference.name;
const valid={browser:{category:'instruments',query:'bass amp',limit:10,matchMode:'ranked',refresh:false},render};
const bad=[null,[],{},0,1,1.5,-1,false,true,'','x','😀'.repeat(257)];
for(const [tool,args]of Object.entries(valid)){
 await run('valid',[{tool,args}]);
 for(const args of [undefined,...bad])await run('validation',[{tool,...(args===undefined?{}:{args})}]);
 await run('extra',[{tool,args:{...args,extra:true}}]);
 for(const key of Object.keys(args)){
  const missing={...args};delete missing[key];await run('missing',[{tool,args:missing}]);
  for(const value of bad)await run('field',[{tool,args:{...args,[key]:value}}]);
 }
 for(const fail of ['refresh','snapshot','invoke'])await run('failure',[{tool,args,fail}]);
 for(const statusPatch of [{connected:false},{capabilities:[]},{operations:[]}])await run('capability',[{tool,args}],{statusPatch});
 await run('abort',[{tool,args,abort:true}]);
}
for(const query of ['', ' ', 'bass', 'BaSs Amp', 'sub', 'ass', 'no match', 'İSTANBUL', 'ΟΣ','😀','   bass\uFEFF','a '.repeat(100),Array.from({length:20},(_,n)=>'t'+n).join(' '),'a'.repeat(64),'a'.repeat(65),'bass bass amp'])await run('rank',[{args:{query,limit:2}}]);
for(const category of ['clips',['instruments'],[['plugins']],{toString:null},['bad'],null])await run('category',[{args:{category}}]);
for(const matchMode of ['ranked','substring'])for(const returns of [null,1,true,'x',[],{}, {items:null},{items:[]},{items:[null]}, {items:[{id:'x'}]}])await run('result-shape',[{args:{matchMode},returns}]);
for(const field of ['id','objectIdentity','name','category','path','isDevice'])for(const value of [null,'',false,1,'😀'.repeat(field==='path'?257:129)])await run('candidate',[{args:{},returns:{items:[{...items[0],[field]:value}]}}]);
for(const returnCount of [10000,10001])await run('bound',[{args:{limit:1},returnCount}]);
await run('cache',[{args:{query:'bass'}},{args:{query:'amp'},fail:'invoke'},{args:{refresh:true}},{args:{category:['instruments']}},{args:{category:'instruments'}},{args:{category:'instruments',query:'apple'}},{args:{},statusPatch:{epoch:2}},{args:{}},{args:{},statusPatch:{connected:false}}]);
await run('substring',[{args:{matchMode:'substring',query:'bass',limit:2,category:'instruments'}},{args:{matchMode:'substring'}},{args:{}}]);
for(const trackPatch of [{objectIdentity:''},{kind:'group'},{kind:'return'},{kind:'main'},{kind:'midi',mediaKind:'midi'},{kind:'audio',mediaKind:'audio'}])await run('track-kind',[{tool:'render',args:render}],{trackPatch});
for(const args of [{...render,trackRef:'unknown'},{...render,expectedName:'renamed'},{...render,fromBeat:4,toBeat:4},{...render,toBeat:1000},{...render,toBeat:0.25}])await run('render-boundary',[{tool:'render',args}]);
for(const returns of [null,{},false,1,'abc',[],[1,2]])await run('render-spread',[{tool:'render',args:render,returns}]);
const pool=[],seen=new Map(),intern=v=>{const key=JSON.stringify(v);if(!seen.has(key)){seen.set(key,pool.length);pool.push(v)}return seen.get(key)};
for(const c of cases)c.results=c.results.map(intern);
fs.writeFileSync(new URL('host-browser-render-oracle.json',import.meta.url),JSON.stringify({defaults,cases,pool}));
console.log(cases.length+' browser/render scenarios');
