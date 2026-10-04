// Regenerate after `npm run build --workspace @kumi/runtime`.
import { writeFileSync } from 'node:fs';
import { measureSamples } from '../../../../packages/runtime/dist/src/library/features.js';
import { kick, hat, snare, beat, pad } from '../../../../packages/runtime/dist/test/fixtures/library.js';
const cases = [
  { kind: 'kick', rate: 44100, seconds: 0.5 },
  { kind: 'hat', rate: 44100, seconds: 0.12 },
  { kind: 'snare', rate: 44100, seconds: 0.25 },
  { kind: 'beat', rate: 44100, seconds: 4 },
  { kind: 'pad', rate: 44100, seconds: 4 },
  { kind: 'silence', rate: 48000, seconds: 0.25 },
  { kind: 'empty', rate: 44100, seconds: 0 },
  ...[8000, 16000, 22050, 32000, 48000, 96000].map(rate => ({ kind: 'tone', rate, seconds: 0.37 })),
  { kind: 'short', rate: 22050, seconds: 0.006 },
  { kind: 'stereo', rate: 44100, seconds: 0.4 },
  { kind: 'anti', rate: 44100, seconds: 0.1 },
];
const samples = ({kind,rate,seconds}) => {
  switch (kind) {
    case 'kick': return [kick(50)];
    case 'hat': return [hat()];
    case 'snare': return [snare()];
    case 'beat': return [beat(120, 2)];
    case 'pad': return [pad([220,261.63,329.63],4)];
    case 'silence': case 'empty': return [new Float32Array(Math.round(rate*seconds))];
    case 'stereo': return [0,1].map(channel=>Float32Array.from({length:Math.round(rate*seconds)},(_,i)=>0.3*Math.sin(2*Math.PI*(channel?446:440)*i/rate)));
    case 'anti': {const left=Float32Array.from({length:Math.round(rate*seconds)},(_,i)=>0.3*Math.sin(2*Math.PI*440*i/rate));return [left,left.map(v=>-v)];}
    default: return [Float32Array.from({length:Math.round(rate*seconds)},(_,i)=>0.25*Math.sin(2*Math.PI*440*i/rate))];
  }
};
for (const entry of cases) {const channels=samples(entry);entry.expected=measureSamples(channels,entry.rate,entry.seconds);}
writeFileSync(new URL('library-features-oracle.json',import.meta.url),JSON.stringify(cases)+'\n');
