const page = require('../../core/page'),
  repo = require('../../services/repository'),
  d = require('../../shared/domain');
page({
  data: {
    review:{difficulty:'',fatigue:'',hunger:''},
    reviewFields:[{key:'difficulty',title:'训练感觉',options:[{value:'easy',label:'轻松'},{value:'okay',label:'刚好'},{value:'hard',label:'吃力'}]},{key:'fatigue',title:'恢复与疲劳',options:[{value:'low',label:'精神充足'},{value:'okay',label:'一般'},{value:'high',label:'疲劳明显'}]},{key:'hunger',title:'饮食饥饿感',options:[{value:'low',label:'很少饿'},{value:'okay',label:'舒服'},{value:'high',label:'经常饿'}]}],
    allMeasurements: false,
    showMeasure: false,
    showHistory: false,
    weight: '',
    waist: ''
  },
  render() {
    const summary=require('../../shared/daily').summary(this.data.vm.records,this.data.vm.entitlement,this.data.vm.date);
    const saved=require('../../core/store').get().reviewDrafts?.[this.data.vm.entitlement?.id]||{};
    const samePlan=this._reviewPlan===this.data.vm.entitlement?.id;
    this._reviewPlan=this.data.vm.entitlement?.id;
    const entered={...saved,...Object.fromEntries(Object.entries(samePlan?this.data.review:{}).filter(([,value])=>value))};
    this.setData({summary,knownReview:summary.feedback,review:{...summary.feedback,...entered},growth: require('../../services/dashboard').growth(this.data.vm, this.data.allMeasurements)});
  },
  toggleRange() { this.setData({allMeasurements: !this.data.allMeasurements}); this.render(); },
  toggleMeasure() { this.setData({showMeasure: !this.data.showMeasure}); },
  toggleHistory() { this.setData({showHistory: !this.data.showHistory}); },
  reviewChange(e){this.setData({review:{...this.data.review,[e.currentTarget.dataset.key]:e.detail.value}});const store=require('../../core/store'),s=store.get();store.save({reviewDrafts:{...s.reviewDrafts,[s.entitlement.id]:this.data.review}});},
  reviewPlan(){this.run(async()=>{if(!['difficulty','fatigue','hunger'].every(k=>this.data.review[k])){wx.showToast({title:'可稍后补充，当前安排保持不变',icon:'none'});return;}await require('../../services/coach').review(this.data.review);require('../../services/analytics').track('review_submitted');});},
  confirmPlan(){this.run(async()=>{await require('../../services/coach').confirm();wx.showToast({title:'下周安排已确认',icon:'success'});});},
  weight(e) {
    this.setData({
      weight: e.detail.value
    });
  },
  waist(e) {
    this.setData({
      waist: e.detail.value
    });
  },
  measure(e) {
    const fields = e && e.detail && e.detail.value;
    if (fields) this.setData({
      weight: fields.weight,
      waist: fields.waist
    });
    if (wx.hideKeyboard) wx.hideKeyboard();
    this.run(async () => {
      repo.write('measurement', 'measurement:' + d.localDate(), {
        date: d.localDate(),
        weight: this.data.weight === '' ? null : Number(this.data.weight),
        waist: this.data.waist === '' ? null : Number(this.data.waist)
      });
      wx.showToast({
        title: '已保存',
        icon: 'success'
      });
    });
  }
});
