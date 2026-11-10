// Owns exactly one VisionKit v2 session. Generation guards make late start/RAF
// callbacks harmless after hide, retry, or unload. "slam" is the production
// metric pose mode; "plane" (with anchor events and hit tests) is lab-only.
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
      if (this.api.isVKSupport && !this.api.isVKSupport("v2"))
        throw new Error("当前设备不支持 VisionKit v2，不能进行米制空间追踪");
      const session = (this.session = this.api.createVKSession({
        version: "v2",
        // VisionKit exposes metric SLAM through the v2 plane configuration.
        // Production consumes only camera poses; no plane anchors or hit tests.
        track: { plane: { mode: 1, ...(this.mode === "slam" ? { force: true } : {}) } },
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
        // Metric SLAM needs v2; the lab plane mode tolerates a v1 fallback.
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
  isTracking() {
    return this.running && this.session?.state === 1;
  }
  getDiagnostics() {
    return { running: this.running, mode: this.mode, sessionGeneration: this.generation,
      actualVersion: this.session?.version ?? null, state: this.session?.state ?? null,
      anchorEvents: { ...this.anchorEvents } };
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
