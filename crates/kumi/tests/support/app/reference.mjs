// Recreate using the authoritative compiled checkout: node reference.mjs /path/to/apps/kumi/dist
import { pathToFileURL } from "node:url";
import { writeFileSync } from "node:fs";
const app = await import(pathToFileURL(`${process.argv[2]}/src/tui/app.js`));
const cases = [];
const add = (fn, ...args) => cases.push({fn, args, expected: app[fn](...args) ?? null});
for (const input of ["", "/", "/Users/me/x.wav", "/model", "/mod_EL", "/quit\n", "/model\u0085x", "/model\ufeffx", "hi"]) add("isCommand", input);
for (const color of [null, "", "bad", "#000000", "#3c3c3c", "#86e3b5", "#f59a3c", "#ffffff"]) add("chipColor", color ?? undefined);
const focus = {track:{name:"Keys"}, detail:"Device", device:"Operator", trackRef:"t", view:"Session",sceneIndex:0};
const focuses = [null, {}, focus, {...focus, detail:"Clip",clip:"",selectedNotes:2}, {...focus,sceneIndex:1}, {...focus,device:"Reverb"}, {...focus, detail:"Clip",slotRef:"s"}, {...focus,view:"Arrangement"}, {...focus,view:"Arrangement",detail:"Clip",slotRef:"s"}, {track:{name:"Keys"},scene:"Chorus"}, {...focus, parameter:{name:"Pan",owner:"Mixer"}}, {...focus, parameter:{name:"Frequency",value:"440 Hz",owner:"Operator"}}];
for(const f of focuses.filter(Boolean)) add("focusPath",f);
for(const before of focuses)for(const after of focuses)for(const was of [undefined,"device","session"])add("touchedNext",before,after,was);
for(const crumbs of [[],["Keys"],["Keys","Reverb"],["Keys","Instrument Rack","Pad Layer","Chorus-Ensemble","Rate"],["主旋律","é 🎹 melody","Rate"]])for(const width of [0,1,6,12,24,40])add("fitCrumbs",crumbs,width);
for(const label of ["Current open Set: Night Drive — Remote Script · real-live","Current open Set: A — B — Remote Script · real-live","Inference-only — No Live access","Current open Set:  — bridge","Current open Set: x\ny — bridge","Current open Set: x — bridge\n"])add("setNameFrom",label);
const base={id:"c1",family:"device",title:"Change",state:"applied",at:1};
const changes=[base,{...base,from:0.8,to:0.4,range:[0,1]}, {...base,from:-2,to:10,range:[0,1]}, {...base,from:0,to:1,range:[1,0]},
 {...base,colors:{from:"#3c3c3c",to:"#e553a0"}}, {...base,colors:{to:"#e553a0"}},
 ...[undefined,0,1,4,1.5].map(index=>({...base,devices:{devices:["Arpeggiator","Operator","Reverb","Echo","Utility"],index}})),
 ...[0,1,2].flatMap(chain=>[undefined,0,1].map(index=>({...base,devices:{rack:"Rack",chain,index,chains:[{name:"Wavetable",devices:["Wavetable"]},{name:"Operator",devices:["Operator","Reverb"]},{name:"Bells",devices:[]}]}}))),
 {...base,clip:{length:4,notes:[60,64,67].map(pitch=>({pitch,start:0,duration:4,velocity:96}))}},
 {...base,clip:{length:4,notes:[{pitch:72,start:0,duration:2,velocity:100},{pitch:60,start:2,duration:2,velocity:30}]}}
];
for(const change of changes)for(const width of [8,12,20,40,48])for(const depth of ["truecolor","256","16","none"])add("changePicture",change,width,depth);
for(const notes of [[60,64,67].map(pitch=>({pitch,start:0,duration:4,velocity:96})),Array.from({length:12},(_,i)=>({pitch:40+i*5,start:i/3,duration:0.2,velocity:i*10,selected:i===4})),[{pitch:60,start:-1,duration:0.01,velocity:64},{pitch:72,start:8,duration:1,velocity:63}]])for(const width of [8,12,32])for(const rows of [1,2,3])add("clipPicture",{length:4,notes},width,rows);
for(const afterReconnect of [undefined,true])for(const lines of [[],["A changed","B changed"]])for(const more of [0,4])add("catchUpText",{set:"Night Drive",lastSeenAt:1000,lines,more,afterReconnect},61000);
writeFileSync(new URL("./reference.json",import.meta.url),JSON.stringify(cases));
// Voice settings accept exactly lower-case language codes of two or three letters.
const names={};const display=new Intl.DisplayNames(["en"],{type:"language"});
for(let length=2;length<=3;length++)for(let value=0;value<26**length;value++){
 let n=value,code="";for(let i=0;i<length;i++){code=String.fromCharCode(97+n%26)+code;n=Math.floor(n/26);}
 const name=display.of(code);if(name!==code)names[code]=name;
}
writeFileSync(new URL("../../../src/tui/app/language-names.json",import.meta.url),JSON.stringify(names));
