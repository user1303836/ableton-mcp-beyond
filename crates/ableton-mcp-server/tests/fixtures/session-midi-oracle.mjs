// Regenerate with TS_REFERENCE_ROOT pointing at a checkout with its TypeScript build.
import {writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=process.env.TS_REFERENCE_ROOT??fileURLToPath(new URL('../../../..',import.meta.url));
const {DeterministicLiveSimulator}=await import(pathToFileURL(resolve(root,'apps/mcp-server/dist/src/live.js')));
const {SessionMidiTransactionManager,discoverSession}=await import(pathToFileURL(resolve(root,'apps/mcp-server/dist/src/transactions/session-midi.js')));
function simulator(){const s=new DeterministicLiveSimulator();for(let index=1;index<=3;index++){s.state.scenes.push({ref:`scene:scene-${index+1}`,objectIdentity:`simulator:scene:scene-${index+1}`,name:`Scene ${index+1}`,index});s.state.tracks[0].clipSlots.push({ref:`clip-slot:track-1:${index}`,parentRef:s.state.tracks[0].ref,objectIdentity:`simulator:clip-slot:track-1:${index}`,sceneIndex:index,clipRef:null,empty:true});}return s;}
const base={trackRef:'track:track-1',sceneIndex:1,name:'Bounded Beat',length:4,notes:[{pitch:36,start:0,duration:.25,velocity:100,channel:1}]};
const rows=[];
function add(name,input){let request=structuredClone(input);const row={name,input:structuredClone(input)};const m=new SessionMidiTransactionManager(simulator());try{const result=m.preview(request);delete result.transactionId;delete result.expiresAt;row.result=result;}catch(e){row.error={name:e.name,message:e.message};}row.mutated=request;rows.push(row);}
add('base',base);
for(const field of ['trackRef','sceneIndex','name','length','notes'])for(const value of [undefined,null,false,0,-1,1,1.5,4,1024,1025,100000,100001,'', 'x', [],{}]){const request={...base,[field]:value};if(value===undefined)delete request[field];add(`${field}:${JSON.stringify(value)}`,request);}
for(const field of ['pitch','start','duration','velocity','channel','mute','probability','velocityDeviation','releaseVelocity'])for(const value of [undefined,null,false,true,-128,-127,-1,0,.5,1,16,127,128,'x',[],{}]){const note={...base.notes[0],[field]:value};if(value===undefined)delete note[field];add(`note.${field}:${JSON.stringify(value)}`,{...base,notes:[note]});}
for(const value of [null, false, true,0,1,'x',[],[1]])add(`note primitive:${JSON.stringify(value)}`,{...base,notes:[value]});
for(const name of ['🎶'.repeat(128),'🎶'.repeat(129)])add(`name UTF16 ${name.length}`,{...base,name});
add('extra fields',{...base,extra:'preserve',notes:[{...base.notes[0],extra:'preserve'}]});
const pages=[];for(const kind of ['track','scene','clip','note','unknown'])for(const limit of [0,1,2,100,101,1.5])for(const cursor of [undefined,'','bad','MQ','MS45','LTE','NQ','!KzE=']){const row={kind,limit,...(cursor!==undefined?{cursor}:{})};try{row.result=discoverSession(simulator(),kind,limit,cursor);}catch(e){row.error=e.message;}pages.push(row);}
writeFileSync(new URL('./session-midi-oracle.json',import.meta.url),JSON.stringify({rows,pages})+'\n');
console.log(JSON.stringify({rows:rows.length,pages:pages.length}));
