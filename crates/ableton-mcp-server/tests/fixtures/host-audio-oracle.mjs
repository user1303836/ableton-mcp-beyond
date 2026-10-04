import fs from "node:fs";
import {pathToFileURL} from "node:url";
const base=new URL(".",pathToFileURL(process.argv[2]));
const {McpHost}=await import(new URL("host.js",base));
const {DeterministicLiveSimulator}=await import(new URL("live.js",base));
const {analyzePcm}=await import(new URL("analysis.js",base));
const {diagnoseAudioWithLiveContext}=await import(new URL("audio-diagnosis.js",base));
const host=new McpHost(),count=[],encoded=[],requests=[];
const pcm=Buffer.alloc(32).toString("base64"),valid={pcmBase64:pcm,sampleRate:48000};
const values=[null,{},[],true,0,1,1.5,-1,"","x",pcm];
for(const value of [...values,"AAAAAA==","AAAAAB==","AAAA","AA==","A===","AAAAAAAA","AAAAAAA=","A".repeat(64),"-AAAAA==","_AAAAA==","AA AA===","😀😀","AAAAAA==\n"])count.push({value,result:host.base64FloatCount(value)});
for(const maxChannels of [2,32])for(const allowFrameSize of [false,true]) {
 const args=[undefined,...values,valid,{...valid,extra:true}];
 for(const field of ["pcmBase64","sampleRate","channels","channelLayout","frameSize"])for(const value of [...values,8000,7999,32000,96000,384000,384001,256,4096,4097,["M"],["L","R"],["L","L"],["M","L","R","C","Ls","Rs","LFE"]])args.push({...valid,[field]:value});
 for(const value of args)encoded.push({...(value===undefined?{}:{value}),maxChannels,allowFrameSize,...(host.encodedAnalysisSource(value,maxChannels,allowFrameSize)===undefined?{undefined:true}:{result:host.encodedAnalysisSource(value,maxChannels,allowFrameSize)})});
}
async function request(tool,args) {
 const jobs=[];host.analysisRunner={run:async job=>{jobs.push(job);return{okay:true};}};
 const row={tool,...(args===undefined?{}:{args})};
 try{row.result=await host[tool==="audio_analyze"?"audioAnalyzeAsync":"audioCompareReferenceAsync"](1,args);row.jobs=jobs;}catch(e){row.error=e.message;}
 requests.push(row);
}
for(const args of [undefined,...values,valid,{...valid,extra:true}])await request("audio_analyze",args);
for(const field of ["pcmBase64","sampleRate","channels","channelLayout","frameSize"])for(const value of [...values,8000,7999,32000,96000,384000,384001,256,4096,4097,["M"],["L","R"],["L","L"]])await request("audio_analyze",{...valid,[field]:value});
const pair={project:valid,reference:valid};
for(const args of [undefined,...values,pair,{...pair,extra:true},{project:valid},{reference:valid}])await request("audio_compare_reference",args);
for(const side of ["project","reference"])for(const value of [...values,{...valid,sampleRate:8000},{...valid,sampleRate:32000},{...valid,sampleRate:96000},{...valid,sampleRate:96001},{...valid,frameSize:1024},{...valid,channels:4}])await request("audio_compare_reference",{...pair,[side]:value});
for(const alignment of [...values,{}, {extra:1},{mode:"auto"},{mode:"manual"},{mode:"disabled"},{mode:["auto"]},{mode:{toString:5}},{mode:["manual","auto"]}])await request("audio_compare_reference",{...pair,alignment});
for(const field of ["maxLagSeconds","manualOffsetSeconds"])for(const value of [...values,-10,-10.1,10,10.1])await request("audio_compare_reference",{...pair,alignment:{[field]:value}});
const sim=new DeterministicLiveSimulator(),snapshot=sim.snapshot(),source={kind:"caller-supplied-pcm",observedAt:"2026-01-01T00:00:00.000Z",description:"fixed source"};
const analysis=analyzePcm({samples:new Float32Array(4096).fill(0.95),sampleRate:48000});
const diagnoses=[];
for(const variant of ["full","extra","reordered","routing","partial-other","no-mixer","missing","verified"]) {
 const state=structuredClone(snapshot);const provenance={...source};
 if(variant==="extra")state.tracks[0].mixer.future={gain:0.2,description:"retained"};
 if(variant==="reordered")state.tracks[0].mixer=Object.fromEntries(Object.entries(state.tracks[0].mixer).reverse());
 if(variant==="routing")state.tracks[0].routing.futureRoute={choice:"2"};
 if(variant==="partial-other")state.tracks.push({ref:"unrelated"});
 if(variant==="no-mixer")delete state.tracks[0].mixer;
 if(variant==="verified"){provenance.kind="verified-live-resampling-capture";provenance.captureId="capture-fixture";}
 const trackRef=variant==="missing"?"unknown":snapshot.tracks[0].ref;
 const row={variant,snapshot:state,source:provenance,trackRef};
 try{row.result=diagnoseAudioWithLiveContext(analysis,state,1,trackRef,provenance,"2026-01-01T00:00:01.000Z");}catch(e){row.error=e.message;}
 diagnoses.push(row);
}
fs.writeFileSync(new URL("host-audio-oracle.json",import.meta.url),JSON.stringify({count,encoded,requests,analysis,diagnoses}));
console.log(JSON.stringify({count:count.length,encoded:encoded.length,requests:requests.length,diagnoses:diagnoses.length}));
