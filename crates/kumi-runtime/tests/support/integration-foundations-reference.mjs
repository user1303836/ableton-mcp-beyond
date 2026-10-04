// Regenerate after building the TypeScript runtime; Node is a reference-test dependency only.
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { foldTracks, trackLine } from '../../../../packages/runtime/dist/src/integrations/ableton/fold.js';
import { atLeast } from '../../../../packages/runtime/dist/src/integrations/ableton/bridge-version.js';
const track = (i) => ({ ref: `track:${i}`, name: `Track ${i}`, type: 'midi', devices: ['Operator','EQ Eight','Reverb'].map((name,j) => ({ref:`device:${j}`,name})), ...(i % 4 === 2 ? { group:'track:1' } : {}) });
const fold=[];
for(const count of [0,2,120,250,2000]) for(const budget of [0,50,200,2000,12288,999999]) for(const focused of [0,7,1900]) {
 const out=foldTracks(Array.from({length:count},(_,i)=>track(i+1)),row=>row.ref===`track:${focused}`,budget);
 fold.push({count,budget,focused,hash:createHash('sha256').update(JSON.stringify(out)).digest('hex')});
}
const lines=[{}, {ref:'track:9',name:'Pad',type:'audio'}, {ref:15,name:37,type:'midi',group:''}, {name:['a','b'],devices:[{name:['x',null,'z']},{name:{x:3}},{}]}, {name:'长'.repeat(80),devices:[{name:'é'.repeat(50)}]}].flatMap(track=>[true,false].map(names=>({track,names,text:trackLine(track,names)})));
const versions=[];
for(const version of [undefined,'','1.0.34','1.0.35','1.1.0','1.0.33','1.0.9','1.0.34-beta.1','bad','01.000.034garbage','1.0.34.1','1..35',' 1. 0. 34','1e9.0.3','1.-2.34']) for(const minimum of ['1.0.34','1.0.73','0','bad','1.0.34.1'])versions.push({version:version??null,minimum,expected:atLeast(version,minimum)});
writeFileSync(new URL('./integration-foundations-oracle.json',import.meta.url),JSON.stringify({fold,lines,versions},null,2)+'\n');
