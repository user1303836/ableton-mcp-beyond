import{readFileSync,writeFileSync,unlinkSync}from'node:fs';
const original=new URL('../../../../packages/runtime/dist/src/integrations/ableton/index.js',import.meta.url),file=new URL('index.parameters-oracle.js',original);let source=readFileSync(original,'utf8');
const marker='    return {\n        async start(signal) {\n            if (closed || started)';if(!source.includes(marker))throw Error('source hook changed');
source=source.replace(marker,`    return {
        async _ready(config){await tools.refresh(new AbortController().signal);for(const ref of config.shorts??[])shortRef(ref);for(const [ref,row] of config.known??[])known.set(ref,row);},
        _op(op,signal){if(op.invalidate)invalidate();if(op.op==='map')return valueForText(op.ref,op.text,signal);if(op.op==='parameters')return deviceParameters(op.ref,op.fields,signal);if(op.op==='enabled')return fastOn();return fastParameters(CHANGES.find(k=>k.tool===(op.tool??'set_device_parameter')),op.input,signal);},
        _state(){return{maps:[...displayMaps],found:[...fastFound],fastGeneration,changes:[...changes.values()],changesThisTurn};},
        async start(signal){if(closed||started)`);writeFileSync(file,source);
const wrap=value=>({content:[{type:'text',text:JSON.stringify(value)}],...(value&&typeof value==='object'&&!Array.isArray(value)?{structuredContent:value}:{})});
const normalize=value=>JSON.parse(JSON.stringify(value).replace(/\bc\d+\b/g,'<change>'));
const row=(name='Drive',index=0)=>({index,name,min:0,max:1,items:[],grid:[[0,'0 dB'],[.5,'3 dB'],[1,'6 dB']]});
const cases=[];
try{const{createAbletonIntegration}=await import(file.href);
 async function run(label,config,operations){
  const calls=[],responses=[],events=[],results=[];let controller;
  const endpoint={pid:null,serverInfo:{name:'fixture',version:config.version??'1.0.73'},async list(){return{tools:['live_discover','live_run_python'].filter(n=>!(config.missing??[]).includes(n)).map(name=>({name,inputSchema:{type:'object'}}))};},async call(name,args,signal){
   signal.throwIfAborted();calls.push({name,args:structuredClone(args)});const code=args.code??'';const stage=name==='live_discover'?'discover':code.startsWith('# kumi:fast-find')?'find':code.startsWith('# kumi:fast-set')?'set':'map';let entry;
   if(config.failure?.stage===stage)entry=config.failure.response;
   if(!entry){let value;
    if(stage==='discover'){const index=Number(args.cursor??0);value=config.pages?.[index]??{items:[{ref:'7:parameter:0',name:'Drive'}]};}
    else if(stage==='map')value=config.map??{ok:true,result:row()};
    else{const line=code.split('\n').find(s=>s.startsWith('ARGS = json.loads('));const asked=JSON.parse(JSON.parse(line.slice('ARGS = json.loads('.length,-1)));
     if(stage==='find')value={ok:true,result:asked.map((a,i)=>config.found?.[a.parameter??a.ref]??row(a.parameter??'Drive',i))};
     else value={ok:true,result:config.setResult??{device:'Effect',track:{ref:'7:track:0'},items:asked.map(a=>({name:a.name??'Drive',prior:.5,value:a.value,min:0,max:1,priorDisplay:'3 dB',display:a.value*6+' dB'}))}};
    }
    entry={reply:wrap(value)};
   }
   responses.push(structuredClone(entry));if(entry.cancel)controller.abort();if(entry.throw)throw Error(entry.throw);return entry.reply;
  },onCatalogChanged(){return()=>{}},onDisconnect(){return()=>{}},stderrStatus(){return{bytes:0,truncated:false}},async close(){}};
  const integration=createAbletonIntegration({connect:async()=>endpoint,onConnection(){},onChange:r=>events.push(r),now:()=>new Date('2026-10-03T12:00:00Z'),generation:'connection',...(config.fast===undefined?{}:{fast:config.fast})});await integration.start(new AbortController().signal);await integration._ready(config);
  for(const op of operations){controller=new AbortController();if(op.abort)controller.abort();let value;try{value=await integration._op(op,controller.signal);}catch(e){value={error:e.name==='AbortError'?'cancelled':e.message};}results.push(structuredClone({value,state:integration._state()}));}
  await integration.close();cases.push(normalize({label,config,operations,calls,responses,events,results}));
 }
 const base={deviceRef:'7:device:0:0',parameter:'Drive',value:.8};
 for(const input of [{},{...base,deviceRef:''},{...base,deviceRef:4},{...base,values:[]},{...base,values:[null]},{...base,parameter:''},{...base,parameter:null},{deviceRef:base.deviceRef,value:.3},{...base,value:null},{...base,value:false},{...base,value:{}},...[-1,0,.25,1,4,'0.2',' 0.5 ','0xff','','3 dB','99 dB','nonsense'].map(value=>({...base,value}))])await run('input',{},[{input}]);
 await run('named-cache',{},[{input:base},{input:{...base,parameter:' drive ',value:.1}},{input:{...base,value:.3},invalidate:true}]);
 await run('reference',{},[{input:{deviceRef:base.deviceRef,parameterRef:'7:parameter:0',value:.1}},{input:{deviceRef:base.deviceRef,parameterRef:'7:parameter:0',value:'3 dB'}}]);
 await run('text-cache',{},[{input:{...base,value:'3 dB'}},{input:{...base,value:'6 dB'}},{input:{...base,value:'0 dB'},invalidate:true}]);
 const several={deviceRef:base.deviceRef,values:[{parameter:'Drive',value:.1},{parameter:'Tone',value:'3 dB'},{parameter:'Missing',value:.2}]};
 await run('partial-missing',{found:{Missing:{missing:['Drive','Tone']}}},[{input:several,tool:'set_device_parameters'}]);
 await run('all-missing',{found:{Drive:{missing:['Other']}}},[{input:base}]);
 for(const found of [{error:'discover again'},{error:'device gone'},{error:{}},{},false,{name:4,min:0,max:1},{name:'Drive',min:'0',max:1}])await run('found-shape',{found:{Drive:found}},[{input:base}]);
 for(const stage of ['find','set'])for(const response of [{throw:'upstream'},{reply:{isError:true,content:[{type:'text',text:'uncertain mutation'}]}},{reply:{isError:true,content:[{type:'text',text:'refused'}]}},{reply:{content:[{type:'text',text:'bad JSON'}]}},{reply:wrap({ok:false,error:{message:'gone'}})}])await run('failed-'+stage,{failure:{stage,response}},[{input:base}]);
 await run('abort-before',{},[{input:base,abort:true}]);await run('cancel-after-apply',{failure:{stage:'set',response:{cancel:true,reply:wrap({ok:true,result:{device:'Effect',track:{ref:'7:track:0'},items:[{name:'Drive',prior:.5,value:.8,min:0,max:1,priorDisplay:'3 dB',display:'4.8 dB'}]}})}}},[{input:base}]);
 await run('known-track',{known:[['7:track:0',{name:'Bass',color:'#ffffff'}]]},[{input:base}]);
 for(const config of [{},{version:'1.0.1'},{missing:['live_run_python']},{fast:false},{fast:true}])await run('enabled',config,[{op:'enabled'}]);
 for(const map of [{ok:true,result:row()},{ok:false},{ok:true,result:{}},{ok:true,result:false},{ok:true,result:{...row(),items:[3,'Low',null,'High'],grid:[[0,'Low'],[1,'High'],[],[4,4],null]}}])await run('display-map',{map},[{op:'map',ref:'7:parameter:0',text:'3 dB'},{op:'map',ref:'7:parameter:0',text:'6 dB'}]);
 for(const config of [{version:'1.0.1'},{missing:['live_run_python']}])await run('map-unavailable',config,[{op:'map',ref:'7:parameter:0',text:'3 dB'}]);
 await run('short-ref-map',{shorts:['7:parameter:0']},[{op:'map',ref:'parameter:1',text:'3 dB'}]);
 for(const pages of [[{items:[{name:'one'}],nextCursor:'1'},{items:[{name:'two'}]}],[{items:null}],[{items:[null]}],[{items:[{}],nextCursor:'1'},{items:[{}],nextCursor:'1'}]])await run('paged-parameters',{pages},[{op:'parameters',ref:'7:device:0:0',fields:['ref','name','value']}]);
 const values=[],ids=new Map();for(const c of cases)c.responses=c.responses.map(v=>{const key=JSON.stringify(v);if(!ids.has(key)){ids.set(key,values.length);values.push(v);}return ids.get(key);});writeFileSync(new URL('parameters-oracle.json',import.meta.url),JSON.stringify({cases,values})+'\n');console.log(cases.length+' source parameter sequences');
}finally{unlinkSync(file)}
