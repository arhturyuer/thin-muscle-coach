const {test}=require('node:test'),assert=require('node:assert/strict');
const g=require('../shared/guidance'),d=require('../shared/domain'),b=require('../server/business'),guided=require('../server/guided'),ai=require('../server/daily-ai');
const {memoryCloud,loadEntry}=require('./fixtures/cloud-runtime');
const assessment={schemaVersion:2,consent:true,screening:'clear',age:28,sex:'male',height:175,weight:70,waist:'',goal:'habit',experience:'beginner',activity:'light',minutes:15,frequency:3,weekdays:[1,3,5],equipment:'none',foodScene:'takeout',foodObstacle:'irregular',diet:'none',allergies:''};
const now=Date.parse('2026-10-30T12:00:00+08:00');
function serialMemory(){const memory=memoryCloud();const original=memory.db.runTransaction;let tail=Promise.resolve();memory.db.runTransaction=fn=>{const next=tail.then(()=>original(fn));tail=next.catch(()=>{});return next;};return memory;}
async function memberRuntime(time=now){const memory=serialMemory(),runtime=memory.scope('test');await runtime.transact('same-user',s=>{s.orders.push({id:'membership-order',status:'paid',sku:'year',months:12,amount:19800,paidAt:time-1000});s.entitlement=guided.entitlement(s,assessment,{}, {nutritionReviewed:true},time);});return {memory,runtime};}
test('new assessment validates fields, weekdays, consent and suitability',()=>{
 assert.equal(g.validate(assessment),'');
 for(const patch of [{consent:false},{frequency:4},{weekdays:[1,1,5]},{height:0},{weight:'x'},{allergies:42}])assert.ok(g.validate({...assessment,...patch}));
 assert.equal(d.makePlan({...assessment,screening:'guidance'}),null);
 assert.equal(d.makePlan({...assessment,weight:40}),null);
 assert.equal(d.makePlan({...assessment,age:70}),null);
});
test('answers change actual training schedule, load, food and numeric targets',()=>{
 const a=d.makePlan(assessment,{}, {startDate:'2026-10-30',nutritionReviewed:true});
 assert.deepEqual(a.days.filter(x=>!x.rest).map(x=>x.index),[0,3,5]);
 const changed=d.makePlan({...assessment,minutes:30,experience:'occasional',frequency:2,weekdays:[0,2],equipment:'band',foodScene:'cook',foodObstacle:'protein',goal:'muscle',diet:'vegetarian'},{row:'cloud://row'},{startDate:'2026-10-30',nutritionReviewed:true});
 assert.equal(changed.days.filter(x=>!x.rest).length,2);
 const moves=changed.days.find(x=>!x.rest).exercises;assert.equal(moves.length,5);assert.equal(moves[0].sets,3);assert.equal(moves[0].reps,10);
 assert.notEqual(a.nutrition.scene,changed.nutrition.scene);assert.notEqual(a.nutrition.task,changed.nutrition.task);assert.notEqual(a.nutrition.energy,changed.nutrition.energy);assert.ok(changed.nutrition.meals.every(x=>!x.includes('肉')));
 assert.equal(d.makePlan(assessment).nutrition.energy,undefined);
 assert.equal(d.makePlan({...assessment,allergies:'大豆'}).nutrition.meals.length,1);
});
test('membership durations use calendar months and Shanghai month-end clamping',()=>{
 assert.equal(new Date(g.addMonths(Date.parse('2026-01-31T20:15:00+08:00'),1)).toISOString(),'2026-02-28T12:15:00.000Z');
 assert.equal(new Date(g.addMonths(Date.parse('2024-02-29T12:00:00+08:00'),12)).toISOString(),'2025-02-28T04:00:00.000Z');
 const paid=Date.parse('2026-01-31T12:00:00+08:00');const orders=[{id:'a',sku:'month',months:1,status:'paid',paidAt:paid},{id:'b',sku:'year',months:12,status:'paid',paidAt:paid+1000}];
 const m=g.membership(orders,paid);assert.equal(m.segments[1].startsAt,m.segments[0].expiresAt);assert.equal(m.expiresAt,g.addMonths(g.addMonths(paid,1),12));
 orders[0].status='refunded';assert.equal(g.membership(orders,paid+1000).expiresAt,g.addMonths(paid+1000,12));
 orders[1].redacted=true;assert.equal(g.membership(orders,paid+1000).active,false);
});
test('membership fulfillment and refund are idempotent and preserve old challenge orders',()=>{
 const s=b.fresh();s.orders.push({id:'new-order',sku:'month',months:1,status:'pending',amount:1900});b.fulfill(s,'new-order','platform');const revision=s.revision;b.fulfill(s,'new-order','platform');assert.equal(s.revision,revision);assert.equal(s.entitlement,null);assert.equal(b.publicState(s).membership.active,true);
 b.refund(s,'new-order','refund');const refunded=s.revision;b.refund(s,'new-order','refund');b.fulfill(s,'new-order','late');assert.equal(s.revision,refunded);assert.equal(b.publicState(s).membership.active,false);
 s.orders.push({id:'legacy-order',status:'pending',amount:990,plan:d.makePlan({age:28,goal:'habit',experience:'beginner',minutes:15,equipment:'none',screening:'clear',consent:true})});b.fulfill(s,'legacy-order','legacy');assert.equal(s.entitlement.status,'pending');assert.equal(s.entitlement.id,'legacy-order');
});
test('new SKU purchase rejects legacy creation, ignores caller amount and snapshots three prices',async()=>{
 const memory=serialMemory(),scope=memory.scope('test'),api=loadEntry('coach_test',scope);
 assert.notEqual((await api({action:'purchase.create',assessment})).code,0);
 for(const product of g.catalogForStage('test')){const r=await api({action:'purchase.create',assessment,sku:product.sku,amount:1,months:999});assert.equal(r.code,0,r.message);assert.equal(r.data.order.amount,product.amount);const state=await scope.transact('same-user',s=>s);const o=state.orders.find(x=>x.id===r.data.order.id);assert.equal(o.months,product.months);assert.ok(o.productId);}
});
test('new service requires all promised capabilities before selling',()=>{
 const env={MEMBERSHIP_READY:'true',AI_READY:'true',CLOUDBASE_AI_API_KEY:'test',NUTRITION_READY:'true',NUTRITION_REVIEW_ID:'review',PAY_PRODUCT_MONTH:'m',PAY_PRODUCT_YEAR:'y',PAY_PRODUCT_THREE_YEAR:'t'};
 assert.equal(guided.config(env).membershipEnabled,true);
 for(const key of ['CLOUDBASE_AI_API_KEY','NUTRITION_REVIEW_ID','PAY_PRODUCT_YEAR'])assert.equal(guided.config({...env,[key]:''}).membershipEnabled,false);
 assert.equal('CLOUDBASE_AI_API_KEY' in guided.config(env),false);
});
test('weekly adjustment checks versions, preserves current plan and generates next week',async()=>{
 const previous=process.env.ENTITLEMENT_SECRET;process.env.ENTITLEMENT_SECRET='test-secret';
 try{const {runtime}=await memberRuntime();const before=await runtime.transact('same-user',s=>structuredClone(s.entitlement));
 await runtime.archivePlan('same-user',before);
 await runtime.transact('same-user',s=>{for(let i=0;i<2;i++)s.records['s'+i]={kind:'session',value:{planId:before.id,status:'completed',date:'2026-10-30'}};});
 const cfg={contentPublished:true,nutritionReviewed:true,media:{}};
 const r=await guided.handle({action:'plan.review',baseVersion:before.version,requestId:'review-one',review:{difficulty:'hard',fatigue:'high',hunger:'high'}},runtime,cfg,now);assert.equal(r.data.proposal.loadDelta,-1);
 await assert.rejects(guided.handle({action:'plan.review',baseVersion:999,requestId:'review-bad',review:{}},runtime,cfg,now),/更新/);
 await assert.rejects(guided.handle({action:'plan.confirm',requestId:'bad-confirm',baseVersion:before.version,proposalId:'another-review'},runtime,cfg,now),e=>e.code==='VERSION_CONFLICT');
 await guided.handle({action:'plan.confirm',requestId:'confirm-one',baseVersion:before.version,proposalId:'review-one'},runtime,cfg,now);await guided.handle({action:'plan.confirm',requestId:'confirm-one',baseVersion:before.version,proposalId:'review-one'},runtime,cfg,now);
 assert.deepEqual((await runtime.transact('same-user',s=>s.entitlement)),before);
 const next=await guided.handle({action:'plan.generate',requestId:'generate-next'},runtime,cfg,now+7*d.DAY);assert.notEqual(next.data.entitlement.id,before.id);assert.equal(next.data.entitlement.version,before.version+1);
 assert.equal(next.data.entitlement.plan.days.find(x=>!x.rest).exercises[0].sets,1);
 assert.ok((await runtime.loadPlan('same-user',before.id)).plan);
 }finally{if(previous===undefined)delete process.env.ENTITLEMENT_SECRET;else process.env.ENTITLEMENT_SECRET=previous;}
});
test('historical weekly records validate against immutable archive and refunded access is rejected',async()=>{
 const {runtime}=await memberRuntime();const s=await runtime.transact('same-user',s=>structuredClone(s));const e=s.entitlement;const index=e.plan.days.findIndex(x=>!x.rest),date=d.localDate(now+index*d.DAY);
 const op={id:'session-op',kind:'session',key:`session:${e.id}:${index}`,baseVersion:0,value:{planId:e.id,day:index,date,status:'completed',completedSets:e.plan.days[index].exercises.reduce((n,x)=>n+x.sets,0),seconds:600,difficulty:'okay',discomfort:false}};
 s.entitlement=null;assert.equal(b.applyBatch(s,[op],now+14*d.DAY,{[e.id]:e})[0].status,'ok');s.orders[0].status='refunded';assert.equal(b.applyBatch(s,[{...op,id:'session-new',baseVersion:1}],now+14*d.DAY,{[e.id]:e})[0].status,'invalid');
});
test('30 successful AI replies are charged once, the 31st is blocked, next day resets',async()=>{
 const {runtime}=await memberRuntime();let calls=0;const provider=async()=>{calls++;return {reply:'先按今天安排完成熟悉动作，留意身体感受。',adjustment:null};};
 const cfg={aiEnabled:true};let result;
 for(let i=0;i<30;i++)result=await ai.handle({action:'ai.ask',requestId:'request-'+i,message:'怎么开始？'},runtime,cfg,now,provider);
 assert.equal(result.remaining,0);assert.equal(calls,30);
 result=await ai.handle({action:'ai.ask',requestId:'request-0',message:'怎么开始？'},runtime,cfg,now,provider);assert.equal(calls,30);assert.equal(result.remaining,0);
 await assert.rejects(ai.handle({action:'ai.ask',requestId:'request-31',message:'今天怎么练？'},runtime,cfg,now,provider),e=>e.code==='QUOTA_EXCEEDED');
 const next=await ai.handle({action:'ai.ask',requestId:'request-next',message:'怎么开始？'},runtime,cfg,now+d.DAY,provider);assert.equal(next.remaining,29);
 const history=await ai.handle({action:'ai.history',date:d.localDate(now)},runtime,cfg,now,provider);assert.equal(history.messages.length,10);assert.equal(history.nextOffset,10);
});
test('AI timeout, invalid response and duplicate concurrency never consume extra quota',async()=>{
 const {runtime}=await memberRuntime(),cfg={aiEnabled:true};const event={action:'ai.ask',requestId:'retry-request',message:'今天怎么练？'};
 await assert.rejects(ai.handle(event,runtime,cfg,now,async()=>{throw new Error('timeout');}),/未扣/);
 await assert.rejects(ai.handle(event,runtime,cfg,now,async()=>({reply:'每天只吃 800 千卡'})),/未扣/);
 let release,started;const ready=new Promise(r=>started=r);const pending=ai.handle(event,runtime,cfg,now,()=>{started();return new Promise(r=>release=r);});await ready;
 await assert.rejects(ai.handle(event,runtime,cfg,now,async()=>({reply:'重复'})),e=>e.code==='PENDING');
 await assert.rejects(ai.handle({...event,requestId:'other-request'},runtime,cfg,now,async()=>({reply:'并发'})),e=>e.code==='PENDING');
 release({reply:'先保持今天的训练节奏。'});assert.equal((await pending).remaining,29);
});
test('AI saved reply survives network retry across midnight without charging the new day',async()=>{
 const midnight=Date.parse('2026-10-30T23:59:59+08:00'),{runtime}=await memberRuntime(midnight),cfg={aiEnabled:true};let calls=0;
 const event={action:'ai.ask',requestId:'midnight-request',date:'2026-10-30',message:'明天怎么练？'},provider=async()=>{calls++;return {reply:'先查看明天的安排。'};};
 await ai.handle(event,runtime,cfg,midnight,provider);const retry=await ai.handle(event,runtime,cfg,midnight+2000,provider);assert.equal(calls,1);assert.equal(retry.remaining,29);
 assert.equal((await ai.handle({action:'ai.quota'},runtime,cfg,midnight+2000,provider)).remaining,30);
});
test('account deletion invalidates in-flight AI, removes conversation and plan health data',async()=>{
 const {runtime,memory}=await memberRuntime();let release,started;const ready=new Promise(r=>started=r);
 const pending=ai.handle({action:'ai.ask',requestId:'delete-request',message:'怎么练？'},runtime,{aiEnabled:true},now,()=>{started();return new Promise(r=>release=r);});await ready;
 await runtime.transact('same-user',s=>{s.deletedAt=now+1;s.entitlement=null;s.orders=s.orders.map(x=>({...x,redacted:true}));});await runtime.clearGuidance('same-user');release({reply:'按安排执行。'});await assert.rejects(pending,/未扣/);
 const rows=[...memory.collections.get('coach_test_accounts_guidance').values()];assert.ok(rows.every(x=>!x.requests||Object.keys(x.requests).length===0));
});
test('conversion events archive outside health snapshot and deduplicate retries',async()=>{
 const memory=serialMemory(),scope=memory.scope('test'),api=loadEntry('coach_test',scope);await api({action:'bootstrap'});
 const op={id:'event-operation',kind:'event',key:'event:assessment_step:step2-request',baseVersion:0,value:{name:'assessment_step',at:now,date:d.localDate(now)}};
 for(let i=0;i<2;i++){const r=await api({action:'sync.batch',owner:'same-user',operations:[op]});assert.equal(r.code,0);assert.equal(r.data.results[0].status,'ok');assert.equal(r.data.state.records[op.key],undefined);}
 const rows=[...memory.collections.get('coach_test_accounts_guidance').values()].filter(x=>x.key.startsWith('event:'));assert.equal(rows.length,1);assert.deepEqual(rows[0].value,op.value);
 const state=await scope.transact('same-user',s=>s);assert.equal(state.processed[op.id],undefined);
});
test('weekly progression retains confirmed load and requires multiple weight records for new baseline',()=>{
 const s=b.fresh();s.entitlement={id:'weekly',version:1,startDate:'2026-10-23',memberPlan:true,plan:d.makePlan(assessment,{}, {startDate:'2026-10-23',loadDelta:-1})};
 let p=guided.proposal(s,{difficulty:'easy',fatigue:'low',hunger:'okay'});assert.equal(p.loadDelta,-1);assert.equal(p.assessment.weight,70);
 s.records.a={kind:'session',value:{planId:'weekly',status:'completed'}};s.records.b={kind:'session',value:{planId:'weekly',status:'completed'}};
 p=guided.proposal(s,{difficulty:'easy',fatigue:'low',hunger:'okay'});assert.equal(p.loadDelta,0);
 for(let i=0;i<6;i++)s.records['w'+i]={kind:'measurement',value:{date:`2026-10-${20+i}`,weight:68+i/10}};
 p=guided.proposal(s,{difficulty:'okay',fatigue:'okay',hunger:'okay'});assert.ok(p.trend);assert.equal(p.assessment.weight,68.4);
});
test('new client completes assessment, pays monthly, starts today and syncs versioned training',async()=>{
 const oldWx=global.wx,secret=process.env.ENTITLEMENT_SECRET;process.env.ENTITLEMENT_SECRET='integration-secret';const storage=new Map();
 const memory=serialMemory(),scope=memory.scope('prod'),backend=loadEntry('coach_prod',scope);
 const weekday=new Date(Date.now()+8*3600000).getUTCDay(),a={...assessment,weekdays:[weekday,(weekday+2)%7,(weekday+4)%7]};
 for(const key of Object.keys(require.cache))if(key.includes('/miniprogram/'))delete require.cache[key];
 global.wx={getAccountInfoSync:()=>({miniProgram:{envVersion:'release'}}),getStorageSync:key=>storage.get(key),setStorageSync:(key,value)=>storage.set(key,structuredClone(value)),removeStorageSync:key=>storage.delete(key),getSystemInfoSync:()=>({system:'Android',version:'8.0.68'}),login:async()=>({code:'login'}),cloud:{callFunction:async({data})=>({result:await backend(data)})},requestVirtualPayment:async()=>{await scope.transact('same-user',s=>b.fulfill(s,s.orders[0].id,'verified-platform'));}};
 try{
  const sync=require('../miniprogram/services/syncService'),coach=require('../miniprogram/services/coach'),store=require('../miniprogram/core/store');
  await sync.bootstrap(true);assert.equal(store.get().owner,'same-user');
  await coach.assess(a);const paid=await coach.purchase('month');assert.equal(paid.status,'paid');assert.equal(store.get().membership.active,true);
  await coach.generate();assert.ok(store.get().entitlement.memberPlan);assert.equal(store.get().entitlement.plan.days[0].rest,false);
  await coach.start();while(store.get().session.exercise<store.get().session.task.exercises.length){store.save({session:{...store.get().session,restUntil:null}});coach.next();}
  await coach.finish('okay',false);assert.equal(store.get().queue.length,0);assert.equal(coach.snapshot().report.sessions,1);
  const actual=await scope.transact('same-user',s=>s);assert.ok(Object.values(actual.records).some(r=>r.kind==='session'&&r.value.status==='completed'));
 }finally{for(const key of Object.keys(require.cache))if(key.includes('/miniprogram/'))delete require.cache[key];if(oldWx===undefined)delete global.wx;else global.wx=oldWx;if(secret===undefined)delete process.env.ENTITLEMENT_SECRET;else process.env.ENTITLEMENT_SECRET=secret;}
});

