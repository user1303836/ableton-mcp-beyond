// Recreate with: node screens.mjs /path/to/apps/kumi/dist
import {pathToFileURL} from 'node:url';
import {writeFileSync} from 'node:fs';
import {PassThrough,Writable} from 'node:stream';
const root=process.argv[2];
const {TuiApp}=await import(pathToFileURL(`${root}/src/tui/app.js`));
const {VirtualTerminal}=await import(pathToFileURL(`${root}/test/vt.js`));
const connect=[{type:'connection',state:'connected'},{type:'observation',label:'Current open Set: Night Drive — Remote Script · real-live'}];
const change=(more)=>({type:'change',change:{id:'c1',family:'device',title:'Changed the bass',state:'applied',at:1,...more}});
const scenarios=[
 {name:'welcome',events:connect},
 {name:'notices',events:[...connect,...['  space stays  ',' first \n\n next  ','Unicode 主旋律 🎹 é','private-token hidden'].map(message=>({type:'notice',message}))]},
 {name:'focus',events:[...connect,{type:'focus',focus:{track:{name:'Bass',color:'#f59a3c',kind:'midi'},device:'Operator',detail:'Device',view:'Session',parameter:{name:'Filter Freq',value:'1.20 kHz',owner:'Operator'}}}]},
 {name:'changes',events:[...connect,change({from:0.8,to:0.4,range:[0,1]}),change({id:'c2',family:'tempo',title:'Tempo 120 → 124 BPM'})]},
 {name:'colors',events:[...connect,change({colors:{from:'#3c3c3c',to:'#e553a0'}})]},
 {name:'devices',events:[...connect,change({devices:{devices:['Arpeggiator','Operator','Reverb','Echo','Utility'],index:2}})]},
 {name:'notes',events:[...connect,change({family:'clip',clip:{length:4,notes:[60,64,67].map(pitch=>({pitch,start:0,duration:4,velocity:96}))}})]},
 {name:'memory',events:[...connect,{type:'remembered',scope:'producer',note:{id:'p1',text:'Prefers short reverbs',at:1}},{type:'recipe',action:'saved',name:'Drum bus',steps:3},{type:'technique',action:'kept',technique:{id:'t1',name:'Neuro from a Reese',fits:'gritty neuro basses'}}]},
 {name:'spectrum',events:[...connect,{type:'heard',file:'ref.wav',summary:'−8.4 LUFS · 128 BPM · F minor',bands:[-8,-5,-7,-9,-10,-12,-13,-16,-18,-22]}]},
 {name:'comparison',events:[...connect,{type:'heard',file:'mix.wav',summary:'−12.1 LUFS',bands:[-8,-5,-7,-6,-10,-12,-15,-17,-19,-22],compared:{reference:'ref.wav',summary:'−8.4 LUFS',differences:[0.2,0.4,-0.3,2.8,0,-1.1,-2,-1.5,-0.8,0.5],headlines:['low mids +2.8 dB']}}]},
 {name:'answer',events:[...connect,{type:'text',text:'**Bass** has:\n- EQ Eight\n- Compressor with `attack 12 ms`'},{type:'tool-start',id:'t',name:'live_discover'},{type:'tool-end',id:'t',name:'live_discover',isError:false,elapsedMs:300},{type:'turn-complete',result:{stopReason:'completed'},elapsedMs:3100}]},
 {name:'web',events:[...connect,{type:'web',action:'searched',title:'erbe-verb design',where:'web',via:'Exa',results:8},{type:'web',action:'read',title:'Building the Erbe-Verb private-token',url:'https://forum.audulus.com/uploads/erbe.pdf',kind:'a PDF',via:'Exa'}]},
 {name:'watched',events:[...connect,{type:'watched',title:'A video',channel:'Au5',url:'https://example.test/video',duration:81,from:0,to:81,chapters:[],words:'transcribed',lines:6,frames:[],notes:['private-token in note']}]},
 {name:'narrow-undo',events:[...connect,change({state:'kept',note:'Changed in Live since; left as it is.'}),change({id:'c2',state:'expired',title:'Previous change'})]},
 {name:'disconnected',events:[...connect,{type:'connection',state:'disconnected'},{type:'notice',message:'Live closed. Kumi will pick up where you left off when it is back.'}]},
];
const cases=[];
for(const [width,height] of [[23,7],[80,24],[120,16],[120,36],[160,40]])for(const scene of scenarios){
 const input=Object.assign(new PassThrough(),{isTTY:true,isRaw:false,setRawMode(v){this.isRaw=v;}});let written='';
 const output=Object.assign(new Writable({write(chunk,_,done){written+=chunk;done();}}),{isTTY:true,columns:width,rows:height});
 const controller={async start(){},async submit(){},async close(){},status(){return{state:'idle',connection:'connected',turns:0,maxTurns:30}}};
 const app=new TuiApp({controller,input,output,mode:'live',secrets:['private-token'],icons:'glyphs',colorDepth:'truecolor',frameMs:1,closeTimeoutMs:100});
 void app.run();await new Promise(resolve=>setTimeout(resolve,5));
 for(const event of scene.events)app.handleEvent(event);app.flush();const vt=new VirtualTerminal(width,height);vt.write(written);
 cases.push({name:scene.name,width,height,events:scene.events,expected:vt.lines()});await app.close();
}
writeFileSync(new URL('./screens.json',import.meta.url),JSON.stringify(cases));
