const page = require('../../core/page'),
  coach = require('../../services/coach'),
  store = require('../../core/store');
page({
  data: {
    feedback: false,
    level: 'unknown',
    discomfort: false,
    busy: false
  },
  onShow() {
    if (wx.enableAlertBeforeUnload && store.get().session) wx.enableAlertBeforeUnload({
      message: '训练进度已自动保存，返回后可继续。'
    });
    this.tick();
    this.timer = setInterval(() => this.tick(), 1000);
  },
  onHide() {
    clearInterval(this.timer);
    coach.pause();
  },
  onUnload() {
    if (wx.disableAlertBeforeUnload) wx.disableAlertBeforeUnload();
    clearInterval(this.timer);
    coach.pause();
  },
  render() {
    this.tick();
  },
  tick() {
    const s = store.get().session;
    if (!s) {
      this.setData({
        session: null
      });
      return;
    }
    const seconds = Math.floor(coach.elapsed(s) / 1000),
      total = s.task.exercises.reduce((n, x) => n + x.sets, 0);
    this.setData({
      session: s,
      move: s.task.exercises[s.exercise] ? {
        ...s.task.exercises[s.exercise],
        media: (store.get().config.mediaUrls || {})[s.task.exercises[s.exercise].id] || ''
      } : null,
      clock: String(Math.floor(seconds / 60)).padStart(2, '0') + ':' + String(seconds % 60).padStart(2, '0'),
      rest: Math.max(0, Math.ceil(((s.restUntil || 0) - Date.now()) / 1000)),
      progress: Math.round(s.completedSets / total * 100)
    });
  },
  mediaError() {
    this.setData({
      videoError: true
    });
  },
  next() {
    coach.next();
    this.setData({
      videoError: false
    });
  },
  toggle() {
    store.get().session.runningSince ? coach.pause() : coach.resume();
  },
  end() {
    coach.pause();
    return this.run(async () => {
      const result = await wx.showActionSheet({
        itemList: ['结束训练，保存已完成的部分', '只是暂停，稍后继续', '身体不适，停止训练']
      });
      if (result.tapIndex !== 1) this.setData({
        feedback: true,
        discomfort: result.tapIndex === 2
      });
    });
  },
  difficulty(e) {
    this.setData({
      level: e.detail.value
    });
  },
  discomfort(e) {
    if (e.detail.value) coach.pause();
    this.setData({
      discomfort: e.detail.value
    });
  },
  save(e) {
    if (e && e.detail && e.detail.value) this.setData({...e.detail.value,level:e.detail.value.level||'unknown'});
    this.run(async () => {
      await coach.finish(this.data.level, this.data.discomfort);
      if (wx.disableAlertBeforeUnload) wx.disableAlertBeforeUnload();
      wx.redirectTo({
        url: '/pages/report/index?finished=1'
      });
    });
  }
});
