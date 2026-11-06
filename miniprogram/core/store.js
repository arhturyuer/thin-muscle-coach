const domain = require('../shared/domain'),
  release = require('./release');
let state, selectedPrefix, owner = 'guest';
let listeners = [];

function select() {
  const prefix = release.cachePrefix();
  if (prefix === selectedPrefix) return;
  selectedPrefix = prefix;
  state = undefined;
  owner = 'guest';
  try {
    owner = wx.getStorageSync(prefix + 'owner') || 'guest';
  } catch (e) {}
}

function blank() {
  return {
    ...domain.initialState(),
    owner,
    queue: [],
    conflicts: [],
    draft: {},
    session: null,
    preview: null,
    lastBootstrap: 0,
    online: true,
    syncError: '',
    syncing: false,
    accountStatus: 'connecting',
    avatarDisplay: null,
    config: {
      paymentsEnabled: false,
      contentPublished: false,
      reminderTemplateId: ''
    }
  };
}

function read() {
  try {
    const saved = wx.getStorageSync(selectedPrefix + owner);
    return saved ? {
      ...saved,
      syncing: false,
      accountStatus: saved.owner === 'guest' ? 'connecting' : 'cached'
    } : blank();
  } catch (e) {
    return blank();
  }
}

function get() {
  select();
  if (!state) state = read();
  return state;
}

function save(patch) {
  state = {
    ...get(),
    ...patch
  };
  wx.setStorageSync(selectedPrefix + 'owner', owner);
  wx.setStorageSync(selectedPrefix + owner, state);
  listeners.forEach(fn => fn(state));
  return state;
}

function identify(id) {
  select();
  if (id === owner) return;
  const guest = get();
  owner = id;
  state = read();
  if (guest.owner === 'guest') {
    state.draft = guest.draft;
    state.assessmentStep = guest.assessmentStep;
    state.assessmentFlowVersion = guest.assessmentFlowVersion;
    state.preview = guest.preview;
    state.queue = guest.queue;
    state.records = {
      ...state.records,
      ...guest.records
    };
  }
  save({
    owner
  });
}

function clear() {
  select();
  wx.removeStorageSync(selectedPrefix + owner);
  const stepsEpoch=(state?.stepsEpoch||0)+1;
  state = blank();
  save({stepsEpoch});
}

function subscribe(fn) {
  listeners.push(fn);
  return () => {
    listeners = listeners.filter(f => f !== fn);
  };
}
module.exports = {
  get,
  save,
  identify,
  clear,
  subscribe
};
