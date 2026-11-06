const repo = require('./repository'),
  store = require('../core/store'),
  d = require('../shared/domain');

function track(name, key, durationMs) {
  const eventKey = 'event:' + name + ':' + (key || repo.id());
  if (store.get().records[eventKey]) return;
  try {
    repo.write('event', eventKey, {
      name,
      ...(Number.isFinite(durationMs)?{durationMs:Math.max(0,Math.min(d.DAY,durationMs))}:{}),
      at: Date.now(),
      date: d.localDate()
    });
  } catch (e) {
    /* Analytics never blocks the user flow. */
  }
}
module.exports = {
  track
};
