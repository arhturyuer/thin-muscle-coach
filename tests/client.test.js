const {
  test,
  beforeEach,
  afterEach
} = require('node:test'), assert = require('node:assert/strict'), fs = require('fs');
const {
  service,
  loadPage
} = require('./fixtures/mini-runtime');
let storage, originalTimer;

function reset() {
  for (const p of Object.keys(require.cache))
    if (p.includes('/miniprogram/')) delete require.cache[p];
}
beforeEach(() => {
  storage = new Map();
  originalTimer = global.setTimeout;
  global.setTimeout = (fn, ms) => {
    const t = originalTimer(fn, ms);
    t.unref();
    return t;
  };
  global.wx = {
    getStorageSync: k => storage.get(k),
    setStorageSync: (k, v) => storage.set(k, JSON.parse(JSON.stringify(v))),
    removeStorageSync: k => storage.delete(k),
    showToast: async () => {},
    showModal: async () => ({
      confirm: true
    }),
    hideKeyboard() {},
    pageScrollTo() {},
    getAccountInfoSync: () => ({
      miniProgram: {
        envVersion: 'release'
      }
    })
  };
  reset();
});
afterEach(() => {
  global.setTimeout = originalTimer;
  delete global.wx;
  delete global.Page;
  reset();
});

function connect(backend) {
  require('../miniprogram/core/config').cloudEnv = 'test';
  wx.cloud = {
    callFunction: async ({
      data
    }) => ({
      result: {
        code: 0,
        stage: 'prod',
        data: await backend.invoke(data.action, data)
      }
    })
  };
  wx.login = async () => ({
    code: 'native-code'
  });
  wx.getSystemInfoSync = () => ({
    system: 'Android',
    version: '8.0.68'
  });
}
const form = {
  age: 28,
  goal: 'habit',
  experience: 'beginner',
  minutes: 15,
  equipment: 'none',
  screening: 'clear',
  consent: true
};
test('cached account restores on restart and another account remains isolated', () => {
  let s = require('../miniprogram/core/store');
  s.identify('user-a');
  s.save({
    draft: {
      age: 28
    }
  });
  reset();
  s = require('../miniprogram/core/store');
  assert.equal(s.get().owner, 'user-a');
  assert.equal(s.get().draft.age, 28);
  s.identify('user-b');
  assert.deepEqual(s.get().draft, {});
  s.clear();
  assert.deepEqual(s.get().records, {});
});
test('release app contains no simulated payment service or enable switch', () => {
  assert.equal(fs.existsSync(require('path').join(__dirname, '../miniprogram/services/demo.js')), false);
  assert.equal('enableDeveloperDemo' in require('../miniprogram/core/config'), false);
});
test('unconfigured service shows Chinese availability copy without code paths', async () => {
  require('../miniprogram/core/config').cloudEnv = '';
  await assert.rejects(require('../miniprogram/services/api').call('bootstrap'), /^Error: 服务暂未开放/);
});
test('service exceptions do not expose cloud identifiers or implementation details', async () => {
  require('../miniprogram/core/config').cloudEnv = 'test';
  wx.cloud = {
    callFunction: async () => {
      throw new Error('cloud secret internal stack');
    }
  };
  await assert.rejects(require('../miniprogram/services/api').call('bootstrap'), /^Error: 暂时无法连接服务/);
});
test('offline elapsed time and pause/resume use timestamps', () => {
  const s = require('../miniprogram/core/store'),
    coach = require('../miniprogram/services/coach');
  s.save({
    session: {
      elapsed: 3000,
      runningSince: Date.now() - 4000
    }
  });
  assert.ok(coach.elapsed(s.get().session) >= 7000);
  coach.pause();
  const elapsed = s.get().session.elapsed;
  assert.equal(s.get().session.runningSince, null);
  coach.resume();
  assert.equal(s.get().session.elapsed, elapsed);
});
test('native payment success callback cannot unlock until server confirms payment', async () => {
  const backend = service();
  connect(backend);
  wx.requestVirtualPayment = async () => {};
  const coach = require('../miniprogram/services/coach'),
    sync = require('../miniprogram/services/syncService'),
    store = require('../miniprogram/core/store');
  coach.assess(form);
  await sync.bootstrap(true);
  const order = await coach.purchase();
  assert.equal(order.status, 'pending');
  assert.equal(store.get().entitlement, null);
  await assert.rejects(coach.start(), /购买/);
  backend.confirm(order.id);
  await coach.orderStatus(order.id);
  assert.equal(store.get().entitlement.status, 'pending');
});
test('production flow uses native payment and server confirmation through complete training and deletion', async () => {
  const backend = service();
  connect(backend);
  wx.requestVirtualPayment = async data => backend.confirm(data.testOrderId);
  const store = require('../miniprogram/core/store'),
    coach = require('../miniprogram/services/coach'),
    sync = require('../miniprogram/services/syncService'),
    api = require('../miniprogram/services/api');
  coach.assess(form);
  await sync.bootstrap(true);
  assert.equal(store.get().owner, 'user-a');
  const order = await coach.purchase();
  assert.equal(order.status, 'paid');
  await coach.start();
  for (let i = 0; i < 8; i++) {
    store.save({
      session: {
        ...store.get().session,
        restUntil: null
      }
    });
    coach.next();
  }
  await coach.finish('okay', false);
  assert.equal(coach.snapshot().report.sessions, 1);
  assert.equal(store.get().queue.length, 0);
  await sync.bootstrap(true);
  assert.equal(coach.snapshot().report.sessions, 1);
  await api.call('account.delete', {
    confirm: 'DELETE'
  });
  store.clear();
  assert.deepEqual(store.get().records, {});
});
test('native form submit captures final keyboard value before blur', async () => {
  const page = loadPage('assessment');
  page.onLoad();
  page.setData({step:2,form:{...page.data.form,consent:true,sex:'male',height:175,weight:70}});
  await page.next({
    detail: {
      value: {
        age: '32',
        goal: 'strength',
        experience: 'beginner'
      }
    }
  });
  assert.equal(page.data.form.age, '32');
  assert.equal(page.data.step, 3);
  assert.equal(require('../miniprogram/core/store').get().draft.age, '32');
});
test('later assessment steps cannot bypass continuing from the privacy notice', async () => {
 const page=loadPage('assessment');page.onLoad();page.setData({step:2,form:{...page.data.form,sex:'male',age:'28'}});
 let authorized=false;wx.requirePrivacyAuthorize=()=>{authorized=true;};
 await page.next({detail:{value:{}}});assert.match(page.data.error,/说明/);assert.equal(authorized,false);
});
test('privacy authorization failure does not save a personalized assessment record', async () => {
  const page = loadPage('assessment');
  page.setData({
    step: 1,
    form
  });
  wx.requirePrivacyAuthorize = ({
    fail
  }) => fail({
    errMsg: 'deny'
  });
  await page.next({
    detail: {
      value: {
        consent: ['yes'],
        screening: 'clear'
      }
    }
  });
  assert.match(page.data.error, /隐私保护指引/);
  assert.equal(require('../miniprogram/core/store').get().records.assessment, undefined);
});
test('native reminder switch rolls back after subscription rejection', async () => {
  const store = require('../miniprogram/core/store');
  store.save({
    config: {
      reminderTemplateId: 'template'
    }
  });
  wx.requestSubscribeMessage = async () => ({
    template: 'reject'
  });
  const page = loadPage('profile');
  page.refresh();
  await page.reminder({
    detail: {
      value: true
    }
  });
  assert.equal(page.data.reminderEnabled, false);
  assert.equal(store.get().reminder.enabled, false);
});
test('changing reminder time does not request subscription again', async () => {
  const backend = service();
  connect(backend);
  const store = require('../miniprogram/core/store');
  store.save({
    reminder: {
      enabled: true,
      time: '20:00'
    },
    config: {
      reminderTemplateId: 'template'
    }
  });
  let asked = 0;
  wx.requestSubscribeMessage = async () => {
    asked++;
    return {
      template: 'accept'
    };
  };
  await require('../miniprogram/services/coach').reminder(true, '19:30', {
    requestAuthorization: false
  });
  assert.equal(asked, 0);
  assert.equal(store.get().reminder.time, '19:30');
});
test('native nutrition form saves values still held by keyboard input', async () => {
  const backend = service();
  connect(backend);
  backend.state().orders.push({
    id: 'test-order',
    status: 'pending',
    plan: require('../shared/domain').makePlan(form)
  });
  backend.confirm('test-order');
  const store = require('../miniprogram/core/store');
  store.identify('user-a');
  store.save({
    entitlement: require('../server/business').activate(backend.state(), Date.now(), 'secret')
  });
  const page = loadPage('nutrition');
  page.onLoad();
  await page.save({
    detail: {
      value: {
        breakfast: '鸡蛋和米饭',
        lunch: '',
        dinner: '',
        nutrition: true
      }
    }
  });
  const daily = Object.values(store.get().records).find(r => r.kind === 'daily');
  assert.equal(daily.value.breakfast, '鸡蛋和米饭');
});
test('long messages use native modal, short messages use toast, native cancellation stays silent', async () => {
  const feedback = require('../miniprogram/core/feedback');
  let modal = 0,
    toast = 0;
  wx.showModal = async () => {
    modal++;
  };
  wx.showToast = async () => {
    toast++;
  };
  await feedback.showError(new Error('这是一条较长的操作提示，需要用户读完后再继续下一步。'));
  await feedback.showError(new Error('请填写年龄'));
  await feedback.showError({
    errMsg: 'showActionSheet:fail cancel'
  });
  assert.equal(modal, 1);
  assert.equal(toast, 1);
});
test('dirty record edits during sync retain newer data and acknowledged version', async () => {
  const store = require('../miniprogram/core/store'),
    repo = require('../miniprogram/services/repository'),
    api = require('../miniprogram/services/api'),
    sync = require('../miniprogram/services/syncService');
  store.identify('user-a');
  const value = {
    date: '2026-10-30',
    weight: 70,
    waist: null
  };
  repo.write('measurement', 'measurement:2026-10-30', value);
  let release, started;
  const ready = new Promise(r => {
    started = r;
  });
  api.call = async (action, {
    operations
  }) => {
    started();
    await new Promise(r => {
      release = r;
    });
    const op = operations[0];
    return {
      results: [{
        id: op.id,
        key: op.key,
        status: 'ok',
        version: 1
      }],
      state: {
        records: {
          [op.key]: {
            kind: op.kind,
            value: op.value,
            version: 1
          }
        }
      }
    };
  };
  const pending = sync.flush();
  await ready;
  repo.write('measurement', 'measurement:2026-10-30', {
    ...value,
    weight: 71
  });
  release();
  await pending;
  assert.equal(store.get().queue.length, 1);
  assert.equal(store.get().queue[0].baseVersion, 1);
  assert.equal(store.get().records['measurement:2026-10-30'].value.weight, 71);
});

