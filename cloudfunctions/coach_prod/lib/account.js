const DEFAULT_NICKNAME = '薄肌学员';

function defaultProfile() {
  return {
    nickname: DEFAULT_NICKNAME,
    avatarFileId: null,
    version: 0,
    updatedAt: null
  };
}

function normalizeNickname(value) {
  if (typeof value !== 'string') throw new Error('请输入昵称');
  const name = value.trim();
  if (!name) throw new Error('请输入昵称');
  if (Array.from(name).length > 20) throw new Error('昵称最多 20 个字符');
  if (/[\u0000-\u001f\u007f]/.test(name)) throw new Error('昵称不能包含换行或控制字符');
  return name;
}
const MAX_AVATAR_SIZE = 2 * 1024 * 1024;
module.exports = {
  DEFAULT_NICKNAME,
  defaultProfile,
  normalizeNickname,
  MAX_AVATAR_SIZE
};
