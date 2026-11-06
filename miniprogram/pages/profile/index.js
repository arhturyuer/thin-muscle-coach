const page = require('../../core/page'),
  coach = require('../../services/coach'),
  store = require('../../core/store'),
  sync = require('../../services/syncService'),
  api = require('../../services/api'),
  repo = require('../../services/repository');
page({
  data: {
    busy: false,
    showArchive: false,
    defaultAvatar: require('../../services/profile').DEFAULT_AVATAR,
    avatarFailed: false,
    reminderEnabled: false,
    version: '1.0.0'
  },
  removePreference(e) { return this.run(async()=>{const key=e.currentTarget.dataset.key,row=store.get().records[key];if(row?.kind!=='preference')return;repo.write('preference',key,{...row.value,active:false,at:Date.now()});}); },
  toggleArchive() { this.setData({showArchive: !this.data.showArchive}); },
  avatarError() {
    this.setData({
      avatarFailed: true
    });
  },
  reconnect() {
    return this.run(async () => {
      await sync.bootstrap(true);
      if (store.get().accountStatus !== 'ready') throw new Error('暂时无法连接微信账号，请稍后再试');
      wx.showToast({
        title: '已连接'
      });
    });
  },
  render() {
    if (this.lastAvatar !== this.data.vm.avatarUrl) {
      this.lastAvatar = this.data.vm.avatarUrl;
      this.setData({
        avatarFailed: false
      });
    }
    const labels = {
      assessment: '评估',
      daily: '饮食记录',
      session: '训练记录',
      workoutRecord: '运动记录',
      measurement: '身体记录',
      event: '使用记录'
    };
    const dashboardProfile = require('../../services/dashboard').profile(this.data.vm);
    this.setData({
      archiveBasicFields: dashboardProfile.summaryFields.slice(0, 3),
      archiveSummaryFields: dashboardProfile.summaryFields.slice(3),
      savedPreferences:Object.entries(this.data.vm.records).filter(([,r])=>r.kind==='preference'&&r.value.active).map(([key,r])=>({key,text:r.value.text})),
      dashboardProfile,
      reminderEnabled: !!this.data.vm.reminder.enabled,
      conflicts: this.data.vm.conflicts.map(c => ({
        ...c,
        label: labels[c.operation.kind] || '个人记录'
      }))
    });
  },
  sync() {
    this.run(async () => {
      await sync.bootstrap(true);
      await sync.flush();
      if (store.get().syncError) throw new Error(store.get().syncError);
      wx.showToast({
        title: '备份已完成'
      });
    });
  },
  reminder(e) {
    this.setData({
      reminderEnabled: e.detail.value
    });
    return this.run(() => coach.reminder(e.detail.value, this.data.vm.reminder.time)).then(() => this.refresh());
  },
  time(e) {
    this.run(() => coach.reminder(this.data.vm.reminder.enabled, e.detail.value, {
      requestAuthorization: false
    }));
  },
  subscribe() {
    this.run(() => coach.reminder(true, this.data.vm.reminder.time));
  },
  resolve(e) {
    const index = Number(e.currentTarget.dataset.index);
    this.run(async () => {
      const conflict = store.get().conflicts[index];
      if (!conflict) return;
      let useLocal = false;
      if (conflict.invalid) {
        const choice = await wx.showModal({
          title: '记录暂时无法备份',
          content: conflict.message + '。草稿仍保存在本机，是否移除此草稿？',
          confirmText: '移除草稿'
        });
        if (!choice.confirm) return;
      } else {
        const choice = await wx.showActionSheet({
          itemList: ['保留其他设备的记录', '保留本机记录']
        });
        useLocal = choice.tapIndex === 1;
      }
      const currentIndex = store.get().conflicts.indexOf(conflict);
      if (currentIndex < 0) return;
      repo.resolve(currentIndex, useLocal);
      const workout = require('../../services/workout');
      const meal=require('../../services/meal-week');
      if (meal.affectsPlan(conflict.operation)){await sync.flush();void meal.ensure();}
      if (workout.affectsPlan(conflict.operation)) {
        await sync.flush();
        await workout.ensure();
      }
    });
  },
  notificationSettings() {
    this.run(() => wx.openSetting({
      withSubscriptions: true
    }));
  },
  remove() {
    this.run(async () => {
      const r = await wx.showModal({
        title: '删除个人数据？',
        content: '清理档案、训练、饮食、测量和提醒，并停止本轮训练权益。必要交易记录保留用于对账和售后。此操作不可撤销。',
        confirmText: '确认删除',
        confirmColor: '#923E35'
      });
      if (!r.confirm) return;
      await api.call('account.delete', {
        confirm: 'DELETE'
      });
      require('../../services/meal-photo').clearLocal(store.get());
      store.clear();
      wx.showToast({
        title: '个人数据已删除'
      });
    });
  }
});
