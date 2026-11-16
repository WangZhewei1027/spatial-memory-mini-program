const config = require("./config");
const { CONFIG, fetchAnchorCandidates, fetchAnchorContent } = require("../../../utils/backend");
const { loadReferencePixels } = require("./reference");
const { ImageMatcher } = require("../../../lib/image-matcher/client");
const { track, intervalFor, inspectPixels, blurState, candidateMovement, contentView, attention, hintActive } = require("../../../lib/image-matcher/policy");
const { RGBA_BYTES, INPUT_EDGE } = require("../../../lib/image-matcher/spec");
const matchLog = require("./log");
const diagnostics = require("./diagnostics");
const location = require("./location");
const { referenceScope, gpsBody, checked, candidatesFrom, contentFrom } = require("./candidates");
const { PHASES, canTransition, scanState } = require("./state");

// Recognition flow: discover nearby targets -> embed references -> match camera
// frames -> fetch content -> place it once SLAM has a valid pose. Once the user leaves
// the shown content, frames are matched again and a different target replaces it.
// Pure decisions live in lib/image-matcher/policy.js; per-scan fields in ./state.js.
const errorFields = error => ({ code: error.code, message: error.message || error.errMsg });
const pad = (value, width = 2) => String(value).padStart(width, '0');
const clockTime = ms => { const t = new Date(ms); return `${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}`; };
const score = value => Number.isFinite(value) ? value.toFixed(3) : '—';
const round2 = value => Number.isFinite(value) ? +value.toFixed(2) : null;
const round3 = value => Number.isFinite(value) ? +value.toFixed(3) : null;
const SCANNING_PHASES = [PHASES.SCANNING, PHASES.REACQUIRING], SHOWN_PHASES = [PHASES.LOCKED, PHASES.REACQUIRING];
// Relative pose only; no coordinates.
const viewFields = view => ({ offsetDeg: view.offsetDeg == null ? null : Math.round(view.offsetDeg),
  pitchDeg: Math.round(view.pitchDeg), distanceMeters: +view.distance.toFixed(1) });
// Which phone produced a log; scores and timings are only comparable per device.
const deviceInfo = () => {
  try {
    const device = wx.getDeviceInfo?.() || {}, app = wx.getAppBaseInfo?.() || {};
    return { model: device.model, system: device.system, wechat: app.version, sdk: app.SDKVersion };
  } catch (_) { return null; }
};
// Per-target scores of one frame for field calibration: raw (this frame), smoothed,
// and which reference image matched best. Highest raw scores first, bounded.
const targetScores = entries => [...entries].sort((a, b) => b.raw - a.raw).slice(0, config.frameLogTargets)
  .map(entry => ({ id: entry.reference.id, raw: round3(entry.raw), smooth: round3(entry.score), image: entry.image }));

