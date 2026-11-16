const XR_CONFIG = require("./config");
const { reportError } = require("../../utils/report-error");
const scenePreview = require("./scene-preview");
const gps = require("./gps");
const navigation = require("./navigation");
const matching = require("./matching/index");
const { initialRecognitionState } = require("./matching/state");
const mapConfig = require("./map-config");
const { THREE } = require("../../lib/three-runtime/runtime");
const { ARRuntime } = require("../../lib/three-runtime/ar-runtime");
const {
  ModelCache,
  disposeTree,
} = require("../../lib/three-runtime/resources");
const assetsMethods = require("./assets/index")(XR_CONFIG);
const renderModuleMethods = require("./render-modules/index")(XR_CONFIG);
const repulsionMethods = require("./effects/repulsion")(XR_CONFIG);
const hugeMethods = require("./assets/huge")(XR_CONFIG);
const confettiMethods = require("./effects/confetti")(XR_CONFIG);
function buildInitialState() {
  return {
    retrievalMode: "gps",
    _modeEpoch: 0,
    _contentEpoch: 0,
    _allowedAssetIds: new Set(),
    ...initialRecognitionState(),
    _disposed: false,
    _retrievalPaused: false,
    nodeIdCounter: 0,
    nodeList: [], // [{ assetId, node, billboardEl, trs, billboardTrs, type, bucket, bornAt, audioRefs, videoRefs, imageRefs, modelAnim? }]
    // 音频节点子列表（audioRefs 非空的 entry），由 queue 在注册/销毁时维护，
    // tickAudioVolume 直接用，避免每帧 nodeList.filter 分配
    _audioEntries: [],

    // assetId → 被驱逐时刻：repeatCooldownMs 类型（text/image）消失后冷却期内不重复放置
    _seenAssets: new Map(),
    // 首轮限量揭示是否已消耗（首轮 revealFirstFetch 加量，仅在实际放置过内容后置位）
    _firstRevealDone: false,
    spatialAudioList: [],
    // Three 渲染器初始化完成后即可放置；文字无需背景图预加载。
    _preloadDone: false,
    _pendingDisplayAssets: [],
    _placeQueue: [],
    _placeDrain: null,
    _placingBusy: false,
    _placingAssetId: null,
    // 上次触发 fetchNearbyAssets 的时间戳（用于冷却判断）
    _lastFetchTime: 0,
    gpsReady: false,
    firstFetchDone: false,
    currentGPS: null,
    isFetchingAssets: false,
    _worldFetchRequest: null,
    // 导航状态
    _navTarget: null,
    _navActive: false,
    _compassHeading: null,
    _navNodes: [],
    _navParticleEls: [],
    _navLabelNode: null,
    _navLabelTextEl: null,
    _lastNavLabel: "",
    // 巨型远景模型
    _hugeNodeList: [],
    _pendingHugeAssets: [],
    _isFetchingHuge: false,
    _hugeFetchRequest: null,
    _hugeDrain: null,
    _hugePlacingBusy: false,
    // 随机彩带
    _confettiBursts: [],
    _confettiTimer: null,
    _confettiCounter: 0,
    _mapConfigReady: false,
    _mapConfigEpoch: 0,
    _mapConfigRequest: null,
    _assetsLoaded: false,
    _confettiEnabled: false,
    _textAssetStyle: "dialog_decorated",
  };
}

