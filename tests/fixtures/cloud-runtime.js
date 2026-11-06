const fs = require('fs'),
  vm = require('vm'),
  path = require('path'),
  b = require('../../server/business'),
  d = require('../../shared/domain'),
  {
    createRuntime
  } = require('../../server/runtime-factory');

function memoryCloud() {
  const collections = new Map();
  let ctx = {
    OPENID: 'same-user'
  };
  const clone = v => JSON.parse(JSON.stringify(v));
  const bucket = name => {
    if (!collections.has(name)) collections.set(name, new Map());
    return collections.get(name);
  };

  function field(row, key) {
    return key.split('.').reduce((v, k) => v && v[k], row);
  }

  function query(name, filter = {}, limit = 100, sort) {
    return {
      doc(id) {
        return {
          async get() {
            const value = bucket(name).get(id);
            if (!value) throw new Error('document not found');
            return {
              data: clone(value)
            };
          },
          async remove(){bucket(name).delete(id);},
          async set({
            data
          }) {
            bucket(name).set(id, clone({
              ...data,
              _id: id
            }));
          }
        };
      },
      where(value) {
        return query(name, {
          ...filter,
          ...value
        }, limit, sort);
      },
      orderBy(key, direction) {
        return query(name, filter, limit, {
          key,
          direction
        });
      },
      limit(n) {
        return query(name, filter, n, sort);
      },
      async get() {
        let data = [...bucket(name).values()].filter(row => Object.entries(filter).every(([key, value]) => value && value.$gt !== undefined ? field(row, key) > value.$gt : field(row, key) === value));
        if (sort) data.sort((a, b) => String(a[sort.key]).localeCompare(String(b[sort.key])) * (sort.direction === 'desc' ? -1 : 1));
        return {
          data: clone(data.slice(0, limit))
        };
      }
    };
  }
  const db = {
    collection: name => query(name),
    command: {
      gt: value => ({
        $gt: value
      })
    },
    runTransaction: fn => fn(db)
  };
  const cloud = {
    database: () => db,
    getWXContext: () => ctx
  };
  return {
    cloud,
    db,
    collections,
    setContext: value => {
      ctx = value;
    },
    scope: stage => ({
      ...createRuntime(cloud, stage),
      sourceVersion: 'test-build'
    })
  };
}

function loadEntry(name, runtime, options = {}) {
  const env = {
    APP_ID: 'wx-test',
    PAY_PRODUCT_ID: 'same-product',
    PAY_PRODUCT_MONTH:'same-product',PAY_PRODUCT_YEAR:'year-product',PAY_PRODUCT_THREE_YEAR:'three-product',
    ENTITLEMENT_SECRET: 'stage-secret-' + runtime.stage,
    ...options.env
  };
  const exports = {};
  const platform = {
    query: async () => null,
    payData: async () => ({
      testOnly: true
    }),
    messageState: require('../../server/partition').messageState,
    send: async () => {},
    ...options.platform
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../cloudfunctions', name, 'index.js'), 'utf8'), {
    exports,
    Buffer,
    console,
    Date: options.now ? {
      now: () => options.now
    } : Date,
    process: {
      env
    },
    require(p) {
      if (p === './lib/runtime') return runtime;
      if (p === './lib/business') return {
        ...b,
        config: () => options.realConfig?b.config(env,runtime.stage):({
          catalog:require('../../server/guided').config(env,runtime.stage).catalog,
          paymentsEnabled: true,
          membershipEnabled:true,nutritionReviewed:true,aiEnabled:true,
          contentPublished: true,
          reminderTemplateId: 'approved',
          media: {}
        })
      };
      if (p === './lib/domain') return d;
      if (p === './lib/setup-status') return require('../../server/setup-status');
      if (p === './lib/payment-reconcile') return require('../../server/payment-reconcile');
      if (p === './lib/payment-products') return require('../../server/payment-products');
      if (p === './lib/profile') return require('../../server/profile');
      if (p === './lib/avatar') return {
        verify: async () => true
      };
      if (p === './lib/platform') return platform;
      if (p === './lib/partition') return require('../../server/partition');
      if (p === './lib/guidance') return require('../../shared/guidance');
      if (p === './lib/daily-ai') return require('../../server/daily-ai');
      if (p === './lib/guided') return require('../../server/guided');
      if (p === './lib/workout-plan') return require('../../server/workout-plan');
      if (p === 'crypto') return require('crypto');
      throw new Error(p);
    }
  });
  return exports.main;
}
module.exports = {
  memoryCloud,
  loadEntry
};
