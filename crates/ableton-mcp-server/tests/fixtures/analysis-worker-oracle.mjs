import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
const worker=process.argv[2];
const bytes=Buffer.alloc(4096*4);for(let i=0;i<4096;i++)bytes.writeFloatLE(0.1,i*4);
const pcm=bytes.toString('base64'), source={pcmBase64:'$pcm',sampleRate:48000}, rows=[];
function run(job) {
 const input=JSON.stringify(job).replaceAll('"$pcm"',JSON.stringify(pcm));
 const process=spawnSync('node',[worker],{input,encoding:'utf8'});
 const output=JSON.parse(process.stdout);
 rows.push({job,output,code:process.status});
}
for(const mode of [undefined,null,'auto','manual','disabled','unknown',0,true,{},[],['auto'],['manual'],['disabled'],[['auto']],['auto',null],{toString:1},[{toString:1}]]) {
 run({mode:'compare',project:source,reference:source,alignment:{...(mode===undefined?{}:{mode}),maxLagSeconds:0,manualOffsetSeconds:0}});
}
for(const channelLayout of [null,{},[],['M'],['L','R'],[['M']],[['L'],['R']],[{toString:1}],['unknown'],['L','L'],['LFE'],[['LFE']]])for(const mode of ['analyze','compare']) {
 const adjusted={...source,channelLayout};
 run(mode==='analyze'?{mode,source:adjusted}:{mode,project:adjusted,reference:source,alignment:{mode:'disabled'}});
}
fs.writeFileSync(new URL('analysis-worker-oracle.json',import.meta.url),JSON.stringify({pcm,rows}));
console.log(rows.length);
