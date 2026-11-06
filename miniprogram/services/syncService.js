const store = require('../core/store'),
  api = require('./api'),
  repo = require('./repository');
let timer, flight, boot, hasBootstrapped = false;

function schedule() {
  clearTimeout(timer);
  timer = setTimeout(async () => {
    const workout = require('./workout'), s = store.get();
    const affectsPlan = s.queue.some(workout.affectsPlan), meal=require('./meal-week'), mealChanged=s.queue.some(meal.affectsPlan);
    await flush();
    if (store.get().owner!==s.owner)return;
    if(mealChanged)void meal.ensure();
    if (affectsPlan) await workout.ensure();
  }, 30000);
}
async function bootstrap(force = false) {
  if (boot) return boot;
  if (!force && hasBootstrapped && Date.now() - store.get().lastBootstrap < 300000) return flush().then(()=>{void require('./meal-week').ensure();return require('./workout').ensure();});
  boot = (async () => {
    store.save({
      accountStatus: 'connecting'
    });
    try {
      const local = store.get();
      const r = await api.call('bootstrap', {
        cursor: local.revision,
        owner: local.owner
      });
      if((store.get().stepsEpoch||0)!==(local.stepsEpoch||0)||store.get().owner!==local.owner)return;
      store.identify(r.userId);
      repo.accept(r.state);
      const config = await resolveMedia(r.config);
      store.save({
        config,
        aiQuota:r.aiQuota||null,
        lastBootstrap: Date.now(),
        syncError: '',
        accountStatus: 'ready'
      });
      await require('./profile').refreshAvatar();
      hasBootstrapped = true;
      if (config.eventKeysSupported) repo.retryRejectedEvents();
      await flush();
      void require('./meal-week').ensure();
      await require('./workout').ensure();
    } catch (e) {
      store.save({
        syncError: e.message,
        accountStatus: store.get().owner === 'guest' ? 'error' : 'cached'
      });
    } finally {
      boot = null;
    }
  })();
  return boot;
}
async function flush() {
  if (flight) return flight;
  const s = store.get();
  if (!s.queue.length) return;
  if (s.owner === 'guest') {
    store.save({
      syncError: '连接账号后才能同步'
    });
    return;
  }
  if (!s.online) return;
  const batch = s.queue.slice(0, 30),
    owner = s.owner;
  store.save({
    syncing: true
  });
  flight = (async () => {
    try {
      const r = await api.call('sync.batch', {
        operations: batch,
        owner
      });
      if (store.get().owner !== owner) return;
      const current = store.get(),
        done = new Set(r.results.filter(x => x.status !== 'retry').map(x => x.id));
      const rejected = r.results.filter(x => x.status === 'conflict' || x.status === 'invalid');
      const failedKeys = new Set(rejected.map(x => batch.find(o => o.id === x.id).key));
      const acknowledgedKeys = new Set(r.results.filter(x => x.status === 'ok').map(x => x.key));
      const conflicts = [...current.conflicts.filter(c => !failedKeys.has(c.operation.key) && !acknowledgedKeys.has(c.operation.key)), ...rejected.map(x => ({
        operation: current.queue.find(o => o.key === batch.find(b => b.id === x.id).key) || batch.find(o => o.id === x.id),
        remote: x.remote || null,
        message: x.message || '',
        invalid: x.status === 'invalid'
      }))];
      // Keep edits made while this request was in flight. A newer local edit must use the acknowledged version.
      const queue = current.queue.filter(o => !done.has(o.id) && !failedKeys.has(o.key)).map(o => {
        const ack = r.results.find(x => x.key === o.key && x.status === 'ok');
        return ack ? {
          ...o,
          baseVersion: ack.version
        } : o;
      });
      store.save({
        queue,
        conflicts,
        syncError: r.results.some(x => x.status === 'invalid') ? '部分记录未被云端接受，已保留本机草稿，请在我的页面查看' : ''
      });
      repo.accept(r.state);
      await require('./profile').refreshAvatar();
      return batch.some(o => done.has(o.id));
    } catch (e) {
      store.save({
        syncError: e.message
      });
    } finally {
      flight = null;
      store.save({
        syncing: false
      });
      if (store.get().queue.length) schedule();
    }
  })().then(progress => {
    const current = store.get();
    // An older batch may have been in flight when the assessment was saved.
    if (progress && current.owner === owner && current.queue.some(op=>require('./workout').affectsPlan(op)||require('./meal-week').affectsPlan(op))) return flush();
  });
  return flight;
}
async function resolveMedia(config) {
  const cached = store.get().config;
  const same = JSON.stringify(config.media || {}) === JSON.stringify(cached.media || {});
  if (same && Date.now() - (cached.mediaFetchedAt || 0) < 3600000) return {
    ...config,
    mediaUrls: cached.mediaUrls,
    mediaFetchedAt: cached.mediaFetchedAt
  };
  const entries = Object.entries(config.media || {});
  if (!entries.length || !wx.cloud) return config;
  try {
    const r = await wx.cloud.getTempFileURL({
      fileList: entries.map(([, id]) => id)
    });
    const mediaUrls = {};
    entries.forEach(([name, id]) => {
      const found = r.fileList.find(x => x.fileID === id && x.status === 0);
      if (found) mediaUrls[name] = found.tempFileURL;
    });
    return {
      ...config,
      mediaUrls,
      mediaFetchedAt: Date.now()
    };
  } catch (e) {
    return {
      ...config,
      mediaUrls: {}
    };
  }
}
module.exports = {
  schedule,
  bootstrap,
  flush
};
