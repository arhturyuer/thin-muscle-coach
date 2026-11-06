const {test}=require('node:test'),assert=require('node:assert/strict');
const {detail}=require('../miniprogram/services/payment-error');
test('the iOS minimum-price error gives an actionable explanation',()=>{
 assert.match(detail({err_msg:'IOS_ORDER_PRICE_TOO_LOW'}),/最低 ¥1/);
});
test('cashier parameter failure retains err_msg and strips signed payment data',()=>{
 const payData={signData:JSON.stringify({offerId:'123456789',outTradeNo:'bjt'+'a'.repeat(24),attach:'private-attach'}),paySig:'a'.repeat(64),signature:'b'.repeat(64)};
 const text=detail({err_msg:'goodsPrice invalid: 1',errMsg:'requestVirtualPayment:fail paySig='+payData.paySig+' signature='+payData.signature+' signData='+payData.signData},payData);
 assert.match(text,/goodsPrice invalid: 1/);for(const value of [payData.paySig,payData.signature,'123456789','private-attach'])assert.equal(text.includes(value),false);
});
test('cashier reasons are bounded and redact credentials, links and long identifiers',()=>{
 const text=detail({err_msg:'invalid parameter openid=private-user session_key=private-key https://private.example/path '+ 'a'.repeat(64)+' '+ 'x '.repeat(200)});
 assert.ok(text.length<=220);assert.equal(/private|a{24}/.test(text),false);
 assert.equal(detail({err_msg:{secret:'no'},errMsg:undefined}), '');
});
