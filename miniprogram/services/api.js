const config = require('../core/config'),
  release = require('../core/release');
async function call(action, data = {}) {
  const target = release.current();
  if (!config.cloudEnv || !wx.cloud) throw new Error('服务暂未开放，请稍后再试。');
  let result;
  try {
    result = await wx.cloud.callFunction({
      name: target.functionName,
      data: {
        ...data,
        action
      }
    });
  } catch (e) {
    if(target.stage==='test'){
      const labels={'bootstrap':'连接账号','sync.batch':'同步记录','purchase.create':'下单','purchase.status':'查单','plan.preview':'生成预览','plan.generate':'生成方案'};
      const raw=e&&(e.errCode??e.code),code=/^-?\d{1,12}$/.test(String(raw))?String(raw):'未知';
      const timeout=/timeout|timed out|time.limit|超时/i.test(String(e&&(e.errMsg||e.message)||''));
      const error=new Error('联调'+(labels[action]||'请求')+(timeout?'超时':'连接失败')+'（错误码 '+code+'）'+(action==='purchase.create'||action==='purchase.status'?'，请先到订单页查询，避免重复付款。':'，请稍后重试。'));
      error.code='TEST_TRANSPORT_ERROR';error.action=action;throw error;
    }
    const error=new Error('暂时无法连接服务，请检查网络后重试。');error.code='TRANSPORT_ERROR';throw error;
  }
  const r = result.result;
  if (release.stage() !== target.stage || !r || r.stage !== target.stage) throw new Error('服务版本不匹配，请重新打开小程序后重试。');
  if (r.code !== 0) {
    if (['INVALID', 'UNAUTHORIZED', 'ACCOUNT_CHANGED', 'MEMBERSHIP_REQUIRED', 'VERSION_CONFLICT', 'AI_UNAVAILABLE', 'QUOTA_EXCEEDED', 'PENDING', 'EXPIRED', 'PHOTO_STORAGE_FAILED', 'PHOTO_SAVE_FAILED', 'PAYMENT_LOGIN_EXPIRED', 'PAYMENT_PLATFORM_ERROR', 'PAYMENT_PREPARE_FAILED'].includes(r.code)) {const error=new Error(r.message);error.code=r.code;throw error;}
    if(target.stage==='test'){
      const labels={'bootstrap':'连接账号','sync.batch':'同步记录','purchase.create':'下单','purchase.status':'查单','plan.preview':'生成预览','plan.generate':'生成方案'};
      const raw=String(r.code);let hash=2166136261;for(let i=0;i<raw.length;i++)hash=Math.imul(hash^raw.charCodeAt(i),16777619);
      const diagnostic=/^-?\d{1,12}$/.test(raw)?raw:(hash>>>0).toString(16);
      const version=/^[a-f0-9]{16}$/.test(r.sourceVersion||'')?r.sourceVersion.slice(0,8):'未知';
      const error=new Error('联调'+(labels[action]||'请求')+'失败（编号 '+diagnostic+'，版本 '+version+'）');
      error.code='TEST_SERVICE_ERROR';error.action=action;throw error;
    }
    throw new Error('服务暂时不可用，请稍后重试。');
  }
  return r.data;
}
module.exports = {
  call
};
