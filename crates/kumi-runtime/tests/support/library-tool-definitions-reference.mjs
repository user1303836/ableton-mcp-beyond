import{writeFileSync}from'node:fs';
import{libraryTools}from'../../../../packages/runtime/dist/src/library/tools.js';
import{manualTool}from'../../../../packages/runtime/dist/src/library/manual.js';
const definitions=[...libraryTools({},{}),manualTool({dir:'/unused'})].map(({name,description,inputSchema})=>({name,description,inputSchema}));
writeFileSync(new URL('../../src/library/tool-definitions.json',import.meta.url),JSON.stringify(definitions,null,2)+'\n');
