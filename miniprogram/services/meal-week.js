const store=require('../core/store'),release=require('../core/release'),api=require('./api'),repo=require('./repository'),d=require('../shared/domain'),w=require('../shared/workout');
const identity=s=>[release.stage(),s.owner,s.dataEpoch||0,s.stepsEpoch||0].join(':');
const affectsPlan=op=>['assessment','meal','mealAnalysis','daily','preference'].includes(op?.kind);
let flight,attempt,sequence=0;
const loads=new Map(), recent=new Map();
function accept(result,week){
  const s=store.get(),weeks={...s.mealWeeks},states={...s.mealWeekStates},legacy={...s.legacyMealDays};
  for(const row of result.weeks||[{weekStart:week,...result}]){
    if(row.plan&&(!weeks[row.weekStart]||weeks[row.weekStart].version<=row.plan.version))weeks[row.weekStart]=row.plan;
    states[row.weekStart]={...states[row.weekStart],status:row.status,message:row.message||'',...(row.targetDate?{targetDate:row.targetDate,targets:row.targets}:{})};
    for(const day of row.legacyDays||[])legacy[day.date]=day;
  }
  store.save({legacyMealDays:Object.fromEntries(Object.entries(legacy).slice(-120)),mealWeeks:Object.fromEntries(Object.entries(weeks).slice(-24)),mealWeekStates:Object.fromEntries(Object.entries(states).slice(-24))});
}
function load(date=d.localDate(),force=false){
  const s=store.get();if(!s.config.mealWeeksSupported||!s.online||s.owner==='guest')return Promise.resolve();
  const week=w.week(date),owner=identity(s),version=sequence,key=[owner,week.start,version].join(':');
  if(loads.has(key))return loads.get(key);
  if(!force&&Date.now()-(recent.get(key)||0)<30000)return Promise.resolve();
  const promise=api.call('meal.plan.get',{from:week.start,to:week.end,owner:s.owner,epoch:s.dataEpoch||0}).then(r=>{
    if(owner===identity(store.get())&&version===sequence){
      const current=store.get().mealWeekStates?.[week.start];
      // Reads without a server plan cannot erase an actionable local state.
      const states=r.weeks.map(row=>row.status==='empty'&&['consent','failed','unavailable','generating'].includes(current?.status)
        ?{...row,status:current.status,message:current.message}:row);
      if(states.length)accept({weeks:states});
      recent.set(key,Date.now());
      if(recent.size>32)recent.delete(recent.keys().next().value);
    }
    return r;
  }).finally(()=>loads.delete(key));
  loads.set(key,promise);return promise;
}
async function ensure({retry=false}={}){
  const s=store.get(),owner=identity(s),date=d.localDate(),week=w.week(date).start;
  if(!s.config.mealWeeksSupported||!s.online||s.owner==='guest'||!s.membership?.active)return;
  if(s.queue.some(affectsPlan)||s.conflicts.some(x=>affectsPlan(x.operation)))return;
  const key=[owner,week,s.mealWeekConsentVersion||0,s.records.assessment?.version||0,s.targetsVersion||0,s.entitlement?.id||''].join(':');
  if(flight){
    if(flight.key===key)return flight.promise;
    await flight.promise;
    if(owner===identity(store.get()))return ensure({retry});
    return;
  }
  if(!retry&&attempt===key)return;
  attempt=key;const version=++sequence;
  const current=()=>owner===identity(store.get())&&d.localDate()===date&&version===sequence;
  const promise=(async()=>{
    store.save({mealWeekStates:{...store.get().mealWeekStates,[week]:{status:'generating',message:''}}});
    try{
      const result=await api.call('meal.plan.ensure',{requestId:repo.id(),owner:s.owner,epoch:s.dataEpoch||0});
      if(current()){sequence++;accept(result,week);if(result.status==='generating')poll(owner,date,sequence,0);}
    }catch(error){
      if(current()){sequence++;accept({status:'failed',message:error.message},week);if(['TRANSPORT_ERROR','TEST_TRANSPORT_ERROR'].includes(error.code))poll(owner,date,sequence,0,true);}
    }
  })();
  flight={key,promise};
  try{return await promise;}finally{if(flight?.promise===promise)flight=null;}
}
function poll(owner,date,version,count,recover=false){
  if(count>=33)return;
  setTimeout(async()=>{
    if(owner!==identity(store.get())||date!==d.localDate()||version!==sequence||!store.get().online)return;
    try{
      const r=await load(date,true),status=r?.weeks[0]?.status;
      if(status==='generating'||recover&&status==='empty')poll(owner,date,version,count+1,recover);
      else if(status==='empty'&&store.get().mealWeekStates?.[w.week(date).start]?.status==='generating')
        accept({status:'failed',message:'本周食谱暂未生成，请重试。'},w.week(date).start);
    }catch{poll(owner,date,version,count+1,recover);}
  },2000);
}
async function consent(){
  const s=store.get(),owner=identity(s);
  await require('../core/feedback').requirePrivacy();
  if(owner!==identity(store.get()))throw new Error('账号已变化，请重新打开');
  const result=await api.call('meal.plan.consent',{version:1,owner:s.owner,epoch:s.dataEpoch||0});
  if(owner!==identity(store.get()))throw new Error('账号已变化，请重新打开');
  store.save({mealWeekConsentVersion:result.version});
  await require('./syncService').flush();
  void ensure();
}
function view(vm,date){
  const week=w.week(date).start,plan=vm.mealWeeks?.[week],day=plan?.days.find(x=>x.date===date);
  const state=vm.mealWeekStates?.[week];
  return {day:day||null,targets:state?.targetDate===date?state.targets:null,status:date>vm.date&&week>w.week(vm.date).start?'empty':state?.status||'empty',message:state?.message||''};
}
module.exports={affectsPlan,ensure,load,consent,view};
