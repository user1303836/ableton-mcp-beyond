import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
const source=pathToFileURL(process.argv[2]);
let text=fs.readFileSync(source,'utf8');
for(const relative of ['./analysis.js','./host.js']) text=text.replaceAll(JSON.stringify(relative),JSON.stringify(new URL(relative,source).href));
text+='\nexport {percentile,measure};\n';
const m=await import(`data:text/javascript;base64,${Buffer.from(text).toString('base64')}`);
const percentiles=[];
for(const values of [[],[3],[5,1,2,8,3],Array.from({length:256},(_,i)=>256-i)])for(const fraction of [-1,0,0.1,0.5,0.95,1,2]){
 let result;try{result=m.percentile(values,fraction)}catch(error){result={error:error.message}}
 percentiles.push({values,fraction,result});
}
const measurements=[];
for(const minimum of [false,true])for(const value of [-10,0,1,5,10])for(const budget of [0,1,5])measurements.push({value,budget,minimum,result:m.measure('gate',value,'ms',budget,minimum?'minimum':'maximum')});
const analysis=[];
for(const kind of ['valid','short','unsafe','truthyUnsafe']){
 let calls=0;let result;
 try{const measured=m.measureMaximumInputAnalysis(input=>{calls++;return {sampleCount:kind==='short'?1:input.samples.length,safety:{projectMutated:kind==='unsafe'?true:kind==='truthyUnsafe'?'yes':false},peak:0.5}});result=measured.map(({name,unit,budget})=>({name,unit,budget}));}catch(error){result={error:error.message};}
 analysis.push({kind,calls,result});
}
fs.writeFileSync(new URL('benchmark-oracle.json',import.meta.url),JSON.stringify({budgets:m.BENCHMARK_BUDGETS,analysisMeasurements:m.ANALYSIS_MEASUREMENTS,percentiles,measurements,analysis}));
console.log({percentiles:percentiles.length,measurements:measurements.length,analysis:analysis.length});
