const {test,beforeEach,afterEach}=require('node:test'),assert=require('node:assert/strict');
const {loadPage}=require('./fixtures/mini-runtime'),d=require('../shared/domain'),w=require('../shared/workout');
let store,date,plan,workout,calls,timer;
beforeEach(()=>{
 for(const key of Object.keys(require.cache))if(key.includes('/miniprogram/'))delete require.cache[key];
 timer=global.setTimeout;global.setTimeout=(fn,ms)=>{const t=timer(fn,ms);t.unref();return t;};
 const storage=new Map();global.wx={getStorageSync:k=>storage.get(k),setStorageSync:(k,v)=>storage.set(k,structuredClone(v)),removeStorageSync:k=>storage.delete(k),getAccountInfoSync:()=>({miniProgram:{envVersion:'release'}}),showToast(){},showModal:async()=>({confirm:true}),navigateTo(){},navigateBack(){}};
 date=d.localDate();const week=w.week(date);plan={id:'workout-'+week.start,version:1,weekStart:week.start,weekEnd:week.end,days:[{date,planVersion:1,title:'稳定与力量',reason:'结合评测与恢复安排。',rest:false,seconds:900,energyKcal:40,exercises:[{id:'move-0',name:'站姿提膝',cue:'保持稳定',equipment:'none',mode:'time',sets:2,reps:null,seconds:120},{id:'move-1',name:'靠墙半蹲',cue:'平稳站起',equipment:'none',mode:'reps',sets:2,reps:8,seconds:80}]}]};
 store=require('../miniprogram/core/store');store.identify('owner');store.save({membership:{active:true,segments:[{startsAt:Date.now()-7*d.DAY,expiresAt:Date.now()+7*d.DAY}]},config:{workoutPlansSupported:true,aiEnabled:true},workoutWeeks:{[week.start]:plan},workoutStates:{[week.start]:{status:'ready'}},records:{},online:true});
 calls=[];wx.cloud={callFunction:async({data})=>{calls.push(data);const result=data.action==='workout.plan.ensure'?{status:'ready',plan}:data.action==='workout.plan.get'?{plans:[plan],states:[{weekStart:week.start,status:'ready'}]}:{results:[],state:{incremental:true,records:{}}};return {result:{code:0,stage:'prod',data:result}};}};
 workout=require('../miniprogram/services/workout');
});
afterEach(()=>{global.setTimeout=timer;delete global.wx;for(const key of Object.keys(require.cache))if(key.includes('/miniprogram/'))delete require.cache[key];});
test('record page starts with planned unchecked sets and timed moves use seconds',async()=>{
 const page=loadPage('exercise-record');page.onLoad({date});await page.onShow();
 assert.deepEqual(page.data.rows[0].setDetails.map(x=>[x.completed,x.reps,x.seconds]),[[false,'','60'],[false,'','60']]);
 assert.deepEqual(page.data.rows[1].setDetails.map(x=>[x.completed,x.reps]),[[false,'8'],[false,'8']]);
 const vm=require('../miniprogram/services/coach').snapshot();assert.equal(workout.view(vm,w.shift(date,1)).canRecord,false);page.onHide();
});
test('offline partial completion persists locally; editing reuses the record key and sync base version',async()=>{
 store.save({online:false});await workout.save(date,[{sets:'1',seconds:'60'},{}]);
 const key='workout:'+date,row=store.get().records[key];assert.equal(row.value.status,'partial');assert.equal(row.value.exercises[0].reps,null);assert.equal(row.value.exercises[1].sets,0);assert.equal(store.get().queue.length,1);
 await workout.save(date,[{sets:'2',seconds:'120'},{sets:'2',reps:'8',seconds:'80'}]);
 assert.equal(store.get().queue.length,1);assert.equal(store.get().queue[0].baseVersion,0);assert.equal(store.get().records[key].value.status,'completed');
 const page=loadPage('exercise-record');page.onLoad({date});page.onShow();
 assert.deepEqual(page.data.rows[0].setDetails.map(x=>[x.completed,x.seconds]),[[true,'60'],[true,'60']]);
 assert.deepEqual(page.data.rows[1].setDetails.map(x=>[x.completed,x.reps]),[[true,'8'],[true,'8']]);page.onHide();
});
test('per-set edits persist offline, keep unchecked sets, and pass shared validation',async()=>{
 store.save({online:false});
 const page=loadPage('exercise-record');page.onLoad({date});page.refresh();
 const event=(index,setIndex,value,field)=>({currentTarget:{dataset:{index,setIndex,field}},detail:{value}});
 page.removeSet(event(0));
 page.setInput(event(0,0,'45','seconds'));
 page.checkSet(event(0,0,['done']));
 page.difficulty(event(0,0,'easy'));
 page.addSet(event(1));
 page.setInput(event(1,0,'7.5','weightKg'));
 page.setInput(event(1,0,'10','reps'));
 page.checkSet(event(1,0,['done']));
 page.setInput(event(1,1,'9','reps'));
 page.checkSet(event(1,1,['done']));
 page.checkSet(event(1,1,[]));
 page.difficulty(event(1,0,'hard'));
 await page.save();
 const saved=store.get().records['workout:'+date].value;
 assert.equal(saved.completedSets,2);assert.equal(saved.seconds,85);assert.equal(saved.status,'partial');assert.equal(saved.difficulty,'hard');
 assert.deepEqual(saved.exercises.map(x=>[x.sets,x.difficulty]),[[1,'easy'],[1,'hard']]);
 assert.equal(w.matches(saved,plan.days[0]),true);
 const invalid=structuredClone(saved);invalid.exercises[1].setDetails[0].weightKg=-1;
 assert.equal(w.validRecord(invalid),false);
 invalid.exercises[1].setDetails[0].weightKg=7.5;invalid.exercises[1].setDetails[1].completed=true;
 assert.equal(w.validRecord(invalid),false);
 const reopened=loadPage('exercise-record');reopened.onLoad({date});reopened.refresh();
 assert.deepEqual(reopened.data.rows.map(x=>x.setDetails.length),[1,3]);
 assert.deepEqual(reopened.data.rows[1].setDetails.map(x=>[x.completed,x.weightKg,x.reps]),[[true,'7.5','10'],[false,'','9'],[false,'','8']]);
 assert.equal(reopened.data.rows[1].difficulty,'hard');
});
test('empty, fractional, negative and out of range actual values are rejected',async()=>{
 for(const rows of [[{},{}],[{sets:'-1',seconds:'10'},{}],[{sets:'1.5',seconds:'10'},{}],[{sets:'1000',seconds:'10'},{}],[{sets:'1',seconds:'0'},{}]])await assert.rejects(workout.save(date,rows),/填写/);
 assert.equal(store.get().queue.length,0);
});
test('past paid plan permits supplementation; future dates and dates outside membership are read-only',async()=>{
 const yesterday=w.shift(date,-1),week=w.week(yesterday),past={...plan,id:'workout-'+week.start,weekStart:week.start,weekEnd:week.end,days:[{...plan.days[0],date:yesterday}]};
 store.save({online:false,workoutWeeks:{...store.get().workoutWeeks,[week.start]:past}});await workout.save(yesterday,[{sets:1,seconds:60},{}]);assert.ok(store.get().records['workout:'+yesterday]);
 const future=w.shift(date,1),futureWeek=w.week(future);store.save({workoutWeeks:{[futureWeek.start]:{...plan,weekStart:futureWeek.start,days:[{...plan.days[0],date:future}]}}});
 await assert.rejects(workout.save(future,[]),/日期/);
 store.save({membership:{active:false,segments:[]}});assert.equal(workout.view(require('../miniprogram/services/coach').snapshot(),future).canRecord,false);
});
test('recovery records contain no invented workout and update calendar completion',async()=>{
 plan.days[0]={...plan.days[0],rest:true,seconds:0,energyKcal:0,exercises:[]};store.save({online:false,workoutWeeks:{[plan.weekStart]:plan}});await workout.save(date,[]);
 const vm=require('../miniprogram/services/coach').snapshot(),calendar=require('../miniprogram/services/dashboard').calendar(vm,date);
 assert.equal(calendar.weeks.flatMap(x=>x.days).find(x=>x.date===date).label,'已完成');assert.equal(require('../miniprogram/services/dashboard').growth(vm).sessions,0);
 assert.equal(calendar.trainingCompleted,false);
});
test('training that replaces recovery shows as unrecorded and saves over the old record version',async()=>{
 const key='workout:'+date,day={...plan.days[0],planVersion:2};
 store.save({online:false,workoutWeeks:{[plan.weekStart]:{...plan,version:2,days:[day]}},records:{
  [key]:{kind:'workoutRecord',version:4,value:{planId:plan.id,planVersion:1,date,status:'recovery',exercises:[],completedSets:0,seconds:0,discomfort:false}}
 }});
 const coach=require('../miniprogram/services/coach'),calendar=require('../miniprogram/services/dashboard').calendar(coach.snapshot(),date);
 assert.equal(calendar.weeks.flatMap(x=>x.days).find(x=>x.date===date).label,'训练');
 const detail=loadPage('exercise-detail');detail.onLoad({date});detail.refresh();
 assert.equal(detail.data.workoutView.record,null);
 assert.equal(detail.data.workoutView.completed,false);
 assert.equal(detail.data.workoutView.canRecord,true);
 await workout.save(date,[{sets:1,seconds:60},{}],{expectedVersion:2});
 assert.equal(store.get().queue[0].baseVersion,4);
 assert.equal(store.get().queue[0].value.planVersion,2);
});
test('today and detail use the same selected date and manual record route; future CTA stays disabled',async()=>{
 let url;wx.navigateTo=options=>{url=options.url;};
 const today=loadPage('today');today.onShow();today.recordWorkout();assert.equal(url,'/pages/exercise-record/index?date='+date);today.openExercise();assert.equal(url,'/pages/exercise-detail/index?date='+date);
 const detail=loadPage('exercise-detail');detail.onLoad({date});await detail.onShow();assert.equal(detail.data.calendar.selected,today.data.calendar.selected);detail.record();assert.equal(url,'/pages/exercise-record/index?date='+date);
 detail.selectDate({detail:{date:w.shift(date,1)}});assert.equal(detail.data.workoutView.canRecord,false);today.onHide();detail.onHide();
});
test('today and detail show training completion only for the selected completed date',async()=>{
 store.save({online:false});
 const today=loadPage('today');today.onShow();
 const detail=loadPage('exercise-detail');detail.onLoad({date});detail.onShow();
 const completion=()=>[today.data.calendar.trainingCompleted,detail.data.calendar.trainingCompleted];
 assert.deepEqual(completion(),[false,false]);
 await workout.save(date,[{sets:1,seconds:60},{}]);
 assert.deepEqual(completion(),[false,false]);
 await workout.save(date,[{sets:2,seconds:120},{sets:2,reps:8,seconds:80}]);
 assert.deepEqual(completion(),[true,true]);
 const selection={detail:{date:w.shift(date,-1)}};
 today.selectDate(selection);detail.selectDate(selection);
 assert.deepEqual(completion(),[false,false]);
 today.onHide();detail.onHide();
});
test('automatic ensure deduplicates same day, retries explicit failures, and protects pending local records',async()=>{
 await workout.ensure();await workout.ensure();assert.equal(calls.filter(x=>x.action==='workout.plan.ensure').length,1);
 await workout.ensure({retry:true});assert.equal(calls.filter(x=>x.action==='workout.plan.ensure').length,2);
 store.save({online:false});await workout.save(date,[{sets:1,seconds:60},{}]);store.save({online:true});await workout.ensure({retry:true});assert.equal(calls.filter(x=>x.action==='workout.plan.ensure').length,2);
});
test('reassessment syncs past earlier batches and replaces an obsolete assessment conflict',async()=>{
 const coach=require('../miniprogram/services/coach');
 const assessment={schemaVersion:3,consent:true,screening:'clear',age:28,sex:'male',height:175,weight:70,targetWeight:65,pace:'moderate',stepGoal:6000,waist:'',goal:'habit',experience:'beginner',activity:'light',minutes:15,frequency:3,weekdays:[1,3,5],equipment:'none',foodScene:'cook',foodObstacle:'irregular',diet:'none',allergies:''};
 const previous={kind:'assessment',version:2,value:assessment};
 store.save({
  records:{assessment:previous},
  conflicts:[{operation:{key:'assessment',kind:'assessment',value:{...assessment,minutes:30}},remote:previous}],
  queue:Array.from({length:30},(_,i)=>({id:'event-'+i,key:'event:'+i,kind:'event'}))
 });
 let remote=previous;
 wx.cloud.callFunction=async({data})=>{
  calls.push(data);
  let result;
  if(data.action==='plan.preview')result={plan:d.makePlan(data.assessment)};
  if(data.action==='sync.batch'){
   const update=data.operations.find(x=>x.kind==='assessment');
   if(update){
    assert.equal(update.baseVersion,remote.version);
    remote={kind:'assessment',version:3,value:update.value};
   }
   result={results:data.operations.map(x=>({id:x.id,key:x.key,status:'ok',version:3})),state:{records:{assessment:remote}}};
  }
  if(data.action==='workout.plan.ensure'){
   assert.equal(remote.value.equipment,'band');
   result={status:'ready',plan:{...plan,version:2,days:[{...plan.days[0],planVersion:2,title:'弹力带训练'}]}};
  }
  return {result:{code:0,stage:'prod',data:result}};
 };
 await coach.assess({...assessment,equipment:'band'});
 assert.deepEqual(calls.map(x=>x.action),['plan.preview','sync.batch','sync.batch','workout.plan.ensure']);
 assert.equal(store.get().conflicts.length,0);
 assert.equal(workout.view(coach.snapshot(),date).day.title,'弹力带训练');
});
test('an assessment saved during generation waits for the updated workout',async()=>{
 let finish;
 const updated={...plan,version:2,days:[{...plan.days[0],planVersion:2,title:'新评测的计划'}]};
 wx.cloud.callFunction=async({data})=>{
  calls.push(data);
  const current=calls.length===1?await new Promise(resolve=>{finish=()=>resolve(plan);}):updated;
  return {result:{code:0,stage:'prod',data:{status:'ready',plan:current}}};
 };
 const old=workout.ensure();
 store.save({records:{assessment:{version:2,value:{minutes:30}}}});
 const latest=workout.ensure();
 finish();
 await Promise.all([old,latest]);
 assert.equal(calls.length,2);
 assert.equal(store.get().workoutWeeks[plan.weekStart].days[0].title,'新评测的计划');
});
test('late responses from a different account never populate workout cache',async()=>{
 let resolve;wx.cloud.callFunction=async()=>{await new Promise(done=>{resolve=done;});return {result:{code:0,stage:'prod',data:{status:'ready',plan}}};};
 const pending=workout.ensure({retry:true});while(!resolve)await new Promise(done=>setImmediate(done));store.identify('another-owner');resolve();await pending;assert.equal(store.get().workoutWeeks,undefined);
});
test('manual data updates growth and report without counting the legacy training twice',async()=>{
 store.save({online:false,records:{legacy:{kind:'session',value:{date,status:'completed',completedSets:9,seconds:500,planId:'old'}}}});
 await workout.save(date,[{sets:2,seconds:120},{sets:2,reps:8,seconds:80}]);const vm=require('../miniprogram/services/coach').snapshot(),growth=require('../miniprogram/services/dashboard').growth(vm);
 assert.equal(growth.sessions,1);assert.equal(growth.sets,4);assert.equal(vm.report.sessions,1);
});

test('existing record links with a move id still focus the selected move',()=>{
 const record=loadPage('exercise-record');record.onLoad({date,moveId:'move-1'});record.refresh();let selector;wx.pageScrollTo=options=>{selector=options.selector;};record.onReady();assert.equal(selector,'#record-move-1');
 record.onHide();
});

test('rest days expose no recording route and a direct record-page save remains inert',()=>{
 plan.days[0]={...plan.days[0],rest:true,seconds:0,energyKcal:0,exercises:[]};
 store.save({online:false,workoutWeeks:{[plan.weekStart]:plan}});
 let navigations=0;wx.navigateTo=()=>{navigations++;};
 const today=loadPage('today');today.onShow();today.recordWorkout();
 const detail=loadPage('exercise-detail');detail.onLoad({date});detail.refresh();detail.record();
 const record=loadPage('exercise-record');record.onLoad({date});record.refresh();record.save();
 assert.equal(navigations,0);assert.equal(store.get().records['workout:'+date],undefined);assert.equal(store.get().queue.filter(x=>x.kind!=='event').length,0);
 today.onHide();detail.onHide();record.onHide();
});
