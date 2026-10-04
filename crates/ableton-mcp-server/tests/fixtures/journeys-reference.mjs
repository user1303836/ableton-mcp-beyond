// Regenerate with the built TypeScript reference; Rust runtime needs no Node.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as j from '../../../../apps/mcp-server/dist/src/journeys.js';
const toolOracle = JSON.parse(readFileSync(new URL('tool-catalog-oracle.json', import.meta.url)));
const statuses = toolOracle.statuses;
statuses.push({...statuses[1],epoch:null});
statuses.push({...statuses[1],capabilities:['session.read','session.discovery','browser'],operations:['discover','browser.search','browser.load','device.delete']});
statuses.push({...statuses[1],capabilities:['session.read','session.discovery','routing','mixing','transport'],operations:['discover','session.playback','routing.set','mixer.set']});
const inputs = j.JOURNEY_IDS.flatMap(journey => [
  {journey,traits:'syncopated, spacious, warm, controlled',experienceLevel:'advanced',bars:8},
  {journey,traits:'controlled clear balanced'},
  ...['broken beat, sparse bass','copy Artist X\'s exact signature patch','in the style of Bright Eyes','sound like Major Lazer','copy Dark Star exactly','majority business','brightness and softness','Warm Spacious','warm dark soft punchy bright sharp gritty organic metallic airy wide minor major','dense swung energetic', 'minimal gentle','swing swung half time double-time','calm relaxed driving aggressive dense sparse','\ufeffwarm\ufeff','\u0085warm\u0085','Sound\ufeffLike warm','tracK warm','ſignature warm','áCopyá warm','Foo Bar','warm😀','straight syncopated swung swing half-time double-time broken steady offbeat sparse minimal dense busy layered calm relaxed driving energetic aggressive gentle warm bright dark soft gritty clean rounded sharp organic metallic airy dry intimate wide narrow spacious reverberant distant close controlled punchy dynamic compressed clear balanced loud quiet major minor modal dissonant consonant chromatic gradual contrasting repetitive evolving short long'].map(traits=>({journey,traits})),
  ...[1,7,9,16].map(bars=>({journey,traits:'busy syncopated swung driving minor wide',bars})),
]);
const sha = value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const cases=[];
const inputsPerJourney=inputs.length/j.JOURNEY_IDS.length;
for(let si=0;si<statuses.length;si++) for(let ii=0;ii<inputs.length;ii++) {
  // Every negotiated omission for every journey, plus the full trait corpus on full/disconnected Live.
  if(si>1 && ii%inputsPerJourney!==0) continue;
  const input=inputs[ii],status=statuses[si];
  const plan=j.planUserJourney(input,status);
  cases.push({status:si,input:ii,sha256:sha(plan),promptSha256:sha(j.renderJourneyPrompt(input,status)),...(si===1 && ii%inputsPerJourney===0?{plan}:{})});
}
const base={journey:j.JOURNEY_IDS[0],traits:'warm'};
const invalid=[{}, {...base,journey:'bogus'}, {...base,traits:''}, {...base,traits:'x'.repeat(1001)}, {...base,traits:'😀'.repeat(501)}, {...base,traits:'\0'}, {...base,traits:42}, {...base,experienceLevel:'expert'}, {...base,bars:17},{...base,bars:0},{...base,bars:1.5},{...base,bars:'4'}].map(input=>{try{return {input,result:j.planUserJourney(input,statuses[1])}}catch(e){return {input,error:e.message}}});
const resources=statuses.map(status=>sha(j.journeyResource(status)));
writeFileSync(new URL('journeys-oracle.json',import.meta.url),JSON.stringify({statuses,inputs,cases,invalid,resources})+'\n');
console.log(`${inputs.length} inputs, ${cases.length} plans/prompts, ${resources.length} resources`);
