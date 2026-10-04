import{readFileSync,writeFileSync,unlinkSync}from'node:fs';
const original=new URL('../../../../packages/runtime/dist/src/integrations/ableton/index.js',import.meta.url);const instrumented=new URL('index.refs-oracle.js',original);
const source=readFileSync(original,'utf8');const marker='    const keepLooking = () => {';if(!source.includes(marker))throw Error('source hook changed');
writeFileSync(instrumented,source.replace(marker,'    return { registerRows, validateParentAndCursor, shortRef, shorten, lengthen, requireFreshReferences, invalidate, refs, cursors, known, slimMixers, encode };\n'+marker));
try{
 const{createAbletonIntegration,BRIDGE_TOOLS}=await import(instrumented.href);const book=createAbletonIntegration({onConnection(){},generation:'connection',now:()=>new Date('2026-10-03T12:00:00.000Z')});const cases=[];
 function op(method,...args){let value;try{value=book[method](...args)??null;}catch(error){value={error:error.message};}cases.push({method,args,value,refs:[...book.refs],cursors:[...book.cursors],known:[...book.known]});}
 op('registerRows','set',[{ref:'7:set:0'}],{});
 op('registerRows','track',[{ref:'7:track:0',name:'Bass',color:123456},{ref:'7:track:1',name:'Kick',color:-1}],{});
 op('registerRows','device',[{ref:'7:device:0:0',chainList:[{ref:'7:chain:0:0:0'},null,{}, {ref:''}]}],{});
 op('registerRows','clip-slot',[{ref:'7:clip_slot:0:1',clipRef:'7:clip:0:1',parentRef:'7:track:0'},{ref:'',clipRef:'ignored'}],{kind:'clip-slot',parent:'7:track:0'},'next1');
 op('registerRows','clip-slot',[{ref:'7:clip_slot:0:1',clipRef:'7:clip:0:1',parentRef:'7:track:0'}],{kind:'clip-slot',parent:'7:track:0'},'next1');
 for(const kind of['set','track','device','chain','session-clip','clip-slot','parameter','note','unknown',null,{},['track']])for(const parent of[undefined,'7:set:0','7:track:0','7:device:0:0','7:clip_slot:0:1','7:clip:0:1','gone',null])op('validateParentAndCursor',{kind,...(parent===undefined?{}:{parent})});
 for(const args of[{kind:'clip-slot',parent:'7:track:0',cursor:'next1'},{kind:'clip-slot',parent:'7:track:0',cursor:'next1',fields:['name']},{kind:'clip-slot',parent:'7:track:0',cursor:0},{kind:'track',cursor:'nope'}])op('validateParentAndCursor',args);
 op('registerRows','clip-slot',[],{kind:'clip-slot',parent:'7:track:0',cursor:'next1'},'next1');
 for(const ref of['7:track:0','7:track:1','7:device:0:0','7:parameter:0:1','7:track:0','track:1','bad','12:lower_case:','0:x:whatever','-1:track:0','7:Track:0','7:'+ 'a'.repeat(33)+':0'])op('shortRef',ref);
 const value={ref:'7:track:0',parent:'7:set:0',trackRef:'7:track:1',parameterRefs:['7:parameter:0:1','7:parameter:0:2'],name:'7:track:0',refs:['7:track:0'],child:{selectedTrackRef:'7:track:0'},array:[{deviceRef:'7:device:0:0'}]};op('shorten',value);op('lengthen',book.shorten(value));
 for(let depth of[31,32,33,34]){let value={ref:'7:track:3'};for(let i=0;i<depth;i++)value={child:value};op('shorten',value);}
 for(const value of [{},{trackRef:'7:track:0'},{trackRef:'track:1'},{parameterRef:'gone'},{deviceRef:null},{values:[{deviceRef:'7:device:0:0'},{parameterRef:'gone'}]},{nested:{parameterRef:'gone'}},{array:[{array:[{array:[{parameterRef:'gone'}]}]}]}])op('requireFreshReferences',value);
 for(const value of[{items:[{ref:'7:track:0',mixer:{volume:.5,volumeRef:'7:parameter:1',pan:0,other:2,sends:[.4],volumeDisplay:'-6 dB'}}]},{items:[{mixer:['volume',3]},{mixer:false},{}]},{other:3}])op('slimMixers',value);
 for(const result of[{content:[{type:'text',text:'{"items":[{"ref":"7:track:0","mixer":{"volume":0.5,"volumeRef":"7:parameter:1"}}]}'}]},{content:[{type:'text',text:'bad'}]},{content:[],structuredContent:{trackRef:'7:track:1',name:'Bass'}},{content:[{type:'text',text:'error'}],isError:true}])for(const slim of[false,true])op('encode',result,7,slim);
 op('invalidate');op('lengthen',{ref:'track:1'});op('requireFreshReferences',{trackRef:'7:track:0'});op('shortRef','8:track:0');op('shortRef','7:track:0');
 op('registerRows','return-track',[{ref:'t',name:'🦀'.repeat(130),color:16777215}],{});
 for(const length of[0,256,258])op('registerRows','track',[{ref:'x'.repeat(length),name:'Name'}],{});
 op('registerRows','track',[{ref:'different-parent',parentRef:'wrong',name:'No'}],{parent:'t'});
 for(const parent of[null,0,false,{},[]])op('registerRows','track',[{ref:'parent-shape',parentRef:structuredClone(parent)}],{parent});
 writeFileSync(new URL('./references-oracle.json',import.meta.url),JSON.stringify({bridgeTools:BRIDGE_TOOLS,cases})+'\n');
}finally{unlinkSync(instrumented);}
