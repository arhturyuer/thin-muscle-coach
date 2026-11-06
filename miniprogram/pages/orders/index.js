const page = require('../../core/page'),
  coach = require('../../services/coach'),
  api = require('../../services/api');
page({
  data: {
    busy: false
  },
  onShow(){return this.run(async()=>{
    await require('../../services/syncService').bootstrap(true);
    const s=require('../../core/store').get();
    if(!s.config.testCheckout)return;
    let issue;for(const order of s.orders.filter(o=>['pending','confirming'].includes(o.status)).slice(-3)){try{await coach.orderStatus(order.id);}catch(error){issue=error;}}
    if(issue)throw issue;
  });},
  query(e) {
    this.run(async () => {
      const r = await coach.orderStatus(e.currentTarget.dataset.id);
      if(r.status==='paid'&&this.data.vm.config.testCheckout){wx.redirectTo({url:'/pages/plan/index'});return;}
      wx.showToast({
        title: r.status === 'paid' ? '到账已确认' : '订单状态已更新',
        icon: 'none'
      });
    });
  },
  subscribe() {
    this.run(() => coach.reminder(true, this.data.vm.reminder.time));
  }
});
