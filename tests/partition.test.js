const {
  test,
  beforeEach,
  afterEach
} = require('node:test'), assert = require('node:assert/strict'), cp = require('child_process'), path = require('path');
const {
  memoryCloud,
  loadEntry
} = require('./fixtures/cloud-runtime'), {
  fixture
} = require('./fixtures/payment-notify'), b = require('../server/business'), d = require('../shared/domain'), partition = require('../server/partition'), build = require('../scripts/cloud-build');
let version, storage;
beforeEach(() => {
  for (const key of Object.keys(require.cache))
    if (key.includes('/miniprogram/')) delete require.cache[key];
  version = 'develop';
  storage = new Map();
  global.wx = {
    getAccountInfoSync: () => ({
      miniProgram: {
        envVersion: version
      }
    }),
    getStorageSync: key => storage.get(key),
    setStorageSync: (key, value) => storage.set(key, structuredClone(value)),
    removeStorageSync: key => storage.delete(key)
  };
});
afterEach(() => {
  delete global.wx;
});
const assessment = {
  age: 28,
  goal: 'habit',
  experience: 'beginner',
  minutes: 15,
  equipment: 'none',
  screening: 'clear',
  consent: true
};

function endpoints(memory, options = {}) {
  return Object.fromEntries(['test','prod'].map(stage=>{const api=loadEntry('coach_'+stage,memory.scope(stage),options);api.scope=memory.scope(stage);return [stage,api];}));
}
async function buy(api, stage,legacy=false) {
  if(legacy){const id=(stage==='test'?'bjt':'bjp')+require('crypto').randomBytes(12).toString('hex');await api.scope.transact('same-user',s=>s.orders.push({id,status:'pending',amount:990,productId:'same-product',plan:d.makePlan(assessment)}));await api.scope.db.collection(api.scope.tables.orders).doc(id).set({data:{userId:'same-user',orderId:id}});return id;}
  const r = await api({
    action: 'purchase.create',sku:'month',
    assessment:{...assessment,schemaVersion:2,sex:'male',height:175,weight:70,waist:'',activity:'light',frequency:3,weekdays:[1,3,5],foodScene:'takeout',foodObstacle:'irregular',diet:'none',allergies:''},
    code: 'login-code',
    stage: stage === 'test' ? 'prod' : 'test'
  });
  assert.equal(r.code, 0);
  assert.equal(r.stage, stage);
  return r.data.order.id;
}
async function state(scope) {
  return scope.transact('same-user', s => structuredClone(s));
}

function delivery(id) {
  return {
    Event: 'xpay_goods_deliver_notify',
    OpenId: 'same-user',
    OutTradeNo: id,
    GoodsInfo: {
      ProductId: 'same-product',
      Quantity: 1
    },
    WeChatPayInfo: {
      MchOrderNo: 'wx-' + id
    },
    stage: 'ignored'
  };
}

