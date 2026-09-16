import test from 'node:test';
import assert from 'node:assert/strict';
import {autoSchedule,deriveSummaryDates,stageWarnings} from '../dist/schedule-core.js';
const t=(id,level,start,duration,predecessors=[])=>({id,name:id,level,start,finish:start,duration,predecessors});
test('固定上階保留期間，累計上階依子項，超期指出子項',()=>{
 const tasks=[{...t('P',0,'2026-01-01',10),summaryMode:'fixed'},t('A',1,'2026-01-05',20)];
 let out=autoSchedule(tasks).tasks;assert.equal(deriveSummaryDates(out)[0].finish,'2026-01-10');assert.match(stageWarnings(out).get('P'),/A.*14 天/);
 out[0].summaryMode='auto';assert.equal(deriveSummaryDates(out)[0].finish,'2026-01-24');
});
test('固定階段可依前置起算，子項以SS連動；循環拒絕',()=>{
 const tasks=[t('Approval',0,'2026-01-01',1),{...t('P',0,'2026-01-01',10,[{taskId:'Approval',type:'FS',lag:0}]),summaryMode:'fixed'},t('A',1,'2026-01-01',3,[{taskId:'P',type:'SS',lag:0}])];
 const out=autoSchedule(tasks);assert.equal(out.ok,true);assert.equal(out.tasks[1].start,'2026-01-02');assert.equal(out.tasks[2].start,'2026-01-02');
 tasks[1].predecessors=[{taskId:'A',type:'FS',lag:0}];assert.equal(autoSchedule(tasks).ok,false);
});
test('指定日期早於前置限制時調整並保留原因',()=>{
 const tasks=[t('A',0,'2026-01-01',10),{...t('B',0,'2026-01-03',5,[{taskId:'A',type:'FS',lag:0}]),notBefore:'2026-01-03'}];
 const out=autoSchedule(tasks);assert.equal(out.tasks[1].start,'2026-01-11');assert.match(out.tasks[1].dateNotice,/A.*2026-01-11/);
});
