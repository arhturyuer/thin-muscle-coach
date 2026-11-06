const {test}=require('node:test'),assert=require('node:assert/strict');
const model=require('../miniprogram/services/today-summary'),d=require('../shared/domain');
const date='2026-11-05',planId='paid-plan';
function fixture(){
 const a={height:175,weight:70,stepGoal:8000};
 return {vm:{date,entitlement:{id:planId},records:{}},calendar:{selected:date,logs:[],sessions:[],view:{intake:1800,plan:{assessment:a},steps:{steps:4000}}},daily:{plannedMeals:[],meals:[{slot:'breakfast',suggestion:'鸡蛋、牛奶'}]},workout:{day:{planVersion:1,title:'核心与下肢',rest:false,energyKcal:101,exercises:[{id:'move-0',name:'深蹲',mode:'reps',sets:3,reps:12,seconds:180},{id:'move-1',name:'平板支撑',mode:'time',sets:2,reps:null,seconds:120}]}}};
}
const result=f=>model.view(f.vm,f.calendar,f.daily,f.workout);
function meal(f,slot,kcal,text='米饭'){
 const key=`meal:${planId}:${date}:${slot}`,id=`analysis:${planId}:${date}:${slot}`;
 f.vm.records[key]={kind:'meal',value:{text,analysisIds:kcal===null?[]:[id]}};
 if(kcal!==null)f.vm.records[id]={kind:'mealAnalysis',value:{planId,date,slot,analysis:{consumed:{energyKcal:kcal}}}};
 return key;
}
test('diet shows actual meals first, snack counts, orphan analysis never counts',()=>{
 const f=fixture();meal(f,'breakfast',300);meal(f,'snack',100,'苹果');
 f.vm.records.orphan={kind:'mealAnalysis',value:{analysis:{consumed:{energyKcal:999}}}};
 const x=result(f).diet;assert.equal(x.remaining,'1400');assert.equal(x.rows[0].text,'米饭');assert.equal(x.rows[0].state,'已记录');assert.equal(x.rows[3].text,'苹果');
});
test('missing text calories, missing analyses and partial nutrition require confirmation',()=>{
 for(const mode of ['text','missing','partial','null']){
  const f=fixture(),key=meal(f,'lunch',mode==='text'?null:100);
  if(mode==='missing')delete f.vm.records[f.vm.records[key].value.analysisIds[0]];
  if(mode==='partial')f.vm.records[key].value.nutritionIncomplete=true;
  if(mode==='null')f.vm.records[f.vm.records[key].value.analysisIds[0]].value.analysis.consumed.energyKcal=null;
  assert.equal(result(f).diet.remaining,'待确认',mode);
 }
});
test('replacement, tombstone, deduplicated references and excess intake recompute',()=>{
 const f=fixture(),key=meal(f,'lunch',1900),id=f.vm.records[key].value.analysisIds[0];
 f.vm.records[key].value.analysisIds.push(id);
 assert.equal(result(f).diet.remaining,'100');assert.equal(result(f).diet.label,'已超出');
 f.vm.records[key].value.text='';assert.equal(result(f).diet.remaining,'1800');
 f.vm.records[key].value.text='面';f.vm.records[key].value.analysisIds=[];assert.equal(result(f).diet.remaining,'待确认');
});
test('historical meals select recorded plan and exclude another date or mismatched analysis',()=>{
 const f=fixture();f.vm.entitlement.id='new-plan';f.calendar.logs=[{planId}];const key=meal(f,'lunch',200);
 assert.equal(result(f).diet.remaining,'1600');f.vm.records[f.vm.records[key].value.analysisIds[0]].value.date='2026-11-04';assert.equal(result(f).diet.remaining,'待确认');
});
test('no records uses zero recorded intake; absent target and suggestions remain meaningful',()=>{
 const f=fixture();assert.equal(result(f).diet.remaining,'1800');assert.equal(result(f).diet.rows[0].text,'鸡蛋、牛奶');
 f.calendar.view.intake=null;assert.equal(result(f).diet.remaining,'待补充评测');
});
test('integer allocation preserves daily total including rounding ties',()=>{
 for(let n=0;n<25;n++){const x=model.allocate(n,[{seconds:1},{seconds:1},{seconds:1}]);assert.equal(x.reduce((s,v)=>s+v,0),n);}
 assert.deepEqual(model.allocate(5,[{seconds:1},{seconds:1},{seconds:1}]),[2,2,1]);
});
test('partial training uses actual seconds and leaves action progress separate from heat',()=>{
 const f=fixture();f.workout.record={planVersion:1,exercises:[{id:'move-0',sets:1,reps:12,seconds:60}]};
 const x=result(f).exercise;assert.equal(x.training.done,'20');assert.equal(x.training.remaining,'81');assert.match(x.rows[0].progress,/还剩2组×12次/);assert.equal(x.rows[0].muscles,'练腿部、臀部');assert.equal(x.rows[1].muscles,'查看动作说明');
 f.workout.record.exercises[0]={id:'move-0',sets:1,reps:8,seconds:600};
 const y=result(f).exercise;assert.equal(y.training.remaining,'0');assert.equal(y.rows[0].state,'部分完成');assert.match(y.rows[0].progress,/与计划次数不同/);
});
test('activity surplus never cancels unfinished training and progress uses capped contributions',()=>{
 const f=fixture();f.calendar.view.steps.steps=20000;const x=result(f).exercise;
 assert.equal(x.activity.remaining,'0');assert.equal(x.remaining,'101');assert.ok(x.progress<100);assert.ok(+x.done>+x.target);
});
test('unsynchronized steps are unknown while verified zero steps is actual zero',()=>{
 const f=fixture();f.calendar.view.steps.steps=null;let x=result(f).exercise;
 assert.equal(x.activity.done,'待同步');assert.equal(x.done,'待确认');assert.equal(x.training.done,'0');
 f.calendar.view.steps.steps=0;x=result(f).exercise;assert.equal(x.done,'0');assert.notEqual(x.remaining,'待确认');
});
test('rest day, empty plan and future remain independent of legacy diet task',()=>{
 const f=fixture();f.calendar.view.task=null;assert.equal(result(f).exercise.hasDay,true);
 f.workout.day={rest:true,title:'恢复',energyKcal:0,exercises:[]};assert.equal(result(f).exercise.training.remaining,'0');
 f.workout.day=null;assert.equal(result(f).exercise.training.target,'待确认');assert.equal(result(f).diet.rows.length,3);
 const future=fixture();future.vm.date='2026-11-04';assert.equal(result(future).exercise.rows[0].state,'尚未开始');assert.equal(result(future).exercise.progress,0);
});
test('manual records take precedence over legacy sessions and version mismatch stays unknown',()=>{
 const f=fixture();f.calendar.sessions=[{seconds:999,manual:false}];f.workout.record={planVersion:1,exercises:[{id:'move-1',sets:1,seconds:60}]};
 assert.equal(result(f).exercise.training.done,'20');assert.equal(result(f).exercise.rows[1].state,'部分完成');
 f.workout.record.planVersion=2;assert.equal(result(f).exercise.training.done,'待确认');
});
