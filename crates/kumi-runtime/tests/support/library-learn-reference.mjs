// Regenerate after building the TypeScript runtime. Whole learned entries, preserving Float32 vectors.
import {mkdtempSync,writeFileSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {learnSound} from '../../../../packages/runtime/dist/src/library/learn.js';
import {kick,hat,snare,beat,pad,wav} from '../../../../packages/runtime/dist/test/fixtures/library.js';
const root=mkdtempSync(join(tmpdir(),'kumi-learn-reference-'));
const cases=[];
try {
 for(const [name,channels] of [['Kick Deep.wav',[kick(48,.6)]],['Kick Short.wav',[kick(60,.25)]],['Hat Closed.wav',[hat()]],['Untitled 7.wav',[kick(52,.5)]],['Beat 120 bpm.wav',[beat(120,2)]],['Pad Am.wav',[pad([220,261.63,329.63],3),pad([220,261.63,329.63],3)]],['Dusty Snare.wav',[snare()]]]) {
  const path=join(root,name);writeFileSync(path,wav(channels));
  const entry=await learnSound(path,name,statSync(path).size,123);entry.path=name;
  cases.push(entry);
 }
 writeFileSync(new URL('library-learn-oracle.json',import.meta.url),JSON.stringify(cases)+'\n');
} finally {rmSync(root,{recursive:true,force:true});}
