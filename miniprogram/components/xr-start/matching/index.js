const config = require("./config");
const { CONFIG, fetchAnchorCandidates, fetchAnchorContent } = require("../../../utils/backend");
const { loadOSDReference } = require("./reference");
const { removeFile } = require("../../../lib/three-runtime/resources");
const matchLog = require("./log");
const { methods: diagnostics, pathInfo } = require("./diagnostics");

function gpsBody(gps) {
  return { workspace_id: CONFIG.workspaceId, latitude: gps.latitude, longitude: gps.longitude,
    accuracy: gps.accuracy, gps_timestamp: gps.sampledAt, coordinate_system: "wgs84" };
}
function checked(response) {
  if (response.statusCode !== 200) throw new Error(response.data?.error || "请求失败，请重新扫描");
  return response.data;
}
function candidatesFrom(data) {
  if (!Array.isArray(data?.candidates) || data.candidates.length > 200) throw new Error("识别目标数据无效");
  const ids = new Set();
  for (const item of data.candidates) {
    if (!item || typeof item.id !== "string" || !item.id || ids.has(item.id) ||
        typeof item.name !== "string" || typeof item.image_url !== "string" || !/^https?:\/\//.test(item.image_url) ||
        typeof item.reference_version !== "string" || !item.reference_version)
      throw new Error("识别目标数据无效");
    ids.add(item.id);
  }
  return data.candidates;
}

function locate() {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("定位超时，请检查定位权限")),
      12000,
    );
    wx.getLocation({
      type: "wgs84",
      isHighAccuracy: true,
      highAccuracyExpireTime: 3000,
      success: (res) => {
        clearTimeout(timer);
        resolve({ ...res, sampledAt: Date.now() });
      },
      fail: () => {
        clearTimeout(timer);
        reject(new Error("定位失败，请开启微信定位权限"));
      },
    });
  });
}

