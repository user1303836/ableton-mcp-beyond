import fs from'node:fs';import os from'node:os';import path from'node:path';import{pathToFileURL}from'node:url';
const base=new URL('.',pathToFileURL(process.argv[2]));const{McpHost}=await import(new URL('host.js',base));const{DeterministicLiveSimulator}=await import(new URL('live.js',base));const{buildDeviceStateFile}=await import(new URL('transactions/device-state.js',base));
const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'host-device-state-oracle-'))),sim=new DeterministicLiveSimulator(),device=sim.state.tracks[0].devices[0],file=buildDeviceStateFile(sim.snapshot(),device.ref,'saved');file.savedAt='2026-01-01T00:00:00.000Z';
function setup(){fs.rmSync(dir,{recursive:true,force:true});fs.mkdirSync(dir);fs.writeFileSync(path.join(dir,'saved.ableton-device-state.json'),JSON.stringify(file));fs.writeFileSync(path.join(dir,'invalid.json'),'{');fs.writeFileSync(path.join(dir,'wrong.json'),'{}');fs.writeFileSync(path.join(dir,'oversized.json'),' '.repeat(256*1024+1));fs.mkdirSync(path.join(dir,'folder'));fs.symlinkSync(path.join(dir,'folder'),path.join(dir,'linked-directory'));fs.symlinkSync(path.join(dir,'saved.ableton-device-state.json'),path.join(dir,'linked.json'));}
function expand(v){return JSON.parse(JSON.stringify(v).replaceAll('$root',dir));}
function clean(v){v=structuredClone(v);if(v?.result?.content?.[0]?.text)try{const body=JSON.parse(v.result.content[0].text);if(body.transactionId)body.transactionId='$transaction';if(body.expiresAt)body.expiresAt='$time';v.result.content[0].text=body;}catch{}return JSON.parse(JSON.stringify(v).replaceAll(dir,'$root'));}
const valid={save:{deviceRef:device.ref,name:'saved',directory:'$root',overwrite:true},preview:{file:'$root/saved.ableton-device-state.json',targetDeviceRef:device.ref},apply:{transactionId:'missing',confirmation:'apply',idempotencyKey:'apply-key'}};
const methods={save:'liveDeviceStateSaveAsync',preview:'liveDeviceStateRecallPreviewAsync',apply:'liveDeviceStateRecallApplyAsync'},rows=[];
async function run(tool,args,options={}){setup();const sim=new DeterministicLiveSimulator();if(options.statusPatch){const status={...sim.status(),...options.statusPatch};sim.status=()=>status;}const host=new McpHost(sim);rows.push({tool,args,options,result:clean(await host[methods[tool]](1,expand(args)))});}
try{
for(const [tool,args]of Object.entries(valid)){
 for(const value of [null,{},[],true,0,'x',args,{...args,extra:true}])await run(tool,value);
 for(const field of Object.keys(args)){const missing={...args};delete missing[field];await run(tool,missing);for(const value of [null,{},[],false,true,0,1,-1,0.5,'','x'])await run(tool,{...args,[field]:value});}
 for(const statusPatch of [{connected:false},{capabilities:[]},{operations:[]}])await run(tool,args,{statusPatch});
}
for(const file of ['$root/missing.json','$root/invalid.json','$root/wrong.json','$root/oversized.json','$root/folder','$root/linked.json','relative.json','/bad\0file'])await run('preview',{...valid.preview,file});
for(const directory of ['$root/missing','$root/folder','$root/linked-directory','$root/wrong.json','relative','/bad\0dir'])await run('save',{...valid.save,directory});
for(const patch of [{morphFromLive:true},{amount:0.5},{morphFromLive:true,amount:0.5},{morphFromFile:'$root/saved.ableton-device-state.json',amount:0.5},{morphFromFile:'$root/saved.ableton-device-state.json',morphFromLive:true,amount:0.5},{morphFromFile:null,amount:0.5},{morphFromLive:false},{allowPartialLayout:true},{allowPartialLayout:'true'},{amount:1.1},{amount:-0.1}])await run('preview',{...valid.preview,...patch});
const workflows=[];
for(const mode of ['recall','morph-live','morph-file']){
 setup();const sim=new DeterministicLiveSimulator(),host=new McpHost(sim),results=[];
 sim.simulateExternalEdit(device.parameters[0].ref,'value',device.parameters[0].min);
 const args={...valid.preview,...(mode==='morph-live'?{morphFromLive:true,amount:0.5}:mode==='morph-file'?{morphFromFile:'$root/saved.ableton-device-state.json',amount:0.5}:{})};
 const preview=await host.liveDeviceStateRecallPreviewAsync(1,expand(args));results.push(clean(preview));const transactionId=JSON.parse(preview.result.content[0].text).transactionId;
 for(const key of ['apply-key','apply-key','another-key'])results.push(clean(await host.liveDeviceStateRecallApplyAsync(results.length+1,{transactionId,confirmation:'apply',idempotencyKey:key})));
 workflows.push({mode,args,results,state:sim.state});
}
fs.writeFileSync(new URL('host-device-state-oracle.json',import.meta.url),JSON.stringify({file,deviceRef:device.ref,parameter:device.parameters[0],rows,workflows}));console.log({rows:rows.length,workflows:workflows.length});
}finally{fs.rmSync(dir,{recursive:true,force:true});}
