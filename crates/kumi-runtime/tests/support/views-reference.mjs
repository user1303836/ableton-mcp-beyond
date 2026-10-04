// Source is instrumented only to expose private reads; production TypeScript stays unchanged.
import {readFileSync,writeFileSync,unlinkSync} from 'node:fs';
const original=new URL('../../../../packages/runtime/dist/src/integrations/ableton/index.js',import.meta.url);
const file=new URL('index.views-oracle.js',original);const source=readFileSync(original,'utf8');
const marker='    return {\n        async start(signal) {\n            if (closed || started)';
if(!source.includes(marker))throw Error('source hook changed');
writeFileSync(file,source.replace(marker,`    available=options.fixture.available !== false; lost=options.fixture.lost === true;
    endpoint={serverInfo:{version:options.fixture.version}}; tools=options.fixture.tools;
    return { _pages:pages, _tree:readDeviceTree, _pointed:pointedPin, _pin:async(pin,signal)=>{currentEpoch=7;const value=await checkPin(pin,signal);return {value,refs:[...refs]};},
        async start(signal) {
            if (closed || started)`));
const wrap=body=>({content:[{type:'text',text:JSON.stringify(body)}],structuredContent:body});
const page=(items=[],extra={})=>wrap({epoch:7,kind:'fixture',revision:'r1',items,truncated:false,...extra});
const error={isError:true,content:[{type:'text',text:'fixture failure'}]};
const cases=[];
try {
 const {createAbletonIntegration}=await import(file.href);
 async function run(label,method,args,respond,settings={}) {
  const controller=new AbortController(),calls=[],responses=[];
  const tools={has:name=>!(settings.missing??[]).includes(name),async call(name,input,signal){
   signal.throwIfAborted();calls.push({name,args:structuredClone(input)});
   const reply=respond(name,input,calls.length-1)??page();responses.push(structuredClone(reply));
   if(reply.abort){controller.abort();signal.throwIfAborted();}
   if(reply.throw)throw Error(reply.throw);
   return reply;
  }};
  const integration=createAbletonIntegration({onConnection(){},fixture:{tools,...settings}});
  let value;try {value=(await integration[method](...args,controller.signal))??null;}catch(e){value={error:controller.signal.aborted?'cancelled':e.message};}
  cases.push({label,method,args,settings,calls,responses,value});
 }
 for(const limit of [undefined,0,1,2,3,4,100,2.5,-1]) for(const tail of ['end','repeat','epoch','kind','error','throw','malformed']) {
  await run(`pages-${limit}-${tail}`,'_pages',[{kind:'fixture',...(limit===undefined?{}:{limit})}],(_,args,i)=>i===0?page([{ref:'a'},{ref:'b'}],{nextCursor:'next',truncated:true}):tail==='error'?error:tail==='throw'?{throw:'read failed'}:tail==='malformed'?{content:[{type:'text',text:'no JSON'}]}:page([{ref:'c'}],tail==='repeat'?{nextCursor:'next'}:tail==='epoch'?{epoch:8}:tail==='kind'?{kind:'track'}:{}));
 }
 for(const result of [page(),error,{content:[{type:'text',text:'no JSON'}]},wrap({nextCursor:0}),wrap({nextCursor:'',items:[]})])await run('pages-single','_pages',[{kind:'fixture'}],()=>result);
 const treeRows={
  '7:track:0':[{ref:'7:device:0:0',name:'Rack',canHaveChains:true,deviceType:'instrument',chainList:[{ref:'7:chain:0:0:0',name:'Layer'},{ref:'7:chain:0:0:1',name:'Empty'}]},{ref:'7:device:0:1',canHaveDrumPads:true,chainList:[{ref:'pad-chain'}]},{ref:'7:device:0:2',name:'Long'.repeat(100),className:'Class'.repeat(60),deviceType:'audio_effect'}],
  '7:chain:0:0:0':[{ref:'7:device:0:0:0:0',name:'Nested',chainList:[{ref:'inner-chain',name:'Inside'}]}],
  'inner-chain':[{ref:'7:device:deep',name:'Synth'}],
 };
 for(const version of [undefined,'1.0.1','1.0.57','1.0.73'])for(const failAt of [-1,0,1,2,3])await run(`tree-${version}-${failAt}`,'_tree',['7:track:0'],(_,a,i)=>i===failAt?error:page(treeRows[a.parent]??[]),{version});
 for(const setting of [{available:false},{lost:true},{missing:['live_discover']}])await run('tree-unavailable','_tree',['7:track:0'],()=>{throw Error('unexpected read')},setting);
 for(const ref of ['track:1','-1:track:0','7:track:x','٧:track:0','7:track:1:2'])await run('tree-invalid','_tree',[ref],()=>{throw Error('unexpected read')});
 await run('tree-paged','_tree',['7:track:0'],(_,a)=>a.cursor?page([{ref:'second'}]):page([{ref:'first',chainList:[null,{}, {ref:4}]}],{nextCursor:'two'}));
 await run('tree-depth','_tree',['7:track:0'],(_,a,i)=>page([{ref:'d'+i,chainList:[{ref:'c'+i}]}]));
 await run('tree-many-chains','_tree',['7:track:0'],(_,a,i)=>page(i===0?[{ref:'rack',chainList:Array.from({length:140},(_,i)=>({ref:'c'+i,name:'n'+i}))}]:[]));
 await run('tree-cancel','_tree',['7:track:0'],()=>({abort:true}));
 for(const count of [0,1,6,7,8,12])for(const scene of [-5,0,.5,3,3.5,6,6.5,20])await run(`strip-${count}-${scene}`,'sessionStrip',['7:track:0',scene],(_,a)=>a.kind==='clip-slot'?page(Array.from({length:count},(_,i)=>({ref:'slot'+i,sceneIndex:i,...(i%2?{clipRef:'clip'+i}:{}),playingStatus:i%3}))):page([{name:'Clip '+a.parent,isAudio:a.parent==='slot3'}]));
 for(const sceneIndex of [-1,0.5,'5',null,9])await run(`strip-index-${sceneIndex}`,'sessionStrip',['7:track:0',0],(_,a)=>a.kind==='clip-slot'?page([{ref:'slot',sceneIndex,clipRef:'clip'}]):page([{name:'🦀'.repeat(140),isAudio:true}]));
 for(const fail of ['error','throw','malformed','empty','cancel'])await run('strip-clip-'+fail,'sessionStrip',['7:track:0',0],(_,a)=>a.kind==='clip-slot'?page([{ref:'slot',clipRef:'clip'}]):fail==='error'?error:fail==='throw'?{throw:'oops'}:fail==='malformed'?{content:[]}:fail==='cancel'?{abort:true}:page());
 const note=(i)=>({id:i,pitch:60+i%12,start:i/4,duration:.25,velocity:80});
 for(const count of [0,1,32,512,520])for(const paged of [false,true])await run(`clip-${count}-${paged}`,'clipView',['7:clip_slot:0:0'],(name,a)=>name==='live_note_read'?wrap({notes:[{id:0},{id:2},{id:'3'}]}):a.kind==='session-clip'?page([{name:'Notes',length:8}]):page(Array.from({length:paged?Math.ceil(count/2):count},(_,i)=>note(i+(a.cursor?Math.ceil(count/2):0))),paged&&!a.cursor?{nextCursor:'tail'}:{}));
 for(const clip of [{},{length:0},{length:-1},{length:'4'},{length:4,isAudio:true},{length:4,name:'🦀'.repeat(140)}])await run('clip-shape','clipView',['7:clip_slot:0:0'],(_,a)=>page(a.kind==='session-clip'?[clip]:[{pitch:60,start:0,duration:1},{pitch:'60',start:0,duration:1},{pitch:60,start:0,duration:1,velocity:'x'}]));
 for(const where of ['clip','note','selected'])for(const mode of ['error','throw','cancel'])await run(`clip-${where}-${mode}`,'clipView',['7:clip_slot:0:0'],(name,a)=>((where==='clip'&&a.kind==='session-clip')||(where==='note'&&a.kind==='note')||(where==='selected'&&name==='live_note_read'))?(mode==='error'?error:mode==='cancel'?{abort:true}:{throw:'failed'}):a.kind==='session-clip'?page([{length:4}]):page([note(0)]));
 for(const position of [0,5,32,null,'7'])for(const length of [undefined,0,100])await run(`arrange-${position}-${length}`,'arrangementStrip',[],(name,a)=>name==='live_song_state'?wrap({...(length===undefined?{}:{songLength:length})}):a.kind==='set'?page([{position,playing:true,loop:{length:8,enabled:true}}]):page([{name:'Verse',position:8},{position:24},{name:'Invalid',position:'bad'}]));
 for(const kind of ['set','locator','song'])for(const failure of ['error','throw','cancel'])await run(`arrange-fail-${kind}-${failure}`,'arrangementStrip',[],(name,a)=>((kind==='song'&&name==='live_song_state')||kind===a.kind)?(failure==='error'?error:failure==='cancel'?{abort:true}:{throw:'failed'}):name==='live_song_state'?wrap({songLength:42}):a.kind==='set'?page([{position:5}]):page([{name:'End',position:32}]));
 for(const method of ['sessionStrip','clipView','arrangementStrip'])for(const settings of [{available:false},{lost:true},{missing:['live_discover']}])await run('unavailable-'+method,method,method==='sessionStrip'?['7:track:0',0]:method==='clipView'?['7:clip_slot:0:0']:[],()=>{throw Error('unexpected read')},settings);
 for(const kind of ['track','scene','clip_slot','session_clip','arrangement_clip','device','chain','unknown',null,{}])for(const name of [undefined,'','Thing'])await run('pointed-basic','_pointed',[{payload:{kind,ref:'7:device:4:0',...(name===undefined?{}:{name}),trail:['Track','Rack',name??''],path:[4,0]}}],()=>page());
 for(const data of [{},{ref:''},{ref:12},{ref:'7:track:0',trail:[null,4,'Bass']},{kind:'arrangement_selection',lanes:[{ref:'7:track:0',kind:'track',name:'Bass'},{name:'Kick'}],timeSelection:{fromBeat:4,toBeat:12}},{kind:'session_selection',slots:[{ref:'7:clip_slot:0:0',name:'Clip'},{name:null}]},{kind:'selection',lanes:[null,{}]},{kind:'scene',ref:'7:scene:0',path:[.5]}])await run('pointed-shape','_pointed',[{payload:data,ref:'7:device:fallback'}],()=>page());
 const pin={trackRef:'7:track:0',ref:'7:device:0:0',node:'device',name:'Rack',trail:[],siblings:[],track:'Bass'};
 for(const live of [false,true])for(const node of ['device','chain','track','scene','clip','clip-slot','selection'])for(const reference of ['7:device:0:0','8:device:0:0','7:device:old'])await run('pin-kind-ref','_pin',[{...pin,live,node,ref:reference}],(_,a)=>page(treeRows[a.parent]??[]));
 for(const p of [{...pin,name:'Nested',ref:'gone',trail:['Rack','Layer'],siblings:Array.from({length:15},(_,i)=>'n'+i)},{...pin,name:'Layer',node:'chain',ref:'gone',trail:['Rack']},{...pin,name:'Synth',ref:'gone',trail:['Rack','Layer','Nested','Inside']},{...pin,name:'Not here'},{...pin,live:true,time:{fromBeat:0,toBeat:16}},{...pin,live:true,ref:'7:clip:0:0',node:'clip'}])await run('pin-nested','_pin',[p],(_,a)=>page(treeRows[a.parent]??[]));
 writeFileSync(new URL('views-oracle.json',import.meta.url),JSON.stringify({cases})+'\n');console.log(cases.length+' source view traces');
}finally{unlinkSync(file);}
