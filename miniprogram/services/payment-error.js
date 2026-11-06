// Native cashier errors may contain signed request data. Never display it verbatim.
function detail(error, payData = {}) {
  const reasons = [error && error.err_msg, error && error.errMsg, error && error.message]
    .filter(value => typeof value === 'string' && value.trim());
  if(reasons.some(value=>value.includes('IOS_ORDER_PRICE_TOO_LOW')))return '苹果支付单笔最低 ¥1，请使用最新联调版本（IOS_ORDER_PRICE_TOO_LOW）';
  const privateValues = [payData.signData, payData.paySig, payData.signature];
  try {
    const signed = JSON.parse(payData.signData || '{}');
    privateValues.push(signed.offerId, signed.outTradeNo, signed.attach);
  } catch (e) {}
  return [...new Set(reasons.map(value => {
    let text = value.slice(0, 2000);
    for (const secret of privateValues) if (typeof secret === 'string' && secret.length >= 4) text = text.split(secret).join('[已隐藏]');
    return text.replace(/requestVirtualPayment\s*:\s*fail\s*/gi, '')
      .replace(/https?:\/\/\S+/gi, '[链接已隐藏]')
      .replace(/(?:paySig|pay_sig|signature|session_key|access_token|openid|open_id|offerId|outTradeNo|attach|appkey|secret)\s*["']?\s*[:=]\s*["']?[^\s,;}"']+/gi, '[敏感参数已隐藏]')
      .replace(/[a-zA-Z0-9_+\/-]{24,}={0,2}/g, '[标识已隐藏]').trim();
  }).filter(Boolean))].join('；').slice(0, 220);
}
module.exports = { detail };
