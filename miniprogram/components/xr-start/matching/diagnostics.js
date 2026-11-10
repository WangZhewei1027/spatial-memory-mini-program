const config = require('./config');
const round = value => Number.isFinite(value) ? +value.toFixed(3) : null;

// Bounded, permanent diagnostics. No images, embeddings, URLs or coordinates.
module.exports = {
  _startMatchDiagnostics(source = 'automatic') {
    if (config.debugLogs === false || this._matchDiagnostics) return;
    const now = Date.now();
    const d = this._matchDiagnostics = { source, startedAt: now, stage: 'waiting_camera', stageAt: now,
      cameraFrames: 0, captured: 0, inferred: 0, invalidPixels: 0, staleResults: 0, busyFrames: 0,
      lastFrameAt: null, submittedAt: null, lastResult: null, lastDecision: null };
    this._matchLog('识别启动', { source, automatic: true, intervalMs: config.frameIntervalMs });
    const report = () => {
      if (this._matchDiagnostics !== d || this._disposed || this._retrievalPaused) return;
      this._reportMatchDiagnostics();
      this._matchDiagnosticTimer = setTimeout(report, config.diagnosticIntervalMs);
    };
    this._matchDiagnosticTimer = setTimeout(report, config.diagnosticIntervalMs);
  },
  _matchStage(stage) {
    const d = this._matchDiagnostics;
    if (d && d.stage !== stage) { d.stage = stage; d.stageAt = Date.now(); }
  },
  _recordMatchDecision(fields) {
    const d = this._matchDiagnostics;
    if (!d) return;
    d.lastResult = { ...fields, topScore: round(fields.topScore), secondScore: round(fields.secondScore),
      margin: round(fields.margin) };
    const key = `${fields.reason}:${fields.topId || ''}:${fields.observations || 0}`;
    // Log first result / reason transitions / confirmation progress immediately;
    // unchanged decisions are included in the 3-second summary, not every frame.
    if (key !== d.lastDecision) this._matchLog('匹配结果', d.lastResult);
    d.lastDecision = key;
  },
  _reportMatchDiagnostics(reason = 'periodic') {
    const d = this._matchDiagnostics;
    if (!d) return;
    const now = Date.now();
    this._matchLog('扫描摘要', { reason, stage: d.stage, stageMs: now - d.stageAt,
      cameraFrames: d.cameraFrames, captured: d.captured, inferred: d.inferred,
      invalidPixels: d.invalidPixels, staleResults: d.staleResults, busyFrames: d.busyFrames,
      frameAgeMs: d.lastFrameAt == null ? null : now - d.lastFrameAt,
      workerBusy: !!this._matchFrameBusy,
      inFlightMs: this._matchFrameBusy && d.submittedAt != null ? now - d.submittedAt : 0,
      nextFrameInMs: Math.max(0, (this._nextMatchFrameAt || 0) - now),
      references: this._matchReferences?.length || 0, lastResult: d.lastResult });
  },
  _stopMatchDiagnostics(reason) {
    this._reportMatchDiagnostics(reason);
    clearTimeout(this._matchDiagnosticTimer); this._matchDiagnosticTimer = null; this._matchDiagnostics = null;
  },
};