Component({
  properties: {
    sceneId: { type: String, value: "" },
    sceneOrganizationId: { type: String, value: "" },
    width: { type: Number, value: 300 },
    height: { type: Number, value: 300 },
  },
  observers: {
    "width,height"(width, height) {
      this._runtime?.resize(width, height);
    },
  },
  data: {
    arReady: false,
    cameraReady: false,
    retrievalMode: "gps",
    renderError: "",
    renderStatus: "正在启动 AR 相机…",
    canRetry: true,
  },
  lifetimes: {
    attached() {
      Object.assign(this, buildInitialState());
      this._pageVisible = true;
      this._forwardScratch = new THREE.Vector3();
      this._raycaster = new THREE.Raycaster();
      this._tapPoint = new THREE.Vector2();
      this._scenePreviewMode = !!this.data.sceneId;
      if (!this._scenePreviewMode) { this.startGPSWatch(); void this.loadMapConfig(); }
    },
    ready() {
      this.createSelectorQuery()
        .select("#ar-canvas")
        .fields({ node: true, size: true })
        .exec((result) => {
          if (this._disposed) return;
          try {
            const canvas = (this._canvas = result[0]?.node);
            if (!canvas) throw new Error("无法创建 AR 画布");
            this._runtime = new ARRuntime(canvas, {
              width: this.data.width,
              height: this.data.height,
              onReady: () => this.handleARReady(),
              onTick: (dt) => this.handleTick(dt),
              onState: (state, message) => this.onARState(state, message),
              onCameraFrame: (frame) => this.handleRecognitionFrame(frame),
              requireTracking: () => this._scenePreviewMode || this.retrievalMode !== "anchor" || ["tracking", "locked"].includes(this._matchPhase),
              debugTimings: XR_CONFIG.debugLog,
              onLayersChange: layers => this.onRenderLayersChange(layers),
              onLayerError: event => this.onRenderLayerError(event),
            });
            this._attachRenderModules();
            this._modelCache = new ModelCache(
              canvas,
              XR_CONFIG.maxCachedModelUrls || 8,
            );
            this._hugeModelCache = new ModelCache(
              canvas,
              XR_CONFIG.maxCachedHugeUrls || 3,
            );
            this._preloadDone = this._assetsLoaded = true;
            if (this._pageVisible) this.startAR();
          } catch (error) {
            this.onARState("error", error.message);
          }
        });
    },
    detached() {
      this.pauseRetrieval();
      this._disposed = true;
      this._arReady = false;
      clearTimeout(this._firstFetchTimer);
      if (this._gpsListener) wx.offLocationChange(this._gpsListener);
      this._runtime?.dispose();
      this._modelCache?.dispose();
      this._hugeModelCache?.dispose();
      this._runtime = null;
      this.scene = null;
      this._canvas = null;
    },
  },
  pageLifetimes: {
    hide() {
      this._pageVisible = false;
      this._mapConfigEpoch++;
      this._mapConfigRequest = null;
      this._mapConfigReady = false;
      this.pauseRetrieval();
      this._arReady = false;
      this._sessionActive = false;
      this._runtime?.stop();
      clearTimeout(this._firstFetchTimer);
      this._firstFetchStarted = false;
      this.setData({ arReady: false });
    },
    show() {
      this._pageVisible = true;
      if (this._scenePreviewMode) this._retrievalPaused = false;
      else void this.loadMapConfig();
      if (this._runtime && !this._sessionActive) this.startAR();
    },
  },
  methods: {
    ...scenePreview,
    ...mapConfig,
    ...gps,
    ...matching,
    ...assetsMethods,
    ...renderModuleMethods,
    ...repulsionMethods,
    ...navigation,
    ...hugeMethods,
    ...confettiMethods,
    getCamTransform() {
      return this._arReady ? this._runtime?.camera : null;
    },
    startAR() {
      if (this._disposed || !this._runtime || this._sessionActive) return;
      this._ensureARSession();
    },
    // Camera, recognition and display share one SLAM session; rescans reuse it.
    _ensureARSession() {
      if (this._disposed || this._pageVisible === false || !this._runtime || this._contextLost || (!this._scenePreviewMode && !this._mapConfigReady)) return false;
      if (this._sessionActive) return this._arReady;
      clearTimeout(this._firstFetchTimer);
      this._firstFetchStarted = false;
      this._arReady = false;
      this._cameraReady = false;
      this._sessionActive = true;
      this.setData({ arReady: false, cameraReady: false, renderError: "", renderStatus: "正在启动空间追踪…" });
      this._runtime.start();
      return this._arReady;
    },
    onARState(state, message) {
      if (this._runtime?.session) {
        console[state === "error" ? "error" : "log"]("[SLAM] 相机会话", JSON.stringify({
          state, message, native: this._runtime.session.getDiagnostics(),
        }));
      }
      if (this._disposed) return;
      if (state === "error") {
        clearTimeout(this._firstFetchTimer);
        this._firstFetchStarted = false;
        this._sessionActive = false;
        this._arReady = false;
        this._cancelScenePreview();
        this._cancelRetrieval();
        this._clearRemoteAssets();
        this.setData({
          arReady: false,
          renderError: message || "AR 初始化失败",
          renderStatus: "",
          canRetry: !!this._runtime && !this._contextLost,
        });
      } else if (state === "tracking") {
        this._arReady = false;
        this.setData({ arReady: false, renderStatus: message });
      } else if (state === "trackingrestored") {
        this._arReady = true;
        this.setData({ arReady: true, renderStatus: "" });
        this._finishMatchPlacement();
        if (!this._placingBusy && this._placeQueue?.length) this._drainPlaceQueue();
      } else if (state !== "trackingready")
        this.setData({
          renderStatus:
            state === "running"
              ? "请缓慢左右移动手机，建立空间定位…"
              : "正在启动 AR 相机…",
        });
      this.triggerEvent("renderstatus", {
        state,
        message: message || "",
        renderer: "visionkit-three",
      });
    },
    handleARReady() {
      this._arReady = true;
      this._firstFetchStarted = false;
      this.setData({ arReady: true, renderStatus: "", renderError: "" });
      if (!this._placingBusy && this._placeQueue?.length) this._drainPlaceQueue();
      if (this._scenePreviewMode) { this._beginScenePreview(); return; }
      if (this.retrievalMode === "anchor") {
        if (this._matchPhase === "tracking") this._finishMatchPlacement();
        else void this.recognizeAnchor();
        return;
      }
      this._maybeStartFirstFetch();
      this.flushPendingDisplayAssets();
      this._maybeStartConfetti();
    },
    handleTick(dt) {
      if (this._disposed || !this._arReady) return;
      this._frameDelta = dt;
      if (this._scenePreviewMode) {
        this._tickScenePreview();
        return;
      }
      if (this._retrievalPaused) return;
      if (this.retrievalMode === "anchor") return;
      // Refresh nearby data periodically while spatial placement uses SLAM poses.
      const now = Date.now();
      if (now - this._lastFetchTime >= XR_CONFIG.gpsRefreshMs) {
        this._lastFetchTime = now;
        this.fetchNearbyAssets();
        this.fetchHugeAssets();
      }
    },
    _maybeStartConfetti() {
      if (
        this._arReady &&
        this._assetsLoaded &&
        this._confettiEnabled === true &&
        !this._retrievalPaused &&
        this.retrievalMode === "gps"
      )
        this.startRandomConfetti();
    },
    reportAssetError(asset, error) {
      if (this._disposed) return;
      console.warn("[ThreeAR][asset-error]", {
        assetId: asset?.id,
        type: asset?.file_type,
        message: error?.message || error?.errMsg || String(error),
      });
      reportError("asset", error, { assetId: asset?.id, type: asset?.file_type, alias: error?.alias, instanceId: error?.instanceId });
      this.triggerEvent("asseterror", {
        assetId: asset?.id,
        type: asset?.file_type,
        message: error?.message || error?.errMsg || "素材加载失败",
      });
    },
    onCanvasTap(event) {
      if (!this._arReady || this._retrievalPaused) return;
      const touch = event.changedTouches?.[0];
      if (!touch) return;
      this.createSelectorQuery()
        .select("#ar-canvas")
        .boundingClientRect((rect) => {
          if (!rect || !this._arReady || this._disposed) return;
          const x = (touch.clientX - rect.left) / rect.width,
            y = (touch.clientY - rect.top) / rect.height;
          this._tapPoint.set(x * 2 - 1, 1 - y * 2);
          this._raycaster.setFromCamera(this._tapPoint, this._runtime.camera);
          const hits = this._raycaster.intersectObjects(
            this.nodeList.map((e) => e.node),
            true,
          );
          if (hits.length) {
            let node = hits[0].object;
            while (node) {
              const entry = this.nodeList.find((e) => e.node === node);
              if (entry) {
                if (entry.onTap) {
                  entry.onTap();
                  return;
                }
                break;
              }
              node = node.parent;
            }
          }
        })
        .exec();
    },
    onContextLost(event) {
      this._runtime?.facade.dispatch("webglcontextlost", event.detail);
      this._runtime?.stop();
      this._contextLost = true;
      this.onARState("error", "渲染上下文已丢失，请返回首页后重新进入 AR");
    },
    onContextRestored() {
      if (!this._disposed)
        this.setData({
          renderError: "请返回首页后重新进入 AR，以重新建立相机和渲染资源",
        });
    },
    retryAR() {
      if (this._contextLost) return;
      if (!this._scenePreviewMode && !this._mapConfigReady) void this.loadMapConfig();
      else this.startAR();
    },
  },
});
