const test = require('node:test'), assert = require('node:assert/strict');
const dashboard = require('../miniprogram/services/dashboard');
const base = () => ({date:'2026-11-02', records:{}, entitlement:null});
const record = (kind,value) => ({kind,value});
test('today distinguishes onboarding, assessed preview, pending recovery and expired plans', () => {
  const vm=base(); assert.equal(dashboard.today(vm).guide,true);
  vm.preview={days:[{rest:true}],nutrition:{meals:['早餐']}};
  assert.equal(dashboard.today(vm).guide,false);
  assert.equal(dashboard.today(vm).task,null);
  vm.entitlement={id:'p',status:'pending',plan:vm.preview};
  assert.equal(dashboard.today(vm).task.rest,true);
  vm.entitlement.status='expired'; vm.today={rest:false};
  assert.equal(dashboard.today(vm).task,null);
});
test('today separates a saved meal log from task completion and counts recovery',()=>{
  const vm={...base(),active:true,day:1,today:{rest:true},entitlement:{id:'p',plan:{days:[{rest:true}]}},records:{'daily:p:2026-11-02':record('daily',{date:'2026-11-02',breakfast:'饭',nutrition:false,recovery:true})}};
  const result=dashboard.today(vm);assert.equal(result.recorded,true);assert.equal(result.nutritionDone,false);assert.equal(result.done,1);
});
test('growth includes interrupted effort, unique food days, independent sparse measurements and week boundaries',()=>{
  const vm=base();vm.records={
    a:record('session',{date:'2026-11-01',status:'completed',completedSets:4,seconds:120,difficulty:'easy'}),
    b:record('session',{date:'2026-11-02',status:'interrupted',completedSets:2,seconds:60,difficulty:'hard'}),
    c:record('daily',{date:'2026-11-02',nutrition:true,breakfast:'饭'}),
    d:record('daily',{date:'2026-11-02',nutrition:true}),
    e:record('measurement',{date:'2026-10-01',weight:70,waist:80}),
    f:record('measurement',{date:'2026-11-01',weight:69,waist:null}),
    g:record('measurement',{date:'2026-11-02',weight:null,waist:79})};
  const recent=dashboard.growth(vm);assert.equal(recent.sessions,1);assert.equal(recent.nutritionDays,1);
  assert.equal(recent.sets,6);assert.equal(recent.minutes,3);
  assert.equal(recent.trends[0].count,1);assert.equal(recent.trends[1].latest,79);
  assert.equal(recent.weeks[2].training,1);assert.equal(recent.weeks[3].training,0);
  assert.equal(recent.weeks[3].nutrition,1);assert.equal(recent.weeks[3].recorded,1);
  const all=dashboard.growth(vm,true);assert.equal(all.trends[0].change,'-1');assert.equal(all.trends[1].change,'-1');
});
test('empty growth and a completed assessment stay independent from an edited draft',()=>{
  const vm=base();assert.equal(dashboard.growth(vm).latest,'暂无记录');
  vm.draft={goal:'muscle'};vm.records.assessment=record('assessment',{goal:'habit',weight:65});
  assert.equal(dashboard.profile(vm).goal,'建立持续的运动习惯');
});
test('calendar aligns Monday weeks across months and restricts actions to today',()=>{
  const vm={...base(),active:true,day:1,today:{rest:false},entitlement:{id:'p',startDate:'2026-11-02',plan:{days:Array.from({length:7},(_,i)=>({rest:i%2===1})),nutrition:{meals:['早餐']}}}};
  const current=dashboard.calendar(vm);assert.equal(current.anchor,'2026-11-02');assert.equal(current.weeks[0].days[0].date,'2026-10-26');assert.equal(current.weeks[2].days[6].date,'2026-11-15');
  const future=dashboard.calendar(vm,'2026-11-03');assert.equal(future.view.task.rest,true);assert.equal(future.view.executable,false);assert.equal(future.isToday,false);
  const outside=dashboard.calendar(vm,'2026-11-12');assert.equal(outside.view.task,null);
  const rotated=dashboard.calendar(vm,'2026-11-09','2026-11-09',2);assert.equal(rotated.weeks[2].days[0].date,'2026-11-09');assert.equal(rotated.weeks[0].days[0].date,'2026-11-16');
});
test('calendar displays historical records even when their plan is no longer retained',()=>{
  const vm=base();vm.records={old:record('session',{date:'2026-10-31',status:'completed',seconds:120,completedSets:2}),food:record('daily',{date:'2026-10-31',nutrition:true,breakfast:'燕麦'})};
  const result=dashboard.calendar(vm,'2026-10-31');assert.equal(result.hasRecords,true);assert.equal(result.view.task,null);assert.equal(result.sessions[0].minutes,2);assert.equal(result.logs[0].breakfast,'燕麦');assert.equal(result.view.executable,false);
});
test('profile summary follows the latest completed assessment rather than an older active plan',()=>{
  const vm=base();
  vm.records.assessment=record('assessment',{sex:'female',age:30,height:165,weight:60,goal:'habit',stepGoal:7000,weekdays:[1,3,5]});
  vm.entitlement={plan:{energyTargets:{basalKcal:1900}}};
  const result=dashboard.profile(vm);
  assert.deepEqual(result.summaryFields.map(f=>f.label),['性别','年龄','身高','基础代谢','我的目标','每日目标步数','可训练日']);
  assert.equal(result.summaryFields[3].value,'1320 千卡/日（估算）');
  assert.equal(result.summaryFields[6].value,'周一、周三、周五');
  assert.ok(result.detailFields.every(f=>!['年龄','生理性别','身高','基础代谢估算','每日步数目标','可训练日'].includes(f.label)));
});
