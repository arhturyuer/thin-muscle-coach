const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),{EventEmitter}=require('node:events');
function platform(response){let options,written;const module={exports:{}};
 const https={request(url,args,callback){options=args;const req=new EventEmitter();req.setTimeout=()=>{};req.write=body=>{written=body;};req.destroy=e=>req.emit('error',e);req.end=()=>{const answer=Array.isArray(response)?response.shift():response;const res=new EventEmitter();res.statusCode=answer.status;callback(res);if(answer.body)res.emit('data',answer.body);res.emit('end');};return req;}};
 vm.runInNewContext(fs.readFileSync(require.resolve('../server/platform'),'utf8'),{module,exports:module.exports,Buffer,Date,process:{env:{APP_ID:'test-app',APP_SECRET:'test-secret',PAY_APP_KEY:'test-payment-key'}},require:name=>name==='https'?https:name==='crypto'?require('node:crypto'):require('../server/partition')});
 return {request:module.exports.request,query:module.exports.query,get options(){return options;},get written(){return written;}};
}
test('WeChat POST includes the exact byte length instead of chunked request framing',async()=>{
 const p=platform({status:200,body:'{"errcode":0}'}),body=JSON.stringify({note:'中文',order_id:'test'});await p.request('/xpay/query_order?access_token=secret',body);
 assert.equal(p.options.headers['Content-Length'],Buffer.byteLength(body));assert.equal(p.written,body);
});
test('empty and invalid WeChat replies yield safe diagnostics without credentials',async()=>{
 for(const [response,code]of [[{status:200,body:''},'WECHAT_EMPTY_RESPONSE'],[{status:200,body:'not json'},'WECHAT_INVALID_RESPONSE'],[{status:411,body:''},'WECHAT_HTTP_ERROR']]){
  const p=platform(response);await assert.rejects(p.request('/xpay/query_order?access_token=must-not-leak','{}'),e=>e.code===code&&e.operation==='/xpay/query_order'&&!e.message.includes('must-not-leak'));
 }
});

test('platform hints expose only recognized fields and categories',async()=>{
 const p=platform({status:200,body:JSON.stringify({errcode:268490002,errmsg:'order_id not exist; access_token=private-token'})});
 await assert.rejects(p.request('/xpay/query_order?access_token=private-token','{}'),e=>e.platformCode===268490002&&e.platformDetail.fields.includes('order_id')&&e.platformDetail.reason==='not_found'&&!JSON.stringify(e).includes('private-token'));
});

test('an absent platform order is distinguished from other missing parameters',async()=>{
 const p=platform({status:200,body:JSON.stringify({errcode:268490002,errmsg:'order not found'})});
 await assert.rejects(p.request('/xpay/query_order','{}'),e=>e.platformDetail.fields.includes('order')&&e.platformDetail.reason==='not_found');
 const q=platform({status:200,body:JSON.stringify({errcode:268490002,errmsg:'offer_id not found'})});
 await assert.rejects(q.request('/xpay/query_order','{}'),e=>!e.platformDetail.fields.some(field=>['order','order_id','wx_order_id'].includes(field)));
});

test('query preserves a not-yet-created order as pending but rejects an invalid offer',async()=>{
 const token={status:200,body:JSON.stringify({access_token:'private-token',expires_in:7200})};
 const missingOrder=platform([token,{status:200,body:JSON.stringify({errcode:268490002,errmsg:'order not found'})}]);
 assert.equal(await missingOrder.query('test-user','local-order'),null);
 const invalidOffer=platform([token,{status:200,body:JSON.stringify({errcode:268490002,errmsg:'offer_id not found'})}]);
 await assert.rejects(invalidOffer.query('test-user','local-order'),e=>e.platformCode===268490002);
});

test('Chinese order-not-found responses preserve the unpaid order',async()=>{
 const p=platform([{status:200,body:JSON.stringify({access_token:'token',expires_in:7200})},{status:200,body:JSON.stringify({errcode:268490002,errmsg:'订单不存在'})}]);
 assert.equal(await p.query('test-user','local-order'),null);
});

test('legacy orderid spelling is still an order-specific not-found condition',async()=>{
 const p=platform([{status:200,body:JSON.stringify({access_token:'token',expires_in:7200})},{status:200,body:JSON.stringify({errcode:268490002,errmsg:'orderid not found'})}]);
 assert.equal(await p.query('test-user','local-order'),null);
});

test('the observed bare data-not-found response keeps a local unpaid order pending',async()=>{
 const token={status:200,body:JSON.stringify({access_token:'token',expires_in:7200})};
 const p=platform([token,{status:200,body:JSON.stringify({errcode:268490002,errmsg:'数据不存在 rid: test'})}]);
 assert.equal(await p.query('test-user','local-order'),null);
 const other=platform([token,{status:200,body:JSON.stringify({errcode:268490002,errmsg:'配置数据不存在'})}]);
 await assert.rejects(other.query('test-user','local-order'),e=>e.platformCode===268490002);
});
