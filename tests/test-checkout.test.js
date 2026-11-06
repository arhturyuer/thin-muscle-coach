const {test}=require('node:test'),assert=require('node:assert/strict');
const b=require('../server/business'),guided=require('../server/guided'),checkout=require('../server/test-checkout');
const {memoryCloud,loadEntry}=require('./fixtures/cloud-runtime');
const env={APP_ID:'app',APP_SECRET:'app-secret',PAY_OFFER_ID:'offer',PAY_APP_KEY:'strong-payment-key',ENTITLEMENT_SECRET:''};
const a={schemaVersion:2,consent:true,screening:'clear',age:28,sex:'male',height:175,weight:70,waist:'',goal:'habit',experience:'beginner',activity:'light',minutes:15,frequency:3,weekdays:[1,3,5],equipment:'none',foodScene:'cook',foodObstacle:'irregular',diet:'none',allergies:''};
test('basic test checkout needs real credentials but does not open production capabilities',()=>{
 const cfg=b.config(env,'test');assert.equal(cfg.testCheckout,true);assert.equal(cfg.paymentsEnabled,true);assert.equal(cfg.membershipEnabled,true);assert.equal(cfg.contentPublished,false);assert.equal(cfg.aiEnabled,false);assert.equal(cfg.nutritionReviewed,false);assert.equal(cfg.numericTargetsEnabled,true);assert.equal(b.config({...env,TEST_NUMERIC_TARGETS_READY:'false'},'test').numericTargetsEnabled,false);assert.equal(b.config(env,'prod').numericTargetsEnabled,false);
 assert.equal(b.config({...env,PAY_APP_KEY:''},'test').paymentsEnabled,false);
 assert.equal(cfg.iosEnabled,true);
 assert.equal(b.config({...env,IOS_PAYMENT_READY:'false'},'test').iosEnabled,false);
 assert.equal(b.config({...env,PAY_APP_KEY:''},'test').iosEnabled,false);
 assert.equal(b.config({...env,TEST_CHECKOUT_READY:'false'},'test').iosEnabled,false);
 const prod=b.config({...env,TEST_CHECKOUT_READY:'true'},'prod');assert.equal(prod.testCheckout,false);assert.equal(prod.paymentsEnabled,false);assert.equal(prod.membershipEnabled,false);
 assert.equal(prod.iosEnabled,false);assert.equal(b.config({...env,IOS_PAYMENT_READY:'true'},'prod').iosEnabled,true);
 assert.equal(checkout.enabled('test',{TEST_CHECKOUT_READY:'false'}),false);
 const key=checkout.signingSecret(env,'test');assert.equal(key.length,64);assert.notEqual(key,env.PAY_APP_KEY);assert.equal(checkout.signingSecret(env,'prod'),'');assert.equal(JSON.stringify(cfg).includes(key),false);
});
test('test checkout confirms only actual queried payments and then generates a basic plan',async()=>{
 const memory=memoryCloud(),scope=memory.scope('test');let status=1;
 const api=loadEntry('coach_test',scope,{env,realConfig:true,platform:{query:async()=>({status,wx_order_id:'platform-paid'})}});
 const response=await api({action:'purchase.create',sku:'month',assessment:a});assert.equal(response.code,0,response.message);assert.equal(response.data.order.amount,1);assert.equal(response.data.order.plan.testCheckout,true);assert.equal(response.data.order.plan.nutrition.reviewed,false);
 const id=response.data.order.id;assert.equal((await api({action:'purchase.status',orderId:id})).data.order.status,'pending');
 status=2;assert.equal((await api({action:'purchase.status',orderId:id})).data.order.status,'paid');
 const old=process.env.PAY_APP_KEY,oldSecret=process.env.ENTITLEMENT_SECRET;process.env.PAY_APP_KEY=env.PAY_APP_KEY;delete process.env.ENTITLEMENT_SECRET;
 try{const generated=await api({action:'plan.generate',requestId:'test-plan-one',assessment:a});assert.equal(generated.code,0,generated.message);assert.equal(generated.data.entitlement.plan.testCheckout,true);assert.equal(generated.data.entitlement.plan.contentStatus,'test');assert.equal(generated.data.entitlement.plan.nutrition.reviewed,false);assert.equal(generated.data.entitlement.plan.days.length,7);assert.ok(generated.data.entitlement.credential);}
 finally{if(old===undefined)delete process.env.PAY_APP_KEY;else process.env.PAY_APP_KEY=old;if(oldSecret===undefined)delete process.env.ENTITLEMENT_SECRET;else process.env.ENTITLEMENT_SECRET=oldSecret;}
 const prod=loadEntry('coach_prod',memory.scope('prod'),{env,realConfig:true});assert.notEqual((await prod({action:'purchase.create',sku:'month',assessment:a,testCheckout:true,stage:'test'})).code,0);
});

