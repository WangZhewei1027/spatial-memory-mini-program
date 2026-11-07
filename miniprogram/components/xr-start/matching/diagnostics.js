const config = require("./config");
const log = require("./log");

// Paths identify the image/marker without disclosing signed URLs or user directories.
function pathInfo(path) {
  if (typeof path !== "string") return { kind: typeof path, file: null };
  if (!path) return { kind: "empty", file: null };
  const clean = path.split(/[?#]/)[0];
  return { kind: /^https?:/.test(path) ? "remote" : /(?:\/tmp\/|\/temp\/|tmp_)/.test(path) ? "temp" : "local",
    file: clean.split("/").pop().slice(0, 120) };
}
function anchorInfo(anchor) {
  if (!anchor || typeof anchor !== "object") return { valueType: typeof anchor };
  const scalar = value => typeof value === "number" || typeof value === "string" ? String(value).slice(0, 80) : null;
  return { id: scalar(anchor.id), type: scalar(anchor.type), markerId: scalar(anchor.markerId),
    markerIdType: typeof anchor.markerId, path: pathInfo(anchor.path),
    origin: { x: scalar(anchor.origin?.x), y: scalar(anchor.origin?.y) },
    size: { width: scalar(anchor.size?.width), height: scalar(anchor.size?.height) } };
}

const methods = {
  _osdLog(event, fields = {}, level = "info") {
    log(event, { run: this._osdDiagnostics?.run ?? this._modeEpoch, batch: this._osdBatchEpoch, phase: this._osdPhase, ...fields }, level);
  },
  _beginOSDDiagnostics() {
    if (config.debugLogs === false) return;
    this._osdDiagnostics = { run: this._modeEpoch, startedAt: Date.now(), reportedAt: Date.now(), callbacks: 0, observations: 0,
      accepted: 0, events: {}, rejected: {}, ignored: {}, resets: {}, bestCount: 0, bestDurationMs: 0,
      progressAt: -Infinity, sampleKeys: new Set() };
  },
  _sampleOSD(key, event, fields, level = "info") {
    const d = this._osdDiagnostics;
    if (!d || d.sampleKeys.has(key)) return;
    d.sampleKeys.add(key);
    this._osdLog(event, fields, level);
  },
  _recordOSDEvent(event, anchors) {
    const d = this._osdDiagnostics;
    if (!d) return;
    d.callbacks++;
    d.lastCallbackAt = Date.now();
    d.events[event] = (d.events[event] || 0) + 1;
    if (Array.isArray(anchors) && event !== "removeAnchors") d.observations += anchors.length;
    const shape = Array.isArray(anchors) ? anchors.length ? "nonempty" : "empty" : "invalid";
    this._sampleOSD(`event:${event}:${shape}`, "原生回调", { event,
      payloadType: Array.isArray(anchors) ? "array" : typeof anchors,
      count: Array.isArray(anchors) ? anchors.length : null,
      samples: Array.isArray(anchors) ? anchors.slice(0, 3).map(anchorInfo) : [] });
  },
  _rejectOSD(reason, anchor) {
    const d = this._osdDiagnostics;
    if (!d) return;
    d.rejected[reason] = (d.rejected[reason] || 0) + 1;
    this._sampleOSD(`reject:${reason}`, "回调被过滤", { reason, sample: anchorInfo(anchor),
      registeredReference: pathInfo(this._osdMarkers.get(anchor?.markerId)?.path) }, "warn");
  },
  _ignoreOSD(reason) {
    const d = this._osdDiagnostics;
    if (!d) return;
    d.ignored[reason] = (d.ignored[reason] || 0) + 1;
    this._sampleOSD(`ignore:${reason}`, "回调未进入确认", { reason });
  },
  _resetOSDEvidence(reason) {
    const d = this._osdDiagnostics;
    if (d && this._osdEvidence) {
      d.resets[reason] = (d.resets[reason] || 0) + 1;
      this._sampleOSD(`reset:${reason}`, "连续确认重置", { reason, observations: this._osdEvidence.count,
        durationMs: this._osdEvidence.lastAt - this._osdEvidence.since, gapMs: Date.now() - this._osdEvidence.lastAt });
    }
    this._osdEvidence = null;
  },
  _logOSDProgress(evidence, confirmed) {
    const d = this._osdDiagnostics;
    if (!d) return;
    const now = Date.now(), durationMs = now - evidence.since;
    d.bestCount = Math.max(d.bestCount, evidence.count);
    d.bestDurationMs = Math.max(d.bestDurationMs, durationMs);
    if (!confirmed && now - d.progressAt < 1000) return;
    d.progressAt = now;
    this._osdLog(confirmed ? "确认命中" : "连续确认进度", {
      markerId: evidence.id, anchorId: this._osdMarkers.get(evidence.id)?.id,
      observations: evidence.count, requiredObservations: config.minimumObservations,
      durationMs, requiredDurationMs: config.confirmDurationMs, maxGapMs: config.maxObservationGapMs });
  },
  reportOSDScan(reason = "periodic") {
    const d = this._osdDiagnostics, now = Date.now();
    if (!d || (reason === "periodic" && (this._osdPhase !== "scanning" || now - d.reportedAt < config.diagnosticIntervalMs))) return;
    d.reportedAt = now;
    const result = reason === "matched" ? "confirmed" : !d.callbacks ? "no_native_events"
      : !d.observations ? "no_observations" : !d.accepted
        ? Object.keys(d.rejected).length ? "all_observations_rejected" : "observations_ignored"
        : "awaiting_confirmation";
    this._osdLog("扫描摘要", { reason, result, elapsedMs: now - d.startedAt,
      callbacks: d.callbacks, events: { ...d.events }, observations: d.observations, accepted: d.accepted,
      rejected: { ...d.rejected }, ignored: { ...d.ignored }, resets: { ...d.resets },
      bestObservations: d.bestCount, bestDurationMs: d.bestDurationMs,
      lastCallbackAgeMs: d.lastCallbackAt == null ? null : now - d.lastCallbackAt,
      confirmation: this._osdEvidence ? { markerId: this._osdEvidence.id, count: this._osdEvidence.count,
        durationMs: this._osdEvidence.lastAt - this._osdEvidence.since, gapMs: now - this._osdEvidence.lastAt } : null,
      registered: this._osdMarkers.size,
      cameraFrameAgeMs: this._runtime?.validFrameAt ? Math.max(0, now - this._runtime.validFrameAt) : null,
      native: this._runtime?.session?.getOSDDiagnostics?.() || null });
  },
};
module.exports = { methods, pathInfo };
