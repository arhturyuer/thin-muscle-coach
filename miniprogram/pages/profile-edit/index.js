const page = require('../../core/page'),
  store = require('../../core/store'),
  account = require('../../shared/account'),
  feedback = require('../../core/feedback'),
  profile = require('../../services/profile');
page({
  data: {
    nickname: '',
    avatarTemp: '',
    resetAvatar: false,
    avatarUrl: profile.DEFAULT_AVATAR,
    defaultAvatar: profile.DEFAULT_AVATAR,
    avatarFailed: false,
    baseVersion: 0,
    dirty: false,
    busy: false,
    supported: false,
    devtools: false,
    review: 'passed',
    error: ''
  },
  onLoad() {
    const current = store.get().profile || account.defaultProfile();
    this.original = {
      ...current
    };
    this.attempt = {};
    const supported = wx.canIUse && wx.canIUse('button.open-type.chooseAvatar') && wx.canIUse('input.type.nickname') && wx.canIUse('input.bindnicknamereview');
    const device = wx.getDeviceInfo ? wx.getDeviceInfo() : (wx.getSystemInfoSync ? wx.getSystemInfoSync() : {});
    this.setData({
      nickname: current.nickname,
      baseVersion: current.version,
      avatarUrl: store.get().avatarDisplay && store.get().avatarDisplay.fileId === current.avatarFileId ? store.get().avatarDisplay.url : profile.DEFAULT_AVATAR,
      supported: !!supported,
      devtools: device.platform === 'devtools'
    });
  },
  updateDirty() {
    const dirty = this.data.nickname !== this.original.nickname || !!this.data.avatarTemp || this.data.resetAvatar;
    this.setData({
      dirty
    });
    if (dirty && wx.enableAlertBeforeUnload) wx.enableAlertBeforeUnload({
      message: '资料尚未保存，离开将放弃本次修改。'
    });
    else if (wx.disableAlertBeforeUnload) wx.disableAlertBeforeUnload();
  },
  nickname(e) {
    const value = e.detail.value;
    if (value !== this.data.nickname) {
      this.setData({
        nickname: value,
        review: 'pending',
        error: ''
      });
      this.updateDirty();
    }
  },
  reviewed(e) {
    this.setData({
      review: e.detail.pass && !e.detail.timeout ? 'passed' : 'failed',
      error: e.detail.pass && !e.detail.timeout ? '' : '昵称检查未通过或已超时，请重新填写'
    });
  },
  chooseAvatar(e) {
    if (!e.detail.avatarUrl) return;
    this.attempt = {};
    this.setData({
      avatarTemp: e.detail.avatarUrl,
      resetAvatar: false,
      avatarUrl: e.detail.avatarUrl,
      avatarFailed: false,
      error: ''
    });
    this.updateDirty();
  },
  async pickAvatarInDevtools() {
    if (!this.data.devtools || this.data.busy) return;
    return this.run(async () => {
      await feedback.requirePrivacy();
      try {
        const result = await wx.chooseMedia({
          count: 1,
          mediaType: ['image'],
          sourceType: ['album'],
          sizeType: ['compressed']
        });
        const file = result.tempFiles && result.tempFiles[0];
        if (file && file.tempFilePath) this.chooseAvatar({detail: {avatarUrl: file.tempFilePath}});
      } catch (error) {
        if (!feedback.isCancel(error)) this.avatarPickerError({detail: error});
      }
    });
  },
  avatarPickerError(e) {
    const message = e.detail && e.detail.errMsg || '';
    if (/cancel|用户取消/i.test(message)) return;
    const undeclared = /scope.*declar/i.test(message);
    this.setData({
      error: undeclared && this.data.devtools
        ? '微信后台尚未声明图片选择用途，请在用户隐私保护指引中配置后重新编译。'
        : /privacy|scope.*declar|隐私/i.test(message)
          ? '头像选择暂不可用，隐私授权未完成，请稍后重试。'
          : '暂时无法打开头像选择，请在手机微信中重试，或更新微信后再试。'
    });
  },
  useDefaultAvatar() {
    this.attempt = {};
    this.setData({
      avatarTemp: '',
      resetAvatar: true,
      avatarUrl: profile.DEFAULT_AVATAR,
      avatarFailed: false
    });
    this.updateDirty();
  },
  avatarError() {
    this.setData({
      avatarFailed: true
    });
  },
  onUnload() {
    if (wx.disableAlertBeforeUnload) wx.disableAlertBeforeUnload();
  },
  async cancel() {
    if (this.data.busy) return;
    if (this.data.dirty) {
      const r = await wx.showModal({
        title: '放弃本次修改？',
        content: '已保存的头像和昵称不会改变。',
        confirmText: '放弃修改',
        cancelText: '继续编辑',
        confirmColor: '#173E32'
      });
      if (!r.confirm) return;
    }
    if (wx.disableAlertBeforeUnload) wx.disableAlertBeforeUnload();
    wx.navigateBack();
  },
  save(e) {
    if (e && e.detail && e.detail.value) this.nickname({
      detail: {
        value: e.detail.value.nickname
      }
    });
    return this.run(async () => {
      this.setData({
        error: ''
      });
      account.normalizeNickname(this.data.nickname);
      if (!this.data.supported) throw new Error('请更新微信后修改头像与昵称，现有账号仍可正常使用');
      // Clicking submit can blur the nickname field before its platform review callback arrives.
      for (let i = 0; i < 25 && this.data.review === 'pending'; i++) await new Promise(r => setTimeout(r, 200));
      if (this.data.review !== 'passed') throw new Error('昵称检查尚未通过，请稍后重试或重新填写');
      const draft = {
        nickname: this.data.nickname,
        avatarTemp: this.data.avatarTemp,
        resetAvatar: this.data.resetAvatar
      };
      let result = await profile.saveProfile(draft, this.data.baseVersion, this.attempt);
      if (result.status === 'conflict') {
        const choice = await wx.showModal({
          title: '资料在其他设备上已更新',
          content: '选择保留本机修改，或使用云端最新资料。',
          confirmText: '保留本机',
          cancelText: '使用云端',
          confirmColor: '#173E32'
        });
        if (choice.confirm) result = await profile.saveProfile(draft, result.profile.version, this.attempt);
        else {
          this.original = {
            ...result.profile
          };
          this.setData({
            nickname: result.profile.nickname,
            baseVersion: result.profile.version,
            resetAvatar: false,
            avatarTemp: '',
            resetAvatar: false,
            avatarUrl: store.get().avatarDisplay && store.get().avatarDisplay.url || profile.DEFAULT_AVATAR,
            review: 'passed'
          });
          this.updateDirty();
          return;
        }
      }
      if (result.status !== 'saved') throw new Error('资料又有更新，请重新保存');
      this.setData({
        dirty: false
      });
      if (wx.disableAlertBeforeUnload) wx.disableAlertBeforeUnload();
      wx.showToast({
        title: '资料已保存',
        icon: 'success'
      });
      wx.navigateBack();
    });
  }
});
