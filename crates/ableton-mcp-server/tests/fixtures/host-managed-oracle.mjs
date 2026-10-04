import fs from 'node:fs';import{pathToFileURL}from'node:url';
const base=new URL('.',pathToFileURL(process.argv[2]));const{McpHost}=await import(new URL('host.js',base));const{DeterministicLiveSimulator}=await import(new URL('live.js',base));
function simulator(){const s=new DeterministicLiveSimulator();for(let index=1;index<=3;index++){s.state.scenes.push({ref:`scene:scene-${index+1}`,objectIdentity:`simulator:scene:scene-${index+1}`,name:`Scene ${index+1}`,index});s.state.tracks[0].clipSlots.push({ref:`clip-slot:track-1:${index}`,parentRef:s.state.tracks[0].ref,objectIdentity:`simulator:clip-slot:track-1:${index}`,sceneIndex:index,clipRef:null,empty:true});}return s;}
function clean(value){value=structuredClone(value);if(value?.result?.content?.[0]?.text)try{const body=JSON.parse(value.result.content[0].text);if(body?.transactionId)body.transactionId='$transaction';if(body?.expiresAt)body.expiresAt='$time';value.result.content[0].text=body;}catch{}return value;}
const rows=[];
async function run(tool,args,options={}){const sim=simulator(),host=new McpHost(sim,options.policy?{toolPolicy:options.policy}:{}),row={tool,args,options};try{row.result=clean(await host[tool](1,structuredClone(args)));}catch(e){row.error=e.message;}rows.push(row);}
const preview={trackRef:'track:track-1',sceneIndex:1,name:'Bounded Beat',length:4,notes:[{pitch:36,start:0,duration:.25,velocity:100,channel:1}]};
const apply={transactionId:'missing',confirmation:'apply',idempotencyKey:'apply-key'};
for(const tool of ['liveMidiPreview','liveMidiPreviewAsync','liveMidiApply','liveMidiApplyAsync','liveBatchPreviewAsync','liveBatchApplyAsync']){
 const valid=tool.includes('Apply')?apply:tool.includes('Batch')?{operations:[{kind:'track.rename',trackRef:'track:track-1',name:'Renamed'}]}:preview;
 for(const value of [null,[],{},true,0,'x',valid,{...valid,extra:true}])await run(tool,value);
 for(const key of Object.keys(valid)){const missing={...valid};delete missing[key];await run(tool,missing);for(const value of [null,[],{},false,true,0,-1,1,1.5,1024,1025,100000,100001,'','x'])await run(tool,{...valid,[key]:value});}
}
for(const kind of ['mixer.set','device.parameter.set','clip.set','track.rename','scene.rename','track.create','routing.arm','other','constructor','toString','__proto__','__defineGetter__','__defineSetter__','hasOwnProperty','__lookupGetter__','__lookupSetter__','isPrototypeOf','propertyIsEnumerable','valueOf','toLocaleString',null,[],{}])for(const policy of [{profile:'full'},{profile:'read-only'},{profile:'full',deny:['live_track_properties_preview']}])await run('liveBatchPreviewAsync',{operations:[{kind}]},{policy});
const workflows=[];
for(const tool of ['liveMidiPreview','liveMidiPreviewAsync','liveBatchPreviewAsync'])for(const reconnect of [false,true]){
 const sim=simulator(),host=new McpHost(sim),args=tool.includes('Batch')?{operations:[{kind:'track.rename',trackRef:'track:track-1',name:'Renamed'}]}:preview;
 const results=[];const made=await host[tool](1,args);results.push(clean(made));const transactionId=JSON.parse(made.result.content[0].text).transactionId;if(reconnect)sim.reconnect();
 const applyTool=tool.replace('Preview','Apply');for(const key of ['apply-key','apply-key','another-key'])try{results.push(clean(await host[applyTool](results.length+1,{transactionId,confirmation:'apply',idempotencyKey:key})));}catch(e){results.push({error:e.message});}
 workflows.push({tool,reconnect,results,state:sim.state});
}
fs.writeFileSync(new URL('host-managed-oracle.json',import.meta.url),JSON.stringify({state:simulator().state,preview,rows,workflows}));console.log({rows:rows.length,workflows:workflows.length});
