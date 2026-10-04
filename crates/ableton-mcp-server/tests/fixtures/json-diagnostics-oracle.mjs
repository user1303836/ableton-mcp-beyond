import fs from 'node:fs';
const values=['', ' ', '{','[','true','false','null','0','-3.14e+4','{}','[]','{"a":[1,2,"😀"]}',...['x','undefined','NaN','Infinity','[object Object]','nulX','tru','truefalse','01','-','1.','1e','1e+','"abc','"a\\q"','"\\u123z"','"a\nb"','{\r x}','{\r\n x}','{\n x}']];
for(const base of ['{"key":"value","list":[1,true,null]}','[1,2,3]','"escaped\\ntext"','{"😀":"𝄞"}','-42.125e-10']){
 for(let i=0;i<=base.length;i++){values.push(base.slice(0,i));for(const ch of ['x','!',',',':','"','\n','\r','\u0000','😀',' ','[',']','{','}','0','e','\\'])values.push(base.slice(0,i)+ch+base.slice(i));}
}
for(let n=0;n<35;n++)for(const p of [0,4,9,10,11,20,34])values.push(' '.repeat(p)+'x'+'a'.repeat(n));
const units=text=>Array.from({length:text.length},(_,i)=>text.charCodeAt(i));
const rows=values.map(text=>{try{JSON.parse(text);return{units:units(text)};}catch(e){return{units:units(text),error:units(e.message)};}});
fs.writeFileSync(new URL('json-diagnostics-oracle.json',import.meta.url),JSON.stringify(rows));console.log(rows.length);
