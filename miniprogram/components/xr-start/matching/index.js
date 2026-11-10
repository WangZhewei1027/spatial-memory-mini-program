const config = require("./config");
const { CONFIG, fetchAnchorCandidates, fetchAnchorContent } = require("../../../utils/backend");
const { loadReferencePixels } = require("./reference");
const { ImageMatcher } = require("../../../lib/image-matcher/client");
const { evaluateMatch, observe, intervalFor, inspectPixels, candidateMovement } = require("../../../lib/image-matcher/policy");
const { RGBA_BYTES, INPUT_EDGE } = require("../../../lib/image-matcher/spec");
const matchLog = require("./log");
const diagnostics = require("./diagnostics");
const location = require("./location");
const { referenceScope, gpsBody, checked, candidatesFrom, contentFrom } = require("./candidates");
const { PHASES, canTransition, scanState } = require("./state");

// Recognition flow: discover nearby targets -> embed references -> match camera
// frames -> fetch content -> place it once SLAM has a valid pose.
// Pure decisions live in lib/image-matcher/policy.js; per-scan fields in ./state.js.
const errorFields = error => ({ code: error.code, message: error.message || error.errMsg });
const pad = (value, width = 2) => String(value).padStart(width, '0');
const clockTime = ms => { const t = new Date(ms); return `${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}`; };
const score = value => Number.isFinite(value) ? value.toFixed(3) : '—';

