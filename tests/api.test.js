const {
  test
} = require('node:test'), assert = require('node:assert/strict'), vm = require('vm'), fs = require('fs'), crypto = require('crypto'), b = require('../server/business'), d = require('../shared/domain');

function apiFixture() {
  const accounts = new Map();
  let current = 'user-a';
  const runtime = {
    stage: 'prod',
    sourceVersion: 'test-version',
    tables: {
      orders: 'coach_order_index'
    },
    cloud: {
      getWXContext: () => ({
        OPENID: current
      })
    },
    db: {
      collection: () => ({
        doc: () => ({
          set: async () => {}
        })
      })
    },
    clearGuidance:async()=>{},
    auxTransact:async(id,key,fn)=>fn({},accounts.get(id)||b.fresh()),
    transact: async (id, fn) => {
      const state = JSON.parse(JSON.stringify(accounts.get(id) || b.fresh()));
      const out = await fn(state);
      accounts.set(id, state);
      return out;
    }
  };
  const exports = {};
  vm.runInNewContext(fs.readFileSync(require.resolve('../cloudfunctions/coach_prod/index.js'), 'utf8'), {
    exports,
    process: {
      env: {
        ENTITLEMENT_SECRET: 'secret',
        PAY_PRODUCT_ID: 'product', PAY_PRODUCT_MONTH:'month-product'
      }
    },
    Date,
    console,
    require(p) {
      if (p === './lib/runtime') return runtime;
      if (p === './lib/business') return {
        ...b,
        config: () => ({
          catalog:require('../shared/guidance').catalogForStage(runtime.stage),
          paymentsEnabled: true,membershipEnabled:true,nutritionReviewed:true,
          contentPublished: true,
          media: {}
        })
      };
      if (p === './lib/domain') return d;
      if (p === './lib/payment-products') return require('../server/payment-products');
      if (p === './lib/profile') return require('../server/profile');
      if (p === './lib/avatar') return {
        verify: async () => true
      };
      if (p === './lib/partition') return require('../server/partition');
      if (p === './lib/platform') return {
        payData: async () => ({
          test: true
        }),
        query: async () => null
      };
      if (p === './lib/guidance') return require('../shared/guidance');
      if (p === './lib/daily-ai') return require('../server/daily-ai');
      if (p === 'crypto') return crypto;
      throw new Error(p);
    }
  });
  return {
    call: exports.main,
    accounts,
    identity: id => {
      current = id;
    }
  };
}
const assessment = {
  schemaVersion:2,sex:'male',height:175,weight:70,waist:'',activity:'light',frequency:3,weekdays:[1,3,5],foodScene:'takeout',foodObstacle:'irregular',diet:'none',allergies:'',
  age: 28,
  goal: 'habit',
  experience: 'beginner',
  minutes: 15,
  equipment: 'none',
  screening: 'clear',
  consent: true
};
test('cloud endpoint ignores caller-supplied identity, price and entitlement', async () => {
  const f = apiFixture();
  let r = await f.call({
    action: 'purchase.create',sku:'month',
    assessment,
    code: 'fake-code',
    amount: 1,
    userId: 'user-b',
    paid: true
  });
  assert.equal(r.code, 0);
  assert.equal(r.data.order.amount, 1900);
  const id = r.data.order.id;
  assert.equal(f.accounts.get('user-a').entitlement, null);
  f.identity('user-b');
  r = await f.call({
    action: 'purchase.status',
    orderId: id,
    userId: 'user-a'
  });
  assert.notEqual(r.code, 0);
  f.identity('');
  assert.equal((await f.call({
    action: 'bootstrap'
  })).code, 'UNAUTHORIZED');
});
test('deletion removes all health content while retaining redacted transaction metadata', async () => {
  const f = apiFixture();
  await f.call({
    action: 'purchase.create',sku:'month',
    assessment,
    code: 'code'
  });
  const s = f.accounts.get('user-a');
  b.fulfill(s, s.orders[0].id, 'wx1');
  s.records.x = {
    kind: 'assessment',
    value: assessment
  };
  let r = await f.call({
    action: 'account.delete',
    confirm: 'NO'
  });
  assert.notEqual(r.code, 0);
  r = await f.call({
    action: 'account.delete',
    confirm: 'DELETE'
  });
  assert.equal(r.code, 0);
  const deleted = f.accounts.get('user-a');
  assert.equal(Object.keys(deleted.records).length, 0);
  assert.equal(deleted.entitlement, null);
  assert.equal(deleted.orders[0].plan, undefined);
  assert.equal(deleted.orders[0].redacted, true);
});
test('sync cannot send a previous account queue under a different authenticated identity', async () => {
  const f = apiFixture();
  f.identity('user-b');
  const r = await f.call({
    action: 'sync.batch',
    owner: 'user-a',
    operations: []
  });
  assert.equal(r.code, 'ACCOUNT_CHANGED');
});
