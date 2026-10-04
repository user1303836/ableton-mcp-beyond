import{readFileSync,writeFileSync,unlinkSync}from'node:fs';
const original=new URL('../../../../packages/runtime/dist/src/integrations/ableton/index.js',import.meta.url),file=new URL('index.observation-oracle.js',original);let source=readFileSync(original,'utf8');
const marker='    return {\n        async start(signal) {\n            if (closed || started)';if(!source.includes(marker)||!source.includes('    function definitions() {'))throw Error('source hook changed');
// Tool implementations are tested separately. This captures the complete observation/context path.
source=source.replace('    function definitions() {','    function definitions() { return [];');
source=source.replace(marker,`    return {
        _seed(config){if(config.reconnected!==undefined)reconnected=config.reconnected;if(config.lost!==undefined)lost=config.lost;if(config.available!==undefined)available=config.available;for(const c of config.changes??[])changes.set(c.record.id,c);},
        _invalidate:invalidate,
        _state(){return{epoch:currentEpoch??null,lease:observationGeneration,lastTrackCount,currentTempo:currentTempo??null,beatsPerBar,refs:[...refs],cursors:[...cursors],known:[...known]};},
        async start(signal){
            if(closed||started)`);writeFileSync(file,source);
const wrap=value=>({content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value});
const baseTrack=(index=0)=>({ref:`7:track:${index}`,parentRef:'7:set:0',name:['Bass','Kick','Keys'][index]??`Track ${index}`,kind:'regular',mediaKind:index%2?'audio':'midi',color:index*12345,mixer:{volumeDisplay:'-6.0 dB',panDisplay:'C'}});
const baseDevices=[{ref:'7:device:0:0',parentRef:'7:track:0',name:'Rack',className:'InstrumentGroupDevice',chainList:[{ref:'7:chain:0:0:0',name:'Low'},{ref:'7:chain:0:0:1',name:'Air'}]},{ref:'7:device:0:0:0:0',parentRef:'7:chain:0:0:0',name:'Nested',chainList:[{ref:'7:chain:inner',name:'Inside'}]},{ref:'7:device:inside',parentRef:'7:chain:inner',name:'Analog',className:'Analog'},{ref:'7:device:1:0',parentRef:'7:track:1',name:'EQ Eight',className:'Eq8'}];
const cases=[];
try{const{createAbletonIntegration}=await import(file.href);
 async function run(label,turns,settings={}){
  let config={},integration,signal;const calls=[],responses=[],states=[],results=[];const listeners=new Set();
  const endpoint={pid:null,serverInfo:{name:'fixture',version:settings.version??'1.0.73'},async list(){return{tools:['live_status','live_discover','live_song_state','live_project_info'].filter(n=>!(config.missing??[]).includes(n)).map(name=>({name,inputSchema:{type:'object'}}))};},async call(name,args,abort){
   abort.throwIfAborted();calls.push({name,args:structuredClone(args)});const kind=name==='live_discover'?String(args.kind):name;
   let entry;if(config.fail?.kind===kind){const mode=config.fail.mode;entry=mode==='throw'?{throw:'private upstream failure'}:mode==='error'?{reply:{isError:true,content:[{type:'text',text:'unavailable'}]}}:mode==='malformed'?{reply:{content:[{type:'text',text:'bad JSON'}]}}:undefined;}
   if(!entry){let body;
    if(name==='live_status')body={connected:true,adapter:'remote-script',provenance:'fake-live',epoch:7,environment:{liveVersion:'12.0'},...config.status};
    else if(name==='live_song_state')body={signatureNumerator:4,signatureDenominator:4,sessionRecord:false,swingAmount:0,...config.song};
    else if(name==='live_project_info')body={path:'',exists:false,...config.projectInfo};
    else{
     let items=kind==='set'?[{ref:'7:set:0',objectIdentity:'song',name:'Set',tempo:120,playing:false,position:0,loop:{start:0,length:16},recording:false,filePath:'',...config.set}]:kind==='track'?(config.tracks??Array.from({length:config.count??3},(_,i)=>baseTrack(i))):kind==='device'?(config.devices??baseDevices):kind==='selection'?(config.selection??[{selectedTrackRef:'7:track:0'}]):[];
     if(kind==='set'&&config.setRows)items=config.setRows;
     const all=items;const size=config.pageSize??100000;const start=args.cursor?Number(args.cursor):0;
     if(kind==='track'||kind==='device')items=items.slice(start,start+size);
     // Real discovery projects only requested fields.
     if(Array.isArray(args.fields))items=items.map(row=>Object.fromEntries(Object.entries(row).filter(([key])=>args.fields.includes(key))));
     body={epoch:config.epochs?.[kind]??7,kind,items,revision:'r1',truncated:config.truncated?.includes(kind)??false,...((kind==='track'||kind==='device')&&start+size<all.length?{nextCursor:String(start+size),truncated:true}:{})};
    }
    entry={reply:wrap(body)};
   }
   if(config.fail?.kind===kind&&['invalidate','disconnect','abort'].includes(config.fail.mode))entry.effect=config.fail.mode;
   responses.push(structuredClone(entry));if(entry.effect==='invalidate')integration._invalidate();if(entry.effect==='disconnect')for(const callback of listeners)callback();if(entry.effect==='abort'){signal.abort();abort.throwIfAborted();}
   if(entry.throw)throw Error(entry.throw);return entry.reply;
  },onCatalogChanged(){return()=>{};},onDisconnect(callback){listeners.add(callback);return()=>listeners.delete(callback);},stderrStatus(){return{bytes:0,truncated:false};},async close(){}};
  integration=createAbletonIntegration({connect:async()=>endpoint,onConnection:(state,cause)=>states.push([state,cause??null]),now:()=>new Date('2026-10-03T12:00:00Z'),generation:'connection',reconnectIntervalMs:3600000});await integration.start(new AbortController().signal);
  for(config of turns){signal=new AbortController();integration._seed(config);if(config.abort)signal.abort();let value;try{const result=await integration.observe(signal.signal,config.hints);value={...result,tools:result.tools.map(t=>t.name)};}catch(error){value={error:signal.signal.aborted&&error.name==='AbortError'?'cancelled':error.message};}results.push({value,state:integration._state()});}
  await integration.close();cases.push({label,turns,settings,calls,responses,states,results});
 }
 await run('basic',[{},{}]);
 for(const count of [0,1,64,65,100,400])await run('track-count-'+count,[{count},{count}]);
 for(const pageSize of [1,2,3,100])await run('page-size-'+pageSize,[{count:12,pageSize}]);
 for(const version of ['1.0.1','1.0.57'])await run('bridge-version-'+version,[{count:110,pageSize:10}],{version});
 for(const name of ['',null,'  ','A'.repeat(300),'🦀'.repeat(140)])await run('set-name',[{set:{name}}]);
 for(const mixer of [null,{},[],false,{volumeDisplay:'-6 dB'.repeat(10),panDisplay:'Left'.repeat(10)}])await run('track-mixer',[{tracks:[{...baseTrack(),mixer}]}]);
 for(const tracks of [[{...baseTrack(),kind:'group',mediaKind:'audio'}],[{...baseTrack(),name:null,mediaKind:null,groupTrackRef:'7:track:2'}],[{...baseTrack(),ref:null,name:'🦀'.repeat(150)}]])await run('track-shape',[{tracks}]);
 for(const devices of [[],[...baseDevices].reverse(),[{ref:'7:device:0:0',parentRef:'7:track:0',name:'🦀'.repeat(100),className:'x'.repeat(100),chainList:[null,{}, {ref:'7:chain:0:0:0'}]}],[{ref:4,parentRef:'7:track:0'},{ref:'7:device:empty',parentRef:'7:track:1',name:'',className:''}],[{ref:'7:device:many',parentRef:'7:track:0',chainList:Array.from({length:40},(_,i)=>({ref:'7:chain:'+i,name:'Layer'+i}))}]])await run('device-shape',[{devices}]);
 for(const selection of [[],[{}],[{selectedTrackRef:'gone'}],[{selectedTrackRef:'7:track:2'}]])await run('selection',[{selection}]);
 for(const [signatureNumerator,signatureDenominator] of [[3,4],[6,8],[7,8],[null,4],['7','8'],[0,4],[4,0]])await run('time-signature',[{song:{signatureNumerator,signatureDenominator,sessionRecord:true,swingAmount:.4}}]);
 for(const kind of ['live_status','set','track','device','selection','live_song_state'])for(const mode of ['throw','error','malformed','invalidate','disconnect','abort'])await run('failed-'+kind+'-'+mode,[{fail:{kind,mode}}]);
 for(const kind of ['set','track','device','selection'])await run('wrong-epoch-'+kind,[{epochs:{[kind]:8}}]);
 for(const missing of [['live_status'],['live_discover'],['live_song_state'],['live_project_info']])await run('missing-tools',[{missing}]);
 for(const status of [{connected:false},{provenance:'real-live'},{provenance:null},{epoch:null},{environment:[]},{environment:null}])await run('status-shape',[{status}]);
 for(const setRows of [[],[{ref:'7:set:0'},{ref:'7:set:1'}],[{name:'Missing reference'}]])await run('set-rows',[{setRows}]);
 await run('set-identity',[{},{set:{name:'Renamed'}},{set:{objectIdentity:'other'}},{set:{objectIdentity:'other',name:'Other title'}}]);
 await run('reconnect',[{},{lost:true},{lost:false,reconnected:true,set:{ref:'8:set:0',objectIdentity:'restarted'},status:{epoch:8},epochs:{set:8,track:8,device:8,selection:8}}]);
 await run('unavailable-first',[{available:false},{available:true}]);
 await run('aborted-turn',[{abort:true},{}]);
 const pin={trackRef:'7:track:1',ref:'7:track:1',node:'track',name:'Kick',trail:[],siblings:[],live:true};await run('live-pin',[{hints:{pinned:pin}},{hints:{pinned:{...pin,ref:'6:track:1'}}}]);
 const changes=Array.from({length:20},(_,i)=>({record:{id:'c'+i,family:'mixer',title:'Change '+i,state:i%3?'applied':'undone',at:0,track:{name:'Track '+(i%6)},...(i%2?{note:'Note'}:{})},...(i%4===0?{within:'group'}:{})}));await run('recent-changes',[{count:200,changes},{hints:{continuing:true},count:200}]);
 const values=[],ids=new Map();for(const c of cases)c.responses=c.responses.map(v=>{const key=JSON.stringify(v);if(!ids.has(key)){ids.set(key,values.length);values.push(v);}return ids.get(key);});writeFileSync(new URL('observation-oracle.json',import.meta.url),JSON.stringify({cases,values})+'\n');console.log(cases.length+' source observation sequences');
}finally{unlinkSync(file)}
