import {readFileSync,writeFileSync,unlinkSync} from 'node:fs';
const original=new URL('../../../../packages/runtime/dist/src/integrations/ableton/index.js',import.meta.url);const file=new URL('index.connection-oracle.js',original);const source=readFileSync(original,'utf8');
const marker='    return {\n        async start(signal) {\n            if (closed || started)';if(!source.includes(marker))throw Error('source hook changed');
writeFileSync(file,source.replace(marker,`    return {
        _invoke:invoke, _invalidate:invalidate, _loseLive:loseLive, _loseAccess:loseAccess, _look:lookForLive, _readStatus:readStatus, _subscribe:subscribe, _transport:readTransport, _seedChanges(){changes.set("c1",{record:{id:"c1",state:"applied"}});},
        async _ready(signal){await tools.refresh(signal);},
        _seed(seed){ currentEpoch=seed.epoch; currentSet=seed.set; lastEpoch=seed.epoch; available=seed.available!==false; lost=seed.lost===true;
          for(const [kind,rows,args] of seed.rows??[]) registerRows(kind,rows,args); for(const ref of seed.shorts??[]) shortRef(ref); },
        _state(){return {available,lost,closed,lease:observationGeneration,epoch:currentEpoch??null,refs:[...refs],cursors:[...cursors],known:[...known],reconnected};},
        async start(signal) {
            if (closed || started)`));
