// Run with the compiled authoritative TypeScript checkout as argv[2].
import { pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';
const {Transcript,stepLabel,doingLabel,pictureRows}=await import(pathToFileURL(`${process.argv[2]}/apps/kumi/dist/src/tui/transcript.js`));
const pic={width:4,height:2,rgb:Array.from({length:24},(_,i)=>(i*39)%256)};
const step=(label,endedAt,more={})=>({id:label+endedAt,label,state:'done',ms:300,...(endedAt===undefined?{}:{endedAt}),...more});
const entries=[
 {kind:'user',text:'主旋律 👨‍👩‍👧‍👦 é hello\nsecond line'}, {kind:'notice',text:'note about the new bridge',tone:'info'}, {kind:'notice',text:'Careful\nnow',tone:'warn'}, {kind:'divider',text:'another conversation'},
 ...['note','technique','recipe','lesson'].map(what=>({kind:'memory',what,text:'kept this way of working in a long sentence'})),
 {kind:'assistant',text:'# Result\n**strong** and `code`\n\n```py\na = 2\n```\n',steps:[],status:'done'},
 {kind:'assistant',text:'',steps:[],status:'failed'}, {kind:'assistant',text:'Partial',steps:[],status:'stopped'},
 {kind:'assistant',text:'Done.',steps:[step('looked at your Set'),step('looked at your Set'),step('made changes')],status:'done',elapsedMs:2500},
 {kind:'assistant',text:'',steps:[step('read a page',100),step('read a page',undefined,{state:'running',tool:'read_web',startedAt:200,doing:'reading section 2'})],status:'running',startedAt:0},
 {kind:'heard',file:'Kick.aif',summary:'wide and bright',bands:[-60,-50,-40,-30,-20,-10,0,10,20,30]},
 {kind:'heard',file:'Kick.aif',summary:'balance',bands:[],compared:{reference:'Ref.wav',summary:'close',differences:[0,0.1,-0.1,1.5,-1.5,2.55,100,0,-9.95,2]}},
 {kind:'auditioned',round:2,best:{label:'best',score:71},previous:58,takes:[{label:'one',score:50},{label:'two',silent:true},{label:'three'}],gaps:['brighter top','faster attack']},
 {kind:'auditioned',round:3,best:{label:'best',score:40},previous:58,takes:[],gaps:[]},
 {kind:'auditioned',round:1,takes:[{label:'one',silent:true}],gaps:[]},
 {kind:'web',lines:[{lead:'Searched the web for',title:'“Live chains”',detail:'8 results'},{lead:'Read',title:'Manual',detail:''}]},
 ...[true,false].map(pictures=>({kind:'watched',title:'Mix',channel:'Maker',duration:4000,from:0,to:4000,chapters:['Start','Finish'],words:'captions',frames:Array.from({length:10},(_,i)=>({at:i*400,thumb:pic,...(i===2?{zoom:'detail'}:{})})),sound:{from:1,to:70},notes:['quiet in places'],pictures})),
 {kind:'watched',title:'Short',from:1,to:2,chapters:[],words:'none',frames:[],notes:[],pictures:false}
];
const cases=[];
for(const entry of entries)for(const width of [12,24,60]){const t=new Transcript();t.add(structuredClone(entry));cases.push({entry,width,now:10000,rows:t.rows(width,10000)});}
const folding=[];const t=new Transcript();const original={kind:'assistant',text:'',status:'running',startedAt:0,steps:[step('searched the web',900),step('read a page',1000),step('read a page',1100),step('read a page',1200),step('made a device',1300,{state:'error'}),step('made a device',1400)]};t.add(structuredClone(original));
for(const now of [1300,4199,4200,4300,4420,4490,4601,6000]){const before=t.changeAt(now);const rows=t.rows(60,now);folding.push({now,before,rows,after:t.changeAt(now),laidOut:t.laidOut,steps:t.entries[0].steps});}
const pictures=[1,2,5,12].map(cells=>({picture:pic,cells,rows:pictureRows(pic,cells)}));
writeFileSync(new URL('./reference.json',import.meta.url),JSON.stringify({cases,original,folding,pictures,labels:['read_web','live_status','watch_video','make_device','live_unknown_action','new_tool',''].map(tool=>({tool,label:stepLabel(tool),doing:doingLabel(tool,'fallback')}))}));
