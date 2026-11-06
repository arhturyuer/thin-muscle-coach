/* Display-only projections. Persisted records and service interfaces stay unchanged. */
const d = require('../shared/domain');
const uniqueDays = rows => new Set(rows.map(r => r.date)).size;
function shift(date, days) { return new Date(Date.parse(date + 'T00:00:00Z') + days * d.DAY).toISOString().slice(0, 10); }
function today(vm) {
  const e = vm.entitlement, plan = e && e.plan || vm.preview;
  const assessed = !!(vm.records.assessment || vm.preview || e);
  const pending = !!(e && e.status === 'pending' && (!e.expiresAt || Date.now() < e.expiresAt));
  const executable = !!(vm.active && (!e.expiresAt || Date.now() < e.expiresAt));
  const task = executable ? vm.today : pending && plan ? plan.days[0] : null;
  const daily = e && vm.records[`daily:${e.id}:${vm.date}`];
  const session = executable && vm.records[`session:${e.id}:${vm.day - 1}`];
  const completed = !!(session && session.value.status === 'completed');
  const nutritionDone = !!(daily && daily.value.nutrition);
  const recoveryDone = !!(daily && daily.value.recovery);
  return {
    assessed, guide: !assessed && !vm.isMember, pending, executable, task, plan,
    date: vm.date, completed, nutritionDone, recorded: !!daily, recoveryDone,
    done: (task && task.rest ? Number(recoveryDone) : Number(completed)) + Number(nutritionDone),
    meals: plan && plan.nutrition ? plan.nutrition.meals : [],
    week: plan ? plan.days.map((day, i) => {
      const date = e && e.startDate ? shift(e.startDate, i) : '';
      const log = date && vm.records[`daily:${e.id}:${date}`];
      const record = e && vm.records[`session:${e.id}:${i}`];
      return {index:i, label:date ? date.slice(5) : `第${i+1}日`, rest:day.rest,
        current:executable && i === vm.day-1,
        done:day.rest ? !!(log && log.value.recovery) : !!(record && record.value.status === 'completed')};
    }) : []
  };
}
function trend(rows, field, title, unit) {
  const points = rows.filter(r => Number.isFinite(r[field]));
  if (!points.length) return {field, title, unit, count:0, points:[]};
  const first = points[0], last = points[points.length-1];
  const values = points.map(r => r[field]), min = Math.min(...values), max = Math.max(...values);
  const span = Math.max(1, Date.parse(last.date) - Date.parse(first.date));
  const plotted = points.map(r => ({date:r.date, value:r[field], x:5+90*(Date.parse(r.date)-Date.parse(first.date))/span,
    y:85-70*(max === min ? 0.5 : (r[field]-min)/(max-min))}));
  const delta = Math.round((last[field]-first[field])*10)/10;
  return {field,title,unit,count:points.length, first:first[field], latest:last[field],
    min,max,firstDate:first.date,lastDate:last.date,change:(delta>0?'+':'')+delta, points:plotted};
}
function growth(vm, all = false) {
  const sessions = require('../shared/workout').sessions(vm.records);
  const rows = [...Object.entries(vm.records || {}).filter(([,r]) => ['daily','measurement','meal'].includes(r.kind)).map(([key,r]) => ({key,...r})),...sessions];
  const completed = sessions.filter(r => r.value.status === 'completed');
  const daily = rows.filter(r => r.kind === 'daily').map(r => r.value);
  const start = shift(vm.date,-27);
  const measurements = rows.filter(r => r.kind === 'measurement' && (all || r.value.date >= start)).map(r => r.value).sort((a,b) => a.date.localeCompare(b.date));
  const recent = sessions.filter(r => r.value.date >= start && r.value.date <= vm.date);
  const monday = shift(vm.date,-((new Date(vm.date+'T00:00:00Z').getUTCDay()+6)%7));
  const weeks = Array.from({length:4},(_,i) => {
    const from = shift(monday,(i-3)*7), to = shift(from,6);
    const inWeek = r => r.date >= from && r.date <= to && r.date <= vm.date;
    const logs = daily.filter(inWeek);
    return {from,to,training:completed.filter(r => inWeek(r.value)).length,
      nutrition:uniqueDays(logs.filter(r => r.nutrition)), recorded:uniqueDays([...logs.filter(r => ['breakfast','lunch','dinner'].some(k => (r[k]||'').trim())),...Object.values(vm.records).filter(r=>r.kind==='meal'&&r.value.text&&inWeek(r.value)).map(r=>r.value)])};
  });
  return {
    sessions:completed.length,nutritionDays:uniqueDays(daily.filter(r=>r.nutrition)),
    latest:rows.map(r=>r.value.date).filter(Boolean).sort().pop() || '暂无记录',
    trends:[trend(measurements,'weight','体重趋势','千克'),trend(measurements,'waist','体型参考 · 腰围','厘米')],
    training:recent.filter(r=>r.value.status==='completed').length,
    sets:recent.reduce((sum,r)=>sum+r.value.completedSets,0),
    minutes:Math.round(recent.reduce((sum,r)=>sum+r.value.seconds,0)/60),
    feelings:['easy','okay','hard'].map((key,i)=>({label:['轻松','刚刚好','吃力'][i],count:recent.filter(r=>r.value.difficulty===key).length})),
    weeks,history:sessions.sort((a,b)=>b.value.date.localeCompare(a.value.date)), measurements
  };
}
function profile(vm) {
  const a = vm.records.assessment && vm.records.assessment.value || vm.entitlement && vm.entitlement.plan && vm.entitlement.plan.assessment || vm.preview && vm.preview.assessment;
  if (!a) return {available:false,fields:[],summaryFields:[],detailFields:[],goal:'完成评测后展示你的目标'};
  const labels = {male:'男',female:'女',beginner:'刚开始训练',occasional:'偶尔训练',none:'无器械',band:'弹力带',sedentary:'久坐为主',light:'轻度活动',active:'活动较多',takeout:'外卖',canteen:'食堂',cook:'自己做饭'};
  const targets=vm.entitlement?.plan?.energyTargets||vm.preview?.energyTargets;
  const fields = [['年龄',a.age && a.age+' 岁'],['生理性别',labels[a.sex]],['身高',a.height && a.height+' 厘米'],['评测体重',a.weight && a.weight+' 千克'],['目标体重',a.targetWeight && a.targetWeight+' 千克'],['预计周期',targets && (targets.direction==='maintain'?'维持体重':targets.estimatedWeeks?targets.estimatedWeeks+' 周（本轮起点估算）':'分阶段复评')],['基础代谢估算',targets && targets.basalKcal+' 千卡/日'],['每日步数目标',a.stepGoal && a.stepGoal+' 步'],['评测腰围',a.waist && a.waist+' 厘米'],['训练基础',labels[a.experience]],['活动量',labels[a.activity]],['训练条件',labels[a.equipment]],['单次时间',a.minutes && a.minutes+' 分钟'],['每周训练',a.frequency && a.frequency+' 次'],['可训练日',Array.isArray(a.weekdays) && a.weekdays.map(i=>['周日','周一','周二','周三','周四','周五','周六'][i]).join('、')],['饮食场景',labels[a.foodScene]],['饮食偏好',{none:'无特别偏好',vegetarian:'素食'}[a.diet]],['饮食障碍',{irregular:'吃饭不规律',protein:'蛋白质搭配',snacking:'随手吃零食'}[a.foodObstacle]],['饮食禁忌',a.allergies || ([2,3].includes(a.schemaVersion) ? '无' : '')]].filter(x=>x[1]).map(([label,value])=>({label,value}));
  const goal = {fat_loss:'减脂，改善身体组成',muscle:'增肌，积累力量',habit:'建立持续的运动习惯',strength:'提升力量',posture:'改善体态'}[a.goal] || '尚未设置目标';
  const basal = require('../shared/guidance').basal(a);
  const summaryFields = [
    ['性别', labels[a.sex]], ['年龄', a.age && a.age+' 岁'], ['身高', a.height && a.height+' 厘米'],
    ['基础代谢', Number.isFinite(basal) && basal > 0 ? Math.round(basal)+' 千卡/日（估算）' : '待补充'],
    ['我的目标', goal], ['每日目标步数', a.stepGoal && a.stepGoal+' 步'],
    ['可训练日', Array.isArray(a.weekdays) && a.weekdays.map(i=>['周日','周一','周二','周三','周四','周五','周六'][i]).join('、')]
  ].map(([label,value])=>({label,value:value || '待补充'}));
  const summaryLabels = new Set(['年龄','生理性别','身高','基础代谢估算','每日步数目标','可训练日']);
  return {available:true,fields,summaryFields,detailFields:fields.filter(f=>!summaryLabels.has(f.label)),goal};
}
module.exports = {today,growth,profile,shift};

