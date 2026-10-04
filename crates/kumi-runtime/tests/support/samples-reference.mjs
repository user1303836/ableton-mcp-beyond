import {writeFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {audioSeconds,findSamples,defaultSampleFolders} from '../../../../packages/runtime/dist/src/integrations/ableton/samples.js';
function wav(seconds){const b=Buffer.alloc(44);b.write('RIFF');b.writeUInt32LE(36+Math.round(44100*seconds)*4,4);b.write('WAVE',8);b.write('fmt ',12);b.writeUInt32LE(16,16);b.writeUInt32LE(176400,28);b.write('data',36);b.writeUInt32LE(Math.round(44100*seconds)*4,40);return b;}
function aiff(frames){const b=Buffer.alloc(38);b.write('FORM');b.writeUInt32BE(30,4);b.write('AIFF',8);b.write('COMM',12);b.writeUInt32BE(18,16);b.writeUInt32BE(frames,22);Buffer.from([0x40,0x0e,0xac,0x44,0,0,0,0,0,0]).copy(b,28);return b;}
const headers=[];
function add(b,bytes=b.length){let value;let throws=false;try{value=audioSeconds(b,bytes)??null}catch{throws=true;value=null}headers.push({hex:b.toString('hex'),bytes,value,throws});}
for(const s of [0,0.00003,.1,.5,1.5,2.667,1000]){const b=wav(s);add(b);for(const size of [0,0xffffffff]){const c=Buffer.from(b);c.writeUInt32LE(size,40);add(c,44+Math.round(44100*s)*4);}for(let n=0;n<b.length;n++)add(b.subarray(0,n));}
for(const frames of [0,1,22050,44100,0xffffffff]){const b=aiff(frames);add(b);const c=Buffer.from(b);c.write('AIFC',8);add(c);b[28]|=128;add(b);for(let n=0;n<b.length;n++)add(b.subarray(0,n));}
const odd=Buffer.concat([wav(.5).subarray(0,12),Buffer.from('4a554e4b0300000061626300','hex'),wav(.5).subarray(12)]);add(odd);
const root=mkdtempSync(join(tmpdir(),'kumi-sample-oracle-'));
const files=[['Drums/Kicks/Kick 808 Long.wav',wav(1.5)],['Drums/Kicks/Kick Punchy.wav',wav(.25)],['Drums/Snares/Snare Crack.aif',aiff(22050)],['Drums/Hats/Closed Hat.wav',wav(.1)],['Drums/Hats/notes.txt',Buffer.from('not audio')],['Drums/.hidden/Kick Secret.wav',wav(.2)],['Ableton Folder Info/Previews/Kick Preset.adv.ogg',Buffer.from('OggS')],['Loops/90 BPM Break.wav',wav(2.667)],['Kick/A kick.wav',wav(.1)],['Other/Kick 2.wav',wav(.2)],['Other/kick 10.WAVE',wav(.3)],['Other/Kïck 3.flac',Buffer.from('fLaC')],['Bad.wav',wav(.1).subarray(0,29)]];
try{for(const [name,bytes]of files){mkdirSync(join(root,name,'..'),{recursive:true});writeFileSync(join(root,name),bytes);}symlinkSync(root,join(root,'Drums','loop'),'dir');
const cases=[];for(const [words,limit]of [[['KICK'],20],[['drums','snare'],10],[[],50],[['break'],1],[['  kick\uFEFF',''],2],[['no-match'],10],[[],0]]){const value=await findSamples({folders:[join(root,'Nowhere'),root],words,limit});cases.push({words,limit,value:JSON.parse(JSON.stringify(value).replaceAll(root,'$ROOT'))});}
const names=['Kick 2','kick 10','Kïck 3','kick 01','KICK 1','kick-2','kick_2','808 7','808 12','Écho','echo','Ö','o','α2','α12','中文2','中文10'];const pairs=names.flatMap(a=>names.map(b=>Math.sign(a.localeCompare(b,undefined,{numeric:true,sensitivity:'base'}))));
writeFileSync(new URL('./samples-oracle.json',import.meta.url),JSON.stringify({files:files.map(([name,bytes])=>({name,hex:bytes.toString('hex')})),cases,headers,collation:{names,pairs}},null,2)+'\n');
}finally{rmSync(root,{recursive:true,force:true});}
