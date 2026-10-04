// Regenerate from the built TypeScript reference: npm run build, then node this file.
import { writeFileSync } from 'node:fs';
import { applyMidiTransform, noteContentDigest, noteIdentityDigest, diffNotes } from '../../../../apps/mcp-server/dist/src/midi-transforms.js';
const notes = [60,64,67,72,76].map((pitch,index)=>({pitch,start:index<3?0:2,duration:1,velocity:100-index*5,channel:1,id:index+1,mute:index===0?null:false,probability:index===1?null:1,extra:'preserved'}));
const specs=[['transpose',{semitones:12}],['scale-constrain',{root:0,scale:'minor'}],['quantize',{grid:.25,amount:.5,target:'both'}],['swing',{grid:.25,amount:.7}],['velocity-curve',{curve:'arch',amount:1}],['humanize-velocity',{maxDelta:12,seed:'alpha'}],['humanize-timing',{maxOffset:.125,seed:'beta'}],['legato',{}],['staccato',{factor:.5}],['rotate',{steps:2}],['repeat',{times:3,decay:.5}],['ratchet',{subdivisions:3,probability:.6,seed:'gamma'}],['chord-voicing',{strategy:'drop2'}],['arpeggiate',{pattern:'random',rate:.25,seed:'delta'}],['seeded-variation',{velocityMax:10,timingMax:.05,probabilityDepth:.4,seed:'epsilon'}],['euclidean',{pulses:3,steps:8,pitch:36,rotation:-2}],['chord-progression',{symbols:['Cmaj7','Dm7','G7','C'],voicing:'drop2'}],['drum-pattern',{style:'breakbeat',bars:2,gridResolution:16,density:.5,seed:'drums',mapping:{kick:36,snare:38,closedHat:42,openHat:46}}],['bassline',{pattern:'walking',chords:['C','Dm7','G7','C'],stepBeats:.5}],['motif-invert',{}],['motif-retrograde',{}],['motif-augment',{numerator:3,denominator:2}],['motif-diminish',{numerator:2,denominator:3}]];
const cases=[];
for (const [type,params] of specs) for (const input of [[],notes]) {
 const spec={type,params}, expected=applyMidiTransform(input,spec,16);
 cases.push({notes:input,spec,clipLength:16,expected,contentDigest:noteContentDigest(expected.notes),identityDigest:noteIdentityDigest(expected.notes),diff:diffNotes(input,expected.notes)});
}
for(const [type,params] of specs) {
 try { const spec={type,params:{}}, expected=applyMidiTransform(notes,spec,16); cases.push({notes,spec,clipLength:16,expected}); }
 catch(e) { cases.push({notes,spec:{type,params:{}},clipLength:16,error:e.message}); }
}
writeFileSync(new URL('./midi-transform-oracle.json',import.meta.url),'[\n'+cases.map(row=>JSON.stringify(row)).join(',\n')+'\n]\n');