test('internal analytics do not appear as pending personal records', () => {
  const store = require('../miniprogram/core/store'),
    coach = require('../miniprogram/services/coach');
  store.save({
    online: true,
    queue: [{
      kind: 'event',
      id: 'analytics'
    }, {
      kind: 'measurement',
      id: 'measurement'
    }]
  });
  assert.equal(coach.snapshot().online, true);
  assert.equal(coach.snapshot().pending, 1);
  store.save({
    queue: [{
      kind: 'event',
      id: 'analytics'
    }]
  });
  assert.equal(coach.snapshot().pending, 0);
});

test('cached bootstrap still flushes pending writes on foreground return', async () => {
  const backend = service();
  connect(backend);
  const store = require('../miniprogram/core/store'),
    sync = require('../miniprogram/services/syncService'),
    repo = require('../miniprogram/services/repository');
  let bootstraps = 0;
  const invoke = backend.invoke;
  backend.invoke = async (action, data) => {
    if (action === 'bootstrap') bootstraps++;
    return invoke(action, data);
  };
  store.save({
    lastBootstrap: Date.now()
  });
  await sync.bootstrap();
  assert.equal(bootstraps, 1);
  repo.write('measurement', 'measurement:2026-10-30', {
    date: '2026-10-30',
    weight: 70
  });
  await sync.bootstrap();
  assert.equal(bootstraps, 1);
  assert.equal(store.get().queue.length, 0);
  assert.ok(backend.state().records['measurement:2026-10-30']);
  assert.equal(store.get().syncing, false);
});