module.exports = {
  ...diagnostics,
  ...location,
  _setMatchPhase(next) {
    // A rejected transition is a programming error; log it loudly but keep the
    // UI consistent with what the caller intended.
    if (!canTransition(this._matchPhase, next))
      this._matchLog('非法识别状态切换', { from: this._matchPhase, to: next }, 'error');
    this._matchPhase = next;
    if (!SCANNING_PHASES.includes(next)) this._clearRecognitionHint();
    // Keep the last scores visible after a confirmed match; errors replace them.
    if (next === PHASES.ERROR) this._matchProgress('');
  },
  _matchLog(event, fields = {}, level = 'info') {
    matchLog(event, { run: this._modeEpoch, phase: this._matchPhase, ...fields }, level);
  },
  _recognitionStatus(message, hint = message) {
    if (this._disposed) return;
    const locked = SHOWN_PHASES.includes(this._matchPhase) || !!this._matchedAnchorId;
    const key = `${this.retrievalMode}:${locked}:${message}:${hint}`;
    if (key === this._lastRecognitionStatus) return;
    this._lastRecognitionStatus = key;
    this.triggerEvent('recognitionstatus', { mode: this.retrievalMode, message: hint, diagnostic: hint === message ? '' : message, phase: this._matchPhase, locked });
  },
  // Second status line: whether a frame is being matched, when, and the scores
  // of every completed frame. Only emitted while scanning (at most ~2 per second).
  _matchProgress(text) {
    if (this._disposed || text === this._lastMatchProgress) return;
    this._lastMatchProgress = text;
    this.triggerEvent('matchprogress', { mode: this.retrievalMode, text });
  },
  _setRecognitionHint(active) {
    if (this._matchHintActive === active) return;
    this._matchHintActive = active;
    if (!this._disposed) this.triggerEvent('recognitionhint', { mode: this.retrievalMode, active });
  },
  _clearRecognitionHint() {
    clearTimeout(this._matchHintTimer);
    this._matchHintTimer = null; this._matchHintToken = null;
    this._setRecognitionHint(false);
  },
  _refreshRecognitionHint(best, matcher, epoch) {
    if (!matcher || this._imageMatcher !== matcher || !this._recognitionCurrent(epoch) || !SCANNING_PHASES.includes(this._matchPhase)) return;
    const shownId = this._matchPhase === PHASES.REACQUIRING ? this._matchedAnchorId : null;
    const active = hintActive(this._matchHintActive, best, shownId, config);
    if (!active) { this._clearRecognitionHint(); return; }
    clearTimeout(this._matchHintTimer);
    const token = this._matchHintToken = {};
    this._setRecognitionHint(true);
    // Expire even if camera frames stop. A refreshed hint and a restarted Worker
    // both invalidate this callback, independently of the scan's mode epoch.
    this._matchHintTimer = setTimeout(() => {
      if (this._matchHintToken !== token || this._imageMatcher !== matcher || !this._recognitionCurrent(epoch) ||
          !SCANNING_PHASES.includes(this._matchPhase)) return;
      this._clearRecognitionHint();
    }, config.hintStaleMs);
  },
  _recognitionCurrent(epoch) {
    return this._modeEpoch === epoch && !this._disposed && !this._retrievalPaused &&
      this.retrievalMode === 'anchor' && this._sessionActive && this._cameraReady;
  },
  _stopMatcher() { this._clearRecognitionHint(); this._imageMatcher?.close(); this._imageMatcher = null; },
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
    this._clearRemoteAssets({ preserveActivities: true });
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
    this._syncRenderModules?.();
    if (mode === 'anchor') this._startMatchDiagnostics('enter');
    this._recognitionStatus(mode === 'anchor' ? '请将镜头对准目标' : '根据附近位置直接显示素材');
    this._ensureARSession();
    if (mode === 'anchor') void this.recognizeAnchor();
    else if (this._arReady) { this._maybeStartConfetti?.(); this.fetchNearbyAssets(); this.fetchHugeAssets(); }
  },
  pauseRetrieval() {
    this._cancelScenePreview?.(); this._retrievalPaused = true;
    this._cancelRetrieval('pause'); this._clearRemoteAssets();
    this._runtime?.layers?.pause();
  },
  resumeRetrieval() {
    if (!this._retrievalPaused || this._disposed) return;
    this._retrievalPaused = false;
    this._runtime?.layers?.start();
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
    this._cancelRetrieval('movement'); this._clearRemoteAssets({ preserveActivities: true });
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
        this._recognitionStatus(`正在准备参考图（${references.length + failures.length + 1}/${this._matchCandidates.length}）…`, "正在准备图像识别…");
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
      this._matchScanStartedAt = Date.now();
      this._matchLog('扫描开始', {
        device: deviceInfo(),
        targets: references.map(reference => ({ id: reference.id, name: reference.name, images: reference.vectors.length,
          distanceMeters: Number.isFinite(reference.distance_meters) ? Math.round(reference.distance_meters) : null })),
        references: references.length, candidates: this._matchCandidates.length, cacheHits,
        cacheMisses: references.length - cacheHits, intervalMs: config.frameIntervalMs,
        minimumScore: config.minimumScore, minimumMargin: config.minimumMargin, scoreSmoothingMs: config.scoreSmoothingMs, scoreJump: config.scoreJump,
        observationsRequired: config.minimumObservations, confirmDurationMs: config.confirmDurationMs,
        strongScore: config.strongScore, strongMargin: config.strongMargin, strongObservationsRequired: config.strongObservations,
        strongConfirmDurationMs: config.strongConfirmDurationMs, leadFrameIntervalMs: config.leadFrameIntervalMs,
        maxFrameIntervalMs: config.maxFrameIntervalMs, maxResultAgeMs: config.maxResultAgeMs,
        blurSharpnessRatio: config.blurSharpnessRatio, maxBlurRetries: config.maxBlurRetries,
        maxContentPrefetches: config.maxContentPrefetches });
    } catch (error) {
      if (!current()) return;
      this._stopMatcher(); this._matchReferences = []; this._matchCandidates = []; this._matchEvidence = null;
      this._setMatchPhase(PHASES.ERROR); this._nextRecognitionAt = Infinity;
      this._matchLog('识别准备失败', errorFields(error), 'error');
      this._recognitionStatus(error.message || error.errMsg || '识别准备失败', '识别准备失败，请重新扫描');
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
    if (!SCANNING_PHASES.includes(this._matchPhase) || this._matchPreparing || this._matchFrameBusy || now < this._nextMatchFrameAt) return;
    const epoch = this._modeEpoch, background = this._matchPhase === PHASES.REACQUIRING;
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
        this._clearRecognitionHint();
        this._matchEvidence = null; this._matchFrameBusy = false;
        this._recordMatchDecision({ reason: 'invalid_pixels', pixelMin: +stats.min.toFixed(1),
          pixelMax: +stats.max.toFixed(1), pixelStddev: +stats.stddev.toFixed(1), captureMs });
        if (!background) this._recognitionStatus('自动识别中 · 画面过暗或缺少细节');
        this._matchProgress(`${clockTime(now)} 跳过：画面过暗或缺少细节 · 等待下一帧`);
        return;
      }
      // A motion-blurred frame costs no inference and keeps the accumulated evidence.
      const blur = this._matchBlur = blurState(this._matchBlur, stats.sharpness, config);
      if (blur.blurred) {
        if (d) d.blurredFrames++;
        this._matchFrameBusy = false; this._nextMatchFrameAt = now + config.blurRetryMs;
        this._recordMatchDecision({ reason: 'blurred_frame', sharpness: +stats.sharpness.toFixed(2),
          sharpnessBaseline: +blur.previous.toFixed(2), sharpnessRatio: round2(stats.sharpness / blur.previous),
          retry: blur.retries, captureMs });
        this._matchProgress(`${clockTime(now)} 跳过：画面模糊 · 马上重试`);
        return;
      }
      if (d) { d.submittedAt = now; d.captureMs = captureMs; d.sharpness = stats.sharpness; d.sharpnessBaseline = blur.previous; }
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
    // A background scan ends without a new epoch; its matcher identifies late results.
    const matcher = this._imageMatcher;
    const current = () => this._recognitionCurrent(epoch) && this._imageMatcher === matcher && SCANNING_PHASES.includes(this._matchPhase);
    if (!matcher || !current()) return;
    try {
      const { vector, inferenceMs } = await matcher.embed(pixels);
      if (!current()) return;
      const now = Date.now(), elapsed = now - capturedAt;
      const d = this._matchDiagnostics;
      if (d) d.inferred++;
      this._nextMatchFrameAt = capturedAt + intervalFor(elapsed, config);
      if (elapsed > config.maxResultAgeMs) {
        if (d) d.staleResults++;
        this._clearRecognitionHint();
        this._matchEvidence = null;
        this._recordMatchDecision({ reason: 'stale_result', frame: this._matchFrameCount, elapsedMs: elapsed, inferenceMs });
        this._matchProgress(`${clockTime(now)} #${this._matchFrameCount} 结果过期（${elapsed}ms）已丢弃 · 等待下一帧`);
        return;
      }
      const result = track(this._matchEvidence, vector, this._matchReferences, capturedAt, config);
      this._refreshRecognitionHint(result.frame.best, matcher, epoch);
      // While its content is shown, the same target leading again changes nothing.
      const shown = this._matchPhase === PHASES.REACQUIRING && result.match?.reference.id === this._matchedAnchorId;
      const match = shown ? null : result.match;
      this._matchEvidence = result.evidence;
      // Only a clear lead speeds up sampling: on a borderline lead, extra frames within the
      // same couple of seconds mostly repeat the same view and make false confirmations easier.
      this._nextMatchFrameAt = capturedAt + intervalFor(elapsed, config, result.strong && !shown);
      if (match && !result.confirmed) this._prefetchMatchContent(match.reference, epoch);
      this._recordMatchDecision({ reason: shown ? 'shown_target' : result.confirmed ? 'confirmed' : match ? 'confirming' : result.reason,
        topId: result.best?.reference.id || null, topScore: result.best?.score,
        secondScore: result.second, margin: result.margin,
        frameTopId: result.frame.best?.reference.id || null, frameTopScore: result.frame.best?.score,
        frameMargin: result.frame.margin, minimumScore: config.minimumScore,
        minimumMargin: config.minimumMargin, observations: result.progress,
        observationsRequired: result.required, strong: result.strong, slowObservations: result.evidence.count,
        leadMs: result.evidence.id ? capturedAt - result.evidence.since : null, frame: this._matchFrameCount,
        sharpness: round2(d?.sharpness), sharpnessBaseline: round2(d?.sharpnessBaseline),
        captureMs: d?.captureMs, inferenceMs, elapsedMs: elapsed,
        nextIntervalMs: this._nextMatchFrameAt - capturedAt, scores: targetScores(result.scores) });
      const best = result.best;
      const frameBest = result.frame.best;
      this._lastMatchScores = best
        ? `${score(best.score)}（本帧 ${score(frameBest?.score)}） ${best.reference.name || best.reference.id}` : '无可比参考图';
      this._matchProgress(`${clockTime(now)} #${this._matchFrameCount} 相似度 ${this._lastMatchScores}` +
        ` · 次高 ${score(result.second)} · 阈值 ${config.minimumScore} · 差 ${score(result.margin)}` +
        ` · ${elapsed}ms · 下次 ${((this._nextMatchFrameAt - capturedAt) / 1000).toFixed(1)}s 后`);
      if (!result.confirmed || shown) {
        const hint = match ? `正在确认：${match.reference.name || '目标'} · 请保持镜头稳定` : this._scanStatusMessage || '自动识别中 · 请对准目标';
        this._recognitionStatus(match ? `确认 ${result.progress}/${result.required}` : hint, hint);
      }
      if (result.confirmed && shown) this._matchEvidence = null;
      else if (result.confirmed) {
        this._matchLog('确认命中', { anchorId: match.reference.id, score: +match.score.toFixed(4), margin: round3(result.margin),
          via: result.via, strong: result.strong, observations: result.progress, frames: this._matchFrameCount,
          leadMs: capturedAt - result.evidence.since, scanMs: now - this._matchScanStartedAt, inferenceMs, elapsedMs: elapsed });
        void this._acceptImageMatch(match.reference);
      }
    } catch (error) { if (this._imageMatcher === matcher) this._failFrameRecognition(error, epoch); }
    finally { if (this._modeEpoch === epoch && (!this._imageMatcher || this._imageMatcher === matcher)) this._matchFrameBusy = false; }
  },
  _failFrameRecognition(error, epoch) {
    if (!this._recognitionCurrent(epoch)) return;
    // The shown content is unaffected by a failed background scan; try again later.
    if (this._matchPhase === PHASES.REACQUIRING) {
      this._matchLog('后台识别失败', errorFields(error), 'warn');
      this._reacquireBlockedUntil = Date.now() + config.reacquireRetryMs;
      return this._stopReacquire('inference_error');
    }
    this._stopMatcher(); this._matchFrameBusy = false; this._matchEvidence = null;
    this._setMatchPhase(PHASES.ERROR); this._nextRecognitionAt = Infinity;
    this._matchLog('图像识别失败', errorFields(error), 'error');
    this._recognitionStatus(error.message || '图像识别失败', '图像识别失败，请重新扫描');
    this._stopMatchDiagnostics('inference_error');
  },
  // Content for the leading target is requested before confirmation finishes, so a
  // confirmed match usually has it ready. A wrong guess is simply never used.
  _prefetchMatchContent(candidate, epoch) {
    const prefetch = this._matchContentPrefetch;
    if (prefetch.has(candidate.id) || prefetch.size >= config.maxContentPrefetches) return;
    const startedAt = Date.now(), request = this._requestMatchContent(candidate, epoch);
    // A failure is retried only if this target is confirmed; here it is just recorded.
    request.then(assets => { if (assets) this._matchLog('预取完成', { anchorId: candidate.id, assets: assets.length, elapsedMs: Date.now() - startedAt }); },
      error => { if (this._modeEpoch === epoch) this._matchLog('预取失败', { anchorId: candidate.id, elapsedMs: Date.now() - startedAt, ...errorFields(error) }, 'warn'); });
    prefetch.set(candidate.id, request);
    this._matchLog('预取内容', { anchorId: candidate.id, frame: this._matchFrameCount, scanMs: startedAt - this._matchScanStartedAt });
  },
  async _requestMatchContent(candidate, epoch) {
    const gps = await this._locateForRecognition(epoch);
    if (!this._recognitionCurrent(epoch)) return null;
    const response = await fetchAnchorContent({ ...gpsBody(CONFIG, gps), anchor_id: candidate.id, reference_version: candidate.reference_version });
    return contentFrom(checked(response), candidate.id);
  },
  async _acceptImageMatch(candidate) {
    if (!SCANNING_PHASES.includes(this._matchPhase) || !candidate) return;
    const epoch = this._modeEpoch, matchedAt = Date.now(), replacing = this._matchPhase === PHASES.REACQUIRING;
    if (replacing && candidate.id === this._matchedAnchorId) return;
    const prefetched = this._matchContentPrefetch.get(candidate.id);
    this._stopMatchDiagnostics('matched');
    // Keep the old content until the replacement is ready and SLAM can place it.
    this._setMatchPhase(PHASES.LOADING); this._stopMatcher(); this._matchReferences = [];
    this._matchEvidence = null; this._nextRecognitionAt = Date.now() + config.gpsCheckIntervalMs;
    this._recognitionStatus(`已识别：${candidate.name || '目标'}，正在加载内容…`);
    try {
      let assets = null;
      if (prefetched) {
        try { assets = await prefetched; }
        catch (error) { this._matchLog('预取未命中，重新读取', { anchorId: candidate.id }); }
        if (!this._recognitionCurrent(epoch)) return;
      }
      if (!assets) assets = await this._requestMatchContent(candidate, epoch);
      if (!assets || !this._recognitionCurrent(epoch)) return;
      this._matchLog('内容就绪', { anchorId: candidate.id, prefetched: !!prefetched, assets: assets.length, elapsedMs: Date.now() - matchedAt });
      this._pendingMatchPlacement = { epoch, matchedAt, candidate, assets };
      this._setMatchPhase(PHASES.TRACKING);
      if (!this._arReady) this._recognitionStatus(`已识别：${candidate.name || '目标'} · 请缓慢左右移动手机，建立空间定位`);
      this._finishMatchPlacement();
    } catch (error) {
      if (!this._recognitionCurrent(epoch)) return;
      if (replacing) {
        this._matchLog('切换内容读取失败', { anchorId: candidate.id, ...errorFields(error) }, 'warn');
        this._reacquireBlockedUntil = Date.now() + config.reacquireRetryMs;
        this._setMatchPhase(PHASES.LOCKED); this._matchProgress('');
        this._recognitionStatus(this._matchLockStatus);
        return;
      }
      this._setMatchPhase(PHASES.ERROR); this._nextRecognitionAt = Infinity;
      this._matchLog('内容读取失败', errorFields(error), 'error');
      this._recognitionStatus(error.message || '内容加载失败', '内容加载失败，请重新扫描');
    }
  },
  _finishMatchPlacement() {
    const pending = this._pendingMatchPlacement;
    if (!pending || this._matchPhase !== PHASES.TRACKING || !this._recognitionCurrent(pending.epoch) || !this._arReady ||
        this._runtime?.session.mode !== 'slam') return;
    this._pendingMatchPlacement = null;
    const { epoch, matchedAt, candidate, assets } = pending;
    if (this._matchedAnchorId) this._matchLog('切换目标', { from: this._matchedAnchorId, to: candidate.id });
    this._clearRemoteAssets({ preserveActivities: true }); this._matchedAnchorId = candidate.id;
    for (const asset of assets) this._allowedAssetIds.add(asset.id);
    this._recognitionTiming = { requestId: `image-${epoch}-${matchedAt}`, startedAt: matchedAt, matchedAt,
      anchorId: candidate.id, contentEpoch: this._contentEpoch };
    this._setMatchPhase(PHASES.LOCKED);
    this._matchAttention = null; this._matchLockPose = this._cameraPose(); this._reacquireBlockedUntil = 0;
    this.displayAssets(assets);
    this._matchLog('内容已锁定', { anchorId: candidate.id, assets: assets.length, space: 'world', elapsedMs: Date.now() - matchedAt,
      scanMs: Date.now() - this._matchScanStartedAt });
    this._matchLockStatus = `已识别：${candidate.name || '目标'}${assets.length ? ' · 内容已固定在空间中' : ' · 暂无关联内容'}`;
    this._recognitionStatus(this._matchLockStatus);
  },
  // Camera position and viewing direction in SLAM world space, copied.
  _cameraPose() {
    const camera = this.getCamTransform?.();
    if (!camera) return null;
    const forward = camera.getWorldDirection(this._forwardScratch), position = camera.position;
    return { position: { x: position.x, y: position.y, z: position.z }, forward: { x: forward.x, y: forward.y, z: forward.z } };
  },
  // Stable viewing reference for this target. Async assets may appear in the new
  // camera direction, and a Scene's authored origin can be anywhere; neither should
  // move the attention baseline or cancel a turn toward the next target.
  _contentFocus() {
    const lock = this._matchLockPose;
    if (!lock) return null;
    const reach = config.focusAheadMeters / (Math.hypot(lock.forward.x, lock.forward.z) || 1);
    return { x: lock.position.x + lock.forward.x * reach, z: lock.position.z + lock.forward.z * reach, forward: lock.forward };
  },
  // Runs on rendered frames with a valid pose. Leaving the shown content resumes
  // matching in the background; coming back stops it. Content is only replaced by a
  // confirmed different target, so a wrong guess here costs inference, not content.
  _tickAttention() {
    if (!SHOWN_PHASES.includes(this._matchPhase)) return;
    const now = Date.now();
    if (now < this._nextAttentionAt) return;
    this._nextAttentionAt = now + config.attentionIntervalMs;
    const pose = this._cameraPose(), focus = pose && this._contentFocus();
    if (!focus) return;
    const view = contentView(pose.position, pose.forward, focus, config);
    const state = this._matchAttention = attention(this._matchAttention, view, now, config);
    if (state.flipped) this._matchLog(state.away ? '离开内容' : '回到内容', viewFields(view));
    if (state.away && this._matchPhase === PHASES.LOCKED && now >= this._reacquireBlockedUntil) void this._startReacquire();
    else if (!state.away && this._matchPhase === PHASES.REACQUIRING) this._stopReacquire('returned');
  },
  // Matches frames again against the targets this scan already prepared; nothing is
  // fetched and the shown content is untouched.
  async _startReacquire() {
    const epoch = this._modeEpoch, references = [];
    for (const candidate of this._matchCandidates) {
      const cached = this._referenceCache.lookup(candidate.id, candidate.reference_version);
      if (cached) references.push({ ...candidate, vectors: cached.vectors });
    }
    // No other target to switch to, or a competitor is missing (see recognizeAnchor):
    // stay locked until movement or a rescan refreshes the targets.
    if (references.length < 2 || references.length !== this._matchCandidates.length) {
      this._reacquireBlockedUntil = Infinity;
      this._matchLog('不启动后台扫描', { references: references.length, candidates: this._matchCandidates.length });
      return;
    }
    const shown = references.find(reference => reference.id === this._matchedAnchorId);
    this._setMatchPhase(PHASES.REACQUIRING);
    Object.assign(this, { _matchReferences: references, _matchEvidence: null, _matchBlur: null, _matchContentPrefetch: new Map(),
      _matchFrameBusy: false, _matchFrameCount: 0, _nextMatchFrameAt: 0, _lastMatchScores: null, _matchScanStartedAt: Date.now() });
    this._scanStatusMessage = `已识别：${shown?.name || '目标'} · 对准其他目标可自动切换`;
    this._recognitionStatus(this._scanStatusMessage);
    this._startMatchDiagnostics('reacquire'); this._matchStage('initializing_worker');
    const matcher = this._imageMatcher = new ImageMatcher();
    this._matchPreparing = true;
    try {
      await matcher.start();
      if (this._imageMatcher !== matcher) return;
      this._matchStage('scanning');
      this._matchLog('后台扫描开始', { shownAnchorId: this._matchedAnchorId, references: references.length, elapsedMs: Date.now() - this._matchScanStartedAt });
    } catch (error) {
      if (this._imageMatcher === matcher) this._failFrameRecognition(error, epoch);
    } finally { if (this._imageMatcher === matcher) this._matchPreparing = false; }
  },
  _stopReacquire(reason) {
    this._stopMatchDiagnostics(reason); this._stopMatcher();
    clearTimeout(this._matchSubmitTimer);
    Object.assign(this, { _matchSubmitTimer: null, _matchReferences: [], _matchEvidence: null, _matchContentPrefetch: new Map(),
      _matchFrameBusy: false, _matchPreparing: false });
    this._setMatchPhase(PHASES.LOCKED);
    this._matchProgress('');
    this._recognitionStatus(this._matchLockStatus);
  },
};
