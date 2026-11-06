const store = require('../core/store'),
  api = require('./api'),
  repo = require('./repository'),
  account = require('../shared/account'),
  feedback = require('../core/feedback');
const DEFAULT_AVATAR = '/assets/icons/profile-active.png';
async function refreshAvatar() {
  const s = store.get(),
    id = s.profile && s.profile.avatarFileId;
  if (!id) {
    store.save({
      avatarDisplay: null
    });
    return;
  }
  if (s.avatarDisplay && s.avatarDisplay.fileId === id && s.avatarDisplay.expiresAt > Date.now()) return;
  if (!s.online || !wx.cloud) return;
  try {
    const result = await wx.cloud.getTempFileURL({
      fileList: [id]
    });
    const item = (result.fileList || []).find(x => x.fileID === id && x.status === 0);
    if (item && item.tempFileURL && store.get().profile.avatarFileId === id) store.save({
      avatarDisplay: {
        fileId: id,
        url: item.tempFileURL,
        expiresAt: Date.now() + 50 * 60000
      }
    });
  } catch (e) {
    /* The default avatar remains available when media fails. */ }
}

function fileInfo(file) {
  return new Promise((resolve, reject) => wx.getFileSystemManager().getFileInfo({
    filePath: file,
    success: resolve,
    fail: reject
  }));
}
async function saveProfile(draft, baseVersion, attempt = {}) {
  const nickname = account.normalizeNickname(draft.nickname),
    s = store.get();
  if (!s.online) throw new Error('当前离线，资料草稿已保留，请联网后保存');
  if (s.owner === 'guest') {
    await require('./syncService').bootstrap(true);
    if (store.get().owner === 'guest') throw new Error('暂时无法连接微信账号，请稍后重试');
  }
  if (!store.get().config.profileEditingSupported) throw new Error('资料修改暂未开放，请稍后重试');
  await feedback.requirePrivacy();
  const owner = store.get().owner,
    stage = require('../core/release').stage();
  const key = JSON.stringify([nickname, draft.avatarTemp || '', !!draft.resetAvatar, baseVersion]);
  if (attempt.key !== key) {
    attempt.key = key;
    attempt.requestId = repo.id();
  }
  let ticket = null;
  if (draft.avatarTemp) {
    if (attempt.file === draft.avatarTemp && attempt.ticket && attempt.ticket.expiresAt > Date.now()) ticket = attempt.ticket;
    else {
      const info = await fileInfo(draft.avatarTemp);
      if (info.size > account.MAX_AVATAR_SIZE) throw new Error('头像最大支持 2 MB');
      const image = await wx.getImageInfo({
        src: draft.avatarTemp
      });
      const extension = image.type === 'jpeg' || image.type === 'jpg' ? 'jpg' : image.type === 'png' ? 'png' : null;
      if (!extension) throw new Error('头像仅支持 JPG、PNG 图片');
      ticket = await api.call('profile.avatar.prepare', {
        extension
      });
      const uploaded = await wx.cloud.uploadFile({
        cloudPath: ticket.path,
        filePath: draft.avatarTemp
      });
      if (uploaded.fileID !== ticket.fileId) throw new Error('头像上传结果不一致，请重试');
      attempt.file = draft.avatarTemp;
      attempt.ticket = ticket;
    }
  }
  if (store.get().owner !== owner || require('../core/release').stage() !== stage) throw new Error('账号已变化，请重新打开编辑页');
  const result = await api.call('profile.update', {
    nickname,
    baseVersion,
    requestId: attempt.requestId,
    resetAvatar: !!draft.resetAvatar,
    ...(ticket ? {
      avatarUploadId: ticket.id,
      avatarFileId: ticket.fileId
    } : {})
  });
  if(store.get().owner!==owner||require('../core/release').stage()!==stage)throw new Error('账号已变化，请重新打开编辑页');
  if (result.profile && store.get().profile && result.profile.version<store.get().profile.version)return {status:'conflict',profile:store.get().profile};
  if (result.status === 'saved' || result.status === 'conflict') {
    store.save({
      profile: result.profile
    });
    await refreshAvatar();
  }
  return result;
}
module.exports = {
  DEFAULT_AVATAR,
  refreshAvatar,
  saveProfile
};
