import {writeFileSync} from 'node:fs';
import {CHANGES} from '../../../../packages/runtime/dist/src/integrations/ableton/changes.js';
import {MORE_CHANGES, setMeter} from '../../../../packages/runtime/dist/src/integrations/ableton/more-changes.js';
const tracks={'t1':{name:'Bass',color:'#c08040'},'7:track:2':{name:'Kick'},'empty':{name:'',color:''}};
const cases=[]; let meter=[4,4];
const add=(tool,preview={},input={},applied)=>{const kind=CHANGES.find(k=>k.tool===tool);cases.push({tool,preview,input,meter,...(applied===undefined?{}:{applied}),value:kind.summarize(preview,input,ref=>tracks[ref],applied)});};
for(const kind of CHANGES.filter(k=>!MORE_CHANGES.includes(k)))add(kind.tool);
const fields=[null,false,'',0,1,-1,0.33333,'  padded  ',[],{}];
for(const v of fields){
 add('set_tempo',{priorTempo:v,proposedTempo:123.12345});add('set_tempo',{priorTempo:140,proposedTempo:v});
 add('set_mixer',{trackRef:'t1',prior:{volume:.85},proposed:{volume:v,pan:v,mute:v,solo:v,cueVolume:v,sends:v}});
 add('rename',{target:{kind:'track',ref:'t1',currentName:v},proposedName:v},{name:'fallback',ref:'t1'});
 add('set_device_parameter',{device:{name:v,trackRef:'t1'},parameter:{name:v,currentValue:v,proposedValue:.6,min:0,max:1,displayValue:v}},{value:.3},{displayValue:'-6 dB'});
 add('load_device',{trackRef:'t1',chainName:'Chain',rackName:v,item:{name:v}},{},{placement:{devices:['Operator',v],index:v,chain:v,rack:v,chains:[{name:v,devices:[v,'Operator']}]}});
 add('set_track_color',{ref:'t1'},{},{color:v});
}
for(const parts of [{}, {volume:.5,pan:-.5,mute:true,solo:false,cueVolume:0,sends:[0,.5]}, {volume:.85,pan:0,mute:false,solo:true,sends:[.1]}, {volume:1,pan:1,sends:[.1,.2]}])for(const display of [false,true]){
 add('set_mixer',{trackRef:'t1',prior:{volume:.85},proposed:parts,...(display?{priorDisplay:{volume:' 0.0 dB ',pan:'Center',sends:['-inf dB','0.0 dB']}}:{})},{},display?{display:{volume:'-6.0 dB',pan:'50 L',sends:['-6.0 dB','0.0 dB']}}:{});
 for(const chainActivator of [true,false,null])add('set_chain_mixer',{rackName:' Rack ',chainName:'Ch 1',prior:{volume:.85},proposed:{...parts,chainActivator}});
}
for(const proposed of [[],[{kind:'track',trackKind:'audio',name:'Voice'}],[{kind:'track'}],[{kind:'scene',name:'Drop'}],[{kind:'track'},{kind:'track',trackKind:'audio'},{kind:'scene'}],[{kind:'unknown'},null]])add('add_tracks_and_scenes',{proposed});
for(const kind of ['clip','device','scene','track',null])add('rename',{target:{kind,ref:'t1',currentName:'Old'},proposedName:' New '});
for(const notes of [[],[{pitch:60,start:0,duration:1},{pitch:64,start:.25,duration:2,velocity:50}], [{pitch:60,start:0,duration:0},{pitch:'60',start:0,duration:1},null,{}, {pitch:-3,start:-1,duration:.5,velocity:0}],Array.from({length:520},(_,i)=>({pitch:i%128,start:i/4,duration:1}))])for(const length of [0,8,null])add('write_midi_clip',{target:{trackRef:'t1'},proposed:{name:' Tune ',length,notes}},{name:'Fallback',length:4,notes:[{pitch:42,start:0,duration:1}]});
for(const filePath of ['/a/Kick.wav','C:\\Drums\\Hat.v2.aif','/a/noext','/a/end.','.wav','/a/name.\n',null]){add('load_sample',{}, {trackRef:'t1',filePath});for(const note of [undefined,36,37.5,-1])add('load_sample_to_pad',{}, {filePath,note,instrument:'Drum Sampler'});}
for(const notes of [[],[36],[36,37,38],[36,40],[-1,.5],[36,null]])for(const drum of [true,false])add('load_samples_to_pads',{}, {pads:notes.map((note,i)=>({note,filePath:`/samples/Pad ${i}.wav`,...(drum?{instrument:'Drum Sampler'}:{})}))});
for(const action of ['insert-chain','randomize-macros','store-variation','recall-variation','delete-variation','set','copy-pad','add-macro','remove-macro'])for(const applied of [{},{visibleMacroCount:5},{placement:{rack:'Rack',chain:1,chains:[{name:'x',devices:['Operator']}]}}])add('edit_rack',{rackName:'Old Rack',prior:{visibleMacroCount:4}},{action,index:2,sourceIndex:36,targetIndex:42},applied);
for(const parameters of [[],[{ref:'p',name:'Drive',currentValue:0,proposedValue:1,displayValue:'0.0 dB'}],[{ref:'a',name:'Cutoff',currentValue:800,proposedValue:800},{ref:'b',name:'Resonance',currentValue:0,proposedValue:1}], [null,{name:'Old',currentValue:1,proposedValue:0},{ref:'p',name:'Name',displayValue:'  old  '}]] )for(const tool of ['set_device_parameter','set_device_parameters'])add(tool,{device:{name:' Filter ',trackRef:'t1'},parameters},{values:[{},{}]},{parameters:[{ref:'p',displayValue:'wrong'},{ref:'p',displayValue:'-6.0 dB'},{displayValue:' New '}]});
for(const color of [-1,0,16777215,16777216,1.5,123456])add('set_track_color',{}, {ref:'t1'},{color});
for(const input of [{},{start:0,end:32,startName:'Intro',endName:'Drop'}, {start:1.005,end:1.99999}, {startName:'x'.repeat(100),endName:'　'}])add('set_locators',{},input);
for(const deviceRef of ['7:device:2','7:device:2:chain:1','bad',null])for(const action of ['sidechain','routing'])add('set_sidechain',{}, {deviceRef,action,routingType:'Kick'});
const rich = { trackRef:'7:track:2', clipRef:'7:clip:2:1', deviceRef:'7:device:2:1', ref:'7:device:2:1', targetTrackRef:'t1',
    loopEnabled:true,loopStart:4,loopLength:8,loopEnd:16,metronome:true,punchIn:false,punchOut:true,position:10,
    inputType:' Kick ',inputSubRouting:'Post FX',outputType:'Main',outputSubRouting:'Stereo',arm:true,monitoring:'auto',
    trackActivator:false,crossfadeAssign:2,panningMode:1,crossfader:.3,kind:'macro-name',macroIndex:2,mappingIndex:4,
    minimum:0,maximum:100,fadeMinimum:4,fadeMaximum:80,muted:true,looping:true,launchMode:2,launchQuantization:1,colorIndex:6,
    legato:true,velocityAmount:.635,ramMode:false,pitchCoarse:5,pitchFine:-2,gain:.5,warping:false,warpMode:6,fadeInLength:1,
    arrangementPosition:8,targetSceneIndex:2,source:'7:clip:2:1',length:8,name:'Rich',action:'set',setting:'sample.slice_mode',
    notes:[{pitch:60,start:0,duration:1,velocity:100},{}],noteIds:[1,2],grid:1,transform:'transpose',params:{semitones:-12},
    points:[{},{}],tempo:125.005,tempoEnabled:true,signatureNumerator:7,signatureDenominator:8,swingAmount:.335,
    clipTriggerQuantization:1,midiRecordingQuantization:4,enabled:true,index:-1,mute:true,solo:false,autoColor:true,
    rootNote:1,scaleName:'  Minor  ',grooveAmount:1.25,filePath:'/samples/Kick.wav',sceneIndex:1,fromBeat:4,toBeat:32,start:4};
