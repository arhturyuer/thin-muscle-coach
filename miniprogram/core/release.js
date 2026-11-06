const manifest = require('../shared/stages');

function stage() {
  try {
    const version = wx.getAccountInfoSync().miniProgram.envVersion;
    return Object.prototype.hasOwnProperty.call(manifest.versions, version) ? manifest.versions[version] : null;
  } catch (e) {
    return null;
  }
}

function current() {
  const name = stage();
  if (!name) throw new Error('暂时无法识别小程序版本，请重新打开或更新微信后重试。');
  return {
    stage: name,
    ...manifest.stages[name]
  };
}

function cachePrefix() {
  const name = stage();
  return name ? manifest.stages[name].cachePrefix : 'coach:unrecognized:';
}
module.exports = {
  stage,
  current,
  cachePrefix
};