test('develop routes to test; trial and release route to prod, all in the same cloud environment', async () => {
  const names = [];
  wx.cloud = {
    callFunction: async ({
      name
    }) => {
      names.push(name);
      return {
        result: {
          code: 0,
          stage: version === 'develop' ? 'test' : 'prod',
          data: {
            ready: true
          }
        }
      };
    }
  };
  const api = require('../miniprogram/services/api');
  for (const value of ['develop', 'trial', 'release']) {
    version = value;
    await api.call('bootstrap');
  }
  assert.deepEqual(names, ['coach_test', 'coach_prod', 'coach_prod']);
  assert.equal(require('../miniprogram/core/config').cloudEnv, 'cloud1-d2glj4fu92e8f1497');
});
test('unrecognized or unavailable version never calls any cloud function', async () => {
  let calls = 0;
  wx.cloud = {
    callFunction: async () => {
      calls++;
    }
  };
  const api = require('../miniprogram/services/api');
  for (const value of ['', undefined, 'unexpected']) {
    version = value;
    await assert.rejects(api.call('bootstrap'), /识别小程序版本/);
  }
  wx.getAccountInfoSync = () => {
    throw new Error('unavailable');
  };
  await assert.rejects(api.call('bootstrap'), /识别小程序版本/);
  assert.equal(calls, 0);
});
test('wrong partition response is rejected before data can be merged', async () => {
  const store = require('../miniprogram/core/store');
  store.save({
    records: {
      safe: {
        value: 'local'
      }
    }
  });
  wx.cloud = {
    callFunction: async () => ({
      result: {
        stage: 'prod',
        code: 0,
        data: {
          records: {
            unsafe: {
              value: 'remote'
            }
          }
        }
      }
    })
  };
  await assert.rejects(require('../miniprogram/services/api').call('bootstrap'), /服务版本不匹配/);
  assert.equal(store.get().records.unsafe, undefined);
});
test('a version switch while a request is in flight rejects the old response', async () => {
  let finish;
  wx.cloud = {
    callFunction: () => new Promise(r => {
      finish = r;
    })
  };
  const pending = require('../miniprogram/services/api').call('bootstrap');
  version = 'trial';
  finish({
    result: {
      stage: 'test',
      code: 0,
      data: {}
    }
  });
  await assert.rejects(pending, /服务版本不匹配/);
});
test('all local state is isolated, trial/release share prod, legacy cache remains untouched', () => {
  storage.set('coach:owner', 'legacy');
  storage.set('coach:legacy', {
    queue: ['legacy-operation']
  });
  const store = require('../miniprogram/core/store');
  assert.equal(store.get().owner, 'guest');
  store.identify('same-user');
  store.save({
    draft: {
      age: 21
    },
    session: {
      id: 'test-session'
    },
    queue: [{
      id: 'test-op'
    }],
    conflicts: [{
      id: 'test-conflict'
    }],
    revision: 9
  });
  version = 'trial';
  assert.equal(store.get().owner, 'guest');
  assert.deepEqual(store.get().queue, []);
  store.identify('same-user');
  store.save({
    draft: {
      age: 30
    },
    revision: 3
  });
  version = 'release';
  assert.equal(store.get().draft.age, 30);
  store.clear();
  assert.deepEqual(store.get().draft, {});
  version = 'develop';
  assert.equal(store.get().draft.age, 21);
  assert.equal(store.get().session.id, 'test-session');
  assert.equal(store.get().queue[0].id, 'test-op');
  assert.equal(store.get().conflicts[0].id, 'test-conflict');
  assert.equal(store.get().revision, 9);
  assert.deepEqual(storage.get('coach:legacy').queue, ['legacy-operation']);
});
test('function stage is immutable despite caller input, and payment configuration remains real', async () => {
  const memory = memoryCloud(),
    api = endpoints(memory);
  const testId = await buy(api.test, 'test'),
    prodId = await buy(api.prod, 'prod');
  assert.match(testId, /^bjt[0-9a-f]{24}$/);
  assert.match(prodId, /^bjp[0-9a-f]{24}$/);
  assert.equal((await state(memory.scope('test'))).orders[0].productId, 'same-product');
  assert.equal((await state(memory.scope('prod'))).orders[0].id, prodId);
  const foreign = await api.prod({
    action: 'purchase.status',
    orderId: testId,
    stage: 'test'
  });
  assert.notEqual(foreign.code, 0);
  assert.equal(foreign.stage, 'prod');
  assert.ok(memory.collections.has('coach_test_order_index'));
  assert.ok(memory.collections.has('coach_order_index'));
  const boot = await api.test({
    action: 'bootstrap',
    stage: 'prod'
  });
  assert.equal(boot.data.config.paymentsEnabled, true);
  assert.equal(boot.sourceVersion, 'test-build');
});
test('verified shared callback routes delivery, duplicate notifications, failure and refund to only one partition', async () => {
  const memory = memoryCloud(),
    api = endpoints(memory),
    testScope = memory.scope('test'),
    prodScope = memory.scope('prod');
  const testId = await buy(api.test, 'test'),
    prodId = await buy(api.prod, 'prod');
  const calls = [];
  const notify = fixture({
    sourceVersion: 'test-build',
    forStage: stage => {
      calls.push(stage);
      return memory.scope(stage);
    }
  });
  let r = await notify.main(notify.event(JSON.stringify({
    ...delivery(testId),
    stage: 'prod'
  })));
  assert.equal(r.body, 'success');
  assert.equal(r.headers['X-Coach-Stage'], 'test');
  assert.equal((await state(testScope)).orders[0].id, testId);
  assert.equal((await state(prodScope)).entitlement, null);
  const revision = (await state(testScope)).revision;
  await notify.main(notify.event(JSON.stringify(delivery(testId))));
  assert.equal((await state(testScope)).revision, revision);
  r = await notify.main(notify.event(JSON.stringify({
    ...delivery(prodId),
    GoodsInfo: {
      ProductId: 'wrong-product',
      Quantity: 1
    }
  })));
  assert.equal(r.statusCode, 400);
  assert.equal((await state(prodScope)).entitlement, null);
  await notify.main(notify.event(JSON.stringify(delivery(prodId))));
  assert.equal((await state(prodScope)).orders[0].id, prodId);
  const refund = {
    Event: 'xpay_refund_notify',
    OpenId: 'same-user',
    OutTradeNo: testId,
    RetCode: 1,
    MchRefundId: 'r1',
    WxRefundId: 'wr1'
  };
  await notify.main(notify.event(JSON.stringify(refund)));
  assert.equal((await state(testScope)).orders[0].status, 'paid');
  await notify.main(notify.event(JSON.stringify({
    ...refund,
    RetCode: 0
  })));
  assert.equal((await state(testScope)).orders[0].status, 'refunded');
  assert.equal((await state(prodScope)).orders[0].status, 'paid');
  const before = calls.length;
  r = await notify.main(notify.event(JSON.stringify(delivery('unknown123'))));
  assert.equal(r.statusCode, 400);
  assert.equal(calls.length, before);
});
test('legacy bj orders continue using the original production collections and callback', async () => {
  const memory = memoryCloud(),
    prod = memory.scope('prod'),
    id = 'bj' + 'a'.repeat(24);
  await prod.transact('same-user', s => {
    s.orders.push({
      id,
      status: 'pending',
      amount: 990,
      plan: d.makePlan(assessment)
    });
  });
  await memory.db.collection('coach_order_index').doc(id).set({
    data: {
      userId: 'same-user',
      orderId: id
    }
  });
  const notify = fixture({
    sourceVersion: 'test-build',
    forStage: stage => memory.scope(stage)
  }, {
    PAY_PRODUCT_ID: 'same-product'
  });
  assert.equal((await notify.main(notify.event(JSON.stringify(delivery(id))))).body, 'success');
  assert.equal((await state(prod)).entitlement.id, id);
  assert.equal(memory.collections.has('coach_test_accounts'), false);
});
test('training activation, sync and deletion affect only the invoked function partition', async () => {
  const memory = memoryCloud(),
    api = endpoints(memory, {
      now: Date.parse('2026-10-30T20:05:00+08:00')
    }),
    notify = fixture({
      sourceVersion: 'test-build',
      forStage: stage => memory.scope(stage)
    });
  const ids = {
    test: await buy(api.test, 'test',true),
    prod: await buy(api.prod, 'prod',true)
  };
  for (const stage of ['test', 'prod']) {
    await notify.main(notify.event(JSON.stringify(delivery(ids[stage]))));
    assert.equal((await api[stage]({
      action: 'challenge.activate'
    })).code, 0);
  }
  const op = {
    id: 'measurement123',
    key: 'measurement:2026-10-30',
    kind: 'measurement',
    baseVersion: 0,
    value: {
      date: '2026-10-30',
      weight: 70
    }
  };
  const session = {
    id: 'sessionop123',
    key: `session:${ids.test}:0`,
    kind: 'session',
    baseVersion: 0,
    value: {
      planId: ids.test,
      date: '2026-10-30',
      day: 0,
      status: 'completed',
      completedSets: 8,
      seconds: 900,
      difficulty: 'okay',
      discomfort: false
    }
  };
  const synced = await api.test({
    action: 'sync.batch',
    owner: 'same-user',
    operations: [op, session],
    stage: 'prod'
  });
  assert.ok(synced.data.results.every(r => r.status === 'ok'));
  assert.equal((await state(memory.scope('prod'))).records[op.key], undefined);
  assert.equal(b.publicState(await state(memory.scope('prod'))).records[session.key], undefined);
  assert.equal(d.report(await state(memory.scope('test'))).sessions, 1);
  await api.test({
    action: 'account.delete',
    confirm: 'DELETE',
    stage: 'prod'
  });
  assert.equal((await state(memory.scope('test'))).entitlement, null);
  assert.equal((await state(memory.scope('prod'))).entitlement.status, 'active');
});
test('each scheduler scans, queries and deduplicates only its own partition', async () => {
  const memory = memoryCloud(),
    now = Date.parse('2026-10-30T20:05:00+08:00'),
    queries = [],
    sends = [];
  for (const stage of ['test', 'prod']) {
    const scope = memory.scope(stage),
      id = partition.partition(stage).orderPrefix + 'b'.repeat(24);
    await scope.transact('same-user', s => {
      s.orders.push({
        id,
        status: 'pending',
        plan: d.makePlan(assessment),
        amount: 990
      });
      b.fulfill(s, id, 'wx-' + id);
      b.activate(s, now, 'secret');
      s.reminder = {
        enabled: true,
        time: '20:00'
      };
      s.orders.push({
        id: partition.partition(stage).orderPrefix + 'c'.repeat(24),
        status: 'pending'
      });
    });
  }
  memory.setContext({});
  for (const stage of ['test', 'prod']) {
    const job = loadEntry('reminderJob_' + stage, memory.scope(stage), {
      now,
      env: {
        REMINDER_TEMPLATE_ID: 'template'
      },
      platform: {
        query: async (user, id) => {
          queries.push({
            stage,
            id
          });
          return null;
        },
        send: async (user, task, actualStage) => {
          sends.push(actualStage);
        }
      }
    });
    assert.equal((await job({
      Type: 'Timer',
      stage: stage === 'test' ? 'prod' : 'test'
    })).stage, stage);
    await job({
      Type: 'Timer'
    });
  }
  assert.deepEqual(sends, ['test', 'prod']);
  assert.ok(queries.every(q => partition.orderStage(q.id) === q.stage));
  assert.equal((await state(memory.scope('test'))).notification['2026-10-30'].status, 'sent');
  assert.equal((await state(memory.scope('prod'))).notification['2026-10-30'].status, 'sent');
});
test('message target cannot direct test notifications to release, prod defaults formal and supports trial', () => {
  assert.equal(partition.messageState('test', 'formal'), 'developer');
  assert.equal(partition.messageState('prod'), 'formal');
  assert.equal(partition.messageState('prod', 'trial'), 'trial');
  assert.throws(() => partition.messageState('prod', 'developer'));
});
test('build and deployment target selection is explicit and test cannot select production functions', () => {
  assert.equal(build.entries().length, 5);
  assert.deepEqual(build.target('test').functions, ['coach_test', 'reminderJob_test']);
  assert.deepEqual(build.target('prod').functions, ['coach_prod', 'reminderJob_prod']);
  assert.deepEqual(build.target('callback').functions, ['paymentCallback']);
  assert.throws(() => build.target());
  assert.throws(() => build.target('all'));
  const script = path.join(__dirname, '../uploadCloudFunction.sh');
  const missing = cp.spawnSync('sh', [script], {
    encoding: 'utf8'
  });
  assert.equal(missing.status, 2);
  const plan = JSON.parse(cp.execFileSync('sh', [script, 'test', '--dry-run'], {
    encoding: 'utf8'
  }));
  assert.deepEqual(plan.functions, ['coach_test', 'reminderJob_test']);
  assert.equal(plan.cloudEnv, 'cloud1-d2glj4fu92e8f1497');
});

