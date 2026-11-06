const {test}=require('node:test'),assert=require('node:assert/strict');
const d=require('../shared/domain'),g=require('../shared/guidance'),w=require('../shared/workout');
const explanation=require('../miniprogram/services/energy-explanation');
const date='2026-11-05';
const a={schemaVersion:3,consent:true,screening:'clear',age:28,sex:'male',height:175,weight:70,targetWeight:65,pace:'moderate',stepGoal:8000,waist:'',goal:'habit',experience:'beginner',activity:'light',minutes:15,frequency:3,weekdays:[1,3,4],equipment:'none',foodScene:'cook',foodObstacle:'irregular',diet:'none',allergies:''};
function fixture(){
 const plan=d.makePlan(a,{},{nutritionReviewed:true,startDate:date}),week=w.week(date);
 const day={date,planVersion:1,title:'力量训练',rest:false,energyKcal:90,seconds:900,exercises:[{id:'move-0',name:'深蹲',mode:'reps',sets:3,reps:12,seconds:180}]};
 return {date,active:true,day:1,today:plan.days[0],config:{},membership:{segments:[]},entitlement:{id:'paid-plan',status:'active',credential:'local',startDate:date,plan},records:{},activitySteps:{[date]:{date,steps:4000,syncedAt:Date.parse(date+'T12:00:00+08:00')}},workoutWeeks:{[week.start]:{days:[day]}},workoutStates:{}};
}
test('explanation uses the same selected-day numbers as Today and actual body inputs',()=>{
 const vm=fixture(),x=explanation.view(vm,date),model=require('../miniprogram/services/dashboard'),calendar=model.calendar(vm,date);
 const daily=require('../miniprogram/services/daily').view(vm,date,calendar.view.task),workout=require('../miniprogram/services/workout').view(vm,date);
 const summary=require('../miniprogram/services/today-summary').view(vm,calendar,daily,workout);
 assert.deepEqual(x.diet,summary.diet);assert.deepEqual(x.exercise,summary.exercise);
 assert.equal(x.basal,'1659');assert.match(x.basalFormula,/10 × 70/);assert.match(x.basalFormula,/＋ 6.25 × 175/);assert.match(x.dietMethod,new RegExp(String(calendar.view.intake)));
 assert.ok(x.maintenanceDetails.some(line=>line.includes('步数修正')));assert.ok(x.trainingDetails.some(line=>line.includes('未取整')));
});
test('partial time and intake fractions produce the same actual totals in explanations',()=>{
 const vm=fixture();vm.records['workout:'+date]={kind:'workoutRecord',value:{planVersion:1,date,exercises:[{id:'move-0',sets:1,reps:12,seconds:60}]}};
 const id='analysis:paid-plan:'+date+':lunch';vm.records['meal:paid-plan:'+date+':lunch']={kind:'meal',value:{planId:'paid-plan',date,slot:'lunch',text:'半碗米饭',analysisIds:[id]}};
 vm.records[id]={kind:'mealAnalysis',value:{planId:'paid-plan',date,slot:'lunch',analysis:{consumed:{energyKcal:90}}}};
 const x=explanation.view(vm,date);assert.equal(x.exercise.training.done,'30');assert.equal(x.actions[0].target,'90');assert.equal(x.actions[0].done,30);assert.equal(x.diet.consumed,'90');
});
test('history uses saved targets and body inputs instead of current target changes',()=>{
 const vm=fixture(),old=structuredClone(vm.entitlement.plan),newAssessment={...a,weight:68,targetWeight:63};
 vm.entitlement.plan={...old,assessment:newAssessment,nutrition:g.nutrition(newAssessment,true),energyTargets:g.energyTargets(newAssessment),targetHistory:[{effectiveFrom:date,assessment:old.assessment,nutrition:old.nutrition,energyTargets:old.energyTargets},{effectiveFrom:'2026-11-06',assessment:newAssessment,nutrition:g.nutrition(newAssessment,true),energyTargets:g.energyTargets(newAssessment)}]};vm.date='2026-11-06';
 const x=explanation.view(vm,date);assert.equal(x.basal,'1659');assert.equal(x.diet.target,String(old.nutrition.energy));assert.match(x.inputs,/70 千克/);assert.equal(x.isToday,false);
});
test('unknown inputs stay unknown; rest and future explain their own states',()=>{
 const vm=fixture();delete vm.activitySteps[date];let x=explanation.view(vm,date);assert.equal(x.exercise.activity.done,'待同步');assert.equal(x.exercise.done,'待确认');
 vm.workoutWeeks[w.week(date).start].days[0]={date,planVersion:1,rest:true,title:'恢复',energyKcal:0,exercises:[]};x=explanation.view(vm,date);assert.match(x.trainingDetails[0],/无需记录/);
 vm.date='2026-11-04';assert.equal(explanation.view(vm,date).future,true);
 const empty={...fixture(),entitlement:null,today:null,active:false,workoutWeeks:{},records:{}};x=explanation.view(empty,date);assert.equal(x.basal,'待确认');assert.equal(x.diet.target,'待补充评测');assert.doesNotMatch(x.basalFormula,/NaN/);
});
test('legacy nutrition formula is distinguished from newer target calculation',()=>{
 const vm=fixture(),assessment={...a,schemaVersion:2};delete assessment.targetWeight;
 vm.entitlement.plan=d.makePlan(assessment,{},{nutritionReviewed:true,startDate:date});vm.today=vm.entitlement.plan.days[0];
 const x=explanation.view(vm,date);assert.match(x.dietMethod,/原有方案/);assert.match(x.dietDetails[0],/50 千卡/);assert.ok(x.maintenanceDetails.every(line=>!line.includes('每日平均训练量')));
});
