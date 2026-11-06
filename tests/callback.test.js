const {
  test
} = require('node:test'), assert = require('node:assert/strict'), {
  fixture
} = require('./fixtures/payment-notify');
test('encrypted payment payload validates signature, decrypts and binds AppID', () => {
  const f = fixture(),
    text = JSON.stringify({
      Event: 'xpay_goods_deliver_notify',
      OutTradeNo: 'order1'
    });
  assert.equal(f.decode(f.event(text)), text);
  assert.throws(() => f.decode(f.event(text, 'different-app')), /AppID/);
});
test('tampered, plaintext and expired webhook payloads are rejected', () => {
  const f = fixture();
  const e = f.event('{}');
  e.queryStringParameters.msg_signature = 'forged';
  assert.throws(() => f.decode(e), /签名/);
  assert.throws(() => f.decode({
    httpMethod: 'POST',
    queryStringParameters: {
      timestamp: String(Date.now() / 1000)
    },
    body: {
      Event: 'xpay_goods_deliver_notify'
    }
  }), /加密/);
  const old = f.event('{}');
  old.queryStringParameters.timestamp = '1';
  assert.throws(() => f.decode(old), /过期/);
});

test('native test delivery hints require independent WeChat confirmation',async()=>{
 let request;const f=fixture({cloud:{callFunction:async input=>{request=input;return {result:{code:0,data:{confirmed:false}}};}}});
 const event={MsgType:'event',Event:'xpay_goods_deliver_notify',OutTradeNo:'bjt'+'a'.repeat(24),paid:true};
 assert.equal((await f.main(event)).ErrCode,1);assert.equal(request.name,'coach_test');assert.equal(request.data.action,'payment.reconcile');assert.equal('paid' in request.data,false);
});
test('native delivery acknowledges a verified test payment and leaves production routing closed',async()=>{
 const f=fixture({cloud:{callFunction:async()=>({result:{code:0,data:{confirmed:true}}})}});
 assert.equal((await f.main({MsgType:'event',Event:'xpay_goods_deliver_notify',OutTradeNo:'bjt'+'a'.repeat(24)})).ErrCode,0);
 assert.equal((await f.main({MsgType:'event',Event:'xpay_goods_deliver_notify',OutTradeNo:'bjp'+'a'.repeat(24)})).ErrCode,1);
});
