const store=require('../core/store'),repo=require('./repository'),api=require('./api'),d=require('../shared/domain'),n=require('../shared/nutrition');
const key=(planId,date)=>planId+':'+date;
function cached(s,date){const e=s.entitlement,plan=e&&require('../shared/guidance').planForDate(e.plan,date),p=e&&(s.mealPlans||{})[key(e.id,date)];return p&&p.baseVersion===(e.version||0)&&p.targetVersion===(plan.energyTargets?.version||plan.version)?p:null;}
function presentation(plan){return plan?{...plan,display:n.display(plan.totals),meals:plan.meals.map(m=>({...m,display:n.display(m.totals),text:n.mealText(m)}))}:null;}
async function load(force=false){
 const {s,e,date}=require('./daily').current();
 if(!s.online)throw new Error('当前离线，已保存的食谱仍可查看');
 if(!s.config.aiEnabled)throw new Error('食谱生成暂未开放');
 if(!s.mealPlanConsent){
  await require('../core/feedback').requirePrivacy();
  const result=await wx.showModal({title:'生成个性化三餐食谱',content:'使用你的评测、饮食限制和已确认的饮食照片分析记录，由腾讯云 CloudBase AI 生成今日食谱与建议份量。营养数值为估算，可修改记录，历史习惯不替代忌口限制。',confirmText:'同意并生成'});
  if(!result.confirm)return null;
  if(store.get().owner!==s.owner)throw new Error('账号已变化，请重新打开');store.save({mealPlanConsent:true});
 }
 await require('./syncService').flush();
 if(store.get().queue.some(x=>['meal','mealAnalysis'].includes(x.kind)))throw new Error('饮食记录尚未同步，请联网同步后再生成食谱');
 if(store.get().conflicts.some(x=>['meal','mealAnalysis'].includes(x.operation.kind)))throw new Error('饮食记录存在冲突，请先在“我的”处理');
 let pending=store.get().mealPlanPending;
 if(pending&&(pending.planId!==e.id||pending.date!==date||pending.baseVersion!==(e.version||0)))pending=null;
 if(!pending){pending={requestId:repo.id(),date,planId:e.id,baseVersion:e.version||0,force};store.save({mealPlanPending:pending});}
 try{
  const result=await api.call('meal.plan',{...pending,consent:true});
  const latest=store.get();if(latest.owner!==s.owner||latest.entitlement?.id!==e.id||latest.entitlement?.version!==e.version||result.plan.targetVersion!==(latest.entitlement.plan.energyTargets?.version||latest.entitlement.plan.version)||date!==d.localDate())throw new Error('账号、日期或计划已变化，请重新生成');
  store.save({mealPlans:Object.fromEntries(Object.entries({...latest.mealPlans,[key(e.id,date)]:result.plan}).slice(-28)),mealPlanPending:null});return result.plan;
 }catch(error){if(['INVALID','VERSION_CONFLICT','MEMBERSHIP_REQUIRED','QUOTA_EXCEEDED'].includes(error.code))store.save({mealPlanPending:null});throw error;}
}
module.exports={key,cached,presentation,load};
