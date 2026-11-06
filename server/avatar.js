const https = require('https'),
  {
    MAX_AVATAR_SIZE
  } = require('./account');

function format(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpg';
  return null;
}
async function verify(cloud, ticket) {
  const r = await cloud.getTempFileURL({
    fileList: [ticket.fileId]
  });
  const item = (r.fileList || []).find(x => x.fileID === ticket.fileId && x.status === 0);
  if (!item || !/^https:\/\//.test(item.tempFileURL)) throw new Error('头像尚未上传完成，请重试');
  const bytes = await new Promise((resolve, reject) => {
    const req = https.get(item.tempFileURL, res => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error('头像读取失败，请重试'));
        return;
      }
      if (Number(res.headers['content-length']) > MAX_AVATAR_SIZE) {
        res.destroy();
        reject(new Error('头像最大支持 2 MB'));
        return;
      }
      const chunks = [];
      let size = 0;
      res.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_AVATAR_SIZE) {
          res.destroy();
          reject(new Error('头像最大支持 2 MB'));
        } else chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.setTimeout(8000, () => req.destroy(new Error('头像读取超时，请重试')));
    req.on('error', reject);
  });
  if (!bytes.length || format(bytes) !== ticket.extension) throw new Error('头像格式不正确，请重新选择 JPG 或 PNG 图片');
  return true;
}
module.exports = {
  verify,
  format
};
