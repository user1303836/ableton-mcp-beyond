import {readFileSync,writeFileSync,unlinkSync,mkdtempSync,rmSync} from 'node:fs';
import {homedir,tmpdir} from 'node:os';
const original=new URL('../../../../packages/runtime/dist/src/integrations/ableton/index.js',import.meta.url),file=new URL('index.mutations-oracle.js',original);
let source=readFileSync(original,'utf8');
const marker='    return {\n        async start(signal) {\n            if (closed || started)';
if(!source.includes(marker))throw Error('source hook changed');
source=source.replace(marker,`    let oracleArrange; return {
      async _ready(c){await tools.refresh(new AbortController().signal);available=c.available??true;lost=c.lost??false;currentEpoch=c.noEpoch?undefined:7;currentTempo=120;currentSet=c.set;changesThisTurn=c.count??0;project=c.project;for(const [r,k] of c.refs??[])refs.set(r,k);for(const r of c.shorts??[])shortRef(r);for(const [r,t] of c.known??[])known.set(r,t);for(const [k,v] of c.cursors??[])cursors.set(k,v);for(const sample of c.samples??[])samples.set(sample.path,sample);oracleArrange=arrangeHost();},
      _bump(){observationGeneration++;},
      async _op(op,signal){if(op.set!==undefined)currentSet=op.set;if(op.service==='public'){const tool=definitions().find(t=>t.name===op.tool);if(!tool)throw Error('Tool not offered');return tool.execute(op.input,signal);}if(op.service==='watch')return watch(op.input,signal);if(op.service==='plan')return makeChanges(op.input,signal);if(op.service==='stream'){
        let onStarts=0;const stream=streamChanges(signal,()=>onStarts++);const progress=[];
        for(const chunk of op.chunks??[]){stream.push(chunk);await new Promise(resolve=>setImmediate(resolve));progress.push({started:stream.started});}
        if(op.cancel)options._cancel();
        if(op.abandon){await stream.abandon();return{abandoned:true,started:stream.started,onStarts,progress};}
        const result=await stream.finish(op.finish);return{result,started:stream.started,onStarts,progress};
      }if(op.service==='clip')return clipFile(op.named,signal);if(op.service==='step')return step(op.tool,op.input,signal);if(op.service==='copy')return keepCopy(signal);if(op.service==='offers')return oracleArrange.offers(op.tool);if(op.service==='arrange')return oracleArrange.change(op.tool,op.input,signal);if(op.service==='undoStep'){const opened=await oracleArrange.undoStep();await opened.close();return opened.opened;}if(op.service==='tell')return oracleArrange.tell(op.title);const run=()=>op.action?act(ACTIONS.find(k=>k.tool===op.tool),op.input,signal,op.cleanup??false):change(CHANGES.find(k=>k.tool===op.tool),op.input,signal,op.settled??false);return op.quiet?quietly([],run):run();},
      _state(){return{changes:[...changes.values()],changesThisTurn,refs:[...refs],known:[...known],names:[...shortRefs],cursors:[...cursors],tempo:currentTempo,lease:observationGeneration,found:[...fastFound]};},
      async start(signal){if(closed||started)`);
