const { removeFile, now } = require('./engine');
let sequence = 0;
function canvas2d(width, height) {
  const canvas = wx.createOffscreenCanvas({ type: '2d', width, height });
  return { canvas, ctx: canvas.getContext('2d') };
}
function loadImage(canvas, path) {
  return new Promise((resolve, reject) => {
    const image = canvas.createImage();
    const timer = setTimeout(() => { image.onload = image.onerror = null; reject(new Error('图像解码超时')); }, 10000);
    image.onload = () => { clearTimeout(timer); image.onload = image.onerror = null; resolve(image); };
    image.onerror = e => { clearTimeout(timer); image.onload = image.onerror = null; reject(new Error(e?.errMsg || '图像解码失败')); };
    image.src = path;
  });
}
function writeJPEG(bytes) {
  const filePath = `${wx.env.USER_DATA_PATH}/image-match-${Date.now()}-${sequence++}.jpg`;
  return new Promise((resolve, reject) => wx.getFileSystemManager().writeFile({ filePath,
    data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    success: () => resolve(filePath), fail: error => { removeFile(filePath); reject(error); } }));
}
function exportJPEG(canvas) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => { done = true; reject(new Error('JPEG 导出超时')); }, 10000);
    wx.canvasToTempFilePath({ canvas, fileType: 'jpg', quality: 0.8,
      success: r => { clearTimeout(timer); if (done) removeFile(r.tempFilePath); else { done = true; resolve(r.tempFilePath); } },
      fail: e => { clearTimeout(timer); if (!done) { done = true; reject(e); } },
    });
  });
}
function createProcessor() {
  const pool = new Map();
  let closed = false;
  const check = current => { if (closed || !current()) throw new Error('测试已取消'); };
  function surface(width, height) {
    if (closed) throw new Error('图像处理器已释放');
    const key = `${width}x${height}`;
    if (!pool.has(key)) pool.set(key, canvas2d(width, height));
    return pool.get(key);
  }
  return {
    async prepare(snapshot, current = () => true) {
      check(current);
      const timings = { prepareMs: 0, encodeMs: 0, decodeMs: 0 };
      const started = now(), target = surface(snapshot.width, snapshot.height);
      if (snapshot.pixels) {
        const image = target.ctx.createImageData(snapshot.width, snapshot.height);
        image.data.set(snapshot.pixels); target.ctx.putImageData(image, 0, 0);
      }
      timings.prepareMs = now() - started;
      if (snapshot.mode === 'jpeg-small') {
        let path;
        try {
          const encodeAt = now();
          path = snapshot.jpeg ? await writeJPEG(snapshot.jpeg) : await exportJPEG(target.canvas);
          timings.encodeMs = now() - encodeAt;
          check(current);
          const decodeAt = now(), image = await loadImage(target.canvas, path);
          check(current);
          target.ctx.drawImage(image, 0, 0, snapshot.width, snapshot.height);
          timings.decodeMs = now() - decodeAt;
        } finally { removeFile(path); }
      }
      return { canvas: target.canvas, timings };
    },
    async fromPath(path, edge = 640) {
      const temp = canvas2d(1, 1), image = await loadImage(temp.canvas, path);
      if (closed) throw new Error('图像处理器已释放');
      const scale = Math.min(1, edge / Math.max(image.width, image.height));
      const target = surface(Math.max(1, Math.round(image.width * scale)), Math.max(1, Math.round(image.height * scale)));
      target.ctx.drawImage(image, 0, 0, target.canvas.width, target.canvas.height);
      return target.canvas;
    },
    close() { closed = true; for (const item of pool.values()) { item.canvas.width = 1; item.canvas.height = 1; } pool.clear(); },
  };
}
// A deterministic image fixture measures actual WASM/Canvas/codec work in the
// simulator. It is explicitly NOT a camera readback or building accuracy test.
function fixtureFrame(width = 720, height = 1280, variant = 'buildings') {
  const source = canvas2d(width, height);
  source.ctx.fillStyle = '#aacde4'; source.ctx.fillRect(0, 0, width, height);
  for (let i = 0; i < 8; i++) {
    source.ctx.fillStyle = ['#a34227', '#c6b49a', '#6d7363'][i % 3];
    source.ctx.fillRect(i * width / 8, height * (0.15 + (i % 3) * 0.1), width / 8 - 4, height);
    for (let y = 0; y < 10; y++) {
      source.ctx.fillStyle = '#243849'; source.ctx.fillRect(i * width / 8 + 12, height * 0.48 + y * 50, 25, 30);
    }
  }
  if (variant === 'checker') {
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      source.ctx.fillStyle = (x + y) % 2 ? '#ffffff' : '#000000';
      source.ctx.fillRect(x * width / 8, y * height / 8, width / 8, height / 8);
    }
  }
  const scratch = canvas2d(width, height);
  return { width, height, getCameraBuffer(w, h) {
    scratch.canvas.width = w; scratch.canvas.height = h;
    scratch.ctx.drawImage(source.canvas, 0, 0, w, h);
    return scratch.ctx.getImageData(0, 0, w, h).data.buffer;
  }, close() { source.canvas.width = scratch.canvas.width = 1; source.canvas.height = scratch.canvas.height = 1; } };
}
function pixelSummary(pixels) {
  let min = 255, max = 0, sum = 0, squared = 0, count = 0, alphaMin = 255;
  const stride = Math.max(4, Math.floor(pixels.length / 1024 / 4) * 4);
  for (let i = 0; i + 3 < pixels.length; i += stride) {
    alphaMin = Math.min(alphaMin, pixels[i + 3]);
    for (let channel = 0; channel < 3; channel++) {
      const value = pixels[i + channel]; min = Math.min(min, value); max = Math.max(max, value);
      sum += value; squared += value * value; count++;
    }
  }
  const mean = sum / count;
  return { min, max, mean, stddev: Math.sqrt(Math.max(0, squared / count - mean * mean)), alphaMin, samples: count / 3 };
}
module.exports = { createProcessor, fixtureFrame, loadImage, pixelSummary };
