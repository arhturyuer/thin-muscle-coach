const store = require('./core/store'),
  sync = require('./services/syncService'),
  config = require('./core/config');
App({
  onLaunch() {
    require('./core/updates').install();
    if (wx.cloud && config.cloudEnv) wx.cloud.init({
      env: config.cloudEnv,
      traceUser: false
    });
    store.get();
    require('./services/meal-photo').clearViewFiles();
    if (wx.getNetworkType) wx.getNetworkType({
      success: r => store.save({
        online: r.networkType !== 'none'
      })
    });
    wx.onNetworkStatusChange(r => {
      store.save({
        online: r.isConnected
      });
      if (r.isConnected) sync.bootstrap(true);
    });
  },
  onShow() {
    Promise.resolve(sync.bootstrap()).then(()=>require('./services/activity-steps').sync());
  },
  onHide() {
    require('./services/coach').pause();
    sync.flush();
  }
});
