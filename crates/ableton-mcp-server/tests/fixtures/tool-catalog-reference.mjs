// Regenerate after `npm run build --prefix apps/mcp-server` from the behavioral reference.
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as catalog from '../../../../apps/mcp-server/dist/src/tool-catalog.js';
import { LIVE_CAPABILITIES, LIVE_REGISTRY_OPERATIONS } from '../../../../apps/mcp-server/dist/src/live.js';
import * as journeys from '../../../../apps/mcp-server/dist/src/journeys.js';
const data = { catalog: catalog.TOOL_CATALOG, classes: catalog.TOOL_POLICY_CLASSES, profiles: catalog.TOOL_POLICY_PROFILES, availabilityRules: catalog.TOOL_AVAILABILITY_RULES, policyRules: catalog.TOOL_POLICY_RULES };
writeFileSync(new URL('../../src/tool-catalog-data.json', import.meta.url), JSON.stringify(data, null, 2) + '\n');
writeFileSync(new URL('../../src/journeys-data.json', import.meta.url), JSON.stringify({catalog:journeys.JOURNEY_CATALOG,prompts:journeys.JOURNEY_PROMPTS,ids:journeys.JOURNEY_IDS},null,2)+'\n');
const unavailable = {connected:false,adapter:'unavailable',epoch:null,protocol:'ableton-live/v1',capabilities:[]};
const full = {connected:true,adapter:'remote-script',epoch:1,protocol:'ableton-live/v1',provenance:'real-live',capabilities:LIVE_CAPABILITIES,operations:LIVE_REGISTRY_OPERATIONS};
const policies = [undefined,...Object.keys(catalog.TOOL_POLICY_PROFILES).map(profile=>({profile})),{allow:['live_tempo_*','live_status']},{profile:'performance',deny:['live_tempo_apply','live_mixer_*']},{allow:['live_retired_tool']},{deny:['live_recording_*']}];
const statuses = [unavailable,full,{...full,provenance:'fake-live'},{...full,operations:[]},{...full,capabilities:[]},{...full,willingtonKinds:['eq','compressor']}];
for (const operation of LIVE_REGISTRY_OPERATIONS) statuses.push({...full,operations:full.operations.filter(value=>value!==operation)});
for (const capability of LIVE_CAPABILITIES) statuses.push({...full,capabilities:full.capabilities.filter(value=>value!==capability)});
const parsedPolicies=policies.map(raw=>catalog.parseToolPolicySpec(raw));
const cases=statuses.flatMap((status,si)=>parsedPolicies.map((policy,pi)=>{
  const result={rows:catalog.resolveToolVisibility(status,policy).map(({entry,...row})=>({name:entry.name,...row})),descriptors:catalog.visibleToolDescriptors(status,policy)};
  return {status:si,policy:pi,sha256:createHash('sha256').update(JSON.stringify(result)).digest('hex')};
}));
const invalid=[null,1,[],{profile:'everything'},{extra:true},{allow:['not a tool']},{deny:['A']},{allow:new Array(257).fill('live_status')},{profile:4}].map(input=>{try{return {input,result:catalog.parseToolPolicySpec(input)}}catch(error){return {input,error:error.message}}});
writeFileSync(new URL('tool-catalog-oracle.json', import.meta.url),JSON.stringify({statuses,policies:parsedPolicies,cases,invalid})+'\n');
console.log(`${data.catalog.length} tools; ${cases.length} status/policy cases`);
