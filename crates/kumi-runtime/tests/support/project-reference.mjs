// Regenerate from the built TypeScript behavioral reference.
import {readFileSync,writeFileSync} from 'node:fs';
import {describeDiff,describeWatch,since} from '../../../../packages/runtime/dist/src/integrations/ableton/project.js';
const fixture=JSON.parse(readFileSync(new URL('../../../../packages/runtime/test/fixtures/catch-up.json',import.meta.url)));
const cases=[];const add=(diff,before,after)=>{for(const limit of [0,1,2,8,40])cases.push({diff,before,after,limit,described:describeDiff(diff,before,after,limit),watched:describeWatch(diff,before,after,limit)});};
add(fixture.diff,fixture.before,fixture.after);add(fixture.ambiguous.diff,fixture.ambiguous.before,fixture.ambiguous.after);
const many=Array.from({length:200},(_,i)=>`t${i}`);const rows=(ids,named=false)=>ids.map(id=>({snapshotId:id,kind:'track',name:named?`Track ${id}`:'Template',data:{}}));
add({items:[{kind:'track',type:'ambiguity',beforeSnapshotIds:many,afterSnapshotIds:many.slice(1)}]},[{records:rows(many)}],[{records:rows(many.slice(1))}]);
add({items:[{kind:'track',type:'ambiguity',beforeSnapshotIds:many.slice(0,25),afterSnapshotIds:[]}]},[{records:rows(many,true)}],[{records:[]}]);
for(const kind of ['set','track','scene','clip','device','locator','unsupported'])for(const renamed of [true,false]){
 const before=[{records:[{snapshotId:'old',kind,order:1,name:'Old',data:{}}]}],after=[{records:[{snapshotId:'new',kind,order:1,name:renamed?'New':'Old',data:{kind:'midi',clipKind:'midi',className:'Operator',depth:1,siblingOrder:2,location:{lane:'session',sceneOrder:3},routing:{a:'x'.repeat(280)},mixer:{volume:0.3,pan:0,sends:[0],mute:false,solo:false,extra:4}}}]}];
 add({items:[{type:'change',kind,beforeSnapshotId:'old',afterSnapshotId:'new',facets:renamed?['renamed']:['changed'],details:[{path:'/data/tempo',before:120,after:124},{path:'/data/notes',before:'x'.repeat(150),after:{notes:Array(50).fill(1)}},{path:'/data/structureHash',before:'a',after:'b'}]}]},before,after);
 add({items:[{type:'change',kind,beforeSnapshotId:'old',facets:['removed']},{type:'change',kind,afterSnapshotId:'new',facets:['added']}]},before,after);
}
const times=[0,30000,90000,119999,25*60000,59.5*60000,60*60000,23.5*60*60000,3*24*60*60000,-1000].map(delta=>({delta,text:since(0,delta)}));
writeFileSync(new URL('project-oracle.json',import.meta.url),JSON.stringify({fixture,cases,times})+'\n');