const wrap=body=>({content:[{type:'text',text:JSON.stringify(body)}],structuredContent:body});
const page=(kind,items,extra={})=>wrap({epoch:7,kind,items,revision:'r1',truncated:false,...extra});
const status=(extra={})=>wrap({connected:true,adapter:'remote-script',epoch:7,provenance:'fake-live',...extra});
const base={epoch:7,set:'["7:set:0","song"]',rows:[['track',[{ref:'7:track:0',name:'Bass'}],{}],['device',[{ref:'7:device:0:0',parentRef:'7:track:0',name:'Filter'}],{}]],shorts:['7:track:0','7:device:0:0']};
const catalog=['live_status','live_discover','server_status','live_note_read','live_device_read'];const cases=[];
try{
 const {createAbletonIntegration}=await import(file.href);
 const {KUMI}=await import(new URL('../../command.js',original).href);
 async function run(label,name,input,respond,settings={}){
  let integration;const calls=[],responses=[],states=[],disconnects=new Set();let closes=0;let signal=new AbortController();
  const endpoint={pid:null,serverInfo:{name:'fixture',version:'1.0.73'},async list(){return{tools:catalog.filter(n=>n!==settings.missing).map(name=>({name,inputSchema:{type:'object',properties:{},additionalProperties:true}}))};},async call(name,args,abort){
   abort.throwIfAborted();calls.push({name,args:structuredClone(args)});const entry=respond(name,args,calls.length-1)??{reply:status()};responses.push(structuredClone(entry));
   if(entry.effect==='invalidate')integration._invalidate();if(entry.effect==='disconnect')for(const listener of disconnects)listener();if(entry.effect==='abort'){signal.abort();abort.throwIfAborted();}
   if(entry.throw)throw Error(entry.throw);return entry.reply;
  },onCatalogChanged(){return()=>{};},onDisconnect(f){disconnects.add(f);return()=>disconnects.delete(f);},stderrStatus(){return{bytes:0,truncated:false};},async close(){closes++;}};
  integration=createAbletonIntegration({connect:async()=>endpoint,generation:'connection',now:()=>new Date('2026-10-03T12:00:00.000Z'),onConnection:(state,cause)=>states.push([state,cause??null]),reconnectIntervalMs:3600000});
  await integration.start(signal.signal);await integration._ready(signal.signal);const seed={...base,...settings.seed};integration._seed(seed);
  if(settings.abort)signal.abort();const value=await integration._invoke(name,input,signal.signal);const state=integration._state();await integration.close();
  cases.push({label,name,input,settings,seed,calls,responses,states,value,state,closes});
 }
 const discover=(name,args)=>({reply:name==='live_status'?status():page(String(args.kind),args.kind==='set'?[{ref:'7:set:0',objectIdentity:'song',name:'Set'}]:[{ref:'7:parameter:0:0:0',parentRef:args.parent,name:'Cutoff',value:1000}])});
 for(const input of [{kind:'parameter',parent:'device:1'},{kind:'device',parent:'track:1'},{kind:'set'},{kind:'track'}, {kind:'unknown'}, {kind:'parameter',parent:'gone'}, {kind:'parameter',parent:4},{kind:'parameter'},{kind:'device',parent:'track:1',cursor:'old'},{kind:'track',fields:[]}])await run('discovery-basic','live_discover',input,discover);
 for(const input of [{deviceRef:'device:1'},{deviceRef:'gone'},{deviceRef:7},{values:[{deviceRef:'gone'}]},{other:{deviceRef:'gone'}},{}])await run('non-discovery','live_device_read',input,(name)=>({reply:name==='live_status'?status():wrap({ok:true,ref:'7:device:0:0'})}));
 for(const settings of [{seed:{available:false}},{seed:{lost:true}},{seed:{epoch:undefined}},{abort:true},{missing:'live_discover'}])await run('unavailable','live_discover',{kind:'track'},discover,settings);
 for(const method of ['live_discover','server_status','live_status','live_note_read'])for(const at of [0,1,2])for(const failure of ['throw','error','malformed','epoch','disconnect','invalidate','abort','oversized'])await run(`read-${method}-${at}-${failure}`,method,method==='live_discover'?{kind:'device',parent:'track:1'}:{},(name,args,index)=>{
  if(index!==at)return discover(name,args);
  if(failure==='throw')return{throw:'private upstream detail'};
  if(failure==='error')return{reply:{isError:true,content:[{type:'text',text:'upstream refused'}]}};
  if(failure==='malformed')return{reply:{content:[{type:'text',text:'bad JSON'}]}};
  if(failure==='epoch')return{reply:name==='live_status'?status({epoch:8}):page(String(args.kind),[],{epoch:8})};
  if(failure==='oversized')return{reply:wrap({huge:'x'.repeat(66*1024)})};
  return{...discover(name,args),effect:failure};
 });
 for(const tail of ['end','repeat','error','throw','kind','epoch','parent','oversize','large'])await run('read-ahead-'+tail,'live_discover',{kind:'parameter',parent:'device:1'},(name,args,index)=>{
  if(name==='live_status')return{reply:status()};
  if(index===0)return{reply:page('parameter',[{ref:'7:parameter:0',parentRef:'7:device:0:0',name:'first'}],{nextCursor:'second',truncated:true})};
  if(tail==='error')return{reply:{isError:true,content:[{type:'text',text:'bad'}]}};if(tail==='throw')return{throw:'bad'};if(tail==='oversize')return{reply:wrap({huge:'x'.repeat(66000)})};
  return{reply:page(tail==='kind'?'track':'parameter',[{ref:'7:parameter:'+index,parentRef:tail==='parent'?'gone':'7:device:0:0',name:tail==='large'?'x'.repeat(33000):'more'}],tail==='epoch'?{epoch:8}:tail==='repeat'?{nextCursor:'second'}:index===1?{nextCursor:'third'}:{})};
 });
 for(const set of [{ref:'7:set:other',objectIdentity:'song'},{ref:'7:set:0',objectIdentity:'other'},{}])await run('set-identity','live_discover',{kind:'set'},name=>({reply:name==='live_status'?status():page('set',[set])}));
 const lifecycle=[];
 async function life(label,configs,commands,transport=false){
  const states=[],calls=[],notes=[],connections=[],results=[],transports=[];let attempts=0;let integration;
  const endpoints=configs.map((config,id)=>{let at=0,closes=0;const listeners=new Set();return{pid:null,serverInfo:{name:'fixture',version:'1.0.73'},async list(){return{tools:['live_status','live_discover',...(transport?['live_subscribe','live_song_state']:[])].map(name=>({name,inputSchema:{type:'object'}}))};},async call(name,args,signal){signal.throwIfAborted();calls.push({endpoint:id,name,args:structuredClone(args)});const index=at++;if(config.replies){const value=config.replies[Math.min(index,config.replies.length-1)];if(value.throw)throw Error(value.throw);if(value.error)return{isError:true,content:[{type:'text',text:'refused'}]};return wrap(value);}const value=config.statuses?.[Math.min(index,config.statuses.length-1)]??{connected:true,epoch:7};if(value.throw)throw Error(value.throw);return status(value);},onCatalogChanged(){return()=>{};},onDisconnect(f){listeners.add(f);return()=>listeners.delete(f);},stderrStatus(){return{bytes:0,truncated:false};},async close(){closes++;},disconnect(){for(const f of listeners)f();},get closes(){return closes;}};});
  integration=createAbletonIntegration({connect:async signal=>{const id=attempts++;connections.push(id);if(configs[id]?.fail)throw Error('spawn failed');if(!endpoints[id])throw Error('no endpoint');return endpoints[id];},onConnection:(state,cause)=>states.push([state,cause??null]),onChange:record=>notes.push(record.note),...(transport?{onTransport:t=>transports.push(t?{...t,at:0}:null)}:{}),generation:'connection',reconnectIntervalMs:3600000});
  for(const command of commands){let value=null;const signal=new AbortController();if(command==='abortStart')signal.abort();try{
   if(command==='start'||command==='abortStart'){await integration.start(signal.signal);await integration._ready(signal.signal);integration._seed(base);integration._seedChanges();}
   else if(command==='subscribe')await integration._subscribe(signal.signal);else if(command==='transport')await integration._transport();else if(command==='close')await integration.close();else if(command==='status')value=await integration._readStatus(signal.signal);else if(command==='liveAway')integration._loseLive();else if(command==='bridgeAway')integration._loseAccess();else if(command==='look')await integration._look();else if(command==='disconnect')endpoints[0].disconnect();
  }catch(error){value={error:error.message.replaceAll(KUMI,'<kumi>')};}await new Promise(setImmediate);results.push({command,value,state:integration._state()});}
  await integration.close();await Promise.resolve();lifecycle.push({label,configs,commands,transport,transports,states,calls,notes,connections,results,closes:endpoints.map(e=>e.closes)});
 }
 await life('start-close-once',[{}],['start','close','close','start']);
 await life('start-twice',[{}],['start','start']);
 await life('failed-start',[{fail:true}],['start','start']);
 await life('aborted-start',[{}],['abortStart']);
 await life('same-live-back',[{statuses:[{connected:true,epoch:7}]}],['start','liveAway','look','close']);
 await life('new-live-back',[{statuses:[{connected:true,epoch:8}]}],['start','liveAway','look']);
 await life('fresh-bridge-same-live',[{},{}],['start','bridgeAway','look']);
 await life('fresh-bridge-new-live',[{},{statuses:[{connected:true,epoch:8}]}],['start','disconnect','look']);
 await life('restarted-remote-bridge',[{statuses:[{connected:false,reason:'remote-bridge-or-live-epoch-changed'}]},{statuses:[{connected:true,epoch:8}]}],['start','liveAway','look']);
 await life('fresh-not-ready',[{},{statuses:[{connected:false}]}],['start','bridgeAway','look','look']);
 await life('fresh-status-throws',[{},{statuses:[{throw:'status unavailable'}]}],['start','bridgeAway','look']);
 await life('fresh-spawn-fails',[{},{fail:true}],['start','bridgeAway','look','look']);
 await life('live-away-idempotent',[{}],['start','liveAway','liveAway','bridgeAway','bridgeAway']);
 await life('closed-does-not-reconnect',[{}],['start','close','liveAway','bridgeAway','look']);
 const song={signatureNumerator:6,signatureDenominator:8};const set=(playing,position,tempo=120)=>({items:[{playing,position,tempo}]});
 await life('transport-dedup',[{replies:[song,set(false,1),set(false,2),set(true,2),set(true,3),set(true,3),set(true,3,121),set(false,3,121)]}],['start',...Array(7).fill('transport'),'liveAway'],true);
 await life('transport-subscription',[{replies:[{ok:true},song,set(true,0)]}],['start','subscribe','subscribe','close'],true);
 await life('transport-subscription-fallback',[{replies:[{error:true},{ok:true},song,set(false,0)]}],['start','subscribe','close'],true);
 await life('transport-subscription-retry',[{replies:[{throw:'subscribe failed'},song,set(false,0),{ok:true},set(false,0)]}],['start','subscribe','subscribe','close'],true);
 for(const signature of [{signatureNumerator:'6',signatureDenominator:'8'},{signatureNumerator:[true],signatureDenominator:4},{signatureNumerator:[6],signatureDenominator:[8]},{}])await life('transport-signature',[{replies:[signature,set(true,4)]}],['start','transport','close'],true);
 await life('transport-time-signature-refresh',[{replies:[song,...Array(8).fill(set(true,0)),{signatureNumerator:3,signatureDenominator:4},set(true,0)]}],['start',...Array(9).fill('transport'),'close'],true);
 const values=[],ids=new Map();for(const c of cases)c.responses=c.responses.map(v=>{const key=JSON.stringify(v);if(!ids.has(key)){ids.set(key,values.length);values.push(v);}return ids.get(key);});
 writeFileSync(new URL('connection-oracle.json',import.meta.url),JSON.stringify({cases,values,lifecycle})+'\n');console.log(cases.length+' source connection/read traces');
}finally{unlinkSync(file);}
