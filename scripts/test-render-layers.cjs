const assert = require("node:assert/strict");
const { THREE } = require("../miniprogram/lib/three-runtime/runtime");
const { RenderLayers } = require("../miniprogram/lib/three-runtime/render-layers");
const calls = [], errors = [], events = [];
const camera = new THREE.PerspectiveCamera(60, 1, .01, 300);
camera.position.set(2, 1, 4); camera.updateMatrixWorld(true);
const renderer = { autoClear: true, clearDepth() { calls.push("depth"); }, render(scene, view) {
  calls.push(scene.children[0].name); assert.equal(this.autoClear, false);
  if (scene.children[0].name === "layer:hud") assert.deepEqual(view.position.toArray(), [0, 0, 0]);
} };
const layers = new RenderLayers({ renderer, camera, onError: e => errors.push(e), onChange: s => events.push(s),
  createLighting: () => ({ dispose() { calls.push("lighting:dispose"); } }),
  drawContent: (r, scene, view) => r.render(scene, view),
});
const lifecycle = [], frames = [];
const world = layers.register({ id: "world", order: 0,
  onResume() { lifecycle.push("resume"); }, onPause() { lifecycle.push("pause"); },
  onReset(reason) { lifecycle.push(`reset:${reason}`); }, onDispose() { lifecycle.push("dispose"); },
  onFrame({ dt }) { frames.push(dt); }, actions: { ping: value => calls.push(value) },
});
const activity = layers.register({ id: "activity", depth: "isolated", order: 100, lit: false });
const hud = layers.register({ id: "hud", space: "view", depth: "isolated", order: 200, lit: false });
assert.throws(() => layers.register({ id: "world" }), /Duplicate/);
assert.throws(() => layers.register({ id: "invalid", space: "view" }), /policy/);
assert.equal(layers.dispatch("world", "ping", "too-early"), false);
layers.start(); layers.start();
assert.deepEqual(lifecycle, ["resume"]);
const node = () => new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
let released = 0;
const a = node(); a.geometry.addEventListener("dispose", () => released++);
world.mount(a); activity.mount(node()); hud.mount(node());
assert.throws(() => activity.mount(a), /already owned/);
assert.equal(world.root.children.length, 1);
layers.render(true);
assert.deepEqual(calls, ["layer:world", "depth", "layer:activity", "depth", "layer:hud"]);
assert.equal(renderer.autoClear, true);
calls.length = 0;
layers.render(false);
assert.deepEqual(calls, ["depth", "layer:hud"], "tracking loss only suppresses spatial layers");
layers.update(1000, true); layers.update(1500, true);
assert.deepEqual(frames, [0, .5]);
const stale = world.capture();
world.clear("rescan");
assert.equal(released, 1); assert.equal(stale(), false);
assert.equal(activity.root.children.length, 1);
let lateReleased = 0;
assert.equal(world.mount(node(), { current: stale, dispose() { lateReleased++; } }), false);
assert.equal(lateReleased, 1);
const current = world.capture();
layers.pause(); layers.pause();
assert.equal(current(), false); assert.equal(activity.root.children.length, 1);
assert.equal(layers.dispatch("world", "ping", "paused"), false);
layers.start(); layers.update(60000, true); assert.equal(frames.at(-1), 0, "background time excluded");
world.mount(node()); world.setEnabled(false);
assert.equal(world.root.children.length, 0); assert.equal(activity.root.children.length, 1);
world.setEnabled(true); assert.equal(layers.dispatch("world", "ping", "ok"), true);
assert.equal(layers.dispatch("world", "toString"), false);
const plugin = layers.register({ id: "new-feature", order: 300, depth: "isolated", lit: false,
  onFrame() { throw new Error("plugin failed"); } });
plugin.mount(node()); layers.update(61000, true);
assert.equal(plugin.enabled, false); assert.equal(errors[0].moduleId, "new-feature");
assert.equal(activity.root.children.length, 1, "one failed module cannot clear another");
const token = activity.capture(); activity.dispose(); activity.dispose();
assert.equal(token(), false);
const replacement = layers.register({ id: "activity", depth: "isolated", lit: false });
assert.equal(token(), false, "same-ID registration must not revive old work");
assert.ok(replacement.active);
layers.dispose(); layers.dispose();
assert.equal(layers.snapshot().length, 0);
assert.throws(() => layers.register({ id: "late" }), /disposed/);
assert.ok(lifecycle.includes("dispose"));
console.log("PASS registered layer isolation, depth composition, view camera, lifecycle, stale work, resource ownership and failure isolation");

async function sceneQueueRegression() {
  const { registerScene } = require("../miniprogram/components/xr-start/render-modules/scene");
  const registry = new RenderLayers({ renderer, camera });
  registry.start();
  const pending = [], mounted = [];
  const host = { _arReady: true, _cancelScenePreview() {}, _clearAssetState() {}, tickModelAnimation() {},
    _isAssetPlacementCurrent: asset => asset._layerCurrent(),
    reportAssetError(_asset, error) { throw error; },
    async _placeSceneAsset(asset) {
      await new Promise(resolve => pending.push({ id: asset.id, resolve }));
      if (this._isAssetPlacementCurrent(asset)) mounted.push(asset.id);
    },
  };
  const module = registerScene({ layers: registry, host, staggerMs: 40 });
  const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
  const first = { id: "same-scene", _layerCurrent: module.layer.capture() };
  module.enqueue([first, first]);
  registry.update(1000, true); await flush();
  assert.equal(pending.length, 1, "scene queue de-duplicates in-flight IDs");
  module.layer.clear();
  module.enqueue([{ id: "same-scene", _layerCurrent: module.layer.capture() }]);
  registry.update(1050, true); await flush();
  assert.equal(pending.length, 2, "a cleared generation does not block the next one");
  pending[0].resolve(); await flush();
  assert.deepEqual(mounted, []);
  assert.deepEqual(module.pendingIds(), ["same-scene"], "old finally cannot clear the new request");
  pending[1].resolve(); await flush();
  assert.deepEqual(mounted, ["same-scene"]);
  module.enqueue([{ id: "pause-cancelled", _layerCurrent: module.layer.capture() }]);
  registry.pause(); registry.start(); registry.update(1100, true); await flush();
  assert.equal(pending.length, 2, "pause cancels queued work before it can issue IO");
  registry.dispose();
  console.log("PASS independent Scene queue, same-ID late completion and pause cancellation");
}
sceneQueueRegression().catch(error => { console.error(error); process.exitCode = 1; });
