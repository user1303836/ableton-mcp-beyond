import {writeFileSync} from 'node:fs';
import {goalSetup,goalLeap} from '../../../../packages/runtime/dist/src/core/goal.js';
const state={version:1,goal:'make the bass warm',request:{candidates:[],fromBeat:8,beats:4,reference:'reference.wav'},slots:[{name:'Dark',label:'Dark Operator',chain:'Operator',knobs:[],elite:[],sigma:0.1,stale:0}],generation:8,rendered:72,trend:[],elapsedMs:10000,status:'paused'};
const setup=['make the bass warm','α goal 😀',''].map(goal=>({goal,text:goalSetup(goal)}));
const leaps=[];
for(const trend of [[],[12.5,19,47.8],[1,2,3,4,5,6,7,8,9,10]])for(const best of [undefined,{label:'Dark Operator',score:78.45}])for(const stalled of [false,true])for(const structural of [undefined,{kind:'sub',gap:'sub is absent',move:'add a sub layer',share:0.7}]){
 const input={state:{...state,trend},best,gaps:trend.length?['too bright','attack too sharp']:[],stalled,structural};leaps.push({...input,text:goalLeap(input.state,best,input.gaps,stalled,structural)});
}
writeFileSync(new URL('goal-oracle.json',import.meta.url),JSON.stringify({state,setup,leaps})+'\n');
