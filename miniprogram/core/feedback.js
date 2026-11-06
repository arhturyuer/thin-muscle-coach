function isCancel(error) {
  return /cancel|用户取消/.test(error && (error.errMsg || error.message) || '');
}

function message(error, fallback = '暂时无法连接服务，请检查网络后重试。') {
  const text = error && error.message;
  if (!text || /cloud|database|openid|SECRET|AppKey|function|config\.js|errCode|网络请求.*fail/i.test(text)) return fallback;
  return text;
}

function showError(error) {
  if (isCancel(error)) return;
  const content = message(error);
  if (content.length <= 18) return wx.showToast({
    title: content,
    icon: 'none'
  });
  return wx.showModal({
    title: '操作未完成',
    content,
    showCancel: false,
    confirmText: '知道了',
    confirmColor: '#173E32'
  });
}

function openPrivacyContract() {
  if (!wx.openPrivacyContract) return wx.showModal({
    title: '微信版本较低',
    content: '请更新微信后查看平台隐私保护指引，也可在本页阅读数据使用说明。',
    showCancel: false,
    confirmText: '知道了'
  });
  wx.openPrivacyContract({
    fail: () => showError(new Error('暂时无法打开隐私保护指引，请稍后重试。'))
  });
}

function requirePrivacy() {
  if (!wx.requirePrivacyAuthorize) return Promise.resolve();
  return new Promise((resolve, reject) => wx.requirePrivacyAuthorize({
    success: resolve,
    fail: () => reject(new Error('请同意隐私保护指引后再保存评估。'))
  }));
}
module.exports = {
  isCancel,
  message,
  showError,
  openPrivacyContract,
  requirePrivacy
};