// Browsing another date never changes the service's actual execution date.
function calendar(vm, selectedDate = vm.date, weekStart, slot = 1) {
  vm = {...vm, date: d.validDate(vm.date || '') ? vm.date : d.localDate()};
  const selected = d.validDate(selectedDate) ? selectedDate : vm.date;
  const monday = date => shift(date,-((new Date(date+'T00:00:00Z').getUTCDay()+6)%7));
  const anchor = weekStart || monday(selected);
  const e = vm.entitlement;
  const plan = e && e.plan;
  const planStart = e && e.startDate;
  const rows = Object.values(vm.records || {});
  const dayInfo = date => {
    const index = planStart ? Math.round((Date.parse(date)-Date.parse(planStart))/d.DAY) : -1;
    const original = index >= 0 && index < 7 && plan ? plan.days[index] : null;
    const task = original ? require('../shared/daily').effective(vm.records,e,date,original).task : null;
    const sessions = require('../shared/workout').sessions(vm.records).filter(r=>r.value.date===date).map(r=>r.value);
    const rawLogs = rows.filter(r=>r.kind==='daily' && r.value.date===date).map(r=>r.value);
    const planIds=new Set([...rawLogs.map(x=>x.planId),...rows.filter(r=>r.kind==='meal'&&r.value.date===date).map(r=>r.value.planId)]);
    const logs=Array.from(planIds).map(id=>{const legacy=rawLogs.find(x=>x.planId===id)||{};const rules=require('../shared/daily');return {...legacy,planId:id,date,...Object.fromEntries(rules.meals(vm.records,id,date).map(x=>[x.slot,vm.records[rules.mealKey(id,date,x.slot)]?x.text:legacy[x.slot]||x.text]))};});
    return {date,index,task,sessions,logs,completed:sessions.some(r=>r.status==='completed'),
      nutritionDone:logs.some(r=>r.nutrition),recoveryDone:vm.records['workout:'+date]?.value.status==='recovery'||logs.some(r=>r.recovery)};
  };
  const weeks = Array.from({length:3},(_,i)=>{
    const offset=(i-slot+3)%3;
    const start=shift(anchor,(offset===2?-1:offset)*7);
    return {id:i,days:Array.from({length:7},(_,j)=>{
      const date=shift(start,j), info=dayInfo(date);
      const workout=require('./workout').view(vm,date);
      const recoveryDone=info.recoveryDone && (!workout.day || workout.day.rest);
      return {date,number:Number(date.slice(8)),weekday:['一','二','三','四','五','六','日'][j],
        selected:date===selected,today:date===vm.date,
        label:info.completed || recoveryDone ? '已完成' : workout.record ? '部分完成' : workout.day ? workout.day.rest?'恢复':'训练' : info.task ? info.task.rest ? '恢复' : '训练' : info.logs.length || info.sessions.length ? '有记录' : '—'};
    })};
  });
  const info=dayInfo(selected), actual=today(vm), isToday=selected===vm.date;
  const view=isToday ? actual : {...actual,date:selected,task:info.task,pending:false,executable:false,
    completed:info.completed,nutritionDone:info.nutritionDone,recoveryDone:info.recoveryDone,
    recorded:!!info.logs.length,done:Number(info.task && info.task.rest ? info.recoveryDone : info.completed)+Number(info.nutritionDone),
    meals:info.task ? actual.meals : []};
  const effective=require('../shared/daily').effective(vm.records,e,selected,view.task);
  if(view.plan)view.plan={...require('../shared/guidance').planForDate(view.plan,selected),minutes:effective.minutes};
  view.task=effective.task;
  view.energy=require('../shared/guidance').dailyEnergy(view.plan,view.task,effective.minutes);
  view.intake=(view.plan?.nutrition?.numericEnabled||view.plan?.nutrition?.reviewed)?view.plan.nutrition.energy:null;
  view.steps=require('./activity-steps').view(vm,selected);
  return {weeks,anchor,slot,range:anchor+' — '+shift(anchor,6),selected,isToday,
    isPast:selected<vm.date,trainingCompleted:selected<=vm.date&&info.completed,
    view,sessions:info.sessions.map(r=>({...r,minutes:Math.round(r.seconds/60)})),
    logs:info.logs,hasRecords:!!(info.sessions.length || info.logs.length)};
}
module.exports.calendar = calendar;
