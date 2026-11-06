const store = require('../core/store');
const d = require('../shared/domain');
const rules = require('../shared/daily');
const nutrition = require('../shared/nutrition');
const repo = require('./repository');
const daily = require('./daily');
const media = require('./meal-photo');
const feedback = require('../core/feedback');

function checkDraft(draft) {
  const s = store.get();
  if (media.identity(s) !== draft.owner || draft.date !== d.localDate() ||
      !!s.config.mealWeeksSupported !== draft.weekly ||
      (!draft.weekly && s.entitlement?.id !== draft.planId)) {
    throw new Error('账号、日期或计划已变化，请重新记录');
  }
}

function analysisText(analysis) {
  const foods = analysis.foods.map(food => food.name +
    (food.weightGrams == null ? '（重量待确认）' : ' ' + food.weightGrams + '克'));
  return analysis.title + '：' + foods.join('、') + '；实际进食 ' +
    Math.round(analysis.consumedFraction * 100) + '%';
}

const methods = {
  takeDailyPhoto(event = {}) {
    return this.run(async () => {
      const s = store.get();
      const weekly = !!s.config.mealWeeksSupported;
      const date = d.localDate();
      const owner = media.identity(s);
      if (!this.data.calendar?.isToday) throw new Error('请回到今天记录饮食');
      if (weekly && !media.canCapture(s, date)) throw new Error('餐照同步暂不可用');
      if (!weekly) daily.current();

      const savedDraft = s.mealPhotoDraft;
      if (weekly && savedDraft?.owner === owner) {
        if (savedDraft.date === date) {
          this._captureDraft = savedDraft;
          if (savedDraft.analysis || savedDraft.text || savedDraft.attempt || savedDraft.manualEntry) await this.openPhotoResult(savedDraft);
          else if (savedDraft.recognitionError) {
            this.setData({photoProgress: 'failed', photoError: savedDraft.recognitionError});
          } else await this.analyzeDailyPhoto(savedDraft, true);
          return;
        }
        media.remove(savedDraft.src);
        media.remove(savedDraft.attempt?.file);
        store.save({mealPhotoDraft: null});
      }
      if (this.data.recordPrompt || (!weekly && s.dailyRecordQueue?.length)) {
        throw new Error('请先完成或取消当前记录');
      }
      const planId = weekly ? rules.dietScope(date) : s.entitlement.id;
      const draft = {slot: '', text: '', analysis: null, date, planId, owner, weekly, requestId: repo.id()};

      await feedback.requirePrivacy();
      checkDraft(draft);
      const existingSrc = event.existingSrc || event.currentTarget?.dataset?.src;
      if (existingSrc) draft.src = existingSrc;
      else {
        const source = event.currentTarget?.dataset?.source === 'album' ? 'album' : 'camera';
        const selection = await wx.chooseMedia({count: 1, mediaType: ['image'], sourceType: [source]});
        const file = selection.tempFiles?.[0]?.tempFilePath;
        if (!file) return;
        checkDraft(draft);
        try {
          draft.src = (await wx.saveFile({tempFilePath: file})).savedFilePath;
        } catch {
          throw new Error('无法在本机保留这张照片，请检查可用存储空间后重试');
        }
      }
      try {
        checkDraft(draft);
        if (weekly) store.save({mealPhotoDraft: draft});
        else if (!existingSrc) {
          const latest = store.get(), key = planId + ':' + date;
          const photos = latest.mealPhotos?.[key] || [];
          if (photos.length >= 9) throw new Error('当日最多保存九张照片');
          store.save({mealPhotos: {...latest.mealPhotos, [key]: [...photos, draft.src]}});
        }
      } catch (error) {
        if (!existingSrc) media.remove(draft.src);
        throw error;
      }
      if (!store.get().config.mealRecognitionEnabled) await this.openPhotoResult(draft);
      else await this.analyzeDailyPhoto(draft);
    });
  },
  importDietPhoto() {
    return this.takeDailyPhoto({currentTarget: {dataset: {source: 'album'}}});
  },
  async analyzeDailyPhoto(draft, resume = false) {
    if (this._captureHidden) return;
    const flow = {};
    this._photoFlow = flow;
    this._captureDraft = draft;
    this.setData({photoProgress: 'preparing', photoError: ''});
    const check = () => {
      if (this._photoFlow !== flow) throw new Error('识别页面已关闭');
      checkDraft(draft);
    };
    try {
      const result = await require('./meal-ai').recognize(draft.src, {
        requestId: draft.requestId,
        date: draft.date,
        ...(draft.weekly ? {planId: draft.planId} : {})
      }, {check, resume, onProgress: photoProgress => this.setData({photoProgress})});
      check();
      this.setData({photoProgress: 'finishing'});
      if (!result?.foods?.length) {
        // A completed empty result is cached by the server. An explicit retry needs a new ticket.
        draft = {...draft, requestId: repo.id()};
        throw new Error('未识别到清晰食物，可以重试或手动填写。');
      }
      const analysis = nutrition.normalizeAnalysis(result);
      const text = analysisText(analysis);
      draft = {...draft, analysis, text, recognizedText: text, recognitionError: ''};
      if (draft.weekly) store.save({mealPhotoDraft: draft});
      this._captureDraft = draft;
      await this.openPhotoResult(draft);
    } catch (error) {
      if (this._photoFlow !== flow) return;
      if (error.code === 'PHOTO_RECOGNITION_EXPIRED') draft = {...draft, requestId: repo.id()};
      const message = feedback.message(error, '照片暂时无法识别，可以重试或手动填写。');
      try {
        checkDraft(draft);
        this._captureDraft = {...draft, recognitionError: message};
        if (draft.weekly) store.save({mealPhotoDraft: this._captureDraft});
        this.setData({photoProgress: 'failed', photoError: message});
      } catch {
        this.closePhotoProgress();
        throw error;
      }
    } finally {
      if (this._photoFlow === flow) this._photoFlow = null;
    }
  },
  retryDailyPhoto() {
    return this.run(async () => {
      const draft = this._captureDraft;
      if (!draft || !this.data.calendar?.isToday) return;
      checkDraft(draft);
      if (draft.analysis) await this.openPhotoResult(draft);
      else await this.analyzeDailyPhoto(draft, true);
    });
  },
  manualPhoto() {
    return this.run(async () => {
      if (!this._captureDraft || !this.data.calendar?.isToday) return;
      const draft = {...this._captureDraft, manualEntry: true};
      checkDraft(draft);
      if (draft.weekly) store.save({mealPhotoDraft: draft});
      await this.openPhotoResult(draft);
    });
  },
  stopPhotoScroll() {},
  closePhotoProgress() {
    this._photoFlow = null;
    this._captureDraft = null;
    this.setData({photoProgress: '', photoError: ''});
  },
  openPhotoResult(draft) {
    checkDraft(draft);
    if (this._captureHidden || !this.data.calendar?.isToday) return;
    return new Promise((resolve, reject) => {
      wx.navigateTo({
        url: '/pages/meal-result/index',
        events: {mealSaved: result => this.onPhotoSaved?.(result)},
        success: ({eventChannel}) => {
          this.closePhotoProgress();
          eventChannel.emit('mealDraft', draft);
          resolve();
        },
        fail: reject
      });
    });
  },
  undoDietMeal(e) {
    return this.run(async () => {
      if (!this.data.calendar?.isToday) return;
      daily.undoMeal(e.currentTarget.dataset.key);
      await require('./syncService').flush();
    });
  }
};

module.exports = {methods, checkDraft, analysisText};