test('previously rejected valid analytics are retried once the server advertises support', async () => {
  const backend = service();
  connect(backend);
  const store = require('../miniprogram/core/store'),
    sync = require('../miniprogram/services/syncService'),
    d = require('../shared/domain');
  store.identify('user-a');
  const operation = {
    id: 'eventop123',
    key: 'event:assessment_started:old123',
    kind: 'event',
    baseVersion: 0,
    value: {
      name: 'assessment_started',
      at: Date.now(),
      date: d.localDate()
    }
  };
  store.save({
    conflicts: [{
      operation,
      invalid: true,
      message: '记录格式不正确',
      remote: null
    }],
    syncError: '部分记录未被云端接受'
  });
  await sync.bootstrap(true);
  assert.equal(store.get().queue.length, 0);
  assert.equal(store.get().conflicts.length, 0);
  assert.equal(store.get().syncError, '');
  assert.ok(backend.state().records[operation.key]);
});

test('silent account bootstrap needs no explicit login or avatar authorization', async () => {
  const backend = service();
  connect(backend);
  let requested = 0;
  wx.login = async () => {
    requested++;
  };
  wx.requirePrivacyAuthorize = () => {
    throw new Error('unexpected profile authorization');
  };
  await require('../miniprogram/services/syncService').bootstrap(true);
  const s = require('../miniprogram/core/store').get();
  assert.equal(s.accountStatus, 'ready');
  assert.equal(s.profile.nickname, '薄肌学员');
  assert.equal(requested, 0);
});
test('saving nickname alone does not upload an avatar and updates the cached profile', async () => {
  const backend = service();
  connect(backend);
  const store = require('../miniprogram/core/store');
  store.identify('user-a');
  store.save({
    config: {
      profileEditingSupported: true
    }
  });
  let uploads = 0;
  wx.cloud.uploadFile = async () => {
    uploads++;
  };
  const r = await require('../miniprogram/services/profile').saveProfile({
    nickname: ' 小明 '
  }, 0, {});
  assert.equal(r.status, 'saved');
  assert.equal(store.get().profile.nickname, '小明');
  assert.equal(uploads, 0);
});
test('offline profile editing does not submit or lose the draft', async () => {
  const backend = service();
  connect(backend);
  const store = require('../miniprogram/core/store');
  store.save({
    online: false
  });
  const draft = {
    nickname: '离线草稿',
    avatarTemp: '/tmp/avatar.png'
  };
  await assert.rejects(require('../miniprogram/services/profile').saveProfile(draft, 0, {}), /离线/);
  assert.equal(draft.nickname, '离线草稿');
  assert.equal(backend.state().profile.version, 0);
});
test('avatar upload failure preserves the old saved profile', async () => {
  const backend = service();
  connect(backend);
  const store = require('../miniprogram/core/store');
  store.identify('user-a');
  store.save({
    config: {
      profileEditingSupported: true
    }
  });
  wx.getFileSystemManager = () => ({
    getFileInfo: ({
      success
    }) => success({
      size: 100
    })
  });
  wx.getImageInfo = async () => ({
    type: 'png'
  });
  wx.cloud.uploadFile = async () => {
    throw new Error('upload failed');
  };
  await assert.rejects(require('../miniprogram/services/profile').saveProfile({
    nickname: '新昵称',
    avatarTemp: '/tmp/avatar.png'
  }, 0, {}), /upload failed/);
  assert.equal(backend.state().profile.nickname, '薄肌学员');
  assert.equal(store.get().profile.version, 0);
});
test('native nickname form captures shortcut text and waits for platform review before saving', async () => {
  global.setTimeout = originalTimer;
  const backend = service();
  connect(backend);
  const store = require('../miniprogram/core/store');
  store.identify('user-a');
  store.save({
    config: {
      profileEditingSupported: true
    }
  });
  wx.canIUse = () => true;
  wx.navigateBack = () => {};
  wx.enableAlertBeforeUnload = () => {};
  wx.disableAlertBeforeUnload = () => {};
  const page = loadPage('profile-edit');
  page.onLoad();
  const promise = page.save({
    detail: {
      value: {
        nickname: '快捷昵称'
      }
    }
  });
  setImmediate(() => page.reviewed({
    detail: {
      pass: true,
      timeout: false
    }
  }));
  await promise;
  assert.equal(backend.state().profile.nickname, '快捷昵称');
  assert.equal(page.data.dirty, false);
});
test('canceling native avatar picker leaves the existing selection unchanged', () => {
  wx.canIUse = () => true;
  const page = loadPage('profile-edit');
  page.onLoad();
  const url = page.data.avatarUrl;
  page.chooseAvatar({
    detail: {}
  });
  assert.equal(page.data.avatarUrl, url);
  assert.equal(page.data.dirty, false);
});
test('oversized avatar is rejected before an upload credential or file upload is requested', async () => {
  const backend = service();
  connect(backend);
  const store = require('../miniprogram/core/store');
  store.identify('user-a');
  store.save({
    config: {
      profileEditingSupported: true
    }
  });
  wx.getFileSystemManager = () => ({
    getFileInfo: ({
      success
    }) => success({
      size: 2 * 1024 * 1024 + 1
    })
  });
  await assert.rejects(require('../miniprogram/services/profile').saveProfile({
    nickname: '用户',
    avatarTemp: '/tmp/big.png'
  }, 0, {}), /2 MB/);
  assert.equal(backend.state().avatarUploads, undefined);
});
test('a delayed sync response cannot roll back a newly saved profile',()=>{const store=require('../miniprogram/core/store'),repo=require('../miniprogram/services/repository');store.save({profile:{nickname:'新资料',avatarFileId:null,version:3},records:{}});repo.accept({records:{},profile:{nickname:'旧资料',avatarFileId:null,version:2}});assert.equal(store.get().profile.nickname,'新资料');assert.equal(store.get().profile.version,3);});
test('rejected nickname review never submits profile changes',async()=>{const backend=service();connect(backend);const store=require('../miniprogram/core/store');store.identify('user-a');store.save({config:{profileEditingSupported:true}});wx.canIUse=()=>true;const page=loadPage('profile-edit');page.onLoad();page.nickname({detail:{value:'新昵称'}});page.reviewed({detail:{pass:false,timeout:false}});await page.save({detail:{value:{nickname:'新昵称'}}});assert.equal(backend.state().profile.version,0);assert.equal(page.data.dirty,true);});

