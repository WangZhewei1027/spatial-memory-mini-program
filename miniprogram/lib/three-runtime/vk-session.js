// Owns exactly one native session. Generation guards make late start/RAF callbacks
// harmless after hide, retry, or unload. OSD and metric SLAM run sequentially.
class VKSessionController {
  constructor({
    api,
    gl,
    size,
    onFrame,
    onState,
    onAnchors,
    now = Date.now,
    maxFps = 30,
    mode = "plane",
  }) {
    Object.assign(this, { api, gl, size, onFrame, onState, onAnchors, now, mode });
    // Bound camera rendering work independently of native recognition events.
    this.frameIntervalMs = maxFps > 0 ? 1000 / maxFps : 0;
    this.generation = 0;
    this.running = false;
  }
  start() {
    this.stop();
    this.anchorEvents = {};
    const generation = this.generation;
    const current = () => generation === this.generation;
    try {
      if (typeof this.api.createVKSession !== "function")
        throw new Error("当前环境没有 VisionKit，请用支持 AR 的真机");
      if (this.mode !== "osd" && this.api.isVKSupport && !this.api.isVKSupport("v2"))
        throw new Error("当前设备不支持 VisionKit v2，不能进行米制空间追踪");
      const session = (this.session = this.api.createVKSession({
        version: this.mode === "osd" ? "v1" : "v2",
        // VisionKit exposes metric SLAM through the v2 plane configuration.
        // Production consumes only camera poses; no plane anchors or hit tests.
        track: this.mode === "osd" ? { OSD: true } : { plane: { mode: 1, ...(this.mode === "slam" ? { force: true } : {}) } },
        gl: this.gl,
      }));
      if (!session) throw new Error("VisionKit 未返回会话");
      this.listeners = (this.mode === "slam" ? [] : ["addAnchors", "updateAnchors", "removeAnchors"]).map(
        (name) => {
          const handler = (anchors) => {
            if (!current()) return;
            this.anchorEvents[name] = (this.anchorEvents[name] || 0) + 1;
            this.onAnchors?.(name, anchors);
          };
          session.on(name, handler);
          return [name, handler];
        },
      );
      this.onState("starting");
      this.timer = setTimeout(() => {
        if (current())
          this.fail(
            new Error("VisionKit 启动超过 15 秒，请检查相机权限并重试"),
          );
      }, 15000);
      session.start((error) => {
        if (!current()) return;
        clearTimeout(this.timer);
        if (error) {
          this.fail(new Error(describeStartError(error)));
          return;
        }
        if (this.mode === "slam" && session.version !== "v2") {
          this.fail(new Error("当前设备未启用 VisionKit v2，无法将内容固定在真实空间中"));
          return;
        }
        this.running = true;
        this.lastFrameAt = null;
        this.onState("running");
        const tick = () => {
          if (!current() || !this.running) return;
          this.raf = null;
          try {
            const now = this.now();
            const interval = this.frameIntervalMs;
            if (
              interval === 0 ||
              this.lastFrameAt == null ||
              now - this.lastFrameAt >= interval
            ) {
              const delta =
                this.lastFrameAt == null ? interval : now - this.lastFrameAt;
              this.lastFrameAt =
                interval === 0 ? now : now - (delta % interval);
              const { width, height } = this.size();
              const start = this.now();
              const frame = session.getVKFrame(width, height);
              // Process native textures immediately; never retain a VKFrame across ticks.
              this.onFrame(frame, { now, acquireMs: this.now() - start });
            }
          } catch (error) {
            this.fail(error);
            return;
          }
          if (current() && this.running)
            this.raf = session.requestAnimationFrame(tick);
        };
        this.raf = session.requestAnimationFrame(tick);
      });
    } catch (error) {
      this.fail(error);
    }
  }
  fail(error) {
    this.stop();
    this.onState("error", error.message || String(error));
  }
  addOSDMarker(path) {
    if (!this.running || this.mode !== "osd" || typeof this.session.addOSDMarker !== "function")
      throw new Error("当前微信不支持图片识别，请更新微信后重试");
    const id = this.session.addOSDMarker(path);
    if (!Number.isInteger(id) || id < 0) throw new Error("参考图无法用于识别，请更换清晰的目标图片");
    return id;
  }
  removeOSDMarker(id) {
    if (this.running && this.mode === "osd") this.session.removeOSDMarker(id);
  }
  isTracking() {
    return this.running && this.session?.state === 1;
  }
  getOSDDiagnostics() {
    const state = { running: this.running, mode: this.mode, requestedVersion: this.mode === "osd" ? "v1" : "v2",
      sessionGeneration: this.generation,
      actualVersion: this.session?.version ?? null, state: this.session?.state ?? null,
      planeEnabled: this.mode !== "osd", planeResultsUsed: this.mode === "plane",
      canAddMarker: typeof this.session?.addOSDMarker === "function", nativeMarkerCount: null };
    if (this.mode === "osd") {
      state.anchorListeners = (this.listeners || []).map(([name]) => name);
      state.anchorEvents = { ...this.anchorEvents };
    }
    if (!this.running || this.mode !== "osd" || typeof this.session?.getAllOSDMarker !== "function") return state;
    try {
      const markers = this.session.getAllOSDMarker();
      if (Array.isArray(markers)) {
        state.nativeMarkerCount = markers.length;
        state.nativeMarkers = markers.slice(0, 5).map(marker => ({ markerId: marker.markerId,
          file: typeof marker.path === "string" ? marker.path.split(/[?#]/)[0].split("/").pop().slice(0, 120) : null }));
      } else state.markerReadError = "unexpected_marker_list";
    } catch (error) { state.markerReadError = error.message || error.errMsg || "marker_read_failed"; }
    return state;
  }
  hitTest(x = 0.5, y = 0.5) {
    if (!this.running || this.mode !== "plane") return [];
    return this.session.hitTest(x, y) || [];
  }
  stop() {
    this.generation++;
    this.running = false;
    clearTimeout(this.timer);
    const session = this.session;
    this.session = null;
    if (session) {
      if (this.raf != null) {
        try {
          session.cancelAnimationFrame(this.raf);
        } catch (_) {}
      }
      for (const [name, handler] of this.listeners || []) {
        try {
          session.off(name, handler);
        } catch (_) {}
      }
      try {
        session.stop();
      } catch (_) {}
      try {
        session.destroy();
      } catch (_) {}
    }
    this.raf = null;
    this.listeners = [];
  }
}
function describeStartError(error) {
  const code =
    typeof error === "number" ? error : (error.errCode ?? error.code);
  const messages = {
    104: "用户取消相机授权",
    112: "请在微信小程序隐私协议中声明相机接口",
    2000002: "设备不支持 VisionKit v2",
    2000003: "系统不支持 VisionKit v2",
    2000004: "设备不支持 VisionKit v2",
    2003000: "AR 会话不可用",
    2003001: "请开启微信的系统相机权限",
    2003002: "请开启小程序的相机权限",
  };
  return `${messages[code] || error.errMsg || "VisionKit 启动失败"} (${code ?? JSON.stringify(error)})`;
}
module.exports = { VKSessionController, describeStartError };
