const page = require('../../core/page');
const store = require('../../core/store');
const feedback = require('../../core/feedback');
const rules = require('../../shared/daily');
const nutrition = require('../../shared/nutrition');
const media = require('../../services/meal-photo');
const daily = require('../../services/daily');
const {checkDraft, analysisText} = require('../../services/meal-capture');
const saving = new Set();

const metrics = [
  {key: 'weightGrams', label: '克重', unit: '克'},
  {key: 'energyKcal', label: '热量', unit: '千卡'},
  {key: 'proteinGrams', label: '蛋白质', unit: '克'},
  {key: 'fatGrams', label: '脂肪', unit: '克'},
  {key: 'carbGrams', label: '碳水化合物', unit: '克'}
];
const fractions = [
  {value: 1, label: '全部'}, {value: 0.75, label: '四分之三'},
  {value: 0.5, label: '一半'}, {value: 0.25, label: '四分之一'}
];
const number = raw => /^\d*\.?\d+$|^\d+\.$/.test(raw) ? Number(raw) : NaN;

page({
  data: {
    mealSlots: rules.slots.map(slot => ({slot, label: rules.labels[slot]})),
    metrics, macroMetrics: metrics.slice(2), fractions, keyboardHeight: 0, scrollTarget: ''
  },
  onLoad() {
    this._opener = this.getOpenerEventChannel();
    this._opener.on('mealDraft', draft => {
      try {
        checkDraft(draft);
        this.setData({draft, titleInput: draft.analysis?.title || '',
          totals: nutrition.display(draft.analysis?.consumed)});
      } catch (error) {
        this.setData({pageError: error.message});
      }
    });
  },
  onUnload() {
    this._resultUnloaded = true;
  },
  render() {
    const draft = this.data.draft;
    if (!draft) return;
    try {
      checkDraft(draft);
    } catch (error) {
      this.setData({draft: null, titleInput: '', foodEdit: null, totals: null, pageError: error.message});
    }
  },
  canEdit() {
    const draft = this.data.draft;
    return !!draft && !this.data.busy && !draft.attempt && !saving.has(draft.requestId);
  },
  setDraft(draft) {
    this.checkResultDraft(draft);
    if (draft.weekly) store.save({mealPhotoDraft: draft});
    if (!this._resultUnloaded) this.setData({draft, totals: nutrition.display(draft.analysis?.consumed), saveError: ''});
  },
  checkResultDraft(draft) {
    checkDraft(draft);
    if (draft.weekly && store.get().mealPhotoDraft?.requestId !== draft.requestId) {
      throw new Error('餐照草稿已变化，请返回后重新打开');
    }
  },
  updateAnalysis(foods, consumedFraction, title = this.data.titleInput) {
    const analysis = nutrition.normalizeAnalysis({title: title.trim(), foods, consumedFraction});
    this.setDraft({...this.data.draft, analysis, text: analysisText(analysis)});
    return analysis;
  },
  titleInput(e) {
    if (!this.canEdit()) return;
    const title = e.detail.value;
    const {foods, consumedFraction} = this.data.draft.analysis;
    this.updateAnalysis(foods, consumedFraction, title);
    this.setData({titleInput: title});
  },
  manualInput(e) {
    if (this.canEdit()) this.setDraft({...this.data.draft, text: e.detail.value});
  },
  selectSlot(e) {
    const slot = e.currentTarget.dataset.slot;
    if (this.canEdit() && rules.slots.includes(slot)) this.setDraft({...this.data.draft, slot});
  },
  selectFraction(e) {
    if (!this.canEdit()) return;
    this.updateAnalysis(this.data.draft.analysis.foods, Number(e.currentTarget.dataset.value));
  },
  editFood(e) {
    if (!this.canEdit() || this.data.foodEdit) return;
    const foods = this.data.draft.analysis?.foods || [];
    const index = e.currentTarget.dataset.index == null ? foods.length : Number(e.currentTarget.dataset.index);
    if (!foods[index] && (index !== foods.length || foods.length >= 12)) return;
    this._foodBeforeEdit = foods[index] || {name: '', portion: '', confidence: 'low'};
    this._manualNutrients = new Set();
    const original = this._foodBeforeEdit;
    const values = Object.fromEntries(metrics.map(({key}) => [key, original[key] == null ? '' : String(original[key])]));
    this.setData({foodEdit: {index, name: original.name, values}, foodError: '', scrollTarget: 'food-editor'});
  },
  foodNameInput(e) {
    if (this.canEdit() && this.data.foodEdit) this.setData({'foodEdit.name': e.detail.value, foodError: ''});
  },
  foodValueInput(e) {
    const edit = this.data.foodEdit;
    if (!this.canEdit() || !edit) return;
    const key = e.currentTarget.dataset.key;
    if (!nutrition.fields.includes(key)) return;
    const raw = e.detail.value;
    const values = {...edit.values, [key]: raw};
    if (key === 'weightGrams') {
      const original = this._foodBeforeEdit;
      const weight = number(raw);
      if (raw === '' || Number.isFinite(weight)) {
        const scale = raw !== '' && original.weightGrams > 0 ? weight / original.weightGrams : 1;
        for (const field of nutrition.fields.slice(1)) {
          if (!this._manualNutrients.has(field) && original[field] != null) {
            values[field] = String(nutrition.round(original[field] * scale));
          }
        }
      }
    } else this._manualNutrients.add(key);
    this.setData({'foodEdit.values': values, foodError: ''});
  },
  commitFood() {
    const edit = this.data.foodEdit;
    if (!this.canEdit() || !edit) return;
    try {
      if (!edit.name.trim()) throw new Error('请填写食物名称');
      const food = {...this._foodBeforeEdit, name: edit.name};
      for (const {key, label} of metrics) {
        const raw = edit.values[key];
        food[key] = raw === '' ? null : number(raw);
        if (food[key] !== null && !Number.isFinite(food[key])) throw new Error('请输入有效的' + label);
      }
      const old = this.data.draft.analysis;
      const foods = [...(old?.foods || [])];
      foods[edit.index] = food;
      const analysis = this.updateAnalysis(foods, old?.consumedFraction ?? 1);
      if (!this.data.titleInput.trim()) this.setData({titleInput: analysis.title});
      this.cancelFood();
    } catch (error) {
      this.setData({foodError: error.message});
    }
  },
  cancelFood() {
    wx.hideKeyboard?.();
    this._foodBeforeEdit = null;
    this._manualNutrients = null;
    this.setData({foodEdit: null, foodError: '', scrollTarget: '', keyboardHeight: 0});
  },
  async removeFood(e) {
    if (!this.canEdit() || this.data.foodEdit) return;
    const draft = this.data.draft;
    const index = Number(e.currentTarget.dataset.index);
    const food = draft.analysis?.foods[index];
    if (!food) return;
    const {confirm} = await wx.showModal({title: '删除食物', content: '从本餐明细中删除「' + food.name + '」？', confirmColor: '#173E32'});
    if (!confirm || !this.canEdit() || draft !== this.data.draft) return;
    try {
      const foods = draft.analysis.foods.filter((_, i) => i !== index);
      if (foods.length) this.updateAnalysis(foods, draft.analysis.consumedFraction);
      else this.setDraft({...draft, text: '', analysis: null, manualEntry: true});
    } catch (error) {
      feedback.showError(error);
    }
  },
  fieldFocus(e) {
    this._focusedField = e.currentTarget.dataset.anchor;
    if (this.data.keyboardHeight) this.setData({scrollTarget: this._focusedField});
  },
  keyboardChange(e) {
    const keyboardHeight = e.detail.height || 0;
    this.setData({keyboardHeight, scrollTarget: keyboardHeight ? this._focusedField || '' : ''});
  },
  previewPhoto() {
    const src = this.data.draft?.src;
    if (src) wx.previewImage({current: src, urls: [src]});
  },
  savePhoto() {
    return this.run(async () => {
      const draft = this.data.draft;
      if (!draft || this.data.foodEdit || !rules.slots.includes(draft.slot) || !draft.text.trim()) return;
      if (saving.has(draft.requestId)) {
        this.setData({saveError: '正在保存这张照片，请稍后再试'});
        return;
      }
      wx.hideKeyboard?.();
      this.setData({saveError: ''});
      saving.add(draft.requestId);
      try {
        this.checkResultDraft(draft);
        let result;
        if (draft.weekly) {
          result = await media.save(draft, async () => {
            try {
              const {confirm} = await wx.showModal({
                title: '保存餐食与照片',
                content: '压缩照片会随这餐私有同步，可在登录同一账号的设备上查看。',
                confirmText: '确认保存', confirmColor: '#173E32'
              });
              return confirm;
            } catch {
              throw new Error('未能打开保存确认窗口，请重新点击保存');
            }
          }, next => this.setDraft(next));
          if (!result) return;
          if (store.get().mealPhotoDraft?.requestId === draft.requestId) store.save({mealPhotoDraft: null});
          require('../../services/analytics').track('meal_recorded', draft.requestId);
        } else {
          const input = {slot: draft.slot, text: draft.text, source: 'photo', analysis: draft.analysis};
          const ticket = {requestId: draft.requestId, date: draft.date, planId: draft.planId};
          result = daily.saveMeal(input, 'new', ticket);
          if (result.conflict) {
            const choice = await wx.showActionSheet({itemList: ['补充到这一餐', '替换这一餐']});
            checkDraft(draft);
            const row = rules.meals(store.get().records, draft.planId, draft.date).find(meal => meal.slot === draft.slot);
            if (row.key !== result.old.key || row.version !== result.old.version || row.text !== result.old.text) {
              throw new Error('该餐记录已有变化，请重新确认保存');
            }
            result = daily.saveMeal(input, choice.tapIndex === 0 ? 'append' : 'replace', ticket);
          }
        }
        if (draft.recognizedText && draft.text !== draft.recognizedText) require('../../services/analytics').track('photo_corrected');
        if (!this._resultUnloaded) {
          this._opener.emit('mealSaved', {key: result.key, slot: draft.slot});
          wx.navigateBack({success: () => wx.showToast({title: '这一餐已记录', icon: 'none'})});
        }
      } catch (error) {
        if (!this._resultUnloaded && !feedback.isCancel(error)) {
          const text = feedback.message(error, '餐照暂时无法保存，请稍后重试');
          this.setData({saveError: text.replace(/[。！!？?]+$/, '')});
        }
      } finally {
        saving.delete(draft.requestId);
      }
    });
  },
  discardPhoto() {
    return this.run(async () => {
      const draft = this.data.draft;
      if (!draft) return;
      if (saving.has(draft.requestId)) throw new Error('正在保存这张照片，请稍后再试');
      const {confirm} = await wx.showModal({
        title: '放弃这次记录', content: '本次未保存的修改将被丢弃。', confirmColor: '#173E32'
      });
      if (!confirm) return;
      this.checkResultDraft(draft);
      if (draft.weekly) {
        store.save({mealPhotoDraft: null});
        media.remove(draft.src);
        media.remove(draft.attempt?.file);
      }
      this.goBack();
    });
  },
  goBack() {
    wx.navigateBack({fail: () => wx.switchTab({url: '/pages/today/index'})});
  }
});
