// The simulator drives the shared Three renderer from the canvas clock.
// It supplies a fixed viewpoint and never produces recognition pixels.
class SimulatedCameraSession {
  constructor(canvas, onFrame, onState) {
    this.canvas = canvas;
    this.onFrame = onFrame;
    this.onState = onState;
    this.mode = "simulated";
  }
  start() {
    this.stop();
    let lastFrame = null;
    const tick = () => {
      if (this.tick !== tick) return;
      this.raf = null;
      const now = Date.now();
      try {
        if (lastFrame === null || now - lastFrame >= 1000 / 30) {
          lastFrame = now;
          this.onFrame(now);
        }
        if (this.tick === tick) this.raf = this.canvas.requestAnimationFrame(tick);
      } catch (error) {
        this.stop();
        this.onState("error", error.message || String(error));
      }
    };
    this.tick = tick;
    this.onState("running");
    tick();
  }
  stop() {
    this.tick = null;
    if (this.raf != null) this.canvas.cancelAnimationFrame(this.raf);
    this.raf = null;
  }
}
module.exports = { SimulatedCameraSession };
