const manifest = require('./stages.json');

function partition(stage) {
  if (!Object.prototype.hasOwnProperty.call(manifest.stages, stage)) throw new Error('无效服务分区');
  return manifest.stages[stage];
}

function orderStage(id) {
  if (typeof id !== 'string') throw new Error('订单号格式错误');
  if (/^bjt[0-9a-f]{24}$/.test(id)) return 'test';
  if (/^bjp[0-9a-f]{24}$/.test(id) || /^bj[0-9a-f]{24}$/.test(id)) return 'prod';
  throw new Error('订单号格式错误');
}

function messageState(stage, configured = process.env.MESSAGE_STATE) {
  partition(stage);
  if (stage === 'test') return 'developer';
  if (configured === undefined || configured === '' || configured === 'formal') return 'formal';
  if (configured === 'trial') return 'trial';
  throw new Error('正式提醒仅支持 formal 或 trial');
}
module.exports = {
  partition,
  orderStage,
  messageState
};