test('devtools avatar picker uses local media and keeps phone native chooser unchanged', async () => {
  wx.canIUse = () => true;
  wx.getDeviceInfo = () => ({platform: 'devtools'});
  let selected = 0;
  wx.chooseMedia = async options => {
    selected++;
    assert.deepEqual(options.mediaType, ['image']);
    return {tempFiles: [{tempFilePath: '/tmp/avatar.png'}]};
  };
  const page = loadPage('profile-edit');
  page.onLoad();
  await page.pickAvatarInDevtools();
  assert.equal(page.data.avatarTemp, '/tmp/avatar.png');
  assert.equal(page.data.dirty, true);
  assert.equal(page.data.busy, false);
  page.setData({devtools: false});
  await page.pickAvatarInDevtools();
  assert.equal(selected, 1);
});

test('avatar chooser cancellation preserves the draft and failures provide feedback', async () => {
  wx.canIUse = () => true;
  wx.getDeviceInfo = () => ({platform: 'devtools'});
  wx.chooseMedia = async () => {throw {errMsg: 'chooseMedia:fail cancel'};};
  const page = loadPage('profile-edit');
  page.onLoad();
  await page.pickAvatarInDevtools();
  assert.equal(page.data.error, '');
  assert.equal(page.data.dirty, false);
  page.avatarPickerError({detail: {errMsg: 'chooseAvatar:fail api scope is not declared in the privacy agreement'}});
  assert.match(page.data.error, /尚未声明图片选择用途/);
  assert.equal(page.data.dirty, false);
});
test('continue records consent only after authorization and restores selected days',async()=>{
 const page=loadPage('assessment');page.onLoad();
 page.change({currentTarget:{dataset:{key:'weight'}},detail:{value:'70'}});
 const store=require('../miniprogram/core/store');assert.deepEqual(store.get().draft,{});
 page.change({currentTarget:{dataset:{key:'screening'}},detail:{value:'clear'}});
 wx.requirePrivacyAuthorize=({success})=>success();await page.next({detail:{value:{}}});
 assert.equal(page.data.step,2);assert.equal(store.get().draft.consent,true);
 page.setData({step:7});page.weekdays({detail:{value:['1','3','5']}});
 const restored=loadPage('assessment');restored.onLoad();assert.equal(restored.data.step,7);assert.equal(restored.data.selectedDays[3].checked,true);
 restored.back();assert.equal(restored.data.step,6);restored.change({currentTarget:{dataset:{key:'frequency'}},detail:{value:'2'}});
 await restored.next();assert.equal(restored.data.step,7);await restored.next();assert.match(restored.data.error,/2 个/);assert.deepEqual(restored.data.form.weekdays,[1,3,5]);
});
test('legacy assessment positions migrate without changing answers',()=>{
 const store=require('../miniprogram/core/store');
 for(const [legacy,current] of [[1,1],[2,2],[3,5],[4,5],[5,5]]){
  store.save({draft:{schemaVersion:2,consent:true,age:'32'},assessmentStep:legacy,assessmentFlowVersion:undefined});
  const page=loadPage('assessment');page.onLoad();assert.equal(page.data.step,current);assert.equal(page.data.form.age,'32');
 }
});
test('assessment validates numeric precision and bounds while allowing optional waist',async()=>{
 const page=loadPage('assessment');page.onLoad();page.setData({step:3,form:{...page.data.form,consent:true}});
 for(const values of [{height:'99',weight:'70'},{height:'175',weight:'250.1'},{height:'175.22',weight:'70'},{height:'175',weight:'abc'}]){
  await page.next({detail:{value:values}});assert.equal(page.data.step,3);assert.match(page.data.error,/检查/);
 }
 await page.next({detail:{value:{height:'230',weight:'30'}}});assert.equal(page.data.step,4);
 await page.next({detail:{value:{waist:'',activity:'light'}}});assert.equal(page.data.step,5);
 page.setData({step:2});await page.next({detail:{value:{sex:'male',age:'28.5'}}});assert.equal(page.data.step,2);
 await page.next({detail:{value:{sex:'male',age:'18'}}});assert.equal(page.data.step,3);
});
test('rejected privacy authorization keeps health inputs out of the draft and allows retry',async()=>{
 const page=loadPage('assessment');page.onLoad();page.change({currentTarget:{dataset:{key:'screening'}},detail:{value:'clear'}});
 wx.requirePrivacyAuthorize=({fail})=>fail();await page.next();
 const store=require('../miniprogram/core/store');assert.deepEqual(store.get().draft,{});assert.equal(page.data.form.consent,false);assert.equal(page.data.step,1);
 wx.requirePrivacyAuthorize=({success})=>success();await page.next();assert.equal(page.data.step,2);
});
test('assessment ignores duplicate continue while privacy authorization is pending',async()=>{
 const page=loadPage('assessment');page.onLoad();page.setData({form:{...page.data.form,screening:'clear'}});
 let success,calls=0;wx.requirePrivacyAuthorize=options=>{calls++;success=options.success;};
 const pending=page.next();await page.next();assert.equal(calls,1);assert.equal(page.data.step,1);success();await pending;assert.equal(page.data.step,2);
});
test('new preview uses resolved media URLs and defaults to the monthly package',()=>{
 const store=require('../miniprogram/core/store');const a={schemaVersion:2,consent:true,screening:'clear',age:28,sex:'male',height:175,weight:70,waist:'',goal:'habit',experience:'beginner',activity:'light',minutes:15,frequency:3,weekdays:[1,3,5],equipment:'none',foodScene:'takeout',foodObstacle:'irregular',diet:'none',allergies:''};
 store.save({preview:require('../shared/domain').makePlan(a),config:{mediaUrls:{squat:'https://example.test/squat.mp4'}}});
 const page=loadPage('preview');page.refresh();assert.equal(page.data.sku,'month');assert.equal(page.data.price,19);assert.equal(page.data.plan.days.find(x=>!x.rest).exercises[0].media,'https://example.test/squat.mp4');
});
test('a confirmed new week never overwrites an unfinished training session',async()=>{
 const store=require('../miniprogram/core/store'),coach=require('../miniprogram/services/coach');
 store.save({membership:{active:true},session:{key:'session:old-week:6',planId:'old-week',day:6,date:'2026-10-30',task:{title:'原计划动作',exercises:[]},elapsed:1000,runningSince:null}});
 wx.cloud={callFunction:async()=>{throw new Error('must not replace the session');}};
 const session=await coach.start();assert.equal(session.planId,'old-week');assert.equal(session.task.title,'原计划动作');assert.ok(session.runningSince);
});
test('home guide stays visible at either viewport edge and returns to its document position',()=>{
 const page=loadPage('today');let scrollTop=0,viewport=600;
 page.setData({showGuide:true});
 wx.nextTick=fn=>fn();wx.getWindowInfo=()=>({windowWidth:375,windowHeight:viewport});
 wx.createSelectorQuery=()=>({selectViewport(){return this;},scrollOffset(){return this;},select(){return this;},boundingClientRect(){return this;},exec(fn){fn([{scrollTop},{top:900-scrollTop,height:50,left:36,width:303}]);}});
 page.scheduleGuideMeasure();assert.equal(page.data.guideDock,'bottom');assert.equal(page.data.guideWidth,303);
 scrollTop=500;page.onPageScroll({scrollTop});assert.equal(page.data.guideDock,'');
 scrollTop=1000;page.onPageScroll({scrollTop});assert.equal(page.data.guideDock,'top');
 scrollTop=500;page.onPageScroll({scrollTop});assert.equal(page.data.guideDock,'');
 scrollTop=0;page.onPageScroll({scrollTop});assert.equal(page.data.guideDock,'bottom');
 viewport=1100;page.onResize();assert.equal(page.data.guideDock,'');
});
test('member home removes the floating guide and hidden pages ignore delayed measurements',()=>{
 const page=loadPage('today');page.setData({showGuide:true,guideDock:'bottom'});
 let callback;wx.nextTick=fn=>fn();wx.getWindowInfo=()=>({windowWidth:375,windowHeight:600});
 wx.createSelectorQuery=()=>({selectViewport(){return this;},scrollOffset(){return this;},select(){return this;},boundingClientRect(){return this;},exec(fn){callback=fn;}});
 page.scheduleGuideMeasure();page.onHide();callback([{scrollTop:0},{top:900,height:50,left:36,width:303}]);assert.equal(page._guideMetrics,undefined);
 page.setData({vm:{isMember:true,active:false,entitlement:null,records:{}}});page.render();assert.equal(page.data.showGuide,false);assert.equal(page.data.guideDock,'');
});

