// Read just ISO BMFF metadata with Range requests. In particular, never call
// getVideoInfo/downloadFile for streamed video: those can wait for the full file.
const MAX_METADATA = 2 * 1024 * 1024;
function type(view, offset) { return String.fromCharCode(...new Uint8Array(view.buffer, view.byteOffset + offset, 4)); }
function atom(view, offset) {
  if (offset + 8 > view.byteLength) return null;
  let size = view.getUint32(offset), header = 8;
  if (size === 1) { if (offset + 16 > view.byteLength) return null; size = view.getUint32(offset + 8) * 4294967296 + view.getUint32(offset + 12); header = 16; }
  return { size, header, kind: type(view, offset + 4), offset };
}
function inspectMoov(bytes) {
  const view = new DataView(bytes); let duration, hasAudio = false;
  function walk(start, end) {
    for (let offset = start; offset + 8 <= end;) {
      const box = atom(view, offset); if (!box || box.size < box.header || offset + box.size > end) throw new Error('无效 MP4 索引');
      const payload = offset + box.header;
      if (box.kind === 'mvhd') {
        const version = view.getUint8(payload), scaleOffset = payload + (version === 1 ? 20 : 12);
        const scale = view.getUint32(scaleOffset);
        const count = version === 1 ? view.getUint32(scaleOffset + 4) * 4294967296 + view.getUint32(scaleOffset + 8) : view.getUint32(scaleOffset + 4);
        if (scale > 0 && count > 0) duration = count / scale;
      } else if (box.kind === 'hdlr' && payload + 12 <= offset + box.size) hasAudio ||= type(view, payload + 8) === 'soun';
      else if (['moov', 'trak', 'mdia'].includes(box.kind)) walk(payload, offset + box.size);
      offset += box.size;
    }
  }
  walk(0, view.byteLength); return { duration, hasAudio };
}
async function inspectRemoteMp4(url, isCancelled = () => false, register = () => () => {}) {
  async function range(start, length) {
    if (isCancelled()) throw new Error('演出视频加载已取消');
    return new Promise((resolve, reject) => {
      let done = false, task, unregister = () => {};
      function finish(fn, value) { if (done) return; done = true; unregister(); fn(value); }
      task = wx.request({ url, responseType: 'arraybuffer', header: { Range: `bytes=${start}-${start + length - 1}` }, timeout: 15000,
        success(res) {
          if (isCancelled()) return finish(reject, new Error('演出视频加载已取消'));
          if (res.statusCode !== 206 || !(res.data instanceof ArrayBuffer) || res.data.byteLength > MAX_METADATA) return finish(reject, new Error('视频服务器未支持分段读取，请重新上传为 MP4'));
          finish(resolve, res.data);
        }, fail(error) { finish(reject, error); } });
      unregister = register(() => { task?.abort(); finish(reject, new Error('演出视频加载已取消')); });
      if (done) unregister();
    });
  }
  // Walking top-level headers also supports older MP4s whose moov is at EOF.
  let offset = 0;
  for (let count = 0; count < 64; count++) {
    const head = await range(offset, 16), box = atom(new DataView(head), 0);
    if (!box || box.size < box.header || !Number.isSafeInteger(box.size) || (count === 0 && !['ftyp', 'moov', 'mdat', 'free', 'wide', 'skip'].includes(box.kind))) throw new Error('视频不是可分段播放的 MP4，请重新上传');
    if (box.kind === 'moov') {
      if (box.size > MAX_METADATA) throw new Error('视频索引过大，请重新上传压缩');
      const info = inspectMoov(await range(offset, box.size));
      if (!(info.duration > 0 && Number.isFinite(info.duration))) throw new Error("未找到 MP4 有效时长");
      return info;
    }
    offset += box.size;
  }
  throw new Error('未找到 MP4 视频索引，请重新上传');
}
module.exports = { inspectRemoteMp4, inspectMoov };
