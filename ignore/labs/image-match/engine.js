const makeScope = require('./vendor/mediapipe');
const build = require('./vendor/build-info');
const { createClock } = require('./clock');
const textCodec = require('./vendor/text-codec');
const { withTimeout } = require('./timeout');
const { adaptReadPixels } = require('./webgl-transfers');

const now = createClock(wx.getPerformance ? wx.getPerformance() : { now: Date.now });
function loadWasmPackage() {
  return require.async('../image-match-wasm/ready.js');
}
function download(url) {
  return new Promise((resolve, reject) => wx.downloadFile({ url, timeout: 20000,
    success: result => result.statusCode === 200 ? resolve(result.tempFilePath) : reject(new Error(`模型下载 HTTP ${result.statusCode}`)), fail: reject }));
}
function readFile(path) {
  return new Promise((resolve, reject) => wx.getFileSystemManager().readFile({ filePath: path, success: r => resolve(r.data), fail: reject }));
}
function removeFile(path) {
  if (path) wx.getFileSystemManager().unlink({ filePath: path, fail() {} });
}
async function createEngine(modelUrl, isCurrent = () => true, log = () => {}, canvas) {
  if (typeof WXWebAssembly === 'undefined') throw new Error('当前运行时没有 WXWebAssembly');
  const start = now();
  log('wasm-package-loading', {});
  await withTimeout(loadWasmPackage(), 20000, 'WASM 分包加载超过 20 秒，请退出预览后重试');
  if (!isCurrent()) throw new Error('已取消');
  log('wasm-package', { ms: now() - start, ...build });
  let path, model;
  try {
    path = await withTimeout(download(modelUrl), 22000, '模型下载超时，请确认手机和电脑在同一 Wi-Fi、开启小程序调试', removeFile);
    model = new Uint8Array(await withTimeout(readFile(path), 10000, '模型文件读取超时'));
  }
  finally { removeFile(path); }
  if (model.length !== 4117670 || String.fromCharCode(...model.slice(4, 8)) !== 'TFL3')
    throw new Error('模型不是此实验固定的 MobileNet V3 Small float32/1');
  if (!isCurrent()) throw new Error('已取消');
  log('model-downloaded', { bytes: model.byteLength, ms: now() - start });
  const gl = canvas?.getContext('webgl2');
  if (!gl) throw new Error('MediaPipe 需要页面 WebGL2 Canvas');
  const scope = makeScope({ wasm: WXWebAssembly, wasmPath: 'labs/image-match-wasm/vision.wasm.br', textCodec, now,
    trace: (event, detail) => log(event, { ...detail, ms: now() - start }),
    Canvas: function(width, height) { return wx.createOffscreenCanvas({ type: 'webgl', width, height }); } });
  scope.prepare({ print: text => log('native', { text }), printErr: text => log('native', { text }) });
  const restoreTransfers = adaptReadPixels(gl, log);
  let task;
  try {
    task = await withTimeout(scope.api.ImageEmbedder.createFromOptions({ wasmLoaderPath: '', wasmBinaryPath: '' }, {
      baseOptions: { modelAssetBuffer: model, delegate: 'CPU' }, canvas,
      runningMode: 'IMAGE', l2Normalize: true, quantize: false,
    }), 30000, 'MediaPipe 初始化超过 30 秒，请退出此页后重新进入', lateTask => lateTask.close());
    if (!isCurrent()) throw new Error('已取消');
  } catch (error) { try { task?.close(); } finally { restoreTransfers(); } throw error; }
  log('engine-ready', { ms: now() - start, runtime: 'MediaPipe 0.10.21 / WXWebAssembly / CPU' });
  let closed = false;
  return { build, initializationMs: now() - start,
    embed(image) {
      if (closed) throw new Error('匹配引擎已释放');
      const embedding = task.embed(image).embeddings[0]?.floatEmbedding;
      if (!embedding?.length) throw new Error('模型未返回图像特征');
      return Float32Array.from(embedding);
    },
    close() { if (!closed) { closed = true; try { task.close(); } finally { restoreTransfers(); } } },
  };
}
module.exports = { createEngine, now, removeFile };
