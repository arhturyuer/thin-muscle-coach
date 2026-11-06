// Configure an encrypted JSON HTTP message-push endpoint. Never trust client-supplied xpay events.
const crypto = require('crypto'),
  {
    forStage,
    cloud,
    sourceVersion
  } = require('./lib/runtime'),
  b = require('./lib/business');

function safeEqual(a, c) {
  const x = Buffer.from(a || ''),
    y = Buffer.from(c || '');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function decode(event) {
  const q = event.queryStringParameters || {},
    token = process.env.MESSAGE_TOKEN,
    key = process.env.MESSAGE_AES_KEY;
  if (!token || !key) throw new Error('消息验签配置缺失');
  if (Math.abs(Date.now() / 1000 - Number(q.timestamp)) > 600) throw new Error('消息已过期');
  const body = typeof event.body === 'string' ? JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString() : event.body) : event.body;
  const encrypted = event.httpMethod === 'GET' ? q.echostr : body && body.Encrypt;
  if (!encrypted) throw new Error('仅接受加密消息');
  const sig = crypto.createHash('sha1').update([token, q.timestamp, q.nonce, encrypted].sort().join('')).digest('hex');
  if (!safeEqual(sig, q.msg_signature)) throw new Error('消息签名错误');
  const aes = Buffer.from(key + '=', 'base64'),
    decipher = crypto.createDecipheriv('aes-256-cbc', aes, aes.subarray(0, 16));
  decipher.setAutoPadding(false);
  let raw = Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64')), decipher.final()]);
  const pad = raw[raw.length - 1];
  if (pad < 1 || pad > 32 || !raw.subarray(raw.length - pad).every(x => x === pad)) throw new Error('消息填充错误');
  raw = raw.subarray(0, raw.length - pad);
  const len = raw.readUInt32BE(16);
  if (len > raw.length - 20) throw new Error('消息长度错误');
  if (raw.subarray(20 + len).toString() !== process.env.APP_ID) throw new Error('消息 AppID 错误');
  return raw.subarray(20, 20 + len).toString();
}
exports.decode = decode;
exports.main = async event => {
  try {
    if(!event.httpMethod){
      if(event.MsgType!=='event'||event.Event!=='xpay_goods_deliver_notify'||!/^bjt[0-9a-f]{24}$/.test(event.OutTradeNo||''))return {ErrCode:1,ErrMsg:'unsupported event'};
      // Do not trust client-provided paid flags, product IDs or identity fields.
      const response=await cloud.callFunction({name:'coach_test',data:{action:'payment.reconcile',orderId:event.OutTradeNo}});
      return response.result&&response.result.code===0&&response.result.data&&response.result.data.confirmed?{ErrCode:0,ErrMsg:'success'}:{ErrCode:1,ErrMsg:'payment not confirmed'};
    }
    const raw = decode(event);
    if (event.httpMethod === 'GET') return {
      statusCode: 200,
      headers: {
        'X-Coach-Stage': 'callback',
        'X-Coach-Version': sourceVersion
      },
      body: raw
    };
    const msg = JSON.parse(raw);
    const stage = require('./lib/partition').orderStage(msg.OutTradeNo);
    const {
      lookup,
      transact
    } = forStage(stage);
    const index = await lookup(msg.OutTradeNo);
    if (!index) throw new Error('订单尚未索引');
    if (msg.OpenId !== index.userId) throw new Error('订单身份错误');
    await transact(index.userId, s => {
      const o = s.orders.find(o => o.id === index.orderId);
      if (!o) throw new Error('订单不存在');
      if (o.redacted) return;
      if (msg.Event === 'xpay_goods_deliver_notify') {
        if (msg.GoodsInfo.ProductId !== (o.productId || process.env.PAY_PRODUCT_ID) || Number(msg.GoodsInfo.Quantity) !== 1 || !msg.WeChatPayInfo.MchOrderNo) throw new Error('商品信息错误');
        b.fulfill(s, o.id, msg.WeChatPayInfo.MchOrderNo);
      } else if (msg.Event === 'xpay_refund_notify') {
        if (Number(msg.RetCode) === 0 && msg.MchRefundId && msg.WxRefundId) b.refund(s, o.id, msg.WxRefundId);
      } else if (msg.Event === 'xpay_complaint_notify') {
        o.complaintAt = Date.now();
      } else throw new Error('未配置的支付通知类型');
    });
    return {
      statusCode: 200,
      headers: {
        'X-Coach-Stage': stage,
        'X-Coach-Version': sourceVersion
      },
      body: 'success'
    };
  } catch (e) {
    console.error('payment callback rejected', e.message);
    return {
      statusCode: 400,
      headers: {
        'X-Coach-Stage': 'callback',
        'X-Coach-Version': sourceVersion
      },
      body: 'rejected'
    };
  }
};
