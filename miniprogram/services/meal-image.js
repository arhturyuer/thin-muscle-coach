const limit = 600 * 1024 * 4 / 3;

function file(method, options) {
  return new Promise((resolve, reject) => wx.getFileSystemManager()[method]({
    ...options, success: resolve, fail: reject
  }));
}

async function read(path) {
  try {
    const {data} = await file('readFile', {filePath: path, encoding: 'base64'});
    if (typeof data !== 'string') throw new Error('Invalid file data');
    return data;
  } catch {
    throw Object.assign(new Error('无法读取本机照片，请重新选择照片'), {code: 'PHOTO_FILE_UNREADABLE'});
  }
}

function mime(data) {
  if (data.startsWith('/9j/')) return 'jpeg';
  if (data.startsWith('iVBORw0KGgo')) return 'png';
  return null;
}

function imageUrl(data) {
  const type = mime(data);
  if (!type) throw Object.assign(new Error('无法处理此照片格式，请选择 JPG 或 PNG 照片'), {code: 'INVALID'});
  if (data.length > limit) throw Object.assign(new Error('照片压缩后仍超过 600 KB，请裁剪或重新拍摄'), {code: 'INVALID'});
  return `data:image/${type};base64,${data}`;
}

async function prepare(src, sizes) {
  let info;
  try {
    info = await wx.getImageInfo({src});
  } catch {
    throw new Error('无法打开本机照片，请重新选择照片');
  }
  const axis = info.width >= info.height ? 'compressedWidth' : 'compressedHeight';
  const longEdge = Math.max(info.width, info.height);
  let data;
  for (const [size, quality] of sizes) {
    let compressed;
    try {
      compressed = await wx.compressImage({src, quality, [axis]: Math.min(size, longEdge)});
    } catch {
      throw new Error('本机照片压缩失败，请重新选择照片');
    }
    data = await read(compressed.tempFilePath);
    if (data.length <= limit && mime(data)) return {path: compressed.tempFilePath, data};
  }
  imageUrl(data);
}

async function copyForSave(path, id) {
  try {
    const destPath = `${wx.env.USER_DATA_PATH}/meal-save-${id}`;
    await file('copyFile', {srcPath: path, destPath});
    return destPath;
  } catch {
    throw new Error('无法写入本机照片副本，请检查可用存储空间后重试');
  }
}

module.exports = {read, prepare, imageUrl, copyForSave};
