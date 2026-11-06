const page = require('../../core/page'),
  coach = require('../../services/coach');
page({
  onShow() {
    require('../../services/analytics').track('report_viewed', require('../../shared/domain').localDate());
  },
  subscribe() {
    this.run(() => coach.reminder(true, this.data.vm.reminder.time));
  }
});
