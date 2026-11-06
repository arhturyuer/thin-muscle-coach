const d = require('../shared/domain'),
  store = require('../core/store'),
  repo = require('./repository'),
  api = require('./api'),
  sync = require('./syncService');

function snapshot() {
  const s = store.get(),
    e = s.entitlement;
  let index = d.currentDay(e);
  let today = index >= 0 && index < 7 && e.plan ? e.plan.days[index] : null;
  if (today) today=require('../shared/daily').effective(s.records,e,d.localDate(),today).task;
  return {
    ...s,
    hasDraft:!!s.draft.consent,
    hasPreview:!!(s.preview&&[2,3].includes(s.preview.schemaVersion)),
    isMember:!!(s.membership&&s.membership.active),
    membershipUntil:s.membership&&s.membership.expiresAt?new Date(s.membership.expiresAt+8*3600000).toISOString().slice(0,10):'',
    profile: s.profile || require('../shared/account').defaultProfile(),
    day: index + 1,
    today,
    active: d.active(e),
    report: d.report(s),
    avatarUrl: s.avatarDisplay && s.profile && s.avatarDisplay.fileId === s.profile.avatarFileId ? s.avatarDisplay.url : require('./profile').DEFAULT_AVATAR,
    accountLabel: !s.online ? '离线使用，记录保存在本机' : s.accountStatus === 'ready' ? '微信账号已连接' : s.accountStatus === 'connecting' ? '正在连接微信账号' : '暂未连接，点击重新连接',
    pending: s.queue.filter(o => o.kind !== 'event').length,
    date: d.localDate()
  };
}

function assess(a) {
  const apply=plan=>{
    store.save({draft:a,preview:plan});
    if(plan){repo.write('assessment','assessment',a);if([2,3].includes(a.schemaVersion)&&!store.get().records['measurement:'+d.localDate()])repo.write('measurement','measurement:'+d.localDate(),{date:d.localDate(),weight:+a.weight,waist:a.waist==null||a.waist===''?null:+a.waist});require('./analytics').track('assessment_completed');}
    if(plan&&store.get().membership?.active)return sync.flush().then(async()=>{
      const s=store.get();
      void require('./meal-week').ensure();
      if(s.config.workoutPlansSupported){
        const workout=require('./workout');
        if(s.conflicts.some(c=>workout.affectsPlan(c.operation)))throw new Error('请在「我的」中处理评测或运动记录的同步冲突，处理后将更新运动计划。');
        if(s.queue.some(workout.affectsPlan))throw new Error('评测或运动记录待同步，联网同步后将更新运动计划。');
        await workout.ensure();
      }
      return plan;
    });
    return plan;
  };
  const plan=d.makePlan(a,store.get().config.media||{});
  if([2,3].includes(a.schemaVersion)&&plan)return api.call('plan.preview',{assessment:a}).then(r=>apply(r.plan));
  return apply(plan);
}