for(const {system,sku,amount,orderType} of [{system:'Android',sku:'month',amount:1,orderType:0},{system:'iOS 18',sku:'month',amount:100,orderType:7}])test(`${system} ${sku} test flow goes from assessment through queried payment to completed execution`,async()=>{
 const oldWx=global.wx,oldTimer=global.setTimeout,oldKey=process.env.PAY_APP_KEY,oldSecret=process.env.ENTITLEMENT_SECRET;
 process.env.PAY_APP_KEY=env.PAY_APP_KEY;delete process.env.ENTITLEMENT_SECRET;
 global.setTimeout=(fn,ms)=>{const timer=oldTimer(fn,ms);timer.unref();return timer;};
 const memory=memoryCloud(),scope=memory.scope('test'),storage=new Map();let remoteStatus=1;
 const backend=loadEntry('coach_test',scope,{env,realConfig:true,platform:{query:async()=>({status:remoteStatus,order_type:orderType,wx_order_id:'actual-query-test'})}});
 for(const key of Object.keys(require.cache))if(key.includes('/miniprogram/'))delete require.cache[key];
 global.wx={getAccountInfoSync:()=>({miniProgram:{envVersion:'develop'}}),getStorageSync:key=>storage.get(key),setStorageSync:(key,value)=>storage.set(key,structuredClone(value)),removeStorageSync:key=>storage.delete(key),getSystemInfoSync:()=>({system,version:'8.0.68'}),login:async()=>({code:'test-login'}),cloud:{callFunction:async({data})=>({result:await backend(data)})},requestVirtualPayment:async()=>{remoteStatus=2;}};
 try{
  const sync=require('../miniprogram/services/syncService'),coach=require('../miniprogram/services/coach'),store=require('../miniprogram/core/store');
  await sync.bootstrap(true);assert.equal(store.get().config.testCheckout,true);assert.equal(store.get().config.contentPublished,false);
  const day=new Date(Date.now()+8*3600000).getUTCDay();await coach.assess({...a,weekdays:[day,(day+2)%7,(day+4)%7]});
  assert.equal(coach.purchaseIssue(),'');const paid=await coach.purchase(sku);assert.equal(paid.status,'paid');assert.equal(paid.amount,amount);assert.equal(store.get().membership.active,true);
  await coach.generate();assert.equal(store.get().entitlement.plan.testCheckout,true);assert.ok(store.get().entitlement.plan.nutrition.energy>0);assert.equal(store.get().entitlement.plan.nutrition.reviewed,false);
  await coach.start();while(store.get().session.exercise<store.get().session.task.exercises.length){store.save({session:{...store.get().session,restUntil:null}});coach.next();}
  await coach.finish('okay',false);assert.equal(coach.snapshot().report.sessions,1);assert.equal(store.get().queue.length,0);
  const persisted=await scope.transact('same-user',s=>s);assert.ok(Object.values(persisted.records).some(r=>r.kind==='session'&&r.value.status==='completed'));
 }finally{global.setTimeout=oldTimer;if(oldWx===undefined)delete global.wx;else global.wx=oldWx;if(oldKey===undefined)delete process.env.PAY_APP_KEY;else process.env.PAY_APP_KEY=oldKey;if(oldSecret===undefined)delete process.env.ENTITLEMENT_SECRET;else process.env.ENTITLEMENT_SECRET=oldSecret;for(const key of Object.keys(require.cache))if(key.includes('/miniprogram/'))delete require.cache[key];}
});

