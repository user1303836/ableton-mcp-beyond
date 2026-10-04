// Regenerate from the built TypeScript reference. Native default launch-shape tests live beside this oracle.
import { writeFileSync } from 'node:fs';
import { configForBridge, configForEntrypoint } from '../../../../apps/mcp-server/dist/src/delivery.js';
const cases=[];
function add(name,entrypoint,bridge,command='/usr/bin/node',configPath='/does-not-exist-kumi-port/bridge.json'){
 const row={name,entrypoint,bridge,command,configPath};
 try{row.result=configForBridge(entrypoint,bridge,command,configPath,false);}catch(error){row.error=error.message;}
 cases.push(row);
}
const base={host:'127.0.0.1',port:43210,secretFile:'/does-not-exist-kumi-port/secret',timeoutMs:5000};
add('base','/opt/cli.js',base);
for(const field of Object.keys(base))for(const value of [undefined,null,false,0,1,99,100,65535,65536,60000,60001,1.5,'','value',[],{}]){const bridge={...base,[field]:value};if(value===undefined)delete bridge[field];add(`${field}:${JSON.stringify(value)}`,'/opt/cli.js',bridge);}
for(const host of ['::1','localhost','127.0.0.2','127.999.0.1','0.0.0.0'])add(`host:${host}`,'/opt/cli.js',{...base,host});
for(const value of [null,false,0,1,43210,43211,65535,65536,1.5,'bad',{},[]])add(`realtime:${JSON.stringify(value)}`,'/opt/cli.js',{...base,realtimePort:value});
for(const diagnostics of [null,false,{},[],{path:'/x',maxBytes:1},{path:'/x',maxBytes:16777216},{path:'x',maxBytes:16777216},{path:'/x\0y',maxBytes:16777216},{path:4,maxBytes:16777216},{path:'/x',maxBytes:16777216,extra:true}])add(`diagnostics:${JSON.stringify(diagnostics)}`,'/opt/cli.js',{...base,diagnostics});
for(const entrypoint of ['relative','', '/opt/cli.js'])for(const command of ['', 'node', '/usr/bin/node'])add(`entrypoint:${entrypoint}:${command}`,entrypoint,base,command);
for(const configPath of ['', 'relative','/x\0y','/valid'])add(`config:${configPath}`,'/opt/cli.js',base,'node',configPath);
add('extra field','/opt/cli.js',{...base,inlineSecret:'forbidden'});
writeFileSync(new URL('./delivery-oracle.json',import.meta.url),JSON.stringify(cases)+'\n');
