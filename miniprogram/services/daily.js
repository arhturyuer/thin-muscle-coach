const store=require('../core/store'),repo=require('./repository'),d=require('../shared/domain'),rules=require('../shared/daily'),api=require('./api');
function current() {
  const s=store.get(),e=s.entitlement;
  if(!d.active(e)||!e.credential||e.memberPlan&&!s.membership?.active)throw new Error('请先启动有效计划，再记录或调整');
  return {s,e,date:d.localDate()};
}
function currentMeal(){
  const s=store.get(),date=d.localDate();
  if(s.config.mealWeeksSupported&&s.membership?.active&&(!s.membership.expiresAt||s.membership.expiresAt>Date.now()))return {s,date,e:s.entitlement,weekly:true};
  return {...current(),weekly:false};
}
function saveMeal(input,mode='new',ticket={}) {
  const {s,e,date,weekly}=currentMeal();
  if(ticket.date&&ticket.date!==date||ticket.planId&&ticket.planId!==e?.id&&!weekly)throw new Error('日期或计划已变化，请重新记录');
  if(!rules.slots.includes(input.slot)||!input.text?.trim())throw new Error('请选择餐次并填写内容');
  const old=(weekly?rules.mealsForDate(s.records,date):rules.meals(s.records,e.id,date)).find(x=>x.slot===input.slot),planId=old.planId||e.id;
  if(ticket.requestId&&s.dailyWrites?.[ticket.requestId])return {saved:true,key:old.key};
  if(old.text&&mode==='new')return {conflict:true,old,input};
  const append=mode==='append'&&!!old.text,text=append?old.text+'；'+input.text.trim():input.text.trim();
  if(text.length>1000)throw new Error('该餐最多 1000 字，请精简后保存');
  const oldValue=s.records[old.key]?.value||{};
  const oldIncomplete=oldValue.nutritionIncomplete??!!(old.text&&(!(oldValue.analysisIds||[]).length||!['photo','undo'].includes(oldValue.source)));
  const nutritionIncomplete=!input.analysis||(append&&oldIncomplete);
  const analysisIds=append?[...(oldValue.analysisIds||[])]:[];
  if(input.analysis){
    if(analysisIds.length>=20)throw new Error('这一餐的照片记录过多，请分到加餐或精简记录');
    const nutrition=require('../shared/nutrition'),analysis=nutrition.normalizeAnalysis(input.analysis);
    const analysisKey=`analysis:${planId}:${date}:${ticket.requestId||repo.id()}`;
    if(!store.get().records[analysisKey])repo.write('mealAnalysis',analysisKey,{planId,date,slot:input.slot,analysis,at:Date.now()});
    analysisIds.push(analysisKey);
  }
  const photoIds=oldValue.photoIds||[];
  repo.write('meal',old.key,{planId,date,slot:input.slot,text,source:input.source||'text',at:Date.now(),previous:old.text,analysisIds,previousAnalysisIds:oldValue.analysisIds||[],nutritionIncomplete,previousNutritionIncomplete:oldIncomplete,
    ...(photoIds.length?{photoIds:append?photoIds:[],previousPhotoIds:photoIds}:{})});
  if(ticket.requestId)store.save({dailyWrites:Object.fromEntries(Object.entries({...store.get().dailyWrites,[ticket.requestId]:true}).slice(-1000))});
  require('./analytics').track('meal_recorded',ticket.requestId,ticket.startedAt?Date.now()-ticket.startedAt:undefined);
  return {saved:true,key:old.key};
}
function undoMeal(key) {
  const {s,e,date,weekly}=currentMeal(),row=s.records[key];
  if(!row||row.kind!=='meal'||row.value.date!==date||(!weekly&&row.value.planId!==e.id)||weekly&&rules.mealsForDate(s.records,date).find(x=>x.slot===row.value.slot)?.key!==key)return;
  repo.write('meal',key,{...row.value,text:row.value.previous||'',previous:row.value.text,source:'undo',at:Date.now(),analysisIds:row.value.previousAnalysisIds||[],previousAnalysisIds:row.value.analysisIds||[],nutritionIncomplete:row.value.previousNutritionIncomplete??!!(row.value.previous&&!(row.value.previousAnalysisIds||[]).length),previousNutritionIncomplete:row.value.nutritionIncomplete??false,
    ...(row.value.photoIds||row.value.previousPhotoIds?{photoIds:row.value.previousPhotoIds||[],previousPhotoIds:row.value.photoIds||[]}:{})});
  require('./analytics').track('meal_undone');
}
function feedback(value) {
  if(!Object.keys(value).length)return;
  const {s,e,date}=current(),key=`feedback:${e.id}:${date}`;
  repo.write('dailyFeedback',key,{...s.records[key]?.value,...value,planId:e.id,date,at:Date.now()});
}
async function request(action,data) {
  const {s,e,date}=current();if(!s.online)throw new Error('联网后才能生成或采用新安排，现有计划仍可使用');
  await require('./syncService').flush();
  if(store.get().queue.some(x=>x.kind==='session'))throw new Error('训练记录尚未同步，请联网同步后再调整');
  if(store.get().conflicts.some(x=>x.operation.kind==='session'))throw new Error('训练记录存在冲突，请先到“我的”处理');
  const signature=JSON.stringify({action,...data,planId:e.id,date,baseVersion:e.version||0});
  let pending=store.get().dayPending;
  if(pending&&pending.signature!==signature)throw new Error('上一项调整结果尚未确认，请先重试上一操作或刷新记录');
  if(!pending){pending={signature,requestId:repo.id()};store.save({dayPending:pending});}
  try {
    const r=await api.call(action,{...data,planId:e.id,date,baseVersion:e.version||0,requestId:pending.requestId});
    if(store.get().entitlement?.id!==e.id||d.localDate()!==date)throw new Error('日期或计划已变化，请刷新');
    if(r.state)repo.accept(r.state);store.save({dayPending:null});return r;
  } catch(error) {if(['INVALID','VERSION_CONFLICT','MEMBERSHIP_REQUIRED'].includes(error.code))store.save({dayPending:null});throw error;}
}
async function propose(input){const r=await request('day.propose',{input});require('./analytics').track('adjustment_proposed');return r.proposal;}
async function adopt(p) {
  if(p.target==='workout'&&store.get().session)throw new Error('请先结束或中断正在进行的训练，已完成部分会保留');
  const r=await request('day.adopt',{proposalId:p.id,overrideVersion:p.overrideVersion});require('./analytics').track('adjustment_adopted');return r;
}
async function undoOverride(row) {
  if(row.value.target==='workout'&&store.get().session)throw new Error('请先结束正在进行的训练，再恢复原安排');
  const r=await request('day.undo',{proposalId:row.value.proposalId,overrideVersion:row.version});require('./analytics').track('adjustment_undone');return r;
}
function preference(text) {const {date}=current();repo.write('preference','preference:'+repo.id(),{text,active:true,date,at:Date.now()});}
function view(vm,date,task) {
  const e=vm.entitlement;
  if(!e)return {meals:[],activities:[],summary:rules.summary(vm.records,null,date)};
  const list=rules.meals(vm.records,e.id,date);
  const hour=new Date(Date.now()+8*3600000).getUTCHours(),slot=hour<11?'breakfast':hour<17?'lunch':'dinner';
  const generated=require('./meal-plan').cached(vm,date);
  const suggestions=generated?generated.meals.map(x=>require('../shared/nutrition').mealText(x)):require('../shared/guidance').planForDate(e.plan,date).nutrition?.meals||[];
  const meals=list.map((m,i)=>({...m,suggestion:rules.override(vm.records,e.id,date,m.slot)?.text||suggestions[i]||'',current:m.slot===slot}));
  const nutrition=require('../shared/nutrition');
  const plannedMeals=rules.slots.slice(0,3).map((slot,i)=>{const meal=generated?.meals.find(x=>x.slot===slot),record=meals.find(x=>x.slot===slot);return {...meal,slot,label:rules.labels[slot],recorded:!!record?.text,reference:!generated?suggestions[i]||'':'',display:meal?nutrition.display(meal.totals):null};});
  const activities=Object.entries(vm.records).filter(([,r])=>r.value.date===date&&r.value.planId===e.id&&['meal','dayOverride','session'].includes(r.kind)).map(([key,r])=>({key,kind:r.kind,version:r.version,value:r.value,at:r.value.at||Date.parse(r.value.date+'T00:00:00+08:00'),text:r.kind==='meal'?`${rules.labels[r.value.slot]}：${r.value.text||'已撤销记录'}`:r.kind==='session'?`训练${r.value.status==='completed'?'完成':'已中断'} · ${r.value.completedSets} 组`:`${r.value.target==='workout'?'运动':rules.labels[r.value.target]}安排${r.value.active?'已调整':'已恢复'}`,analysis: r.kind==='meal'?(r.value.analysisIds||[]).map(id=>vm.records[id]?.value?.analysis).filter(Boolean):[],canUndo:r.kind==='meal'||r.kind==='dayOverride'&&r.value.active})).sort((a,b)=>b.at-a.at);
  for(const activity of activities){const totals=nutrition.sum(activity.analysis.map(x=>x.consumed));activity.nutritionDisplay=activity.analysis.length?nutrition.display(totals):null;}
  return {plannedMeals,mealPlan:require('./meal-plan').presentation(generated),meals,activities,summary:rules.summary(vm.records,e,date),...rules.effective(vm.records,e,date,task)};
}
async function retry(){const p=store.get().dayPending;if(!p)return;const {action,...data}=JSON.parse(p.signature);return request(action,data);}
module.exports={retry,current,currentMeal,saveMeal,undoMeal,feedback,propose,adopt,undoOverride,preference,view};
