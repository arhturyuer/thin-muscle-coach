const {test}=require('node:test'),assert=require('node:assert/strict');
const g=require('../shared/guidance'),d=require('../shared/domain'),steps=require('../server/activity-steps'),guided=require('../server/guided'),meal=require('../server/meal-plan');
const {memoryCloud}=require('./fixtures/cloud-runtime');
const a={schemaVersion:3,consent:true,screening:'clear',age:28,sex:'male',height:175,weight:70,targetWeight:65,pace:'moderate',stepGoal:6000,waist:'',goal:'habit',experience:'beginner',activity:'light',minutes:15,frequency:3,weekdays:[1,3,5],equipment:'none',foodScene:'cook',foodObstacle:'irregular',diet:'none',allergies:''};
const make=(patch={})=>d.makePlan({...a,...patch},{},{nutritionReviewed:true,startDate:'2026-11-02'});
test('new assessments require target, pace, integer steps and suitable target BMI; v2 stays readable',()=>{
 assert.equal(g.validate(a),'');assert.equal(d.validateAssessment(a),'');
 for(const patch of [{targetWeight:''},{targetWeight:45},{targetWeight:100},{pace:'extreme'},{stepGoal:999},{stepGoal:20001},{stepGoal:5000.5}])assert.ok(g.validate({...a,...patch}));
 const old={...a,schemaVersion:2};delete old.targetWeight;assert.equal(g.validate(old),'');assert.ok(d.makePlan(old));
});
test('basal estimate uses current weight and sex, not target weight',()=>{
 assert.equal(g.basal(a),1658.75);assert.equal(g.basal({...a,sex:'female'}),1492.75);
 assert.equal(make().energyTargets.basalKcal,make({targetWeight:60}).energyTargets.basalKcal);
 for(const sex of ['male','female'])for(const activity of ['sedentary','light','active'])assert.ok(make({sex,activity}).nutrition.energy>=g.basal({...a,sex,activity}));
});
test('paces have ordered energy and periods; capped fast pace extends its theoretical period',()=>{
 const rows=['gentle','moderate','fast'].map(pace=>make({pace}).energyTargets);
 assert.ok(rows[0].intakeKcal>=rows[1].intakeKcal&&rows[1].intakeKcal>=rows[2].intakeKcal);
 assert.ok(rows[0].estimatedWeeks>=rows[1].estimatedWeeks&&rows[1].estimatedWeeks>=rows[2].estimatedWeeks);
 assert.ok(rows[2].limited);assert.ok(rows[2].estimatedWeeks>Math.ceil(5/(70*.0075)));
 assert.equal(make().nutrition.energy,make().energyTargets.intakeKcal);
});
test('gain uses independent capped surplus and maintenance has no completion deadline',()=>{
 const p=make({targetWeight:75,pace:'fast'}),t=p.energyTargets;
 assert.equal(t.direction,'gain');assert.ok(t.intakeKcal-t.maintenanceKcal<=300);assert.ok(t.intakeKcal-t.maintenanceKcal<=t.maintenanceKcal*.1+1);
 assert.ok(t.estimatedWeeks>0);assert.equal(make({targetWeight:70.1}).energyTargets.direction,'maintain');assert.equal(make({targetWeight:70}).energyTargets.estimatedWeeks,null);
});
test('activity baseline counts only step differences and weekly training once',()=>{
 const p=make(),t=p.energyTargets;
 assert.equal(t.maintenanceKcal,Math.round(g.basal(a)*1.375+g.training(a)*3/7));
 const extra=make({stepGoal:7000}).energyTargets;
 assert.ok(Math.abs(extra.maintenanceKcal-t.maintenanceKcal-g.walking(a,1000))<1);
 const train=g.dailyEnergy(p,p.days.find(x=>!x.rest),15),rest=g.dailyEnergy(p,p.days.find(x=>x.rest),15);
 assert.equal(train.activityKcal,train.trainingKcal+train.walkingKcal);assert.equal(rest.trainingKcal,0);assert.equal(rest.walkingKcal,train.walkingKcal);
 assert.equal(rest.intakeKcal,train.intakeKcal);
});
test('daily shortening/rest/undo change activity target without changing food or adding walking',()=>{
 const p=make(),e={id:'week-test',plan:p},date='2026-11-02',original=p.days[0],key=require('../shared/daily').overrideKey(e.id,date,'workout');
 const records={[key]:{value:{active:true,minutes:5,task:{...original,rest:false}}}};
 const view=require('../shared/daily').effective(records,e,date,original),short=g.dailyEnergy(p,view.task,view.minutes),normal=g.dailyEnergy(p,original,15);
 assert.ok(short.trainingKcal<normal.trainingKcal);assert.equal(short.walkingKcal,normal.walkingKcal);assert.equal(short.intakeKcal,normal.intakeKcal);
 records[key].value.task={rest:true,exercises:[]};assert.equal(g.dailyEnergy(p,require('../shared/daily').effective(records,e,date,original).task,0).trainingKcal,0);
 records[key].value.active=false;assert.equal(require('../shared/daily').effective(records,e,date,original).minutes,15);
});
test('unreviewed numeric plans stay gated and cannot silently generate quantitative recipes',()=>{
 const p=d.makePlan(a);assert.equal(p.energyTargets,undefined);assert.equal(p.nutrition.energy,undefined);
 assert.throws(()=>meal.context({entitlement:{plan:p}},'2026-11-02'),/尚未开放/);
});
test('recipe receives stored target and version, no steps, rather than recomputing assessment needs',()=>{
 const p=make();p.nutrition.energy=1999;const c=meal.context({entitlement:{plan:p},records:{}},'2026-11-02');
 assert.equal(c.targets.energy,1999);assert.equal(c.targetVersion,p.energyTargets.version);assert.equal(c.assessment.stepGoal,undefined);
});
test('target settings apply today, preserve past dates and training, and survive weekly review',async()=>{
 const runtime=memoryCloud().scope('test'),now=Date.parse('2026-11-04T12:00:00+08:00');
 await runtime.transact('same-user',s=>{s.orders=[{id:'paid',sku:'month',months:1,status:'paid',paidAt:now-1000}];s.entitlement={id:'week-test',memberPlan:true,version:1,plan:make(),startDate:'2026-11-02',status:'active',expiresAt:now+d.DAY};});
 const before=await runtime.transact('same-user',s=>structuredClone(s.entitlement));
 const event={action:'plan.targets.update',assessment:{...a,targetWeight:64,pace:'gentle'},baseVersion:1,baseTargetsVersion:0,requestId:'target-update'};
 await guided.handle(event,runtime,{nutritionReviewed:true},now);
 await guided.handle(event,runtime,{nutritionReviewed:true},now);
 await assert.rejects(guided.handle({...event,requestId:'stale-target'},runtime,{},now),e=>e.code==='VERSION_CONFLICT');
 const state=await runtime.transact('same-user',s=>s),updated=state.entitlement;
 assert.equal(updated.id,before.id);assert.equal(updated.version,before.version);assert.deepEqual(updated.plan.days,before.plan.days);assert.equal(state.nextAdjustment,undefined);
 assert.equal(updated.plan.assessment.targetWeight,64);assert.equal(updated.plan.assessment.pace,'gentle');assert.equal(state.targetsVersion,1);
 assert.equal(g.planForDate(updated.plan,'2026-11-03').assessment.targetWeight,65);
 assert.equal(g.planForDate(updated.plan,'2026-11-04').assessment.targetWeight,64);
 assert.notEqual(updated.plan.energyTargets.version,before.plan.energyTargets.version);
 assert.equal(meal.context(state,'2026-11-04').targets.energy,updated.plan.nutrition.energy);
 assert.equal(meal.context(state,'2026-11-03').targets.energy,before.plan.nutrition.energy);
 const dashboard=require('../miniprogram/services/dashboard'),vm={date:'2026-11-04',entitlement:updated,records:{},active:true,day:3,today:updated.plan.days[2]};
 assert.equal(dashboard.calendar(vm,'2026-11-03').view.intake,before.plan.nutrition.energy);
 assert.equal(dashboard.calendar(vm).view.intake,updated.plan.nutrition.energy);
 const proposal=guided.proposal(state,{difficulty:'okay',fatigue:'okay',hunger:'okay'});assert.equal(proposal.assessment.pace,'gentle');
 await assert.rejects(guided.handle({...event,baseVersion:2},runtime,{},now),e=>e.code==='VERSION_CONFLICT');
});
const fixedNow=Date.parse('2026-11-04T12:00:00+08:00');
async function stepRuntime(){const runtime=memoryCloud().scope('test');await runtime.transact('same-user',()=>{});runtime.cloud.getWXContext=()=>({OPENID:'same-user',APPID:'wx-test'});return runtime;}
function data(now=fixedNow,values=[['2026-11-04',1234]]){return {list:[{cloudID:'cloud-id',data:{watermark:{appid:'wx-test',timestamp:Math.floor(now/1000)},stepInfoList:values.map(([date,step])=>({timestamp:Date.parse(date+'T00:00:00+08:00')/1000,step}))}}]};}
const event={consent:true,cloudID:'cloud-id'};
test('steps use verified server open data, overwrite daily counts and preserve real zero',async()=>{
 const r=await stepRuntime();r.cloud.getOpenData=async args=>{assert.deepEqual(args,{list:['cloud-id']});return data(fixedNow,[['2026-11-04',0]]);};
 let result=await steps.handle({...event,steps:99999},r,fixedNow);assert.equal(result.days['2026-11-04'].steps,0);
 r.cloud.getOpenData=async()=>data();result=await steps.handle(event,r,fixedNow);assert.equal(result.days['2026-11-04'].steps,1234);
 result=await steps.handle(event,r,fixedNow);assert.equal(result.days['2026-11-04'].steps,1234);
 assert.equal(JSON.stringify(result).includes('cloud-id'),false);
});
test('step reference excludes today, missing dates, and dates older than last seven complete dates',()=>{
 const days=Object.fromEntries([['2026-11-04',20000],['2026-11-03',1000],['2026-11-02',2000],['2026-11-01',3000],['2026-10-20',9000]].map(([date,steps])=>[date,{date,steps}]));
 assert.equal(steps.reference(days,'2026-11-04'),2000);delete days['2026-11-01'];assert.equal(steps.reference(days,'2026-11-04'),null);
});
test('step sync rejects consent absence, forged app and invalid counts',async()=>{
 const r=await stepRuntime();await assert.rejects(steps.handle({...event,consent:false},r,fixedNow));await assert.rejects(steps.handle({consent:true,steps:99},r,fixedNow));
 for(const patch of ['app','count']){r.cloud.getOpenData=async()=>{const x=data();if(patch==='app')x.list[0].data.watermark.appid='other';else x.list[0].data.stepInfoList[0].step=-1;return x;};await assert.rejects(steps.handle(event,r,fixedNow));}
});
test('out-of-order step requests and stale cloud data cannot overwrite newer data',async()=>{
 const r=await stepRuntime();let finish,started;const ready=new Promise(resolve=>started=resolve);
 r.cloud.getOpenData=()=>{started();return new Promise(resolve=>finish=resolve);};const pending=steps.handle(event,r,fixedNow);await ready;
 r.cloud.getOpenData=async()=>data(fixedNow+1000,[['2026-11-04',2000]]);await steps.handle(event,r,fixedNow+1000);
 finish(data());const old=await pending;assert.equal(old.days['2026-11-04'].steps,2000);
 r.cloud.getOpenData=async()=>data();assert.equal((await steps.handle(event,r,fixedNow+2000)).days['2026-11-04'].steps,2000);
});
test('account deletion invalidates an in-flight step request; environments stay separate',async()=>{
 const r=await stepRuntime();let finish,started;const ready=new Promise(resolve=>started=resolve);r.cloud.getOpenData=()=>{started();return new Promise(resolve=>finish=resolve);};
 const p=steps.handle(event,r,fixedNow);await ready;await r.transact('same-user',s=>{s.deletedAt=fixedNow;s.activitySteps={};});finish(data());await assert.rejects(p,e=>e.code==='ACCOUNT_CHANGED');
 const cloud=memoryCloud();await cloud.scope('test').transact('same-user',s=>{s.activitySteps={'2026-11-04':{steps:100}};});assert.equal((await cloud.scope('prod').transact('same-user',s=>s)).activitySteps,undefined);
});
test('Shanghai midnight creates a new step date without losing the previous day',async()=>{
 const r=await stepRuntime(),before=Date.parse('2026-11-04T23:59:59+08:00'),after=before+2000;
 r.cloud.getOpenData=async()=>data(before,[['2026-11-04',7000]]);await steps.handle(event,r,before);
 r.cloud.getOpenData=async()=>data(after,[['2026-11-04',7100],['2026-11-05',0]]);const result=await steps.handle(event,r,after);
 assert.equal(result.days['2026-11-04'].steps,7100);assert.equal(result.days['2026-11-05'].steps,0);
});
test('weekly multiple measurements update the next calculation, retain target, and keep current plan stable',()=>{
 const e={id:'week-test',memberPlan:true,version:1,plan:make(),startDate:'2026-11-02'},s={entitlement:e,records:{}},before=structuredClone(e);
 for(const [date,weight] of [['2026-10-28',70],['2026-10-29',70],['2026-10-30',70],['2026-11-02',69],['2026-11-03',69],['2026-11-04',69]])s.records[date]={kind:'measurement',value:{date,weight}};
 const p=guided.proposal(s,{difficulty:'okay',fatigue:'okay',hunger:'okay'});assert.equal(p.assessment.weight,69);assert.equal(p.assessment.targetWeight,65);assert.deepEqual(e,before);
 const next=make(p.assessment);assert.notEqual(next.energyTargets.basalKcal,e.plan.energyTargets.basalKcal);
});
test('repeated same-day saves retain yesterday baseline and completed records; tomorrow preserves today',async()=>{
 const runtime=memoryCloud().scope('test'),now=Date.parse('2026-11-04T12:00:00+08:00');
 await runtime.transact('same-user',s=>{s.orders=[{id:'paid',sku:'month',months:1,status:'paid',paidAt:now-1000}];s.entitlement={id:'week-test',memberPlan:true,version:1,plan:make(),startDate:'2026-11-02',status:'active',expiresAt:now+3*d.DAY};s.records.completed={kind:'session',value:{date:'2026-11-04',status:'completed'}};s.records.food={kind:'meal',value:{date:'2026-11-04',text:'已吃早餐'}};});
 const records=await runtime.transact('same-user',s=>structuredClone(s.records));
 for(let i=0;i<3;i++)await guided.handle({action:'plan.targets.update',assessment:{...a,targetWeight:64-i},baseVersion:1,baseTargetsVersion:i,requestId:'target-change-'+i},runtime,{nutritionReviewed:true},now+(i===2?d.DAY:0));
 const s=await runtime.transact('same-user',s=>s),p=s.entitlement.plan;
 assert.deepEqual(s.records,records);assert.equal(p.targetHistory.length,3);
 assert.equal(g.planForDate(p,'2026-11-03').assessment.targetWeight,65);assert.equal(g.planForDate(p,'2026-11-04').assessment.targetWeight,63);assert.equal(g.planForDate(p,'2026-11-05').assessment.targetWeight,62);
});
test('enabling test numbers upgrades an existing plan today without resetting records or declaring review',()=>{
 const p=d.makePlan(a,{}, {startDate:'2026-11-02'}),s={revision:1,records:{meal:{kind:'meal',value:{text:'已吃早餐'}}},entitlement:{id:'existing',version:4,memberPlan:true,startDate:'2026-11-02',plan:p}};
 const originalDays=structuredClone(p.days),records=structuredClone(s.records),now=Date.parse('2026-11-04T12:00:00+08:00');
 guided.enableNumericTargets(s,{numericTargetsEnabled:true,nutritionReviewed:false},now);
 assert.equal(s.entitlement.id,'existing');assert.equal(s.entitlement.version,4);assert.deepEqual(s.entitlement.plan.days,originalDays);assert.deepEqual(s.records,records);
 assert.equal(s.entitlement.plan.nutrition.numericEnabled,true);assert.equal(s.entitlement.plan.nutrition.reviewed,false);assert.ok(s.entitlement.plan.energyTargets.basalKcal>0);assert.ok(s.entitlement.plan.nutrition.energy>0);
 assert.equal(g.planForDate(s.entitlement.plan,'2026-11-03').nutrition.energy,undefined);assert.ok(g.planForDate(s.entitlement.plan,'2026-11-04').nutrition.energy>0);
 const rev=s.revision;guided.enableNumericTargets(s,{numericTargetsEnabled:true},now);assert.equal(s.revision,rev);
 const vm={date:'2026-11-04',entitlement:s.entitlement,records:{},active:true,day:3,today:s.entitlement.plan.days[2]};
 assert.equal(require('../miniprogram/services/dashboard').calendar(vm).view.intake,s.entitlement.plan.nutrition.energy);
 assert.equal(meal.context(s,'2026-11-04').targets.energy,s.entitlement.plan.nutrition.energy);
});
test('closed numeric display never upgrades stored plans and preserves actual review policy',()=>{
 const s={revision:1,entitlement:{memberPlan:true,plan:d.makePlan(a)}};guided.enableNumericTargets(s,{numericTargetsEnabled:false,nutritionReviewed:false});assert.equal(s.revision,1);assert.equal(s.entitlement.plan.nutrition.energy,undefined);
 const enabled=d.makePlan(a,{}, {numericTargetsEnabled:true,nutritionReviewed:false});assert.ok(enabled.energyTargets);assert.equal(enabled.nutrition.reviewed,false);
});
