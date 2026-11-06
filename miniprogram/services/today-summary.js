/* Date-scoped, display-only totals. Missing observations are never real zeroes. */
const g = require('../shared/guidance');
const rules = require('../shared/daily');
const nutrition = require('./diet-nutrients');
const knownMuscles = {'椅子深蹲':['腿部','臀部'],'深蹲':['腿部','臀部'],'靠墙半蹲':['腿部'],'墙面俯卧撑':['胸部','手臂'],'臀桥':['臀部'],'鸟狗式':['核心'],'弹力带划船':['背部']};
const finite = x => typeof x === 'number' && Number.isFinite(x) && x >= 0;
const remaining = (target, done) => target === null || done === null ? null : Math.max(0, target - done);
const percent = (done, target) => done === null || target === null ? 0 : target > 0 ? Math.min(100, Math.round(done / target * 100)) : 100;
const display = (n, missing='待确认') => n === null ? missing : String(n);
function allocate(total, moves) {
  const seconds = moves.reduce((sum, x) => sum + (x.seconds||0), 0);
  if (!seconds) return moves.map(() => 0);
  const raw = moves.map(x => total * (x.seconds||0) / seconds), result = raw.map(Math.floor);
  const order = raw.map((x,i) => ({i,fraction:x-result[i]})).sort((a,b) => b.fraction-a.fraction || a.i-b.i);
  const residue=total-result.reduce((sum,x)=>sum+x,0);
  for (let i=0; i<residue; i++) result[order[i].i]++;
  return result;
}
function diet(vm, calendar, daily) {
  if(vm.config?.mealWeeksSupported)return require('./diet-view').build(vm,calendar);
  const date=calendar.selected, records=vm.records||{}, logs=calendar.logs||[];
  const planId=logs.find(x=>x.planId===vm.entitlement?.id)?.planId || logs[0]?.planId || vm.entitlement?.id;
  const meals=planId?rules.meals(records,planId,date):[];
  const target=finite(calendar.view.intake)?Math.round(calendar.view.intake):null;
  const rows=rules.slots.filter(slot=>slot!=='snack'||meals.some(x=>x.slot===slot&&x.text)).map(slot=>{
    const actual=meals.find(x=>x.slot===slot), planned=daily.plannedMeals?.find(x=>x.slot===slot), suggestion=daily.meals?.find(x=>x.slot===slot)?.suggestion;
    const content=actual?.text||suggestion||planned?.reference||planned?.title||calendar.view.meals?.[rules.slots.indexOf(slot)]||'暂无建议食谱';
    const meal=actual?.text?nutrition.mealNutrition(records,{planId,date,slot,value:records[actual.key]?.value}):null;
    return {slot,label:rules.labels[slot],recorded:!!meal,text:content.replace(/^(早餐|午餐|晚餐|加餐)[：:]\s*/,''),state:meal?'已记录':'食谱',
      nutrition:meal,macros:meal||planned?.totals?nutrition.mealMacros(meal?meal.totals:planned.totals):[]};
  });
  const {totals,completed}=nutrition.dailyNutrition(rows,target);
  const consumed=finite(totals.energyKcal)?Math.round(totals.energyKcal):null;
  const rest=remaining(target,consumed), over=rest!==null&&consumed>target;
  return {rows,target:display(target,'待补充评测'),consumed:display(consumed),label:over?'已超出':'还需要吃',
    remaining:display(over?consumed-target:rest,target===null?'待补充评测':'待确认'),numeric:rest!==null,
    progress:nutrition.progress(totals.energyKcal,target),macros:nutrition.dailyMacros(totals,nutrition.fromNutrition(calendar.view.plan?.nutrition)),
    completed:date<=vm.date&&completed,note:consumed===null?'部分餐食热量待确认':rows.some(row=>row.recorded)?'按已确认记录计算 · 热量为估算值':'按已记录计算 · 尚未记录饮食'};
}
function workout(vm, calendar, view) {
  const future=calendar.selected>vm.date, plan=calendar.view.plan, a=plan?.assessment||vm.records?.assessment?.value;
  const legacy=!view.day && view.legacy?.task;
  const day=view.day || (legacy?{...legacy,energyKcal:calendar.view.energy?.trainingKcal??null,exercises:legacy.exercises.map(x=>({...x,mode:'reps'}))}:null);
  const moves=day?.exercises||[], allocations=allocate(finite(day?.energyKcal)?Math.round(day.energyKcal):0,moves);
  const record=view.record && view.record.planVersion===view.day?.planVersion?view.record:null;
  const legacyRecord=!view.record&&(calendar.sessions||[]).find(x=>!x.manual);
  const trainingTarget=day&&finite(day.energyKcal)?Math.round(day.energyKcal):null;
  let trainingDone=0;
  const rows=moves.map((move,i)=>{
    const actual=record?.exercises.find(x=>x.id===move.id), started=!!actual?.sets;
    const complete=started&&actual.sets>=move.sets&&(move.mode==='time'?actual.seconds>=move.seconds:actual.reps>=move.reps);
    const energy=started&&move.seconds>0?allocations[i]*actual.seconds/move.seconds:0;
    trainingDone+=energy;
    const planned=move.mode==='time'?`${move.sets}组 共${move.seconds}秒`:`${move.sets}组 ${move.reps}次`;
    const done=started?(move.mode==='time'?`${actual.sets}组 · 共${actual.seconds}秒`:`${actual.sets}组×${actual.reps}次`):'';
    let rest='';
    if(started&&!complete) rest=move.mode==='time'?`还剩${Math.max(0,move.sets-actual.sets)}组 / ${Math.max(0,move.seconds-actual.seconds)}秒`:actual.reps===move.reps?`还剩${Math.max(0,move.sets-actual.sets)}组×${move.reps}次`:'与计划次数不同，请对照计划继续记录';
    const muscles=move.targetMuscles?.length?move.targetMuscles:knownMuscles[move.name];
    return {...move,planned,energy:move.seconds>0&&trainingTarget!==null?String(allocations[i]):'待确认',muscles:muscles?.length?'练'+muscles.join('、'):'查看动作说明',state:future?'尚未开始':complete?'已完成':started?'部分完成':legacyRecord?'查看原训练记录':'未开始',progress:future?'尚未开始':started?`已做${done}${rest?' · '+rest:''}`:legacyRecord?'旧计时训练未记录逐动作完成量':'尚未记录',complete,doneKcal:Math.round(energy)};
  });
  if(legacyRecord) trainingDone=a&&finite(legacyRecord.seconds)?g.training(a,legacyRecord.seconds/60):null;
  if(!day || view.record&&!record) trainingDone=null;
  if(day?.rest) trainingDone=0;
  trainingDone=trainingDone===null?null:Math.round(trainingDone);
  const steps=calendar.view.steps?.steps??null, stepGoal=a?.stepGoal!=null&&finite(+a.stepGoal)?Number(a.stepGoal):null;
  const canWalk=a&&finite(+a.height)&&+a.height>0&&finite(+a.weight)&&+a.weight>0;
  const activityTarget=canWalk&&stepGoal!==null?Math.round(g.walking(a,stepGoal)):null;
  const activityDone=canWalk&&steps!==null?Math.round(g.walking(a,steps)):null;
  const activityRemaining=remaining(activityTarget,activityDone), trainingRemaining=remaining(trainingTarget,trainingDone);
  const target=activityTarget===null||trainingTarget===null?null:activityTarget+trainingTarget;
  const done=activityDone===null||trainingDone===null?null:activityDone+trainingDone;
  const rest=activityRemaining===null||trainingRemaining===null?null:activityRemaining+trainingRemaining;
  return {rows,hasDay:!!day,legacy:!!legacy,rest:!!day?.rest,title:day?.title||'',reason:day?.reason||'',future,
    target:display(target),done:display(done),remaining:display(rest),progress:future?0:percent(target===null||rest===null?null:target-rest,target),
    activity:{target:display(activityTarget),done:display(activityDone,steps===null?'待同步':'待确认'),remaining:display(activityRemaining),progress:future?0:percent(activityDone,activityTarget)},
    training:{target:display(trainingTarget),done:display(trainingDone),remaining:display(trainingRemaining),progress:future?0:percent(trainingDone,trainingTarget)},
    steps:display(steps,'未同步'),stepGoal:display(stepGoal),stepsRemaining:steps===null||stepGoal===null?null:Math.max(0,stepGoal-steps),
    note:future?'尚未开始':done===null?'部分数据待确认 · 热量为估算值':'热量为估算值，不含基础代谢'};
}
function view(vm,calendar,daily,workoutView) {return {diet:diet(vm,calendar,daily),exercise:workout(vm,calendar,workoutView)};}
module.exports={view,allocate};
