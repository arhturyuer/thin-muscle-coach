const page = require('../../core/page'),
  store = require('../../core/store'),
  repo = require('../../services/repository'),
  d = require('../../shared/domain');
page({
  ...require('../../services/meal-capture').methods,
  ...require('../../services/diet-view').methods,
  data: {
    calendarSlot:1,
    form: {
      nutrition: false,
      recovery: false,
      breakfast: '',
      lunch: '',
      dinner: ''
    }
  },
  onLoad(options = {}) {
    this.setData({date: options.date || d.localDate()});
    const s = store.get(), e = s.entitlement;
    const r = e && s.records[`daily:${e.id}:${this.data.date}`];
    const rows=e?require('../../shared/daily').meals(s.records,e.id,this.data.date):[];
    this.setData({form:{...this.data.form,...r?.value,...Object.fromEntries(rows.filter(x=>x.slot!=='snack').map(x=>[x.slot,x.text]))}});
  },
  onShow(){
    this._captureHidden=false;
    this.loadMealWeek(this.data.date);
    if(this._photoSavedSlot){
      const s=store.get(),slot=this._photoSavedSlot;
      this._photoSavedSlot='';
      if(!s.config.mealWeeksSupported&&s.entitlement&&this.data.date===d.localDate()&&slot!=='snack'){
        const row=require('../../shared/daily').meals(s.records,s.entitlement.id,this.data.date).find(meal=>meal.slot===slot);
        if(row)this.setData({['form.'+slot]:row.text});
      }
    }
  },
  onHide(){this._captureHidden=true;this.closePhotoProgress();},
  onUnload(){this._captureHidden=true;this.closePhotoProgress();},
  onPhotoSaved({slot}){this._photoSavedSlot=slot;},
  selectDate(e){this.setData({date:e.detail.date,dietEditing:null});this.render();this.loadMealWeek(this.data.date);},
  calendarChange(e){
    const next=e.detail.current, previous=this.data.calendarSlot;
    if(next===previous)return;
    const step=(next-previous+3)%3===1?7:-7,shift=require('../../services/dashboard').shift;
    this._weekStart=shift(this.data.calendar.anchor,step);
    this.setData({calendarSlot:next,date:shift(this.data.calendar.selected,step),dietEditing:null});
    this.render();this.loadMealWeek(this.data.date);
  },
  render() {
    const vm=this.data.vm, calendar=require('../../services/dashboard').calendar(vm,this.data.date||vm.date,this._weekStart,this.data.calendarSlot);
    const e=vm.entitlement, photoKey=e?`${e.id}:${calendar.selected}`:'';
    if(vm.config.mealWeeksSupported){
      const diet=require('../../services/diet-view').build(vm,calendar);
      const legacyPhotos=[...new Set(Object.entries(vm.mealPhotos||{}).filter(([key])=>key.endsWith(':'+calendar.selected)).flatMap(([,paths])=>paths))];
      this.setData({calendar,diet,detail:calendar.view,photos:legacyPhotos});
      this.refreshDietPhotos(diet,calendar.selected);
      return;
    }
    const daily=require('../../services/daily').view(vm,calendar.selected,calendar.view.task);
    this.setData({plannedMeals:daily.plannedMeals,mealPlan:daily.mealPlan,activityRows:daily.activities,mealRows:daily.meals,calendar,detail:calendar.view,photoKey,photos:(vm.mealPhotos||{})[photoKey]||[]});
  },
  editDietText(e){
    if(!this.data.diet?.canRecord)return;
    const slot=e.currentTarget.dataset.slot,row=require('../../shared/daily').mealsForDate(store.get().records,this.data.calendar.selected).find(x=>x.slot===slot);
    if(!row)return;
    this.setData({dietEditing:{slot,key:row.key,version:row.version,original:row.text,text:row.text}});
  },
  dietTextInput(e){this.setData({'dietEditing.text':e.detail.value});},
  closeDietText(){this.setData({dietEditing:null});},
  saveDietText(){return this.run(async()=>{
    const edit=this.data.dietEditing;
    if(!this.data.diet.canRecord||!edit)return;
    const row=require('../../shared/daily').mealsForDate(store.get().records,d.localDate()).find(x=>x.slot===edit.slot);
    if(row.key!==edit.key||row.version!==edit.version||row.text!==edit.original)throw new Error('记录已有变化，请重新打开编辑');
    if(edit.text.trim())require('../../services/daily').saveMeal({slot:edit.slot,text:edit.text,source:'edit'},'replace');
    else if(row.text)throw new Error('请填写实际吃的内容，或使用撤销');
    this.setData({dietEditing:null});await require('../../services/syncService').flush();
  });},
  byRecipe(event) {
    this.run(async()=>{
      if(!this.data.calendar.isToday||!this.data.detail.executable)return;
      const slot=event?.currentTarget?.dataset?.slot||'breakfast';
      const meal=this.data.mealRows.find(x=>x.slot===slot);if(!meal?.suggestion)return;
      const service=require('../../services/daily'),input={slot,text:meal.suggestion,source:'recipe'};
      let result=service.saveMeal(input);
      if(result.conflict){const choice=await wx.showActionSheet({itemList:['补充到原记录','替换这一餐']});result=service.saveMeal(input,choice.tapIndex===0?'append':'replace');}
      this.setData({['form.'+slot]:require('../../shared/daily').meals(store.get().records,store.get().entitlement.id,d.localDate()).find(x=>x.slot===slot).text});
      wx.showToast({title:'这一餐已记录，可在今日撤销',icon:'none'});
    });
  },
  previewPhoto(e) {
    wx.previewImage({current: e.currentTarget.dataset.src, urls: this.data.photos});
  },
  input(e) {
    this.setData({
      ['form.' + e.currentTarget.dataset.key]: e.detail.value
    });
  },
  toggle(e) {
    this.input(e);
  },
  save(e) {
    if (e && e.detail && e.detail.value) this.setData({
      form: {
        ...this.data.form,
        ...e.detail.value
      }
    });
    if (wx.hideKeyboard) wx.hideKeyboard();
    this.run(async () => {
      const s = store.get();
      if (this.data.date && this.data.date !== d.localDate()) throw new Error('仅可记录今日饮食');
      if (!d.active(s.entitlement)) throw new Error('挑战尚未开始或已经结束');
      const dailyService=require('../../services/daily');
      const existing=require('../../shared/daily').meals(s.records,s.entitlement.id,d.localDate());
      for(const slot of ['breakfast','lunch','dinner']) {
        const text=this.data.form[slot]||'',old=existing.find(x=>x.slot===slot);
        if(text!==old.text){if(text.trim())dailyService.saveMeal({slot,text,source:'edit'},'replace');else repo.write('meal',old.key,{planId:s.entitlement.id,date:d.localDate(),slot,text:'',source:'edit',previous:old.text,at:Date.now()});}
      }
      repo.write('daily', `daily:${s.entitlement.id}:${d.localDate()}`, {
        ...this.data.form,
        planId: s.entitlement.id,
        date: d.localDate()
      });
      require('../../services/analytics').track('nutrition_saved', s.entitlement.id + ':' + d.localDate());
      wx.showToast({
        title: '记录已保存',
        icon: 'success'
      });
    });
  }
});
