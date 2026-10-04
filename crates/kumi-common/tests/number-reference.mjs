import {writeFileSync} from 'node:fs';
const values=['','\uFEFF','\u0085','\u008512\u0085','\uFEFF12\uFEFF','0x','0b','0o','+0x1','-0x1','0xfg','0b2','0o8','0B001','0O12','0X20','0b1.0','0x 1','Infinity','+Infinity','-Infinity','infinity','1e999','.2','1.','1_000','NaN'];
for(const radix of[2,8,16])for(const bits of[1,30,52,53,54,60,64,100,1023,1024,1025])for(const offset of[-2n,-1n,0n,1n,2n,100n]){const n=(1n<<BigInt(bits))+offset;if(n>=0n)values.push(({2:'0b',8:'0o',16:'0x'}[radix])+n.toString(radix));}
writeFileSync(new URL('./number-oracle.json',import.meta.url),JSON.stringify(values.map(text=>{const value=Number(text);return{text,value:Number.isFinite(value)?value:String(value)}}),null,2)+'\n');
