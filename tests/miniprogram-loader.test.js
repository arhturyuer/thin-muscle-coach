const {
  test
} = require('node:test'), assert = require('node:assert/strict'), fs = require('fs'), path = require('path'), vm = require('vm');
const root = path.resolve(__dirname, '../miniprogram');
// WeChat's loader resolves application modules to JavaScript; Node's JSON loader is deliberately unavailable.
function boot(version) {
  const cache = new Map(),
    storage = new Map();
  let app;
  const wx = {
    getAccountInfoSync: () => ({
      miniProgram: {
        envVersion: version
      }
    }),
    getStorageSync: k => storage.get(k),
    setStorageSync: (k, v) => storage.set(k, v),
    onNetworkStatusChange() {},
    getNetworkType({
      success
    }) {
      success({
        networkType: 'wifi'
      });
    }
  };

  function load(file) {
    if (!file.endsWith('.js')) file += '.js';
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) throw new Error('MiniProgram module is not defined: ' + path.relative(root, file));
    if (cache.has(file)) return cache.get(file).exports;
    const module = {
      exports: {}
    };
    cache.set(file, module);
    const context = {
      module,
      exports: module.exports,
      wx,
      App: value => {
        app = value;
      },
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      console,
      require: request => {
        assert.ok(request.startsWith('.'), 'Only bundled relative modules may be required');
        return load(path.resolve(path.dirname(file), request));
      }
    };
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), context, {
      filename: file
    });
    return module.exports;
  }
  load(path.join(root, 'app.js'));
  app.onLaunch();
  return {
    load,
    app,
    storage
  };
}
test('mini program startup loads JS-only dependencies and selects the correct service partition', () => {
  for (const [version, expected] of [
      ['develop', 'test'],
      ['trial', 'prod'],
      ['release', 'prod']
    ]) {
    const runtime = boot(version);
    assert.ok(runtime.app);
    const release = runtime.load(path.join(root, 'core/release.js'));
    assert.equal(release.current().stage, expected);
    const store = runtime.load(path.join(root, 'core/store.js'));
    assert.equal(store.get().owner, 'guest');
    assert.ok(runtime.storage.has('coach:' + expected + ':owner'));
  }
});
