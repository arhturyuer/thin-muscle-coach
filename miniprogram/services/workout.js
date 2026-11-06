const store=require('../core/store'),api=require('./api'),repo=require('./repository'),w=require('../shared/workout'),d=require('../shared/domain');
let ensuring,sequence=0,pollTimer,requests=new Map();
const identity=s=>s.owner+':'+(s.dataEpoch||0)+':'+require('../core/release').stage();
const affectsPlan=operation=>['assessment','workoutRecord','session'].includes(operation.kind);
const attemptKey=(s,date)=>'v2:'+identity(s)+':'+date+':'+(s.records.assessment?.version||0)+':'+JSON.stringify(s.records.assessment?.value||s.entitlement?.plan?.assessment||s.preview?.assessment);
function accept(result,from,to) {
  const weeks={...store.get().workoutWeeks},states={...store.get().workoutStates};
  for(const plan of result.plans||[result.plan].filter(Boolean))if(!weeks[plan.weekStart]||weeks[plan.weekStart].version<=plan.version)weeks[plan.weekStart]=plan;
  for(const state of result.states||[{weekStart:w.week(d.localDate()).start,...result}])states[state.weekStart]={status:state.status,message:state.message||''};
  const legacyWorkoutPlans={...store.get().legacyWorkoutPlans};
  for(const plan of result.legacyPlans||[])legacyWorkoutPlans[plan.id]=plan;
  store.save({workoutWeeks:weeks,workoutStates:states,legacyWorkoutPlans});
}
async function ensure({retry=false}={}) {
  const s=store.get();if(!s.config.workoutPlansSupported||!s.online||!s.membership?.active)return;
  const date=d.localDate(),week=w.week(date).start,key=attemptKey(s,date),owner=identity(s);
  // Do not generate from stale assessments or overwrite unsynchronized exercise days.
  if(s.queue.some(affectsPlan)||s.conflicts.some(x=>affectsPlan(x.operation)))return;
  if(ensuring){
    if(ensuring.key===key)return ensuring.promise;
    await ensuring.promise;
    if(identity(store.get())===owner)return ensure({retry});
    return;
  }
  if(!retry&&s.workoutAttempt===key&&['ready','failed'].includes(s.workoutStates?.[week]?.status))return;
  clearTimeout(pollTimer);
  sequence++;
  store.save({workoutAttempt:key,workoutStates:{...s.workoutStates,[week]:{status:'generating',message:''}}});
  const isCurrent=()=>attemptKey(store.get(),d.localDate())===key;
  const promise=(async()=>{
    try{
      const result=await api.call('workout.plan.ensure',{requestId:repo.id()});
      if(isCurrent()){
        sequence++;
        accept(result);
        if(result.status==='generating')poll(owner,date,sequence,0);
      }
    }
    catch(error){if(isCurrent()){sequence++;store.save({workoutStates:{...store.get().workoutStates,[week]:{status:'failed',message:error.message}}});}}
    finally{ensuring=null;}
  })();
  ensuring={key,promise};
  return promise;
}
function poll(owner,date,version,attempt) {
  clearTimeout(pollTimer);
  if(attempt>=30||identity(store.get())!==owner||!store.get().online)return;
  pollTimer=setTimeout(async()=>{
    const isCurrent=()=>sequence===version&&identity(store.get())===owner;
    if(!isCurrent())return;
    try{await load(date,w.week(date).end);if(isCurrent()&&store.get().workoutStates?.[w.week(date).start]?.status==='generating')poll(owner,date,version,attempt+1);}
    catch(error){if(isCurrent())store.save({workoutStates:{...store.get().workoutStates,[w.week(date).start]:{status:'failed',message:error.message}}});}
  },2000);
}
async function load(from,to=from) {
  const s=store.get();if(!s.config.workoutPlansSupported||!s.online)return;
  const owner=identity(s),version=sequence,key=owner+':'+from+':'+to+':'+version;
  if(requests.has(key))return requests.get(key);
  const request=(async()=>{try{const result=await api.call('workout.plan.get',{from,to});if(identity(store.get())===owner&&sequence===version)accept(result,from,to);return result;}finally{requests.delete(key);}})();
  requests.set(key,request);return request;
}
function view(vm,date) {
  const plan=vm.workoutWeeks?.[w.week(date).start],day=plan?.days.find(x=>x.date===date),record=vm.records['workout:'+date]?.value;
  const state=vm.workoutStates?.[w.week(date).start]||{status:'empty',message:''};
  const paid=(vm.membership?.segments||[]).some(x=>x.startsAt<Date.parse(date+'T00:00:00+08:00')+d.DAY&&x.expiresAt>Date.parse(date+'T00:00:00+08:00'));
  const oldPlan=[vm.entitlement,...Object.values(vm.legacyWorkoutPlans||{})].filter(Boolean).find(p=>p.startDate&&date>=p.startDate&&p.plan?.days[d.dayIndex(p.startDate,Date.parse(date+'T12:00:00+08:00'))]);
  const legacy=oldPlan?{plan:oldPlan.plan,task:oldPlan.plan.days[d.dayIndex(oldPlan.startDate,Date.parse(date+'T12:00:00+08:00'))]}:null;
  const currentRecord=w.replacesRecovery(day,record)?null:record;
  return {plan:plan||null,day:day?{...day,minutes:Math.round(day.seconds/60),exercises:day.exercises.map((x,index)=>({...x,order:index+1,prescription:w.prescription(x),video:vm.config.mediaUrls?.[x.mediaId]||''}))}:null,
    legacy,
    record:currentRecord||null,status:state.status,message:state.message,
    canRecord:!!day&&date<=vm.date&&paid,completed:!!currentRecord&&currentRecord.status!=='partial'};
}
function secondsForSet(total, count, index) {
  return Math.floor(total/count) + (index % count < total % count ? 1 : 0);
}
function plannedSet(move,index) {
  return {
    number:index+1,completed:false,weightKg:'',
    reps:move.mode==='time'?'':String(move.reps),
    seconds:move.mode==='time'?String(secondsForSet(move.seconds,move.sets,index)):''
  };
}
function recordRows(day,record) {
  return day.exercises.map(move=>{
    const saved=record?.exercises.find(x=>x.id===move.id);
    const setDetails=saved?.setDetails
      ? saved.setDetails.map((set,index)=>({
        number:index+1,completed:set.completed,weightKg:String(set.weightKg??''),
        reps:String(set.reps??''),seconds:String(set.seconds||'')
      }))
      : Array.from({length:Math.max(move.sets,saved?.sets||0)},(_,index)=>{
        const row=plannedSet(move,index);
        if(!saved||index>=saved.sets)return row;
        return {...row,completed:true,reps:String(saved.reps??''),seconds:String(Math.max(1,secondsForSet(saved.seconds,saved.sets,index)))};
      });
    return {id:move.id,difficulty:saved?.difficulty||'unknown',setDetails};
  });
}
function actualExercise(move,row) {
  const timed=move.mode==='time';
  if(!Array.isArray(row?.setDetails))return {id:move.id,sets:Number(row?.sets||0),reps:timed?null:Number(row?.reps||0),seconds:Number(row?.seconds||0)};
  const setDetails=row.setDetails.map((set,index)=>({
    completed:set.completed,
    weightKg:set.weightKg===''||set.weightKg==null?null:Number(set.weightKg),
    reps:timed?null:Number(set.reps||0),
    seconds:!timed&&set.completed&&(set.seconds===''||set.seconds==null)
      ? secondsForSet(move.seconds,move.sets,index)
      : Number(set.seconds||0)
  }));
  return {id:move.id,difficulty:row.difficulty,...w.summarizeSets(setDetails,timed),setDetails};
}
async function save(date,rows,{difficulty='unknown',discomfort=false,expectedVersion,expectedRecord}={}) {
  const vm=require('./coach').snapshot(),v=view(vm,date),day=v.day;
  if(!v.canRecord)throw new Error('该日期暂无可记录的付费运动计划');
  if(expectedVersion!=null&&day.planVersion!==expectedVersion)throw new Error('计划已有更新，请返回并重新打开记录页，当前填写尚未保存');
  if(expectedRecord&&(vm.owner!==expectedRecord.owner||vm.dataEpoch!==expectedRecord.epoch||v.record?.at!==expectedRecord.at)){
    throw new Error('账号或该日记录已有变化，请返回后重新打开记录页');
  }
  const exercises=day.rest?[]:day.exercises.map((move,index)=>actualExercise(move,rows[index]));
  const rated=exercises.filter(move=>move.sets>0).map(move=>move.difficulty);
  difficulty=['hard','okay','easy'].find(value=>rated.includes(value))||difficulty;
  const all=day.exercises.every(move=>{const x=exercises.find(row=>row.id===move.id);return x&&x.sets>=move.sets&&(move.mode==='time'?x.seconds>=move.seconds:x.reps>=move.reps);});
  const value={planId:v.plan.id,planVersion:day.planVersion,date,status:day.rest?'recovery':all&&!discomfort?'completed':'partial',exercises,completedSets:exercises.reduce((n,x)=>n+x.sets,0),seconds:exercises.reduce((n,x)=>n+x.seconds,0),difficulty,discomfort,at:Date.now()};
  if(!w.matches(value,day))throw new Error('请填写有效的重量、次数或时长，并至少勾选一组已完成的动作');
  repo.write('workoutRecord','workout:'+date,value);
  await require('./syncService').flush();return value;
}
module.exports={ensure,load,view,save,affectsPlan,recordRows,plannedSet};