test('signing failures expose only safe platform codes and retain scoped diagnostics',async()=>{
 const memory=memoryCloud(),scope=memory.scope('test');
 const api=loadEntry('coach_test',scope,{env,realConfig:true,platform:{payData:async()=>{const error=new Error('secret must not leak');error.platformCode=40125;throw error;}}});
 const result=await api({action:'purchase.create',sku:'month',assessment:a,code:'fresh'});assert.equal(result.code,'PAYMENT_PLATFORM_ERROR');assert.match(result.message,/40125/);assert.equal(result.message.includes('secret'),false);
 const diagnostic=await api({action:'setup.paymentDiagnostic'});assert.equal(diagnostic.data.phase,'sign-payment');assert.equal(diagnostic.data.platformCode,40125);assert.equal(JSON.stringify(diagnostic.data).includes('secret'),false);
});
test('iOS test purchase uses only the server-priced one-yuan monthly product and does not reuse Android orders',async()=>{
 const memory=memoryCloud(),scope=memory.scope('test');let signed;
 const api=loadEntry('coach_test',scope,{env,realConfig:true,platform:{query:async()=>null,payData:async(owner,order)=>{signed=order;return {};}}});
 const android=await api({action:'purchase.create',sku:'month',assessment:a});assert.equal(android.data.order.amount,1);
 const ios=await api({action:'purchase.create',sku:'month',assessment:a,paymentPlatform:'ios',amount:1,productId:'boji_test_month'});
 assert.equal(ios.code,0,ios.message);assert.equal(ios.data.order.amount,100);assert.notEqual(ios.data.order.id,android.data.order.id);assert.equal(signed.productId,'boji_test_ios_month');
 for(const sku of ['year','three_year'])assert.notEqual((await api({action:'purchase.create',sku,assessment:a,paymentPlatform:'ios'})).code,0);
 assert.deepEqual(b.config(env,'test').iosCatalog.map(x=>x.amount),[100]);
 assert.deepEqual(b.config(env,'prod').iosCatalog.map(x=>x.amount),[1900,19800,29800]);
});

test('unknown coded signing errors are translated instead of becoming the generic unavailable message',async()=>{
 const memory=memoryCloud(),scope=memory.scope('test');
 const api=loadEntry('coach_test',scope,{env,realConfig:true,platform:{payData:async()=>{const e=new Error('private internal path');e.code=-501000;throw e;}}});
 const result=await api({action:'purchase.create',sku:'month',assessment:a,code:'fresh'});
 assert.equal(result.code,'PAYMENT_PREPARE_FAILED');assert.match(result.message,/支付签名/);assert.match(result.message,/-501000/);assert.equal(result.message.includes('private'),false);
 const diagnostic=await api({action:'setup.serviceDiagnostic'});assert.equal(diagnostic.data.action,'purchase.create');assert.equal(diagnostic.data.code,'-501000');
});

test('checkout retires a platform-closed pending order before signing a fresh order',async()=>{
 const memory=memoryCloud(),scope=memory.scope('test');let remote=null,signatures=0;
 const api=loadEntry('coach_test',scope,{env,realConfig:true,platform:{query:async()=>remote,payData:async()=>{signatures++;return {};}}});
 const first=await api({action:'purchase.create',sku:'month',assessment:a});assert.equal(first.code,0);
 remote={status:6};const retry=await api({action:'purchase.create',sku:'month',assessment:a});assert.equal(retry.code,0);assert.notEqual(retry.data.order.id,first.data.order.id);assert.equal(signatures,2);
 const state=await scope.transact('same-user',s=>s);assert.equal(state.orders.find(o=>o.id===first.data.order.id).status,'closed');
});
test('a pending order already paid at WeChat is fulfilled without signing or charging a replacement',async()=>{
 const memory=memoryCloud(),scope=memory.scope('test');let remote=null,signatures=0;
 const api=loadEntry('coach_test',scope,{env,realConfig:true,platform:{query:async()=>remote,payData:async()=>{signatures++;return {};}}});
 const first=await api({action:'purchase.create',sku:'year',assessment:a});remote={status:2,wx_order_id:'confirmed-platform'};
 const retry=await api({action:'purchase.create',sku:'year',assessment:a});assert.equal(retry.code,0);assert.equal(retry.data.order.status,'paid');assert.equal(retry.data.order.id,first.data.order.id);assert.equal(signatures,1);assert.equal(retry.data.state.membership.active,true);
 assert.equal((await scope.transact('same-user',s=>s)).orders.length,1);
});
test('bootstrap enables numbers on an existing paid test plan while production stays closed',async()=>{
 const memory=memoryCloud(),scope=memory.scope('test'),now=Date.now(),date=require('../shared/domain').localDate(now),assessment={...a,schemaVersion:3,targetWeight:65,pace:'moderate',stepGoal:8000};
 await scope.transact('same-user',s=>{s.entitlement={id:'existing-week',version:1,memberPlan:true,startDate:date,plan:require('../shared/domain').makePlan(assessment)};});
 const api=loadEntry('coach_test',scope,{env,realConfig:true});const result=await api({action:'bootstrap'});assert.equal(result.code,0,result.message);
 assert.equal(result.data.config.numericTargetsEnabled,true);assert.equal(result.data.config.nutritionReviewed,false);assert.ok(result.data.state.entitlement.plan.nutrition.energy>0);assert.ok(result.data.state.entitlement.plan.energyTargets.walkingKcal>0);
});
