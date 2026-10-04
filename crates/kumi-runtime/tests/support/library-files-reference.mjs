// Regenerate after building the TypeScript runtime.
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gzipSync} from 'node:zlib';
import {readSet,deviceName,timeSignature} from '../../../../packages/runtime/dist/src/library/sets.js';
import {readLivePreset,readMaxDevice,pluginPresetFacts} from '../../../../packages/runtime/dist/src/library/presets.js';
import {liveSet,livePreset,liveRack,maxDevice} from '../../../../packages/runtime/dist/test/fixtures/library.js';
const root=mkdtempSync(join(tmpdir(),'kumi-library-reference-'));
const cases=[];
async function add(name,body,kind='set') {const path=join(root,name);writeFileSync(path,body);let expected,error;try{expected=await (kind==='set'?readSet(path):kind==='max'?readMaxDevice(path):readLivePreset(path));}catch(e){error=e.message;}cases.push({name,body:body.toString('base64'),kind,...(expected?{expected}:{error})});}
try {
 await add('Song.als',liveSet({tempo:87.5,root:2,scale:2,scenes:3,tracks:[{kind:'AudioTrack',name:'Gtr',color:3,devices:['<AudioEffectGroupDevice Id="1"><UserName Value="Amp Chain" /><Branches><AudioEffectBranch><DeviceChain><AudioToAudioDeviceChain><Devices><Amp Id="0" /><Cabinet Id="1" /></Devices></AudioToAudioDeviceChain></DeviceChain></AudioEffectBranch></Branches></AudioEffectGroupDevice>'],session:2,samples:['/x/a.wav','/x/b.wav']}]}));
 const vocal=(name,id)=>({kind:'AudioTrack',name,id,color:17,devices:['Eq8','Compressor2','Reverb'],session:1,samples:['/producer/vox.wav']});
 await add('Night Drive.als',liveSet({tempo:124,root:9,scale:1,main:['GlueCompressor','Limiter'],tracks:[{kind:'GroupTrack',name:'Drums',id:12,color:14},{kind:'MidiTrack',name:'Kick',id:13,group:12,color:14,devices:['DrumGroupDevice','DrumBuss'],arrangement:[[0,64],[64,128]]},{kind:'MidiTrack',name:'Reese Bass',id:14,color:24,devices:['plugin:Serum','Saturator','Eq8']},vocal('Lead Vox',15),vocal('Vox Double',16),{kind:'ReturnTrack',name:'A-Reverb',id:2,devices:['Hybrid']},{kind:'ReturnTrack',name:'B-Delay',id:3,devices:['Echo']}]}));
 await add('Sunrise.als',liveSet({tempo:126,root:0,scale:1,main:['GlueCompressor','Limiter'],tracks:[{kind:'MidiTrack',name:'Sub Bass',id:1,color:24,devices:['Operator','Saturator','Eq8']},vocal('Vocals',2),vocal('Adlibs',3),{kind:'ReturnTrack',name:'A-Verb',id:4,devices:['Reverb']},{kind:'ReturnTrack',name:'B-Echo',id:5,devices:['Echo']}]}));
 await add('New.als',liveSet({tempo:120,root:0,scale:0,tracks:[]}));
 const au='<AuPluginDevice><UserName Value="Warm Pad"/><PluginDesc><AuPluginInfo><Name Value="Alchemy"/><Manufacturer Value="Apple"/><ComponentType Value="1635085685"/></AuPluginInfo></PluginDesc></AuPluginDevice>';
 const vst='<PluginDevice><PluginDesc><VstPluginInfo><PlugName Value="Old Synth"/></VstPluginInfo></PluginDesc></PluginDevice>';
 const max='<MxDeviceMidiEffect><UserName Value="Steps"/><FileRef><Path Value="C:\\Devices\\Euclidean.amxd"/></FileRef></MxDeviceMidiEffect>';
 await add('Plugins.ALS',liveSet({tempo:101.257,root:6,scale:14,tracks:[{kind:'MidiTrack',name:'Keys',devices:[au,vst,max,'NewFutureEffect22'],arrangement:[[0,27.129]]}]}));
 await add('Not a set.als',Buffer.from('plain text'));
 await add('Plain.adv',livePreset('Eq8'),'preset');
 await add('Rolling Bass.adv',livePreset('InstrumentVector','Dark bass for rollers'),'preset');
 await add('Vox Chain.adg',liveRack('AudioEffectGroupDevice',['Eq8','Compressor2','Reverb']),'preset');
 await add('Tight Kit.adg',liveRack('DrumGroupDevice',['OriginalSimpler']),'preset');
 await add('Plugin.adv',gzipSync(`<Ableton>${au}</Ableton>`),'preset');
 await add('Max.adv',livePreset('MxDeviceInstrument','A'.repeat(240)),'preset');
 await add('Empty.adv',Buffer.from('<NotLive/>'),'preset');
 for(const kind of ['instrument','audio_effect','midi_effect'])await add(`${kind}.amxd`,maxDevice(kind),'max');
 await add('notmax.amxd',Buffer.from('short'),'max');
 const names=['OriginalSimpler','AutoFilter2','FrequencyShifter','MxDeviceFooBar2','NewEffect22','MxThing','MidiFuture'];
 const signatures=[-1,0,98,99,201,203,299,302,693,1.5].map(value=>({value,expected:timeSignature(value)??null}));
 const pluginPaths=['Maker/Plugin/Bank/Preset.fxp','Plugin/Preset.vstpreset','Preset.aupreset','Maker\\Plugin\\Preset.fxb','//Maker//Plugin///Preset.fxp'];
 writeFileSync(new URL('library-files-oracle.json',import.meta.url),JSON.stringify({cases,names:names.map(tag=>({tag,name:deviceName(tag)})),signatures,pluginPaths:pluginPaths.map(path=>({path,expected:pluginPresetFacts(path)}))})+'\n');
} finally {rmSync(root,{recursive:true,force:true});}
