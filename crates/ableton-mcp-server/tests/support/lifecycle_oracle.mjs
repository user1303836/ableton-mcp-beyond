// Runs the unmodified TypeScript lifecycle with its source test fixtures. Only
// filesystem identities and policy-specific digests are normalized for Rust.
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import ts from 'typescript';
const root=process.cwd();
let source=fs.readFileSync('apps/mcp-server/test/lifecycle.test.ts','utf8').split('test("lifecycle plan is')[0];
source=source.replaceAll('"../src/delivery.js"',JSON.stringify(pathToFileURL(path.join(root,'apps/mcp-server/dist/src/delivery.js')).href))
 .replaceAll('"../src/live.js"',JSON.stringify(pathToFileURL(path.join(root,'apps/mcp-server/dist/src/live.js')).href))
 .replaceAll('"../src/lifecycle.js"',JSON.stringify(pathToFileURL(path.join(root,'apps/mcp-server/dist/src/lifecycle.js')).href))
 .replace('new URL("../../../../LICENSE.md", import.meta.url)',JSON.stringify(path.join(root,'LICENSE.md')));
source+=`
const root=mkdtempSync(join(tmpdir(),"lifecycle-oracle-"));
const rows=[];
try {
 const first=fixturePackage(root,"1.0.0","1.0.0");
 const options=await withPorts(lifecycleOptions(root,first,"install"));
 const record=async(label,options)=>rows.push({label,result:await runLifecycle(options)});
 await record("plan",{...options,apply:false,confirmLiveStopped:false});
 await record("install",options);
 await record("status",{...options,action:"status"});
 await record("repair-noop",{...options,action:"repair"});
 const second=fixturePackage(root,"1.1.0","1.1.0");
 await record("upgrade",{...options,action:"upgrade",packageRoot:second,...artifactOptions(second)});
 await record("rollback",{...options,action:"rollback"});
 await record("uninstall",{...options,action:"uninstall"});
 await record("uninstall-again",{...options,action:"uninstall"});
} finally {rmSync(root,{recursive:true,force:true});}
function normalize(value){if(typeof value==='string')return value.replaceAll(root,'<root>').replace(/^[a-f0-9]{64}$/,'<sha256>').replace(/^[a-f0-9]{40}$/,'<commit>').replace(/-\\d+-\\d+-\\d+$/g,'-<id>');if(Array.isArray(value))return value.map(normalize);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,normalize(v)]));return value;}
export default normalize(rows);
`;
const code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
const {default:rows}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
fs.writeFileSync('crates/ableton-mcp-server/tests/support/lifecycle_oracle.json',JSON.stringify(rows,null,2)+'\n');
console.log(`${rows.length} lifecycle results`);
