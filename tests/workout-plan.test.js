const {test}=require('node:test'),assert=require('node:assert/strict');
const {memoryCloud,loadEntry}=require('./fixtures/cloud-runtime');
const w=require('../shared/workout'),d=require('../shared/domain'),b=require('../server/business'),plans=require('../server/workout-plan');
const assessment={schemaVersion:2,consent:true,screening:'clear',age:28,sex:'male',height:175,weight:70,waist:'',goal:'habit',experience:'beginner',activity:'light',minutes:15,frequency:3,weekdays:[1,3,5],equipment:'none',foodScene:'takeout',foodObstacle:'irregular',diet:'none',allergies:''};
const now=Date.parse('2026-11-04T12:00:00+08:00'),cfg={aiEnabled:true};
const event={action:'workout.plan.ensure',requestId:'request-workout-1'};
async function runtime(){const memory=memoryCloud(),base=memory.db.runTransaction;let tail=Promise.resolve();memory.db.runTransaction=fn=>{const result=tail.then(()=>base(fn));tail=result.catch(()=>{});return result;};const r=memory.scope('test');await r.transact('same-user',s=>{s.orders=[{id:'paid',status:'paid',sku:'month',months:1,paidAt:now-10*d.DAY}];s.records.assessment={kind:'assessment',version:1,value:assessment};});return r;}
function output(c){return {days:Array.from({length:(Date.parse(c.to)-Date.parse(c.from))/d.DAY+1},(_,i)=>{const date=w.shift(c.from,i),rest=!c.assessment.weekdays.includes(new Date(date).getUTCDay());return {date,title:rest?'轻松恢复':'下肢与稳定训练',reason:'根据可训练时间与身体恢复安排。',rest,seconds:rest?0:900,energyKcal:rest?0:40,exercises:rest?[]:[{name:'站姿交替提膝',cue:'站立保持躯干稳定，缓慢交替提膝。',equipment:'none',mode:'time',sets:2,reps:null,seconds:120},{name:'靠墙半蹲',cue:'背部贴墙，浅蹲后平稳站起。',equipment:'none',mode:'reps',sets:2,reps:8,seconds:80}]};})};}
function record(day,plan){return {planId:plan.id,planVersion:day.planVersion,date:day.date,status:'completed',exercises:day.exercises.map(x=>({id:x.id,sets:x.sets,reps:x.reps,seconds:x.seconds})),completedSets:4,seconds:200,difficulty:'okay',discomfort:false,at:now};}
test('Shanghai weeks cover Monday, Sunday, year boundaries and midnight',()=>{
 assert.deepEqual(w.week('2026-11-02'),{start:'2026-11-02',end:'2026-11-08'});
 assert.deepEqual(w.week('2026-11-08'),{start:'2026-11-02',end:'2026-11-08'});
 assert.deepEqual(w.week('2027-01-01'),{start:'2026-12-28',end:'2027-01-03'});
 assert.equal(w.week(d.localDate(Date.parse('2026-11-08T16:00:00Z'))).start,'2026-11-09');
});
test('first open generates only today through Sunday and accepts new timed and counted moves',async()=>{
 const r=await runtime(),result=await plans.handle(event,r,cfg,now,async c=>output(c));
 assert.equal(result.status,'ready');assert.equal(result.plan.days.length,5);assert.equal(result.plan.days[0].date,'2026-11-04');assert.equal(result.plan.days.at(-1).date,'2026-11-08');
 assert.equal(result.plan.days[0].exercises[0].name,'站姿交替提膝');assert.equal(result.plan.days[0].exercises[0].reps,null);assert.equal(result.plan.days[1].rest,true);
 const food=await r.transact('same-user',s=>s.entitlement);assert.equal(food,null);
});
test('Sunday first open creates one day and next Monday creates another natural week',async()=>{
 const r=await runtime();const sunday=Date.parse('2026-11-08T12:00:00+08:00');
 const a=await plans.handle(event,r,cfg,sunday,async c=>output(c));assert.equal(a.plan.days.length,1);
 const next=await plans.handle(event,r,cfg,sunday+d.DAY,async c=>output(c));assert.equal(next.plan.days.length,7);assert.notEqual(next.plan.id,a.plan.id);
});
test('same-week repeated opens and concurrent calls do not duplicate model requests',async()=>{
 const r=await runtime();let resolve,count=0;
 const first=plans.handle(event,r,cfg,now,async c=>{count++;await new Promise(done=>{resolve=done;});return output(c);});
 while(!resolve)await new Promise(done=>setImmediate(done));
 const second=await plans.handle({...event,requestId:'request-workout-2'},r,cfg,now,async()=>{throw new Error('duplicate');});assert.equal(second.status,'generating');
 resolve();await first;
 await plans.handle(event,r,cfg,now+d.DAY,async()=>{throw new Error('duplicate');});assert.equal(count,1);
});
test('membership and valid assessments are required before provider execution',async()=>{
 const r=await runtime();await r.transact('same-user',s=>{s.orders=[];});
 await assert.rejects(plans.handle(event,r,cfg,now,output),{code:'MEMBERSHIP_REQUIRED'});
 const another=await runtime();await another.transact('same-user',s=>{s.records={};});
 await assert.rejects(plans.handle(event,another,cfg,now,output),/评测/);
});
test('AI schema rejects missing dates, duplicate dates, unsupported equipment, excessive load and calories',()=>{
 const c={assessment,from:'2026-11-04',to:'2026-11-08'};
 for(const mutate of [x=>x.days.pop(),x=>x.days[1].date=x.days[0].date,x=>x.days[0].exercises[0].equipment='band',x=>x.days[0].exercises[0].sets=6,x=>x.days[0].energyKcal=10000,x=>x.days[0].seconds=901,x=>x.days[0].exercises[0].cue='',x=>x.days[0].title='标题过长'.repeat(10)]){
  const x=output(c);mutate(x);assert.throws(()=>plans.normalize(x,c,1));
 }
});
test('reevaluation keeps recorded days, permits partial edits, and retains immutable versions',async()=>{
 const r=await runtime(),first=await plans.handle(event,r,cfg,now,output),day=first.plan.days[0],v=record(day,first.plan);
 const snapshot=await plans.loadForRecord(r,'same-user',v);assert.ok(snapshot);
 await r.transact('same-user',s=>{const results=b.applyBatch(s,[{id:'record-request-1',kind:'workoutRecord',key:'workout:'+v.date,baseVersion:0,value:v}],now,{[v.planId+':'+v.planVersion]:snapshot});assert.equal(results[0].status,'ok');s.records.assessment.version++;s.records.assessment.value={...assessment,minutes:30};});
 const second=await plans.handle(event,r,cfg,now,async c=>{const result=output(c);for(const row of result.days)row.title='更新后的方案';return result;});
 assert.equal(second.plan.version,2);assert.equal(second.plan.days[0].planVersion,1);assert.equal(second.plan.days[2].title,'更新后的方案');
 const read=await plans.handle({action:'workout.plan.get',from:v.date,to:v.date},r,cfg,now);assert.equal(read.plans[0].days[0].title,day.title);
 await r.transact('same-user',s=>{const edited={...v,status:'partial',exercises:v.exercises.map(x=>({...x,sets:1})),completedSets:2};const results=b.applyBatch(s,[{id:'record-request-2',kind:'workoutRecord',key:'workout:'+v.date,baseVersion:1,value:edited}],now,{[v.planId+':'+v.planVersion]:snapshot});assert.equal(results[0].status,'ok');});
});
test('Thursday can become training after a zero-volume recovery, including a cached reassessment',async()=>{
 const thursday=now+d.DAY,date=d.localDate(thursday),reassessment={...assessment,weekdays:[2,4,6]};
 const thursdayRecovery=c=>({days:output(c).days.map(day=>day.date===date?output({...c,assessment}).days.find(day=>day.date===date):day)});
 for(const cached of [false,true]){
  const r=await runtime();
  if(cached)await r.transact('same-user',s=>{s.records.assessment={...s.records.assessment,version:2,value:reassessment};});
  const original=await plans.handle(event,r,cfg,now,thursdayRecovery);
  const oldDay=original.plan.days.find(day=>day.date===date);
  const recovery={planId:original.plan.id,planVersion:oldDay.planVersion,date,status:'recovery',exercises:[],completedSets:0,seconds:0,difficulty:'unknown',discomfort:false,at:thursday};
  await r.transact('same-user',s=>{
   const saved=b.applyBatch(s,[{id:'recovery-1',kind:'workoutRecord',key:'workout:'+date,baseVersion:0,value:recovery}],thursday,{[recovery.planId+':1']:original.plan});
   assert.equal(saved[0].status,'ok');
   // A cached snapshot may already have the latest assessment key but still include the locked recovery.
   s.records.assessment={kind:'assessment',version:2,value:reassessment,revision:++s.revision};
  });
  await assert.rejects(plans.handle(event,r,cfg,thursday,thursdayRecovery),{code:'AI_UNAVAILABLE'});
  const failure=await r.auxTransact('same-user','workout:'+w.week(date).start,row=>row.failure);
  assert.equal(failure.reason,'缺少复评后的今日训练');
  const result=await plans.handle(event,r,cfg,thursday,async c=>{
   assert.equal(c.calendar[0].trainingRequired,true);
   return output(c);
  });
  assert.equal(result.plan.days[0].planVersion,1);
  assert.equal(result.plan.days.find(day=>day.date===date).rest,false);
  const api=loadEntry('coach_test',r,{now:thursday});
  const read=await api({action:'workout.plan.get',from:date});
  const day=read.data.plans[0].days.find(day=>day.date===date);
  assert.equal(day.planVersion,2);
  assert.equal(day.rest,false);
  const saved=await api({action:'sync.batch',owner:'same-user',operations:[{
   id:'thursday-training',kind:'workoutRecord',key:'workout:'+date,baseVersion:1,value:{...record(day,result.plan),at:thursday}
  }]});
  assert.equal(saved.data.results[0].status,'ok');
  assert.equal(saved.data.state.records['workout:'+date].value.completedSets,4);
 }
});
test('a recovery with discomfort remains bound to its original day after reassessment',async()=>{
 const r=await runtime(),thursday=now+d.DAY,date=d.localDate(thursday),first=await plans.handle(event,r,cfg,now,output);
 await r.transact('same-user',s=>{
  s.records['workout:'+date]={kind:'workoutRecord',version:1,revision:1,value:{date,planVersion:1,status:'recovery',completedSets:0,seconds:0,discomfort:true}};
  s.records.assessment={...s.records.assessment,version:2,revision:2,value:{...assessment,weekdays:[2,4,6]}};
 });
 const result=await plans.handle(event,r,cfg,thursday,output);
 assert.deepEqual(result.plan.days.find(day=>day.date===date),first.plan.days.find(day=>day.date===date));
});
test('a recovery recorded after the latest assessment does not trigger regeneration',async()=>{
 const r=await runtime(),date=d.localDate(now);
 await r.transact('same-user',s=>{s.records.assessment.revision=1;s.revision=1;});
 const first=await plans.handle(event,r,cfg,now,async c=>({days:output(c).days.map(day=>day.date===date?
  {...day,rest:true,exercises:[],seconds:0,energyKcal:0}:day)}));
 await r.transact('same-user',s=>{
  s.records['workout:'+date]={kind:'workoutRecord',version:1,revision:2,value:{date,planVersion:1,status:'recovery',completedSets:0,seconds:0,discomfort:false}};
 });
 const result=await plans.handle(event,r,cfg,now,()=>{throw new Error('unexpected generation');});
 assert.equal(result.plan.version,first.plan.version);
 assert.equal(result.plan.days[0].rest,true);
});
test('record saved during generation wins and stale model results cannot overwrite reassessment',async()=>{
 const r=await runtime(),first=await plans.handle(event,r,cfg,now,output);
 await r.transact('same-user',s=>{s.records.assessment.version++;});
 await plans.handle(event,r,cfg,now,async c=>{await r.transact('same-user',s=>{s.records['workout:2026-11-04']={kind:'workoutRecord',version:1,value:record(first.plan.days[0],first.plan)};});return output(c);});
 let current=await plans.handle({action:'workout.plan.get',from:'2026-11-04'},r,cfg,now);assert.equal(current.plans[0].days[0].planVersion,1);
 await r.transact('same-user',s=>{s.records.assessment.version++;});
 await assert.rejects(plans.handle(event,r,cfg,now,async c=>{await r.transact('same-user',s=>{s.records.assessment.version++;});return output(c);}),{code:'VERSION_CONFLICT'});
 current=await plans.handle({action:'workout.plan.get',from:'2026-11-04'},r,cfg,now);assert.equal(current.plans[0].version,2);
});
test('failure preserves previous plan and a retry can recover without a rules fallback',async()=>{
 const r=await runtime();await plans.handle(event,r,cfg,now,output);await r.transact('same-user',s=>{s.records.assessment.version++;});
 await assert.rejects(plans.handle(event,r,cfg,now,()=>{throw new Error('timeout');}),{code:'AI_UNAVAILABLE'});
 const result=await plans.handle({action:'workout.plan.get',from:'2026-11-04'},r,cfg,now);assert.equal(result.states[0].status,'failed');assert.equal(result.plans[0].version,1);
 const retried=await plans.handle(event,r,cfg,now,output);assert.equal(retried.status,'ready');assert.equal(retried.plan.version,2);
});
test('generation diagnostics retain only known validation reasons and never provider content',async()=>{
 const r=await runtime();
 await assert.rejects(plans.handle(event,r,cfg,now,async()=>({days:[]})),{code:'AI_UNAVAILABLE'});
 const first=await r.auxTransact('same-user','workout:2026-11-02',row=>row.failure);assert.equal(first.reason,'生成日期不完整');
 await assert.rejects(plans.handle(event,r,cfg,now,()=>{throw new Error('private-provider-data');}),{code:'AI_UNAVAILABLE'});
 const second=await r.auxTransact('same-user','workout:2026-11-02',row=>row.failure);assert.equal(second.reason,null);assert.ok(!JSON.stringify(second).includes('private-provider-data'));
});
test('future records, forged actions, wrong versions and unpaid days are rejected; historical edits use optimistic versions',async()=>{
 const r=await runtime(),result=await plans.handle(event,r,cfg,now,output),v=record(result.plan.days[0],result.plan),snapshot=result.plan;
 for(const patch of [{date:'2026-11-06'},{planVersion:99},{exercises:v.exercises.map(x=>({...x,id:'move-99'}))}]){
  const value={...v,...patch};await r.transact('same-user',s=>{const res=b.applyBatch(s,[{id:'invalid-request-'+Math.random().toString(36).slice(2),kind:'workoutRecord',key:'workout:'+value.date,baseVersion:0,value}],now,{[v.planId+':1']:snapshot});assert.equal(res[0].status,'invalid');});
 }
 await r.transact('same-user',s=>{
  const op={id:'valid-request-1',kind:'workoutRecord',key:'workout:'+v.date,baseVersion:0,value:v},archive={[v.planId+':1']:snapshot};
  assert.equal(b.applyBatch(s,[op],now+d.DAY,archive)[0].status,'ok');assert.equal(b.applyBatch(s,[{...op,id:'conflict-request'}],now+d.DAY,archive)[0].status,'conflict');
  s.orders=[];assert.equal(b.applyBatch(s,[{...op,id:'unpaid-request',baseVersion:1}],now+d.DAY,archive)[0].status,'invalid');
 });
});
test('manual records replace legacy session statistics, recovery does not count as training',()=>{
 const legacy={kind:'session',value:{date:'2026-11-04',status:'completed',completedSets:9,seconds:500}},manual={kind:'workoutRecord',value:{date:'2026-11-04',status:'partial',completedSets:2,seconds:60}};
 assert.equal(w.sessions({legacy,manual}).length,1);assert.equal(w.sessions({legacy,manual})[0].value.completedSets,2);
 assert.equal(w.sessions({legacy,manual:{...manual,value:{...manual.value,status:'recovery'}}}).length,0);
});
test('context includes four-week manual data, fatigue and preferences without inventing legacy per-move data',async()=>{
 const r=await runtime(),s=await r.transact('same-user',s=>s);s.records.old={kind:'session',value:{date:'2026-09-01',completedSets:1}};s.records.recent={kind:'session',value:{date:'2026-11-03',completedSets:4}};s.records.feedback={kind:'dailyFeedback',value:{date:'2026-11-03',fatigue:'high'}};s.records.preference={kind:'preference',value:{text:'避免跳跃',active:true}};
 const c=plans.context(s,'2026-11-04');assert.equal(c.history.length,1);assert.equal(c.history[0].exercises,undefined);assert.equal(c.feedback[0].fatigue,'high');assert.deepEqual(c.preferences,['避免跳跃']);
 assert.deepEqual(c.calendar.map(x=>[x.date,x.weekdayLabel,x.trainingAllowed]),[['2026-11-04','周三',true],['2026-11-05','周四',false],['2026-11-06','周五',true],['2026-11-07','周六',false],['2026-11-08','周日',false]]);
});
test('explicit calendar handles Sunday zero and a year boundary while keeping forbidden dates blocked',async()=>{
 const r=await runtime(),s=await r.transact('same-user',s=>s);s.records.assessment.value={...assessment,weekdays:['0','2','4']};
 const c=plans.context(s,'2026-12-31');assert.deepEqual(c.calendar.map(x=>[x.date,x.weekday,x.trainingAllowed]),[['2026-12-31',4,true],['2027-01-01',5,false],['2027-01-02',6,false],['2027-01-03',0,true]]);
 const bad={days:c.calendar.map(x=>({date:x.date,title:'训练',reason:'训练安排',rest:false,seconds:900,energyKcal:35,exercises:[{name:'提膝',cue:'缓慢交替提膝',equipment:'none',mode:'time',sets:1,reps:null,seconds:60}]}))};
 assert.throws(()=>plans.normalize(bad,c,1),/训练日期与评测不一致/);
});
test('coach entry exposes workout APIs, feature flag, and validates manual records through sync.batch',async()=>{
 const r=await runtime(),generated=await plans.handle(event,r,cfg,now,output),api=loadEntry('coach_test',r,{now});
 const boot=await api({action:'bootstrap'});assert.equal(boot.code,0);assert.equal(boot.data.config.workoutPlansSupported,true);
 const read=await api({action:'workout.plan.get',from:'2026-11-04',to:'2026-11-08'});assert.equal(read.code,0);assert.equal(read.data.plans[0].id,generated.plan.id);
 const ensured=await api(event);assert.equal(ensured.code,0);assert.equal(ensured.data.plan.version,1);
 const value=record(generated.plan.days[0],generated.plan);
 const move=value.exercises[1];
 move.difficulty='okay';
 move.setDetails=[
  {completed:true,weightKg:7.5,reps:8,seconds:40},
  {completed:true,weightKg:10,reps:9,seconds:40}
 ];
 const key='workout:'+value.date;
 const synced=await api({action:'sync.batch',owner:'same-user',operations:[{id:'entry-record-request',kind:'workoutRecord',key,baseVersion:0,value}]});
 assert.equal(synced.code,0);assert.equal(synced.data.results[0].status,'ok');
 const saved=synced.data.state.records[key].value;
 assert.equal(saved.completedSets,4);
 assert.deepEqual(saved.exercises[1],move);
});
test('workout API authentication uses trusted context and rejects cross-owner record synchronization',async()=>{
 const r=await runtime(),api=loadEntry('coach_test',r,{now});
 const wrong=await api({action:'sync.batch',owner:'another-user',operations:[]});assert.equal(wrong.code,'ACCOUNT_CHANGED');
 r.cloud.getWXContext=()=>({OPENID:''});const anonymous=await api({action:'workout.plan.get',OPENID:'same-user',from:'2026-11-04'});assert.equal(anonymous.code,'UNAUTHORIZED');
});

test('target muscles are optional, trimmed and validated without rewriting legacy plans',()=>{
 const c={assessment,from:'2026-11-04',to:'2026-11-04'},plain=output(c);
 assert.equal(plans.normalize(plain,c,1)[0].exercises[0].targetMuscles,undefined);
 const move=plain.days[0].exercises[0];move.targetMuscles=[' 核心 ','腿部','核心'];assert.deepEqual(plans.normalize(plain,c,1)[0].exercises[0].targetMuscles,['核心','腿部']);
 for(const invalid of ['核心',[''],['a'.repeat(13)],['一','二','三','四','五'],[null]]){move.targetMuscles=invalid;assert.throws(()=>plans.normalize(plain,c,1),/动作说明/);}
});
