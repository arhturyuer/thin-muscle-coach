/* Pure daily interaction rules; shared by the client and the service. */
const slots = ['breakfast', 'lunch', 'dinner', 'snack'];
const labels = {breakfast:'早餐', lunch:'午餐', dinner:'晚餐', snack:'加餐'};
const slotOf = text => /早[餐饭]/.test(text) ? 'breakfast' : /午[餐饭]/.test(text) ? 'lunch' : /晚[餐饭]/.test(text) ? 'dinner' : /加餐|零食/.test(text) ? 'snack' : '';
const mealKey = (planId,date,slot) => `meal:${planId}:${date}:${slot}`;
const overrideKey = (planId,date,target) => `override:${planId}:${date}:${target}`;
function meals(records, planId, date) {
  const old = records[`daily:${planId}:${date}`]?.value || {};
  return slots.map(slot => {
    const key=mealKey(planId,date,slot), row=records[key];
    return {key,slot,label:labels[slot],text:row ? row.value.text : old[slot] || '',source:row?.value.source || 'legacy',at:row?.value.at || 0,version:row?.version || 0};
  });
}
const dietScope=date=>'diet-'+require('./workout').week(date).start;
function mealsForDate(records,date,fallbackId) {
  const dietId=dietScope(date);
  const bySlot={}, oldBySlot={};
  const newer=(entry,old)=>!old||Number(!!entry.pending)>Number(!!old.pending)||
    !!entry.pending===!!old.pending&&((entry.value.at||0)>(old.value.at||0)||
      (entry.value.at||0)===(old.value.at||0)&&(entry.revision||0)>(old.revision||0));
  for(const row of Object.values(records||{})) {
    const v=row.value;
    if(v.date!==date)continue;
    if(row.kind==='meal'&&(bySlot[v.slot]?.value.planId!==dietId||v.planId===dietId)&&
      (v.planId===dietId&&bySlot[v.slot]?.value.planId!==dietId||newer(row,bySlot[v.slot])))bySlot[v.slot]=row;
    if(row.kind==='daily')for(const slot of slots)if(v[slot]&&newer(row,oldBySlot[slot]))oldBySlot[slot]=row;
  }
  return slots.map(slot=>{
    const row=bySlot[slot],old=oldBySlot[slot],planId=row?.value.planId||old?.value.planId||fallbackId||dietId;
    return {key:mealKey(planId,date,slot),planId,date,slot,label:labels[slot],text:row?row.value.text:old?.value[slot]||'',
      source:row?.value.source||'legacy',version:row?.version||0,at:row?.value.at||0,value:row?.value};
  });
}
function override(records,planId,date,target) {const row=records[overrideKey(planId,date,target)];return row?.value.active ? row.value : null;}
function effective(records,e,date,task) {
  if(!e)return {task,minutes:0};
  const value=override(records,e.id,date,'workout');
  return {task:value?.task || task, minutes:value?.minutes ?? e.plan.minutes,adjustmentId:value?.proposalId || null};
}
function number(text) {
  if(/^\d+$/.test(text))return +text;
  const digits={零:0,一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9};
  if(text.includes('十')){const [a,b]=text.split('十');return (digits[a]||1)*10+(digits[b]||0);}return digits[text];
}
function interpret(text) {
  const result={records:[],questions:[],adjustment:null,preference:null,feedback:{},handled:false};
  if(/以后|今后|一直|长期/.test(text)){result.preference=text;result.handled=true;return result;}
  if(/昨天|明天|前天|后天/.test(text))return result;
  const parts=text.split(/[，,。；;\n]/).flatMap(part=>{
    const positions=Array.from(part.matchAll(/([早午晚][餐饭]|加餐)/g)).map(x=>x.index);
    return positions.length<2?[part]:positions.map((pos,i)=>part.slice(i===0?0:pos,positions[i+1]));
  });
  for(const part of parts.map(x=>x.trim()).filter(Boolean)) {
    if(/准备|打算|想吃|要吃|计划|明天|昨天|没吃|没有吃|没喝|没有喝|还没|未吃|不吃|不想吃|吃什么|吃了吗|能吃|可以吃|要不要|如果|假如|是不是|不是|不确定|记得吗|[？?]/.test(part))continue;
    if(!/吃了|喝了|吃过|喝过|已吃|已喝/.test(part))continue;
    const slot=slotOf(part), content=part.replace(/^(早餐|早饭|午餐|午饭|晚餐|晚饭|加餐)[：:\s]*/,'').trim();
    if(slot)result.records.push({slot,text:content,source:'text'});else result.questions.push({text:content,source:'text'});
  }
  const time=text.match(/(?:只有|只剩|剩下|缩短到|改成|仅有)\s*([\d一二两三四五六七八九十]+)\s*分钟/);
  const symptoms=text.replace(/(?:没有|并无|不再)(?:疼痛|不适|头晕|受伤|不舒服)/g,'');
  const pain=/疼|痛|受伤|不舒服|不适|头晕/.test(symptoms);
  const tired=/很累|疲劳|太累|没恢复/.test(text)&&!/不累|没有疲劳/.test(text);
  if(pain)result.adjustment={target:'workout',mode:'rest',reason:'你报告了不适，今天停止相关训练，不安排补偿性加练。'};
  else if(time)result.adjustment={target:'workout',mode:'short',minutes:number(time[1]),reason:'根据今天可用时间缩短安排，不补偿性加练。'};
  else if(tired)result.adjustment={target:'workout',mode:'light',reason:'今天疲劳明显，降低训练量，保留恢复时间。'};
  else if(/换一道|换一个|外食|外卖|没有.*食材|没有.*[蛋肉菜米奶]|不想吃/.test(text))result.adjustment={target:slotOf(text)||'meal',mode:/外食|外卖/.test(text)?'outside':'swap',reason:'根据今天的饮食条件更换这一餐。'};
  if(tired)result.feedback.fatigue='high';
  if(/经常饿|很饿|总是饿/.test(text))result.feedback.hunger='high';
  if(/精神充足/.test(text))result.feedback.fatigue='low';
  if(/饱腹合适|饥饿感舒服/.test(text))result.feedback.hunger='okay';
  if(Object.keys(result.feedback).length)result.feedback.scope=/本周|这周/.test(text)?'week':'day';
  result.handled=!!(result.records.length||result.questions.length||result.adjustment||Object.keys(result.feedback).length);
  return result;
}
function summary(records,e,date) {
  const values=Object.values(records||{}), start=e?.startDate || date;
  const week=values.filter(r=>r.value.date>=start&&r.value.date<=date&&(!r.value.planId||r.value.planId===e?.id));
  const sessions=require('./workout').sessions(records).filter(r=>r.value.date>=start&&r.value.date<=date&&(r.kind==='workoutRecord'||!r.value.planId||r.value.planId===e?.id));
  const feedback=week.filter(r=>r.kind==='dailyFeedback').sort((a,b)=>b.value.at-a.value.at);
  const inferred={};
  for(const key of ['fatigue','hunger']){const candidates=feedback.filter(r=>r.value[key]);const weekly=candidates.find(r=>r.value.scope==='week');if(weekly)inferred[key]=weekly.value[key];else if(new Set(candidates.map(r=>r.value.date)).size>=2&&new Set(candidates.map(r=>r.value[key])).size===1)inferred[key]=candidates[0].value[key];}
  const known=sessions.filter(r=>['easy','okay','hard'].includes(r.value.difficulty));
  if(known.length>=2){const ranked=known.map(r=>r.value.difficulty);inferred.difficulty=ranked.includes('hard')?'hard':ranked.every(x=>x==='easy')?'easy':'okay';}
  const recordedDays=new Set(week.filter(r=>r.kind==='meal'&&r.value.text||r.kind==='daily'&&['breakfast','lunch','dinner'].some(k=>r.value[k])).map(r=>r.value.date)).size;
  return {completed:sessions.filter(r=>r.value.status==='completed').length,recordedDays,adjustments:week.filter(r=>r.kind==='dayOverride'&&r.value.active).length,feedback:inferred,feelingCount:known.length};
}
module.exports={slots,labels,slotOf,mealKey,overrideKey,meals,mealsForDate,dietScope,override,effective,interpret,summary};
