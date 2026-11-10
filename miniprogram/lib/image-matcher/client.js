const spec = require('./spec');
const { CODES, RecognitionError } = require('./errors');

// require.async needs literal paths; scripts/test-image-matcher.cjs checks that
// these packages match spec.WASM_PATH / spec.MODEL_PATHS.
const loadPackages = () => Promise.all([
  require.async('../../packages/image-match-runtime/ready.js'),
  require.async('../../packages/image-match-model-a/ready.js'),
  require.async('../../packages/image-match-model-b/ready.js'),
]);
const INIT_TIMEOUT_MS = 30000;
const EMBED_TIMEOUT_MS = 10000;

class ImageMatcher {
  constructor(api = wx) { this.api = api; this.closed = false; this.sequence = 0; this.pending = null; }
  start() {
    if (this.startPromise) return this.startPromise;
    this.startPromise = new Promise((resolve, reject) => {
      this.rejectStart = reject;
      this.initializationTimer = setTimeout(() =>
        this.close(new RecognitionError(CODES.INIT_TIMEOUT, '图像识别准备超时，请重新扫描')), INIT_TIMEOUT_MS);
      this.initialize().then(() => {
        clearTimeout(this.initializationTimer); this.rejectStart = null; resolve(this);
      }, error => { this.close(error); reject(error); });
    });
    return this.startPromise;
  }
  async initialize() {
    if (!this.api.createWorker || !this.api.preDownloadSubpackage)
      throw new RecognitionError(CODES.UNSUPPORTED, '当前微信不支持后台图像识别，请更新微信');
    await Promise.all([
      loadPackages(),
      new Promise((resolve, reject) => this.api.preDownloadSubpackage({ packageType: 'workers', success: resolve, fail: reject })),
    ]);
    this.check();
    const fs = this.api.getFileSystemManager();
    const modelParts = await Promise.all(spec.MODEL_PATHS.map(filePath => new Promise((resolve, reject) =>
      fs.readFile({ filePath, success: result => resolve(result.data), fail: reject }))));
    this.check();
    if (modelParts.reduce((n, b) => n + b.byteLength, 0) !== spec.MODEL_BYTES)
      throw new RecognitionError(CODES.MODEL_INCOMPLETE, '识别模型文件不完整');
    const worker = this.worker = this.api.createWorker('workers/image-matcher/index.js');
    worker.onMessage(result => this.receive(result));
    worker.onProcessKilled?.(() => this.close(new RecognitionError(CODES.WORKER_KILLED, '图像识别进程已停止，请重新扫描')));
    worker.onError?.(error => this.close(new RecognitionError(CODES.WORKER_FAILED, error.message || '后台图像识别失败，请重新扫描')));
    await this.request('init', { wasmPath: spec.WASM_PATH, modelParts, edge: spec.INPUT_EDGE, dimensions: spec.DIMENSIONS },
      INIT_TIMEOUT_MS);
    this.check();
    return this;
  }
  receive(result) {
    const pending = this.pending;
    if (this.closed || !pending || result.id !== pending.id) return;
    this.pending = null; clearTimeout(pending.timer);
    if (!result.ok) pending.reject(new RecognitionError(result.code || CODES.WORKER_FAILED, result.error || '图像识别失败'));
    else pending.resolve(result);
  }
  check() { if (this.closed) throw new RecognitionError(CODES.CANCELLED, '识别已取消'); }
  request(type, data, timeout = EMBED_TIMEOUT_MS) {
    this.check();
    if (this.pending) return Promise.reject(new RecognitionError(CODES.BUSY, '图像识别正在处理上一帧'));
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => this.close(new RecognitionError(CODES.TIMEOUT, '图像识别超时，请重新扫描')), timeout);
      this.pending = { id, timer, resolve, reject };
      try { this.worker.postMessage({ id, type, ...data }); }
      catch (error) { this.close(error); }
    });
  }
  async embed(pixels) {
    const result = await this.request('embed', { pixels });
    const vector = new Float32Array(result.vector);
    if (vector.length !== spec.DIMENSIONS || !vector.every(Number.isFinite))
      throw new RecognitionError(CODES.INVALID_OUTPUT, '图像特征无效');
    return { vector, inferenceMs: result.inferenceMs };
  }
  close(error = new RecognitionError(CODES.CANCELLED, '识别已取消')) {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.initializationTimer); this.rejectStart?.(error); this.rejectStart = null;
    if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(error); this.pending = null; }
    try { this.worker?.terminate(); } finally { this.worker = null; }
  }
}
module.exports = { ImageMatcher };
