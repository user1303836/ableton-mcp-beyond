import fs from "node:fs";
import {pathToFileURL} from "node:url";
import {createHash} from "node:crypto";
const base=new URL(".",pathToFileURL(process.argv[2]));
const {McpHost}=await import(new URL("host.js",base));
const {DeterministicLiveSimulator,LIVE_REGISTRY_OPERATIONS}=await import(new URL("live.js",base));
const canonical=v=>Array.isArray(v)?"["+v.map(canonical).join(",")+"]":v&&typeof v==="object"?"{"+Object.keys(v).sort().map(k=>JSON.stringify(k)+":"+canonical(v[k])).join(",")+"}":JSON.stringify(v);
const hash=v=>createHash("sha256").update(canonical(v)).digest("hex");
const context=ctx=>ctx===undefined?null:{...(typeof ctx.deadlineMs==="number"?{deadline:true}:{}),...(ctx.idempotencyKey!==undefined?{idempotencyKey:ctx.idempotencyKey}:{}),...(ctx.transactionId!==undefined?{transactionId:ctx.transactionId}:{}),...(ctx.signal!==undefined?{signal:true}: {})};
const sim=new DeterministicLiveSimulator(), snapshot=sim.snapshot(),track=snapshot.tracks[0],clip=track.clips[0],device=track.devices[0],parameter=device.parameters[0];
const valid={
 live_snapshot:{},live_discover:{kind:"track"},live_note_read:{clipRef:clip.ref,noteIds:[1]},live_key_estimate:{notes:[{pitch:60,start:0,duration:1},{pitch:64,start:1,duration:1},{pitch:67,start:2,duration:1}]},
 live_song_state:{conversion:"current-smpte",smpteFormat:"smpte-25"},live_performance_read:{},live_data_read:{key:"test"},
 live_automation_read:{clipRef:clip.ref,parameterRef:parameter.ref,time:0},
 live_device_read:{deviceRef:device.ref,what:"parameter-names",begin:0,end:-1},
 live_clip_time_convert:{clipRef:clip.ref,from:"beats",value:1},
 live_message:{text:"test",modal:false},live_run_python:{code:"1 + 1",mode:"eval",timeoutMs:30000},
 live_browser_preview:{itemId:"browser:test"},live_browser_preview_stop:{previewId:"p".repeat(32)},
 live_observe_subscribe:{topics:[{kind:"transport"}],minIntervalMs:100},
 live_observe_poll:{subscriptionId:"observer-test"},live_observe_unsubscribe:{subscriptionId:"observer-test"},live_browser_roots:{}
};
const method=tool=>"live"+tool.slice(5).split("_").map(s=>s[0].toUpperCase()+s.slice(1)).join("")+"Async";
const defaults={"python.run":{value:2,output:""},"browser.inspect":{id:"browser:test",objectIdentity:"browser-object",name:"Preset"},"browser.preview.start":{previewId:"p".repeat(32)},"browser.preview.stop":{stopped:true},"observe.subscribe":{subscriptionId:"observer-test",topics:[{kind:"transport"}]},"observe.poll":{subscriptionId:"observer-test",changes:[],cursor:"1"},"observe.unsubscribe":{removed:true}};
const cases=[];
async function run(tool,args,options={}) {
 const sim=new DeterministicLiveSimulator(),calls=[];
 const status=sim.status();status.operations=[...LIVE_REGISTRY_OPERATIONS];
 if(options.statusPatch)Object.assign(status,options.statusPatch);
 sim.status=()=>structuredClone(status);
 sim.refreshStatusAsync=async ctx=>{calls.push({kind:"refresh",context:context(ctx)});if(options.fail==="refresh")throw Error(options.message??"request failed: offline");return sim.status();};
 const snapshotAsync=sim.snapshotAsync.bind(sim),discoverAsync=sim.discoverAsync.bind(sim),invokeAsync=sim.invokeAsync.bind(sim);
 sim.snapshotAsync=async (ctx,req)=>{calls.push({kind:"snapshot",context:context(ctx),request:req??null});if(options.fail==="snapshot")throw Error(options.message??"request failed: no snapshot");return snapshotAsync(ctx,req);};
 sim.discoverAsync=async (req,ctx)=>{calls.push({kind:"discover",request:req,context:context(ctx)});if(options.fail==="discover")throw Error(options.message??"request failed: no discovery");return discoverAsync(req,ctx);};
 sim.invokeAsync=async (invocation,ctx)=>{
   calls.push({kind:"invoke",invocation,context:context(ctx)});
   if(options.fail===invocation.operation || options.fail==="invoke")throw Error(options.message??"request failed: exact refusal");
   if(options.returns&&Object.hasOwn(options.returns,invocation.operation))return structuredClone(options.returns[invocation.operation]);
   if(Object.hasOwn(defaults,invocation.operation))return structuredClone(defaults[invocation.operation]);
   return invokeAsync(invocation,ctx);
 };
 const host=new McpHost(sim);
 const row={tool,...(args!==undefined?{args}:{}),...options};
 try {
  const result=await host[method(tool)](1,args);
  if(result?.result?.content?.[0]?.type==="text")try{const body=JSON.parse(result.result.content[0].text);if(tool==="live_performance_read"&&body.sampledAt!==undefined)body.sampledAt=0;result.result.content[0].text=canonical(body);}catch{}
  row.resultHash=hash(result);if(JSON.stringify(result).length<1200)row.result=result;
 }catch(e){row.error=e.message;}
 row.calls=calls;
 cases.push(row);
}
const mutations=[null,[],{},0,1,1.5,-1,false,true,"","x","😀".repeat(257)];
for(const [tool,args] of Object.entries(valid)) {
 await run(tool,args);
 for(const bad of [undefined,...mutations])await run(tool,bad);
 await run(tool,{...args,extra:1});
 for(const key of Object.keys(args)) {
  const missing={...args};delete missing[key];await run(tool,missing);
  for(const bad of mutations)await run(tool,{...args,[key]:bad});
 }
 for(const fail of ["refresh","snapshot","discover","invoke"])await run(tool,args,{fail});
 for(const statusPatch of [{connected:false},{capabilities:[]},{operations:[]}])await run(tool,args,{statusPatch});
 await run(tool,args,{fail:"invoke",message:"details /private/user/project/file.als"});
}
for(const kind of ["set","track","return-track","main-track","scene","clip-slot","session-clip","arrangement-clip","note","locator","device","parameter","selection","routing-choice","session-playback","clip"]) {
 await run("live_discover",{kind});
 await run("live_discover",{kind,parent:track.ref,fields:[],budget:10_000_000,limit:100_000});
}
for(const patch of [{limit:2001},{limit:100001},{limit:1.0},{budget:1.0},{cursor:"not-a-cursor"},{fields:Array(257).fill("name")},{filter:{name:null}},{filter:{name:[]}}])await run("live_discover",{kind:"note",parent:clip.ref,...patch});
for(const noteIds of [[0],[1,2,1],[-1],[1.5],[2**53],Array(3).fill(1)])await run("live_note_read",{clipRef:clip.ref,noteIds});
for(const selected of [true,false,null,1])await run("live_note_read",{clipRef:clip.ref,selected});
for(const what of ["banks","parameter-names"])for(const range of [{},{begin:4,end:3},{begin:4,end:-1},{begin:0,end:10_000_000},{begin:0,end:10_000_001}])await run("live_device_read",{deviceRef:device.ref,what,...range});
for(const notes of [[],[{}],[null],[{pitch:60,start:0,duration:1,extra:1}],[{pitch:60,start:0,duration:0}],[{pitch:60,start:0,duration:1,velocity:0}]])await run("live_key_estimate",{notes});
for(const clipRef of [clip.ref,"unknown"])for(const expectedNotesRevision of [undefined,"a".repeat(64),"A".repeat(64)])await run("live_key_estimate",{clipRef,...(expectedNotesRevision?{expectedNotesRevision}:{})});
for(const tool of ["live_automation_read","live_device_read","live_clip_time_convert","live_message","live_browser_preview","live_browser_preview_stop","live_data_read","live_song_state"]) {
 const ops={"live_automation_read":"automation.envelope.read","live_device_read":"plugin.parameter-names","live_clip_time_convert":"clip.time-convert","live_message":"application.message","live_browser_preview":"browser.inspect","live_browser_preview_stop":"browser.preview.stop","live_data_read":"data.get","live_song_state":"song.read"};
 for(const value of [null,{},false,1,"x",[]])await run(tool,valid[tool],{returns:{[ops[tool]]:value}});
}
await run("live_automation_read",valid.live_automation_read,{returns:{"automation.envelope.read":{exists:true,points:[],revision:"r"},"automation.value-at":null}});
for(const topics of [[],Array(65).fill({kind:"track"}),[null],[{kind:"track",ref:""}],[{kind:"track",ref:track.ref}],[{kind:"wrong"}]])await run("live_observe_subscribe",{topics});
fs.writeFileSync(new URL("host-reads-oracle.json",import.meta.url),JSON.stringify({defaults,cases}));
console.log(JSON.stringify({cases:cases.length,dispatches:cases.reduce((n,c)=>n+c.calls.length,0)}));
