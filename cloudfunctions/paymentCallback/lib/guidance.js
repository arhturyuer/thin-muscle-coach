/* Versioned rules: numeric nutrition is gated by the server's review configuration. */
const RULE_VERSION = 'guidance-2';
const catalog = [
  {sku:'month', title:'月度指导', months:1, amount:1900},
  {sku:'year', title:'年度指导', months:12, amount:19800},
  {sku:'three_year', title:'三年指导', months:36, amount:29800}
];
// The deployed function stage, never request data, selects the price catalog.
function catalogForStage(stage, paymentPlatform) {
  if(stage==='test'&&paymentPlatform==='ios')return [{...catalog[0],amount:100}];
  return catalog.map((product,index)=>({...product,amount:stage==='test'?index+1:product.amount}));
}
function validate(a) {
  if (!a || ![2,3].includes(a.schemaVersion) || !a.consent) return '请先同意健康信息用于生成与同步计划';
  if (!Number.isInteger(+a.age) || +a.age < 18 || +a.age > 100) return '请输入 18–100 岁的年龄';
  if (!['clear','guidance'].includes(a.screening)) return '请完成适用性确认';
  if (!['male','female'].includes(a.sex) || !Number.isFinite(+a.height) || +a.height < 100 || +a.height > 230 || !Number.isFinite(+a.weight) || +a.weight < 30 || +a.weight > 250) return '请检查身高、体重与生理性别';
  if (a.schemaVersion === 3) {
    const target=+a.targetWeight, bmi=target/Math.pow(+a.height/100,2);
    if (!Number.isFinite(target)||target<30||target>250||bmi<18.5||bmi>=30) return '目标体重需在 BMI 18.5–30（不含30）的自动方案范围内';
    if (!['gentle','moderate','fast'].includes(a.pace)) return '请选择目标速度';
    if (!Number.isInteger(+a.stepGoal)||+a.stepGoal<1000||+a.stepGoal>20000) return '每日步数目标需为1000–20000的整数';
  }
  if (a.waist !== '' && a.waist != null && (!Number.isFinite(+a.waist) || +a.waist < 30 || +a.waist > 250)) return '请检查腰围';
  if (!['fat_loss','muscle','habit'].includes(a.goal) || !['beginner','occasional'].includes(a.experience) || !['sedentary','light','active'].includes(a.activity)) return '请选择目标、经验和活动量';
  if (![15,30].includes(+a.minutes) || ![2,3,4].includes(+a.frequency) || !['none','band'].includes(a.equipment)) return '请选择训练条件';
  if (!Array.isArray(a.weekdays) || a.weekdays.length !== +a.frequency || new Set(a.weekdays.map(Number)).size !== +a.frequency || !a.weekdays.every(x => Number.isInteger(+x) && +x >= 0 && +x <= 6)) return '可训练日数量需与每周训练次数一致';
  if (!['takeout','canteen','cook'].includes(a.foodScene) || !['irregular','protein','snacking'].includes(a.foodObstacle) || !['none','vegetarian'].includes(a.diet)) return '请选择饮食习惯';
  if (typeof a.allergies !== 'string' || a.allergies.length > 200) return '饮食禁忌请控制在 200 字以内';
  return '';
}
function suitable(a) {
  const bmi = +a.weight / Math.pow(+a.height/100,2);
  return a.screening === 'clear' && +a.age <= 65 && bmi >= 18.5 && bmi < 30;
}
// Product estimates, not a clinical forecast. Parameters remain subject to nutrition review.
const ENERGY_VERSION='energy-1';
const energyPolicy={activity:{sedentary:1.2,light:1.375,active:1.55},steps:{sedentary:4000,light:6000,active:8000},loss:{gentle:.0025,moderate:.005,fast:.0075},gain:{gentle:.001,moderate:.002,fast:.003},walkingMet:3,walkingKmh:4,strideHeight:.415,trainingMet:3.5,trainingFraction:.6,lossLimit:.2,gainLimit:.1,gainMax:300,kcalPerKg:7700};
function basal(a,weight=+a.weight){return 10*weight+6.25*+a.height-5*+a.age+(a.sex==='male'?5:-161);}
function walking(a,steps=+a.stepGoal,weight=+a.weight){return (energyPolicy.walkingMet-1)*weight*(steps*+a.height/100*energyPolicy.strideHeight/1000)/energyPolicy.walkingKmh;}
function training(a,minutes=+a.minutes,weight=+a.weight){return (energyPolicy.trainingMet-1)*weight*minutes/60*energyPolicy.trainingFraction;}
function energyAt(a,weight,direction){
 const bmr=basal(a,weight), baseline=energyPolicy.steps[a.activity];
 const maintenance=bmr*energyPolicy.activity[a.activity]+walking(a,+a.stepGoal-baseline,weight)+training(a,+a.minutes,weight)*+a.frequency/7;
 const requested=direction==='maintain'?0:weight*energyPolicy[direction==='loss'?'loss':'gain'][a.pace]*energyPolicy.kcalPerKg/7;
 // No separate approved sex-specific intake floor exists in the current rules; retain the BMR floor.
 const allowed=direction==='loss'?Math.max(0,Math.min(requested,maintenance*energyPolicy.lossLimit,maintenance-bmr)):Math.min(requested,maintenance*energyPolicy.gainLimit,energyPolicy.gainMax);
 const intake=direction==='loss'?Math.ceil(maintenance-allowed):direction==='gain'?Math.floor(maintenance+allowed):Math.round(maintenance);
 const delta=direction==='loss'?Math.max(0,maintenance-intake):direction==='gain'?Math.max(0,intake-maintenance):0;
 return {bmr,maintenance,requested,delta,intake,limited:allowed+1<requested};
}
function energyTargets(a){
 const direction=Math.abs(+a.targetWeight-+a.weight)<=.1000001?'maintain':+a.targetWeight<+a.weight?'loss':'gain';
 const first=energyAt(a,+a.weight,direction);let weight=+a.weight,weeks=0,limited=first.limited;
 if(direction!=='maintain')while((direction==='loss'?weight>+a.targetWeight:weight<+a.targetWeight)&&weeks<520){
  const step=energyAt(a,weight,direction);limited=limited||step.limited;
  if(step.delta<1){weeks=null;break;}
  weight+=(direction==='loss'?-1:1)*step.delta*7/energyPolicy.kcalPerKg;weeks++;
 }
 const longTerm=weeks===520||weeks===null;
 return {version:ENERGY_VERSION,estimate:true,direction,pace:a.pace,targetWeight:+a.targetWeight,stepGoal:+a.stepGoal,baselineSteps:energyPolicy.steps[a.activity],basalKcal:Math.round(first.bmr),maintenanceKcal:Math.round(first.maintenance),intakeKcal:first.intake,walkingKcal:Math.round(walking(a)),trainingKcal:Math.round(training(a)),estimatedWeeks:direction==='maintain'?null:longTerm?null:weeks,longTerm,limited,note:direction==='maintain'?'维持目标，无需设定达成期限。':longTerm?'目标跨度较长，建议分阶段复评，不提供确定达成日期。':limited?'已限制能量差，预计周期相应延长；结合每周反馈复评。':'预计周期随执行与身体反馈变化，不承诺达成日期。',basis:{...energyPolicy,weight:+a.weight,height:+a.height,age:+a.age,sex:a.sex,activity:a.activity,minutes:+a.minutes,frequency:+a.frequency}};
}
// Target edits apply from their Shanghai date; earlier days retain their saved baseline.
function planForDate(plan,date){
 if(!plan||!date||!plan.targetHistory?.length)return plan;
 const saved=plan.targetHistory.filter(x=>x.effectiveFrom<=date).sort((a,b)=>b.effectiveFrom.localeCompare(a.effectiveFrom))[0];
 return saved?{...plan,assessment:saved.assessment,nutrition:saved.nutrition,energyTargets:saved.energyTargets}:plan;
}
function dailyEnergy(plan,task,minutes){
 const t=plan?.energyTargets;if(!t||!task)return null;
 const trainingKcal=task.rest?0:Math.round(training(plan.assessment,minutes??plan.minutes));
 return {...t,trainingKcal,activityKcal:trainingKcal+t.walkingKcal};
}
function nutrition(a, reviewed, numericEnabled=reviewed) {
  const rmr = 10 * +a.weight + 6.25 * +a.height - 5 * +a.age + (a.sex === 'male' ? 5 : -161);
  const maintenance = rmr * ({sedentary:1.2,light:1.375,active:1.55}[a.activity]);
  const targets=a.schemaVersion===3?energyTargets(a):null;
  const energy = targets?targets.intakeKcal:Math.round(Math.max(rmr, maintenance * ({fat_loss:0.9,muscle:1.05,habit:1}[a.goal])) / 50) * 50;
  const protein = Math.round(+a.weight * (a.goal === 'muscle' ? 1.6 : 1.2));
  const fat = Math.round(energy * 0.3 / 9);
  const scenes = {takeout:'外卖优先选可分装的主食、蔬菜和蛋白质食物，酱汁另放。',canteen:'食堂分别选择主食、蔬菜和蛋白质食物，按饥饱感调整。',cook:'做饭提前备好主食、蔬菜和蛋白质食物，减少临时凑餐。'};
  const obstacles = {irregular:'先安排三餐的大致时间，忙碌时保留一顿方便的备用餐。',protein:'检查每顿是否有适合自己的蛋白质食物。',snacking:'正餐吃完整，想加餐时先观察饥饿感。'};
  return {
    reviewed:!!reviewed,numericEnabled:!!numericEnabled, ruleVersion:RULE_VERSION,
    ...(numericEnabled ? {energy,protein,fat,carbohydrate:Math.round((energy-protein*4-fat*9)/4),distribution:[0.3,0.4,0.3]} : {}),
    note:numericEnabled ? '估算目标，结合长期执行反馈复评，不是精确测量。' : '营养数值方案尚待专业审核，当前展示饮食结构与执行方法。',
    scene:scenes[a.foodScene], task:obstacles[a.foodObstacle],
    meals:a.allergies.trim() ? ['已记录饮食禁忌；未核验食材前不推荐具体餐食。'] : a.diet === 'vegetarian' ? ['早餐：燕麦、豆制品和水果','午餐：米饭、豆类和蔬菜','晚餐：杂粮、豆制品和蔬菜'] : ['早餐：主食、蛋白质食物和水果','午餐：主食、鱼肉蛋豆任选与蔬菜','晚餐：主食、蛋白质食物和蔬菜'],
    alternative:a.allergies.trim() ? '存在饮食禁忌，仅提供餐食结构；先核对标签、加工与交叉接触信息。' : a.diet === 'vegetarian' ? '肉类替换为适合自己的豆类或豆制品。' : '同类食物可替换，外食也可以按餐食结构组合。'
  };
}
function makePlan(a, exercises, media={}, options={}) {
  const error = validate(a); if (error) throw new Error(error);
  if (!suitable(a)) return null;
  const startDate = options.startDate || new Date(Date.now()+8*3600000).toISOString().slice(0,10);
  const localWeekday = new Date(Date.parse(startDate+'T00:00:00+08:00')+8*3600000).getUTCDay();
  const food = nutrition(a,options.nutritionReviewed,options.numericTargetsEnabled??options.nutritionReviewed);
  const sets = Math.max(1,(+a.minutes===30 ? 3 : 2) + (options.loadDelta || 0));
  const reason = [`每周 ${a.frequency} 天，安排在你选择的可训练日。`, a.experience==='beginner'?'从低难度基础动作开始，先熟悉动作。':'在基础动作上逐步积累训练量。', food.scene];
  const moves = exercises.filter(e => e.id!=='row' || a.equipment==='band').map(e=>({...e,sets,reps:a.experience==='beginner'?Math.max(4,e.reps-2):e.reps+(a.goal==='muscle'?2:0),media:media[e.id]||''}));
  return {...(a.schemaVersion===3&&(options.numericTargetsEnabled??options.nutritionReviewed)?{energyTargets:energyTargets(a)}:{}),version:RULE_VERSION, loadDelta:options.loadDelta||0, schemaVersion:2, contentStatus:'draft', assessment:{...a}, startDate, minutes:+a.minutes, equipment:a.equipment, title:`居家${a.equipment==='band'?'弹力带':'自重'} · 每周 ${a.frequency} 次`,reason:reason.join(' '),reasons:reason,nutrition:food,
    direction:{fat_loss:'先稳定饮食与力量训练，逐步改善身体组成。',muscle:'先学会基础动作，再逐步积累力量与肌肉。',habit:'先建立能持续的饮食和训练节奏。'}[a.goal],
    days:Array.from({length:7},(_,i)=>{const rest=!a.weekdays.map(Number).includes((localWeekday+i)%7);return {index:i,title:rest?'恢复与生活练习':'全身基础力量',rest,exercises:rest?[]:moves,nutrition:food.task,short:'时间不足时先做首个熟悉的动作一组，记录实际完成情况，不补偿性加练。'};})};
}
function addMonths(time,months) {
  const t=new Date(time+8*3600000),day=t.getUTCDate();
  t.setUTCDate(1); t.setUTCMonth(t.getUTCMonth()+months);
  const end=new Date(Date.UTC(t.getUTCFullYear(),t.getUTCMonth()+1,0)).getUTCDate();
  t.setUTCDate(Math.min(day,end)); return t.getTime()-8*3600000;
}
function membership(orders,now=Date.now()) {
  let until=0; const segments=[];
  for (const o of orders.filter(o=>o.sku&&o.status==='paid'&&!o.redacted).sort((a,b)=>a.paidAt-b.paidAt || a.id.localeCompare(b.id))) {
    const startsAt=Math.max(until,o.paidAt), expiresAt=addMonths(startsAt,o.months);
    segments.push({orderId:o.id,sku:o.sku,startsAt,expiresAt}); until=expiresAt;
  }
  return {active:segments.some(x=>x.startsAt<=now&&x.expiresAt>now),expiresAt:until,segments};
}
module.exports={RULE_VERSION,catalog,catalogForStage,ENERGY_VERSION,energyPolicy,basal,walking,training,energyTargets,planForDate,dailyEnergy,validate,suitable,nutrition,makePlan,addMonths,membership};
