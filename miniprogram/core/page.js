const store = require('./store'),
  coach = require('../services/coach'),
  feedback = require('./feedback');

function page(options) {
  const show = options.onShow,
    hide = options.onHide,
    unload = options.onUnload;
  Page({
    ...options,
    onShow() {
      this.refresh();
      this.unsubscribe = store.subscribe(() => this.refresh());
      if (show) show.call(this);
    },
    refresh() {
      this.setData({
        vm: coach.snapshot()
      });
      if (options.render) options.render.call(this);
    },
    onHide() {
      if (this.unsubscribe) this.unsubscribe();
      if (hide) hide.call(this);
    },
    onUnload() {
      if (this.unsubscribe) this.unsubscribe();
      if (unload) unload.call(this);
    },
    go(e) {
      wx.navigateTo({
        url: '/pages/' + e.currentTarget.dataset.page + '/index'
      });
    },
    async onPullDownRefresh() {
      try {
        await this.run(async () => {
          await require('../services/syncService').bootstrap(true);
          if (store.get().syncError) throw new Error('暂时无法更新记录，请检查网络后重试。');
        });
      } finally {
        if (wx.stopPullDownRefresh) wx.stopPullDownRefresh();
      }
    },
    contactError() {
      feedback.showError(new Error('暂时无法打开微信客服，请稍后再试。'));
    },
    openPrivacyContract: feedback.openPrivacyContract,
    home() {
      wx.switchTab({
        url: '/pages/today/index'
      });
    },
    async run(fn) {
      if (this.data.busy) return;
      this.setData({
        busy: true
      });
      try {
        return await fn();
      } catch (e) {
        await feedback.showError(e);
      } finally {
        this.setData({
          busy: false
        });
      }
    }
  });
}
module.exports = page;
