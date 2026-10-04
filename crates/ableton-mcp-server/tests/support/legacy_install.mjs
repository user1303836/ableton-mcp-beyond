// Create the old installation with the unmodified TypeScript lifecycle, including its
// source fixture package/archive, receipt, config, secret, and managed Live assets.
import fs from 'node:fs';import path from 'node:path';import {pathToFileURL} from 'node:url';import {createRequire} from 'node:module';
const ts=createRequire(path.join(process.cwd(),'package.json'))('typescript');
const input=JSON.parse(process.argv[2]),root=process.cwd();
// Build only the reference dependency graph into this test's temporary tree. CI needs
// TypeScript from npm ci, but no checked-out dist files or separate reference build.
const reference=path.join(input.root,'source-reference');const packageRoot=path.join(reference,'apps/mcp-server');
fs.mkdirSync(packageRoot,{recursive:true});fs.copyFileSync('apps/mcp-server/package.json',path.join(packageRoot,'package.json'));
fs.mkdirSync(path.join(reference,'protocol'),{recursive:true});fs.copyFileSync('protocol/ableton-live-v1.operations.json',path.join(reference,'protocol/ableton-live-v1.operations.json'));
const compiled=new Set();
function compile(name){
 const sourcePath=path.resolve(root,'apps/mcp-server/src',name);if(compiled.has(sourcePath))return;compiled.add(sourcePath);
 const input=fs.readFileSync(sourcePath,'utf8');const code=ts.transpileModule(input,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
 const output=path.join(packageRoot,'dist/src',path.relative(path.join(root,'apps/mcp-server/src'),sourcePath).replace(/\.ts$/,'.js'));fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,code);
 for(const imported of ts.preProcessFile(code,true,true).importedFiles){if(imported.fileName.startsWith('.'))compile(path.relative(path.join(root,'apps/mcp-server/src'),path.resolve(path.dirname(sourcePath),imported.fileName.replace(/\.js$/,'.ts'))));}
}
for(const name of ['delivery','live','lifecycle'])compile(name+'.ts');
let source=fs.readFileSync('apps/mcp-server/test/lifecycle.test.ts','utf8').split('test("lifecycle plan is')[0];
for(const name of ['delivery','live','lifecycle'])source=source.replaceAll(`"../src/${name}.js"`,JSON.stringify(pathToFileURL(path.join(packageRoot,`dist/src/${name}.js`)).href));
source=source.replace('new URL("../../../../LICENSE.md", import.meta.url)',JSON.stringify(path.join(root,'LICENSE.md')));
source+=`
const input=${JSON.stringify(input)};
const packageRoot=fixturePackage(input.root,input.version,'actual-node-install');
if(input.clean){
 const manifestPath=join(packageRoot,'release-manifest.json');
 const manifest=JSON.parse(readFileSync(manifestPath,'utf8'));manifest.source.dirty=false;
 const bytes=Buffer.from(JSON.stringify(manifest)+'\\n');writeFileSync(manifestPath,bytes);
 const artifact=artifacts.get(packageRoot);createArtifact(artifact.path,bytes,packageRoot);
 artifact.sha256=sha(readFileSync(artifact.path));
}

const stateDirectory=join(input.root,'State ü space');
const custom=join(input.root,'Custom configuration ü');mkdirSync(custom,{recursive:true});chmodSync(custom,0o700);
const overrides=input.custom?{configPath:join(custom,'owner config.json'),secretPath:join(custom,'owner secret.key')}:{};
if(input.custom){writeFileSync(overrides.secretPath,'a'.repeat(64)+'\\n',{mode:0o600});}
const options=await withPorts(lifecycleOptions(input.root,packageRoot,'install',{timeoutMs:1379,enableBridgeDiagnostics:true,allowDirtyPrivateBuild:!input.clean,...overrides}));
const installed=await runLifecycle(options);
export default {options,installed,receipt:receipt(options)};
`;
const code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
const {default:result}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
fs.rmSync(reference,{recursive:true,force:true});
process.stdout.write(JSON.stringify(result));