module.exports = {
  ...diagnostics,
  ...location,
  _setMatchPhase(next) {
    // A rejected transition is a programming error; log it loudly but keep the
    // UI consistent with what the caller intended.
    if (!canTransition(this._matchPhase, next))
      this._matchLog('非法识别状态切换', { from: this._matchPhase, to: next }, 'error');
    this._matchPhase = next;
    // Keep the last scores visible after a confirmed match; errors replace them.
    if (next === PHASES.ERROR) this._matchProgress('');
  },
  _matchLog(event, fields = {}, level = 'info') {
    matchLog(event, { run: this._modeEpoch, phase: this._matchPhase, ...fields }, level);
  },
  _recognitionStatus(message) {
    if (this._disposed) return;
    const locked = this._matchPhase === PHASES.LOCKED;
    const key = `${this.retrievalMode}:${locked}:${message}`;
    if (key === this._lastRecognitionStatus) return;
    this._lastRecognitionStatus = key;
    this.triggerEvent('recognitionstatus', { mode: this.retrievalMode, message, locked });
  },
  // Second status line: whether a frame is being matched, when, and the scores
  // of every completed frame. Only emitted while scanning (at most ~2 per second).
  _matchProgress(text) {
    if (this._disposed || text === this._lastMatchProgress) return;
    this._lastMatchProgress = text;
    this.triggerEvent('matchprogress', { mode: this.retrievalMode, text });
  },
  _recognitionCurrent(epoch) {
    return this._modeEpoch === epoch && !this._disposed && !this._retrievalPaused &&
      this.retrievalMode === 'anchor' && this._sessionActive && this._cameraReady;
  },
  _stopMatcher() { this._imageMatcher?.close(); this._imageMatcher = null; },
  _cancelRetrieval(reason = 'cancel') {
    this._stopMatchDiagnostics(reason);
    this._modeEpoch++;
    this._stopMatcher();
    clearTimeout(this._matchSubmitTimer);
    // Rescans and movement keep reference embeddings for the same organization/map.
    if (!['rescan', 'movement'].includes(reason) || this._referenceCache.scope !== referenceScope(CONFIG))
      this._referenceCache.clear();
    Object.assign(this, scanState());
    this._matchProgress('');
    this.isFetchingAssets = false;
    this._isFetchingHuge = false;
  },
  rescan() {
    if (this._disposed || this._retrievalPaused || this.retrievalMode !== 'anchor') return;
    this._cancelRetrieval('rescan');
    this._clearRemoteAssets();
    this._recognitionStatus('正在准备重新扫描…');
    this._startMatchDiagnostics('rescan');
    // Keep the metric session and its established coordinate system alive.
    this._ensureARSession();
    void this.recognizeAnchor();
  },
  setRetrievalMode(mode) {
    if (!['gps', 'anchor'].includes(mode) || mode === this.retrievalMode || this._disposed) return;
    this._cancelRetrieval('mode_change'); this._clearRemoteAssets();
    this.retrievalMode = mode; this.setData({ retrievalMode: mode });
    if (mode === 'anchor') this._startMatchDiagnostics('enter');
    this._recognitionStatus(mode === 'anchor' ? '请将镜头对准目标' : '根据附近位置直接显示素材');
    this._ensureARSession();
    if (mode === 'anchor') void this.recognizeAnchor();
    else if (this._arReady) { this._maybeStartConfetti?.(); this.fetchNearbyAssets(); this.fetchHugeAssets(); }
  },
  pauseRetrieval() {
    this._cancelScenePreview?.(); this._retrievalPaused = true;
    this._cancelRetrieval('pause'); this._clearRemoteAssets();
  },
  resumeRetrieval() {
    if (!this._retrievalPaused || this._disposed) return;
    this._retrievalPaused = false;
    this._ensureARSession();
    if (this._scenePreviewMode) { if (this._arReady) this._beginScenePreview(); return; }
    if (this.retrievalMode === 'anchor') { this._startMatchDiagnostics('resume'); void this.recognizeAnchor(); return; }
    this._maybeStartConfetti?.();
    if (this._arReady) { this.fetchNearbyAssets(); this.fetchHugeAssets(); }
  },
  async _checkRecognitionLocation() {
    const epoch = this._modeEpoch;
    this._matchLocating = true;
    this._nextRecognitionAt = Date.now() + config.gpsCheckIntervalMs;
    try {
      // Checking location must not pause camera inference while a fallback fix waits.
      const gps = await this._locateForRecognition(epoch);
      if (!this._recognitionCurrent(epoch) || [PHASES.LOADING, PHASES.TRACKING].includes(this._matchPhase)) return;
      const movement = candidateMovement(this._candidateGPS, gps, config.candidateRefreshDistanceMeters);
      if (movement) return this.restartRecognitionAfterMovement(gps, movement);
    } catch (error) {
      if (this._recognitionCurrent(epoch)) this._matchLog('定位检查失败', errorFields(error), 'warn');
    } finally { if (this._modeEpoch === epoch) this._matchLocating = false; }
  },
  restartRecognitionAfterMovement(gps, movement) {
    this._cancelRetrieval('movement'); this._clearRemoteAssets();
    this._candidateRefreshGPS = gps;
    this._startMatchDiagnostics('movement');
    this._matchLog('移动后刷新目标', { distanceMeters: +movement.distanceMeters.toFixed(1),
      thresholdMeters: movement.thresholdMeters });
    this._recognitionStatus('位置已变化，正在获取附近识别目标…');
    this._ensureARSession();
    return this.recognizeAnchor();
  },
  async recognizeAnchor() {
    if (!this._recognitionCurrent(this._modeEpoch) || this._matchPreparing || this._matchLocating ||
        [PHASES.LOADING, PHASES.TRACKING].includes(this._matchPhase) || Date.now() < this._nextRecognitionAt) return;
    if (!CONFIG.workspaceId) { this._nextRecognitionAt = Infinity; this._recognitionStatus('请先选择具体地图'); return; }
    // A discovery snapshot stays active until meaningful GPS movement or explicit rescan.
    // Even a locked/empty snapshot checks location, without re-querying nearby targets.
    if (this._candidateGPS) return this._checkRecognitionLocation();
    if (this._matchFrameBusy) return;
    this._startMatchDiagnostics();
    const epoch = this._modeEpoch, scope = referenceScope(CONFIG), cache = this._referenceCache;
    const current = () => this._recognitionCurrent(epoch) && referenceScope(CONFIG) === scope;
    cache.useScope(scope);
    this._matchPreparing = true;
    try {
      this._matchStage('locating');
      this._recognitionStatus('正在获取附近识别目标…');
      const gps = this._candidateRefreshGPS || await this._locateForRecognition(epoch);
      this._candidateRefreshGPS = null;
      if (!current()) return;
      this._matchStage('fetching_candidates');
      const response = await fetchAnchorCandidates(gpsBody(CONFIG, gps));
      if (!current()) return;
      this._matchCandidates = candidatesFrom(checked(response));
      this._candidateGPS = { ...gps };
      this._matchLog('附近目标', { count: this._matchCandidates.length, refreshDistanceMeters: config.candidateRefreshDistanceMeters });
      if (!this._matchCandidates.length) {
        this._stopMatcher(); this._matchReferences = []; this._matchEvidence = null;
        this._setMatchPhase(PHASES.EMPTY); this._nextRecognitionAt = Date.now() + config.gpsCheckIntervalMs;
        this._recognitionStatus('附近没有识别目标，请走近目标或重新扫描');
        this._matchStage('empty'); this._stopMatchDiagnostics('no_candidates'); return;
      }
      this._setMatchPhase(PHASES.PREPARING); this._matchEvidence = null; this._matchReferences = [];
      if (!this._imageMatcher) {
        this._matchStage('initializing_worker');
        this._recognitionStatus('正在准备图像识别…');
        const startedAt = Date.now();
        const matcher = this._imageMatcher = new ImageMatcher();
        await matcher.start();
        if (!current()) { matcher.close(); return; }
        this._matchLog('识别模型就绪', { elapsedMs: Date.now() - startedAt, worker: true, simd: false });
      }
      const failures = [], references = [];
      let cacheHits = 0;
      cache.protect(this._matchCandidates);
      for (const candidate of this._matchCandidates) {
        if (!current()) return;
        this._recognitionStatus(`正在准备参考图（${references.length + failures.length + 1}/${this._matchCandidates.length}）…`);
        try {
          this._matchStage('preparing_reference');
          const startedAt = Date.now();
          let cached = cache.lookup(candidate.id, candidate.reference_version);
          const cacheHit = !!cached;
          if (!cacheHit) {
            // Every reference image of the target; one unusable image fails the target.
            const vectors = [];
            for (const url of candidate.image_urls) {
              const pixels = await loadReferencePixels(url, current);
              if (!current()) return;
              const { vector } = await this._imageMatcher.embed(pixels);
              if (!current()) return;
              vectors.push(vector);
            }
            cached = { version: candidate.reference_version, vectors };
          } else cacheHits++;
          cache.remember(candidate.id, cached);
          references.push({ ...candidate, vectors: cached.vectors });
          this._matchLog('参考图就绪', { anchorId: candidate.id, images: cached.vectors.length, cacheHit, elapsedMs: Date.now() - startedAt });
        } catch (error) {
          if (!current()) return;
          if (this._imageMatcher?.closed) throw error;
          failures.push(error.message || '参考图加载失败');
          this._matchLog('参考图不可用', { anchorId: candidate.id, ...errorFields(error) }, 'warn');
        }
      }
      if (!current()) return;
      // Do not accept a target while a missing competitor could change the ranking (same as SAGE).
      if (failures.length) throw new Error(`${failures.length} 张参考图未就绪：${failures[0]}，请重新扫描`);
      this._matchReferences = references;
      this._setMatchPhase(PHASES.SCANNING);
      this._nextRecognitionAt = Date.now() + config.gpsCheckIntervalMs;
      this._nextMatchFrameAt = 0;
      this._matchStage('scanning');
      this._scanStatusMessage = '自动识别中 · 请对准目标';
      this._recognitionStatus(this._scanStatusMessage);
      this._matchLog('扫描开始', {
        references: references.length, candidates: this._matchCandidates.length, cacheHits,
        cacheMisses: references.length - cacheHits, intervalMs: config.frameIntervalMs,
        minimumScore: config.minimumScore, minimumMargin: config.minimumMargin,
        observationsRequired: config.minimumObservations, confirmDurationMs: config.confirmDurationMs });
    } catch (error) {
      if (!current()) return;
      this._stopMatcher(); this._matchReferences = []; this._matchCandidates = []; this._matchEvidence = null;
      this._setMatchPhase(PHASES.ERROR); this._nextRecognitionAt = Infinity;
      this._matchLog('识别准备失败', errorFields(error), 'error');
      this._recognitionStatus(error.message || error.errMsg || '识别准备失败，请重新扫描');
      this._stopMatchDiagnostics('preparation_error');
    } finally { if (this._modeEpoch === epoch) this._matchPreparing = false; }
  },
  handleRecognitionFrame(frame) {
    if (this._disposed || !this._sessionActive || this._retrievalPaused) return;
    if (!this._cameraReady) { this._cameraReady = true; this.setData({ cameraReady: true }); }
    if (this.retrievalMode !== 'anchor' || this._scenePreviewMode) return;
    const now = Date.now();
    const d = this._matchDiagnostics;
    if (d) { d.cameraFrames++; d.lastFrameAt = now; if (this._matchFrameBusy) d.busyFrames++; }
    if (!this._matchPreparing && !this._matchLocating && now >= this._nextRecognitionAt) void this.recognizeAnchor();
    if (this._matchPhase !== PHASES.SCANNING || this._matchPreparing || this._matchFrameBusy || now < this._nextMatchFrameAt) return;
    const epoch = this._modeEpoch;
    this._matchFrameBusy = true; this._nextMatchFrameAt = now + config.frameIntervalMs;
    try {
      // Consume the native frame synchronously; only an owned RGBA buffer may
      // leave this callback. No native texture or VKFrame is retained across ticks.
      const native = frame.getCameraBuffer(INPUT_EDGE, INPUT_EDGE);
      if (!native || native.byteLength !== RGBA_BYTES) throw new Error('无法读取识别相机画面');
      const pixels = new Uint8Array(native).slice().buffer;
      const stats = inspectPixels(pixels), captureMs = Date.now() - now;
      if (d) d.captured++;
      if (!stats.usable) {
        if (d) d.invalidPixels++;
        this._matchEvidence = null; this._matchFrameBusy = false;
        this._recordMatchDecision({ reason: 'invalid_pixels', pixelMin: +stats.min.toFixed(1),
          pixelMax: +stats.max.toFixed(1), pixelStddev: +stats.stddev.toFixed(1), captureMs });
        this._recognitionStatus('自动识别中 · 画面过暗或缺少细节');
        this._matchProgress(`${clockTime(now)} 跳过：画面过暗或缺少细节 · 等待下一帧`);
        return;
      }
      if (d) { d.submittedAt = now; d.captureMs = captureMs; }
      this._matchFrameCount = (this._matchFrameCount || 0) + 1;
      this._matchProgress(`匹配中… #${this._matchFrameCount} · ${clockTime(now)} 取帧${this._lastMatchScores ? ` · 上次 ${this._lastMatchScores}` : ''}`);
      // Let the current rendering callback finish before copying pixels to Worker.
      this._matchSubmitTimer = setTimeout(() => {
        this._matchSubmitTimer = null;
        void this._matchCameraPixels(pixels, epoch, now);
      }, 0);
    } catch (error) { this._failFrameRecognition(error, epoch); }
  },
  async _matchCameraPixels(pixels, epoch, capturedAt) {
    if (!this._recognitionCurrent(epoch)) return;
    try {
      const { vector, inferenceMs } = await this._imageMatcher.embed(pixels);
      if (!this._recognitionCurrent(epoch) || this._matchPhase !== PHASES.SCANNING) return;
      const now = Date.now(), elapsed = now - capturedAt;
      const d = this._matchDiagnostics;
      if (d) d.inferred++;
      this._nextMatchFrameAt = capturedAt + intervalFor(elapsed, config);
      if (elapsed > config.maxResultAgeMs) {
        if (d) d.staleResults++;
        this._matchEvidence = null;
        this._recordMatchDecision({ reason: 'stale_result', elapsedMs: elapsed, inferenceMs });
        this._matchProgress(`${clockTime(now)} #${this._matchFrameCount} 结果过期（${elapsed}ms）已丢弃 · 等待下一帧`);
        return;
      }
      const evaluation = evaluateMatch(vector, this._matchReferences, config), match = evaluation.match;
      const result = observe(this._matchEvidence, match, capturedAt, config);
      this._matchEvidence = result.evidence;
      this._recordMatchDecision({ reason: result.confirmed ? 'confirmed' : match ? 'confirming' : evaluation.reason,
        topId: evaluation.best?.reference.id || null, topScore: evaluation.best?.score,
        secondScore: evaluation.second, margin: evaluation.margin, minimumScore: config.minimumScore,
        minimumMargin: config.minimumMargin, observations: result.evidence?.count || 0,
        observationsRequired: config.minimumObservations, captureMs: d?.captureMs, inferenceMs, elapsedMs: elapsed,
        nextIntervalMs: this._nextMatchFrameAt - capturedAt });
      const best = evaluation.best;
      this._lastMatchScores = best
        ? `${score(best.score)} ${best.reference.name || best.reference.id}` : '无可比参考图';
      this._matchProgress(`${clockTime(now)} #${this._matchFrameCount} 相似度 ${this._lastMatchScores}` +
        ` · 次高 ${score(evaluation.second)} · 阈值 ${config.minimumScore} · 差 ${score(evaluation.margin)}` +
        ` · ${elapsed}ms · 下次 ${((this._nextMatchFrameAt - capturedAt) / 1000).toFixed(1)}s 后`);
      if (!result.confirmed) this._recognitionStatus(match
        ? `正在确认：${match.reference.name || '目标'}（${result.evidence.count}/${config.minimumObservations}）`
        : this._scanStatusMessage || '自动识别中 · 请对准目标');
      if (result.confirmed) {
        this._matchLog('确认命中', { anchorId: match.reference.id, score: +match.score.toFixed(4), inferenceMs, elapsedMs: elapsed });
        void this._acceptImageMatch(match.reference);
      }
    } catch (error) { this._failFrameRecognition(error, epoch); }
    finally { if (this._modeEpoch === epoch) this._matchFrameBusy = false; }
  },
  _failFrameRecognition(error, epoch) {
    if (!this._recognitionCurrent(epoch)) return;
    this._stopMatcher(); this._matchFrameBusy = false; this._matchEvidence = null;
    this._setMatchPhase(PHASES.ERROR); this._nextRecognitionAt = Infinity;
    this._matchLog('图像识别失败', errorFields(error), 'error');
    this._recognitionStatus(error.message || '图像识别失败，请重新扫描');
    this._stopMatchDiagnostics('inference_error');
  },
  async _acceptImageMatch(candidate) {
    if (this._matchPhase !== PHASES.SCANNING || !candidate) return;
    const epoch = this._modeEpoch, matchedAt = Date.now();
    this._stopMatchDiagnostics('matched');
    this._setMatchPhase(PHASES.LOADING); this._stopMatcher(); this._matchReferences = [];
    this._matchEvidence = null; this._nextRecognitionAt = Date.now() + config.gpsCheckIntervalMs;
    this._recognitionStatus(`已识别：${candidate.name || '目标'}，正在加载内容…`);
    try {
      const gps = await this._locateForRecognition(epoch);
      if (!this._recognitionCurrent(epoch)) return;
      const response = await fetchAnchorContent({ ...gpsBody(CONFIG, gps), anchor_id: candidate.id, reference_version: candidate.reference_version });
      if (!this._recognitionCurrent(epoch)) return;
      const assets = contentFrom(checked(response), candidate.id);
      this._pendingMatchPlacement = { epoch, matchedAt, candidate, assets };
      this._setMatchPhase(PHASES.TRACKING);
      if (!this._arReady) this._recognitionStatus(`已识别：${candidate.name || '目标'} · 请缓慢左右移动手机，建立空间定位`);
      this._finishMatchPlacement();
    } catch (error) {
      if (!this._recognitionCurrent(epoch)) return;
      this._setMatchPhase(PHASES.ERROR); this._nextRecognitionAt = Infinity;
      this._matchLog('内容读取失败', errorFields(error), 'error');
      this._recognitionStatus(error.message || '内容加载失败，请重新扫描');
    }
  },
  _finishMatchPlacement() {
    const pending = this._pendingMatchPlacement;
    if (!pending || this._matchPhase !== PHASES.TRACKING || !this._recognitionCurrent(pending.epoch) || !this._arReady ||
        this._runtime?.session.mode !== 'slam') return;
    this._pendingMatchPlacement = null;
    const { epoch, matchedAt, candidate, assets } = pending;
    this._clearRemoteAssets(); this._matchedAnchorId = candidate.id;
    this._allowedAssetIds = new Set(assets.map(a => a.id));
    this._recognitionTiming = { requestId: `image-${epoch}-${matchedAt}`, startedAt: matchedAt, matchedAt,
      anchorId: candidate.id, contentEpoch: this._contentEpoch };
    this._setMatchPhase(PHASES.LOCKED); this.displayAssets(assets);
    this._matchLog('内容已锁定', { anchorId: candidate.id, assets: assets.length, space: 'world', elapsedMs: Date.now() - matchedAt });
    this._recognitionStatus(`已识别：${candidate.name || '目标'}${assets.length ? ' · 内容已固定在空间中' : ' · 暂无关联内容'}`);
  },
};
