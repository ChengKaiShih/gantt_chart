import test from 'node:test';
import assert from 'node:assert/strict';
import {autoSchedule,computeCPM,deriveSummaryDates} from '../dist/schedule-core.js';
const r=(taskId,type='FS',lag=0)=>({taskId,type,lag});
const t=(id,start,duration,level=0,predecessors=[])=>({id,name:id,start,finish:start,duration,level,predecessors});
const stage=(id,start,duration)=>({...t(id,start,duration),summaryMode:'fixed',stageControl:true});
const schedule=tasks=>{const out=autoSchedule(tasks);assert.equal(out.ok,true,out.error);return out.tasks;};
const metrics=tasks=>computeCPM(schedule(tasks)).metrics;
test('階段準時、平行工作提早、超期；取消旗標恢復全案浮時',()=>{
 const tasks=[stage('P','2026-03-01',10),t('A','2026-03-01',10,1),t('B','2026-03-01',8,1),t('C','2026-03-01',12,1),t('Z','2026-03-16',15)];
 const scheduled=schedule(tasks), before=JSON.stringify(scheduled), result=computeCPM(scheduled);
 assert.equal(result.metrics.get('A').totalFloat,0);assert.equal(result.metrics.get('B').totalFloat,2);
 assert.equal(result.metrics.get('C').totalFloat,-2);assert.equal(result.metrics.get('C').critical,true);
 assert.equal(result.metrics.get('C').controllingDeadline.id,'P');
 assert.equal(JSON.stringify(scheduled),before);assert.equal(deriveSummaryDates(scheduled)[0].finish,'2026-03-10');
 scheduled[0].stageControl=false;assert.equal(computeCPM(scheduled).metrics.get('A').totalFloat,20);
});
test('三個階段完整銜接、壓線的控制路徑都為零',()=>{
 const m=metrics([stage('P','2026-03-01',10),t('A','2026-03-01',10,1),stage('Q','2026-03-11',10),t('B','2026-03-11',10,1,[r('A')]),stage('R','2026-03-21',10),t('C','2026-03-21',10,1,[r('B')])]);
 for(const id of ['A','B','C'])assert.equal(m.get(id).totalFloat,0);
});
test('後階段較嚴格的期限沿跨階段前置關係傳回前項',()=>{
 const m=metrics([stage('P','2026-03-01',15),t('A','2026-03-01',10,1),stage('Q','2026-03-11',8),t('B','2026-03-11',10,1,[r('A')]),t('Z','2026-03-25',6)]);
 assert.equal(m.get('A').totalFloat,-2);assert.equal(m.get('B').totalFloat,-2);
 assert.equal(m.get('A').controllingDeadline.id,'Q');
});
test('固定上階的前置與子項SS關係不再被CPM忽略',()=>{
 const tasks=schedule([t('Approval','2026-03-01',1),{...stage('P','2026-03-02',10),predecessors:[r('Approval')]},t('A','2026-03-02',10,1,[r('P','SS')])]);
 const cpm=computeCPM(tasks);assert.equal(cpm.ignoredRelations.length,0);
 assert.equal(cpm.metrics.get('Approval').totalFloat,0);assert.equal(cpm.metrics.get('A').totalFloat,0);
});
test('日末里程碑與同日完工對齊，FS後項隔日開始；FF維持同日',()=>{
 const tasks=schedule([t('A','2026-03-01',10),{...t('M','2026-03-01',0,0,[r('A','FF')]),milestone:true},t('B','2026-03-01',2,0,[r('M')])]);
 assert.equal(tasks[1].finish,'2026-03-10');assert.equal(tasks[2].start,'2026-03-11');
 const cpm=computeCPM(tasks);assert.equal(cpm.projectDuration,12);assert.equal(cpm.conflicts.length,0);
 for(const id of ['A','M','B'])assert.equal(cpm.metrics.get(id).totalFloat,0);
 assert.equal(cpm.metrics.get('M').duration,0);
 assert.equal(cpm.metrics.get('M').ef,cpm.metrics.get('A').ef);
});
test('階段內里程碑準時與逾期均納入期限，孤立里程碑工期仍為零',()=>{
 const m=metrics([stage('P','2026-03-01',10),{...t('M','2026-03-10',0,1),milestone:true},{...t('N','2026-03-11',0,1),milestone:true}]);
 assert.equal(m.get('M').totalFloat,0);assert.equal(m.get('N').totalFloat,-1);
 assert.equal(m.get('N').duration,0);
});
test('不同關係與多前置會傳遞期限限制，不更改既有排程',()=>{
 for(const [type,start] of [['SS','2026-03-01'],['FF','2026-03-06'],['SF','2026-02-25'],['FS','2026-03-11']]){
   const scheduled=schedule([t('A','2026-03-01',10),stage('P',start,5),t('B',start,5,1,[r('A',type)]),t('Z','2026-04-01',1)]);
   const cpm=computeCPM(scheduled);assert.equal(cpm.metrics.get('B').totalFloat,0,type);assert.equal(cpm.metrics.get('A').totalFloat,0,type);
 }
 const m=metrics([t('A','2026-03-01',5),t('B','2026-03-01',10),stage('P','2026-03-11',5),t('C','2026-03-11',5,1,[r('A'),r('B')])]);
 assert.equal(m.get('A').totalFloat,5);assert.equal(m.get('B').totalFloat,0);
});
test('空專案及固定上階循環仍可安全處理',()=>{
 assert.equal(computeCPM([]).projectDuration,0);
 const tasks=[{...stage('P','2026-03-01',10),finish:'2026-03-10',predecessors:[r('A')]},{...t('A','2026-03-01',10,1,[r('P')]),finish:'2026-03-10'}];
 assert.equal(computeCPM(tasks).ok,false);
});
