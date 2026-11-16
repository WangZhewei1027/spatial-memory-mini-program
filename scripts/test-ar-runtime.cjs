const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { transformSync } = require("esbuild");
const root = path.resolve(__dirname, "../miniprogram");
const virtualFiles = new Map();
let lastJPEGOptions, component;
const wx = {
  env: { USER_DATA_PATH: "/tmp/ar-test" },
  getAccountInfoSync: () => ({ miniProgram: { envVersion: "develop" } }),
  getStorageSync: () => "",
  setStorageSync() {},
  base64ToArrayBuffer: (value) => {
    const bytes = Buffer.from(value, "base64");
    return bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.length,
    );
  },
  getFileSystemManager: () => ({
    readFile({ filePath, success, fail }) {
      try {
        const data = fs.readFileSync(
          /^\/?assets\//.test(filePath) ? path.join(root, filePath) : filePath,
        );
        success({
          data: data.buffer.slice(
            data.byteOffset,
            data.byteOffset + data.length,
          ),
        });
      } catch (e) {
        fail(e);
      }
    },
    writeFile({ filePath, data, success }) {
      virtualFiles.set(filePath, data);
      success();
    },
    unlink({ filePath }) {
      virtualFiles.delete(filePath);
    },
  }),
  createOffscreenCanvas(options) {
    const canvas = { width: options.width, height: options.height };
    const ctx = {
      font: "",
      measureText: (s) => ({ width: Array.from(s).length * 24 }),
      clearRect() {},
      fillText() {},
      createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
      putImageData() {},
      getImageData: (x, y, w, h) => ({
        data: new Uint8ClampedArray(w * h * 4),
      }),
    };
    canvas.getContext = () => ctx;
    return canvas;
  },
  canvasToTempFilePath(options) {
    lastJPEGOptions = options;
    virtualFiles.set("/tmp/export.jpg", new ArrayBuffer(4));
    options.success({ tempFilePath: "/tmp/export.jpg" });
  },
};
const runtimeLogs = [];
const context = vm.createContext({
  console: { ...console, log(...args) { runtimeLogs.push(args); }, warn() {}, error: console.error },
  setTimeout,
  clearTimeout,
  wx,
  Intl,
  Component: (value) => {
    component = value;
  },
});
const modules = new Map();
function load(file) {
  if (file.endsWith("/backend-development-local")) {
    return { apiBaseUrl: "http://192.168.20.5:3000" };
  }
  if (!path.extname(file)) file += fs.existsSync(file + ".js") ? ".js" : ".ts";
  file = path.resolve(file);
  if (modules.has(file)) return modules.get(file).exports;
  const module = { exports: {} };
  modules.set(file, module);
  let code = fs.readFileSync(file, "utf8");
  if (file.endsWith(".ts"))
    code = transformSync(code, { loader: "ts", format: "cjs" }).code;
  vm.runInContext(`(function(require,module,exports){${code}\n})`, context, {
    filename: file,
  })(
    (name) => load(path.resolve(path.dirname(file), name)),
    module,
    module.exports,
  );
  return module.exports;
}
const lib = (name) => load(path.join(root, "lib/three-runtime", name));
async function main() {
  const { THREE } = lib("runtime");
  const { layoutText, splitGraphemes, createTextAsset } = lib("text");
  const wrapped = layoutText("中文测试\nhello", (s) => Array.from(s).length, 3);
  assert.deepEqual(Array.from(wrapped.lines), ["中文测", "试", "hel", "lo"]);
  assert.equal(splitGraphemes("👨‍👩‍👧‍👦👍🏽").length, 2);
  // Closing punctuation moves to the next line together with its character.
  const kinsoku = layoutText("留个纪念！再来", (s) => Array.from(s).length, 4);
  assert.deepEqual(Array.from(kinsoku.lines), ["留个纪", "念！再来"]);
  const short = createTextAsset("Hi", {}, "dialog_decorated"),
    long = createTextAsset(
      "这是一段需要自动换行的文字，用于检查动态气泡尺寸和显式换行。",
      {},
      "dialog_decorated",
    );
  assert.ok(long.userData.textLayout.lines > 1);
  assert.ok(long.userData.textLayout.height > short.userData.textLayout.height);
  assert.ok(
    short.children.some((node) => node.geometry.type === "ShapeGeometry"),
  );
  // The bubble is translucent and its hairline is a ring, so no two translucent
  // layers overlap inside the body; the tail hangs below the body.
  const bubbleMeshes = short.children.filter((node) => node.geometry.type === "ShapeGeometry");
  assert.equal(bubbleMeshes.length, 2);
  for (const node of bubbleMeshes) {
    assert.equal(node.material.transparent, true);
    assert.ok(node.material.opacity > 0.2 && node.material.opacity < 0.8);
    assert.equal(node.material.depthWrite, false);
  }
  short.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(bubbleMeshes[0]);
  assert.ok(bounds.min.y < -short.userData.bubble.height / 2 - 0.05, "tail extends below the bubble body");
  const ringArea = bubbleMeshes[1].geometry.index.count / 3;
  assert.ok(ringArea > 0);
  assert.equal(short.userData.bubble.opacity, bubbleMeshes[0].material.opacity);
  const plain = createTextAsset(
    "白字",
    { text_color: "#fa0", text_size: 2 },
    "plain_white",
  );
  assert.equal(plain.children.length, 1);
  assert.ok(createTextAsset("\n".repeat(1000)).userData.textLayout.truncated);
  let releasedTextures = 0;
  short.traverse((node) =>
    node.material?.map?.addEventListener("dispose", () => releasedTextures++),
  );
  lib("resources").disposeTree(short);
  assert.equal(releasedTextures, 1);
  lib("resources").disposeTree(long);
  lib("resources").disposeTree(plain);
  console.log(
    "PASS dynamic text: Chinese/newlines/emoji, geometry backgrounds, size/color, bounded texture and disposal",
  );

  const canvas = {
    createImage() {
      const image = { width: 16, height: 16 };
      Object.defineProperty(image, "src", {
        set() {
          Promise.resolve().then(() => image.onload?.());
        },
      });
      return image;
    },
  };
  const resources = lib("resources");
  const gltf = await resources.loadGLTF(canvas, "/assets/headphone.glb");
  let meshes = 0,
    maps = 0;
  gltf.scene.traverse((node) => {
    if (node.isMesh) meshes++;
    if (node.material?.map) maps++;
  });
  assert.ok(meshes > 0);
  assert.ok(maps > 0, "actual headphone GLB embedded image must be loaded");
  assert.equal(virtualFiles.size, 0);
  assert.equal(
    resources.resolveURI(
      "../textures/a.png",
      "https://example.com/models/x/model.gltf",
    ),
    "https://example.com/models/textures/a.png",
  );
  resources.disposeTree(gltf.scene, { shared: true });
  console.log(
    "PASS actual business GLB: geometry + embedded image via native resource adapter, no browser globals/temp leaks",
  );

  const { ARRuntime } = lib("ar-runtime");
  {
    let captured = 0, needsPose = false;
    const scanning = Object.assign(Object.create(ARRuntime.prototype), {
      canvas: { width: 320, height: 480 }, session: { mode: 'slam', isTracking: () => false },
      background: { draw: () => true }, renderer: {}, onState() {},
      onCameraFrame() { captured++; }, requireTracking: () => needsPose,
      startedAt: Date.now() - 60000, trackingWaitAt: Date.now() - 60000,
    });
    scanning.frame({}, { now: 1000, acquireMs: 0 });
    assert.equal(captured, 1, 'recognition receives pixels without a SLAM pose');
    assert.equal(scanning.trackingWaitAt, null, 'scanning does not time out waiting for a pose');
    needsPose = true;
    scanning.frame({}, { now: 1034, acquireMs: 0 });
    assert.ok(Date.now() - scanning.trackingWaitAt < 1000, 'placement starts its own tracking deadline');
    scanning.trackingWaitAt = Date.now() - 31000;
    assert.throws(() => scanning.frame({}, { now: 1068, acquireMs: 0 }), /空间定位超过/);
    console.log('PASS camera pixels arrive before SLAM tracking; placement retains its tracking timeout');
  }
  {
    const display = Object.assign(Object.create(ARRuntime.prototype), {
      camera: new THREE.PerspectiveCamera(60, 1, .01, 300), renderer: { setSize() {} },
    });
    display.resize(390, 844);
    assert.equal(display.camera.aspect, 390 / 844);
    const edge = new THREE.Vector3(Math.tan(Math.PI / 6) * 390 / 844, 0, -1).project(display.camera);
    assert.ok(Math.abs(edge.x - 1) < 1e-9, "portrait display projection uses the actual canvas ratio");
    display.resize(844, 390);
    assert.equal(display.camera.aspect, 844 / 390);
  }
  {
    const { createSceneCore } = load(path.join(root, "lib/scene-runtime/vendor/scene-core"));
    const core = createSceneCore({ content: { instances: [], durationSeconds: 20, loop: false } });
    const deltas = [];
    const clockRuntime = Object.assign(Object.create(ARRuntime.prototype), {
      canvas: { width: 320, height: 480 }, scene: new THREE.Scene(), content: new THREE.Group(),
      camera: new THREE.PerspectiveCamera(),
      session: { mode: 'slam', start() {}, stop() {}, isTracking: () => true }, background: { draw: () => true },
      lighting: { apply() {} },
      renderer: { render() {}, setSize() {}, info: { render: { calls: 0 }, memory: { geometries: 0, textures: 0 } } },
      onReady() {}, onState() {}, onTick(dt) { deltas.push(dt); core.advance(dt); },
    });
    const pose = new THREE.PerspectiveCamera(60, 320 / 480, .01, 300); pose.updateMatrixWorld(true);
    const frame = { camera: { viewMatrix: pose.matrixWorldInverse.toArray(), getProjectionMatrix(near, far) {
      pose.near = near; pose.far = far; pose.updateProjectionMatrix(); return pose.projectionMatrix.toArray(); } } };
    clockRuntime.start(); core.play();
    for (const now of [1000, 1350, 1750, 2050]) clockRuntime.frame(frame, { now, acquireMs: 0 });
    assert.ok(Math.abs(core.time - 1.05) < 1e-9, 'slow render frames must preserve elapsed scene time, matching native audio');
    clockRuntime.stop(); core.pause(); clockRuntime.start(); core.play();
    clockRuntime.frame(frame, { now: 90000, acquireMs: 0 });
    assert.equal(deltas.at(-1), 0, 'foreground restart discards time spent in the background');
    clockRuntime.frame(frame, { now: 90250, acquireMs: 0 });
    assert.ok(Math.abs(core.time - 1.3) < 1e-9);
    clockRuntime.frame(frame, { now: 93000, acquireMs: 0 });
    assert.equal(runtimeLogs.filter(args => args[0] === '[ThreeAR][timings]').length, 0,
      'normal scanning must not emit periodic rendering diagnostics');
    clockRuntime.debugTimings = true;
    clockRuntime.frame(frame, { now: 97000, acquireMs: 0 });
    assert.equal(runtimeLogs.filter(args => args[0] === '[ThreeAR][timings]').length, 1,
      'rendering diagnostics remain available with explicit opt-in');
    core.dispose();
    console.log('PASS real AR frame clock preserves slow frames and resets across foreground sessions');
  }
  const baseModel = new THREE.Group();
  baseModel.add(
    new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()),
  );
  let cachedDisposals = 0;
  baseModel.children[0].geometry.addEventListener(
    "dispose",
    () => cachedDisposals++,
  );
  const cache = new resources.ModelCache(canvas, 0, async () => ({
    scene: baseModel,
    animations: [],
  }));
  const a = await cache.acquire("same"),
    b = await cache.acquire("same");
  assert.notEqual(a.object, b.object);
  resources.disposeTree(a.object);
  a.release();
  assert.equal(cachedDisposals, 0);
  resources.disposeTree(b.object);
  b.release();
  assert.equal(cachedDisposals, 1);
  cache.dispose();
  console.log(
    "PASS reference-counted GLB cache: one instance cleanup cannot invalidate another",
  );

  load(path.join(root, "components/xr-start/index"));
  for (const m of fs
    .readFileSync(path.join(root, "components/xr-start/index.wxml"), "utf8")
    .matchAll(/bind[\w:]+="(\w+)"/g))
    assert.equal(typeof component.methods[m[1]], "function");
  const host = Object.assign(
    {
      data: {},
      setData(p) {
        Object.assign(this.data, p);
      },
      triggerEvent() {},
    },
    component.methods,
  );
  host.startGPSWatch = () => {};
  host.loadMapConfig = () => {};
  component.lifetimes.attached.call(host);
  host._mapConfigReady = true;
  host._runtime = {
    camera: new THREE.PerspectiveCamera(),
    scene: new THREE.Scene(),
  };
  host._runtime.camera.updateMatrixWorld();
  host._runtime.session = { mode: "slam" };
  host.scene = host._runtime.scene;
  host.shadowRoot = new THREE.Group();
  host.scene.add(host.shadowRoot);
  host._arReady = true;
  host._preloadDone = true;
  host._allowedAssetIds.add("t");
  host._placeTextAsset({
    id: "t",
    file_type: "text",
    text_content: "test",
    _contentEpoch: 0,
  });
  assert.equal(host.nodeList.length, 1);
  assert.equal(host.shadowRoot.children.length, 1);
  assert.ok(host.nodeList[0].node.position.z < 0, "Three camera forward is -Z");
  host._clearRemoteAssets();
  assert.equal(host.nodeList.length, 0);
  assert.equal(host.shadowRoot.children.length, 0);
  const stale = new THREE.Group();
  host.shadowRoot.add(stale);
  let staleDisposed = 0;
  host._allowedAssetIds.add("old");
  const rejected = host._registerNode("old", stale, stale, {
    contentEpoch: 0,
    dispose() {
      staleDisposed++;
    },
  });
  assert.equal(rejected._destroyed, true);
  assert.equal(staleDisposed, 1);
  assert.equal(host.shadowRoot.children.length, 0);
  host.retrievalMode = "anchor";
  host._allowedAssetIds.add("wrong");
  host.displayAssets([
    { id: "wrong", file_type: "text", text_content: "must not appear" },
  ]);
  assert.equal(host.shadowRoot.children.length, 0);
  host._matchedAnchorId = "a";
  host._allowedAssetIds = new Set(["ok"]);
  host._placeQueue = [];
  host._placingBusy = true;
  host.displayAssets([
    { id: "ok", file_type: "text", text_content: "accepted" },
    { id: "wrong", file_type: "text" },
  ]);
  assert.equal(host._placeQueue.length, 1);
  assert.equal(host._placeQueue[0].id, "ok");
  host.displayAssets([{ id: "ok", file_type: "text" }]);
  assert.equal(
    host._placeQueue.length,
    1,
    "pending placement must not duplicate",
  );
  host._clearRemoteAssets();
  host._placingBusy = false;
  console.log(
    "PASS production component dependencies/handlers, -Z placement, full text cleanup, stale async rejection, anchor whitelist and queue dedup",
  );

  // Compose the real activity source, asset queue, renderer and matching lifecycle.
  host.retrievalMode = "anchor";
  host._matchedAnchorId = null;
  const activityRecord = { id: "coexist-history", activity_placement_id: "activity-placement",
    file_type: "text", text_content: "Visible before matching", metadata: { latitude: 31, longitude: 121 } };
  host._placingBusy = true;
  host._replaceActivityRecords([activityRecord]);
  assert.equal(host._placeQueue.length, 1, "history queues before an anchor has matched");
  await host._drainPlaceQueue();
  const history = host.nodeList.find(entry => entry.assetId === "activity:coexist-history");
  assert.ok(history && !history._destroyed, "real text renderer accepts activity history while scanning");
  host.showDanmakuInXR("Live while scanning", { id: "coexist-live", placement_id: "activity-placement" });
  const live = host.nodeList.find(entry => entry.assetId === "activity:coexist-live");
  assert.ok(live && !live._destroyed, "acknowledged messages render while scanning");
  const activityEpoch = host._activityEpoch;
  host._sessionActive = true; host._cameraReady = true;
  const recognize = host.recognizeAnchor;
  host.recognizeAnchor = () => {};
  host.rescan();
  assert.equal(host._activityEpoch, activityEpoch, "rescan preserves activity requests");
  assert.ok(host.nodeList.includes(history) && host.nodeList.includes(live));
  assert.equal(history.node.parent, host.shadowRoot, "orphan cleanup must retain activity nodes");
  host._matchPhase = "tracking";
  host._pendingMatchPlacement = { epoch: host._modeEpoch, matchedAt: Date.now(), candidate: { id: "coexist-anchor" },
    assets: [{ id: "coexist-content", file_type: "text", text_content: "Matched content" }] };
  host._finishMatchPlacement();
  assert.ok(host.nodeList.some(entry => entry.assetId === "coexist-content"));
  assert.ok(host.nodeList.includes(history) && host.nodeList.includes(live), "matching cannot erase messages");
  await host._drainPlaceQueue();
  host._placingBusy = true;
  host._replaceActivityRecords([activityRecord, { ...activityRecord, id: "queued-activity" }]);
  host.restartRecognitionAfterMovement(host.currentGPS, { distanceMeters: 30, thresholdMeters: 20 });
  assert.equal(host.nodeList.some(entry => entry.assetId === "coexist-content"), false);
  assert.ok(host.nodeList.includes(history));
  await host._drainPlaceQueue();
  assert.ok(host.nodeList.some(entry => entry.assetId === "activity:queued-activity"), "pending activity text survives scan content epochs");
  host.pauseRetrieval();
  assert.equal(host.nodeList.length, 0);
  assert.equal(host.shadowRoot.children.length, 0);
  assert.equal(host._activityRecordIds.size, 0);
  assert.equal(host._activityEpoch, activityEpoch + 1, "backgrounding cancels activity requests");
  host.recognizeAnchor = recognize;
  host._retrievalPaused = false;
  console.log("PASS matching + activity history/live rendering, rescan/match/movement preservation, full session cleanup");

  // Exercise real async placement, including switching away and back to the same anchor/id.
  const allow = (id) => {
    host.retrievalMode = "anchor";
    host._matchedAnchorId = "same-anchor";
    host._allowedAssetIds.add(id);
    return { id, file_url: "/fixture", _contentEpoch: host._contentEpoch };
  };
  let pendingImage;
  host._canvas = {
    createImage() {
      return (pendingImage = { width: 24, height: 16 });
    },
  };
  let textureDisposals = 0;
  const originalDispose = THREE.Texture.prototype.dispose;
  THREE.Texture.prototype.dispose = function () {
    textureDisposals++;
    return originalDispose.call(this);
  };
  const imagePlacement = host._placeImageAsset(allow("late-image"));
  await new Promise(setImmediate);
  host._clearRemoteAssets();
  allow("late-image");
  pendingImage.onload();
  await imagePlacement;
  THREE.Texture.prototype.dispose = originalDispose;
  assert.equal(textureDisposals, 1);
  assert.equal(host.shadowRoot.children.length, 0);
  let finishModel,
    modelReleases = 0;
  host._modelCache = {
    acquire: () =>
      new Promise((resolve) => {
        finishModel = resolve;
      }),
  };
  const modelPlacement = host._placeModelAsset(allow("late-model"));
  host._clearRemoteAssets();
  allow("late-model");
  finishModel({
    object: new THREE.Group(),
    animations: [],
    release() {
      modelReleases++;
    },
  });
  await modelPlacement;
  assert.equal(modelReleases, 1);
  assert.equal(host.shadowRoot.children.length, 0);
  // Unacknowledged local text is still rejected, including in matching mode.
  host.showDanmakuInXR("not associated with the matched anchor");
  assert.equal(host.shadowRoot.children.length, 0);
  host._clearRemoteAssets();
  console.log(
    "PASS late image/model downloads release resources after clearing, even with the same anchor/id; unacknowledged local content blocked",
  );

  host.currentGPS = { latitude: 31, longitude: 121, accuracy: 10, sampledAt: Date.now() };
  host._retrievalPaused = false;
  host._arReady = true;
  host.retrievalMode = "anchor";
  host._matchPhase = "scanning";
  host._sessionActive = true; host._cameraReady = true; host._arReady = false;
  wx.uploadFile = () => { throw new Error("camera upload is forbidden"); };
  wx.request = options => {
    if (options.url.includes("/api/miniapp/activities?")) { options.success({ statusCode: 200, data: [] }); return; }
    assert.ok(options.url.endsWith("/api/miniapp/anchors/content"));
    options.success({ statusCode: 200, data: {
      anchor: { id: "matched-place" }, assets: [{ id: "result-text", file_type: "text", text_content: "Anchor text" }],
    } });
  };
  let tracking = false, spatialRenders = 0, sessionStarts = 0;
  const trackingStates = [];
  const nativeCamera = new THREE.PerspectiveCamera(47, 390 / 844, .01, 300);
  nativeCamera.position.set(2, 1.6, 3);
  const nativeFrame = { get camera() {
    nativeCamera.updateMatrixWorld(true);
    return { viewMatrix: nativeCamera.matrixWorldInverse.toArray(), getProjectionMatrix(near, far) {
      nativeCamera.near = near; nativeCamera.far = far; nativeCamera.updateProjectionMatrix();
      return nativeCamera.projectionMatrix.toArray();
    } };
  } };
  host._runtime = Object.assign(Object.create(ARRuntime.prototype), host._runtime, {
    canvas: { width: 390, height: 844 }, content: host.shadowRoot,
    background: { draw: () => true },
    lighting: { apply() {} },
    renderer: { setSize() {}, render(scene, camera) { scene.updateMatrixWorld(true); camera.updateMatrixWorld(); spatialRenders++; }, info: { render: {}, memory: {} } },
    session: { mode: 'slam', start() { sessionStarts++; }, stop() {}, isTracking: () => tracking, getDiagnostics: () => ({}) },
    onReady: () => host.handleARReady(), onTick: dt => host.handleTick(dt),
    onState: (state, message) => { trackingStates.push(state); host.onARState(state, message); },
  });
  await host._acceptImageMatch({ id: "matched-place", name: "Place", reference_version: "v1" });
  assert.equal(host._matchPhase, 'tracking');
  assert.equal(host.nodeList.length, 0);
  host._runtime.frame(nativeFrame, { now: 1000, acquireMs: 0 });
  assert.equal(host._arReady, false); assert.equal(spatialRenders, 0);
  tracking = true;
  const invalidPose = { camera: { viewMatrix: Array(16).fill(0), getProjectionMatrix: () => nativeCamera.projectionMatrix.toArray() } };
  host._runtime.frame(invalidPose, { now: 1010, acquireMs: 0 });
  assert.equal(host.nodeList.length, 0, 'singular poses must never place content');
  host._runtime.frame(nativeFrame, { now: 1034, acquireMs: 0 });
  assert.equal(host._matchedAnchorId, "matched-place");
  assert.equal(host._matchPhase, "locked");
  assert.ok(host._nextRecognitionAt > Date.now(), 'locked content still schedules a GPS movement check');
  assert.equal(host.nodeList.length, 1);
  assert.equal(host.nodeList[0].assetId, "result-text");
  assert.deepEqual(host._runtime.camera.position.toArray(), nativeCamera.position.toArray());
  const lockedPosition = host.nodeList[0].node.getWorldPosition(new THREE.Vector3()).clone();
  const firstScreenPosition = lockedPosition.clone().project(host._runtime.camera);
  host.handleTick(1 / 30);
  assert.equal(host.nodeList[0].assetId, "result-text", "the real billboard/animation tick preserves locked content");
  nativeCamera.position.x += 1;
  nativeCamera.rotation.y = .1;
  host._runtime.frame(nativeFrame, { now: 1068, acquireMs: 0 });
  assert.ok(host.nodeList[0].node.getWorldPosition(new THREE.Vector3()).distanceTo(lockedPosition) < 1e-8,
    'moving/rotating the native camera must preserve world placement');
  assert.ok(lockedPosition.clone().project(host._runtime.camera).distanceTo(firstScreenPosition) > .1,
    'world-locked content must move on screen with camera motion');
  const projection = host._runtime.camera.projectionMatrix.clone();
  host._runtime.resize(844, 390);
  assert.ok(projection.equals(host._runtime.camera.projectionMatrix), 'resize must not overwrite native camera calibration');
  const rendersBeforeLoss = spatialRenders;
  tracking = false; host._runtime.frame(nativeFrame, { now: 1100, acquireMs: 0 });
  assert.equal(spatialRenders, rendersBeforeLoss); assert.equal(host._arReady, false);
  assert.equal(host.nodeList.length, 1, 'tracking loss hides content without clearing its world anchor');
  tracking = true; host._runtime.frame(nativeFrame, { now: 1134, acquireMs: 0 });
  assert.equal(host.nodeList.length, 1, 'recovery must not place a duplicate');
  assert.ok(trackingStates.includes('trackingrestored'));
  host._runtime.frame(null, { now: 1168, acquireMs: 0 });
  assert.equal(host._arReady, false, 'a missing native frame must stop placement using a stale pose');
  host._runtime.frame(nativeFrame, { now: 1200, acquireMs: 0 });
  assert.equal(host._arReady, true); assert.equal(host.nodeList.length, 1);
  await host.recognizeAnchor();
  assert.equal(host._matchPhase, "locked", "moving must not unlock content");
  host.recognizeAnchor = async () => {};
  host.rescan();
  assert.equal(host.nodeList.length, 0);
  assert.equal(host.shadowRoot.children.length, 0);
  assert.equal(host._matchPhase, "idle");
  assert.equal(host._runtime.session.mode, 'slam');
  assert.ok(host._runtime.camera.position.distanceTo(nativeCamera.position) < 1e-8);
  host._runtime.frame(nativeFrame, { now: 1234, acquireMs: 0 });
  assert.equal(host._arReady, true);
  const startsBeforeRescan = sessionStarts;
  host.rescan();
  assert.equal(sessionStarts, startsBeforeRescan, 'rescan must reuse the live SLAM session');
  assert.equal(host._arReady, true, 'rescan preserves the established metric pose');
  host._runtime.frame(nativeFrame, { now: 1268, acquireMs: 0 });
  assert.equal(host._arReady, true);
  host.pauseRetrieval();
  assert.equal(host._matchDiagnosticTimer, null, 'leaving the scanning fixture releases its heartbeat');
  console.log("PASS Worker match -> existing SLAM pose -> world-locked Three content with camera parallax -> tracking recovery -> rescan");

  let decoderRemoved = 0,
    audioDestroyed = 0,
    ended,
    getFrame = true;
  wx.createVideoDecoder = () => ({
    on(name, fn) {
      ended = fn;
    },
    off() {},
    start: async () => {},
    stop: async () => {},
    remove: async () => {
      decoderRemoved++;
    },
    seek: async () => {},
    getFrameData: () =>
      getFrame
        ? { data: new Uint8Array(4 * 4 * 4).buffer, width: 4, height: 4 }
        : null,
  });
  wx.createMediaAudioPlayer = () => ({
    addAudioSource: async () => {},
    start: async () => {},
    stop: async () => {},
    removeAudioSource: async () => {},
    destroy: async () => {
      audioDestroyed++;
    },
  });
  const video = lib("video").createVideo("demo.mp4", {}, (e) => {
    throw e;
  });
  await video.play();
  video.tick();
  assert.equal(video.material.uniforms.ready.value, true);
  assert.equal(video.material.uniforms.tbb.value, true);
  video.dispose();
  getFrame = false;
  video.tick();
  assert.equal(decoderRemoved, 1);
  assert.equal(audioDestroyed, 1);
  assert.equal(typeof ended, "function");
  video.material.uniforms.videoMap.value.dispose();
  video.material.dispose();
  let finishStart;
  const createDecoder = wx.createVideoDecoder;
  wx.createVideoDecoder = () => ({
    ...createDecoder(),
    start: () =>
      new Promise((resolve) => {
        finishStart = resolve;
      }),
  });
  const lateVideo = lib("video").createVideo("late.mp4");
  const starting = lateVideo.play();
  lateVideo.dispose();
  finishStart();
  await starting;
  lateVideo.tick();
  assert.equal(lateVideo.material.uniforms.ready.value, false);
  assert.equal(
    audioDestroyed,
    1,
    "late decoder start must not create a new audio player",
  );
  lateVideo.material.dispose();
  console.log(
    "PASS native video frame upload, TBB selection and decoder/audio cleanup",
  );

  for (const file of [
    "index.js",
    "assets/model.js",
    "assets/image.js",
    "assets/audio.js",
    "assets/video.js",
    "assets/text.js",
    "assets/huge.js",
    "effects/danmaku.js",
    "effects/confetti.js",
  ]) {
    assert.doesNotMatch(
      fs.readFileSync(path.join(root, "components/xr-start", file), "utf8"),
      /getXrFrameSystem|scene\.createElement|assets\/bubble/,
    );
  }
  assert.doesNotMatch(
    fs.readFileSync(path.join(root, "components/xr-start/index.json"), "utf8"),
    /xr-frame/,
  );
  console.log(
    "PASS production rendering no longer invokes XR renderer or fixed bubble PNGs",
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
