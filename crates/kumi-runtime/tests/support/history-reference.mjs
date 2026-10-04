import{readFileSync,writeFileSync,unlinkSync}from'node:fs';
const original=new URL('../../../../packages/runtime/dist/src/integrations/ableton/index.js',import.meta.url),file=new URL('index.history-oracle.js',original);let source=readFileSync(original,'utf8');
const marker='    return {\n        async start(signal) {\n            if (closed || started)';if(!source.includes(marker))throw Error('source hook changed');
source=source.replace(marker,`    async function oracleOp(op,signal){
      if(op.op==='remember'){remember(op.record,op.transactionId??'',op.restore);return;}
      if(op.op==='count'){changesThisTurn+=op.count;return;}
      if(op.op==='undo')return undoChange(op.target??'last',signal,op.discard??false);
      if(op.op==='retire'){retireChanges(op.note);return;}
      if(op.op==='release'){release(op.ids);return;}
      if(op.op==='group')return grouped(op.title,op.ids,op.apart);
      if(op.op==='fast')return runFast(op.code??'pass',signal);
      if(op.op==='stop')return stopEverything(signal);
      if(op.op==='fail')throw Error('quiet failed');
      if(op.op==='quiet'){const into=op.keep?[]:undefined;let value,error;try{value=await quietly(into,async()=>{const values=[];for(const step of op.steps)values.push((await oracleOp(step,signal))??null);return values;});}catch(e){error=e.message;}return{...(into?{into}:{}),...(error?{error}:{value})};}
    }
    return {
        async _ready(config){await tools.refresh(new AbortController().signal);if(config.available!==undefined)available=config.available;if(config.lost!==undefined)lost=config.lost;for(const e of config.entries??[])changes.set(e.record.id,e);for(const [ref,row] of config.known??[])known.set(ref,row);},
        _op:oracleOp,
        _state(){return{changes:[...changes.values()],...(quiet?{quiet}:{}),changesThisTurn,known:[...known]};},
        async start(signal){if(closed||started)`);writeFileSync(file,source);
