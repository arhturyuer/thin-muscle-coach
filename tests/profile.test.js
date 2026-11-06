const {
  test
} = require('node:test'), assert = require('node:assert/strict'), profile = require('../server/profile'), account = require('../shared/account'), b = require('../server/business'), d = require('../shared/domain'), {
  memoryCloud,
  loadEntry
} = require('./fixtures/cloud-runtime');

function fresh() {
  const s = b.fresh();
  profile.ensure(s);
  return s;
}

function edit(s, nickname = '新昵称', extra = {}) {
  return {
    nickname,
    baseVersion: s.profile.version,
    requestId: 'request' + Math.random().toString(36).slice(2),
    ...extra
  };
}
test('legacy account gains default profile without replacing orders or training', () => {
  const s = fresh();
  delete s.profile;
  s.orders.push({
    id: 'existing-order'
  });
  s.records.training = {
    value: 'keep'
  };
  profile.ensure(s);
  assert.equal(s.profile.nickname, '薄肌学员');
  assert.equal(s.profile.avatarFileId, null);
  assert.equal(s.orders[0].id, 'existing-order');
  assert.equal(s.records.training.value, 'keep');
});
test('nickname normalization supports Chinese and emoji, rejects blank, long and control characters', () => {
  assert.equal(account.normalizeNickname('  小明🌱  '), '小明🌱');
  for (const value of ['   ', '名'.repeat(21), '换\n行', null]) assert.throws(() => account.normalizeNickname(value));
});
test('profile updates are idempotent and do not change business records', () => {
  const s = fresh();
  s.orders.push({
    id: 'paid',
    status: 'paid'
  });
  const input = edit(s, '  小明  ');
  assert.equal(profile.commit(s, 'u1', 'test', input).status, 'saved');
  assert.equal(s.profile.nickname, '小明');
  const version = s.profile.version;
  profile.commit(s, 'u1', 'test', input);
  assert.equal(s.profile.version, version);
  assert.equal(s.orders[0].status, 'paid');
  assert.throws(() => profile.commit(s, 'u1', 'test', {
    ...input,
    nickname: 'different'
  }));
});
test('stale version returns conflict instead of overwriting new profile', () => {
  const s = fresh(),
    first = edit(s, '设备一'),
    stale = edit(s, '设备二');
  profile.commit(s, 'u1', 'test', first);
  const r = profile.commit(s, 'u1', 'test', stale);
  assert.equal(r.status, 'conflict');
  assert.equal(r.profile.nickname, '设备一');
});
test('avatar credentials bind owner, stage, file and expiration', () => {
  const s = fresh(),
    ticket = profile.prepare(s, 'u1', 'test', 'png', 1000);
  assert.match(ticket.path, /^test\/avatars\/[a-f0-9]{64}\/[a-f0-9]{32}\.png$/);
  const input = edit(s, '头像用户', {
    avatarUploadId: ticket.id,
    avatarFileId: ticket.fileId
  });
  for (const [user, stage] of [
      ['u2', 'test'],
      ['u1', 'prod']
    ]) assert.throws(() => profile.inspect(s, user, stage, input, 2000));
  assert.throws(() => profile.inspect(s, 'u1', 'test', {
    ...input,
    avatarFileId: ticket.fileId + 'x'
  }, 2000));
  assert.throws(() => profile.inspect(s, 'u1', 'test', input, ticket.expiresAt));
  assert.equal(profile.inspect(s, 'u1', 'test', input, 2000).status, 'ready');
});
test('avatar replacement queues only the old file; failed cleanup retries without losing saved profile', async () => {
  const memory = memoryCloud(),
    scope = memory.scope('test');
  let old, newId;
  await scope.transact('u1', s => {
    const a = profile.prepare(s, 'u1', 'test', 'png');
    profile.commit(s, 'u1', 'test', edit(s, '用户', {
      avatarUploadId: a.id,
      avatarFileId: a.fileId
    }));
    old = a.fileId;
    const next = profile.prepare(s, 'u1', 'test', 'png');
    profile.commit(s, 'u1', 'test', edit(s, '用户', {
      avatarUploadId: next.id,
      avatarFileId: next.fileId
    }));
    newId = next.fileId;
  });
  scope.cloud.deleteFile = async () => {
    throw new Error('network');
  };
  assert.equal(await profile.cleanup(scope, 'u1'), 0);
  let saved = await scope.transact('u1', s => s);
  assert.equal(saved.profile.avatarFileId, newId);
  assert.equal(saved.avatarGarbage[0].fileId, old);
  scope.cloud.deleteFile = async ({
    fileList
  }) => ({
    fileList: fileList.map(fileID => ({
      fileID,
      status: 0
    }))
  });
  assert.equal(await profile.cleanup(scope, 'u1'), 1);
  saved = await scope.transact('u1', s => s);
  assert.equal(saved.avatarGarbage.length, 0);
  assert.equal(saved.profile.avatarFileId, newId);
});
test('expired uploads are cleaned independently of reminder subscriptions', async () => {
  const memory = memoryCloud(),
    scope = memory.scope('test');
  await scope.transact('u1', s => profile.prepare(s, 'u1', 'test', 'png', 1000));
  const deleted = [];
  scope.cloud.deleteFile = async ({
    fileList
  }) => {
    deleted.push(...fileList);
    return {
      fileList: fileList.map(fileID => ({
        fileID,
        status: 0
      }))
    };
  };
  await profile.cleanup(scope, 'u1', 1000 + 16 * 60000);
  assert.equal(deleted.length, 1);
  const s = await scope.transact('u1', s => s);
  assert.equal(s.avatarUploads.length, 0);
  assert.equal(s.reminder.enabled, false);
});
test('resetting profile queues own avatars and leaves records and paid orders for account deletion policy', () => {
  const s = fresh(),
    ticket = profile.prepare(s, 'u1', 'prod', 'jpg');
  profile.commit(s, 'u1', 'prod', edit(s, '用户', {
    avatarUploadId: ticket.id,
    avatarFileId: ticket.fileId
  }));
  s.records.keep = {};
  profile.reset(s);
  assert.equal(s.profile.nickname, '薄肌学员');
  assert.equal(s.profile.avatarFileId, null);
  assert.equal(s.avatarGarbage[0].fileId, ticket.fileId);
  assert.ok(s.records.keep);
});
test('test and production profile endpoints remain isolated and reject foreign avatar references', async () => {
  const memory = memoryCloud(),
    testApi = loadEntry('coach_test', memory.scope('test')),
    prodApi = loadEntry('coach_prod', memory.scope('prod'));
  const boot = await testApi({
    action: 'bootstrap'
  });
  assert.equal(boot.data.state.profile.nickname, '薄肌学员');
  assert.equal(boot.data.config.profileEditingSupported, true);
  const prepared = await testApi({
    action: 'profile.avatar.prepare',
    extension: 'png',
    stage: 'prod'
  });
  assert.match(prepared.data.path, /^test\//);
  const foreign = await prodApi({
    action: 'profile.update',
    nickname: '用户',
    baseVersion: 0,
    requestId: 'foreign123',
    avatarUploadId: prepared.data.id,
    avatarFileId: prepared.data.fileId
  });
  assert.notEqual(foreign.code, 0);
  const saved = await testApi({
    action: 'profile.update',
    nickname: '测试学员',
    baseVersion: 0,
    requestId: 'profile123'
  });
  assert.equal(saved.data.status, 'saved');
  assert.equal((await prodApi({
    action: 'bootstrap'
  })).data.state.profile.nickname, '薄肌学员');
});
test('server rejects non-image data signatures', () => {
  const {
    format
  } = require('../server/avatar');
  assert.equal(format(Buffer.from('not an image')), null);
  assert.equal(format(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'png');
  assert.equal(format(Buffer.from([255, 216, 255, 0])), 'jpg');
});
