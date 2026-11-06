const fs = require('fs'),
  path = require('path');
const root = path.resolve(__dirname, '..'),
  config = require('../miniprogram/core/config'),
  app = require('../miniprogram/app.json');
const missing = [];
for (const [key, label] of Object.entries({
    cloudEnv: '微信云环境 ID'
  })) {
  if (typeof config[key] !== 'string' || !config[key].trim()) missing.push(label);
}
for (const route of app.pages) {
  const content = fs.readFileSync(path.join(root, 'miniprogram', route + '.wxml'), 'utf8');
  if (/开发模拟|开发预览|示例内容|BOJI|YOUR |DAY |JUST |READY\.|WELL/.test(content)) throw new Error('正式页面包含开发或英文占位文案：' + route);
}
if (fs.existsSync(path.join(root, 'miniprogram/services/demo.js'))) throw new Error('正式小程序不能打包模拟支付服务');
for (const item of app.tabBar.list)
  for (const field of ['iconPath', 'selectedIconPath']) {
    if (!item[field] || !fs.existsSync(path.join(root, 'miniprogram', item[field]))) throw new Error('原生导航栏图标缺失');
  }
const manifest = require('../server/stages.json'),
  build = require('./cloud-build');
const expected = {
  develop: 'test',
  trial: 'prod',
  release: 'prod'
};
if (Object.keys(manifest.versions).length !== 3 || Object.entries(expected).some(([key, value]) => manifest.versions[key] !== value)) throw new Error('版本映射不正确');
if (config.cloudEnv !== manifest.cloudEnv) throw new Error('云环境不一致');
for (const [stage, cfg] of Object.entries(manifest.stages)) {
  if (cfg.cachePrefix !== 'coach:' + stage + ':' || cfg.storagePrefix !== stage + '/') throw new Error('缓存或素材分区不正确');
  const expectedTables = stage === 'test' ? ['coach_test_accounts', 'coach_test_order_index'] : ['coach_accounts', 'coach_order_index'];
  if (cfg.accounts !== expectedTables[0] || cfg.orders !== expectedTables[1]) throw new Error('数据集合分区不正确');
  for (const entry of build.entries().filter(e => e.stage === stage)) {
    const meta = require('../cloudfunctions/' + entry.name + '/deployment.json');
    if (entry.name !== (entry.entry === 'coach' ? cfg.functionName : cfg.reminderFunction)) throw new Error('云函数映射不正确');
    if (meta.stage !== stage || meta.sourceVersion !== build.sourceVersion()) throw new Error('部署包版本不一致');
  }
}

const callback = require('../cloudfunctions/' + manifest.callbackFunction + '/deployment.json');
if (callback.stage !== 'callback' || callback.sourceVersion !== build.sourceVersion()) throw new Error('共享回调版本不一致');

if (missing.length) {
  console.error('尚不能提审，缺少正式配置：\n' + missing.map(x => '  - ' + x).join('\n'));
  process.exitCode = 1;
} else console.log('本地提审配置检查通过。云端支付、模板、内容审核与真机验收需按部署文档核验。');
