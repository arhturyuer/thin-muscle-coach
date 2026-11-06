const b=require('./business');
// Public callback bridge: the event is only a hint. WeChat query results are the proof.
async function reconcile(runtime,orderId,platform=require('./platform')){
 if(runtime.stage!=='test'||!/^bjt[0-9a-f]{24}$/.test(orderId||''))b.fail('无效测试订单');
 const index=await runtime.lookup(orderId);if(!index)return {confirmed:false};
 const order=await runtime.transact(index.userId,s=>s.orders.find(o=>o.id===orderId&&!o.redacted)||null);
 if(!order||order.status==='refunded')return {confirmed:false};
 const remote=await platform.query(index.userId,orderId);
 if(!remote||![2,3,4].includes(remote.status))return {confirmed:false,platformStatus:remote?remote.status:null};
 if(remote.order_type!==undefined&&![0,7].includes(remote.order_type))return {confirmed:false,platformStatus:remote.status};
 if(remote.order_id!==undefined&&remote.order_id!==orderId)b.fail('微信订单号与本地订单不一致','PAYMENT_RESPONSE_INVALID');
 if(remote.order_fee!==undefined&&remote.order_fee!==order.amount)b.fail('微信订单金额与本地订单不一致','PAYMENT_RESPONSE_INVALID');
 if(typeof remote.wx_order_id!=='string'||!remote.wx_order_id)b.fail('微信查单未返回平台单号','PAYMENT_RESPONSE_INVALID');
 const confirmed=await runtime.transact(index.userId,s=>{
  const current=s.orders.find(o=>o.id===orderId&&!o.redacted);if(!current||current.status==='refunded')return false;
  b.fulfill(s,orderId,remote.wx_order_id);return true;
 });
 let deliveryAcknowledged=remote.status===4;
 if(confirmed&&!deliveryAcknowledged&&typeof platform.acknowledgeDelivery==='function'){
  try{await platform.acknowledgeDelivery(orderId);deliveryAcknowledged=true;}catch(error){/* Keep verified entitlement; retry delivery acknowledgement later. */}
 }
 if(confirmed&&deliveryAcknowledged)await runtime.transact(index.userId,s=>{const current=s.orders.find(o=>o.id===orderId);if(current&&!current.deliveryAcknowledgedAt){current.deliveryAcknowledgedAt=Date.now();s.revision++;}});
 return {confirmed,deliveryAcknowledged};
}
module.exports={reconcile};