async function purchase(sku='month', recoveryAttempt=0) {
  require('./analytics').track('purchase_clicked');
  const s = store.get();
  const error = d.validateAssessment(s.draft);
  if (error) throw new Error(error);
  const issue = purchaseIssue(s.config);
  if(issue)throw new Error(issue);
  let r;
  for(let attempt=0;attempt<2;attempt++){
    const login=await wx.login();
    if(!login||!login.code)throw new Error('无法获取支付登录状态，请重新打开小程序后重试');
    try{r=await api.call('purchase.create',{assessment:s.draft,sku,code:login.code,paymentPlatform:paymentPlatform()});break;}
    catch(error){if(attempt===0&&error.code==='PAYMENT_LOGIN_EXPIRED')continue;throw error;}
  }
  if(r.order.status==='paid'){if(r.state)repo.accept(r.state);return orderStatus(r.order.id);}
  store.save({
    pendingOrderId: r.order.id
  });
  if([2,3].includes(s.draft.schemaVersion)){
    const product=require('../shared/guidance').catalogForStage(require('../core/release').stage(),paymentPlatform()).find(x=>x.sku===sku);
    if(!product||r.order.amount!==product.amount)throw new Error('订单金额与当前套餐不一致，请更新服务后重试');
  }
  require('./analytics').track('purchase_started', r.order.id);
  if (r.order.plan) {
    const next = r.order.plan;
    const changed = ['targetWeight','pace','stepGoal','schemaVersion','age','sex','height','weight','waist','minutes','equipment','goal','experience','activity','frequency','weekdays','foodScene','foodObstacle','diet','allergies'].some(k => JSON.stringify(next.assessment[k]) !== JSON.stringify(s.draft[k]));
    store.save({
      preview: next,
      draft: next.assessment
    });
    if (changed) {
      const choice = await wx.showModal({
        title: '恢复原来的待付订单',
        content: '原订单对应 ' + next.title + '。本次将恢复原来的评估和饮食安排；新偏好可用于下一轮。是否继续？',
        confirmText: '继续原计划'
      });
      if (!choice.confirm) return r.order;
    }
  } {
    try {
      await new Promise((resolve,reject)=>{
        // Some clients only report via callbacks and return undefined.
        const task=wx.requestVirtualPayment({...r.payData,success:resolve,fail:reject});
        if(task&&typeof task.then==='function')task.then(resolve,reject);
      });
    } catch (e) {
      // A cashier error can arrive after payment; trust the server confirmation.
      let confirmed;try{confirmed=await orderStatus(r.order.id);if(confirmed&&confirmed.status==='paid')return confirmed;}catch(queryError){}
      require('./analytics').track(/cancel/.test(e.errMsg||'')?'payment_cancelled':'payment_failed');
      const nativeCode=[e.errCode,e.err_code,e.code].find(Number.isFinite);
      if(nativeCode===-15012&&confirmed&&confirmed.status==='closed'&&recoveryAttempt===0)return purchase(sku,1);
      const detail=s.config.testCheckout?require('./payment-error').detail(e,r.payData):'';
      throw new Error(/cancel/.test(e.errMsg || '') ? '已取消，计划预览已保留' : '微信收银台调用失败'+(nativeCode===undefined?'':'（错误码 '+nativeCode+'）')+(detail?'：'+detail:'')+'，订单已保留，请查询状态');
    }
  }
  let order=await orderStatus(r.order.id);
  if(s.config.testCheckout)for(let attempt=0;attempt<3&&order&&['pending','confirming'].includes(order.status);attempt++){await new Promise(resolve=>setTimeout(resolve,1000));order=await orderStatus(r.order.id);}
  return order;
}

function paymentPlatform(){
  try{const info=wx.getSystemInfoSync();return info.platform==='ios'||/ios/i.test(info.system||'')?'ios':'default';}catch(e){return 'default';}
}
function purchaseIssue(config=store.get().config) {
  if(!wx.requestVirtualPayment)return '当前微信版本不支持购买，请更新微信。';
  try {
    const info=wx.getSystemInfoSync();
    if(info.platform==='ios'||/ios/i.test(info.system)){
      if(compareVersion(info.version,'8.0.68')<0)return '请将微信更新至 8.0.68 或以上版本后购买。';
      if(!config.iosEnabled)return '当前苹果设备暂未开放购买。';
    }
  }catch(e){return '暂时无法读取设备信息，请重新打开小程序后重试。';}
  return '';
}

function compareVersion(a, b) {
  const x = a.split('.').map(Number),
    y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0) ? 1 : -1;
  }
  return 0;
}
async function orderStatus(id) {
  const r = await api.call('purchase.status', {
    orderId: id
  });
  repo.accept(r.state);
  if (r.order && r.order.status === 'paid') {
    store.save({
      pendingOrderId: null
    });
    require('./analytics').track('purchase_paid', r.order.id);
    await require('./syncService').flush();
    void require('./meal-week').ensure();
    await require('./workout').ensure();
  }
  return r.order;
}
async function activate() {
  const s = store.get();
  if (!s.entitlement || s.entitlement.status !== 'pending') return;
  const r = await api.call('challenge.activate');
  store.save({entitlement: r.entitlement});
}
async function start() {
  let s = store.get();
  if(s.session && (s.membership&&s.membership.active || d.active(s.entitlement))) {resume();return store.get().session;}
  if(s.membership && s.membership.active && (!s.entitlement || !d.active(s.entitlement))) {
    await generate();s=store.get();
  }
  if (!s.entitlement) throw new Error('请先领取并购买计划');
  if (s.entitlement.status === 'pending') { await activate(); s = store.get(); }
  if (!d.active(s.entitlement) || !s.entitlement.credential || Date.now() >= s.entitlement.expiresAt) throw new Error('挑战未激活或已结束，请联网确认');
  const day = d.currentDay(s.entitlement),
    effective = require('../shared/daily').effective(s.records,s.entitlement,d.localDate(),s.entitlement.plan.days[day]),
    task = effective.task;
  if (task.rest) throw new Error('今天是恢复日');
  const key = `session:${s.entitlement.id}:${day}`;
  if (s.records[key] && s.records[key].value.status === 'completed') throw new Error('今天的训练已完成，可以在成长页回顾');
  if (!s.session || s.session.key !== key) store.save({
    session: {
      key,
      planId: s.entitlement.id,
      day,
      date: d.localDate(),
      task,
      adjustmentId: effective.adjustmentId,
      startedAt: Date.now(),
      elapsed: 0,
      runningSince: Date.now(),
      completedSets: 0,
      exercise: 0,
      set: 0,
      restUntil: null
    }
  });
  require('./analytics').track('workout_started', key);
  return store.get().session;
}

