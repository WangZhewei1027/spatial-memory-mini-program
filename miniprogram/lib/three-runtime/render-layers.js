const { THREE } = require("./runtime");
const { disposeTree } = require("./resources");
const { sceneFarPlane } = require("./camera-clipping");

/** One renderer/session, independently owned scenes. No feature names belong here. */
class RenderLayers {
  constructor({ renderer, camera, onError = console.error, onChange = () => {},
    createLighting = THREE.createSceneLighting, drawContent = THREE.renderSceneContent, getRenderError = () => null }) {
    Object.assign(this, { renderer, camera, onError, onChange, createLighting, drawContent, getRenderError });
    this.entries = new Map();
    this.nodeOwners = new WeakMap();
    this.sequence = 0;
    this.running = false;
    this.disposed = false;
    this.size = { width: 1, height: 1 };
  }
  report(entry, phase, error) {
    entry.error = error.message || String(error);
    try { this.onError({ moduleId: entry.id, phase, error }); } catch (_) {}
  }
  call(entry, name, ...args) {
    try { return entry.definition[name]?.(...args); }
    catch (error) { this.report(entry, name, error); return false; }
  }
  notify() {
    if (this.pendingNotify) return;
    this.pendingNotify = true;
    Promise.resolve().then(() => {
      this.pendingNotify = false;
      try { this.onChange(this.snapshot()); } catch (error) { console.warn("[render-layers] diagnostics", error); }
    });
  }
  snapshot() {
    return this.sorted().map(e => ({ id: e.id, label: e.definition.label || e.id, enabled: e.enabled,
      state: e.disposed ? "disposed" : !e.enabled ? "disabled" : this.running ? "running" : "paused",
      nodes: e.root.children.length, error: e.error || "" }));
  }
  sorted() {
    return [...this.entries.values()].sort((a, b) =>
      Number(a.depth === "isolated") - Number(b.depth === "isolated") || a.order - b.order || a.sequence - b.sequence);
  }
  register(definition) {
    const { id, order = 0, space = "world", depth = "shared" } = definition;
    if (this.disposed) throw new Error("Render layer registry is disposed");
    if (typeof id !== "string" || !id || this.entries.has(id)) throw new Error(`Duplicate/invalid render module: ${id}`);
    if (!Number.isFinite(order) || !["world", "view"].includes(space) || !["shared", "isolated"].includes(depth) || (space === "view" && depth !== "isolated"))
      throw new Error(`Invalid render policy: ${id}`);
    const scene = new THREE.Scene(), root = new THREE.Group();
    root.name = `layer:${id}`; scene.add(root);
    const e = { id, definition, order, space, depth, scene, root, owned: new Map(),
      enabled: definition.enabled !== false, generation: 0, disposed: false, clearing: false,
      sequence: this.sequence++, camera: space === "world" ? this.camera : new THREE.PerspectiveCamera(60, this.size.width / this.size.height, .01, 300), lastNow: null };
    const release = (node, cleanup) => {
      node.removeFromParent();
      try { if (cleanup) cleanup(); else disposeTree(node); }
      catch (error) { this.report(e, "release", error); }
    };
    const handle = {
      root,
      get active() { return !e.disposed && !e.clearing && e.enabled && registry.running; },
      get enabled() { return e.enabled && !e.disposed; },
      capture: () => {
        const generation = e.generation;
        return () => handle.active && generation === e.generation;
      },
      mount: (node, { current = handle.capture(), dispose } = {}) => {
        if (this.nodeOwners.has(node)) throw new Error(`Node already owned by ${this.nodeOwners.get(node)}`);
        if (!handle.active || !current()) { release(node, dispose); return false; }
        if (e.owned.has(node)) throw new Error(`Node already owned by ${id}`);
        this.nodeOwners.set(node, id);
        e.owned.set(node, dispose); root.add(node); this.notify(); return true;
      },
      remove: (node) => {
        if (!e.owned.has(node)) return false;
        const cleanup = e.owned.get(node); e.owned.delete(node); this.nodeOwners.delete(node);
        release(node, cleanup); this.notify(); return true;
      },
      clear: (reason = "clear") => {
        if (e.disposed || e.clearing) return;
        e.clearing = true; e.generation++; e.lastNow = null;
        this.call(e, "onReset", reason);
        for (const node of [...e.owned.keys()]) handle.remove(node);
        // Also clean partially-built roots that failed before mount().
        for (const node of [...root.children]) release(node);
        e.clearing = false; this.notify();
      },
      setEnabled: (enabled) => {
        if (e.disposed || e.enabled === !!enabled) return;
        if (!enabled) {
          e.enabled = false; e.generation++; e.lastNow = null;
          if (this.running) this.call(e, "onPause");
          handle.clear("disabled");
        } else {
          e.enabled = true; e.error = "";
          if (this.running) this.call(e, "onResume");
        }
        this.notify();
      },
      dispose: () => {
        if (e.disposed) return;
        e.enabled = false;
        if (this.running) this.call(e, "onPause");
        handle.clear("dispose"); e.disposed = true;
        this.call(e, "onDispose");
        e.lighting?.dispose(); disposeTree(scene);
        this.entries.delete(id); this.notify();
      },
    };
    const registry = this;
    e.handle = handle; this.entries.set(id, e);
    this.call(e, "onResize", this.size);
    if (this.running && e.enabled) this.call(e, "onResume");
    this.notify();
    return handle;
  }
  dispatch(moduleId, action, payload) {
    const e = this.entries.get(moduleId), actions = e?.definition.actions;
    if (!e?.handle.active || !actions || !Object.prototype.hasOwnProperty.call(actions, action)) return false;
    try { actions[action](payload); return true; }
    catch (error) { this.report(e, `action:${action}`, error); this.notify(); return false; }
  }
  start() {
    if (this.running || this.disposed) return;
    this.running = true;
    for (const e of this.entries.values()) { e.lastNow = null; if (e.enabled) this.call(e, "onResume"); }
    this.notify();
  }
  pause() {
    if (!this.running) return;
    this.running = false;
    for (const e of this.entries.values()) {
      e.generation++; e.lastNow = null;
      if (e.enabled) this.call(e, "onPause");
    }
    this.notify();
  }
  clear(reason = "session") { for (const e of [...this.entries.values()]) e.handle.clear(reason); }
  resize(width, height) {
    this.size = { width, height };
    for (const e of this.entries.values()) {
      if (e.space === "view") { e.camera.aspect = width / height; e.camera.updateProjectionMatrix(); }
      this.call(e, "onResize", this.size);
    }
  }
  layerCamera(e) {
    if (e.space === "view") {
      const projection = this.camera.projectionMatrix;
      // A rejected native frame can contain a singular projection. View overlays
      // keep the last usable calibration until tracking supplies another one.
      if (projection.elements.every(Number.isFinite) && Math.abs(projection.determinant()) > 1e-12) {
        e.camera.projectionMatrix.copy(projection);
        e.camera.projectionMatrixInverse.copy(projection).invert();
      }
      e.camera.near = this.camera.near; e.camera.far = this.camera.far;
      e.camera.updateMatrixWorld(true);
    }
    return e.camera;
  }
  update(now, tracking) {
    if (!this.running) return;
    for (const e of this.sorted()) {
      if (!e.handle.active || (e.space === "world" && !tracking)) continue;
      const dt = e.lastNow == null ? 0 : Math.max(0, (now - e.lastNow) / 1000);
      e.lastNow = now;
      if (this.call(e, "onFrame", { dt, now, camera: this.layerCamera(e), tracking }) === false) e.handle.setEnabled(false);
    }
  }
  farPlane() {
    let far = 300;
    for (const e of this.entries.values()) if (e.enabled && e.space === "world") far = Math.max(far, sceneFarPlane(this.camera, e.root));
    return far;
  }
  render(tracking) {
    if (!this.running) return;
    const autoClear = this.renderer.autoClear;
    this.renderer.autoClear = false;
    try {
      for (const e of this.sorted()) {
        if (!e.handle.active || !e.root.children.length || (e.space === "world" && !tracking)) continue;
        try {
          if (e.depth === "isolated") this.renderer.clearDepth();
          const camera = this.layerCamera(e);
          if (e.definition.lit === false) this.renderer.render(e.scene, camera);
          else {
            if (!e.lighting) e.lighting = this.createLighting(this.renderer, e.scene);
            this.drawContent(this.renderer, e.scene, camera, e.root, e.lighting);
          }
          const error = this.getRenderError();
          if (error) throw error;
        } catch (error) { this.getRenderError(); this.report(e, "render", error); e.handle.setEnabled(false); }
      }
    } finally { this.renderer.autoClear = autoClear; }
  }
  dispose() {
    if (this.disposed) return;
    this.pause();
    for (const e of [...this.entries.values()]) e.handle.dispose();
    this.disposed = true;
  }
}
module.exports = { RenderLayers };
