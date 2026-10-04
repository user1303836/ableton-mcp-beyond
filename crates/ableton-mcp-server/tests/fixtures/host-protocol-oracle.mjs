// Run with the reference dist/src/host.js path. SHA-256 keeps large catalogs out of the fixture.
import fs from "node:fs";
import {pathToFileURL} from "node:url";
import {createHash} from "node:crypto";
const base=new URL(".",pathToFileURL(process.argv[2]));
const {McpHost}=await import(new URL("host.js",base));
const {DeterministicLiveSimulator,UnavailableLiveAdapter}=await import(new URL("live.js",base));
const {TOOL_POLICY_PROFILES}=await import(new URL("tool-catalog.js",base));
const init={jsonrpc:"2.0",id:"setup",method:"initialize",params:{protocolVersion:"2025-11-25",capabilities:{},clientInfo:{name:"oracle",version:"1"}}};
const ready={jsonrpc:"2.0",method:"notifications/initialized"};
const meta={"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}};
const modern=(method,params={},id=1)=>({jsonrpc:"2.0",id,method,params:{...params,_meta:meta}});
const cases=[];
const canonical=v=>Array.isArray(v)?"["+v.map(canonical).join(",")+"]":v&&typeof v==="object"?"{"+Object.keys(v).sort().map(k=>JSON.stringify(k)+":"+canonical(v[k])).join(",")+"}":JSON.stringify(v);
async function run(name,requests,options={}) {
 const adapter=new UnavailableLiveAdapter();
 if(options.status)adapter.status=()=>structuredClone(options.status);
 if(options.statusError)adapter.status=()=>{throw Error("broken adapter");};
 const host=new McpHost(adapter,{...(options.policy!==undefined?{toolPolicy:options.policy}:{})});
 const steps=[];
 for(const request of requests) {
  try {
   const result=options.async?await host.handleAsync(request):host.handle(request);
   // Typed native status preserves fields and values; JSON object property insertion order is not adapter authority.
   const normalizeStatus=request?.method==="tools/call"&&request?.params?.name==="live_status"&&result?.result?.isError===false;
   if(normalizeStatus)result.result.content[0].text=canonical(JSON.parse(result.result.content[0].text));
   const text=JSON.stringify(result);
   steps.push({request,...(normalizeStatus?{normalizeStatus:true}:{}),sha256:createHash("sha256").update(text).digest("hex"),...(text.length<=600?{result}:{})});
  }catch(e){steps.push({request,error:e.message});}
 }
 cases.push({name,...options,steps});
}
for(const async of [false,true]) {
 for(const state of ["cold","initialized","ready","modern","exited"]) {
  const prefix=state==="cold"?[]:state==="modern"?[modern("ping",{},"setup")]:state==="exited"?[init,ready,{jsonrpc:"2.0",method:"exit"}]:state==="initialized"?[init]:[init,ready];
  const envelopes=[null,[],{},true,0,"x",{jsonrpc:"2.0"},{jsonrpc:"1.0",id:1,method:"ping"},{jsonrpc:"2.0",id:1,method:4},{jsonrpc:"2.0",id:null,method:"ping"},{jsonrpc:"2.0",id:"",method:"ping"},{jsonrpc:"2.0",id:1.1,method:"ping"},{jsonrpc:"2.0",id:2**53,method:"ping"},{jsonrpc:"2.0",id:"😀".repeat(64),method:"ping"},{jsonrpc:"2.0",id:"😀".repeat(65),method:"ping"},{jsonrpc:"2.0",id:1,method:"ping",x:1},{jsonrpc:"2.0",id:1,method:"ping",_meta:null}];
  for(const request of envelopes)await run("envelope/"+state,[...prefix,request],{async});
  for(const method of ["ping","tools/list","resources/list","prompts/list","notifications/initialized","notifications/cancelled","exit","shutdown","resources/templates/list","resources/read","prompts/get","tools/call","server/discover"]) for(const params of [undefined,null,{},[],{extra:true}])await run("method/"+state+"/"+method,[...prefix,{jsonrpc:"2.0",id:1,method,...(params===undefined?{}:{params})}],{async});
 }
 await run("duplicate",[{jsonrpc:"2.0",id:0,method:"ping"},{jsonrpc:"2.0",id:0.0,method:"initialize",params:init.params},init,ready,{jsonrpc:"2.0",id:1,method:"ping"},{jsonrpc:"2.0",id:"1",method:"ping"},{jsonrpc:"2.0",id:1,method:"ping"},{jsonrpc:"2.0",id:"1",method:"ping"}],{async});
 await run("discovery-neutral",[modern("server/discover"),init,ready,{jsonrpc:"2.0",id:1,method:"ping"},modern("server/discover",{},1)],{async});
 await run("modern-reuse",[modern("ping"),modern("ping"),modern("tools/list"),modern("ping",{},2),init],{async});
 for(const name of ["server_status","capabilities","plan_user_journey","live_status","live_snapshot","live_tempo_apply","live_subscribe","missing"]) for(const args of [undefined,null,{},[],{extra:true}]) {
  for(const state of ["initialized","ready","modern"]) {
   const request={jsonrpc:"2.0",id:1,method:"tools/call",params:{name,...(args===undefined?{}:{arguments:args})}};
   await run("tool/"+name+"/"+state,state==="modern"?[modern("tools/call",request.params)]:[init,...(state==="ready"?[ready]:[]),request],{async});
  }
 }
}
const initVariants=[null,{},[],{...init.params,extra:1},{...init.params,protocolVersion:"2026-07-28"},{...init.params,capabilities:[]},{...init.params,clientInfo:[]},...["name","version"].flatMap(field=>["",null,1,"😀".repeat(field==="name"?128:32),"😀".repeat(field==="name"?129:33)].map(value=>({...init.params,clientInfo:{...init.params.clientInfo,[field]:value}}))),{...init.params,clientInfo:{...init.params.clientInfo,extra:1}},{...init.params,clientInfo:{...init.params.clientInfo,title:[],description:null,websiteUrl:5,icons:"x"}}];
for(const params of initVariants)await run("initialize",[{...init,params},init,ready,init]);
for(const uri of ["ableton://capabilities","ableton://safety","ableton://max-extension","ableton://journeys","ableton://live-workflow","missing"])await run("resource/"+uri,[init,ready,{jsonrpc:"2.0",id:1,method:"resources/read",params:{uri}}]);
for(const name of ["analyze_audio","change_tempo_safely","compose_midi","shape_sound","learn_reference","record_audio","perform_session","missing"])for(const args of [undefined,{},null,[],{x:1},{sampleRate:44100,channels:2},{sampleRate:null,channels:[1,null,2]},{sampleRate:{}},{sampleRate:{toString:5}},{traits:"warm evolving",experienceLevel:"beginner",bars:"4"},{traits:" ",bars:"16"},{traits:"x",bars:"01"},{traits:"x",bars:4}])await run("prompt/"+name,[init,ready,{jsonrpc:"2.0",id:1,method:"prompts/get",params:{name,...(args===undefined?{}:{arguments:args})}}]);
const simulator=new DeterministicLiveSimulator().status();
const statusVariants=[new UnavailableLiveAdapter().status(),simulator,{...simulator,protocol:"wrong"},{...simulator,epoch:0},{...simulator,epoch:null},{...simulator,epoch:2**53},{...simulator,capabilities:[...simulator.capabilities,simulator.capabilities[0]]},{...simulator,operations:["wrong"]},{...simulator,operations:["snapshot","snapshot"]},{...simulator,registryHash:"X".repeat(64)},{...simulator,registryHash:"a".repeat(64)},{...simulator,provenance:"real-live",adapter:"remote-script",operations:["snapshot","session.discover"],capabilities:["session.read"]},{...simulator,provenance:"fake-live",adapter:"remote-script",operations:[],capabilities:[]}];
for(const status of statusVariants)for(const policy of [undefined,...Object.keys(TOOL_POLICY_PROFILES).map(profile=>({profile})),{profile:"full",deny:["live_*"]},{profile:"read-only",allow:["live_tempo_apply"]}])await run("status-policy",[init,ready,{jsonrpc:"2.0",id:1,method:"tools/list"},{jsonrpc:"2.0",id:2,method:"tools/call",params:{name:"capabilities"}},{jsonrpc:"2.0",id:3,method:"tools/call",params:{name:"live_status"}}],{status,policy});
await run("status-error",[init,ready,{jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"live_status"}}],{statusError:true});
fs.writeFileSync(new URL("host-protocol-oracle.json",import.meta.url),JSON.stringify({cases}));
console.log(JSON.stringify({cases:cases.length,requests:cases.reduce((n,c)=>n+c.steps.length,0)}));
