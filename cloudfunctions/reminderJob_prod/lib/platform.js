const https = require('https'),
  crypto = require('crypto');
let tokenCache;

function safePlatformHint(message,path,body){
  let text=String(message||'').slice(0,500);
  const values=Object.entries(process.env).filter(([key])=>/SECRET|TOKEN|KEY|APP_ID|PAY_OFFER_ID/.test(key)).map(([,value])=>value);
  for(const match of path.matchAll(/[?&](?:access_token|secret|js_code|pay_sig)=([^&]+)/g))values.push(decodeURIComponent(match[1]));
  try{const data=JSON.parse(body||'{}');for(const key of ['openid','order_id','wx_order_id'])if(data[key])values.push(data[key]);}catch(e){}
  for(const value of values)if(typeof value==='string'&&value.length>=4){text=text.split(value).join('[redacted]');text=text.split(encodeURIComponent(value)).join('[redacted]');}
  return text.replace(/https?:\/\/\S+/g,'[URL]').replace(/(access_token|session_key|secret|appkey|pay_sig|signature)\s*[=:]\s*[^\s,;]+/gi,'$1=[redacted]').slice(0,180);
}
function request(path, body) {
  const operation=path.split('?')[0];
  const failure=(code,message,status)=>Object.assign(new Error(message),{code,operation,httpStatus:status});
  return new Promise((resolve, reject) => {
    const req = https.request('https://api.weixin.qq.com' + path, {
      method: body ? 'POST' : 'GET',
      headers: body ? {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      } : {}
    }, res => {
      let data = '';
      res.on('data', chunk => {
        data += chunk;
        if (data.length > 1000000) req.destroy(failure('WECHAT_RESPONSE_TOO_LARGE','微信响应过大',res.statusCode));
      });
      res.on('error',()=>reject(failure('WECHAT_RESPONSE_INTERRUPTED','微信响应中断',res.statusCode)));
      res.on('end', () => {
        if(res.statusCode>=400)return reject(failure('WECHAT_HTTP_ERROR','微信接口请求失败（HTTP '+res.statusCode+'）',res.statusCode));
        if(!data.trim())return reject(failure('WECHAT_EMPTY_RESPONSE','微信接口返回空响应，请稍后重试',res.statusCode));
        let r;try{r=JSON.parse(data);}catch(e){return reject(failure('WECHAT_INVALID_RESPONSE','微信接口响应格式异常',res.statusCode));}
        if(r&&r.errcode){
          const error=failure('WECHAT_PLATFORM_ERROR','微信接口错误 '+Number(r.errcode),res.statusCode);
          error.platformCode=Number(r.errcode);
          const hint=String(r.errmsg||'').toLowerCase();
          // Whitelisted semantics only; never copy a response containing credentials.
          error.platformDetail={fields:['order_id','wx_order_id','order','openid','env','offer_id','product_id'].filter(field=>new RegExp('\\b'+field+'\\b').test(hint)),hint:safePlatformHint(r.errmsg,path,body),reason:/not exist|not found|不存在/.test(hint)?'not_found':/required|missing|empty|不能为空|缺少/.test(hint)?'missing':/invalid|不合法|无效/.test(hint)?'invalid':'other'};
          if(/订单|单号|\borderid\b|\bouttradeno\b|\bout_trade_no\b/.test(hint)&&!error.platformDetail.fields.includes('order'))error.platformDetail.fields.push('order');
          reject(error);
        }else resolve(r);
      });
    });
    req.setTimeout(10000, () => req.destroy(failure('WECHAT_REQUEST_TIMEOUT','微信接口超时')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
async function accessToken() {
  if (tokenCache && tokenCache.until > Date.now()) return tokenCache.value;
  const r = await request('/cgi-bin/token?grant_type=client_credential&appid=' + encodeURIComponent(process.env.APP_ID) + '&secret=' + encodeURIComponent(process.env.APP_SECRET));
  if (!r||!r.access_token) throw Object.assign(new Error('无法取得平台访问凭证'),{code:'WECHAT_TOKEN_MISSING',operation:'/cgi-bin/token'});
  tokenCache = {
    value: r.access_token,
    until: Date.now() + (r.expires_in - 120) * 1000
  };
  return r.access_token;
}
async function payData(openid, order, code) {
  const r = await request('/sns/jscode2session?appid=' + encodeURIComponent(process.env.APP_ID) + '&secret=' + encodeURIComponent(process.env.APP_SECRET) + '&js_code=' + encodeURIComponent(code) + '&grant_type=authorization_code');
  if (r.openid !== openid || !r.session_key) {const error=new Error('支付登录状态已变化，请重新发起购买');error.code='PAYMENT_LOGIN_EXPIRED';throw error;}
  const signData = JSON.stringify({
    offerId: process.env.PAY_OFFER_ID,
    buyQuantity: 1,
    env: 0,
    currencyType: 'CNY',
    productId: order.productId || process.env.PAY_PRODUCT_ID,
    goodsPrice: order.amount,
    outTradeNo: order.id,
    attach: order.id
  });
  return {
    mode: 'short_series_goods',
    signData,
    paySig: crypto.createHmac('sha256', process.env.PAY_APP_KEY).update('requestVirtualPayment&' + signData).digest('hex'),
    signature: crypto.createHmac('sha256', r.session_key).update(signData).digest('hex')
  };
}
async function query(openid, orderId) {
  const body = JSON.stringify({
      openid,
      env: 0,
      order_id: orderId
    }),
    sig = crypto.createHmac('sha256', process.env.PAY_APP_KEY).update('/xpay/query_order&' + body).digest('hex');
  try {
    const r = await request('/xpay/query_order?access_token=' + encodeURIComponent(await accessToken()) + '&pay_sig=' + sig, body);
    if(!r||!r.order||typeof r.order!=='object'||!Number.isInteger(r.order.status)){
      const error=Object.assign(new Error('微信查单响应结构异常'),{code:'PAYMENT_QUERY_SHAPE',operation:'/xpay/query_order',responseFields:r&&typeof r==='object'?Object.keys(r).filter(k=>/^[a-zA-Z_]{1,40}$/.test(k)).slice(0,12):[],orderType:typeof (r&&r.order),orderFields:r&&r.order&&typeof r.order==='object'?Object.keys(r.order).filter(k=>/^[a-zA-Z_]{1,40}$/.test(k)).slice(0,15):[]});
      throw error;
    }
    return r.order;
  }catch(error){
    const detail=error.platformDetail;
    if(error.platformCode===268490002&&detail&&detail.reason==='not_found'&&(detail.fields.some(field=>['order','order_id','wx_order_id'].includes(field))||detail.fields.length===0&&/^数据不存在(?:\s|$)/.test(detail.hint||'')))return null;
    throw error;
  }
}
async function acknowledgeDelivery(orderId){
  const body=JSON.stringify({order_id:orderId,env:0});
  const sig=crypto.createHmac('sha256',process.env.PAY_APP_KEY).update('/xpay/notify_provide_goods&'+body).digest('hex');
  return request('/xpay/notify_provide_goods?access_token='+encodeURIComponent(await accessToken())+'&pay_sig='+sig,body);
}
async function send(openid, task, stage) {
  const mapping = JSON.parse(process.env.REMINDER_FIELD_MAP || '{}');
  if (!mapping.title || !mapping.description) throw new Error('请配置审核模板字段映射');
  const data = {};
  data[mapping.title] = {
    value: task.title
  };
  data[mapping.description] = {
    value: task.description
  };
  return request('/cgi-bin/message/subscribe/send?access_token=' + encodeURIComponent(await accessToken()), JSON.stringify({
    touser: openid,
    template_id: process.env.REMINDER_TEMPLATE_ID,
    page: task.report ? 'pages/report/index' : 'pages/today/index',
    data,
    miniprogram_state: require('./partition').messageState(stage),
    lang: 'zh_CN'
  }));
}
module.exports = {
  messageState: require('./partition').messageState,
  request,
  payData,
  query,
  acknowledgeDelivery,
  send
};
