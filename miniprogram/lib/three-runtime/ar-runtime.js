const { THREE, probeWebGL2, createCanvasFacade } = require("./runtime");
const { VKSessionController } = require("./vk-session");
const { sceneFarPlane } = require("./camera-clipping");
const {
  createCameraBackground,
  syncVKCamera,
} = require("./vk-renderer");
const { disposeTree } = require("./resources");
class ARRuntime {
  constructor(
    canvas,
    { width, height, onReady, onTick, onState, onAnchors, debugTimings = false },
  ) {
    this.canvas = canvas;
    this.onReady = onReady;
    this.onTick = onTick;
    this.onState = onState;
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
      this.scene = new THREE.Scene();
      // OSD scans without content; spatial display uses native v2 camera poses.
      this.camera = new THREE.PerspectiveCamera(60, 1, 0.01, 300);
      this.content = new THREE.Group();
      this.scene.add(this.content);
      this.scene.add(new THREE.AmbientLight(0xffffff, 3));
      const light = new THREE.DirectionalLight(0xffffff, 3);
      light.position.set(0, 3, 2);
      this.scene.add(light);
      this.background = createCameraBackground(gl);
      this.renderer.resetState();
      this.resize(width, height);
      this.session = new VKSessionController({
        api: wx,
        gl,
        maxFps: 30,
        mode: "slam",
        onAnchors,
        size: () => ({ width: canvas.width, height: canvas.height }),
        onFrame: (frame, timing) => this.frame(frame, timing),
        onState: (state, message) => {
          if (state === "error") {
            this.ready = false;
          }
          this.onState(state, message);
        },
      });
    } catch (error) {
      disposeTree(this.scene);
      this.background?.dispose();
      this.renderer?.dispose();
      throw error;
    }
  }
  resize(width, height) {
    width = Math.max(16, width);
    height = Math.max(16, height);
    this.renderer.setSize(width, height, false);
    if (this.session?.mode !== "slam") {
      this.camera.aspect = width / height;
      this.camera.updateProjectionMatrix();
    }
  }
  start(mode = this.session.mode) {
    this.stop();
    this.session.mode = mode;
    this.ready = false;
    this.tracking = null;
    this.shaderError = null;
    this.frames = 0;
    this.reportAt = null;
    this.startedAt = Date.now();
    this.lastFrameAt = null;
    this.validFrameAt = null;
    this.cameraFrameAt = null;
    if (mode === "osd") {
      this.camera.matrixAutoUpdate = this.camera.matrixWorldAutoUpdate = true;
      this.camera.position.set(0, 0, 0);
      this.camera.quaternion.identity();
      this.camera.scale.set(1, 1, 1);
      this.resize(this.canvas.width, this.canvas.height);
    }
    this.session.start();
  }
  stop() {
    this.ready = false;
    this.session.stop();
  }
  updateTracking(valid) {
    if (this.session.mode !== "slam" || this.tracking === valid) return;
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
    const spatial = this.session.mode === "slam";
    const poseValid = !spatial || (this.session.isTracking() &&
      syncVKCamera(this.camera, frame.camera, 0.01, this.camera.far));
    if (!spatial) this.camera.updateMatrixWorld(true);
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
    this.updateTracking(poseValid);
    // Never place or render spatial content against an initializing/stale pose.
    // Keep the camera background visible while native tracking recovers.
    if (!poseValid) {
      if (start - (this.validFrameAt || this.startedAt) > 30000)
        throw new Error("空间定位超过 30 秒，请在光线充足、有纹理的环境中重试");
      return;
    }
    this.validFrameAt = start;
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
    const far = sceneFarPlane(this.camera, this.content);
    if (far !== this.camera.far) {
      if (spatial) syncVKCamera(this.camera, frame.camera, 0.01, far);
      else {
        this.camera.far = far;
        this.camera.updateProjectionMatrix();
      }
    }
    const businessMs = Date.now() - businessAt,
      renderAt = Date.now();
    this.renderer.render(this.scene, this.camera);
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
    disposeTree(this.scene);
    this.background.dispose();
    this.renderer.dispose();
  }
}
module.exports = { ARRuntime };
