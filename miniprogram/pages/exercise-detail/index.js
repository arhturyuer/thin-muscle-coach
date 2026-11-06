const page = require('../../core/page');
const coach = require('../../services/coach');
const model = require('../../services/dashboard');
page({
  data: {date: '', busy: false,calendarSlot:1,loadError:''},
  onLoad(options = {}) { this.setData({date: options.date || ''}); },
  onShow(){return this.loadWeek();},
  loadWeek(){const w=require('../../shared/workout'),date=this.data.date||require('../../shared/domain').localDate(),week=w.week(date);return require('../../services/workout').load(week.start,week.end).catch(error=>this.setData({loadError:error.message}));},
  selectDate(e){this.setData({date:e.detail.date});this.render();this.loadWeek();},
  calendarChange(e){const next=e.detail.current,previous=this.data.calendarSlot;if(next===previous)return;const step=(next-previous+3)%3===1?7:-7;this._weekStart=model.shift(this.data.calendar.anchor,step);this.setData({calendarSlot:next,date:model.shift(this.data.calendar.selected,step)});this.render();this.loadWeek();},
  record(){if(this.data.workoutView.canRecord&&!this.data.workoutView.day.rest)wx.navigateTo({url:'/pages/exercise-record/index?date='+this.data.calendar.selected});},
  retry(){return this.run(()=>require('../../services/workout').ensure({retry:true}));},
  resumeTraining(){wx.navigateTo({url:'/pages/workout/index'});},
  render() {
    const calendar = model.calendar(this.data.vm, this.data.date || this.data.vm.date,this._weekStart,this.data.calendarSlot);
    this.setData({calendar, detail: calendar.view,workoutView:require('../../services/workout').view(this.data.vm,calendar.selected)});
  },
  start() {
    this.run(async () => {
      this.refresh();
      if (!this.data.calendar.isToday) {
        wx.showToast({title: this.data.calendar.isPast ? '仅可开始今日训练' : '请先完成今日训练', icon: 'none'});
        return;
      }
      if (!this.data.detail.task || this.data.detail.completed) return;
      if (this.data.detail.pending) await coach.activate();
      if (this.data.detail.task.rest) {
        wx.navigateTo({url: '/pages/nutrition/index'});
        return;
      }
      await coach.start();
      wx.navigateTo({url: '/pages/workout/index'});
    });
  }
});
