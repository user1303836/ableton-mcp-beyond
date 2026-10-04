import{readFileSync,writeFileSync,unlinkSync}from'node:fs';
const original=new URL('../../../../packages/runtime/dist/src/integrations/ableton/index.js',import.meta.url),file=new URL('index.remember-oracle.js',original);const marker='    return {\n        async start(signal) {\n            if (closed || started)';const source=readFileSync(original,'utf8');if(!source.includes(marker))throw Error('source hook changed');
writeFileSync(file,source.replace(marker,`    tools=options.fixture.tools;available=options.fixture.available!==false;lost=options.fixture.lost===true;project=options.fixture.project;
    return{_path:projectPath,_export:exportPages,_save:saveNow,_catch:catchUp,_pending:()=>saving,_project:value=>project=value,_context:()=>catchUpContext,
        async start(signal){
            if(closed||started)`));
const wrap=value=>({content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value});
const current={identity:'song',name:'Set',path:'/saved.als'};
const baseline={version:1,path:'/saved.als',name:'Set',savedAt:Date.parse('2026-10-03T11:00:00Z'),artifactId:'a',pages:[{artifact:{id:'a'},page:{},records:[]}]};
const cases=[];
try{const{createAbletonIntegration}=await import(file.href);
 async function run(label,operation,config={}){
  const calls=[],storage=[],caught=[];let integration;let count=0;
  const tools={has:name=>!(config.missing??[]).includes(name),isValid:true,async call(name,args){calls.push({name,args:structuredClone(args)});if(config.throw===name)throw Error('upstream failed');if(config.replace)integration._project({...current});
   if(name==='live_project_info')return wrap(config.info??{path:'/saved.als',exists:true});
   if(name==='live_project_snapshot_diff'){if(config.diffError)throw Error('diff failed');return wrap(config.diff??{items:[]});}
   const index=args.cursor?Number(args.cursor):0;const page={artifact:{id:config.artifact??'b'},page:{...(index+1<(config.pages??1)?{nextCursor:String(index+1)}:{})},records:[]};count++;return wrap(page);
  },async close(){}};
  const store={async load(path){storage.push({op:'load',path});if(config.loadError)throw Error('load failed');return config.baseline;},async save(value){storage.push({op:'save',value:structuredClone(value)});if(config.saveError)throw Error('save failed');}};
  integration=createAbletonIntegration({onConnection(){},onCatchUp:value=>caught.push(value),now:()=>new Date('2026-10-03T12:00:00Z'),projectStore:config.noStore?undefined:store,fixture:{tools,project:config.project===null?undefined:config.project??current,available:config.available,lost:config.lost}});
  let value;try{
   if(operation==='path')value=await integration._path(new AbortController().signal);
   if(operation==='export')value=await integration._export(new AbortController().signal);
   if(operation==='save')value=await integration._save();
   if(operation==='twice')value=await Promise.all([integration._save(),integration._save()]);
   if(operation==='catch'){integration._catch('song','Set',config.afterReconnect??false);await integration._pending();value=integration._context();}
  }catch(error){value={error:error.message};}
  // No close: that deliberately queues another save. These private operations start no timers.
  cases.push({label,operation,config,calls,storage,caught,value:value??null});
 }
 for(const info of [{path:'/saved.als'},{path:'/saved.als',exists:false},{path:''},{path:4},{path:'x',exists:0},{}])await run('project-path','path',{info});
 for(const config of [{missing:['live_project_info']},{throw:'live_project_info'}])await run('project-path-unavailable','path',config);
 for(const pages of [1,2,63,64,65])await run('export-pages','export',{pages});
 for(const config of [{},{noStore:true},{available:false},{lost:true},{project:null},{project:{identity:'song',name:'Set'}},{missing:['live_project_snapshot_export']},{throw:'live_project_snapshot_export'},{replace:true},{pages:3},{saveError:true}])await run('save-current','save',config);
 await run('save-serialized','twice',{pages:2});
 for(const config of [{},{noStore:true},{project:null},{project:{identity:'other',path:'/saved.als',name:'Other'}},{missing:['live_project_info']},{missing:['live_project_snapshot_export']},{missing:['live_project_snapshot_diff']},{baseline},{baseline,artifact:'a'},{baseline,diffError:true},{baseline,diff:{items:[{type:'change',kind:'set',facets:['modified'],details:[{path:'/data/tempo',before:120,after:125}]}]}},{baseline,artifact:'a',afterReconnect:true},{baseline,loadError:true},{baseline,saveError:true},{throw:'live_project_snapshot_export'}])await run('catch-up','catch',config);
 writeFileSync(new URL('remember-oracle.json',import.meta.url),JSON.stringify({cases})+'\n');console.log(cases.length+' source remember traces');
}finally{unlinkSync(file)}
