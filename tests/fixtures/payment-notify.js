const crypto = require('crypto'),
  fs = require('fs'),
  vm = require('vm'),
  path = require('path');

function fixture(runtime = {}, additions = {}) {
  const key = crypto.randomBytes(32),
    token = 'test-token',
    appid = 'wx-test',
    now = Math.floor(Date.now() / 1000).toString();
  const env = {
    MESSAGE_TOKEN: token,
    MESSAGE_AES_KEY: key.toString('base64').slice(0, -1),
    APP_ID: appid,
    ...additions
  };
  const sandbox = {
    require(name) {
      if (name === 'crypto') return crypto;
      if (name === './lib/runtime') return runtime;
      if (name === './lib/partition') return require('../../server/partition');
      if (name === './lib/business') return require('../../server/business');
      throw new Error(name);
    },
    exports: {},
    Buffer,
    process: {
      env
    },
    Date,
    console: {
      error() {}
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../cloudfunctions/paymentCallback/index.js'), 'utf8'), sandbox);

  function encrypt(message, receiver = appid) {
    const content = Buffer.from(message),
      len = Buffer.alloc(4);
    len.writeUInt32BE(content.length);
    let plain = Buffer.concat([crypto.randomBytes(16), len, content, Buffer.from(receiver)]);
    const pad = 32 - (plain.length % 32);
    plain = Buffer.concat([plain, Buffer.alloc(pad, pad)]);
    const cipher = crypto.createCipheriv('aes-256-cbc', key, key.subarray(0, 16));
    cipher.setAutoPadding(false);
    return Buffer.concat([cipher.update(plain), cipher.final()]).toString('base64');
  }

  function event(message, receiver) {
    const Encrypt = encrypt(message, receiver),
      nonce = 'nonce',
      msg_signature = crypto.createHash('sha1').update([token, now, nonce, Encrypt].sort().join('')).digest('hex');
    return {
      httpMethod: 'POST',
      body: JSON.stringify({
        Encrypt
      }),
      queryStringParameters: {
        timestamp: now,
        nonce,
        msg_signature
      }
    };
  }
  return {
    main: sandbox.exports.main,
    decode: sandbox.exports.decode,
    event
  };
}

module.exports = {
  fixture
};
