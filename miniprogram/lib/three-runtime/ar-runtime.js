const { THREE, probeWebGL2, createCanvasFacade, disposeRenderer } = require("./runtime");
const { VKSessionController } = require("./vk-session");
const { RenderLayers } = require("./render-layers");
const {
  createCameraBackground,
  syncVKCamera,
} = require("./vk-renderer");
class ARRuntime {
  constructor(
    canvas,
    { width, height, onReady, onTick, onState, onCameraFrame, requireTracking, onLayersChange, onLayerError, debugTimings = false },
  ) {
    this.canvas = canvas;
    this.onReady = onReady;
    this.onTick = onTick;
    this.onState = onState;
    this.onCameraFrame = onCameraFrame;
    this.requireTracking = requireTracking;
    this.debugTimings = debugTimings;
    try {
      const gl = (this.gl = canvas.getContext("webgl2", {
        alpha: false,
        antialias: false,
      }));
      const capabilities = probeWebGL2(gl);
      if (debugTimings) console.log("[ThreeAR][webgl2]", capabilities);
      this.facade = createCanvasFacade(canvas, gl, width, height);
      this.renderer = new THREE.WebGLRenderer({
        canvas: this.facade,
        context: gl,
        alpha: false,
        antialias: false,
      });
      this.renderer.autoClear = false;
      this.renderer.setClearColor(0x14202b, 1);
      this.renderer.debug.onShaderError = (context, program) => {
        this.shaderError =
          context.getProgramInfoLog(program) || "Three shader 编译失败";
      };
      // Modules share the native camera, renderer and frame clock, not a content tree.
      this.camera = new THREE.PerspectiveCamera(60, 1, 0.01, 300);
      this.layers = new RenderLayers({ renderer: this.renderer, camera: this.camera,
        onChange: onLayersChange, onError: onLayerError,
        getRenderError: () => { const message = this.shaderError; this.shaderError = null; return message ? new Error(message) : null; },
      });
      this.renderer.info.autoReset = false;
      this.background = createCameraBackground(gl);
      this.renderer.resetState();
      this.resize(width, height);
      this.session = new VKSessionController({
        api: wx,
        gl,
        maxFps: 30,
        mode: "slam",
        size: () => ({ width: canvas.width, height: canvas.height }),
        onFrame: (frame, timing) => this.frame(frame, timing),
        onState: (state, message) => {
          if (state === "error") {
            this.ready = false;
            this.layers.pause();
          }
          this.onState(state, message);
        },
      });
    } catch (error) {
      this.layers?.dispose();
      this.background?.dispose();
      disposeRenderer(this.renderer);
      throw error;
    }
  }
  resize(width, height) {
    width = Math.max(16, width);
    height = Math.max(16, height);
    this.renderer.setSize(width, height, false);
    this.layers?.resize(width, height);
    // Before the first native pose; afterwards VisionKit supplies the projection.
    if (!this.session) {
      this.camera.aspect = width / height;
      this.camera.updateProjectionMatrix();
    }
  }
  start() {
    this.stop();
    this.layers.clear("session");
    this.layers.start();
    this.ready = false;
    this.tracking = null;
    this.shaderError = null;
    this.frames = 0;
    this.reportAt = null;
    this.startedAt = Date.now();
    this.lastFrameAt = null;
    this.validFrameAt = null;
    this.cameraFrameAt = null;
    this.trackingWaitAt = null;
    this.session.start();
  }
  stop() {
    this.ready = false;
    this.layers?.pause();
    this.session.stop();
  }
  updateTracking(valid) {
    if (this.tracking === valid) return;
    this.tracking = valid;
    this.onState(valid ? (this.ready ? "trackingrestored" : "trackingready") : "tracking",
      valid ? "空间追踪已就绪" : "请缓慢左右移动手机，建立空间定位…");
  }
  frame(frame, { now, acquireMs }) {
    const start = Date.now();
    if (!frame) {
      this.updateTracking(false);
      if (start - (this.cameraFrameAt || this.startedAt) > 10000)
        throw new Error("未取得相机帧，请检查设备兼容性和权限");
      return;
    }
    this.renderer.info?.reset?.();
    const poseValid = this.session.isTracking() &&
      syncVKCamera(this.camera, frame.camera, 0.01, this.camera.far);
    const matrixMs = Date.now() - start;
    const backgroundAt = Date.now();
    if (
      !this.background.draw(
        frame,
        this.renderer,
        this.canvas.width,
        this.canvas.height,
      )
    ) {
      this.updateTracking(false);
      if (start - (this.cameraFrameAt || this.startedAt) > 10000)
        throw new Error("无法获取相机纹理，请检查 VisionKit/WebGL2 兼容性");
      return;
    }
    this.cameraFrameAt = start;
    const backgroundMs = Date.now() - backgroundAt;
    // Image recognition needs pixels, not a metric pose. This synchronous hook
    // consumes any requested native buffer before VKFrame's lifetime ends.
    this.onCameraFrame?.(frame);
    this.updateTracking(poseValid);
    // Never place or render spatial content against an initializing/stale pose.
    // Keep the camera background visible while native tracking recovers.
    if (!poseValid) {
      this.layers.update(now, false);
      this.layers.render(false);
      if (this.requireTracking?.() === false) this.trackingWaitAt = null;
      else if (this.trackingWaitAt == null) this.trackingWaitAt = start;
      if (this.trackingWaitAt != null && start - this.trackingWaitAt > 30000)
        throw new Error("空间定位超过 30 秒，请在光线充足、有纹理的环境中重试");
      return;
    }
    this.validFrameAt = start;
    this.trackingWaitAt = null;
    if (!this.ready) {
      this.ready = true;
      this.onReady();
    }
    // Scene time must keep pace with native audio even when rendering drops frames.
    // start() resets the baseline so time spent in the background is excluded.
    const dt =
      this.lastFrameAt == null
        ? 0
        : Math.max(0, (now - this.lastFrameAt) / 1000);
    this.lastFrameAt = now;
    const businessAt = Date.now();
    this.onTick(dt);
    this.layers.update(now, true);
    const far = this.layers.farPlane();
    if (far !== this.camera.far) syncVKCamera(this.camera, frame.camera, 0.01, far);
    const businessMs = Date.now() - businessAt,
      renderAt = Date.now();
    this.layers.render(true);
    if (this.shaderError) throw new Error(this.shaderError);
    this.frames = (this.frames || 0) + 1;
    if (!this.reportAt) this.reportAt = now;
    if (this.debugTimings && now - this.reportAt >= 2000) {
      console.log(
        "[ThreeAR][timings]",
        JSON.stringify({
          fps: +((this.frames * 1000) / (now - this.reportAt)).toFixed(1),
          acquireMs,
          matrixMs,
          backgroundSubmitMs: backgroundMs,
          businessMs,
          threeSubmitMs: Date.now() - renderAt,
          frameWorkMs: Date.now() - start + acquireMs,
          drawCalls: this.renderer.info.render.calls,
          geometries: this.renderer.info.memory.geometries,
          textures: this.renderer.info.memory.textures,
          note: "JS/API submission time; GPU completion not measured",
        }),
      );
      this.frames = 0;
      this.reportAt = now;
    }
  }
  dispose() {
    this.disposed = true;
    this.stop();
    this.layers.dispose();
    this.background.dispose();
    disposeRenderer(this.renderer);
  }
}
module.exports = { ARRuntime };
