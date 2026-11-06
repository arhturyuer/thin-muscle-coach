const {
  cloud,
  db,
  transact,
  tables,
  stage,
  sourceVersion
} = require('./lib/runtime'), b = require('./lib/business'), p = require('./lib/platform');
exports.main = async event => {
  const ctx = cloud.getWXContext();
  if (ctx.OPENID || event.Type !== 'Timer') return {
    stage,
    sourceVersion,
    code: 'FORBIDDEN'
  };
  const cfg = b.config(process.env, stage);
  let remindersReady = !!process.env.REMINDER_TEMPLATE_ID;
  if (remindersReady) try {
    p.messageState(stage);
  } catch (e) {
    remindersReady = false;
    console.error('reminder configuration invalid', e.message);
  }
  let cursor = '',
    sent = 0;
  while (true) {
    let query = db.collection(tables.accounts);
    if (cursor) query = query.where({
      _id: db.command.gt(cursor)
    });
    const page = await query.orderBy('_id', 'asc').limit(100).get();
    if (!page.data.length) break;
    for (const account of page.data) {
      const now = Date.now();
      await require('./lib/profile').cleanup(require('./lib/runtime'), account.userId, now);
      if(account.mealPhotoAssets&&Object.keys(account.mealPhotoAssets).length)await require('./lib/meal-photo').cleanup(require('./lib/runtime'),account.userId,now);
      if(stage==='test'&&!cfg.paymentsEnabled){
        // The business function owns payment credentials; do not duplicate them in this job.
        for(const order of account.orders.filter(o=>!o.redacted&&(['pending','confirming'].includes(o.status)||o.status==='paid'&&!o.deliveryAcknowledgedAt))){
          try{await cloud.callFunction({name:'coach_test',data:{action:'payment.reconcile',orderId:order.id}});}catch(error){console.error('test payment reconciliation unavailable');}
        }
      }
      if (cfg.paymentsEnabled) {
        for (const order of account.orders.filter(o => !o.redacted && ['pending', 'confirming'].includes(o.status))) {
          try {
            const remote = await p.query(account.userId, order.id);
            if (remote && [2, 3, 4].includes(remote.status)) await transact(account.userId, s => b.fulfill(s, order.id, remote.wx_order_id || order.id));
            if (remote && remote.status === 6) await transact(account.userId, s => {
              const o = s.orders.find(o => o.id === order.id);
              if (o && o.status !== 'paid') o.status = 'closed';
            });
          } catch (e) {
            console.error('order reconciliation failed', order.id, e.message);
          }
        }
      }
      if (!remindersReady) continue;
      const task = await transact(account.userId, s => {
        const t = b.reminderDue(s, now);
        if (!t) return null;
        // At-most-once dispatch: an ambiguous timeout is not retried, preventing duplicate notifications.
        s.notification[t.date] = {
          status: 'sending',
          claimedAt: now
        };
        return t;
      });
      if (!task) continue;
      try {
        await p.send(account.userId, task, stage);
        await transact(account.userId, s => {
          s.notification[task.date] = {
            status: 'sent',
            at: Date.now()
          };
        });
        sent++;
      } catch (e) {
        await transact(account.userId, s => {
          s.notification[task.date] = {
            status: 'failed',
            at: Date.now(),
            reason: e.message
          };
          if (e.platformCode === 43101) s.reminder.authorization = 'exhausted';
        });
      }
    }
    cursor = page.data[page.data.length - 1]._id;
    if (page.data.length < 100) break;
  }
  return {
    stage,
    sourceVersion,
    sent
  };
};
