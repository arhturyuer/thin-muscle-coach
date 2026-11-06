const b = require('../../server/business'),
  d = require('../../shared/domain');

function service() {
  let state = b.fresh(),
    counter = 0;
  const cfg = {
    eventKeysSupported: true,
    profileEditingSupported: true,
    paymentsEnabled: true,
    contentPublished: true,
    reminderTemplateId: 'approved-template',
    iosEnabled: true,
    media: {}
  };
  return {
    state: () => state,
    confirm(id) {
      b.fulfill(state, id, 'platform-' + id);
    },
    async invoke(action, data) {
      if (action === 'bootstrap') return {
        userId: 'user-a',
        state: b.publicState(state),
        config: cfg
      };
      if (action === 'profile.avatar.prepare') return require('../../server/profile').prepare(state, 'user-a', 'prod', data.extension);
      if (action === 'profile.update') return require('../../server/profile').commit(state, 'user-a', 'prod', data);
      if (action === 'sync.batch') return {
        results: b.applyBatch(state, data.operations),
        state: b.publicState(state)
      };
      if (action === 'purchase.create') {
        let order = state.orders.find(o => o.status === 'pending');
        if (!order) {
          order = {
            id: 'testorder' + (++counter),
            status: 'pending',
            amount: 990,
            plan: d.makePlan(data.assessment)
          };
          state.orders.push(order);
        }
        return {
          order: {
            ...order
          },
          payData: {
            testOrderId: order.id
          }
        };
      }
      if (action === 'purchase.status') return {
        order: state.orders.find(o => o.id === data.orderId),
        state: b.publicState(state)
      };
      if (action === 'challenge.activate') return {
        entitlement: b.activate(state, Date.now(), 'test-secret')
      };
      if (action === 'reminder.update') {
        state.reminder = {
          enabled: data.enabled,
          time: data.time
        };
        return {
          reminder: state.reminder
        };
      }
      if (action === 'account.delete') {
        state = b.fresh();
        return {
          deleted: true
        };
      }
      throw new Error('Unknown fixture action');
    }
  };
}

function loadPage(name) {
  let definition;
  global.Page = page => {
    definition = page;
  };
  const file = require.resolve('../../miniprogram/pages/' + name + '/index.js');
  delete require.cache[file];
  require(file);
  delete global.Page;
  return {
    ...definition,
    data: structuredClone(definition.data || {}),
    setData(patch) {
      for (const [key, value] of Object.entries(patch)) {
        const keys = key.replace(/\[(\d+)\]/g, '.$1').split('.');
        let node = this.data;
        for (const k of keys.slice(0, -1)) {
          if (!node[k]) node[k] = {};
          node = node[k];
        }
        node[keys[keys.length - 1]] = value;
      }
    }
  };
}
module.exports = {
  service,
  loadPage
};
