const crypto = require('crypto'),
  d = require('./domain');

function fail(message, code = 'INVALID') {
  const e = new Error(message);
  e.code = code;
  throw e;
}

function publicState(s, cursor = 0) {
  const incremental = Number.isInteger(cursor) && cursor > 0 && cursor <= s.revision && cursor >= (s.resetRevision || 0);
  const records = incremental ? Object.fromEntries(Object.entries(s.records).filter(([, r]) => (r.revision || 0) > cursor)) : s.records;
  return {
    incremental,
    activitySteps:s.activitySteps||{},
    dataEpoch:s.deletedAt||0,
    targetsVersion:s.targetsVersion||0,
    mealWeekConsentVersion:s.mealWeekConsentVersion||0,
    profile: s.profile || require('./account').defaultProfile(),
    records,
    orders: s.orders.map(({
      payData,
      ...o
    }) => o),
    entitlement: s.entitlement,
    membership: require('./guidance').membership(s.orders),
    proposal: s.proposal || null,
    nextAdjustmentConfirmed: !!s.nextAdjustment,
    reminder: s.reminder,
    revision: s.revision
  };
}

function fresh() {
  return {
    ...d.initialState(),
    processed: {},
    notification: {}
  };
}

function config(env = process.env, stage = 'prod') {
  let media = {};
  try {
    media = JSON.parse(env.EXERCISE_MEDIA || '{}');
  } catch (e) {}
  const contentPublished = env.CONTENT_PUBLISHED === 'true' && !!env.CONTENT_REVIEW_ID && !!env.MEDIA_LICENSE_ID && d.exercises.every(x => typeof media[x.id] === 'string' && /^cloud:\/\//.test(media[x.id]));
  const testCheckout=require('./test-checkout').enabled(stage,env);
  const testPaymentReady=testCheckout&&['APP_ID','APP_SECRET','PAY_OFFER_ID','PAY_APP_KEY'].every(k=>typeof env[k]==='string'&&env[k].trim());
  const paymentsEnabled = testPaymentReady || env.PAYMENT_READY === 'true' && ['APP_ID', 'APP_SECRET', 'PAY_OFFER_ID', 'PAY_APP_KEY', 'ENTITLEMENT_SECRET', 'MESSAGE_TOKEN', 'MESSAGE_AES_KEY'].every(k => !!env[k]);
  return {
    ...require('./guided').config(env, stage),
    paymentsEnabled,
    mealPhotoStorageReady:env.MEAL_PHOTO_STORAGE_READY==='true',
    testCheckout,
    contentPublished,
    reminderTemplateId: env.REMINDER_TEMPLATE_ID || '',
    // Apple IAP activation confirmed for the small-payment integration partition.
    // Keep production opt-in, and retain an explicit emergency off switch in test.
    iosEnabled: env.IOS_PAYMENT_READY === 'true' || testPaymentReady && env.IOS_PAYMENT_READY !== 'false',
    media: contentPublished ? media : {}
  };
}

function validKey(op) {
  if (/^[-a-zA-Z0-9:]{1,150}$/.test(op.key)) return true;
  // Event names contain underscores; accept them only in a validated event namespace.
  return op.kind === 'event' && typeof op.key === 'string' && op.key.length <= 150 &&
    op.key.startsWith('event:' + op.value.name + ':') && /^event:[a-z_]+:[-a-zA-Z0-9:]+$/.test(op.key);
}

function applyBatch(s, ops, now = Date.now(), archivedPlans = {}) {
  if (!Array.isArray(ops) || ops.length > 30) fail('同步批次过大');
  const results = [];
  for (const op of ops) {
    if (!op || !/^[-a-zA-Z0-9]{5,80}$/.test(op.id) || !d.validRecord(op.kind, op.value) || !validKey(op)) {
      results.push({
        id: op && op.id,
        status: 'invalid',
        message: '记录格式不正确'
      });
      continue;
    }
    if (op.kind === 'preference' && !/^preference:[-a-zA-Z0-9]{5,80}$/.test(op.key)) {results.push({id:op.id,status:'invalid',message:'偏好记录标识无效'});continue;}
    if (s.processed[op.id]) {
      results.push(s.processed[op.id]);
      continue;
    }
    const old = s.records[op.key];
    if (old && old.kind !== op.kind) {
      results.push({
        id: op.id,
        status: 'invalid',
        message: '记录类型不一致'
      });
      continue;
    }
    if ((old ? old.version : 0) !== op.baseVersion) {
      results.push({
        id: op.id,
        status: 'conflict',
        remote: old || null
      });
      continue;
    }
    if(op.kind==='workoutRecord') {
      const v=op.value,w=require('./workout'),plan=archivedPlans[v.planId+':'+v.planVersion];
      const day=plan?.days.find(x=>x.date===v.date),at=Date.parse(v.date+'T00:00:00+08:00');
      const paid=require('./guidance').membership(s.orders,at).segments.some(x=>x.startsAt<at+d.DAY&&x.expiresAt>at);
      if(op.key!=='workout:'+v.date||v.date>d.localDate(now)||!paid||!w.matches(v,day)) {
        results.push({id:op.id,status:'invalid',message:'运动记录不属于有效计划或会员日期'});continue;
      }
      if(old&&(old.value.planId!==v.planId||old.value.planVersion!==v.planVersion)&&!w.replacesRecovery(day,old.value)) {
        results.push({id:op.id,status:'conflict',remote:old,message:'请沿用已记录的计划版本'});continue;
      }
    }
    const mealKind=['meal','mealAnalysis'].includes(op.kind),daily=require('./daily');
    const dietScoped=mealKind&&op.value.planId===daily.dietScope(op.value.date);
    if(mealKind) {
      const v=op.value,at=Date.parse(v.date+'T00:00:00+08:00');
      const paid=require('./guidance').membership(s.orders,at).segments.some(x=>x.startsAt<at+d.DAY&&x.expiresAt>at);
      const validKey=op.kind==='meal'?op.key===daily.mealKey(v.planId,v.date,v.slot):op.key.startsWith(`analysis:${v.planId}:${v.date}:`);
      const allowedPhotos=new Set([...(old?.value.photoIds||[]),...(old?.value.previousPhotoIds||[])]);
      const photos=[...(v.photoIds||[]),...(v.previousPhotoIds||[])];
      if(!validKey||dietScoped&&(!paid||v.date>d.localDate(now))||photos.some(id=>!allowedPhotos.has(id))){
        results.push({id:op.id,status:'invalid',message:'饮食记录归属不一致'});continue;
      }
    }
    if (!dietScoped && ['session','daily','meal','dailyFeedback','mealAnalysis'].includes(op.kind)) {
      const order = s.orders.find(o => o.id === op.value.planId && o.status === 'paid' && !o.redacted);
      const e = archivedPlans[op.value.planId] || (s.entitlement && s.entitlement.id === op.value.planId ? s.entitlement : (order && order.startDate ? {
        id: order.id,
        status: 'expired',
        plan: order.plan,
        startDate: order.startDate
      } : null));
      if (e && e.memberPlan) {
        const at=Date.parse(op.value.date+'T00:00:00+08:00');
        if (!require('./guidance').membership(s.orders,at).segments.some(x=>x.startsAt<at+d.DAY&&x.expiresAt>at)) {results.push({id:op.id,status:'invalid',message:'记录不在会员有效期'});continue;}
      }
      // Historical offline submissions are allowed only inside their paid plan period, never for revoked plans.
      if (!e || !['active', 'expired'].includes(e.status) || op.value.planId !== e.id || !e.startDate || d.dayIndex(e.startDate, Date.parse(op.value.date + 'T12:00:00+08:00')) < 0 || d.dayIndex(e.startDate, Date.parse(op.value.date + 'T12:00:00+08:00')) >= 7 || op.value.date > d.localDate(now)) {
        results.push({
          id: op.id,
          status: 'invalid',
          message: '记录不属于有效挑战'
        });
        continue;
      }
      if(op.kind==='mealAnalysis' && !op.key.startsWith(`analysis:${e.id}:${op.value.date}:`)){results.push({id:op.id,status:'invalid',message:'分析记录归属不一致'});continue;}
      if (op.kind === 'meal' && op.key !== require('./daily').mealKey(e.id,op.value.date,op.value.slot) || op.kind === 'dailyFeedback' && op.key !== `feedback:${e.id}:${op.value.date}`) {results.push({id:op.id,status:'invalid',message:'记录日期或餐次不一致'});continue;}
      if (op.kind === 'daily' && op.key !== `daily:${e.id}:${op.value.date}`) {
        results.push({
          id: op.id,
          status: 'invalid',
          message: '饮食记录日期不一致'
        });
        continue;
      }
      if (op.kind === 'session') {
        const day = d.dayIndex(e.startDate, Date.parse(op.value.date + 'T12:00:00+08:00'));
        const adjustment=op.value.adjustmentId && s.dayProposals?.[op.value.adjustmentId];
        const spec = adjustment && adjustment.adopted && adjustment.planId===e.id && adjustment.date===op.value.date && adjustment.target==='workout' ? adjustment.task : !op.value.adjustmentId ? e.plan.days[op.value.day] : null;
        if (day !== op.value.day || !spec || spec.rest || (op.value.status === 'completed' ? op.value.completedSets !== spec.exercises.reduce((n, x) => n + x.sets, 0) : op.value.completedSets > spec.exercises.reduce((n, x) => n + x.sets, 0)) || op.key !== `session:${e.id}:${op.value.day}`) {
          results.push({
            id: op.id,
            status: 'invalid',
            message: '训练记录与计划不一致'
          });
          continue;
        }
        if (old && old.value.status === 'completed' && (op.value.status !== 'completed' || (old.value.adjustmentId||null)!==(op.value.adjustmentId||null) || old.value.completedSets!==op.value.completedSets)) {
          results.push({
            id: op.id,
            status: 'conflict',
            remote: old
          });
          continue;
        }
      }
    }
    const version = (old ? old.version : 0) + 1;
    s.records[op.key] = {
      kind: op.kind,
      value: op.value,
      version,
      revision: s.revision + 1
    };
    const r = {
      id: op.id,
      key: op.key,
      status: 'ok',
      version
    };
    if(op.kind==='assessment'&&op.key==='assessment'){
      s.mealNutritionBasis={assessment:op.value,assessmentRevision:s.revision+1};
      if(op.value.mealWeekConsentVersion===1)s.mealWeekConsentVersion=1;
    }
    s.processed[op.id] = r;
    results.push(r);
    s.revision++;
  }
  assertCapacity(s);
  return results;
}
function assertCapacity(s){
  if (JSON.stringify(s).length > 700000 || Object.keys(s.records).length > 3000 || Object.keys(s.processed).length > 10000) fail('记录达到容量限制，请联系客服');
}
function activate(s, now, secret) {
  if (!s.entitlement || s.entitlement.status === 'revoked') fail('请先购买挑战');
  const e = s.entitlement;
  if (e.status === 'pending') {
    e.startDate = d.localDate(now);
    e.startedAt = now;
    e.expiresAt = Date.parse(e.startDate + 'T00:00:00+08:00') + 7 * d.DAY;
    e.status = 'active';
    const body = Buffer.from(JSON.stringify({
      id: e.id,
      expiresAt: e.expiresAt
    })).toString('base64');
    e.credential = body + '.' + crypto.createHmac('sha256', secret).update(body).digest('hex');
    const order = s.orders.find(o => o.id === e.id);
    if (order) {
      order.startDate = e.startDate;
      order.expiresAt = e.expiresAt;
    }
    s.revision++;
  }
  if (!d.active(e, now)) fail('本轮挑战已结束');
  return e;
}

function fulfill(s, orderId, platformId) {
  const o = s.orders.find(x => x.id === orderId);
  if (!o) fail('订单不存在');
  if (o.status === 'refunded') return;
  if (o.status === 'paid') return;
  if (s.orders.some(other=>other.id!==orderId&&other.platformId===platformId))fail('该平台支付单已处理');
  if (o.sku) {
    o.status='paid';o.platformId=platformId;o.paidAt=Date.now();s.revision++;return;
  }
  if (s.entitlement && ['pending', 'active'].includes(s.entitlement.status)) fail('已有有效挑战，请人工核对订单');
  o.status = 'paid';
  o.platformId = platformId;
  o.paidAt = Date.now();
  s.entitlement = {
    id: o.id,
    status: 'pending',
    plan: o.plan,
    credential: null
  };
  s.revision++;
}

function refund(s, orderId, refundId) {
  const o = s.orders.find(x => x.id === orderId);
  if (!o) fail('订单不存在');
  if (o.status==='refunded') return;
  o.status = 'refunded';
  o.refundId = refundId;
  if (o.sku && s.entitlement && s.entitlement.memberPlan) {
    const m=require('./guidance').membership(s.orders);
    s.entitlement.expiresAt=Math.min(Date.parse(s.entitlement.startDate+'T00:00:00+08:00')+7*d.DAY,m.expiresAt);
    if (!m.active) s.entitlement.status='revoked';
  }
  if (s.entitlement && s.entitlement.id === orderId) s.entitlement.status = 'revoked';
  s.revision++;
}

function reminderDue(s, now) {
  const e = s.entitlement,
    r = s.reminder;
  if ((e&&e.memberPlan&&!require('./guidance').membership(s.orders,now).active) || !d.active(e, now) || !r.enabled || r.authorization === 'exhausted') return null;
  const date = d.localDate(now),
    due = Date.parse(date + 'T' + r.time + ':00+08:00');
  if (now < due || now - due > 3600000 || s.notification[date]) return null;
  const index = d.currentDay(e, now),
    records = Object.values(s.records);
  const nutrition = records.some(x => x.kind === 'daily' && x.value.planId === e.id && x.value.date === date && x.value.nutrition);
  const trained = e.plan.days[index].rest ? records.some(x => x.kind === 'daily' && x.value.date === date && x.value.recovery) : records.some(x => x.kind === 'session' && x.value.planId === e.id && x.value.day === index && x.value.status === 'completed');
  if (index !== 6 && nutrition && trained) return null;
  return {
    date,
    report: index === 6,
    title: index === 6 ? '你的 7 天回顾已就绪' : '今天的薄肌任务',
    description: index === 6 ? '回顾训练与饮食习惯，继续刚刚好的节奏' : '训练与饮食，一起完成今天的小目标'
  };
}
module.exports = {
  assertCapacity,
  fail,
  validKey,
  config,
  fresh,
  publicState,
  applyBatch,
  activate,
  fulfill,
  refund,
  reminderDue
};
