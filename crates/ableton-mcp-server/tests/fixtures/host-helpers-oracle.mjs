// Regenerate with node .../host-helpers-oracle.mjs PATH_TO_BUILT_HOST_JS.
import fs from "node:fs";
import vm from "node:vm";
const path = process.argv[2];
const source = fs.readFileSync(path, "utf8");
const context = vm.createContext({ structuredClone, Date: {now:()=>1000}, REQUEST_ID_MAX_LENGTH:128, MAX_SET_COLLECTION:10_000_000, MAX_RETAINED_TRANSACTION_BYTES:1024**3 });
vm.runInContext(source.slice(source.indexOf("function isObject("), source.indexOf("export class McpHost")), context);
const cases=[];
function test(fn,...args) { try { const value=vm.runInContext(fn,context)(...args); cases.push({fn,args,...(value===undefined?{undefined:true}:{result:value})}); } catch(error) {cases.push({fn,args,error:error.message});} }
const values=[null,false,true,0,1,1.5,-1,2**53-1,2**53,"","x","a".repeat(128),"a".repeat(129),"😀".repeat(64),"😀".repeat(65),[],{},[1],{name:"test"}];
for(const value of values) {
  test("isNonEmptyString",value); test("isFiniteAtLeast",value,0); test("isIntegerInRange",value,0,128);test("isIdempotencyKey",value);
  test("isDiscoveryFilter",value);test("outputSafetyOf",value);test("canonicalMutationIdentity",value);test("retainedBytes",value);
}
for(const value of [{safe:true,provenance:"observed"},{safe:true,provenance:"simulator"},{safe:true,provenance:"unknown"},{safe:true,provenance:" ",observedAt:null,scope:[]},{safe:true,provenance:"observed",extra:1},{safe:true,provenance:"a".repeat(512)},{safe:true,provenance:"a".repeat(513)}]) test("outputSafetyOf",value);
for(const value of [{x:[]},{x:null},{x:{}},{x:2**53},{x:2**53-1},{"":1},{["a".repeat(65)]:1},{x:"😀".repeat(128)},{x:"😀".repeat(129)},Object.fromEntries(Array.from({length:8},(_,i)=>[i,1])),Object.fromEntries(Array.from({length:9},(_,i)=>[i,1]))]) test("isDiscoveryFilter",value);
for(const reason of [""," ","valid refusal"," request failed: stale epoch ","x\nz","at foo (line)","format foo (line)","node:internal/pipeline","/tmp/file","a /tmp/file","a/tmp/file","/x","file C:\\secret","file \\\\server\\share","path='a/b/c'","X"+"😀".repeat(201),"\uFEFFokay\uFEFF","\u0085/tmp/file","\u0085test","\uFEFF/tmp/file","àat x (y)"]) test("adapterReason",reason);
for(const a of [null,0,0.6,0.6000000238,0.60001,1.0,1.000001,1.000002,"1",[1,0.6],[1,0.6000000238],{a:1,b:2},{b:2,a:1}]) for(const b of [null,0.6,0.6000000238,1.0,[1,0.6],{a:1,b:2}]) test("sameLiveValue",a,b);
for(const observed of [-1,0,1,1.5,2,null,"1"]) for(const proposed of [0.49,0.5,0.5000000005,0.500000002,1.49]) for(const parameter of [{min:0,max:127},{min:0.5,max:127},{min:0,max:1.5},{}]) test("wholeNumberLiveKept",observed,proposed,parameter);
for(const tempo of [-1,0,19,20,999,1000,null,"120"]) for(const enabled of [true,false,null]) test("sceneRestoreFields",{tempo,tempoEnabled:enabled});
for(const signatureNumerator of [-1,0,1,4,99,100,1.5,null]) for(const enabled of [true,false]) test("sceneRestoreFields",{signatureNumerator,timeSignatureEnabled:enabled,signatureDenominator:4});
for(const value of [-1,0,19,20,120,1000,null]) for(const field of ["tempo","signatureNumerator","name"]) for(const restored of [{tempo:-1,tempoEnabled:false,signatureNumerator:0,timeSignatureEnabled:false},{tempo:120,tempoEnabled:true,signatureNumerator:4,timeSignatureEnabled:true}]) test("sceneFieldRestored",restored,field,value,{});
for(const value of [-5,0,0.49,0.5,0.51,1,2,100]) for(const parameter of [{min:0,max:1},{min:0,max:127,quantization:1},{min:-1,max:1,quantization:0.5},{min:0,max:5,quantization:2},{min:5,max:2},{min:-1,max:1,quantization:-1}]) test("fitParameterValue",value,parameter);
for(const kind of ["scene-fire","transport-action","dialog","clip-action","looper","rack","device-advanced","drum-pad","other"]) for(const state of ["applied","uncertain"]) for(const action of [undefined,null,"set","delete-all-chains","save-comparison","set-bank","re-enable-automation","go"]) test("isRetirableAppliedTransaction",{kind,state,payload:{...(action===undefined?{}:{action})}});
function retention(capacity,steps) {
 const R=vm.runInContext("TransactionRetention",context), M=vm.runInContext("BoundedTransactionMap",context);
 const r=new R(capacity),deletions=[],maps=[0,1,2].map(i=>new M(r,v=>{deletions.push([i,v.tag??null]);if(v.cleanupError)throw Error("cleanup");}));
 const inFlight=vm.runInContext("IN_FLIGHT_TRANSACTION_IDS",context);inFlight.clear();const results=[];
 for(const step of steps) {
   let failure;
   try {
    if(step.op==="set") maps[step.map].set(step.key,structuredClone(step.value));
    if(step.op==="update") Object.assign(maps[step.map].get(step.key)??{},step.value);
    if(step.op==="delete") maps[step.map].delete(step.key);
    if(step.op==="flight") step.value?inFlight.add(step.key):inFlight.delete(step.key);
   }catch(e){failure=e.message;}
   results.push(structuredClone({bytes:r.bytes,maps:maps.map(map=>[...map]),deletions:[...deletions],...(failure?{error:failure}:{})}));
 }
 return {capacity,steps,results};
}
const traces=[];
traces.push(retention(250,[
 {op:"set",map:0,key:"a",value:{expiresAt:2000,state:"previewed",tag:"a"}},
 {op:"set",map:1,key:"b",value:{expiresAt:2000,state:"applied",tag:"b"}},
 {op:"set",map:2,key:"c",value:{expiresAt:2000,state:"uncertain",tag:"c"}},
 {op:"set",map:0,key:"d",value:{expiresAt:2000,state:"previewed",tag:"d",large:"x".repeat(180)}},
 {op:"set",map:0,key:"e",value:{expiresAt:2000,state:"previewed",tag:"e",large:"x".repeat(30)}},
 {op:"update",map:1,key:"b",value:{large:"x".repeat(200)}},
 {op:"set",map:1,key:"b",value:{expiresAt:2000,state:"applied",tag:"b2",large:"x".repeat(200)}},
 {op:"set",map:0,key:"f",value:{expiresAt:2000,state:"previewed",tag:"f"}},
 {op:"delete",map:1,key:"b"},
 {op:"set",map:0,key:"f",value:{expiresAt:2000,state:"previewed",tag:"f"}},
]));
let seed=932341; const random=n=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n;};
for(const capacity of [0,100,250,700]) {
 const steps=[];
 for(let i=0;i<100;i++) {
  const map=random(3),key="id_"+random(7),op=random(8);
  if(op===0)steps.push({op:"flight",key,value:random(2)===1});
  else if(op===1)steps.push({op:"delete",map,key});
  else if(op===2)steps.push({op:"update",map,key,value:{state:["previewed","applied","uncertain","undone"][random(4)]}});
  else steps.push({op:"set",map,key,value:{expiresAt:random(3)*1000,state:["previewed","applied","uncertain","undone","applying"][random(5)],kind:["looper","rack","scene-fire","tempo"][random(4)],payload:{action:["set","go"][random(2)]},tag:i,cleanupError:random(5)===0,text:"😀".repeat(random(10))}});
 }
 traces.push(retention(capacity,steps));
}
fs.writeFileSync(new URL("host-helpers-oracle.json",import.meta.url),JSON.stringify({cases,traces}));
console.log(JSON.stringify({helpers:cases.length,retentionSteps:traces.reduce((a,t)=>a+t.steps.length,0)}));
