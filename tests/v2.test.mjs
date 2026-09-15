import test from 'node:test';
import assert from 'node:assert/strict';
import {autoSchedule,computeCPM} from '../dist/schedule-core.js';
const t=(id,start,duration,predecessors=[])=>({id,name:id,level:0,start,finish:start,duration,predecessors});
const r=(taskId,type,lag=0)=>({taskId,type,lag});
test('FS 隔日開始，變更 lag 後下游 SS 同步移動，維持工期',()=>{
 const tasks=[t('A','2026-10-01',10),t('B','2026-12-01',5,[r('A','FS',60)]),t('C','2026-12-01',7,[r('B','SS')])];
 let result=autoSchedule(tasks);assert.equal(result.tasks[1].start,'2026-12-10');
 result.tasks[1].predecessors[0].lag=30;result=autoSchedule(result.tasks);
 assert.equal(result.tasks[1].start,'2026-11-10');assert.equal(result.tasks[2].start,'2026-11-10');assert.equal(result.tasks[2].finish,'2026-11-16');
});
test('四種關係、負 lag、指定不得早於與多前置',()=>{
 const a=t('A','2026-10-01',10);
 for(const [type,lag,start] of [['FS',0,'2026-10-11'],['SS',0,'2026-10-01'],['FF',0,'2026-10-06'],['SF',0,'2026-09-27'],['FS',-2,'2026-10-09']]){
 const out=autoSchedule([a,t('B','2026-01-01',5,[r('A',type,lag)])]);assert.equal(out.tasks[1].start,start);
 }
 const b={...t('B','2026-01-01',5,[r('A','FS')]),notBefore:'2026-11-01'};
 assert.equal(autoSchedule([a,b]).tasks[1].start,'2026-11-01');
 assert.equal(autoSchedule([a,t('C','2026-10-20',2),t('B','2026-01-01',5,[r('A','FS'),r('C','FS')])]).tasks[2].start,'2026-10-22');
});
test('拒絕循環且不改動輸入',()=>{
 const tasks=[t('A','2026-10-01',2,[r('B','FS')]),t('B','2026-10-01',2,[r('A','FS')])];
 const snapshot=JSON.stringify(tasks);assert.equal(autoSchedule(tasks).ok,false);assert.equal(JSON.stringify(tasks),snapshot);
});
test('里程碑零工期與 FF 日期、CPM 一致',()=>{
 const tasks=[t('A','2026-10-01',10),{...t('M','2026-10-01',0,[r('A','FF')]),milestone:true}];
 const result=autoSchedule(tasks);assert.equal(result.tasks[1].start,'2026-10-10');assert.equal(result.tasks[1].finish,'2026-10-10');
 const cpm=computeCPM(result.tasks);assert.equal(cpm.conflicts.length,0);assert.equal(cpm.metrics.get('A').critical,true);
});