test('all nine assessment steps submit the new target assessment exactly once',async()=>{
 const page=loadPage('assessment');page.onLoad();let assessed=0,navigated='';
 require('../miniprogram/services/coach').assess=async a=>{assessed++;assert.equal(a.schemaVersion,3);assert.equal(a.targetWeight,'65');assert.equal(a.pace,'moderate');assert.equal(a.stepGoal,6000);assert.equal(a.consent,true);assert.equal(a.weight,'70.5');assert.deepEqual(a.weekdays,[1,3,5]);return {};};
 wx.requirePrivacyAuthorize=({success})=>success();wx.navigateTo=({url})=>{navigated=url;};
 const answers=[{screening:'clear'},{sex:'male',age:'28'},{height:'175',weight:'70.5'},{waist:'',activity:'light'},{goal:'habit',experience:'beginner',targetWeight:'65',pace:'moderate'},{minutes:15,frequency:3,equipment:'none',stepGoal:6000}, {},{foodScene:'cook',foodObstacle:'irregular'},{diet:'none',allergies:''}];
 for(let i=0;i<answers.length;i++){
  assert.equal(page.data.step,i+1);if(i===6)page.weekdays({detail:{value:['1','3','5']}});
  await page.next({detail:{value:answers[i]}});assert.equal(page.data.error,'');
 }
 assert.equal(assessed,1);assert.equal(navigated,'/pages/preview/index');
});

