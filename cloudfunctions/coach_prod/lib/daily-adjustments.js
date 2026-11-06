const d=require('./domain'), rules=require('./daily'), business=require('./business');
const fail=(message,code='INVALID')=>business.fail(message,code);
function check(s,event,now) {
  const e=s.entitlement;
  if(!d.active(e,now)||event.planId!==e.id||event.date!==d.localDate(now))fail('日期或计划已变化，请返回今天重新操作','VERSION_CONFLICT');
  if(e.memberPlan)require('./guided').requireMember(s,now);
  if(event.baseVersion!==(e.version||0))fail('周计划已有更新，请重新查看','VERSION_CONFLICT');
  return e;
}
function locked(s,e,date) {if(Object.values(s.records).some(r=>r.kind==='session'&&r.value.planId===e.id&&r.value.date===date&&r.value.status==='completed'))fail('今天的训练已完成，不能重写');}
function build(s,e,input,date) {
  const day=d.currentDay(e,Date.parse(date+'T12:00:00+08:00')),original=e.plan.days[day];
  if(input.target==='workout') {
    locked(s,e,date);
    if(original.rest&&input.mode!=='rest')fail('今天是恢复日，不额外增加训练');
    const preferences=Object.values(s.records).filter(r=>r.kind==='preference'&&r.value.active).map(r=>r.value.text);
    if(input.mode!=='rest'&&preferences.some(text=>/运动|训练|动作|深蹲|俯卧撑|臀桥|鸟狗|划船|疼|痛/.test(text)))fail('已保留长期运动偏好，请结合周回顾核验后调整；今天可选择恢复安排');
    const task=JSON.parse(JSON.stringify(original));
    let minutes=e.plan.minutes;
    if(input.mode==='rest'){task.rest=true;task.exercises=[];task.title='今日暂停训练，优先恢复';minutes=0;}
    else {
      if(!['short','light'].includes(input.mode))fail('不支持的调整');
      if(input.mode==='short'&&(!Number.isInteger(input.minutes)||input.minutes<5||input.minutes>60))fail('请提供 5–60 分钟的可用时间');
      minutes=Math.min(e.plan.minutes,input.mode==='short'?input.minutes:Math.max(5,Math.floor(e.plan.minutes/2)));
      const maxSets=Math.max(1,Math.floor((minutes-2)/2));
      let budget=maxSets;
      task.exercises=task.exercises.map(x=>{const sets=budget>0?1:0;budget-=sets;return {...x,sets};}).filter(x=>x.sets);
      task.title=`今天约 ${minutes} 分钟 · 轻量版`;
    }
    return {target:'workout',task,minutes,reason:input.mode==='rest'?'你报告了不适，今天停止训练，必要时寻求专业帮助。':'根据今天的时间或恢复情况减少训练量，不补偿性加练。'};
  }
  if(!rules.slots.includes(input.target))fail('请先选择要调整的餐次');
  const a=e.plan.assessment;
  const preferences=Object.values(s.records).filter(r=>r.kind==='preference'&&r.value.active);
  if(a?.allergies?.trim()||preferences.length)fail('已保留你的饮食限制与偏好，具体食材替换需要核验；可先记录实际餐食或向教练咨询');
  const vegetarian=a?.diet==='vegetarian';
  // Food structures only; no unreviewed numeric nutrition or exercise synthesis.
  const text=input.mode==='outside' ? `外食${rules.labels[input.target]}：选择主食、${vegetarian?'豆制品':'蛋白质食物'}和蔬菜的组合，按实际饥饱进食。` : input.variant ? `${rules.labels[input.target]}：采用分开搭配的主食、${vegetarian?'豆制品':'蛋白质食物'}与蔬菜，按实际饥饱进食。` : `${rules.labels[input.target]}：换一种主食，搭配${vegetarian?'豆制品':'蛋白质食物'}和蔬菜；按现有食谱份量准备。`;
  return {target:input.target,text,reason:'根据今天的饮食条件更换这一餐，保持原有饮食结构。'};
}
async function handle(event,runtime,now=Date.now()) {
  if(!/^[-a-zA-Z0-9]{5,80}$/.test(event.requestId||''))fail('请求标识无效');
  const userId=runtime.cloud.getWXContext().OPENID;
  return runtime.transact(userId,s=>{
    const e=check(s,event,now), action=event.action;
    s.dayProposals=s.dayProposals||{};s.dayOperations=s.dayOperations||{};
    const fingerprint=require('crypto').createHash('sha256').update(JSON.stringify({action,planId:event.planId,date:event.date,input:event.input,proposalId:event.proposalId,target:event.target,overrideVersion:event.overrideVersion})).digest('hex');
    const previous=s.dayOperations[event.requestId];
    if(previous){if(previous.fingerprint!==fingerprint)fail('请求标识已用于其他内容');return {...previous.result,state:business.publicState(s)};}
    let result;
    if(action==='day.propose') {
      if(Object.keys(s.dayProposals).length>=1000)fail('调整记录已达上限，请联系客服');
      const proposal={...build(s,e,event.input||{},event.date),id:event.requestId,planId:e.id,date:event.date,baseVersion:e.version||0};
      const key=rules.overrideKey(e.id,event.date,proposal.target);
      proposal.overrideVersion=s.records[key]?.version||0;
      s.dayProposals[proposal.id]=proposal;result={proposal};
    } else if(action==='day.adopt'||action==='day.undo') {
      const p=s.dayProposals[event.proposalId];
      if(!p||p.planId!==e.id||p.date!==event.date||p.baseVersion!==(e.version||0))fail('建议已失效，请重新生成','VERSION_CONFLICT');
      const key=rules.overrideKey(e.id,event.date,p.target),old=s.records[key];
      if((old?.version||0)!==event.overrideVersion)fail('当天安排已在其他设备修改，请刷新','VERSION_CONFLICT');
      if(p.target==='workout')locked(s,e,event.date);
      if(action==='day.adopt'&&p.adopted)fail('建议已采用，请重新生成');
      if(action==='day.undo'&&(!old?.value.active||old.value.proposalId!==p.id))fail('当前安排已变化，请刷新','VERSION_CONFLICT');
      const value=action==='day.adopt'?{...p,proposalId:p.id,active:true,at:now,previous:old?.value||null}:{...(old.value.previous||{planId:e.id,date:event.date,target:p.target,active:false}),at:now};
      if(action==='day.adopt'){p.adopted=true;p.applied=value;}
      s.records[key]={kind:'dayOverride',value,version:(old?.version||0)+1,revision:s.revision+1};
      result={override:s.records[key]};
    } else fail('不支持的当天操作');
    s.revision++;s.dayOperations[event.requestId]={fingerprint,result};
    if(JSON.stringify(s).length>700000)fail('调整记录已达容量限制，请联系客服');
    return {...result,state:business.publicState(s)};
  });
}
module.exports={handle,build};