module.exports = {
  ...diagnostics,
  _recognitionStatus(message) {
    if (!this._disposed) this.triggerEvent("recognitionstatus", {
      mode: this.retrievalMode, message, locked: this._osdPhase === "locked",
    });
  },
  _recognitionCurrent(epoch) {
    return this._modeEpoch === epoch && !this._disposed && !this._retrievalPaused &&
      this.retrievalMode === "anchor" && this._arReady;
  },
  _releaseOSDMarkers(reason = "replace_batch") {
    this.reportOSDScan(reason);
    this._osdDiagnostics = null;
    this._osdBatchEpoch = (this._osdBatchEpoch || 0) + 1;
    // Detach the registry before native removal can emit synchronous callbacks.
    const markers = this._osdMarkers;
    this._osdMarkers = new Map();
    this._osdEvidence = null;
    for (const [id, entry] of markers || []) {
      try { this._runtime?.session.removeOSDMarker(id); }
      catch (error) { matchLog("移除识别目标失败", { message: error.message }, "warn"); }
      removeFile(entry.path);
    }
  },
  _cancelRetrieval() {
    this._modeEpoch++;
    this._releaseOSDMarkers("cancel");
    this._osdPhase = "idle";
    this._pendingOSDPlacement = null;
    this._osdPreparing = false;
    this._osdCandidates = [];
    this._nextRecognitionAt = 0;
    this._recognitionGPS = null;
    this._recognitionGPSRequest = null;
    this.isFetchingAssets = false;
    this._isFetchingHuge = false;
  },
  rescan() {
    if (this._disposed || this._retrievalPaused || this.retrievalMode !== "anchor") return;
    this._cancelRetrieval();
    this._clearRemoteAssets();
    this._recognitionStatus("正在准备重新扫描…");
    if (this._ensureARMode("osd", { restart: true })) void this.recognizeAnchor();
  },
  setRetrievalMode(mode) {
    if (!["gps", "anchor"].includes(mode) || mode === this.retrievalMode || this._disposed) return;
    this._cancelRetrieval();
    this._clearRemoteAssets();
    this.retrievalMode = mode;
    this.setData({ retrievalMode: mode });
    this._recognitionStatus(mode === "anchor" ? "请将镜头对准目标" : "根据附近位置直接显示素材");
    if (!this._ensureARMode(mode === "anchor" ? "osd" : "slam")) return;
    if (mode === "anchor") void this.recognizeAnchor();
    else {
      this._maybeStartConfetti?.();
      this.fetchNearbyAssets();
      this.fetchHugeAssets();
    }
  },
  pauseRetrieval() {
    this._cancelScenePreview?.();
    this._retrievalPaused = true;
    this._cancelRetrieval();
    this._clearRemoteAssets();
  },
  resumeRetrieval() {
    if (!this._retrievalPaused || this._disposed) return;
    this._retrievalPaused = false;
    if (!this._ensureARMode(this._desiredARMode())) return;
    if (this._scenePreviewMode) { if (this._arReady) this._beginScenePreview(); return; }
    this._maybeStartConfetti?.();
    if (this._arReady) { this.fetchNearbyAssets(); this.fetchHugeAssets(); }
  },
  async recognizeAnchor() {
    if (!this._recognitionCurrent(this._modeEpoch) || this._osdPreparing ||
        this._runtime?.session.mode !== "osd" ||
        ["loading", "tracking", "locked"].includes(this._osdPhase) || Date.now() < this._nextRecognitionAt) return;
    if (!CONFIG.workspaceId) {
      this._nextRecognitionAt = Infinity;
      this._recognitionStatus("请先选择具体地图");
      return;
    }
    const epoch = this._modeEpoch;
    let batchEpoch = this._osdBatchEpoch || 0;
    const current = () => this._recognitionCurrent(epoch) && batchEpoch === (this._osdBatchEpoch || 0);
    this._osdPreparing = true;
    const refreshing = this._osdPhase === "scanning" && this._osdMarkers?.size > 0;
    if (!refreshing) {
      this._osdPhase = "preparing";
      this._osdLog("准备扫描", { workspaceId: CONFIG.workspaceId,
        native: this._runtime?.session?.getOSDDiagnostics?.() || null });
    }
    try {
      if (!this._osdCandidates?.length || this._osdCursor >= this._osdCandidates.length) {
        if (!refreshing) this._recognitionStatus("正在获取附近识别目标…");
        const gps = await this._locateForRecognition(epoch);
        if (!current()) return;
        this._osdLog("定位就绪", { source: gps.source, accuracyM: gps.accuracy, ageMs: Date.now() - gps.sampledAt });
        const requestAt = Date.now();
        const response = await fetchAnchorCandidates(gpsBody(gps));
        if (!current()) return;
        this._osdLog("候选接口返回", { status: response.statusCode, elapsedMs: Date.now() - requestAt });
        const data = checked(response);
        if (!current()) return;
        this._osdCandidates = candidatesFrom(data);
        this._osdCursor = 0;
        this._osdLog("附近目标", { count: this._osdCandidates.length, radiusM: data.gps_radius_meters,
          targets: this._osdCandidates.slice(0, config.batchSize).map(c => ({ id: c.id, name: c.name, distanceM: c.distance_meters })),
          listed: Math.min(this._osdCandidates.length, config.batchSize) });
      }
      if (!this._osdCandidates.length) {
        this._releaseOSDMarkers("no_candidates");
        this._osdPhase = "empty";
        this._nextRecognitionAt = Date.now() + config.emptyRetryMs;
        this._recognitionStatus("附近没有识别目标，请走近目标后重新扫描");
        return;
      }
      const batch = this._osdCandidates.slice(this._osdCursor, this._osdCursor + config.batchSize);
      this._osdCursor += batch.length;
      const candidates = new Map(batch.map(candidate => [candidate.id, candidate]));
      if (refreshing && this._osdMarkers.size === batch.length &&
          [...this._osdMarkers.values()].every(ref => candidates.get(ref.id)?.reference_version === ref.reference_version)) {
        // Refresh metadata without interrupting native detection or an in-progress
        // confirmation. Signed URLs may change while the reference version stays put.
        for (const [id, ref] of this._osdMarkers)
          this._osdMarkers.set(id, { ...candidates.get(ref.id), path: ref.path });
        this._nextRecognitionAt = Date.now() + config.batchDurationMs;
        this._osdLog("继续扫描", { registered: this._osdMarkers.size, referencesUnchanged: true });
        return;
      }
      // Keep the previous batch active during discovery. A match releases it and
      // changes batchEpoch, so a late refresh cannot overwrite loading/locked state.
      this._osdPhase = "preparing";
      this._releaseOSDMarkers();
      batchEpoch = this._osdBatchEpoch;
      this._beginOSDDiagnostics();
      const failures = [];
      for (const candidate of batch) {
        if (!current()) return;
        this._recognitionStatus(`正在准备参考图（${this._osdMarkers.size + 1}/${batch.length}）…`);
        let path;
        const referenceAt = Date.now();
        this._osdLog("准备参考图", { anchorId: candidate.id, name: candidate.name,
          reference: pathInfo(candidate.image_url), version: candidate.reference_version.slice(0, 12) });
        try {
          path = await loadOSDReference(candidate.image_url, current, (stage, fields) => {
            if (current()) this._osdLog("参考图处理", { anchorId: candidate.id, stage, ...fields });
          });
          if (!current()) { removeFile(path); return; }
          const markerId = this._runtime.session.addOSDMarker(path);
          if (this._osdMarkers.has(markerId)) throw new Error("识别目标编号重复，请重新扫描");
          this._osdMarkers.set(markerId, { ...candidate, path });
          this._osdLog("标记已注册", { anchorId: candidate.id, name: candidate.name, markerId,
            path: pathInfo(path), elapsedMs: Date.now() - referenceAt });
        } catch (error) {
          removeFile(path);
          if (!current()) return;
          failures.push(`${candidate.name || "参考图"}：${error.message || "加载失败"}`);
          this._osdLog("参考图失败", { anchorId: candidate.id, message: error.message || error.errMsg || "加载失败" }, "warn");
        }
      }
      if (!current()) return;
      this._osdEvidence = null;
      this._osdPhase = this._osdMarkers.size ? "scanning" : "error";
      this._nextRecognitionAt = Date.now() + (this._osdMarkers.size ? config.batchDurationMs : config.errorRetryMs);
      if (this._osdDiagnostics) this._osdDiagnostics.reportedAt = Date.now();
      this._osdLog("开始扫描", { registered: this._osdMarkers.size, failed: failures.length,
        identity: "markerId",
        batchDurationMs: config.batchDurationMs, minimumObservations: config.minimumObservations,
        confirmDurationMs: config.confirmDurationMs, native: this._runtime?.session?.getOSDDiagnostics?.() || null });
      this._recognitionStatus(this._osdMarkers.size
        ? `请对准目标，保持片刻${this._osdCandidates.length > config.batchSize ? ` · 正在扫描第 ${Math.ceil(this._osdCursor / config.batchSize)} 组` : ""}${failures.length ? ` · ${failures.length} 张参考图不可用` : ""}`
        : failures[0] || "参考图不可用，请重新扫描");
    } catch (error) {
      if (!current()) return;
      this._osdLog("扫描准备失败", { message: error.message || error.errMsg || "未知错误" }, "error");
      this._releaseOSDMarkers();
      this._osdCandidates = [];
      this._osdPhase = "error";
      this._nextRecognitionAt = Date.now() + config.errorRetryMs;
      this._recognitionStatus(error.message || "识别准备失败，请重新扫描");
    } finally {
      if (this._modeEpoch === epoch) this._osdPreparing = false;
    }
  },
  handleOSDAnchors(event, anchors) {
    this._recordOSDEvent(event, anchors);
    if (!this._recognitionCurrent(this._modeEpoch) || this._osdPhase !== "scanning") {
      this._ignoreOSD("phase_not_scanning"); return;
    }
    if (!Array.isArray(anchors)) { this._ignoreOSD("payload_not_array"); return; }
    if (event === "removeAnchors") {
      if (anchors.some(a => a && (a.markerId === this._osdEvidence?.id || a.id === this._osdEvidence?.anchorId))) this._resetOSDEvidence("target_removed");
      return;
    }
    const visible = anchors.filter(a => {
      // iOS can return an empty path; native paths can also differ from wx temp
      // paths. Identity is the markerId registered in this batch, within the
      // current VK session (whose generation guard discards old callbacks).
      const ref = this._osdMarkers.get(a?.markerId);
      const reason = !a || a.type !== 2 ? "not_osd_type" : !ref ? "unknown_marker"
        : !Number.isFinite(a.origin?.x) || !Number.isFinite(a.origin?.y) ||
          !Number.isFinite(a.size?.width) || a.size.width <= 0 || !Number.isFinite(a.size?.height) || a.size.height <= 0 ? "invalid_rect" : null;
      if (reason) { this._rejectOSD(reason, a); return false; }
      if (this._osdDiagnostics) this._osdDiagnostics.accepted++;
      return true;
    });
    const ids = new Set(visible.map(a => a.markerId));
    if (ids.size !== 1) { this._resetOSDEvidence(ids.size ? "multiple_targets" : "no_valid_target"); return; }
    const anchor = visible[0], now = Date.now();
    let evidence = this._osdEvidence;
    if (!evidence || evidence.id !== anchor.markerId || now - evidence.lastAt > config.maxObservationGapMs) {
      this._resetOSDEvidence(evidence?.id !== anchor.markerId ? "target_changed" : "observation_gap");
      evidence = this._osdEvidence = { id: anchor.markerId, anchorId: anchor.id, since: now, lastAt: now, count: 0 };
    }
    evidence.count++;
    evidence.lastAt = now;
    const confirmed = evidence.count >= config.minimumObservations && now - evidence.since >= config.confirmDurationMs;
    this._logOSDProgress(evidence, confirmed);
    if (confirmed)
      void this._acceptOSDMatch(this._osdMarkers.get(anchor.markerId));
  },
  async _acceptOSDMatch(candidate) {
    if (this._osdPhase !== "scanning" || !candidate) return;
    const epoch = this._modeEpoch, matchedAt = Date.now();
    this._osdPhase = "loading";
    this._releaseOSDMarkers("matched");
    this._nextRecognitionAt = Infinity;
    this._recognitionStatus(`已识别：${candidate.name || "目标"}，正在加载内容…`);
    try {
      const gps = await this._locateForRecognition(epoch);
      if (!this._recognitionCurrent(epoch)) return;
      const requestAt = Date.now();
      this._osdLog("读取命中内容", { anchorId: candidate.id });
      const response = await fetchAnchorContent({ ...gpsBody(gps), anchor_id: candidate.id, reference_version: candidate.reference_version });
      if (!this._recognitionCurrent(epoch)) return;
      this._osdLog("内容接口返回", { anchorId: candidate.id, status: response.statusCode, elapsedMs: Date.now() - requestAt });
      const result = checked(response);
      if (result?.anchor?.id !== candidate.id || !Array.isArray(result.assets)) throw new Error("目标内容数据无效，请重新扫描");
      const assets = result.assets.filter(a => a && typeof a.id === "string" && ["text", "image", "model", "audio", "video", "scene"].includes(a.file_type));
      this._pendingOSDPlacement = { epoch, matchedAt, candidate, assets };
      this._osdPhase = "tracking";
      this._recognitionStatus(`已识别：${candidate.name || "目标"} · 请缓慢左右移动手机，建立空间定位`);
      this._osdLog("切换空间追踪", { anchorId: candidate.id, assets: assets.length });
      if (this._ensureARMode("slam")) this._finishOSDPlacement();
    } catch (error) {
      if (!this._recognitionCurrent(epoch)) return;
      // Explicit retry: don't immediately accept a different target after a content failure.
      this._osdPhase = "error";
      this._osdLog("命中内容失败", { anchorId: candidate.id, message: error.message || error.errMsg || "未知错误" }, "error");
      this._recognitionStatus(error.message || "内容加载失败，请重新扫描");
    }
  },
  _finishOSDPlacement() {
    const pending = this._pendingOSDPlacement;
    if (!pending || this._osdPhase !== "tracking" || !this._recognitionCurrent(pending.epoch) ||
        this._runtime?.session.mode !== "slam") return;
    this._pendingOSDPlacement = null;
    const { epoch, matchedAt, candidate, assets } = pending;
    this._clearRemoteAssets();
    this._matchedAnchorId = candidate.id;
    this._allowedAssetIds = new Set(assets.map(a => a.id));
    this._recognitionTiming = { requestId: `osd-${epoch}-${matchedAt}`, startedAt: matchedAt, matchedAt,
      anchorId: candidate.id, contentEpoch: this._contentEpoch };
    this._osdPhase = "locked";
    this.displayAssets(assets);
    this._osdLog("内容已锁定", { anchorId: candidate.id, assets: assets.length, space: "world", elapsedMs: Date.now() - matchedAt });
    this._recognitionStatus(`已识别：${candidate.name || "目标"}${assets.length ? " · 内容已固定在空间中" : " · 暂无关联内容"}`);
  },
  _watchedGPS() {
    const gps = this.currentGPS;
    if (!gps || !Number.isFinite(gps.sampledAt)) return null;
    if (Date.now() - gps.sampledAt > (config.gpsWatchMaxAgeMs ?? 10000)) return null;
    if (!Number.isFinite(gps.accuracy) || gps.accuracy < 0 || gps.accuracy > 100) return null;
    return { ...gps, source: "watch" };
  },

  _locateForRecognition(epoch) {
    // 首选持续定位：随人移动不断更新，大范围移动后也是最新位置，且无需等待。
    const watched = this._watchedGPS();
    if (watched) return Promise.resolve(watched);
    // 兜底：持续定位不可用或太旧时，才做单次高精度定位。
    if (this._recognitionGPS && Date.now() - this._recognitionGPS.sampledAt < (config.gpsCacheMs ?? 5000)) {
      return Promise.resolve({ ...this._recognitionGPS, source: "cache" });
    }
    if (this._recognitionGPSRequest?.epoch === epoch) {
      return this._recognitionGPSRequest.promise.then((gps) => ({ ...gps, source: "shared" }));
    }
    const request = { epoch };
    request.promise = locate().then((gps) => {
      gps = { ...gps, source: "fresh" };
      if (this._modeEpoch === epoch && !this._disposed && !this._retrievalPaused) this._recognitionGPS = gps;
      return gps;
    }).finally(() => {
      if (this._recognitionGPSRequest === request) this._recognitionGPSRequest = null;
    });
    this._recognitionGPSRequest = request;
    return request.promise;
  },

  _clearRemoteAssets() {
    this._recognitionTiming = null;
    this._contentEpoch++;
    for (const ctx of this._pendingAudioContexts || []) {
      try {
        ctx.stop();
        ctx.destroy();
      } catch (_) {}
    }
    this._pendingAudioContexts?.clear();
    this._allowedAssetIds.clear();
    this._placeQueue = [];
    this._pendingDisplayAssets = [];
    const clearedNodeCount = this.nodeList.length;
    for (const entry of this.nodeList) this._destroyNode(entry);
    this.nodeList = [];
    this.flyingDanmakus = [];
    this.stopRandomConfetti?.();
    if (clearedNodeCount || this._hugeNodeList?.length)
      this._osdLog("清空场景素材", { clearedNodeCount, hugeNodeCount: this._hugeNodeList?.length || 0 });
    for (const entry of this._hugeNodeList || []) this._destroyNode(entry);
    this._hugeNodeList = [];
    this._pendingHugeAssets = [];
    this._hugePlaceQueue = [];
    this._seenAssets.clear();
    this._firstRevealDone = false;
    this._matchedAnchorId = null;
    // 兜底回收此前构建异常留下的、未能登记的动态根节点。
    const orphans = [...(this.shadowRoot?.children || [])];
    for (const node of orphans) this._destroyNode({ node });
    if (orphans.length) matchLog("清理未登记场景节点", { count: orphans.length });
  },

};