test('guest account bootstrap carries the assessment flow position with its draft',()=>{
 const store=require('../miniprogram/core/store');store.save({draft:{schemaVersion:2,consent:true,weight:'70'},assessmentStep:7,assessmentFlowVersion:2});store.identify('signed-in');
 const page=loadPage('assessment');page.onLoad();assert.equal(page.data.step,5);assert.equal(page.data.form.weight,'70');
});

test('preview displays test prices only in develop and normal prices in trial and release',()=>{
 for(const version of ['develop','trial','release']){
  wx.getAccountInfoSync=()=>({miniProgram:{envVersion:version}});
  const page=loadPage('preview');page.onLoad({sku:'year'});
  assert.deepEqual(page.data.catalog.map(x=>x.price),version==='develop'?[0.01,0.02,0.03]:[19,198,298]);
  assert.equal(page.data.price,version==='develop'?0.02:198);
  page.select({currentTarget:{dataset:{sku:'three_year'}}});assert.equal(page.data.price,version==='develop'?0.03:298);
 }
});

test('test checkout refuses an old server price before opening the cashier',async()=>{
 wx.getAccountInfoSync=()=>({miniProgram:{envVersion:'develop'}});wx.getSystemInfoSync=()=>({system:'Android',version:'8.0.68'});wx.login=async()=>({code:'code'});
 let opened=false;wx.requestVirtualPayment=async()=>{opened=true;};
 const store=require('../miniprogram/core/store');store.save({draft:{schemaVersion:2,consent:true,screening:'clear',age:28,sex:'male',height:175,weight:70,waist:'',goal:'habit',experience:'beginner',activity:'light',minutes:15,frequency:3,equipment:'none',weekdays:[1,3,5],foodScene:'cook',foodObstacle:'irregular',diet:'none',allergies:''}});
 require('../miniprogram/services/api').call=async()=>({order:{id:'old-test-order',amount:1900}});
 await assert.rejects(require('../miniprogram/services/coach').purchase('month'),/金额/);assert.equal(opened,false);assert.equal(store.get().pendingOrderId,'old-test-order');
});
test('iOS preview offers only monthly one-yuan test checkout while release retains real prices',()=>{
 wx.getAccountInfoSync=()=>({miniProgram:{envVersion:'develop'}});wx.getSystemInfoSync=()=>({platform:'ios',system:'iOS 18',version:'8.0.68'});
 const page=loadPage('preview');page.onLoad({sku:'year'});assert.equal(page.data.sku,'month');assert.deepEqual(page.data.catalog.map(x=>x.price),[1]);assert.equal(page.data.price,1);
 wx.getAccountInfoSync=()=>({miniProgram:{envVersion:'release'}});page.onLoad({sku:'year'});assert.deepEqual(page.data.catalog.map(x=>x.price),[19,198,298]);assert.equal(page.data.price,198);
});

test('purchase availability updates after cloud config refresh and distinguishes old iOS versions',()=>{
 wx.requestVirtualPayment=async()=>{};let version='8.0.68';wx.getSystemInfoSync=()=>({system:'iOS 18',version});
 const store=require('../miniprogram/core/store'),page=loadPage('preview');page.onLoad();assert.match(page.data.purchaseIssue,/苹果/);
 store.save({config:{...store.get().config,iosEnabled:true}});page.render();assert.equal(page.data.purchaseIssue,'');
 version='8.0.9';page.render();assert.match(page.data.purchaseIssue,/更新至/);
 wx.getSystemInfoSync=()=>({system:'Android 15',version:'8.0.68'});store.save({config:{...store.get().config,iosEnabled:false}});page.render();assert.equal(page.data.purchaseIssue,'');
});
test('a cashier error after server-confirmed payment still advances as paid',async()=>{
 const backend=service();connect(backend);const coach=require('../miniprogram/services/coach');await require('../miniprogram/services/syncService').bootstrap();coach.assess(form);
 wx.requestVirtualPayment=async data=>{backend.confirm(data.testOrderId);throw {errMsg:'requestVirtualPayment:fail interrupted'};};
 const order=await coach.purchase();assert.equal(order.status,'paid');assert.equal(require('../miniprogram/core/store').get().pendingOrderId,null);
});

