/* Explain the same date-scoped projections shown on Today; never create new targets. */
const g=require('../shared/guidance');
const number=x=>typeof x==='number'&&Number.isFinite(x);
const shown=x=>number(x)?String(Math.round(x)):'待确认';
function view(vm,date=vm.date){
  const calendar=require('./dashboard').calendar(vm,date),plan=calendar.view.plan;
  const daily=require('./daily').view(vm,calendar.selected,calendar.view.task);
  const workout=require('./workout').view(vm,calendar.selected);
  const summary=require('./today-summary').view(vm,calendar,daily,workout);
  const a=plan?.assessment||vm.records?.assessment?.value||{},t=plan?.energyTargets;
  const basalValid=['weight','height','age'].every(k=>Number.isFinite(+a[k])&&+a[k]>0)&&['male','female'].includes(a.sex);
  const basal=basalValid?g.basal(a):null;
  const coefficient=a.sex==='male'?'+ 5':'− 161';
  const inputs=basalValid?`${a.weight} 千克 · ${a.height} 厘米 · ${a.age} 岁 · ${a.sex==='male'?'男':'女'}`:'补充身体评测后展示你的计算过程';
  const source=t?.basis||a,policy={...g.energyPolicy,...t?.basis,activity:g.energyPolicy.activity};
  const factor=policy.activity?.[a.activity]??g.energyPolicy.activity[a.activity];
  let maintenance=t?.maintenanceKcal??(basalValid&&number(factor)?Math.round(basal*factor):null);
  let dietMethod='当前没有启用热量目标。完成适用评测后展示，未生成的目标不会按零计算。',dietDetails=[],maintenanceDetails=[];
  if(t&&basalValid){
    const baseline=t.baselineSteps,walk=g.walking(a,+a.stepGoal-baseline),weekly=g.training(a,+a.minutes)*+a.frequency/7;
    maintenanceDetails=[`活动系数：${{sedentary:'久坐为主',light:'轻度活动',active:'活动较多'}[a.activity]||'当前活动量'}取 ${factor}。`,
      `步数修正：以 ${baseline} 步为活动系数已包含的参考步数，目标 ${a.stepGoal} 步与它的差值折算约 ${Math.round(walk)} 千卡；少于参考步数时为负向修正。`,
      `训练平均量：按每次 ${a.minutes} 分钟、每周 ${a.frequency} 次估算，平均每天约 ${Math.round(weekly)} 千卡。`,
      `每日维持所需 ≈ 基础代谢 × ${factor} ＋ 步数修正 ＋ 每日平均训练量；采用未取整值计算，最后取整。`];
    const target=calendar.view.intake,adjustment=number(target)?Math.abs(maintenance-target):null;
    const direction={loss:'减脂',gain:'增重',maintain:'维持'}[t.direction]||'当前';
    dietMethod=number(target)?`${direction}目标：在每日维持所需约 ${maintenance} 千卡的基础上${t.direction==='loss'?'减少':t.direction==='gain'?'增加':'调整'}约 ${shown(adjustment)} 千卡，得到每日摄入目标 ${target} 千卡。`:'该日期未启用摄入热量目标。';
    const rate=(t.direction==='loss'?policy.loss:policy.gain)?.[a.pace];
    dietDetails=[`使用评测体重 ${source.weight} 千克和目标体重 ${t.targetWeight} 千克，选择${direction}方向。`,
      t.direction==='maintain'?'维持方向不额外增加或减少热量。':`所选节奏按体重的 ${number(rate)?Number((rate*100).toFixed(3)):'待确认'}% / 周估算变化，再按每千克 ${policy.kcalPerKg} 千卡折算到每天；这是产品的目标估算参数。`,
      t.direction==='loss'?`减少量最多为维持所需的 ${policy.lossLimit*100}%，且未取整的摄入目标不低于基础代谢；最终摄入目标向上取整。`:t.direction==='gain'?`增加量不超过维持所需的 ${policy.gainLimit*100}%，同时不超过 ${policy.gainMax} 千卡 / 天；最终摄入目标向下取整。`:'维持目标四舍五入到整数千卡。'];
  }else if(number(calendar.view.intake)&&basalValid){
    const multiplier={fat_loss:.9,muscle:1.05,habit:1}[a.goal];
    dietMethod=`这个日期沿用原有方案：基础代谢 × 活动系数 ${factor}，再按${{fat_loss:'减脂',muscle:'增肌',habit:'习惯'}[a.goal]||'原有'}目标调整。`;
    dietDetails=[`目标系数为 ${multiplier??'待确认'}；先与基础代谢取较大值，再取最接近的 50 千卡。沿用已保存的目标 ${calendar.view.intake} 千卡。`];
    maintenanceDetails=[`原有方案以基础代谢 × 活动系数 ${factor} 估算每日维持所需，不额外叠加新版步数修正。`];
  }
  const actualSteps=calendar.view.steps?.steps;
  const walkValid=Number.isFinite(+a.height)&&+a.height>0&&Number.isFinite(+a.weight)&&+a.weight>0;
  const distance=walkValid&&number(actualSteps)?actualSteps*(+a.height/100)*g.energyPolicy.strideHeight/1000:null;
  const activityDetails=walkValid?[
    `估算步长 = 身高 ${a.height} 厘米 ÷ 100 × ${g.energyPolicy.strideHeight}，约 ${(+a.height/100*g.energyPolicy.strideHeight).toFixed(2)} 米。`,
    number(actualSteps)?`${actualSteps} 步 × 估算步长 ÷ 1000，约走了 ${distance.toFixed(2)} 千米。`:'当天步数尚未同步，因此已消耗保持待同步。',
    `净活动消耗 = (${g.energyPolicy.walkingMet} − 1) × 体重 ${a.weight} 千克 × 步行距离 ÷ ${g.energyPolicy.walkingKmh} 千米/小时；最后取整。`,
    `其中 ${g.energyPolicy.walkingMet} 是产品采用的步行强度参数，减去 1 是扣除同一时段的静息消耗。目标同样按目标步数 ${summary.exercise.stepGoal} 步计算。`
  ]:['缺少有效身高或体重，暂时无法估算步行热量。'];
  const trainingDetails=summary.exercise.rest?['恢复日不安排训练，训练目标与已消耗均为 0 千卡，无需记录。']:workout.day?[
    `当天训练目标 ${summary.exercise.training.target} 千卡来自已保存的运动方案，由规划模型结合评测体重、动作强度和活动时长估算，不是设备测量。`,
    '先按每个动作的计划活动秒数占比，分配当天目标热量；整数余量按小数部分从大到小分配，保证动作目标合计等于当天训练目标。',
    '每个动作已消耗 ≈ 动作目标热量 × 实际活动秒数 ÷ 计划活动秒数；各动作未取整值相加后，再取整。填写的是各组活动时间合计，组间休息不作为动作活动秒数。',
    '组数与次数用于判断动作是否完成。热量达到目标后，未完成的动作仍保留原状态。'
  ]:summary.exercise.legacy?[
    `原有计时方案采用 (${g.energyPolicy.trainingMet} − 1) × 体重 × 分钟 ÷ 60 × ${g.energyPolicy.trainingFraction} 估算训练净消耗；末尾系数用于折算活动时间。`,
    '旧记录没有逐动作完成量时，仅展示整体估算，不补造每个动作的实际组次。'
  ]:['当天没有已保存的训练方案，训练目标暂时待确认。'];
  return {date:calendar.selected,isToday:calendar.isToday,future:summary.exercise.future,basal:shown(basal),basalAvailable:basalValid,inputs,
    basalFormula:basalValid?`10 × ${a.weight} ＋ 6.25 × ${a.height} − 5 × ${a.age} ${coefficient} ≈ ${shown(basal)} 千卡 / 天`:'待补充评测',
    maintenance:shown(maintenance),maintenanceDetails,dietMethod,dietDetails,activityDetails,trainingDetails,diet:summary.diet,exercise:summary.exercise,
    actions:summary.exercise.rows.map(x=>({id:x.id,name:x.name,target:x.energy,plannedSeconds:x.seconds??null,done:x.doneKcal,state:x.state})),
    recorded:!!workout.record,legacy:summary.exercise.legacy};
}
module.exports={view};