test('payment prices come from the deployed stage and cannot be overridden by callers',async()=>{
 const memory=serialMemory();
 for(const stage of ['test','prod']){
  const api=loadEntry(stage==='test'?'coach_test':'coach_prod',memory.scope(stage));
  const boot=await api({action:'bootstrap',stage:stage==='test'?'prod':'test'});
  const products=g.catalogForStage(stage);
  assert.deepEqual(boot.data.config.catalog.map(x=>x.amount),stage==='test'?[1,2,3]:[1900,19800,29800]);
  for(const product of products){
   const response=await api({action:'purchase.create',assessment,sku:product.sku,stage:stage==='test'?'prod':'test',amount:stage==='test'?1900:1});
   assert.equal(response.code,0,response.message);assert.equal(response.data.order.amount,product.amount);
   const again=await api({action:'purchase.create',assessment,sku:product.sku});assert.notEqual(again.data.order.id,response.data.order.id);
  }
 }
});
test('new orders never reuse a pending order with a different price or product',async()=>{
 const memory=serialMemory(),scope=memory.scope('test'),api=loadEntry('coach_test',scope);
 const first=await api({action:'purchase.create',assessment,sku:'month'});assert.equal(first.code,0);
 await scope.transact('same-user',s=>{s.orders[0].amount=1900;});
 const second=await api({action:'purchase.create',assessment,sku:'month'});assert.notEqual(second.data.order.id,first.data.order.id);assert.equal(second.data.order.amount,1);
 await scope.transact('same-user',s=>{s.orders.find(o=>o.id===second.data.order.id).productId='previous-product';});
 const third=await api({action:'purchase.create',assessment,sku:'month'});assert.notEqual(third.data.order.id,second.data.order.id);
});

test('optional quota storage failure does not hide bootstrap payment configuration',async()=>{
 const memory=serialMemory(),scope=memory.scope('test');
 const api=loadEntry('coach_test',{...scope,auxTransact:async()=>{throw new Error('collection not exists');}});
 const result=await api({action:'bootstrap'});
 assert.equal(result.code,0);assert.equal(result.data.config.paymentsEnabled,true);assert.equal(result.data.config.membershipEnabled,true);
 assert.equal(result.data.aiQuota,null);assert.equal(result.data.aiQuotaUnavailable,true);assert.equal(result.data.userId,'same-user');
});
