const crypto=require('crypto'), d=require('./domain'), g=require('./guidance');
const invalid=(message,code='INVALID')=>{const e=new Error(message);e.code=code;throw e;};
function config(env=process.env,stage='prod') {
  const products=require('./payment-products').forStage(stage,env);
  const testCheckout=require('./test-checkout').enabled(stage,env);
  const aiEnabled=env.AI_READY==='true'&&require('./cloudbase-ai').ready(env);
  const mealRecognitionEnabled=env.MEAL_RECOGNITION_READY==='true'&&require('./cloudbase-ai').ready(env);
  const nutritionReviewed=!testCheckout&&env.NUTRITION_READY==='true'&&!!env.NUTRITION_REVIEW_ID;
  const numericTargetsEnabled=stage==='test'?env.TEST_NUMERIC_TARGETS_READY!=='false':nutritionReviewed;
  return {numericTargetsEnabled,catalog:g.catalogForStage(stage).map(x=>({...x,price:x.amount/100})),iosCatalog:g.catalogForStage(stage,'ios').map(x=>({...x,price:x.amount/100})),mealRecognitionEnabled,aiEnabled,nutritionReviewed,membershipEnabled:(testCheckout||env.MEMBERSHIP_READY==='true'&&aiEnabled&&nutritionReviewed)&&Object.values(products).every(Boolean)};
}
function requireMember(s,now=Date.now()) {const m=g.membership(s.orders,now);if(!m.active) invalid('请先开通或续购指导服务','MEMBERSHIP_REQUIRED');return m;}
function entitlement(s,assessment,media,cfg,now=Date.now(),loadDelta=0,stage='prod') {
  const m=requireMember(s,now), startDate=d.localDate(now);
  const plan=d.makePlan(assessment,media,{startDate,nutritionReviewed:cfg.nutritionReviewed,numericTargetsEnabled:cfg.numericTargetsEnabled,loadDelta});
  if(!plan) invalid('当前情况建议先获得专业指导');
  const id='week-'+crypto.randomBytes(12).toString('hex');
  const expiresAt=Math.min(Date.parse(startDate+'T00:00:00+08:00')+7*d.DAY,m.expiresAt);
  const body=Buffer.from(JSON.stringify({id,expiresAt})).toString('base64');
  return {id,version:(s.entitlement&&s.entitlement.version||0)+1,status:'active',startDate,startedAt:now,expiresAt,memberPlan:true,plan:{...plan,contentStatus:cfg.testCheckout?'test':'published',testCheckout:!!cfg.testCheckout},credential:body+'.'+crypto.createHmac('sha256',require('./test-checkout').signingSecret(process.env,stage)||'disabled').update(body).digest('hex')};
}
// Upgrade only the current target snapshot. Historical days, workouts and logs are untouched.
function enableNumericTargets(s,cfg,now=Date.now()){
 const e=s.entitlement,p=e?.plan;
 if(!cfg.numericTargetsEnabled||!e?.memberPlan||!p||p.nutrition?.numericEnabled||p.nutrition?.reviewed||g.validate(p.assessment)||!g.suitable(p.assessment))return;
 const updated=d.makePlan(p.assessment,cfg.media,{startDate:e.startDate,nutritionReviewed:cfg.nutritionReviewed,numericTargetsEnabled:true,loadDelta:p.loadDelta||0});
 const date=d.localDate(now),effectiveFrom=date>e.startDate?date:e.startDate;
 const snapshot=(plan,from)=>({effectiveFrom:from,assessment:plan.assessment,nutrition:plan.nutrition,energyTargets:plan.energyTargets||null});
 s.targetsVersion=(s.targetsVersion||0)+1;
 if(updated.energyTargets)updated.energyTargets.version+=':enabled:'+s.targetsVersion;
 const history=p.targetHistory||[snapshot(p,e.startDate)];
 e.plan={...p,nutrition:updated.nutrition,energyTargets:updated.energyTargets||null,targetHistory:[...history.filter(x=>x.effectiveFrom!==effectiveFrom),snapshot(updated,effectiveFrom)]};s.revision++;
}
function validReview(review) {
  return review&&['easy','okay','hard'].includes(review.difficulty)&&['low','okay','high'].includes(review.fatigue)&&['low','okay','high'].includes(review.hunger);
}
function proposal(s,review) {
  if(!validReview(review)) invalid('请完成本周感受');
  const e=s.entitlement;if(!e||!e.memberPlan) invalid('请先生成当前周计划');
  const sessions=Object.values(s.records).filter(r=>r.kind==='session'&&r.value.planId===e.id&&r.value.status==='completed');
  const enough=sessions.length>=2;
  const current=e.plan.loadDelta||0;
  const loadDelta=!enough?current:review.difficulty==='hard'||review.fatigue==='high'?Math.max(-1,current-1):review.difficulty==='easy'&&review.fatigue==='low'?Math.min(1,current+1):current;
  const weights=Object.values(s.records).filter(r=>r.kind==='measurement'&&Number.isFinite(r.value.weight)).map(r=>r.value).sort((a,b)=>a.date.localeCompare(b.date));
  const latest=weights.filter(x=>x.date>=e.startDate).slice(-7);
  const prior=weights.filter(x=>x.date<e.startDate).slice(-7);
  const enoughWeights=latest.length>=3&&prior.length>=3;
  const average=list=>Math.round(list.reduce((n,x)=>n+x.weight,0)/list.length*10)/10;
  const baseline=s.nextAdjustment?.assessment||e.plan.assessment;
  const assessment=enoughWeights?{...baseline,weight:average(latest)}:baseline;
  const reason=(!enough?'训练记录不足，保留当前训练量。':loadDelta<current?'本周吃力或疲劳明显，下周每个动作减少一组。':loadDelta>current?'本周完成轻松且恢复充足，下周每个动作增加一组。':'保留当前训练安排，继续积累执行记录。')+(enoughWeights?'根据多次身体记录更新估算基线，不额外扩大能量缺口。':'身体记录不足，保留营养目标，不按单日体重调整。')+(review.hunger==='high'?'经常饥饿时先保证正餐完整，不继续降低能量目标。':'');
  return {baseVersion:e.version,assessment,loadDelta,reason,review,trend:enoughWeights?{recentAverage:average(latest),previousAverage:average(prior)}:null};
}
function validateProposal(s,p) {
  if(!p||!s.entitlement||p.baseVersion!==s.entitlement.version) invalid('计划已有更新，请重新查看','VERSION_CONFLICT');
  if(![-1,0,1].includes(p.loadDelta)||g.validate(p.assessment)) invalid('调整未通过规则校验');
  return p;
}
async function handle(event,runtime,cfg,now=Date.now()) {
  const {transact,cloud}=runtime, userId=cloud.getWXContext().OPENID, action=event.action;
  const reply=data=>({stage:runtime.stage,sourceVersion:runtime.sourceVersion,code:0,data});
  if(action==='plan.targets.update'){
    if(!/^[-a-zA-Z0-9]{5,80}$/.test(event.requestId||''))invalid('请求标识无效');
    const state=await transact(userId,s=>{
      requireMember(s,now);const e=s.entitlement;
      if(!e?.memberPlan||event.baseVersion!==e.version)invalid('计划已有变化，请刷新','VERSION_CONFLICT');
      const fingerprint=crypto.createHash('sha256').update(JSON.stringify(event.assessment||null)).digest('hex');
      const receipt=(s.targetsOperations||{})[event.requestId];
      if(receipt){if(receipt!==fingerprint)invalid('请求标识已用于其他内容');return {state:require('./business').publicState(s)};}
      if(event.baseTargetsVersion!==(s.targetsVersion||0))invalid('目标设置已有变化，请刷新后重试','VERSION_CONFLICT');
      const a=event.assessment;if(a?.schemaVersion!==3||g.validate(a)||!g.suitable(a))invalid('请完成有效的目标评测');
      const trainingKeys=['minutes','frequency','weekdays','equipment','experience','goal'];
      const current=e.plan,assessment={...a,...Object.fromEntries(trainingKeys.map(k=>[k,current.assessment[k]]))};
      const date=d.localDate(now),plan=d.makePlan(assessment,cfg.media,{startDate:e.startDate,nutritionReviewed:cfg.nutritionReviewed,numericTargetsEnabled:cfg.numericTargetsEnabled,loadDelta:current.loadDelta||0});
      s.mealNutritionBasis={assessment:plan.assessment,assessmentRevision:s.records.assessment?.revision||0};
      s.targetsVersion=(s.targetsVersion||0)+1;
      if(plan.energyTargets)plan.energyTargets.version+=':'+s.targetsVersion;
      const snapshot=(p,effectiveFrom)=>({effectiveFrom,assessment:p.assessment,nutrition:p.nutrition,energyTargets:p.energyTargets||null});
      const history=current.targetHistory||[snapshot(current,e.startDate)];
      const effectiveFrom=date>e.startDate?date:e.startDate;
      e.plan={...current,assessment:plan.assessment,nutrition:plan.nutrition,energyTargets:plan.energyTargets||null,targetHistory:[...history.filter(x=>x.effectiveFrom!==effectiveFrom),snapshot(plan,effectiveFrom)]};
      s.targetsOperations=Object.fromEntries(Object.entries({...s.targetsOperations,[event.requestId]:fingerprint}).slice(-20));
      const trainingChanged=trainingKeys.some(k=>JSON.stringify(a[k])!==JSON.stringify(current.assessment[k]));
      if(trainingChanged||s.nextAdjustment)s.nextAdjustment={assessment:{...a},loadDelta:s.nextAdjustment?.loadDelta??current.loadDelta??0,requestId:event.requestId};
      s.proposal=null;s.revision++;
      return {preview:plan,effectiveFrom,state:require('./business').publicState(s)};
    });return reply(state);
  }
  if(action==='plan.preview') {
    const plan=d.makePlan(event.assessment,cfg.media,{nutritionReviewed:cfg.nutritionReviewed,numericTargetsEnabled:cfg.numericTargetsEnabled});
    if(!plan) invalid('当前情况建议先获得专业指导');
    return reply({plan});
  }
  if(action==='plan.get') {
    const result=await transact(userId,s=>({entitlement:s.entitlement,membership:g.membership(s.orders,now)}));
    return reply(result);
  }
  if(action==='plan.generate'||action==='plan.confirm') {
    if(!/^[-a-zA-Z0-9]{5,80}$/.test(event.requestId||'')) invalid('请求标识无效');
    if((!cfg.contentPublished&&!cfg.testCheckout)||!require('./test-checkout').signingSecret(process.env,runtime.stage)) invalid('训练内容尚未开放');
    const old=await transact(userId,s=>s.entitlement);
    if(old&&old.memberPlan) await runtime.archivePlan(userId,old);
    const e=await transact(userId,s=>{
      requireMember(s,now);
      s.planOperations=s.planOperations||{};
      if(s.planOperations[event.requestId]) {if(s.planOperations[event.requestId]!==action) invalid('请求标识已用于其他操作');return s.entitlement;}
      if(s.nextAdjustment&&s.nextAdjustment.requestId===event.requestId) return s.entitlement;
      if(s.entitlement&&s.entitlement.requestId===event.requestId) return s.entitlement;
      let assessment=event.assessment, loadDelta=s.entitlement?.plan?.loadDelta||0;
      if(action==='plan.confirm') {
        if(event.baseVersion!==s.entitlement?.version || event.proposalId!==s.proposal?.requestId) invalid('调整建议已有变化，请重新查看','VERSION_CONFLICT');
        const p=validateProposal(s,s.proposal);
        assessment=p.assessment;loadDelta=p.loadDelta;
        // A current week is immutable: confirmed changes start the next week.
        if(d.active(s.entitlement,now)) {
          s.nextAdjustment={assessment,loadDelta,requestId:event.requestId};s.proposal=null;s.planOperations[event.requestId]=action;s.revision++;
          return s.entitlement;
        }
      } else if(s.entitlement&&s.entitlement.memberPlan&&d.active(s.entitlement,now)) {s.planOperations[event.requestId]=action;return s.entitlement;}
      if(s.nextAdjustment) {assessment=s.nextAdjustment.assessment;loadDelta=s.nextAdjustment.loadDelta;}
      if(!assessment&&s.entitlement) assessment=s.entitlement.plan.assessment;
      if(!assessment||![2,3].includes(assessment.schemaVersion)) assessment=s.orders.filter(o=>o.sku&&o.status==='paid'&&!o.redacted).sort((a,b)=>b.paidAt-a.paidAt)[0]?.plan?.assessment;
      s.entitlement=entitlement(s,assessment,cfg.media,cfg,now,loadDelta,runtime.stage);
      if(!s.records.assessment||assessment===s.records.assessment.value||action==='plan.confirm'||s.nextAdjustment)
        s.mealNutritionBasis={assessment:s.entitlement.plan.assessment,assessmentRevision:s.records.assessment?.revision||0};
      s.entitlement.requestId=event.requestId;s.planOperations[event.requestId]=action;s.proposal=null;s.nextAdjustment=null;s.revision++;
      return s.entitlement;
    });
    await runtime.archivePlan(userId,e);
    return reply({entitlement:e,state:await transact(userId,s=>require('./business').publicState(s))});
  }
  if(action==='plan.review') {
    const p=await transact(userId,s=>{
      requireMember(s,now);
      if(!/^[-a-zA-Z0-9]{5,80}$/.test(event.requestId||'')||event.baseVersion!==s.entitlement?.version) invalid('计划已有更新','VERSION_CONFLICT');
      if(s.proposal&&s.proposal.requestId===event.requestId) return s.proposal;
      const result=proposal(s,event.review);s.proposal={...result,requestId:event.requestId};s.revision++;return s.proposal;
    });return reply({proposal:p});
  }
  if(action.startsWith('ai.')) return reply(await require('./daily-ai').handle(event,runtime,cfg,now));
  return null;
}
module.exports={enableNumericTargets,config,requireMember,entitlement,proposal,validateProposal,handle};
