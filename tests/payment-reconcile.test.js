const {test}=require('node:test'),assert=require('node:assert/strict');
const {memoryCloud}=require('./fixtures/cloud-runtime'),{reconcile}=require('../server/payment-reconcile');
const id='bjt'+'a'.repeat(24);
async function fixture(){const runtime=memoryCloud().scope('test');await runtime.transact('owner',s=>s.orders.push({id,sku:'month',months:1,amount:1,status:'pending'}));await runtime.db.collection(runtime.tables.orders).doc(id).set({data:{userId:'owner',orderId:id}});return runtime;}
test('a callback hint cannot grant access without independent platform proof',async()=>{
 const runtime=await fixture();let seen;const result=await reconcile(runtime,id,{query:async(owner,order)=>{seen=[owner,order];return {status:1};}});assert.equal(result.confirmed,false);assert.deepEqual(seen,['owner',id]);assert.equal((await runtime.transact('owner',s=>s)).orders[0].status,'pending');
});
test('verified delivery is idempotent and requires a platform transaction ID',async()=>{
 const runtime=await fixture();await assert.rejects(reconcile(runtime,id,{query:async()=>({status:2})}),/平台单号/);
 const platform={query:async()=>({status:2,wx_order_id:'wx-platform'})};assert.equal((await reconcile(runtime,id,platform)).confirmed,true);const first=await runtime.transact('owner',s=>structuredClone(s));await reconcile(runtime,id,platform);const second=await runtime.transact('owner',s=>s);assert.equal(second.revision,first.revision);assert.equal(second.orders[0].platformId,'wx-platform');
 await assert.rejects(reconcile({...runtime,stage:'prod'},id,platform),/测试订单/);
});

test('paid delivery-in-progress status grants once and acknowledges platform delivery',async()=>{
 const runtime=await fixture();let acknowledgements=0;
 const platform={query:async()=>({status:3,order_type:0,order_id:id,order_fee:1,wx_order_id:'paid-platform'}),acknowledgeDelivery:async order=>{assert.equal(order,id);acknowledgements++;}};
 const result=await reconcile(runtime,id,platform);assert.equal(result.confirmed,true);assert.equal(result.deliveryAcknowledged,true);
 const state=await runtime.transact('owner',s=>structuredClone(s));assert.equal(state.orders[0].status,'paid');assert.ok(state.orders[0].deliveryAcknowledgedAt);
 await reconcile(runtime,id,platform);const again=await runtime.transact('owner',s=>s);assert.equal(again.revision,state.revision);assert.equal(again.orders[0].paidAt,state.orders[0].paidAt);assert.equal(acknowledgements,2);
});
test('a verified payment is preserved if acknowledgement is temporarily unavailable',async()=>{
 const runtime=await fixture();const result=await reconcile(runtime,id,{query:async()=>({status:3,wx_order_id:'paid-platform'}),acknowledgeDelivery:async()=>{throw new Error('network');}});
 assert.equal(result.confirmed,true);assert.equal(result.deliveryAcknowledged,false);assert.equal((await runtime.transact('owner',s=>s)).orders[0].status,'paid');
});
test('an independently verified iOS payment is fulfilled and delivery is acknowledged once locally',async()=>{
 const runtime=await fixture();let acknowledged=0;
 const platform={query:async()=>({status:3,order_type:7,order_id:id,order_fee:1,wx_order_id:'apple-payment'}),acknowledgeDelivery:async()=>{acknowledged++;}};
 assert.equal((await reconcile(runtime,id,platform)).confirmed,true);
 const first=await runtime.transact('owner',s=>structuredClone(s));
 platform.query=async()=>({status:4,order_type:7,order_id:id,order_fee:1,wx_order_id:'apple-payment'});
 assert.equal((await reconcile(runtime,id,platform)).deliveryAcknowledged,true);
 const again=await runtime.transact('owner',s=>s);assert.equal(acknowledged,1);assert.equal(again.revision,first.revision);assert.equal(again.orders[0].paidAt,first.orders[0].paidAt);assert.equal(again.orders[0].platformId,'apple-payment');
});
test('delivery rejects an amount mismatch and a refund-type order',async()=>{
 const runtime=await fixture();await assert.rejects(reconcile(runtime,id,{query:async()=>({status:3,wx_order_id:'wx',order_fee:999})}),/金额/);
 assert.equal((await reconcile(runtime,id,{query:async()=>({status:3,wx_order_id:'wx',order_type:1})})).confirmed,false);
});

test('different local orders cannot consume the same verified platform transaction',async()=>{
 const runtime=await fixture(),other='bjt'+'b'.repeat(24);
 await runtime.transact('owner',s=>s.orders.push({id:other,sku:'year',months:12,amount:2,status:'pending'}));await runtime.db.collection(runtime.tables.orders).doc(other).set({data:{userId:'owner',orderId:other}});
 const platform={query:async()=>({status:3,wx_order_id:'same-platform'})};await reconcile(runtime,id,platform);await assert.rejects(reconcile(runtime,other,platform),/已处理/);
 assert.equal((await runtime.transact('owner',s=>s)).orders.find(o=>o.id===other).status,'pending');
});

test('test timer delegates pending confirmations to the credential-owning business function',async()=>{
 const {loadEntry}=require('./fixtures/cloud-runtime');const memory=memoryCloud(),runtime=memory.scope('test');
 await runtime.transact('owner',s=>s.orders.push({id,sku:'month',months:1,amount:1,status:'pending'}));memory.setContext({});
 const calls=[];memory.cloud.callFunction=async input=>{calls.push(input);return {result:{code:0,data:{confirmed:true}}};};
 const job=loadEntry('reminderJob_test',runtime,{realConfig:true});const result=await job({Type:'Timer'});
 assert.equal(result.stage,'test');assert.equal(result.sent,0);assert.equal(calls.length,1);assert.equal(calls[0].name,'coach_test');assert.equal(calls[0].data.action,'payment.reconcile');assert.equal(calls[0].data.orderId,id);
});