test('payment refreshes an expired login once and reuses the original order',async()=>{
 const backend=service();connect(backend);const coach=require('../miniprogram/services/coach');await require('../miniprogram/services/syncService').bootstrap();coach.assess(form);
 const api=require('../miniprogram/services/api'),original=api.call;let failed=false,logins=0;const codes=[];
 wx.login=async()=>({code:'fresh-'+(++logins)});wx.requestVirtualPayment=async data=>backend.confirm(data.testOrderId);
 api.call=async(action,data)=>{if(action==='purchase.create'){codes.push(data.code);if(!failed){failed=true;const e=new Error('expired');e.code='PAYMENT_LOGIN_EXPIRED';throw e;}}return original(action,data);};
 const paid=await coach.purchase();assert.equal(paid.status,'paid');assert.deepEqual(codes,['fresh-1','fresh-2']);assert.equal(backend.state().orders.length,1);
});
test('safe payment platform codes are preserved without exposing generic server failures',async()=>{
 wx.cloud={callFunction:async()=>({result:{stage:'prod',code:'PAYMENT_PLATFORM_ERROR',message:'微信支付准备失败（平台错误码 40125）'}})};
 await assert.rejects(require('../miniprogram/services/api').call('purchase.create'),e=>e.code==='PAYMENT_PLATFORM_ERROR'&&e.message.includes('40125'));
 wx.cloud.callFunction=async()=>({result:{stage:'prod',code:'SERVICE_ERROR',message:'secret internal'}});
 await assert.rejects(require('../miniprogram/services/api').call('purchase.create'),e=>!e.message.includes('secret'));
});

test('test service errors identify the failing action without leaking backend messages',async()=>{
 wx.getAccountInfoSync=()=>({miniProgram:{envVersion:'develop'}});wx.cloud={callFunction:async()=>({result:{stage:'test',sourceVersion:'5df02a1897bad906',code:-502005,message:'database secret stack'}})};
 const api=require('../miniprogram/services/api');
 await assert.rejects(api.call('purchase.create'),e=>e.code==='TEST_SERVICE_ERROR'&&e.message.includes('下单')&&e.message.includes('-502005')&&e.message.includes('5df02a18')&&!e.message.includes('secret'));
 wx.cloud.callFunction=async()=>({result:{stage:'test',code:'DATABASE_REQUEST_FAILED',message:'secret stack'}});
 await assert.rejects(api.call('sync.batch'),e=>e.message.includes('同步记录')&&!/database|secret/i.test(e.message));
});
test('test cloud invocation failure distinguishes checkout timeout without retrying or leaking details',async()=>{
 wx.getAccountInfoSync=()=>({miniProgram:{envVersion:'develop'}});let calls=0;
 wx.cloud={callFunction:async()=>{calls++;throw {errCode:-504003,errMsg:'function timeout secret internal request_id=private'};}};
 const api=require('../miniprogram/services/api');
 await assert.rejects(api.call('purchase.create'),e=>e.code==='TEST_TRANSPORT_ERROR'&&e.action==='purchase.create'&&/下单超时/.test(e.message)&&/-504003/.test(e.message)&&/订单页/.test(e.message)&&!/secret|private|request_id/.test(e.message));
 assert.equal(calls,1);
 wx.cloud.callFunction=async()=>{throw {errCode:'secret',message:'private internal'};};
 await assert.rejects(api.call('bootstrap'),e=>/连接账号连接失败/.test(e.message)&&/未知/.test(e.message)&&!/secret|private/.test(e.message));
});

test('callback-only cashier must finish before payment status is queried',async()=>{
 const backend=service();connect(backend);const coach=require('../miniprogram/services/coach');await require('../miniprogram/services/syncService').bootstrap();coach.assess(form);
 let callbacks,queries=0;const api=require('../miniprogram/services/api'),original=api.call;
 api.call=async(action,data)=>{if(action==='purchase.status')queries++;return original(action,data);};
 wx.requestVirtualPayment=options=>{callbacks=options;};
 const purchase=coach.purchase();for(let i=0;i<20&&!callbacks;i++)await Promise.resolve();
 assert.ok(callbacks);assert.equal(queries,0);backend.confirm(callbacks.testOrderId);callbacks.success({});
 assert.equal((await purchase).status,'paid');assert.equal(queries,1);
});
test('callback-only cashier failures retain a readable native error and the pending order',async()=>{
 const backend=service();connect(backend);const coach=require('../miniprogram/services/coach');await require('../miniprogram/services/syncService').bootstrap();coach.assess(form);
 wx.requestVirtualPayment=options=>{options.fail({errMsg:'requestVirtualPayment:fail',errCode:12345});};
 await assert.rejects(coach.purchase(),/收银台调用失败（错误码 12345）/);
 assert.ok(require('../miniprogram/core/store').get().pendingOrderId);assert.equal(backend.state().orders[0].status,'pending');
});

test('cashier -15012 recovers once only after the server confirms the original order is closed',async()=>{
 const backend=service();connect(backend);const coach=require('../miniprogram/services/coach');await require('../miniprogram/services/syncService').bootstrap();coach.assess(form);
 const ids=[];wx.requestVirtualPayment=options=>{ids.push(options.testOrderId);if(ids.length===1){backend.state().orders.find(o=>o.id===options.testOrderId).status='closed';options.fail({errMsg:'requestVirtualPayment:fail',errCode:-15012});}else{backend.confirm(options.testOrderId);options.success({});}};
 assert.equal((await coach.purchase()).status,'paid');assert.equal(ids.length,2);assert.notEqual(ids[0],ids[1]);assert.equal(backend.state().orders.filter(o=>o.status==='paid').length,1);
});
test('cashier recovery never retries a closed-error code while the server result is still pending',async()=>{
 const backend=service();connect(backend);const coach=require('../miniprogram/services/coach');await require('../miniprogram/services/syncService').bootstrap();coach.assess(form);
 let calls=0;wx.requestVirtualPayment=options=>{calls++;options.fail({errMsg:'requestVirtualPayment:fail',errCode:-15012});};
 await assert.rejects(coach.purchase(),/-15012/);assert.equal(calls,1);assert.equal(backend.state().orders.length,1);
});
test('cashier recovery is bounded to one replacement order',async()=>{
 const backend=service();connect(backend);const coach=require('../miniprogram/services/coach');await require('../miniprogram/services/syncService').bootstrap();coach.assess(form);
 let calls=0;wx.requestVirtualPayment=options=>{calls++;backend.state().orders.find(o=>o.id===options.testOrderId).status='closed';options.fail({errMsg:'requestVirtualPayment:fail',errCode:-15012});};
 await assert.rejects(coach.purchase(),/-15012/);assert.equal(calls,2);assert.equal(backend.state().orders.filter(o=>o.status==='paid').length,0);
});

