// Pairwise signs, independent of localeCompare's unspecified negative/positive magnitudes.
import {writeFileSync} from 'node:fs';
const values=['',' ','_','-','.','/','#','!','01','1','10','2','12','128 BPM','A','a','aa','Aa','aA','AA','á','a\u0301','ä','å','Æ','æ','A minor','A# minor','C minor','C# minor','D Dorian','É','e','é','è','ê','E','f','F♯','ß','ss','o','ø','ö','Ö','z','Z','Å','Ω','Ж','あ','ア','中','音','😀'];
const locales=['en-US','de-DE','sv-SE','tr-TR','ja-JP'].map(locale=>({locale,pairs:values.flatMap(a=>values.map(b=>Math.sign(a.localeCompare(b,locale))))}));
writeFileSync(new URL('locale-oracle.json',import.meta.url),JSON.stringify({icu:process.versions.icu,defaultLocale:new Intl.Collator().resolvedOptions().locale,values,locales})+'\n');