const wrap=value=>({content:[{type:'text',text:JSON.stringify(value)}],...(value&&typeof value==='object'&&!Array.isArray(value)?{structuredContent:value}:{})});
const record=(id='r1',state='applied',extra={})=>({id,family:'mixer',title:'Change '+id,state,at:0,...extra});
const entry=(id='r1',state='applied',extra={})=>({record:record(id,state),transactionId:'tx-'+id,...extra});
const normalized=value=>JSON.parse(JSON.stringify(value).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,'<uuid>').replace(/\bc\d+\b/g,'<group>'));
const cases=[];
try{const{createAbletonIntegration}=await import(file.href);
async function run(label,config,operations){
 const calls=[],events=[],results=[];let controller;let at=0;
 const endpoint={pid:null,serverInfo:{name:'fixture',version:'1.0.73'},async list(){return{tools:['live_status','live_discover','live_undo','live_transaction_release','live_run_python','live_session_emergency_stop'].filter(n=>!(config.missing??[]).includes(n)).map(name=>({name,inputSchema:{type:'object'}}))};},async call(name,args,signal){signal.throwIfAborted();calls.push({name,args:structuredClone(args)});const response=config.responses?.[at++]??{value:{state:'undone'}};if(response.cancel)controller.abort();if(response.throw)throw Error(response.throw);return response.reply??wrap(response.value);},onCatalogChanged(){return()=>{}},onDisconnect(){return()=>{}},stderrStatus(){return{bytes:0,truncated:false}},async close(){}};
 const integration=createAbletonIntegration({connect:async()=>endpoint,onConnection(){},onChange:r=>events.push(r),now:()=>new Date('2026-10-03T12:00:00Z'),generation:'connection',changeTimeoutMs:50});await integration.start(new AbortController().signal);await integration._ready(structuredClone(config));
 for(const op of operations){controller=new AbortController();if(op.abort)controller.abort();let value;try{value=(await integration._op(op,controller.signal))??null;}catch(e){value={error:e.name==='AbortError'?'cancelled':e.message};}results.push(structuredClone({value,state:integration._state()}));}
 await integration.close();cases.push(normalized({label,config,operations,calls,events,results}));
}
for(const state of ['applied','undone','expired','kept','unsure'])for(const target of ['last','r1','missing'])await run('state-'+state+'-'+target,{entries:[entry('r1',state)]},[{op:'undo',target},{op:'undo',target}]);
for(const note of [undefined,'','Something changed'])await run('permanent',{entries:[{...entry('r1','kept',{permanent:true}),record:record('r1','kept',{...(note===undefined?{}:{note})})}]},[{op:'undo',target:'r1'}]);
for(const config of [{available:false},{lost:true},{missing:['live_undo']}])await run('unreachable',{...config,entries:[entry()]},[{op:'undo'}]);
await run('cancel-before',{entries:[entry()]},[{op:'undo',abort:true}]);await run('cancel-during',{entries:[entry()],responses:[{cancel:true,value:{state:'undone'}}]},[{op:'undo'}]);
await run('discard',{entries:[entry()]},[{op:'undo',discard:true}]);await run('retry-throw',{entries:[entry()],responses:[{throw:'private failure'},{value:{state:'undone'}}]},[{op:'undo',target:'r1'},{op:'undo',target:'r1'}]);
for(const text of ['refused','Uncertain result','Undo refused; uncertain','modified after apply','changed before deletion','x'.repeat(2200)])for(const state of ['uncertain','refused'])await run('undo-refusal',{entries:[entry()],responses:[{reply:{isError:true,content:[{type:'text',text}],structuredContent:{state}}}]},[{op:'undo'}]);
for(const value of [{},[],{state:'pending'},{state:'undone',extra:4}])await run('undo-body',{entries:[entry()],responses:[{value}]},[{op:'undo'}]);
await run('undo-malformed',{entries:[entry()],responses:[{reply:{content:[{type:'text',text:'bad JSON'}]}}]},[{op:'undo'}]);
await run('no-transaction',{entries:[entry('r1','unsure',{transactionId:''})]},[{op:'undo',target:'r1'}]);
for(const field of ['name','color'])for(const value of [undefined,'','Old'])await run('restore-field',{entries:[entry('r1','applied',{restore:{ref:'7:track:0',field,...(value===undefined?{}:{value})}})],known:[['7:track:0',{name:'Current',color:'#ff0000'}]]},[{op:'undo'}]);
const revert=[{ref:'7:parameter:0',name:'Drive',prior:0,applied:1}];
for(const value of [{back:1,moved:[],gone:[]},{back:1,moved:['Drive'],gone:[]},{back:0,moved:['Drive'],gone:['Tone','Mix']},{back:2,moved:['Drive','Mix'],gone:['Gone']},{back:0,moved:[],gone:Array.from({length:20},(_,i)=>'P'+i)},{back:'1',moved:[0,'Gain',null],gone:null}])await run('fast-revert',{entries:[entry('r1','applied',{transactionId:'',revert})],responses:[{value:{ok:true,result:value}}]},[{op:'undo'},{op:'undo',target:'r1'}]);
for(const response of [{throw:'upstream'},{reply:{isError:true,content:[{type:'text',text:'uncertain'}]}},{reply:{content:[{type:'text',text:'bad JSON'}]}},{value:{ok:false,error:{message:'gone'}}},{value:{ok:true,result:false}}])await run('fast-error',{entries:[entry('r1','applied',{transactionId:'',revert})],responses:[response]},[{op:'undo'}]);
for(const config of [{available:false},{lost:true},{missing:['live_run_python']}])await run('fast-unreachable',{...config,entries:[entry('r1','applied',{revert})]},[{op:'undo'}]);
for(const response of [{value:{ok:true,result:[1,2]}},{value:{ok:false,error:{message:4}}},{value:{ok:false,error:{message:{}}}},{value:{ok:false,error:3}},{reply:{isError:true,content:[{type:'text',text:'x'.repeat(700)}]}},{reply:{isError:true,content:[],structuredContent:{state:'uncertain'}}}])await run('run-fast',{responses:[response]},[{op:'fast'}]);
await run('retire',{entries:['applied','unsure','kept','expired','undone'].map((state,i)=>entry('r'+i,state))},[{op:'retire',note:'Live restarted'},{op:'retire',note:'Again'}]);
const remembers=[{op:'remember',record:record('r1'),transactionId:'tx1'},{op:'remember',record:record('r2','kept'),transactionId:'tx2'},{op:'count',count:3}];
for(const keep of [true,false])for(const fail of [true,false])await run('quiet',{entries:[]},[{op:'quiet',keep,steps:[...remembers,...(fail?[{op:'fail'}]:[])]}]);
await run('nested-quiet',{},[{op:'quiet',keep:true,steps:[remembers[0],{op:'quiet',keep:false,steps:[remembers[1]]},remembers[2]]}]);
await run('release-chunks',{},[{op:'release',ids:['',...Array.from({length:130},(_,i)=>'tx'+i)]}]);
for(const apart of [[],['r2'],['r1','r2']])await run('group',{entries:[entry(),entry('r2'),entry('r3','undone')]},[{op:'group',title:'Arrange'.repeat(40),ids:['r1','r2','r3','missing'],apart},{op:'undo'}]);
await run('partial-group',{entries:[entry(),entry('r2'),entry('group','applied',{members:['r1','r2']})],responses:[{reply:{isError:true,content:[{type:'text',text:'modified after apply'}]}},{value:{state:'undone'}}]},[{op:'undo',target:'group'}]);
for(const config of [{available:false},{lost:true},{missing:['live_discover']},{missing:['live_session_emergency_stop']}])await run('stop-unreachable',config,[{op:'stop'}]);
for(const transport of [{},{playing:true},{sessionRecord:true},{arrangementRecord:true},{sessionRecord:true,arrangementRecord:true}])await run('stop-transport',{responses:[{value:{items:[{transport}]}},{value:{state:'stopped'}}]},[{op:'stop'}]);
await run('stop-targets',{responses:[{value:{items:[{transport:{playing:true},firedTargets:[{trackRef:'b',clipSlotRef:'s',sceneRef:'x'},{}],playingTargets:[{trackRef:'b',clipSlotRef:'s',sceneRef:'x'},{trackRef:'a',clipSlotRef:null}]}]}},{reply:{isError:true,content:[]}},{value:{items:[{transport:{playing:false}}]}}]},[{op:'stop'}]);
await run('stop-retry-fails',{responses:[{value:{items:[{transport:{playing:true}}]}},{reply:{isError:true,content:[]}},{value:{items:[{transport:{playing:true}}]}},{reply:{isError:true,content:[]}}]},[{op:'stop'}]);
for(const response of [{throw:'fail'},{value:{items:[{transport:4}]}},{value:{items:[{playingTargets:[null]}]}}])await run('stop-error',{responses:[response]},[{op:'stop'}]);
writeFileSync(new URL('history-oracle.json',import.meta.url),JSON.stringify({cases})+'\n');console.log(cases.length+' source history sequences');
}finally{unlinkSync(file)}
