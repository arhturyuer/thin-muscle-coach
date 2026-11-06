function install() {
  if (!wx.getUpdateManager) return;
  const manager = wx.getUpdateManager();
  manager.onUpdateReady(() => wx.showModal({
    title: '新版本已就绪',
    content: '你的训练进度已保存在本机。是否现在重启并更新？',
    confirmText: '立即更新',
    cancelText: '稍后再说',
    confirmColor: '#173E32',
    success: r => {
      if (r.confirm) manager.applyUpdate();
    }
  }));
  manager.onUpdateFailed(() => wx.showModal({
    title: '更新未完成',
    content: '你可以继续使用当前版本，下次打开时会重新尝试更新。',
    showCancel: false,
    confirmText: '知道了'
  }));
}
module.exports = {
  install
};