test('test order page reconciles pending orders without invoking another purchase',async()=>{
 const store=require('../miniprogram/core/store'),coach=require('../miniprogram/services/coach'),sync=require('../miniprogram/services/syncService');
 store.save({config:{...store.get().config,testCheckout:true},orders:[{id:'month-paid',status:'pending'},{id:'year-paid',status:'pending'},{id:'old-closed',status:'closed'}]});
 sync.bootstrap=async()=>{};const checked=[];coach.orderStatus=async id=>{checked.push(id);return {id,status:'paid'};};coach.purchase=()=>{throw new Error('must not charge');};
 const page=loadPage('orders');page.onShow();for(let i=0;i<20&&checked.length<2;i++)await Promise.resolve();assert.deepEqual(checked,['month-paid','year-paid']);
 page.onHide();
});

test('meal photo selection requires the WeChat privacy authorization',async()=>{
 const store=require('../miniprogram/core/store'),d=require('../shared/domain'),date=d.localDate();
 store.identify('meal-member');
 store.save({config:{mealWeeksSupported:true,mealPhotoStorageReady:true,mealRecognitionEnabled:true},membership:{active:true}});
 let picks=0;
 wx.requirePrivacyAuthorize=options=>options.fail();
 wx.chooseMedia=async()=>{picks++;};
 const page=loadPage('nutrition');
 page.setData({calendar:{selected:date,isToday:true}});
 await page.takeDailyPhoto();
 assert.equal(picks,0);
 assert.equal(store.get().mealPhotoDraft,undefined);
});
test('the meal result rejects a draft from a different account or plan',()=>{
 const store=require('../miniprogram/core/store'),d=require('../shared/domain'),date=d.localDate();
 const photo=require('../miniprogram/services/meal-photo');
 store.save({entitlement:{id:'new-plan'}});
 const result=loadPage('meal-result');
 let receive;
 result.getOpenerEventChannel=()=>({on:(event,callback)=>{assert.equal(event,'mealDraft');receive=callback;}});
 result.onLoad();
 const draft={owner:photo.identity(store.get()),date,planId:'old-plan',weekly:false,src:'/local/food.jpg'};
 receive(draft);
 assert.equal(result.data.draft,undefined);
 assert.match(result.data.pageError,/计划已变化/);
 receive({...draft,planId:'new-plan',owner:'another-account'});
 assert.equal(result.data.draft,undefined);
});
test('AI coaching sends no health context when user declines consent',async()=>{
 const store=require('../miniprogram/core/store');store.save({config:{aiEnabled:true}});let calls=0;
 wx.showModal=async()=>({confirm:false});const api=require('../miniprogram/services/api');api.call=async()=>{calls++;};
 const page=loadPage('guidance');page.setData({message:'今天如何训练？'});await page.send();assert.equal(calls,0);assert.equal(store.get().aiPending,undefined);
});
test('updating a profile prefills completed assessment from step one while ordinary visits resume the draft',()=>{
  const store=require('../miniprogram/core/store');
  const assessment={schemaVersion:3,consent:true,screening:'clear',sex:'male',age:32,height:175,weight:70,targetWeight:65,stepGoal:8000,weekdays:[1,3,5],diet:'vegetarian',allergies:'花生'};
  const draft={...assessment,age:33};
  store.save({draft,assessmentStep:8,assessmentFlowVersion:3,records:{assessment:{kind:'assessment',value:assessment}}});
  const restarted=loadPage('assessment');restarted.onLoad({restart:'1'});
  assert.equal(restarted.data.step,1);
  assert.deepEqual(restarted.data.form,{...restarted.data.form,...assessment,consent:false});
  assert.deepEqual(store.get().records.assessment.value,assessment);
  assert.deepEqual(store.get().draft,draft);
  restarted.change({currentTarget:{dataset:{key:'activity'}},detail:{value:'active'}});
  assert.equal(restarted.data.form.stepGoal,8000);
  const resumed=loadPage('assessment');resumed.onLoad();
  assert.equal(resumed.data.step,8);
  assert.equal(resumed.data.form.age,33);
});
test('profile reassessment prefills preview or entitled plan when no completed record exists',()=>{
  const store=require('../miniprogram/core/store');
  for(const source of ['preview','entitlement']){
    const assessment={schemaVersion:2,age:29,weekdays:[2,4],consent:true};
    store.save({records:{},draft:{},preview:source==='preview'?{assessment}:null,entitlement:source==='entitlement'?{plan:{assessment}}:null});
    const page=loadPage('assessment');page.onLoad({restart:'1'});
    assert.equal(page.data.step,1);
    assert.equal(page.data.form.age,29);
    assert.deepEqual(page.data.form.weekdays,[2,4]);
    assert.equal(page.data.form.schemaVersion,3);
    assert.equal(page.data.form.consent,false);
  }
});
