const crypto = require('crypto'),
  account = require('./account'),
  {
    partition
  } = require('./partition'),
  manifest = require('./stages.json');

function invalid(message) {
  const e = new Error(message);
  e.code = 'INVALID';
  throw e;
}

function ensure(s) {
  if (!s.profile) {
    s.profile = account.defaultProfile();
    s.revision++;
  }
  if (!s.avatarUploads) s.avatarUploads = [];
  if (!s.avatarGarbage) s.avatarGarbage = [];
  if (!s.profileReceipts) s.profileReceipts = [];
  return s.profile;
}

function ownerKey(userId) {
  return crypto.createHash('sha256').update(userId).digest('hex');
}

function owned(fileId, userId, stage) {
  return typeof fileId === 'string' && !!manifest.storageFilePrefix && fileId.startsWith(manifest.storageFilePrefix + partition(stage).storagePrefix + 'avatars/' + ownerKey(userId) + '/') && /\/[a-f0-9]{32}\.(jpg|png)$/.test(fileId);
}

function garbage(s, fileId, now) {
  if (fileId && !s.avatarGarbage.some(x => x.fileId === fileId)) s.avatarGarbage.push({
    fileId,
    dueAt: now
  });
}

function expireUploads(s, now) {
  ensure(s);
  for (const u of s.avatarUploads)
    if (u.expiresAt <= now && u.fileId !== s.profile.avatarFileId) garbage(s, u.fileId, now);
  s.avatarUploads = s.avatarUploads.filter(u => u.expiresAt > now);
}

function prepare(s, userId, stage, extension, now = Date.now()) {
  ensure(s);
  expireUploads(s, now);
  if (!['jpg', 'png'].includes(extension)) invalid('头像仅支持 JPG、PNG 图片');
  if (!manifest.storageFilePrefix) invalid('头像上传暂未开放，请稍后再试');
  if (s.avatarUploads.length >= 8) invalid('头像操作较频繁，请稍后再试');
  const id = crypto.randomBytes(16).toString('hex');
  const path = partition(stage).storagePrefix + 'avatars/' + ownerKey(userId) + '/' + id + '.' + extension;
  const ticket = {
    id,
    path,
    fileId: manifest.storageFilePrefix + path,
    expiresAt: now + 15 * 60000,
    extension
  };
  s.avatarUploads.push(ticket);
  return {
    ...ticket
  };
}

function fingerprint(input) {
  return crypto.createHash('sha256').update(JSON.stringify([input.nickname, input.baseVersion, input.avatarUploadId || null, input.avatarFileId || null, !!input.resetAvatar])).digest('hex');
}

function inspect(s, userId, stage, input, now = Date.now()) {
  ensure(s);
  let nickname;
  try {
    nickname = account.normalizeNickname(input.nickname);
  } catch (e) {
    e.code = 'INVALID';
    throw e;
  }
  if (!/^[a-zA-Z0-9-]{5,80}$/.test(input.requestId || '')) invalid('保存请求无效，请重新保存');
  if (!Number.isInteger(input.baseVersion) || input.baseVersion < 0) invalid('资料版本无效，请重新打开编辑页');
  const receipt = s.profileReceipts.find(r => r.id === input.requestId);
  if (receipt) {
    if (receipt.hash !== fingerprint(input)) invalid('保存请求已变化，请重新保存');
    return {
      status: s.profile.version === receipt.version ? 'saved' : 'conflict',
      profile: s.profile
    };
  }
  if (s.profile.version !== input.baseVersion) return {
    status: 'conflict',
    profile: s.profile
  };
  let upload = null;
  if (input.resetAvatar && input.avatarUploadId) invalid('请选择新头像或默认头像');
  if (input.avatarUploadId) {
    upload = s.avatarUploads.find(u => u.id === input.avatarUploadId);
    if (!upload || upload.expiresAt <= now || upload.fileId !== input.avatarFileId || !owned(upload.fileId, userId, stage)) invalid('头像上传凭据已失效，请重新选择头像');
  } else if (input.avatarFileId && input.avatarFileId !== s.profile.avatarFileId) invalid('无法使用此头像，请重新选择');
  return {
    status: 'ready',
    nickname,
    upload
  };
}

function commit(s, userId, stage, input, now = Date.now()) {
  const result = inspect(s, userId, stage, input, now);
  if (result.status !== 'ready') return result;
  const old = s.profile.avatarFileId,
    newId = input.resetAvatar ? null : result.upload ? result.upload.fileId : old;
  s.profile = {
    nickname: result.nickname,
    avatarFileId: newId,
    version: s.profile.version + 1,
    updatedAt: now
  };
  s.revision++;
  if (old && old !== newId) garbage(s, old, now);
  if (result.upload) s.avatarUploads = s.avatarUploads.filter(u => u.id !== result.upload.id);
  s.profileReceipts.push({
    id: input.requestId,
    hash: fingerprint(input),
    version: s.profile.version
  });
  s.profileReceipts = s.profileReceipts.slice(-20);
  return {
    status: 'saved',
    profile: s.profile
  };
}

function reset(s, now = Date.now()) {
  ensure(s);
  garbage(s, s.profile.avatarFileId, now);
  for (const u of s.avatarUploads) garbage(s, u.fileId, now);
  s.avatarUploads = [];
  s.profileReceipts = [];
  s.profile = {
    ...account.defaultProfile(),
    version: s.profile.version + 1,
    updatedAt: now
  };
}
async function cleanup(runtime, userId, now = Date.now()) {
  const {
    cloud,
    stage,
    transact
  } = runtime;
  const pending = await transact(userId, s => {
    expireUploads(s, now);
    return s.avatarGarbage.filter(x => x.dueAt <= now && x.fileId !== s.profile.avatarFileId && owned(x.fileId, userId, stage)).slice(0, 20);
  });
  if (!pending.length) return 0;
  try {
    const result = await cloud.deleteFile({
      fileList: pending.map(x => x.fileId)
    });
    const removed = new Set((result.fileList || []).filter(x => x.status === 0 || x.code === 'SUCCESS').map(x => x.fileID));
    await transact(userId, s => {
      ensure(s);
      s.avatarGarbage = s.avatarGarbage.filter(x => !removed.has(x.fileId));
    });
    return removed.size;
  } catch (e) {
    return 0;
  }
}
module.exports = {
  ensure,
  owned,
  prepare,
  inspect,
  commit,
  reset,
  cleanup,
  expireUploads
};
