import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
const base=new URL('.',pathToFileURL(process.argv[2]));
const {McpHost}=await import(new URL('host.js',base));
const {DeterministicLiveSimulator}=await import(new URL('live.js',base));
const {TOOL_CATALOG}=await import(new URL('tool-catalog.js',base));
const init={jsonrpc:'2.0',id:'setup',method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'catalog-oracle',version:'1'}}};
const modernMeta={'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientCapabilities':{}};
const baseStatus=new DeterministicLiveSimulator().status();
const fullStatus={...baseStatus,provenance:'real-live',capabilities:[...new Set([...baseStatus.capabilities,...TOOL_CATALOG.flatMap(t=>[...(t.prereq.capabilitiesAll??[]),...(t.prereq.capabilitiesAny??[])])])],operations:[...new Set([...baseStatus.operations,...TOOL_CATALOG.flatMap(t=>[...(t.prereq.operationsAll??[]),...(t.prereq.operationsAny??[])])])]};
function clean(v){
 if(Array.isArray(v))return v.map(clean);
 if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([key,value])=>[key,['expiresAt','sampledAt'].includes(key)?'<time>':key==='transactionId'?'<transaction>':key==='text'&&typeof value==='string'?(()=>{try{return clean(JSON.parse(value))}catch{return value}})():clean(value)]));
 return v;
}
const cases=[],pool=[],seen=new Map();function intern(v){const text=JSON.stringify(v);if(!seen.has(text)){seen.set(text,pool.length);pool.push(v)}return seen.get(text);}
for(const mode of ['simulator','available'])for(const modern of [false,true])for(const sync of [false,true])for(const tool of TOOL_CATALOG){
 for(const args of [null,{},[],{extra:true}]){
  const sim=new DeterministicLiveSimulator();const adapter=mode==='simulator'?sim:{status:()=>structuredClone(fullStatus),snapshot:()=>sim.snapshot(),get:r=>sim.get(r),invoke:i=>sim.invoke(i),subscribe:l=>sim.subscribe(l),reconnect:()=>sim.reconnect(),snapshotAsync:(c,r)=>sim.snapshotAsync(c,r),discoverAsync:(r,c)=>sim.discoverAsync(r,c),getAsync:(r,c)=>sim.getAsync(r,c),invokeAsync:(i,c)=>sim.invokeAsync(i,c),refreshStatusAsync:async()=>structuredClone(fullStatus)};
  const host=new McpHost(adapter);if(!modern){host.handle(init);host.handle({jsonrpc:'2.0',method:'notifications/initialized'});}
  const request={jsonrpc:'2.0',id:1,method:'tools/call',params:{name:tool.name,arguments:args,...(modern?{_meta:modernMeta}:{})}};
  let result;try{result=sync?host.handle(request):await host.handleAsync(request);}catch(e){result={thrown:e.message};}
  cases.push({mode,modern,sync,tool:tool.name,args,result:intern(clean(result)),state:intern(clean(sim.state))});
 }
}
fs.writeFileSync(new URL('host-catalog-routes-oracle.json',import.meta.url),JSON.stringify({tools:TOOL_CATALOG.map(t=>t.name),fullStatus,cases,pool}));
console.log({tools:TOOL_CATALOG.length,cases:cases.length,pool:pool.length});
