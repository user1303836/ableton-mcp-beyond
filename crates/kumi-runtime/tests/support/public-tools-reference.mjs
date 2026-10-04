import {readFileSync, writeFileSync, unlinkSync} from 'node:fs';
const original = new URL('../../../../packages/runtime/dist/src/integrations/ableton/index.js', import.meta.url);
const file = new URL('index.public-tools-oracle.js', original);
let source = readFileSync(original, 'utf8');
const marker = '    return {\n        async start(signal) {\n            if (closed || started)';
if (!source.includes(marker)) throw Error('source hook changed');
source = source.replace(marker, `    return {
      async _ready(){await tools.refresh(new AbortController().signal);currentEpoch=7;},
      _definitions:definitions,
      async start(signal){if(closed||started)`);
writeFileSync(file, source);
try {
  const {createAbletonIntegration, BRIDGE_TOOLS} = await import(file.href);
  const cases = [];
  async function run(config) {
    const catalog = (config.only ?? BRIDGE_TOOLS).filter(name => !(config.missing ?? []).includes(name)).map(name => ({name, ...(config.description ? {description: config.description} : {}), inputSchema: config.schemas?.[name] ?? {type:'object'}}));
    const endpoint = {pid:null, serverInfo:{name:'fixture',version:config.version??'1.0.73'},async list(){return {tools:catalog}}, async call(){throw Error('unexpected call')}, onCatalogChanged(){return()=>{}},onDisconnect(){return()=>{}},stderrStatus(){return{bytes:0,truncated:false}},async close(){}};
    const integration = createAbletonIntegration({connect:async()=>endpoint,onConnection(){},hands: config.hands===false ? false : async()=>undefined});
    await integration.start(new AbortController().signal);
    await integration._ready();
    const definitions = integration._definitions().map(({name,description,inputSchema,stream}) => ({name,description,inputSchema,stream:!!stream}));
    await integration.close();
    cases.push({config,catalog,definitions});
    return definitions;
  }
  const complete = await run({});
  writeFileSync(new URL('../../src/integrations/ableton/assets/public-tools.json',import.meta.url), JSON.stringify(Object.fromEntries(complete.filter(t=>['find_sounds','make_changes','watch_me','undo_change','undo_in_live','run_python'].includes(t.name)).map(t=>[t.name,{description:t.description,schema:t.inputSchema}]))));
  await run({only:[]});
  await run({hands:false});
  await run({description:''});
  for (const version of ['1.0.1','1.0.34','1.0.35','1.0.48','1.0.49','1.0.50','1.0.57','1.0.58','1.0.67','1.0.68','bad']) await run({version});
  for (const name of BRIDGE_TOOLS) await run({missing:[name]});
  for (const schema of [{type:'object'},{type:'object',properties:{parameters:{type:'array'},values:{type:'array'},action:{enum:['load-samples']},ref:{type:'string'}}}]) await run({schemas:Object.fromEntries(BRIDGE_TOOLS.map(name=>[name,schema]))});
  const pool=[], ids=new Map();const intern=value=>{const key=JSON.stringify(value);if(!ids.has(key)){ids.set(key,pool.length);pool.push(value)}return ids.get(key)};
  const compact=cases.map(c=>({...c,catalog:c.catalog.map(intern),definitions:c.definitions.map(intern)}));
  writeFileSync(new URL('public-tools-oracle.json',import.meta.url), JSON.stringify({pool,cases:compact}));
  process.stdout.write(`${cases.length} tool-catalog cases\n`);
} finally {unlinkSync(file)}
