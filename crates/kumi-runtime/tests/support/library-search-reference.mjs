// Differential corpus for sound rankings, explanations, preset/Set search and displayed tracks.
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {SoundIndex,searchPresets,searchSets,describeTrack,classForWord,isDescriptor} from '../../../../packages/runtime/dist/src/library/search.js';
import {CLASSES} from '../../../../packages/runtime/dist/src/library/classify.js';
import {packVector,unpackVector} from '../../../../packages/runtime/dist/src/library/store.js';
const root=mkdtempSync(join(tmpdir(),'kumi-search-reference-'));mkdirSync(join(root,'Nested'));
try{
 const learned=JSON.parse(readFileSync(new URL('library-learn-oracle.json',import.meta.url)));
 const entries=learned.map((entry,i)=>({...entry,path:join(root,i===2?'Nested':'Samples',entry.path)}));
 for(let i=0;i<92;i++)entries.push({path:join(root,'Names',`${['kick','Éclair','alpha','Alpha','Kick','Zulu'][i%6]} ${92-i}.wav`),size:100,mtime:i,class:CLASSES[i%CLASSES.length],classFrom:i%2?'sound':'folder',kind:i%2?'loop':'one-shot',seconds:(i%20+.5)/2,bpm:[60,120,123,240][i%4],key:['C major','A minor','C# minor','F major'][i%4],brightness:i*150,attack:i,decay:i*3,loudness:i-50,low:i/100,high:1-i/100,flatness:i%10/10,width:i%3/2,onsets:i%20,vector:packVector(Array.from({length:40},(_,d)=>Math.sin(d+i/5)))});
 entries.push({path:join(root,'Notes','Pluck C4.wav'),size:10,mtime:0,note:'C4',seconds:1,vector:'AA=='});
 entries.push({path:join(root,'Offline','Ignored.wav'),size:2,mtime:0});
 entries.push({path:root+'-missing/Ignored.wav',size:2,mtime:0});
 const sources=[{path:root,label:'User Library',kind:'user-library'},{path:join(root,'Nested'),label:'Nested Place',kind:'place'},{path:root+'-missing',label:'Offline',kind:'folder'}];
 const index=new SoundIndex(entries,sources);
 const queries=[{},{words:['kick']},{words:['kick','dark']},{words:['dusty','snare']},{kind:'loop',bpm:60},{bpm:119},{bpm:125},{classes:['hat','snare']},{key:'C'},{key:'Am'},{key:'F#min'},{minSeconds:.3,maxSeconds:.5},{folders:[join(root,'Nested')]},{folders:[]},{words:[' hi-hats ']},{words:['user library']},{words:['not-in-any-name']},{words:['kick'],limit:2}];
 for(const word of ['dark','warm','muffled','mellow','dull','deep','bright','crisp','airy','sharp','harsh','shiny','punchy','snappy','tight','short','long','boomy','big','soft','slow','dusty','lo-fi','gritty','dirty','crunchy','noisy','distorted','clean','pure','wide','stereo','mono','narrow','loud','quiet','heavy','fat','thick','thin','busy','sparse'])queries.push({words:[word],limit:7});
 const first=entries[0];queries.push({like:{vector:[...unpackVector(first.vector)],name:'Kick Deep.wav',path:first.path,brightness:first.brightness,attack:first.attack,seconds:first.seconds},limit:15});
 const files=JSON.parse(readFileSync(new URL('library-files-oracle.json',import.meta.url))).cases;
 const presets=files.filter(c=>c.expected&&c.kind!=='set').map((c,i)=>({path:join(root,c.name),size:100,mtime:i,name:c.name.replace(/\.[^.]+$/,''),format:c.name.split('.').at(-1),...c.expected,source:i%2?'Pack':'User Library',folder:i%2?'Effects':'Instruments'}));
 const presetQueries=[{},{words:['bass']},{device:'EQ Eight'},{device:'Drum Rack'},{device:'Alchemy'},{category:'instrument'},{category:'plug-in'},{words:['effect']},{words:['dark','rollers']},{words:['missing']},...Array.from({length:4},(_,i)=>({limit:i+1}))];
 const sets=files.filter(c=>c.kind==='set'&&c.expected).map((c,i)=>({path:join(root,c.name),size:100,mtime:1000+i,set:c.expected}));
 const setQueries=[{},{words:['serum']},{words:['vox','reverb']},{words:['sunrise']},{key:'Am'},{minTempo:120,maxTempo:125},{words:['old','synth']},{words:['euclidean']},{words:['vox.wav']},{words:['missing']},{limit:2}];
 const classWords=['kick','kicks','hi-hats','HI_HATS','h h','lo-fi','wide','808','sub','ambience','percussion','breaks','guitar','guitars','whatever'];
 const data={entries,sources,size:index.size,measured:index.measured,soundCases:queries.map(q=>{const query={limit:20,...q};return{query,expected:index.search(query)}}),presets,presetCases:presetQueries.map(q=>{const query={limit:20,...q};return{query,expected:searchPresets(presets,query)}}),sets,setCases:setQueries.map(q=>{const query={limit:20,...q};return{query,expected:searchSets(sets,query)}}),tracks:sets.flatMap(e=>[...e.set.tracks,...e.set.returns,...(e.set.main?[e.set.main]:[])]).map(track=>({track,expected:describeTrack(track)})),classWords:classWords.map(word=>({word,class:classForWord(word)??null,descriptor:isDescriptor(word)}))};
 writeFileSync(new URL('library-search-oracle.json',import.meta.url),JSON.stringify(data).replaceAll(root,'<ROOT>')+'\n');
}finally{rmSync(root,{recursive:true,force:true});}