for(meter of [[4,4],[7,8],[3,4]]) {
 setMeter(...meter);
 for(const kind of MORE_CHANGES){
   add(kind.tool); add(kind.tool,{},rich); add(kind.tool,{...rich,proposed:rich,prior:{...rich,loop:{start:0,length:4,enabled:false},loopStart:0,loopEnd:8,looping:false,signatureNumerator:4,signatureDenominator:4,swingAmount:0},destination:rich,payload:rich,target:rich,device:rich,clip:rich,scene:rich,track:{...rich,alsoDeletes:[{},{}]},locator:rich,diff:{add:1,update:2,delete:3},removes:[{}],cuts:[{},{}]},rich,{partial:{made:1,of:2}});
 }
 for(const input of [{},{loopStart:null},{loopEnabled:true},{loopEnabled:false},{loopStart:4,loopLength:8},{metronome:false,punchIn:true,punchOut:false,position:0}])add('set_transport',{prior:{loop:{enabled:true,start:0,length:16}},proposed:input});
 for(const action of ['quantize','quantize-pitch','select','delete-range','duplicate','crop','duplicate-loop','duplicate-region','insert','insert-step','create-envelope','delete-envelope','create-return','delete-return','duplicate-track','modulate','slice-clear','set-amount','add','delete'])for(const tool of ['edit_notes','edit_clip','set_automation','change_structure','edit_device','set_groove','set_warp_markers'])add(tool,{prior:{length:4},notes:3},{...rich,action});
 for(const kind of ['key-zone','velocity-zone','selector-zone','macro-name','variation-name','macro-mapping', ['key-zone']])for(const mappingIndex of [null,0,.5,'2'])add('edit_rack_mapping',{proposed:{minimum:4,fadeMaximum:64}},{...rich,kind,mappingIndex,name:{name:'object'}});
 for(const n of [-1,0,.5,1,3,4,6,12,null,'1']){
   add('set_clip',{prior:{loopStart:2,loopEnd:6,looping:true},proposed:{launchMode:n,velocityAmount:n,looping:true,loopStart:n}},{clipRef:rich.clipRef});
   add('set_audio_clip',{proposed:{pitchCoarse:n,pitchFine:n,warpMode:n}},{...rich,gain:null});
   add('set_mixer_options',{proposed:{crossfadeAssign:n,panningMode:n}},rich);
   add('set_scale',{}, {rootNote:n,scaleName:'　Dorian\tMode　'});
   add('set_song',{prior:{signatureNumerator:null,signatureDenominator:'a',swingAmount:n},proposed:{signatureNumerator:n,swingAmount:n}});
   add('set_scene',{proposed:{tempo:n,tempoEnabled:n,signatureNumerator:3,signatureDenominator:4}});
   add('move_device',{}, {...rich,index:n});
 }
 for(const ref of ['7:track:2','7:clip:2:0','7:arrangement_clip:2','7:device:2:0','7:chain:2:1','7:clip_slot:2:0','7:slot:2','7:drum_pad:2:36','7:clip:22','7:clip:2x','7:track:2x','7:device:2x',null])add('set_device_details',{}, {deviceRef:ref});
 for(const clips of [[],[rich],[rich,{...rich,trackRef:'t1'}],[null,{notes:[{},{}]}],[{trackRef:'t1',notes:[{pitch:40,start:0,duration:0},{pitch:42,start:0,duration:1}],length:4}], [{notes:Array.from({length:520},(_,i)=>({pitch:i%128,start:i/4,duration:1})),length:32,start:8}]])for(const partial of [{},{made:0,of:2},{made:1,of:1},{made:'1',of:2}])add('write_arrangement_clip',{}, {clips},{partial});
}
const values=[], indexed=new Map();
const ref=value=>{const key=JSON.stringify(value);if(!indexed.has(key)){indexed.set(key,values.length);values.push(value);}return indexed.get(key);};
const compact=cases.map(({tool,...fields})=>({tool,...Object.fromEntries(Object.entries(fields).map(([key,value])=>[key,ref(value)]))}));
writeFileSync(new URL('./change-summaries-oracle.json',import.meta.url),JSON.stringify({tracks,values,cases:compact})+'\n');
writeFileSync(new URL('../../src/integrations/ableton/more-change-tools.json',import.meta.url),JSON.stringify(MORE_CHANGES.map(k=>k.tool))+'\n');