function elapsed(s) {
  return s.elapsed + (s.runningSince ? Math.max(0, Date.now() - s.runningSince) : 0);
}

function pause() {
  const s = store.get().session;
  if (s) store.save({
    session: {
      ...s,
      elapsed: elapsed(s),
      runningSince: null
    }
  });
}

function resume() {
  const s = store.get().session;
  if (s) store.save({
    session: {
      ...s,
      runningSince: Date.now()
    }
  });
}

function next() {
  const s = store.get().session;
  if (!s || !s.runningSince || s.restUntil > Date.now()) return;
  const move = s.task.exercises[s.exercise];
  if (!move) return;
  let exercise = s.exercise,
    set = s.set + 1;
  if (set >= move.sets) {
    exercise++;
    set = 0;
  }
  store.save({
    session: {
      ...s,
      exercise,
      set,
      completedSets: s.completedSets + 1,
      restUntil: exercise < s.task.exercises.length ? Date.now() + 45000 : null
    }
  });
}
async function finish(difficulty, discomfort) {
  const s = store.get().session;
  if (!s) throw new Error('没有可保存的训练');
  repo.write('session', s.key, {
    planId: s.planId,
    day: s.day,
    date: s.date,
    status: !discomfort && s.exercise >= s.task.exercises.length ? 'completed' : 'interrupted',
    completedSets: s.completedSets,
    seconds: Math.round(elapsed(s) / 1000),
    difficulty: difficulty || 'unknown',
    adjustmentId: s.adjustmentId || null,
    at: Date.now(),
    discomfort
  });
  require('./analytics').track(!discomfort && s.exercise >= s.task.exercises.length ? 'workout_completed' : 'workout_interrupted', s.key);
  store.save({
    session: null
  });
  await sync.flush();
}
async function reminder(enabled, time, options = {}) {
  const template = store.get().config.reminderTemplateId;
  let authorization = 'unchanged';
  if (enabled && (options.requestAuthorization !== false || !store.get().reminder.enabled)) {
    if (!template) throw new Error('微信提醒暂未开放，你仍可在小程序中查看今日任务。');
    const r = await wx.requestSubscribeMessage({
      tmplIds: [template]
    });
    authorization = r[template];
    if (authorization !== 'accept') throw new Error('未开启微信通知，训练与站内提醒仍可使用');
  }
  const r = await api.call('reminder.update', {
    enabled,
    time,
    authorization
  });
  store.save({
    reminder: r.reminder
  });
  require('./analytics').track(enabled ? 'reminder_enabled' : 'reminder_disabled');
}
async function generate() {
  const requestId=store.get().planRequestId||repo.id();store.save({planRequestId:requestId});
  const r=await api.call('plan.generate',{assessment:[2,3].includes(store.get().draft.schemaVersion)?store.get().draft:null,requestId});store.save({planRequestId:null});
  if(r.state) repo.accept(r.state);else store.save({entitlement:r.entitlement});void require('./meal-week').ensure();return r.entitlement;
}
async function review(review) {
  const r=await api.call('plan.review',{requestId:repo.id(),baseVersion:store.get().entitlement.version,review});store.save({proposal:r.proposal,confirmRequestId:null});return r.proposal;
}
async function confirm() {
  const p=store.get().proposal;if(!p)throw new Error('请先查看调整建议');
  const requestId=store.get().confirmRequestId||repo.id();store.save({confirmRequestId:requestId});
  const r=await api.call('plan.confirm',{requestId,baseVersion:p.baseVersion,proposalId:p.requestId});store.save({confirmRequestId:null});if(r.state)repo.accept(r.state);void require('./meal-week').ensure();return r;
}
module.exports = {
  generate, review, confirm, activate,
  snapshot,
  assess,
  purchase,
  purchaseIssue,
  paymentPlatform,
  orderStatus,
  start,
  elapsed,
  pause,
  resume,
  next,
  finish,
  reminder
};