test('deployment script executes only test targets and rejects a different cloud environment', () => {
  const fs = require('fs'),
    os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boji-deploy-'));
  try {
    const log = path.join(dir, 'commands.jsonl'),
      cli = path.join(dir, 'fake cli');
    fs.writeFileSync(path.join(dir, 'npm'), '#!/bin/sh\nexit 0\n', {
      mode: 0o755
    });
    fs.writeFileSync(cli, '#!/usr/bin/env node\nrequire("fs").appendFileSync(process.env.DEPLOY_LOG,JSON.stringify(process.argv.slice(2))+"\\n");\n', {
      mode: 0o755
    });
    const env = {
      ...process.env,
      PATH: dir + path.delimiter + process.env.PATH,
      WECHAT_DEVTOOLS_CLI: cli,
      DEPLOY_LOG: log,
      WECHAT_CLOUD_ENV: build.manifest.cloudEnv
    };
    const script = path.join(__dirname, '../uploadCloudFunction.sh');
    const result = cp.spawnSync('sh', [script, 'test'], {
      env,
      encoding: 'utf8'
    });
    assert.equal(result.status, 0, result.stderr);
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(calls.map(args => args[args.indexOf('--n') + 1]), ['coach_test', 'reminderJob_test']);
    assert.ok(calls.every(args => args[args.indexOf('--e') + 1] === build.manifest.cloudEnv));
    fs.unlinkSync(log);
    const wrong = cp.spawnSync('sh', [script, 'test'], {
      env: {
        ...env,
        WECHAT_CLOUD_ENV: 'different-env'
      },
      encoding: 'utf8'
    });
    assert.equal(wrong.status, 2);
    assert.equal(fs.existsSync(log), false);
  } finally {
    fs.rmSync(dir, {
      recursive: true,
      force: true
    });
  }
});
