const { createEngine, now, removeFile } = require('./engine');
const { createProcessor, fixtureFrame, pixelSummary } = require('./images');
const { captureVariants } = require('./capture');
const { orderFor, rank, summarize, runPair, cosine } = require('./benchmark');
const { VKSessionController } = require('../../lib/three-runtime/vk-session');
const { createCameraBackground } = require('../../lib/three-runtime/vk-renderer');
const { CONFIG, fetchAnchorCandidates } = require('../../utils/backend');
const LABELS = { 'rgba-full': '原尺寸 RGBA', 'rgba-small': '缩小 RGBA', 'jpeg-small': '缩小＋JPEG' };
const ROUNDS = 18, WARMUP = 3;

Page({
  data: { enabled: false, ready: false, busy: false, cameraRunning: false, scanning: false,
    status: '初始化', error: '', references: [], ranking: [], summary: [], report: '',
    viewWidth: 300, viewHeight: 400, progress: '', source: '' },
  onLoad(options) {
    this._active = true; this._dead = false; this._generation = 0; this._events = [];
    this._references = []; this._options = options;
    this._runId = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    this._enabled = wx.getAccountInfoSync().miniProgram.envVersion === 'develop';
    const info = { ...wx.getDeviceInfo(), ...wx.getAppBaseInfo(), ...wx.getWindowInfo() };
    this._environment = { platform: info.platform, system: info.system, model: info.model,
      SDKVersion: info.SDKVersion, version: info.version };
    const width = Math.min(info.windowWidth - 32, 460);
    this.setData({ enabled: this._enabled, viewWidth: width, viewHeight: Math.round(width * 4 / 3),
      status: this._enabled ? '加载 MediaPipe…' : '仅开发版可使用此实验页' });
  },
  onReady() {
    if (!this._enabled) return;
    this.createSelectorQuery().select('#inference-canvas').fields({ node: true })
      .select('#camera-canvas').fields({ node: true }).exec(rows => {
        if (!this._active) return;
        this._inferenceCanvas = rows[0]?.node; this._cameraCanvas = rows[1]?.node;
        this._canvasesReady = true; void this.initialize();
      });
  },
  onShow() { this._active = true; if (this._canvasesReady && !this._engine && !this._initializing) void this.initialize(); },
  onHide() { this.release(); },
  onUnload() { this._dead = true; this.release(); },
  current(generation) { return this._active && !this._dead && this._generation === generation; },
  log(event, detail) {
    const row = { event, ...detail }; this._events.push(row);
    if (this._events.length > 60) this._events.shift();
    console.log('[ImageMatch]', JSON.stringify(row));
    const stages = { 'wasm-package-loading': '1/5 加载 WASM 分包…', 'wasm-package': '2/5 从电脑下载模型…',
      'model-downloaded': '3/5 初始化 MediaPipe…', 'wasm-instantiate': '3/5 编译 WASM…',
      'wasm-instantiated': '4/5 等待 WASM 初始化…', 'wasm-receive-start': '4/5 读取 WASM 导出…',
      'wasm-memory-ready': '4/5 WASM 内存就绪…', 'wasm-constructors-start': '4/5 执行 WASM 构造函数…',
      'wasm-constructors-end': '4/5 构造函数完成…', 'wasm-receive-end': '4/5 初始化完成…',
      'module-ready': '5/5 加载推理模型…' };
    if (stages[event] && this._active && !this._dead) this.setData({ status: stages[event] });
    if (this._server && (event.startsWith('worker-') || event.startsWith('[DEBUG-simd]') || stages[event] || ['error', 'engine-ready', 'gl-readback', 'input-check', 'benchmark-start', 'benchmark-first-pair'].includes(event))) {
      wx.request({ url: `${this._server}/event`, method: 'POST', timeout: 3000,
        data: { runId: this._runId, event, detail, environment: this._environment }, fail() {} });
    }
  },
  fail(error) {
    const message = error.message || error.errMsg || String(error);
    this.log('error', { message });
    if (this._active && !this._dead) this.setData({ error: message, status: '实验未完成' });
  },
  async initialize() {
    if (!this._enabled || this._initializing || !this._active || this._engine) return;
    const generation = this._generation, current = () => this.current(generation);
    this._initializing = true;
    this.setData({ ready: false, error: '', status: '加载 MediaPipe…' });
    try {
      const dev = this._environment.platform === 'devtools';
      const host = dev ? '127.0.0.1' : require('../../utils/backend-development-local').apiBaseUrl.replace(/^https?:\/\//, '').split(':')[0];
      this._server = `http://${host}:8787`;
      if (this._options.simdProbe) {
        this.setData({ status: '检查 SIMD 指令数值…' });
        const result = await require('./simd-probe').runSimdProbes(current, (e,d) => this.log(e,d));
        if (current()) this.setData({ status: `SIMD 诊断完成：${result.total} 项，${result.failed} 项不一致` });
        if (this._options.simdProbe === '1') return;
      }
      const engine = await createEngine(`${this._server}/model.tflite`, current, (e,d) => this.log(e,d), this._inferenceCanvas);
      if (!current()) { engine.close(); return; }
      this._engine = engine; this._processor = createProcessor();
      this.setData({ status: '验证图像输入…' });
      const vectors = [], pixelStats = [];
      for (const variant of ['buildings', 'checker']) {
        const fixture = fixtureFrame(320, 320, variant);
        try {
          const snapshot = captureVariants(fixture, 320, 320, now, ['rgba-full'])['rgba-full'];
          pixelStats.push(pixelSummary(snapshot.pixels));
          const prepared = await this._processor.prepare(snapshot, current);
          if (!current()) return;
          vectors.push(this._engine.embed(prepared.canvas));
        } finally { fixture.close(); }
      }
      this._inputCheck = { distinctImageCosine: cosine(vectors[0], vectors[1]), pixelStats };
      this.log('input-check', this._inputCheck);
      if (this._inputCheck.distinctImageCosine > 0.99) throw new Error('两张不同测试图的特征过于接近，图像输入验证未通过');
      if (this._options.worker === '1') { await require('./worker-check').runWorkerCheck(this, current); return; }
      this.setData({ ready: true, status: '选择参考图，或载入当前地图的目标' });
      await this.importPendingReferences(generation);
      if (!current() || this._choosingReferences) return;
      if (this._options.fixture === '1') void this.benchmarkFixture();
      else if (this._options.camera === '1') this.startCamera();
    } catch (error) {
      if (current()) {
        this._engine?.close(); this._engine = null; this._processor?.close(); this._processor = null;
        this.fail(error);
      }
    }
    finally {
      this._initializing = false;
      if (this._active && !this._dead && !this._engine && !current()) void this.initialize();
    }
  },
  async addReference(path, name, id, generation) {
    const canvas = await this._processor.fromPath(path);
    if (!this.current(generation)) return;
    const vector = this._engine.embed(canvas);
    this._references = this._references.filter(ref => ref.id !== id);
    this._references.push({ id, name, vector });
    this.setData({ references: this._references.map(({ id, name }) => ({ id, name })) });
  },
  async chooseReferences() {
    if (!this._engine || this.data.busy || this.data.scanning || this._scanTask || this._choosingReferences) return;
    this._choosingReferences = true;
    this.setData({ busy: true, error: '' });
    try {
      const result = await new Promise((resolve, reject) => wx.chooseMedia({ count: 5, mediaType: ['image'], sourceType: ['album'], success: resolve, fail: reject }));
      if (this._dead) return;
      // The native album can hide the page and release the old engine. Import
      // its result into the current engine, or after onShow finishes rebuilding.
      this._pendingReferences = result.tempFiles;
      if (this._active && this._engine && this.data.ready) await this.importPendingReferences(this._generation);
    } catch (error) { if (!/cancel/.test(error.errMsg || '') && this._active && !this._dead) this.fail(error); }
    finally { this._choosingReferences = false; if (this._active && !this._dead) this.setData({ busy: false }); }
  },
  async importPendingReferences(generation) {
    if (!this._pendingReferences?.length || !this.current(generation) || !this._engine) return;
    const files = this._pendingReferences;
    this._pendingReferences = null;
    this.setData({ busy: true });
    try {
      for (const [i, file] of files.entries()) {
        if (!this.current(generation)) return;
        await this.addReference(file.tempFilePath, `图片 ${this._references.length + 1}`, `local-${Date.now()}-${i}`, generation);
      }
      if (this.current(generation)) this.setData({ status: `已载入 ${this._references.length} 张参考图` });
    } finally { if (this.current(generation)) this.setData({ busy: false }); }
  },
  async loadMapReferences() {
    if (!this._engine || this.data.busy || this.data.scanning || this._scanTask) return;
    const generation = this._generation;
    this.setData({ busy: true, error: '', status: '读取附近参考图…' });
    try {
      if (!CONFIG.workspaceId) throw new Error('请先在首页选择地图合集');
      const gps = await new Promise((resolve, reject) => wx.getLocation({ type: 'wgs84', isHighAccuracy: true, success: resolve, fail: reject }));
      if (!this.current(generation)) return;
      const response = await fetchAnchorCandidates({ workspace_id: CONFIG.workspaceId, latitude: gps.latitude,
        longitude: gps.longitude, accuracy: gps.accuracy, gps_timestamp: Date.now(), coordinate_system: 'wgs84' });
      if (!this.current(generation)) return;
      if (response.statusCode !== 200 || !Array.isArray(response.data?.candidates)) throw new Error(response.data?.error || '参考图接口失败');
      const candidates = response.data.candidates.slice(0, 10);
      for (const item of candidates) {
        if (!this.current(generation)) return;
        let path;
        try {
          path = await new Promise((resolve, reject) => wx.downloadFile({ url: item.image_url, timeout: 15000,
            success: r => r.statusCode === 200 ? resolve(r.tempFilePath) : reject(new Error(`参考图 HTTP ${r.statusCode}`)), fail: reject }));
          if (!this.current(generation)) return;
          await this.addReference(path, item.name, item.id, generation);
        } finally { removeFile(path); }
      }
      if (this.current(generation)) this.setData({ status: candidates.length ? `已载入 ${candidates.length} 个附近目标` : '附近没有参考图' });
    } catch (error) { if (this.current(generation)) this.fail(error); }
    finally { if (this.current(generation)) this.setData({ busy: false }); }
  },
  startCamera() {
    if (!this._engine || this._vk) return;
    try {
      const canvas = this._cameraCanvas; canvas.width = 720; canvas.height = 960;
      const gl = canvas.getContext('webgl2');
      this._background = createCameraBackground(gl);
      this._vk = new VKSessionController({ api: wx, gl, mode: 'slam', maxFps: 30, now,
        size: () => ({ width: canvas.width, height: canvas.height }),
        onState: (state, message) => {
          if (!this._active) return;
          this.setData({ cameraRunning: state === 'running' || (this._vk?.running === true),
            status: message || (state === 'running' ? '相机已启动，匹配不等待空间定位' : '启动相机…') });
          if (state === 'error') { this.fail(new Error(message)); this.stopCamera(); }
          if (state === 'running' && this._options.camera === '1' && !this._autoCameraBenchStarted) {
            this._autoCameraBenchStarted = true;
            const generation = this._generation;
            setTimeout(() => {
              if (this.current(generation) && this._vk?.running) void this.benchmark('camera')
                .finally(() => { if (this.current(generation)) this.stopCamera(); });
            }, 0);
          }
        },
        onFrame: frame => {
          if (!frame || !this._active) return;
          this._background.draw(frame, { resetState() {} }, canvas.width, canvas.height);
          if (this._pendingFrame) {
            const request = this._pendingFrame; this._pendingFrame = null; clearTimeout(request.timer);
            try { request.resolve(captureVariants(frame, canvas.width, canvas.height, now, request.order)); }
            catch (error) { request.reject(error); }
          }
        },
      });
      this._vk.start();
    } catch (error) { this.fail(error); this.stopCamera(); }
  },
  nextFrame(order) {
    if (!this._vk?.running) return Promise.reject(new Error('请先启动真机相机'));
    if (this._pendingFrame) return Promise.reject(new Error('上一帧尚未完成'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this._pendingFrame = null; reject(new Error('相机取帧超时')); }, 10000);
      this._pendingFrame = { resolve, reject, timer, order };
    });
  },
  async nextUsableFrame(order, current) {
    const started = now();
    while (current()) {
      const snapshots = await this.nextFrame(order);
      if (!current()) throw new Error('测试已取消');
      const pixels = pixelSummary(snapshots['rgba-full'].pixels);
      if (pixels.max - pixels.min > 8 && pixels.stddev > 3) return { snapshots, pixels };
      this.setData({ status: '请将镜头对准明亮、有细节的物体…' });
      if (now() - started > 10000) throw new Error('相机取到的画面过暗或缺少细节，请检查镜头和预览画面后重试');
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw new Error('测试已取消');
  },
  stopCamera() {
    this._scanning = false; clearTimeout(this._scanTimer);
    if (this._pendingFrame) { clearTimeout(this._pendingFrame.timer); this._pendingFrame.reject(new Error('相机已停止')); this._pendingFrame = null; }
    this._vk?.stop(); this._vk = null; this._background?.dispose(); this._background = null;
    if (!this._dead) this.setData({ cameraRunning: false, scanning: false });
  },
  async toggleScan() {
    if (this._scanning) {
      this._scanning = false; clearTimeout(this._scanTimer);
      this.setData({ busy: true });
      await this._scanTask;
      if (this._active && !this._dead) this.setData({ scanning: false, busy: false });
      return;
    }
    if (!this._engine || !this._references.length || !this._vk?.running || this.data.busy) return;
    this._scanning = true; this.setData({ scanning: true, error: '' });
    const generation = this._generation;
    const processFrame = async () => {
      try {
        const snapshots = await this.nextFrame(['rgba-small']);
        if (!this.current(generation) || !this._scanning) return;
        const { canvas } = await this._processor.prepare(snapshots['rgba-small'], () => this.current(generation));
        if (!this.current(generation) || !this._scanning) return;
        const start = now(), vector = this._engine.embed(canvas);
        const ranking = rank(vector, this._references).slice(0, 3).map(r => ({ ...r, scoreText: r.score.toFixed(3) }));
        this.setData({ ranking, status: `相似度排序 · 推理 ${(now() - start).toFixed(1)} ms` });
      } catch (error) { if (this.current(generation)) { this.fail(error); this._scanning = false; this.setData({ scanning: false }); } }
    };
    const tick = () => {
      const task = processFrame().finally(() => {
        if (this._scanTask === task) this._scanTask = null;
        if (this.current(generation) && this._scanning) this._scanTimer = setTimeout(tick, 400);
      });
      this._scanTask = task;
    };
    tick();
  },
  benchmarkCamera() { if (this._vk?.running) void this.benchmark('camera'); },
  benchmarkFixture() { void this.benchmark('fixture'); },
  async benchmark(source) {
    if (!this._engine || this.data.busy || this._scanning || this._scanTask) return;
    const generation = this._generation, current = () => this.current(generation);
    this.setData({ busy: true, error: '', summary: [], source: source === 'camera' ? '真机相机' : '合成图片 · 非相机', status: '运行三条路径对照…' });
    this.log('benchmark-start', { source });
    const rows = [];
    let fixture, firstFramePixels;
    try {
      if (source === 'fixture') fixture = fixtureFrame();
      let references = this._references;
      for (let i = 0; i < ROUNDS + WARMUP; i++) {
        if (!current()) return;
        const order = orderFor(i), waitAt = now();
        const captured = fixture ? { snapshots: captureVariants(fixture, fixture.width, fixture.height, now, order) }
          : await this.nextUsableFrame(order, current);
        const snapshots = captured.snapshots;
        if (!current()) return;
        const cameraPixels = captured.pixels;
        if (i === 0) firstFramePixels = cameraPixels || pixelSummary(snapshots['rgba-full'].pixels);
        const frameWaitMs = fixture ? 0 : now() - waitAt - Object.values(snapshots).reduce((sum,s) => sum + s.captureMs, 0);
        if (!references.length) {
          const prepared = await this._processor.prepare(snapshots['rgba-full'], current);
          if (!current()) return;
          references = [{ id: 'first-frame', name: '首帧（仅耗时对照）', vector: this._engine.embed(prepared.canvas) }];
        }
        const pair = await runPair({ snapshots, order, processor: this._processor, engine: this._engine, references, now, current, warmup: i < WARMUP });
        if (i === 0) this.log('benchmark-first-pair', { source, warmup: true,
          rows: pair.map(({ mode, totalMs, inferMs, captureMs }) => ({ mode, totalMs, inferMs, captureMs })) });
        for (const row of pair) rows.push({ pair: i, frameWaitMs: Math.max(0, frameWaitMs), cameraPixels, ...row });
        if (current()) this.setData({ status: '运行三条路径对照…', progress: `${Math.max(0, i + 1 - WARMUP)}/${ROUNDS}（预热 ${WARMUP} 组）` });
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      if (!current()) return;
      const summary = summarize(rows);
      this._report = { schema: 1, source, environment: this._environment, engine: this._engine.build,
        initializationMs: this._engine.initializationMs,
        inputCheck: this._inputCheck, firstFramePixels,
        clock: 'cached wx.getPerformance, monotonic clamp for sub-ms devtools jitter',
        model: 'mobilenet_v3_small/float32/1', rawSize: fixture ? [fixture.width, fixture.height] : [720, 960],
        smallMaxEdge: 640, jpegQuality: 80, warmupPairs: WARMUP, measuredPairs: ROUNDS,
        referenceCount: references.length, firstFrameReference: !this._references.length,
        note: 'Total includes capture/copy, preprocessing, codec, synchronous inference and ranking; excludes frame wait and one-off model/reference loading. Scores are similarities, not probabilities. Fixture timings do not measure native camera calls.',
        summary, rows };
      this.log('benchmark-complete', { source, summary });
      this.setData({ busy: false, status: '对照完成', summary: summary.map(s => ({ mode: s.mode, label: LABELS[s.mode],
        p50: s.totalMs.p50.toFixed(1), p95: s.totalMs.p95.toFixed(1), infer: s.inferMs.p50.toFixed(1),
        prepare: s.preprocessMs.p50.toFixed(1), similarity: s.embeddingCosineP50.toFixed(4) })), report: JSON.stringify(this._report, null, 2) });
      // Timings only, to our local development server. No camera pixels or GPS.
      wx.request({ url: `${this._server}/report`, method: 'POST', data: this._report, fail: () => {} });
    } catch (error) { if (current()) this.fail(error); }
    finally { fixture?.close(); if (current()) this.setData({ busy: false }); }
  },
  copyReport() { if (this._report) wx.setClipboardData({ data: JSON.stringify(this._report, null, 2) }); },
  release() {
    this._workerMatcher?.close(); this._workerMatcher = null;
    this._active = false; this._generation++; this.stopCamera();
    this._autoCameraBenchStarted = false;
    this._engine?.close(); this._engine = null; this._processor?.close(); this._processor = null;
    this._references = [];
    if (!this._dead) this.setData({ ready: false, busy: false, references: [], ranking: [] });
  },
});
