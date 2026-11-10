const { download, removeFile } = require('../../../lib/three-runtime/resources');
const { INPUT_EDGE: EDGE } = require('../../../lib/image-matcher/spec');

// Match the model's full-image resize for both references and camera frames.
// Alpha is composited on white; no JPEG encoding or persistent image cache.
async function loadReferencePixels(url, current) {
  let source, canvas, image;
  try {
    source = await download(url);
    if (!current()) throw new Error('识别已取消');
    canvas = wx.createOffscreenCanvas({ type: '2d', width: EDGE, height: EDGE });
    image = canvas.createImage();
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { image.onload = image.onerror = null; reject(new Error('参考图解码超时')); }, 10000);
      image.onload = () => { clearTimeout(timer); image.onload = image.onerror = null; resolve(); };
      image.onerror = () => { clearTimeout(timer); image.onload = image.onerror = null; reject(new Error('参考图无法读取')); };
      image.src = source;
    });
    if (!current()) throw new Error('识别已取消');
    if (Math.min(image.width, image.height) < EDGE) throw new Error('参考图过小，请上传清晰图片');
    const context = canvas.getContext('2d');
    context.fillStyle = '#ffffff'; context.fillRect(0, 0, EDGE, EDGE);
    context.drawImage(image, 0, 0, EDGE, EDGE);
    return context.getImageData(0, 0, EDGE, EDGE).data.slice().buffer;
  } finally {
    if (image) image.onload = image.onerror = null;
    if (canvas) canvas.width = canvas.height = 1;
    if (source && source !== url) removeFile(source);
  }
}
module.exports = { loadReferencePixels };