writeFileSync(file,source);
const wrap=value=>({content:[{type:'text',text:JSON.stringify(value)}],...(value&&typeof value==='object'&&!Array.isArray(value)?{structuredContent:value}:{})});
const fixture=mkdtempSync(tmpdir()+'/kumi-execution-oracle-');writeFileSync(fixture+'/Set.als','last saved Set');
const norm=value=>JSON.parse(JSON.stringify(value).replace(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/g,'<uuid>').replace(/\bc\d+\b/g,'<change>').split(homedir()).join('<home>').split(fixture).join('<fixture>'));
const refs=[['7:track:0','track'],['7:track:1','track'],['7:track:2','track'],['7:scene:0','scene'],['7:scene:1','scene'],['7:clip_slot:1:0','clip-slot'],['7:device:0:0','device'],['7:parameter:7:device:0:0:1','parameter'],['7:device:1:0','device'],['7:mixer:0:volume','parameter']];
const base={refs,shorts:refs.map(r=>r[0]),known:[['7:track:0',{name:'Bass',color:'#ff0000'}],['7:track:1',{name:'Lead'}]],cursors:[['next','device']]};
const change=(tool,input={},extra={})=>({tool,input,...extra}),action=(tool,input={},extra={})=>({tool,input,action:true,...extra});
const cases=[];
try{
 const {createAbletonIntegration,BRIDGE_TOOLS}=await import(file.href);
 const {CHANGES}=await import(new URL('changes.js',original));
 const {ACTIONS}=await import(new URL('actions.js',original));
 const toolNames=[...new Set(['live_status','live_discover','live_run_python','live_session_emergency_stop','live_project_backup_preview','live_project_backup_apply','live_undo_step_begin','live_undo_step_end','live_project_snapshot_export','live_project_snapshot_diff',...CHANGES.flatMap(k=>[k.preview,k.apply]),...ACTIONS.flatMap(k=>[k.preview,k.apply]),...BRIDGE_TOOLS])];
 async function run(label,provided,operations){
  const config={...base,...provided},calls=[],responses=[],events=[],actions=[],results=[],disks=[];let controller,integration;let listCalls=0,deviceReads=0,exportReads=0;const watchEvents=[];
  const endpoint={pid:null,serverInfo:{name:'fixture',version:config.version??'1.0.73'},async list(){listCalls++;return{tools:toolNames.filter(n=>!(config.missing??[]).includes(n)&&!(listCalls===1&&(config.initiallyMissing??[]).includes(n))).map(name=>({name,inputSchema:config.schemas?.[name]??{type:'object'}}))};},async call(name,args,signal){
   signal.throwIfAborted();const at=calls.length;calls.push({name,args:structuredClone(args)});let stage=name==='live_project_snapshot_export'?'export':name==='live_project_snapshot_diff'?'diff':name==='live_status'?'status':name==='live_discover'?'discover':name.endsWith('_preview')?'preview':name.endsWith('_apply')?'apply':'other';
   let response=config.responses?.[at]??config.fail?.[stage];
   if(!response){let value;
    if(stage==='export')value=config.exports?.[Math.min(exportReads++,config.exports.length-1)]??{page:{},artifactId:'artifact',records:[]};
    else if(stage==='diff')value=config.diff??{items:[]};
    else if(stage==='status')value=config.status??{connected:true,epoch:7};
    else if(stage==='discover')value=(args.kind==='device'&&config.deviceLists?{epoch:7,items:config.deviceLists[Math.min(deviceReads++,config.deviceLists.length-1)]}:config.discoverBy?.[args.kind])??config.discover??{epoch:7,items:args.kind==='session-state'?[{transport:{playing:false}}]:args.kind==='parameter'?[{ref:'7:parameter:7:device:0:0:1',name:'Drive',min:0,max:1,value:.5,displayValue:'3 dB'}]:args.kind==='device'?[{ref:'7:device:0:0',name:'Effect',className:'AudioEffect'}]:[]};
    else if(stage==='preview')value=config.preview??{epoch:7,transactionId:'tx',confirmation:'yes',priorTempo:120,proposedTempo:130,prior:{tracks:[{},{}],scenes:[{}]},proposed:[]};
    else if(stage==='apply')value=config.applied??{state:'applied'};
    else if(name==='live_run_python'&&args.code?.startsWith('# kumi:fast-')){
      const line=args.code.split('\n').find(s=>s.startsWith('ARGS = json.loads('));const asked=JSON.parse(JSON.parse(line.slice('ARGS = json.loads('.length,-1)));
      const found=args.code.startsWith('# kumi:fast-find');value={ok:true,result:found?asked.map((a,i)=>config.parameterMissing?.includes(a.parameter)?{missing:['Drive','Tone']}:{index:i,name:a.parameter??'Drive',min:0,max:1}):{device:'Effect',track:{ref:'7:track:0'},items:asked.map(a=>({name:a.name??'Drive',prior:.5,value:a.value,min:0,max:1,priorDisplay:'3 dB',display:a.value*6+' dB'}))}};
    }else value=config.other??{state:'stopped'};
    response={reply:wrap(value)};
   }
   responses.push(structuredClone(response));if(response.cancel)controller.abort();if(response.bump)integration._bump();if(response.throw)throw Error(response.throw);return response.reply;
  },onCatalogChanged(){return()=>{}},onDisconnect(){return()=>{}},stderrStatus(){return{bytes:0,truncated:false}},async close(){}};
  integration=createAbletonIntegration({connect:async()=>endpoint,onConnection(){},onChange:r=>events.push(r),onAction:r=>actions.push(r),onWatch:r=>watchEvents.push(r),lowDisk:async(...args)=>{disks.push(args);return config.disk;},now:()=>new Date('2026-10-03T12:00:00Z'),generation:'connection',fast:config.fast??false,changeTimeoutMs:50,_cancel:()=>controller.abort()});
  await integration.start(new AbortController().signal);await integration._ready(structuredClone(config));
  for(const op of operations){controller=new AbortController();if(op.abort)controller.abort();let value;try{value=await integration._op(op,controller.signal);}catch(e){value={error:e.name==='AbortError'?'cancelled':e.message};}results.push(structuredClone({value,state:integration._state()}));}
  await integration.close();cases.push(norm({label,config,operations,calls,responses,events,actions,watchEvents,disks,results,listCalls}));
 }
 for(const kind of CHANGES)await run('kind-'+kind.tool,{},[change(kind.tool)]);
 for(const config of [{available:false},{lost:true},{noEpoch:true},{count:5000},{missing:['live_tempo_preview']},{initiallyMissing:['live_tempo_apply']},{status:{connected:false}},{status:{connected:true,epoch:8}},{status:{}},{fail:{status:{throw:'private bridge failure'}}}])await run('guard',config,[change('set_tempo',{tempo:130})]);
 await run('old-bridge',{version:'1.0.1'},[change('delete_device',{ref:'device:1'})]);
 await run('stale-ref',{},[change('rename',{kind:'track',ref:'7:track:99',name:'New'})]);
 for(const op of [{abort:true},{settled:true},{quiet:true}])await run('mode',{},[change('set_tempo',{tempo:130},op)]);
 for(const preview of [{},{epoch:8,transactionId:'tx',confirmation:'yes'},{transactionId:2,confirmation:'yes'},{transactionId:'',confirmation:'yes'},{transactionId:'t'.repeat(257),confirmation:'yes'},{transactionId:'😀'.repeat(128),confirmation:'😀'.repeat(256)},{transactionId:'tx',confirmation:'c'.repeat(513)},[]])await run('preview-shape',{preview},[change('set_tempo',{tempo:130})]);
 for(const stage of ['preview','apply'])for(const response of [{throw:'private bridge failure'},{reply:{isError:true,content:[{type:'text',text:'refused'}]}},{reply:{isError:true,content:[{type:'text',text:'uncertain mutation'}]}},{reply:{isError:true,content:[],structuredContent:{state:'uncertain'}}},{reply:{content:[{type:'text',text:'malformed'}]}},{cancel:true,reply:wrap(stage==='preview'?{transactionId:'tx',confirmation:'yes'}:{state:'applied'})},{bump:true,reply:wrap(stage==='preview'?{transactionId:'tx',confirmation:'yes'}:{state:'applied'})}])await run('failure-'+stage,{fail:{[stage]:response}},[change('set_tempo',{tempo:130})]);
 for(const applied of [{},{state:'pending'},[],{state:'applied',blob:'😀'.repeat(5000)},{state:'applied',created:[{kind:'track',ref:'7:track:1',name:'New'}]}])await run('apply-shape',{applied},[change('set_tempo',{tempo:130})]);
 await run('rename-history',{preview:{transactionId:'tx',confirmation:'yes',target:{kind:'track',ref:'7:track:0',currentName:'Bass'},proposedName:'Sub'}},[change('rename',{kind:'track',ref:'track:1',name:'Sub'}),change('set_mixer',{trackRef:'track:1',volume:.7})]);
 await run('color-history',{preview:{transactionId:'tx',confirmation:'yes',ref:'7:track:0',prior:{color:'#ff0000'},proposed:{color:'#00ff00'}}},[change('set_track_color',{ref:'track:1',colorIndex:3})]);
 for(const created of [[{kind:'track',ref:'7:track:1',name:'New'}],[{kind:'scene',ref:'7:scene:1',name:'Chorus'}],[{kind:'track',ref:'7:track:1',name:'New'},{kind:'scene',ref:'7:scene:0'}],[{kind:'other',ref:'unrecognized'}],[],[null]])await run('structure',{applied:{state:'applied',created}},[change('add_tracks_and_scenes',{tracks:[{name:'New'}],scenes:[{name:'Chorus',index:0}]}),change('set_mixer',{trackRef:'track:1',volume:.7})]);
 await run('append-shape',{},[change('add_tracks_and_scenes',{tracks:[null,{}, {index:null}],scenes:[{}]})]);
 await run('append-refusal',{responses:[{reply:wrap({connected:true,epoch:7})},{reply:{isError:true,content:[]}}]},[change('add_tracks_and_scenes',{tracks:[{}]})]);
 for(const tool of ['move_device','move_device_to','delete_device'])for(const config of [{},{missing:['live_discover']}])await run('device-shift',config,[change(tool,tool==='move_device'?{deviceRef:'device:1',index:1}:tool==='move_device_to'?{deviceRef:'device:1',targetTrackRef:'track:2'}:{ref:'device:1'})]);
 await run('produced-ref',{applied:{state:'applied',clipRef:'7:clip:0:0'}},[change('write_midi_clip',{trackRef:'track:1',sceneIndex:0,length:4,notes:[{pitch:60,start:0,duration:1}]})]);
 for(const fail of [undefined,{preview:{reply:{isError:true,content:[{type:'text',text:'parameter range error'}]}}},{discover:{reply:{content:[{type:'text',text:'bad JSON'}]}}}])await run('prepared-parameters',{...(fail?{fail}:{})},[change('set_device_parameter',{deviceRef:'device:1',parameter:'Drive',value:.8})]);
 for(const kind of ACTIONS)await run('action-'+kind.tool,{},[action(kind.tool)]);
 for(const config of [{available:false},{lost:true},{noEpoch:true},{version:'1.0.1'},{missing:['live_recording_preview']},{disk:'Disk nearly full'}])await run('action-guard',config,[action('record',{action:'start',destinationTrackRef:'track:1'})]);
 for(const op of [{},{abort:true},{cleanup:true},{quiet:true}])await run('action-mode',{},[action('play',{action:'start'},op)]);
 await run('action-newer',{version:'1.0.34'},[action('play',{action:'back-to-arrangement'}),action('play',{action:'back-to-arrangement'},{cleanup:true})]);
 await run('action-stale-ref',{},[action('select',{trackRef:'7:track:99'}),action('select',{trackRef:'7:track:99'},{cleanup:true})]);
 await run('samples-cached',{samples:[{name:'Kick',path:'/fixture/kick.wav',folder:'/fixture',bytes:1000}]},[change('load_sample',{trackRef:'track:1',sample:'/fixture/kick.wav'}),change('load_sample_to_pad',{deviceRef:'device:1',note:36,sample:'/fixture/kick.wav',instrument:'Drum Sampler'}),change('load_samples_to_pads',{deviceRef:'device:1',pads:[{note:36,sample:'/fixture/kick.wav'},{note:37,sample:'/fixture/kick.wav'}]})]);
 for(const preview of [{},{transactionId:'',confirmation:'yes'},{transactionId:'tx',confirmation:3},{transactionId:'t'.repeat(600),confirmation:'c'.repeat(600)}])await run('action-preview-shape',{preview},[action('play',{action:'start'})]);
 for(const stage of ['preview','apply'])for(const response of [{throw:'private failure'},{reply:{isError:true,content:[{type:'text',text:'refused'}]}},{reply:{isError:true,content:[{type:'text',text:'uncertain'}]}},{reply:{content:[{type:'text',text:'bad JSON'}]}},{cancel:true,reply:wrap(stage==='preview'?{transactionId:'tx',confirmation:'yes'}:{state:'applied'})},{bump:true,reply:wrap(stage==='preview'?{transactionId:'tx',confirmation:'yes'}:{state:'applied'})}])await run('action-failure-'+stage,{fail:{[stage]:response}},[action('play',{action:'start'})]);
 for(const tool of ['play','record'])for(const missing of [[],['live_session_emergency_stop']])await run('stop-fallback',{missing,fail:{preview:{reply:{isError:true,content:[{type:'text',text:'ordinary stop refused'}]}}}},[action(tool,{action:'stop'})]);
 for(const alsoTrackRefs of [[],['track:2']])await run('disarm-before-record',{discover:{epoch:7,items:[{ref:'7:track:0',name:'Bass',armed:true},{ref:'7:track:1',name:'Lead',armed:true},{ref:'7:track:2',name:'Pad',armed:true}]}},[action('record',{action:'start',lane:'arrangement',destinationTrackRef:'track:1',alsoTrackRefs})]);
 await run('disarm-refused',{discover:{epoch:7,items:[{ref:'7:track:1',name:'Lead',armed:true}]},fail:{preview:{reply:{isError:true,content:[{type:'text',text:'refused'}]}}}},[action('record',{action:'start',destinationTrackRef:'track:1'})]);
 await run('record-saved-project',{project:{identity:'id',path:'/fixture/My Set.als',name:'My Set'}},[action('record',{action:'start'})]);

 const service=(service,extra={})=>({service,...extra});
 for(const named of ['file.wav','/audio/mix.wav','clip:88','clip:missing','arrangement_clip:10','clip:é',' 7:clip:0:1 ','7:arrangement_clip:0:2','7:clip:0:9'])await run('clip-file',{discover:{items:[{ref:'7:clip:0:1',isAudio:true,filePath:'/audio/Session.wav'},{ref:'7:arrangement_clip:0:2',filePath:'/audio/Arrangement.wav'}]}},[service('clip',{named})]);
 for(const clip of [{ref:'7:clip:0:1',isAudio:false},{ref:'7:clip:0:1'},{ref:'7:clip:0:1',filePath:''},{ref:'7:clip:0:1',filePath:4},null])await run('clip-body',{discover:{items:[clip]},shorts:[...base.shorts,'7:clip:0:1']},[service('clip',{named:'clip:1'})]);
 for(const config of [{available:false},{lost:true},{fail:{discover:{throw:'bridge failure'}}},{fail:{discover:{reply:{isError:true,content:[]}}}},{fail:{discover:{reply:{content:[{type:'text',text:'bad JSON'}]}}}}])await run('clip-unreachable',config,[service('clip',{named:'7:clip:0:1'})]);
 await run('clip-paged',{responses:[{reply:wrap({kind:'session-clip',epoch:7,items:[],nextCursor:'second'})},{reply:wrap({kind:'session-clip',epoch:7,items:[{ref:'7:clip:0:1',filePath:'/audio/paged.wav'}]})}]},[service('clip',{named:'7:clip:0:1'})]);
 for(const config of [{},{available:false},{fail:{apply:{reply:{isError:true,content:[{type:'text',text:'uncertain'}]}}}}])await run('internal-step',config,[service('step',{tool:'set_tempo',input:{tempo:130}}),service('step',{tool:'play',input:{action:'start'}})]);
 await run('arrangement-changes',{},[service('arrange',{tool:'set_tempo',input:{tempo:130}}),service('arrange',{tool:'rename',input:{kind:'track',ref:'track:1',name:'Sub'}})]);
 await run('arrangement-refusal',{fail:{preview:{reply:{isError:true,content:[{type:'text',text:'refused'}]}}}},[service('arrange',{tool:'set_tempo',input:{tempo:130}})]);
 for(const config of [{},{version:'1.0.1'},{missing:['live_tempo_apply']}])await run('arrange-offers',config,['missing','set_tempo','delete_device'].map(tool=>service('offers',{tool})));
 for(const config of [{},{other:{stepId:'step-1'}},{other:{stepId:''}},{missing:['live_undo_step_begin']},{fail:{other:{throw:'unavailable'}}}])await run('arrange-undo-step',config,[service('undoStep'),service('tell',{title:'Arrangement complete'})]);
 for(const config of [{},{project:{identity:'p',name:'Set',path:fixture+'/Set.als'}},{project:{identity:'p',name:'Set',path:fixture+'/missing.als'}},{project:{identity:'p',name:'Set',path:fixture+'/Set.als'},missing:['live_project_backup_apply']}])await run('saved-copy',{applied:{backup:fixture+'/Set.backup.als'},...config},[service('copy'),service('copy')]);
 for(const response of [{throw:'bridge failure'},{reply:{isError:true,content:[]}},{reply:wrap({})},{cancel:true,reply:wrap({transactionId:'tx'})}])await run('copy-failure',{project:{identity:'p',name:'Set',path:fixture+'/Set.als'},fail:{preview:response}},[service('copy')]);

 const plan=(steps,extra={})=>service('plan',{input:{steps,...extra}});
 for(const steps of [undefined,null,[],[null],[{}],[{tool:'missing',input:{}}],[{tool:'load_samples_to_pads',input:{}}],[{tool:'wait',input:{}}],[{tool:'wait',input:{seconds:0}}],[{tool:'wait',input:{seconds:.001}}],[{tool:'set_tempo',input:{tempo:130}},{tool:'wait',input:{beats:.001}}]])await run('plan-input',{},[{service:'plan',input:{...(steps===undefined?{}:{steps})}}]);
 for(const final of [false,true])await run('plan-simple',{},[plan([{tool:'set_tempo',input:{tempo:130}},{tool:'rename',input:{kind:'track',ref:'track:1',name:'Sub'}}],{final})]);
 for(const each of [null,{},[],{tempo:[]},{tempo:[120,121]},{tempo:4},{tempo:[120],name:['one','two']},{tempo:[120,121],name:['one','two']}])await run('plan-each',{},[plan([{tool:'set_tempo',input:{tempo:100},each,as:'ignored'}],{final:true})]);
 await run('plan-count-limit',{},[plan([{tool:'set_tempo',each:{tempo:Array.from({length:5001},()=>120)}}])]);
 await run('plan-global-limit',{count:4999},[plan([{tool:'set_tempo',input:{tempo:130}},{tool:'set_tempo',input:{tempo:140}}])]);
 await run('plan-reference',{applied:{state:'applied',deviceRef:'7:device:0:3'}},[plan([{tool:'load_device',input:{trackRef:'track:1',itemId:'Audio Effect'},as:'effect'},{tool:'switch_device',input:{deviceRef:'@effect',enabled:true}}],{final:true})]);
 for(const name of ['@missing','@bad-hyphen','@x'.repeat(40)])await run('plan-missing-name',{},[plan([{tool:'switch_device',input:{deviceRef:name,enabled:true}},{tool:'set_tempo',input:{tempo:125}}])]);
 for(const config of [{},{missing:['live_session_emergency_stop']},{fail:{apply:{reply:{isError:true,content:[{type:'text',text:'uncertain'}]}}}}])await run('plan-stops-playback',config,[plan([{tool:'play',input:{action:'start'}},{tool:'unknown',input:{}},{tool:'set_tempo',input:{tempo:130}}])]);
 await run('plan-stops-recording',{},[plan([{tool:'record',input:{action:'start'}},{tool:'unknown'}])]);
 await run('plan-success-playing',{},[plan([{tool:'play',input:{action:'start'}}],{final:true})]);
 await run('plan-cancelled-apply',{fail:{apply:{cancel:true,reply:wrap({state:'applied'})}}},[plan([{tool:'set_tempo',input:{tempo:130}},{tool:'set_tempo',input:{tempo:140}}])]);
 await run('plan-saved-copy',{project:{identity:'p',name:'Set',path:fixture+'/Set.als'},applied:{state:'applied',backup:fixture+'/backup.als'},other:{stepId:'undo-one'}},[plan(Array.from({length:3},(_,i)=>({tool:'set_tempo',input:{tempo:130+i}})),{final:true})]);
 const parameters=[{tool:'set_device_parameter',input:{deviceRef:'device:1',parameter:'Drive',value:.8}},{tool:'set_device_parameter',input:{deviceRef:'device:1',parameter:'Tone',value:.2}}];
 const parameterSchema={live_device_parameter_preview:{type:'object',properties:{values:{type:'array'}}}};
 const discovery={epoch:7,items:[{ref:'7:parameter:7:device:0:0:1',name:'Drive',min:0,max:1},{ref:'7:parameter:7:device:0:0:2',name:'Tone',min:0,max:1}]};
 for(const schemas of [{},parameterSchema])await run('plan-parameter-batch',{schemas,discover:discovery},[plan(parameters,{final:true})]);
 for(const parameterMissing of [[],['Drive'],['Drive','Tone']])await run('plan-partial-parameters',{schemas:parameterSchema,fast:true,parameterMissing},[plan(parameters,{final:true})]);
 const pads=Array.from({length:3},(_,i)=>({tool:'load_sample_to_pad',input:{deviceRef:'device:1',note:36+i,sample:'/fixture/kick.wav'}}));
 for(const schemas of [{},{live_drum_pad_preview:{type:'object',properties:{action:{enum:['load-samples']}}}}])await run('plan-pad-batch',{schemas,samples:[{name:'Kick',path:'/fixture/kick.wav',folder:'/fixture',bytes:1000}]},[plan(pads,{final:true})]);
 const tempo={tool:'set_tempo',input:{tempo:130}},rename={tool:'rename',input:{kind:'track',ref:'track:1',name:'Sub'}};
 for(const input of [undefined,{steps:[tempo],final:true},{steps:[tempo,rename],final:true}])await run('stream-whole',{},[service('stream',{chunks:[],finish:input})]);
 for(const finish of [undefined,{steps:[tempo],final:true},{steps:[rename],final:true},{steps:[tempo,rename],final:true}])await run('stream-partial',{},[service('stream',{chunks:['{"steps":[',JSON.stringify(tempo)],finish})]);
 await run('stream-broken-tail',{},[service('stream',{chunks:['{"steps":['+JSON.stringify(tempo)+',oops'],finish:undefined})]);
 await run('stream-each-refusal',{},[service('stream',{chunks:['{"steps":['+JSON.stringify({tool:'set_tempo',each:{tempo:3}})],finish:{steps:[{tool:'set_tempo',each:{tempo:3}}]}})]);
 await run('stream-parameters',{schemas:parameterSchema,discover:discovery},[service('stream',{chunks:['{"steps":['+JSON.stringify(parameters[0]),','+JSON.stringify(parameters[1]),']}'],finish:{steps:parameters,final:true}})]);
 await run('stream-abandoned-before',{},[service('stream',{chunks:['{"steps":['],abandon:true})]);
 await run('stream-abandoned-play',{},[service('stream',{chunks:['{"steps":['+JSON.stringify({tool:'play',input:{action:'start'}})],abandon:true})]);
 await run('stream-cancelled-play',{},[service('stream',{chunks:['{"steps":['+JSON.stringify({tool:'play',input:{action:'start'}})],cancel:true,finish:{steps:[{tool:'play',input:{action:'start'}}]}})]);

 const watch=(action,extra={})=>service('watch',{input:{action},...extra});
 for(const config of [{},{available:false},{lost:true},{missing:['live_project_snapshot_diff']}])await run('watch-availability',config,[watch('stop'),watch('start'),watch('stop'),watch('stop')]);
 await run('watch-changed-set',{set:'first'},[watch('start'),watch('stop',{set:'second'}),watch('stop')]);
 await run('watch-restart',{},[watch('start'),watch('start'),watch('stop')]);
 for(const stage of ['export','discover','diff'])for(const response of [{throw:'private bridge failure'},{reply:{content:[{type:'text',text:'bad JSON'}]}},{reply:wrap({items:[null]})},{cancel:true,reply:wrap({page:{},items:[]})}])await run('watch-read-failure',{fail:{[stage]:response}},[watch('start'),watch('stop')]);
 const newDevice={ref:'7:device:0:1',parentRef:'7:track:0',objectIdentity:'new',name:'Saturator',className:'Saturator'};
 const knobs=[{name:'Default',value:.5,defaultValue:.5},{name:'Drive',value:.8,defaultValue:.5,displayValue:'6 dB'},{name:null,value:1,defaultValue:0},{name:'Missing default',value:1},{name:'String default',value:1,defaultValue:'0'},{name:'Near',value:1e-8,defaultValue:0}];
 for(const device of [newDevice,{...newDevice,parentRef:'rack'},{...newDevice,name:null},{...newDevice,objectIdentity:4}])await run('watch-added-device',{deviceLists:[[],[device]],discoverBy:{track:{items:[{ref:'7:track:0',name:'Bass',mediaKind:'midi'}]},parameter:{items:knobs}}},[watch('start'),watch('stop')]);
 await run('watch-device-bound',{deviceLists:[[],Array.from({length:14},(_,i)=>({...newDevice,objectIdentity:i,ref:'7:device:0:'+i}))],discoverBy:{parameter:{items:Array.from({length:30},(_,i)=>({name:'P'+i,value:1,defaultValue:0}))}}},[watch('start'),watch('stop')]);
 await run('watch-malformed-track',{discoverBy:{track:{items:[null]}}},[watch('start'),watch('stop')]);
 const addedTrack={snapshotId:'new-track',kind:'track',name:'Recorded',order:1,data:{kind:'track',armed:true,monitoring:'off',mixer:{volume:.8},routing:{input:'Resampling'}}};
 await run('watch-added-track',{exports:[{page:{},records:[]},{page:{},records:[addedTrack]}],diff:{items:[{type:'change',kind:'track',afterSnapshotId:'new-track',facets:['added']}]},discoverBy:{track:{items:[{ref:'7:track:1',name:'Recorded',mediaKind:'audio'}]}}},[watch('start'),watch('stop')]);
 const publicTool=(tool,input={},extra={})=>service('public',{tool,input,...extra});
 for(const kind of CHANGES.filter(k=>!k.internal))await run('public-change-'+kind.tool,{},[publicTool(kind.tool)]);
 for(const kind of ACTIONS)await run('public-action-'+kind.tool,{},[publicTool(kind.tool)]);
 for(const input of [{},{track:3,from_beat:0,beats:4},{track:'track:1',from_beat:-1,beats:4},{track:'track:1',from_beat:0,beats:0},{track:'track:999',from_beat:0,beats:4},{track:'track:1',from_beat:0,beats:4},{track:'7:track:2',from_beat:1.5,beats:2.5}])await run('public-render',{other:{path:'/audio/result.wav',seconds:4,channels:2,sampleRate:48000}},[publicTool('render',input)]);
 for(const response of [{throw:'bridge failed'},{reply:{isError:true,content:[{type:'text',text:'render refused'}]}},{reply:wrap({})},{reply:{content:[{type:'text',text:'bad JSON'}]}}])await run('public-render-failure',{fail:{other:response}},[publicTool('render',{track:'track:1',from_beat:0,beats:4})]);
 for(const done of [true,false,null])for(const redo of [true,false,'true'])await run('public-live-undo',{other:{done}},[publicTool('undo_in_live',{redo})]);
 for(const response of [{throw:'bridge failed'},{reply:{isError:true,content:[{type:'text',text:'undo refused'}]}},{reply:{content:[{type:'text',text:'bad JSON'}]}}])await run('public-live-undo-failure',{fail:{other:response}},[publicTool('undo_in_live')]);
 for(const result of [null,3,{},[{ref:'7:track:90',type:'Track',name:'Created'},{ref:'7:clip:90:0',type:'Clip',name:'New clip'}],{nested:{ref:'7:device:90:0',type:'Device'}},{ref:'7:track:90',type:3,name:'Ignore'},{ref:'7:track:90',type:'Wrong',name:'X'.repeat(300)},{ref:'7:t_:0',type:'Other'},{ref:'۷:track:90',type:'Track',name:'Unicode digit'},{ref:'7:'+('a'.repeat(33))+':0',type:'Other'}])await run('public-python-register',{other:{ok:true,result}},[publicTool('run_python',{code:'result = None'})]);
 for(const response of [{throw:'bridge failed'},{reply:{isError:true,content:[{type:'text',text:'python refused'}]}},{reply:{content:[{type:'text',text:'bad JSON'}]}},{reply:wrap({ok:false,result:{ref:'7:track:90',type:'Track',name:'Made before error'},error:'oops'})},{cancel:true,reply:wrap({ok:true,result:7})}])await run('public-python-failure',{fail:{other:response}},[publicTool('run_python',{code:'result = obj.name',ref:'track:1'})]);
 await run('public-python-stale',{},[publicTool('run_python',{code:'result = obj.name',ref:'track:999'})]);
 await run('public-python-retirement',{other:{ok:true,result:{ref:'7:track:90',type:'Track',name:'Made'}}},[publicTool('run_python',{code:'result = obj'}),publicTool('render',{track:'track:1',from_beat:0,beats:4}),publicTool('render',{track:'track:4',from_beat:0,beats:4})]);
 for(const input of [{change:'missing'},{},{change:'last',final:true}])await run('public-undo',{},[publicTool('undo_change',input)]);
 await run('public-plan',{},[publicTool('make_changes',{steps:[{tool:'set_tempo',input:{tempo:128}}],final:true})]);
 await run('public-watch',{},[publicTool('watch_me',{action:'start'}),publicTool('watch_me',{action:'stop'})]);
 for(const input of [{},{candidates:[]},{candidates:[{track:'track:1'}],beats:0}])await run('public-audition-invalid',{},[publicTool('audition',input)]);
 for(const folders of [['relative'],[fixture],[fixture+'/missing'],[fixture,42]])await run('public-samples',{},[publicTool('find_sounds',{folders,limit:1,words:['missing']})]);
 const values=[],ids=new Map();for(const c of cases)c.responses=c.responses.map(v=>{const key=JSON.stringify(v);if(!ids.has(key)){ids.set(key,values.length);values.push(v);}return ids.get(key);});
 writeFileSync(new URL('mutations-oracle.json',import.meta.url),JSON.stringify({toolNames,cases,values})+'\n');console.log(cases.length+' source change/action sequences');
}finally{unlinkSync(file);rmSync(fixture,{recursive:true,force:true})}
