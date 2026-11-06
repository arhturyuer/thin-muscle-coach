const {test}=require('node:test'),assert=require('node:assert/strict');
const meal=require('../server/meal-ai'),guided=require('../server/guided'),cloudAI=require('../server/cloudbase-ai'),d=require('../shared/domain');
const {memoryCloud}=require('./fixtures/cloud-runtime');
const image='data:image/jpeg;base64,'+Buffer.from([255,216,255,224,1,2,3,4]).toString('base64');
const result={foods:[{name:'米饭',portion:'1小碗',confidence:'medium'}]};
async function setup(){
 const m=memoryCloud(),runtime=m.scope('test'),now=Date.now();
 await runtime.transact('same-user',s=>{s.orders.push({id:'member',sku:'month',months:1,status:'paid',paidAt:now});s.entitlement={id:'week',status:'active',memberPlan:true,startDate:d.localDate(now),expiresAt:now+d.DAY};});
 return {runtime,now,event:{action:'meal.recognize',consent:true,date:d.localDate(now),requestId:'photo-request',image}};
}
test('AI and meal recognition can be enabled independently in test without enabling reviewed nutrition',()=>{
 const ai=guided.config({AI_READY:'true',CLOUDBASE_AI_API_KEY:'test'},'test');assert.equal(ai.aiEnabled,true);assert.equal(ai.mealRecognitionEnabled,false);assert.equal(ai.nutritionReviewed,false);
 const vision=guided.config({MEAL_RECOGNITION_READY:'true',CLOUDBASE_AI_API_KEY:'test'},'test');assert.equal(vision.mealRecognitionEnabled,true);assert.equal(vision.aiEnabled,false);
 assert.equal(guided.config({MEAL_RECOGNITION_READY:'true',CLOUDBASE_AI_API_KEY:'test',CLOUDBASE_AI_BASE_URL:'https://evil.example/compatible-mode/v1'},'test').mealRecognitionEnabled,false);
});
test('meal recognition rejects URLs, invalid encoding, MIME mismatches and oversized photos',()=>{
 for(const input of ['https://example.com/a.jpg','data:image/jpeg;base64,YWJj',image.replace('jpeg','png'),image+'=', 'data:image/jpeg;base64,'+Buffer.alloc(601*1024).toString('base64')])assert.throws(()=>meal.imageData(input));
 assert.equal(meal.imageData(image).length,64);
});
test('recognition preserves food names and valid metrics when the model gives inconsistent estimates',()=>{
 const item=meal.normalize({foods:[{name:'苹果',portion:'一个',confidence:'medium',weightGrams:4,energyKcal:900,
   proteinGrams:'1.2',fatGrams:1,carbGrams:20},{name:'米饭',portion:'一碗',confidence:'medium',weightGrams:120,energyKcal:'未知',carbGrams:25} ]});
 assert.deepEqual(item.foods.map(food=>food.name),['苹果','米饭']);
 assert.equal(item.foods[0].weightGrams,null);assert.equal(item.foods[0].energyKcal,null);
 assert.equal(item.foods[0].proteinGrams,1.2);assert.equal(item.foods[1].weightGrams,120);
 assert.equal(item.foods[1].energyKcal,null);assert.equal(item.totals.carbGrams,45);
 assert.equal(require('../shared/nutrition').validAnalysis(item),true);
 assert.deepEqual(meal.normalize({foods:[]}).foods,[]);
});
test('meal recognition requires consent, enabled service, current date and paid membership before calling model',async()=>{
 const {runtime,now,event}=await setup();let calls=0;const provider=async()=>{calls++;return result;};
 for(const [patch,cfg]of [[{consent:false},{mealRecognitionEnabled:true}],[{},{}],[{date:'2000-01-01'},{mealRecognitionEnabled:true}]])await assert.rejects(meal.handle({...event,...patch},runtime,cfg,now,provider));
 await runtime.transact('same-user',s=>{s.orders[0].status='refunded';});
 await assert.rejects(meal.handle(event,runtime,{mealRecognitionEnabled:true},now,provider));assert.equal(calls,0);
});
test('meal results are idempotent, quota is capped, and source photos are not persisted',async()=>{
 const {runtime,now,event}=await setup();let calls=0;const provider=async()=>{calls++;return result;},cfg={mealRecognitionEnabled:true};
 const first=await meal.handle(event,runtime,cfg,now,provider);assert.match(first.text,/米饭/);
 assert.deepEqual(await meal.handle(event,runtime,cfg,now,provider),first);assert.equal(calls,1);
 for(let i=1;i<20;i++)await meal.handle({...event,requestId:'photo-'+i},runtime,cfg,now,provider);
 await assert.rejects(meal.handle({...event,requestId:'photo-over'},runtime,cfg,now,provider),e=>e.code==='QUOTA_EXCEEDED');assert.equal(calls,20);
 await runtime.auxTransact('same-user','meal:'+event.date,row=>{assert.equal(JSON.stringify(row).includes(event.image),false);assert.equal(Object.keys(row.requests).length,20);});
});
test('failed or malformed recognition does not consume quota and concurrent requests are blocked',async()=>{
 const {runtime,now,event}=await setup(),cfg={mealRecognitionEnabled:true};let release,started;const ready=new Promise(r=>started=r);
 const pending=meal.handle(event,runtime,cfg,now,()=>{started();return new Promise(r=>release=r);});await ready;
 await assert.rejects(meal.handle({...event,requestId:'photo-other'},runtime,cfg,now,async()=>result),e=>e.code==='PENDING');release({foods:[{name:'rice',portion:'1',confidence:'invalid'}]});await assert.rejects(pending);
 await runtime.auxTransact('same-user','meal:'+event.date,row=>assert.equal(Object.keys(row.requests).length,0));
 assert.match((await meal.handle(event,runtime,cfg,now,async()=>result)).text,/米饭/);
});
test('deleting personal data invalidates in-flight recognition',async()=>{
 const {runtime,now,event}=await setup();let release,started;const ready=new Promise(r=>started=r);
 const pending=meal.handle(event,runtime,{mealRecognitionEnabled:true},now,()=>{started();return new Promise(r=>release=r);});await ready;
 await runtime.transact('same-user',s=>{s.deletedAt=now+1;s.entitlement=null;});await runtime.clearGuidance('same-user');release(result);await assert.rejects(pending);
 await runtime.auxTransact('same-user','meal:'+event.date,row=>assert.equal(Object.keys(row.requests||{}).length,0));
});
test('status recovers a pending or completed result without sending the image or consuming quota',async()=>{
 const {runtime,now,event}=await setup();const query={date:event.date,requestId:event.requestId,planId:'week'};
 assert.equal((await meal.status(query,runtime,now)).status,'missing');
 let resolve,started;const ready=new Promise(r=>started=r);let calls=0;
 const pending=meal.handle(event,runtime,{mealRecognitionEnabled:true},now,()=>{calls++;started();return new Promise(r=>resolve=r);});await ready;
 assert.equal((await meal.status(query,runtime,now)).status,'pending');
 resolve(result);const recognized=await pending;
 for(let i=0;i<3;i++)assert.deepEqual(await meal.status(query,runtime,now),{status:'completed',result:recognized});
 assert.equal(calls,1);
 await assert.rejects(meal.status({...query,planId:'different-plan'},runtime,now),e=>e.code==='VERSION_CONFLICT');
 await assert.rejects(meal.status({...query,date:'2000-01-01'},runtime,now),e=>e.code==='INVALID');
 await runtime.auxTransact('same-user','meal:'+event.date,row=>assert.equal(JSON.stringify(row).includes(event.image),false));
});
test('failed recognition status is recoverable, expired leases stop waiting and other accounts cannot fetch results',async()=>{
 const {runtime,now,event}=await setup(),query={date:event.date,requestId:event.requestId,planId:'week'};
 await assert.rejects(meal.handle(event,runtime,{mealRecognitionEnabled:true},now,async()=>{throw Object.assign(new Error('model timeout'),{aiDiagnostic:{kind:'timeout'}});}),/等待超时/);
 const failed=await meal.status(query,runtime,now);
 assert.equal(failed.status,'failed');assert.match(failed.message,/等待超时/);
 await runtime.auxTransact('same-user','meal:'+event.date,row=>{row.requests[event.requestId]={status:'pending',until:now-1,epoch:0,planId:'week'};});
 assert.equal((await meal.status(query,runtime,now)).status,'expired');
 const other={...runtime,cloud:{getWXContext:()=>({OPENID:'another-user'})}};
 await runtime.transact('another-user',s=>{s.entitlement={id:'week',status:'active',startDate:d.localDate(now),expiresAt:now+d.DAY};s.orders=[{id:'member',sku:'month',months:1,status:'paid',paidAt:now}];});
 assert.equal((await meal.status(query,other,now)).status,'missing');
});
test('changing plans while a photo is analyzed discards the old result',async()=>{
 const {runtime,now,event}=await setup();let resolve,started;const ready=new Promise(r=>started=r);
 const pending=meal.handle(event,runtime,{mealRecognitionEnabled:true},now,()=>{started();return new Promise(r=>resolve=r);});await ready;
 await runtime.transact('same-user',s=>{s.entitlement.id='new-week';});resolve(result);await assert.rejects(pending);
 await runtime.auxTransact('same-user','meal:'+event.date,row=>assert.equal(Object.keys(row.requests).length,0));
});
