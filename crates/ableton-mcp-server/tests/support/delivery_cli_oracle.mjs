// Parser oracle from the source entrypoints; delivery functions are unreachable for these invalid inputs.
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const cases = [[],['--unknown'],['--force','--force'],['--output'],['--output','--force'],['--output',''],['--output','x','--output','y'],['--config'],['--config',''],['--config','-x'],['--config','a','b'],['--input','--output','x'],['--input','a','--input','b'],['--input','a','--output','b','--bridge-host','127.0.0.1'],['--destination'],['--destination','--force'],['--destination','a','--destination','b'],['--bridge-port','-1'],['--timeout-ms','-1'],['--realtime-port','--force']];
const rows=[];
for (const name of ['setup','migrate','diagnostics','install-remote-script']) {
  const source=fs.readFileSync(`apps/mcp-server/src/${name}.ts`,'utf8').replace(/^import .*;$/gm,'').replace(/^#!.*$/m,'').replaceAll('import.meta.url', '"file:///fixture/cli.js"');
  const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText.replace(/export \{\};?/g,'');
  for(const args of cases) {
    // [] is a successful diagnostics request; this corpus only compares parser failures.
    if(name==='diagnostics'&&args.length===0) continue;
    const stdout=[],stderr=[]; const process={argv:['node','test',...args],exitCode:undefined,execPath:'/node',stdout:{write:v=>stdout.push(v)},stderr:{write:v=>stderr.push(v)}};
    await vm.runInNewContext(`(async()=>{${js}})()`,{process,console:{error:v=>stderr.push(v+'\n'),log:v=>stdout.push(v+'\n')},assertSupportedNodeRuntime(){}, resolve(){throw new Error('delivery reached');},fileURLToPath(){throw new Error('delivery reached');},URL,diagnosticsAsync(){throw new Error('delivery reached');}}).catch(()=>{});
    // Source computes install asset URL before validating; remove just its declaration for parser execution.
    if(name==='install-remote-script') {
      stdout.length=0;stderr.length=0;process.exitCode=undefined;
      await vm.runInNewContext(`(async()=>{${js.replace(/^const source = .*;$/m,'const source = "fixture";')}})()`,{process,console:{error:v=>stderr.push(v+'\n'),log:v=>stdout.push(v+'\n')},resolve(){throw new Error('delivery reached');}});
    }
    if(process.exitCode===2) rows.push({command:name,args,stdout:stdout.join(''),stderr:stderr.join(''),code:2});
  }
}
fs.writeFileSync('crates/ableton-mcp-server/tests/support/delivery_cli_oracle.json',JSON.stringify(rows,null,2)+'\n');
console.log(`${rows.length} parser cases`);
