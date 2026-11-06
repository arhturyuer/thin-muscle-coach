const page = require('../../core/page'),
  coach = require('../../services/coach'),
  d = require('../../shared/domain');
page({
  ...require('./actions'),
  ...require('../../services/diet-view').methods,
  onShareAppMessage() {
    return {
      title: '薄肌就是身材刚刚好',
      path: '/pages/today/index'
    };
  },
  onLoad() {
    this.updateNavigationMetrics();
  },
  updateNavigationMetrics() {
    const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync ? wx.getSystemInfoSync() : {};
    const statusBarHeight = info.statusBarHeight || 0;
    const capsule = wx.getMenuButtonBoundingClientRect ? wx.getMenuButtonBoundingClientRect() : null;
    const validCapsule = capsule && capsule.height > 0 && capsule.top >= statusBarHeight;
    const navigationHeight = validCapsule ? capsule.height + (capsule.top - statusBarHeight) * 2 : 44;
    const navigationSideWidth = validCapsule && capsule.left > 0 ? Math.max(80, (info.windowWidth || 375) - capsule.left + 8) : 96;
    this.setData({statusBarHeight,navigationHeight,navigationSideWidth,navigationTotalHeight:statusBarHeight + navigationHeight});
  },
  onShow() {
    this._captureHidden = false;
    this.loadWorkoutWeek();
    this.loadMealWeek(this.data.selectedDate||d.localDate());
    require('../../services/activity-steps').sync();
    this._guideVisible = true;
    require('../../services/analytics').track('home_viewed');
    this._recordQueue=require('../../core/store').get().dailyRecordQueue||[];
    if(this._recordQueue.length){const item=this._recordQueue[0];this.setData({recordPrompt:{...item,needsSlot:!item.slot},composerOpen:true});}
    else this.setData({recordPrompt:null});
    const pending=require('../../core/store').get().dailyInputPending;
    if(pending)this.setData({composerText:pending.text,composerOpen:true,panelDate:pending.date,panelPlan:pending.planId});
    this.scheduleGuideMeasure();
    if(this._savedMealPhoto){
      const {key,slot}=this._savedMealPhoto;
      this._savedMealPhoto=null;
      this.setData({composerOpen:false,keyboardHeight:0});
      this.showSaveNotice(key,require('../../shared/daily').labels[slot]);
    }
  },
  onReady() {
    this.scheduleGuideMeasure();
  },
  onHide() {
    this._captureHidden = true;
    this.closePhotoProgress();
    this._guideVisible = false;
    this.clearSaveNotice();
  },
  onUnload() {
    this._captureHidden = true;
    this.closePhotoProgress();
    this._guideVisible = false;
    this.clearSaveNotice();
  },
  onResize() {
    this.updateNavigationMetrics();
    this._guideMetrics = null;
    this.scheduleGuideMeasure();
  },
  onPageScroll(e) {
    this._guideScrollTop = e.scrollTop;
    this._guideScrollVersion = (this._guideScrollVersion || 0) + 1;
    if (this._guideMetrics) this.positionGuide();
    else this.scheduleGuideMeasure();
  },
  scheduleGuideMeasure() {
    if (!this.data.showGuide || this._guideVisible === false || this._guideMeasureQueued || !wx.createSelectorQuery) return;
    this._guideMeasureQueued = true;
    const measure = () => {
      this._guideMeasureQueued = false;
      if (!this.data.showGuide || this._guideVisible === false) return;
      const query = wx.createSelectorQuery();
      query.selectViewport().scrollOffset();
      query.select('.guide-anchor').boundingClientRect();
      const scrollVersion = this._guideScrollVersion || 0;
      query.exec(results => {
        if (!this.data.showGuide || this._guideVisible === false) return;
        const scroll = results[0], rect = results[1];
        if (!scroll || !rect || !rect.height) return;
        const windowInfo = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
        this._guideMetrics = {
          top: rect.top + scroll.scrollTop,
          height: rect.height,
          viewport: windowInfo.windowHeight,
          gap: this.data.navigationTotalHeight + windowInfo.windowWidth * 12 / 750
        };
        if (scrollVersion === (this._guideScrollVersion || 0)) this._guideScrollTop = scroll.scrollTop;
        const patch = {};
        if (this.data.guideLeft !== rect.left) patch.guideLeft = rect.left;
        if (this.data.guideWidth !== rect.width) patch.guideWidth = rect.width;
        if (Object.keys(patch).length) this.setData(patch);
        this.positionGuide();
      });
    };
    if (wx.nextTick) wx.nextTick(measure);
    else measure();
  },
  positionGuide() {
    if (!this.data.showGuide || !this._guideMetrics) return;
    const m = this._guideMetrics;
    const top = m.top - (this._guideScrollTop || 0);
    const dock = top < m.gap ? 'top' : top + m.height > m.viewport - m.gap ? 'bottom' : '';
    if (dock !== this.data.guideDock) this.setData({guideDock: dock});
  },
  data: {
    busy: false,
    lastSaved: null,
    saveNoticeProgress: 0,
    composerText:'', composerOpen:false, keyboardHeight:0, selectedMeal:'', showAllMeals:false,
    mealSlots:[{slot:'breakfast',label:'早餐'},{slot:'lunch',label:'午餐'},{slot:'dinner',label:'晚餐'},{slot:'snack',label:'加餐'}],
    selectedDate: '',
    dateTitle: '今日',
    statusBarHeight: 0,
    navigationHeight: 44,
    navigationTotalHeight: 44,
    navigationSideWidth: 96,
    calendarSlot: 1,
    showGuide: false,
    guideDock: '',
    guideLeft: 0,
    guideWidth: 0,
    photoIndex: 0,
    photos: [
      {src:'/assets/boji-life.jpg',alt:'男女居家训练后的自然薄肌状态'},
      {src:'/assets/boji-life-02.jpg',alt:'女性在家进行弹力带训练'},
      {src:'/assets/boji-life-03.jpg',alt:'男性居家训练后的自然肌肉线条'},
      {src:'/assets/boji-life-04.jpg',alt:'女性在公园轻松步行'},
      {src:'/assets/boji-life-05.jpg',alt:'男性在家进行基础力量练习'},
      {src:'/assets/boji-life-06.jpg',alt:'两位女性训练后的放松时刻'},
      {src:'/assets/boji-life-07.jpg',alt:'男女一起准备日常餐食'},
      {src:'/assets/boji-life-08.jpg',alt:'女性在家进行舒展活动'},
      {src:'/assets/boji-life-09.jpg',alt:'男性在家进行弹力带划船'},
      {src:'/assets/boji-life-10.jpg',alt:'男女在河畔轻松步行'}
    ]
  },
  stepsSettingsChanged(e){return require('../../services/activity-steps').settingsChanged(e.detail);},
  syncSteps(){return require('../../services/activity-steps').sync({connect:true,force:true});},
  photoChange(e) {
    this.setData({photoIndex: e.detail.current});
  },
  render() {
    const model = require('../../services/dashboard');
    const calendar = model.calendar(this.data.vm, this.data.selectedDate || this.data.vm.date, this._weekStart, this.data.calendarSlot);
    const dashboard = calendar.view;
    const showGuide = dashboard.guide;
    if (!showGuide) this._guideMetrics = null;
    const daily=require('../../services/daily').view(this.data.vm,calendar.selected,dashboard.task);
    const focusMeal=daily.meals.find(m=>m.slot===this.data.selectedMeal)||daily.meals.find(m=>m.current)||daily.meals[0];
    const reviewDue=!this.data.vm.nextAdjustmentConfirmed&&this.data.vm.isMember&&this.data.vm.day>=6&&require('../../core/store').get().dismissedReview!==this.data.vm.entitlement?.id;
    const lastSaved=this.data.vm.records[this.data.lastSaved?.key]?.value.date===this.data.vm.date?this.data.lastSaved:null;
    if(!lastSaved&&this.data.lastSaved)this.clearSaveNotice();
    const [, month, day] = calendar.selected.split('-');
    const dateTitle = calendar.isToday ? '今日' : `${Number(month)}月${Number(day)}日`;
    const workoutView=require('../../services/workout').view(this.data.vm,calendar.selected);
    const summary=require('../../services/today-summary').view(this.data.vm,calendar,daily,workoutView);
    const diet=this.data.vm.config?.mealWeeksSupported?summary.diet:null;
    this.setData({workoutView,summary,diet,lastSaved,daily,focusMeal,reviewDue,dashboard,calendar,dateTitle,showGuide,...(!showGuide ? {guideDock: ''} : {})});
    this.scheduleGuideMeasure();
    if(diet)this.refreshDietPhotos(diet,calendar.selected);
    const recipeKey=this.data.vm.entitlement?.id+':'+this.data.vm.date;
    if(!this.data.vm.config?.mealWeeksSupported&&calendar.isToday&&dashboard.executable&&this.data.vm.mealPlanConsent&&this.data.vm.config.aiEnabled&&dashboard.intake&&this.data.vm.online&&!daily.mealPlan&&this._recipeAttempt!==recipeKey){this._recipeAttempt=recipeKey;Promise.resolve().then(()=>this.ensureNutritionPlan());}
  },
  selectDate(e) {
    this.setData({selectedDate: e.detail?.date || e.currentTarget.dataset.date});
    this.render();
    this.loadWorkoutWeek();
    this.loadMealWeek(this.data.selectedDate||d.localDate());
  },
  calendarChange(e) {
    const next = e.detail.current, previous = this.data.calendarSlot;
    if (next === previous) return;
    const step = (next - previous + 3) % 3 === 1 ? 7 : -7;
    const shift = require('../../services/dashboard').shift;
    this._weekStart = shift(this.data.calendar.anchor, step);
    this.setData({calendarSlot:next, selectedDate:shift(this.data.calendar.selected,step)});
    this.render();
    this.loadWorkoutWeek();
    this.loadMealWeek(this.data.selectedDate||d.localDate());
  },
  backToday() {
    this._weekStart = null;
    this.setData({selectedDate:this.data.vm.date});
    this.render();
    this.loadWorkoutWeek();
    this.loadMealWeek(this.data.selectedDate||d.localDate());
  },
  loadWorkoutWeek(){
    const w=require('../../shared/workout'),date=this.data.selectedDate||d.localDate(),week=w.week(date);
    return require('../../services/workout').load(week.start,week.end).catch(error=>this.setData({workoutLoadError:error.message}));
  },
  retryWorkout(){return this.run(async()=>{await require('../../services/syncService').flush();await require('../../services/workout').ensure({retry:true});});},
  recordWorkout(){
    if(!this.data.workoutView.canRecord||this.data.workoutView.day?.rest)return;
    wx.navigateTo({url:'/pages/exercise-record/index?date='+this.data.calendar.selected});
  },
  openDataExplanation(){wx.navigateTo({url:'/pages/data-explanation/index?date='+this.data.calendar.selected});},
  stopExerciseTap(){},
  openExercise() {
    require('../../services/analytics').track('daily_detail_opened');
    wx.navigateTo({url: '/pages/exercise-detail/index?date=' + this.data.calendar.selected});
  },
  openNutrition() {
    require('../../services/analytics').track('daily_detail_opened');
    wx.navigateTo({url: '/pages/nutrition/index?date=' + this.data.calendar.selected});
  },
  activate() {
    this.run(async () => {
      if (!this.data.calendar.isToday) return;
      await coach.activate();
      this.refresh();
      if (this.data.dashboard.task && !this.data.dashboard.task.rest) {
        await coach.start();
        wx.navigateTo({url: '/pages/workout/index'});
      }
    });
  },
  start() {
    this.run(async () => {
      if (!this.data.calendar.isToday) return;
      if(this.data.dashboard.task?.rest){this.openNutrition();return;}
      await coach.start();
      wx.navigateTo({
        url: '/pages/workout/index'
      });
    });
  }
});
