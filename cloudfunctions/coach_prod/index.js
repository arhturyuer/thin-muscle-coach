const {
  cloud,
  db,
  transact,
  tables,
  stage,
  sourceVersion
} = require('./lib/runtime'), b = require('./lib/business'), d = require('./lib/domain'), p = require('./lib/platform'), crypto = require('crypto');
exports.main = async event => {
  let paymentPhase='request';
  try {
    if(stage==='test'&&event.action==='payment.reconcile')return {stage,sourceVersion,code:0,data:await require('./lib/payment-reconcile').reconcile(require('./lib/runtime'),event.orderId,p)};
    const {
      OPENID: userId
    } = cloud.getWXContext();
    if (!userId) b.fail('请从小程序登录', 'UNAUTHORIZED');
    const cfg = b.config(process.env, stage),
      now = Date.now();
    const paymentPlatform=event.paymentPlatform==='ios'?'ios':'default';
    const paymentCatalog=paymentPlatform==='ios'?cfg.iosCatalog:cfg.catalog;
    const action = event.action;
    if(action==='setup.status'&&stage==='test')return {stage,sourceVersion,code:0,data:require('./lib/setup-status').status(process.env,stage)};
    if(action==='setup.mealPlanDiagnostic'&&stage==='test')return {stage,sourceVersion,code:0,data:await require('./lib/runtime').auxTransact(userId,'mealplan:'+d.localDate(now),row=>({status:row.result?'completed':row.pending&&row.pending.until>now?'pending':'empty',mealCount:row.result?.meals?.length||0,generatedAt:row.result?.generatedAt||null,failure:row.lastFailure||null}))};
    if(action==='setup.mealDiagnostic'&&stage==='test')return {stage,sourceVersion,code:0,data:await require('./lib/runtime').auxTransact(userId,'meal:'+d.localDate(now),row=>row.lastFailure||row.lastSuccess||null)};
    if(action==='setup.paymentDiagnostic'&&stage==='test')return {stage,sourceVersion,code:0,data:await require('./lib/runtime').auxTransact(userId,'payment:diagnostic',row=>row.value||null)};
    if(action==='setup.serviceDiagnostic'&&stage==='test')return {stage,sourceVersion,code:0,data:await require('./lib/runtime').auxTransact(userId,'service:diagnostic',row=>row.value||null)};
    const profile = require('./lib/profile');
    const runtime = require('./lib/runtime');
    if(['workout.plan.ensure','workout.plan.get'].includes(action))return {stage,sourceVersion,code:0,data:await require('./lib/workout-plan').handle(event,runtime,cfg,now)};
    if(['meal.plan.ensure','meal.plan.get','meal.plan.consent'].includes(action))
      return {stage,sourceVersion,code:0,data:await require('./lib/meal-week').handle(event,runtime,cfg,now)};
    if(['meal.photo.save','meal.photo.status','meal.photo.get'].includes(action))
      return {stage,sourceVersion,code:0,data:await require('./lib/meal-photo').handle(event,runtime,cfg,now)};
    if (action === 'profile.avatar.prepare') {
      const ticket = await transact(userId, s => profile.prepare(s, userId, stage, event.extension));
      return {
        stage,
        sourceVersion,
        code: 0,
        data: ticket
      };
    }
    if (action === 'profile.update') {
      let checked;
      if (event.avatarUploadId) {
        checked = await transact(userId, s => profile.inspect(s, userId, stage, event));
        if (checked.status === 'ready' && checked.upload) await require('./lib/avatar').verify(cloud, checked.upload);
      }
      const result = checked && checked.status !== 'ready' ? checked : await transact(userId, s => ({
        ...profile.commit(s, userId, stage, event),
        cleanupNeeded: s.avatarGarbage.length > 0
      }));
      if (result.status === 'saved') {
        if (result.cleanupNeeded) await profile.cleanup(runtime, userId);
      }
      delete result.cleanupNeeded;
      return {
        stage,
        sourceVersion,
        code: 0,
        data: result
      };
    }

    if(action==='activity.steps.sync')return {stage,sourceVersion,code:0,data:await require('./lib/activity-steps').handle(event,runtime,now)};
    if(['day.propose','day.adopt','day.undo'].includes(action))return {stage,sourceVersion,code:0,data:await require('./lib/daily-adjustments').handle(event,runtime,now)};
    if(action==='meal.plan')return {stage,sourceVersion,code:0,data:await require('./lib/meal-plan').handle(event,runtime,cfg,now)};
    if(action==='meal.recognize')return {stage,sourceVersion,code:0,data:await require('./lib/meal-ai').handle(event,runtime,cfg,now)};
    if(action==='meal.status')return {stage,sourceVersion,code:0,data:await require('./lib/meal-ai').status(event,runtime,now)};

    if (['plan.targets.update','plan.preview','plan.get','plan.generate','plan.confirm','plan.review'].includes(action) || action.startsWith('ai.')) return await require('./lib/guided').handle(event,runtime,cfg,now);

    if (action === 'account.delete') {
      if (event.confirm !== 'DELETE') b.fail('请确认删除');
      const hasMealPhotos=await transact(userId, s => {
        profile.reset(s);
        s.revision++;
        s.resetRevision = s.revision;
        if(s.mealPhotoAssets)require('./lib/meal-photo').reset(s);
        s.records = {};
        delete s.mealWeekConsentVersion;delete s.mealNutritionBasis;
        s.activitySteps = {};s.stepsSequence=0;s.targetsOperations={};s.targetsVersion=0;
        s.processed = {};
        s.notification = {};
        s.reminder = {
          enabled: false,
          time: '20:00'
        };
        s.deletedAt = Math.max(now,(s.deletedAt||0)+1);
        s.entitlement = null;
        s.proposal=null;s.nextAdjustment=null;s.planOperations={};s.dayProposals={};s.dayOperations={};
        s.orders = s.orders.map(o => {
          const {
            plan,
            ...rest
          } = o;
          return {
            ...rest,
            redacted: true
          };
        });
        return !!s.mealPhotoAssets;
      });
      await profile.cleanup(runtime, userId);
      if(hasMealPhotos)await require('./lib/meal-photo').cleanup(runtime,userId);
      await runtime.clearGuidance(userId);
      return {
        stage,
        sourceVersion,
        code: 0,
        data: {
          deleted: true
        }
      };
    }
    // Remote payment network calls run outside database transactions (transaction callbacks may retry).
    let queried, signingOrder;
    const archivedPlans={};
    if(action==='sync.batch'&&Array.isArray(event.operations)) for(const op of event.operations) {
      if(op?.kind==='workoutRecord'&&d.validRecord(op.kind,op.value)) {
        const key=op.value.planId+':'+op.value.planVersion;
        if(!archivedPlans[key])archivedPlans[key]=await require('./lib/workout-plan').loadForRecord(runtime,userId,op.value);
      }
      if(op?.value?.planId?.startsWith('week-')&&!archivedPlans[op.value.planId]) {
        const plan=await runtime.loadPlan(userId,op.value.planId);if(plan) archivedPlans[op.value.planId]=plan;
      }
    }
    if (action === 'purchase.status') {
      const order = await transact(userId, s => s.orders.find(o => o.id === event.orderId) || null);
      if (!order) b.fail('订单不存在');
      if (cfg.paymentsEnabled && ['pending', 'confirming'].includes(order.status)) queried = await p.query(userId, order.id);
    }
    let purchaseCandidate,purchaseRemote;
    if(action==='purchase.create'&&cfg.paymentsEnabled){
      const product=paymentCatalog.find(x=>x.sku===event.sku);
      if(product){
        const productId=require('./lib/payment-products').forStage(stage,process.env,paymentPlatform)[product.sku];
        purchaseCandidate=await transact(userId,s=>s.orders.slice().reverse().find(o=>!o.redacted&&o.sku===product.sku&&o.amount===product.amount&&o.productId===productId&&['pending','confirming'].includes(o.status))||null);
        if(purchaseCandidate){paymentPhase='check-existing-order';purchaseRemote=await p.query(userId,purchaseCandidate.id);}
      }
    }
    const archivedEvents=[];
    if(action==='sync.batch'&&event.owner===userId&&Array.isArray(event.operations)&&event.operations.length<=30) {
      for(const op of event.operations) if(op&&op.kind==='event'&&/^[-a-zA-Z0-9]{5,80}$/.test(op.id||'')&&d.validRecord('event',op.value)&&b.validKey(op)) {
        await runtime.auxTransact(userId,'event:'+op.key,row=>{if(!row.value)row.value=op.value;});
        archivedEvents.push(op);
      }
    }
    const data = await transact(userId, async s => {
      if (s.entitlement && s.entitlement.status === 'active' && !d.active(s.entitlement, now)) s.entitlement.status = 'expired';
      if(action==='bootstrap')require('./lib/guided').enableNumericTargets(s,cfg,now);
      if (action === 'bootstrap') return {
        userId,
        state: b.publicState(s, event.owner === userId ? event.cursor : 0),
        config: {
          eventKeysSupported: true,
          profileEditingSupported: true,
          workoutPlansSupported: true,
          mealWeeksSupported: true,
          ...cfg,
          storagePrefix: tables.storagePrefix
        }
      };
      if (action === 'sync.batch') {
        if (event.owner !== userId) b.fail('账号已变化，请重新连接', 'ACCOUNT_CHANGED');
        const results = b.applyBatch(s, Array.isArray(event.operations)?event.operations.filter(op=>!archivedEvents.includes(op)):event.operations, now, archivedPlans);
        results.push(...archivedEvents.map(op=>({id:op.id,key:op.key,status:'ok',version:1}))); 
        return {
          results,
          state: b.publicState(s),
          cursor: s.revision
        };
      }
      if (action === 'purchase.create') {
        paymentPhase='create-order';
        if (!cfg.paymentsEnabled || (!cfg.testCheckout && !cfg.contentPublished)) b.fail('正式支付或训练内容尚未开放');
        if (!cfg.membershipEnabled) b.fail('指导服务尚未开放');
        if(paymentPlatform==='ios'&&!cfg.iosEnabled)b.fail('当前苹果设备暂未开放购买');
        const product=paymentCatalog.find(x=>x.sku===event.sku);
        if(!product) b.fail('请选择有效套餐');
        if(![2,3].includes(event.assessment?.schemaVersion)) b.fail('请完成新版评估');
        const plan = d.makePlan(event.assessment, cfg.media,{nutritionReviewed:cfg.nutritionReviewed,numericTargetsEnabled:cfg.numericTargetsEnabled});
        if (!plan) b.fail('当前情况需要专业指导，暂不提供通用计划');
        const productId=require('./lib/payment-products').forStage(stage,process.env,paymentPlatform)[product.sku];
        if(!productId)b.fail('当前套餐商品尚未配置');
        if(purchaseCandidate&&purchaseRemote){
          const previous=s.orders.find(o=>o.id===purchaseCandidate.id&&!o.redacted);
          if(previous&&['pending','confirming'].includes(previous.status)){
            if([2,3,4].includes(purchaseRemote.status))b.fulfill(s,previous.id,purchaseRemote.wx_order_id||previous.id);
            else if(purchaseRemote.status===6){previous.status='closed';s.revision++;}
          }
          if(previous&&previous.status==='paid')return {order:{id:previous.id,status:previous.status,amount:previous.amount,sku:previous.sku},state:b.publicState(s)};
        }
        // Every native payment attempt gets a fresh outTradeNo, as required by WeChat.
        let order;
        if (!order) {
          order = {
            id: require('./lib/partition').partition(stage).orderPrefix + crypto.randomBytes(12).toString('hex'),
            productId,
            sku:product.sku, months:product.months, title:product.title,
            status: 'pending',
            amount: product.amount,
            createdAt: now,
            plan: {
              ...plan,
              contentStatus: cfg.testCheckout?'test':'published',
              testCheckout:!!cfg.testCheckout
            }
          };
          s.orders.push(order);
          s.revision++;
        }
        signingOrder = order;
        return {
          order: {
            id: order.id,
            status: order.status,
            amount: order.amount,
            sku:order.sku,
            plan: order.plan
          }
        };
      }
      if (action === 'purchase.status') {
        const o = s.orders.find(o => o.id === event.orderId);
        if (!o) b.fail('订单不存在');
        if (!o.redacted && queried && [2, 3, 4].includes(queried.status)) b.fulfill(s, o.id, queried.wx_order_id || o.id);
        if (queried && queried.status === 6 && o.status !== 'paid') o.status = 'closed';
        return {
          order: {
            id: o.id,
            status: o.status,
            amount: o.amount
          },
          state: b.publicState(s)
        };
      }
      if (action === 'challenge.activate') {
        if (!cfg.contentPublished) b.fail('正式内容尚未发布');
        if (!process.env.ENTITLEMENT_SECRET) b.fail('服务端权益签名尚未配置');
        return {
          entitlement: b.activate(s, now, process.env.ENTITLEMENT_SECRET)
        };
      }
      if (action === 'reminder.update') {
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(event.time)) b.fail('提醒时间不正确');
        if (event.enabled && !cfg.reminderTemplateId) b.fail('订阅模板尚未配置');
        s.revision++;
        s.reminder = {
          enabled: !!event.enabled,
          time: event.time,
          authorization: event.authorization === 'accept' ? 'requested' : (s.reminder.authorization || 'unknown'),
          updatedAt: now
        };
        return {
          reminder: s.reminder
        };
      }
      b.fail('未知操作');
    });
    if(action==='bootstrap') {
      // Optional quota storage must not hide payment configuration or account state.
      try {data.aiQuota=await require('./lib/daily-ai').handle({action:'ai.quota'},runtime,cfg,now);}
      catch(e) {data.aiQuota=null;data.aiQuotaUnavailable=true;console.error('AI quota bootstrap unavailable',stage);}
    }
    if (signingOrder) {
      paymentPhase='index-order';
      await db.collection(tables.orders).doc(signingOrder.id).set({
        data: {
          userId,
          orderId: signingOrder.id
        }
      });
      paymentPhase='sign-payment';
      data.payData = await p.payData(userId, signingOrder, event.code);
    }
    return {
      stage,
      sourceVersion,
      code: 0,
      data
    };
  } catch (e) {
    if(stage==='test')try{
      const id=cloud.getWXContext().OPENID;
      if(id)await require('./lib/runtime').auxTransact(id,'service:diagnostic',row=>{row.value={at:Date.now(),action:['bootstrap','sync.batch','purchase.create','purchase.status','plan.preview','plan.generate'].includes(event.action)?event.action:'other',code:String(e.code||'SERVICE_ERROR').slice(0,80),platformCode:Number.isInteger(e.platformCode)?e.platformCode:null,platformDetail:e.platformDetail||null,phase:paymentPhase,operation:['/xpay/query_order','/cgi-bin/token','/sns/jscode2session'].includes(e.operation)?e.operation:null,httpStatus:Number.isInteger(e.httpStatus)?e.httpStatus:null,sourceVersion};});
    }catch(diagnosticError){}
    if(event.action==='purchase.create') {
      const platformCode=Number.isInteger(e.platformCode)?e.platformCode:null;
      const loginExpired=e.code==='PAYMENT_LOGIN_EXPIRED'||[40029,40163].includes(platformCode);
      const code=loginExpired?'PAYMENT_LOGIN_EXPIRED':platformCode!==null?'PAYMENT_PLATFORM_ERROR':e.code||'PAYMENT_PREPARE_FAILED';
      if(stage==='test')try{
        const id=cloud.getWXContext().OPENID;
        if(id)await require('./lib/runtime').auxTransact(id,'payment:diagnostic',row=>{row.value={at:Date.now(),phase:paymentPhase,code,platformCode,sourceVersion};});
      }catch(diagnosticError){}
      if(loginExpired)return {stage,sourceVersion,code,message:'支付登录状态已变化，请重新发起购买'};
      if(platformCode!==null)return {stage,sourceVersion,code,message:'微信支付准备失败（平台错误码 '+platformCode+'），请联系开发者核查。'};
      if(!['INVALID','UNAUTHORIZED','ACCOUNT_CHANGED','MEMBERSHIP_REQUIRED','PENDING','EXPIRED'].includes(e.code)){
        const phases={'request':'请求处理','create-order':'订单保存','index-order':'订单索引','sign-payment':'支付签名','check-existing-order':'核实原订单'};
        const detail=typeof e.code==='number'?String(e.code):'E01';
        return {stage,sourceVersion,code:'PAYMENT_PREPARE_FAILED',message:'下单准备失败（'+phases[paymentPhase]+'，编号 '+detail+'），请联系开发者核查。'};
      }
    }
    return {
      stage,
      sourceVersion,
      ...(stage==='test'&&e.code==='PAYMENT_QUERY_SHAPE'?{queryShape:{responseFields:e.responseFields,orderType:e.orderType,orderFields:e.orderFields}}:{}),
      code: e.code || 'SERVICE_ERROR',
      message: e.message || '服务暂时不可用'
    };
  }
};
