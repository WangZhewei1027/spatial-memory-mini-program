const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const base = path.resolve(__dirname, '../miniprogram');
const config = require(path.join(base, 'components/xr-start/matching/config'));
const target = (id = 'a') => ({ id, name: id, image_url: `https://media.test/${id}.png`, reference_version: `version-${id}` });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function load(file, dependencies, globals = {}) {
  const m = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(base, file), 'utf8'), {
    module: m, exports: m.exports, require: name => {
      assert.ok(name in dependencies, `unexpected dependency: ${name}`);
      return dependencies[name];
    }, console, setTimeout, clearTimeout, ...globals,
  });
  return m.exports;
}
function fixture(overrides = {}) {
  let now = 1000, nextId = overrides.firstMarkerId ?? 0;
  const calls = [], logs = [], files = new Set(), removed = [], native = new Map();
  const log = (event, fields, level) => logs.push({ event, fields: JSON.parse(JSON.stringify(fields)), level });
  const api = {
    CONFIG: { workspaceId: 'map' },
    async fetchAnchorCandidates(body) { calls.push(['candidates', body]); return { statusCode: 200, data: { candidates: [target()] } }; },
    async fetchAnchorContent(body) { calls.push(['content', body]); return { statusCode: 200, data: { anchor: { id: body.anchor_id }, assets: [{ id: 'content-a', file_type: 'text' }] } }; },
    ...overrides,
  };
  const removeFile = p => { if (p) { removed.push(p); files.delete(p); } };
  const clock = { Date: class extends Date { static now() { return now; } } };
  const diagnostics = load('components/xr-start/matching/diagnostics.js', { './config': config, './log': log }, clock);
  const methods = load('components/xr-start/matching/index.js', {
    './config': config, './log': log, '../../../utils/backend': api,
    './diagnostics': diagnostics,
    '../../../lib/three-runtime/resources': { removeFile },
    './reference': { loadOSDReference: overrides.loadReference || (async url => { const p = `/tmp/${url.split('/').pop()}-${nextId}.jpg`; files.add(p); return p; }) },
  }, {
    Date: class extends Date { static now() { return now; } },
    wx: { uploadFile() { throw new Error('No camera uploads'); }, getLocation({ success }) { success({ latitude: 31, longitude: 121, accuracy: 10 }); } },
  });
  const host = Object.assign({
    retrievalMode: 'anchor', _arReady: true, _modeEpoch: 0, _contentEpoch: 0,
    _nextRecognitionAt: 0, _osdPhase: 'idle', _allowedAssetIds: new Set(),
    _seenAssets: new Map(), nodeList: [], statuses: [], displayed: [],
    setData() {}, triggerEvent(_name, value) { this.statuses.push(value); },
    displayAssets(assets) { this.displayed.push(assets); }, _destroyNode() {},
    fetchNearbyAssets() {}, fetchHugeAssets() {},
    _desiredARMode() { return this.retrievalMode === 'anchor' ? 'osd' : 'slam'; },
    _ensureARMode(mode) {
      this._runtime.session.mode = mode;
      this._arReady = !(mode === 'slam' && overrides.deferTracking);
      return this._arReady;
    },
    _runtime: { session: {
      mode: 'osd',
      addOSDMarker(p) { const id = nextId++; native.set(id, p); return id; },
      removeOSDMarker(id) { native.delete(id); },
    } },
  }, methods);
  const observe = (id = [...native.keys()][0], patch = {}) => host.handleOSDAnchors('updateAnchors', [{
    id: id + 100, markerId: id, type: 2, path: native.get(id), origin: { x: 0.2, y: 0.2 }, size: { width: 0.4, height: 0.4 }, ...patch,
  }]);
  return { host, api, calls, logs, files, removed, native, observe, tick: ms => { now += ms; }, settle: async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); } };
}
test('iOS empty-path OSD trace confirms by registered markerId and locks content once', async () => {
  const f = fixture({ firstMarkerId: 10001 });
  await f.host.recognizeAnchor();
  // iPhone 15 Pro / WeChat 8.0.80 / SDK 3.17.6: path is empty, id changes
  // every update, markerId stays 10001. Replay the observed 268 callbacks.
  const sample = { type: 2, markerId: 10001, path: '',
    origin: { x: .13948634266853333, y: .31419575214385986 },
    size: { width: .7120342254638672, height: .37108778953552246 } };
  for (let id = 0; id < 268; id++) {
    f.host.handleOSDAnchors(id === 0 ? 'addAnchors' : 'updateAnchors', [{ ...sample, id }]);
    f.tick(1000 / 30); await f.settle();
  }
  assert.equal(f.host._osdPhase, 'locked', 'valid iOS detections must not be rejected because path is empty');
  assert.equal(f.calls.filter(([kind]) => kind === 'content').length, 1);
  assert.equal(f.host.displayed.length, 1);
  assert.equal(f.logs.filter(x => x.event === '回调被过滤').length, 0);
  f.host.rescan(); await f.settle();
  assert.equal(f.host._osdPhase, 'scanning');
  assert.ok(f.native.has(10002));
  for (let i = 0; i < 3; i++) {
    f.host.handleOSDAnchors('updateAnchors', [{ ...sample, id: 300 + i }]);
    f.tick(350); await f.settle();
  }
  assert.equal(f.host._osdEvidence, null, 'removed marker IDs cannot confirm in a new scan');
  assert.equal(f.calls.filter(([kind]) => kind === 'content').length, 1);
  f.host.pauseRetrieval();
});
test('OSD waits for a valid SLAM pose, and rescan/hide cancels pending spatial placement', async () => {
  for (const action of ['ready', 'rescan', 'hide', 'gps']) {
    const f = fixture({ deferTracking: true });
    await f.host.recognizeAnchor(); await f.host._acceptOSDMatch(target());
    assert.equal(f.host._osdPhase, 'tracking');
    assert.equal(f.host._runtime.session.mode, 'slam');
    assert.equal(f.host.displayed.length, 0, 'OSD camera cannot place world content');
    assert.equal(f.native.size, 0); assert.equal(f.files.size, 0);
    f.host._finishOSDPlacement();
    assert.equal(f.host.displayed.length, 0, 'native start success is not spatial readiness');
    if (action === 'rescan') f.host.rescan();
    if (action === 'hide') f.host.pauseRetrieval();
    if (action === 'gps') f.host.setRetrievalMode('gps');
    await f.settle();
    f.host._arReady = true;
    f.host._finishOSDPlacement(); f.host._finishOSDPlacement();
    assert.equal(f.host.displayed.length, action === 'ready' ? 1 : 0);
    if (action === 'rescan') {
      assert.equal(f.host._runtime.session.mode, 'osd');
      assert.equal(f.host._osdPhase, 'scanning');
    }
    f.host.pauseRetrieval();
  }
});
test('diagnostics distinguish absent SDK callbacks from rejected observations without flooding logs', async () => {
  const silent = fixture(); await silent.host.recognizeAnchor();
  silent.tick(3000); silent.host.reportOSDScan?.();
  const idle = silent.logs.find(x => x.event === '扫描摘要');
  assert.ok(idle, 'scanning with zero SDK callbacks must produce a diagnostic summary');
  assert.equal(idle.fields.result, 'no_native_events');
  assert.equal(idle.fields.callbacks, 0);
  const filtered = fixture(); await filtered.host.recognizeAnchor();
  for (let i = 0; i < 1000; i++) filtered.observe(999, { path: '' });
  filtered.tick(3000); filtered.host.reportOSDScan?.();
  const rejected = filtered.logs.find(x => x.event === '扫描摘要');
  assert.equal(rejected.fields.result, 'all_observations_rejected');
  assert.equal(rejected.fields.rejected.unknown_marker, 1000);
  assert.equal(filtered.logs.filter(x => x.event === '回调被过滤').length, 1);
  assert.ok(filtered.logs.length < 20, 'native frame events must not flood console');
  silent.host.pauseRetrieval(); filtered.host.pauseRetrieval();
});
test('OSD confirms stable observations, locks content after target loss, and rescans manually', async () => {
  const f = fixture(); await f.host.recognizeAnchor();
  assert.equal(f.host._osdPhase, 'scanning'); assert.equal(f.native.size, 1);
  f.observe(); f.tick(350); f.observe(); assert.equal(f.calls.length, 1);
  f.tick(350); f.observe(); await f.settle();
  assert.equal(f.host._osdPhase, 'locked'); assert.equal(f.host._matchedAnchorId, 'a');
  assert.equal(f.host.displayed.length, 1); assert.equal(f.native.size, 0); assert.equal(f.files.size, 0);
  assert.equal(f.logs.find(x => x.event === '扫描摘要').fields.result, 'confirmed');
  assert.equal(f.logs.filter(x => x.event === '确认命中').length, 1);
  f.tick(60000); f.host.handleOSDAnchors('removeAnchors', [{ id: 100, markerId: 0 }]); await f.host.recognizeAnchor();
  assert.equal(f.calls.length, 2); assert.equal(f.host._osdPhase, 'locked');
  f.host.rescan(); await f.settle();
  assert.equal(f.host._matchedAnchorId, null); assert.equal(f.host._osdPhase, 'scanning');
  assert.equal(f.host._contentEpoch, 2); assert.equal(f.native.size, 1);
  f.host.pauseRetrieval(); assert.equal(f.native.size, 0); assert.equal(f.files.size, 0);
});
test('diagnostics expose stalled confirmation, malformed payloads and cancellation without signed URLs', async () => {
  const f = fixture({ fetchAnchorCandidates: async () => ({ statusCode: 200, data: {
    candidates: [{ ...target(), image_url: 'https://media.test/image.png?token=DO_NOT_LOG#secret' }],
  } }) });
  await f.host.recognizeAnchor();
  f.host.handleOSDAnchors('updateAnchors', { anchors: [] });
  assert.equal(f.logs.find(x => x.event === '回调未进入确认').fields.reason, 'payload_not_array');
  f.observe(); f.tick(2000); f.observe(); f.tick(1000); f.host.reportOSDScan();
  const summary = f.logs.find(x => x.event === '扫描摘要');
  assert.equal(summary.fields.result, 'awaiting_confirmation');
  assert.equal(summary.fields.resets.observation_gap, 1);
  assert.equal(summary.fields.bestObservations, 1);
  assert.ok(!JSON.stringify(f.logs).includes('DO_NOT_LOG'));
  const run = summary.fields.run;
  f.host.pauseRetrieval();
  assert.equal(f.logs.findLast(x => x.event === '扫描摘要').fields.run, run);
  const count = f.logs.length;
  f.tick(3000); f.host.reportOSDScan(); f.observe();
  assert.equal(f.logs.length, count, 'cancelled scans stop diagnostic polling');
});
test('wrong type, unknown markers, conflicting targets and observation gaps do not confirm', async () => {
  const f = fixture(); await f.host.recognizeAnchor();
  f.observe(0, { type: 1 }); f.observe(999, { path: f.native.get(0) }); assert.equal(f.host._osdEvidence, null);
  f.observe(); f.tick(2000); f.observe(); f.tick(350); f.observe();
  assert.equal(f.calls.length, 1); assert.equal(f.host._osdEvidence.count, 2);
  f.host.handleOSDAnchors('removeAnchors', [{ id: 100, markerId: 0 }]);
  assert.equal(f.host._osdEvidence, null);
  f.host._osdMarkers.set(2, { ...target('b'), path: '/b.jpg' });
  const anchor = id => ({ id, markerId: id, type: 2, path: id === 0 ? f.native.get(0) : '/b.jpg', origin: { x: 0, y: 0 }, size: { width: .5, height: .5 } });
  f.host.handleOSDAnchors('updateAnchors', [anchor(0), anchor(2)]);
  assert.equal(f.host._osdEvidence, null); assert.equal(f.calls.length, 1);
  f.host.pauseRetrieval();
});
test('missing or rewritten native paths still identify the registered target by markerId', async () => {
  for (const nativePath of [undefined, '/native/reference.jpg']) {
    const f = fixture(); await f.host.recognizeAnchor();
    f.observe(0, { path: nativePath }); f.tick(350);
    f.observe(0, { path: nativePath }); f.tick(350);
    f.observe(0, { path: nativePath }); await f.settle();
    assert.equal(f.host._osdPhase, 'locked');
    assert.equal(f.calls.filter(([kind]) => kind === 'content').length, 1);
    f.host.pauseRetrieval();
  }
});
test('batches remain bounded and visit candidates beyond the first five', async () => {
  const f = fixture({ fetchAnchorCandidates: async () => ({ statusCode: 200, data: { candidates: Array.from({ length: 7 }, (_, i) => target(String(i))) } }) });
  await f.host.recognizeAnchor(); assert.equal(f.native.size, 5); assert.equal(f.files.size, 5);
  f.tick(config.batchDurationMs); await f.host.recognizeAnchor();
  assert.equal(f.native.size, 2); assert.equal(f.files.size, 2);
  assert.deepEqual([...f.host._osdMarkers.values()].map(x => x.id), ['5', '6']);
  f.host.setRetrievalMode('gps'); assert.equal(f.files.size, 0); assert.equal(f.native.size, 0);
});
test('unchanged single-batch targets keep their native markers through a minute without callbacks', async () => {
  const f = fixture({ firstMarkerId: 10001 });
  await f.host.recognizeAnchor();
  const registered = [...f.native.entries()];
  // Replay the user's five 12-second scan windows, with no native detections.
  for (let i = 0; i < 5; i++) {
    f.tick(config.batchDurationMs); await f.host.recognizeAnchor();
    assert.deepEqual([...f.native.entries()], registered,
      'an unchanged single batch must not be removed/re-added every 12 seconds');
  }
  assert.equal(f.removed.length, 0);
  assert.equal(f.logs.filter(x => x.event === '标记已注册').length, 1);
  assert.equal(f.host._osdPhase, 'scanning');
  assert.equal(f.host.displayed.length, 0, 'silence must never be converted into a match');
  f.host.reportOSDScan();
  assert.equal(f.logs.findLast(x => x.event === '扫描摘要').fields.elapsedMs, 60000,
    'diagnostics must accumulate across unchanged candidate refreshes');
  f.host.pauseRetrieval(); assert.equal(f.native.size, 0); assert.equal(f.files.size, 0);
});
test('candidate refresh retains confirmation but replaces changed references and removes absent targets', async () => {
  let candidates = [target()];
  const f = fixture({ fetchAnchorCandidates: async () => ({ statusCode: 200, data: { candidates } }) });
  await f.host.recognizeAnchor();
  const marker = [...f.native.keys()][0];
  f.tick(config.batchDurationMs - 350); f.observe();
  candidates = [{ ...target(), name: 'updated name', image_url: 'https://media.test/a.png?signature=new' }];
  f.tick(350); await f.host.recognizeAnchor(); f.observe();
  assert.equal(f.host._osdEvidence.count, 2, 'refresh must not reset a pending confirmation');
  assert.equal(f.host._osdMarkers.get(marker).name, 'updated name');
  assert.equal(f.removed.length, 0);
  candidates = [{ ...target(), reference_version: 'version-2' }];
  f.tick(config.batchDurationMs); await f.host.recognizeAnchor();
  assert.equal(f.native.size, 1); assert.equal(f.files.size, 1);
  assert.ok(!f.native.has(marker)); assert.equal(f.removed.length, 1);
  assert.equal(f.host._osdEvidence, null);
  candidates = [];
  f.tick(config.batchDurationMs); await f.host.recognizeAnchor();
  assert.equal(f.host._osdPhase, 'empty');
  assert.equal(f.native.size, 0); assert.equal(f.files.size, 0);
});
test('a match during candidate refresh wins over late results and errors', async () => {
  for (const statusCode of [200, 500]) {
    const d = deferred();
    let response = { statusCode: 200, data: { candidates: [target()] } };
    const g = fixture({ fetchAnchorCandidates: () => response });
    await g.host.recognizeAnchor(); response = d.promise;
    g.tick(config.batchDurationMs - 350); g.observe();
    g.tick(350); const refresh = g.host.recognizeAnchor(); await g.settle();
    assert.equal(g.host._osdPhase, 'scanning');
    g.observe(); g.tick(350); g.observe(); await g.settle();
    assert.equal(g.host._osdPhase, 'locked');
    d.resolve({ statusCode, data: { candidates: [target('replacement')] } }); await refresh;
    assert.equal(g.host._osdPhase, 'locked');
    assert.equal(g.host.displayed.length, 1); assert.equal(g.native.size, 0); assert.equal(g.files.size, 0);
    g.host.pauseRetrieval();
  }
});
test('late candidate discovery and late reference files cannot revive a cancelled scan', async () => {
  const d = deferred(); const f = fixture({ fetchAnchorCandidates: () => d.promise });
  const task = f.host.recognizeAnchor(); await f.settle(); f.host.pauseRetrieval();
  d.resolve({ statusCode: 200, data: { candidates: [target()] } }); await task;
  assert.equal(f.native.size, 0); assert.equal(f.host._osdPhase, 'idle');
  const image = deferred(); const g = fixture({ loadReference: () => image.promise });
  const pending = g.host.recognizeAnchor(); await g.settle(); g.host.setRetrievalMode('gps');
  image.resolve('/late.jpg'); await pending;
  assert.ok(g.removed.includes('/late.jpg')); assert.equal(g.native.size, 0);
});
test('late content and errors never overwrite a newer scan, including the same target', async () => {
  const d = deferred(); const f = fixture({ fetchAnchorContent: () => d.promise });
  await f.host.recognizeAnchor();
  const accept = f.host._acceptOSDMatch(target()); await f.settle();
  f.host.rescan(); await f.settle();
  d.resolve({ statusCode: 200, data: { anchor: { id: 'a' }, assets: [{ id: 'late', file_type: 'text' }] } }); await accept;
  assert.equal(f.host.displayed.length, 0); assert.equal(f.host._osdPhase, 'scanning');
  f.host.pauseRetrieval();
});
test('empty candidates, malformed data, bad reference and stale content have actionable states', async () => {
  const f = fixture({ fetchAnchorCandidates: async () => ({ statusCode: 200, data: { candidates: [] } }) });
  await f.host.recognizeAnchor(); assert.equal(f.host._osdPhase, 'empty');
  const malformed = fixture({ fetchAnchorCandidates: async () => ({ statusCode: 200, data: { candidates: [{}] } }) });
  await malformed.host.recognizeAnchor(); assert.equal(malformed.host._osdPhase, 'error');
  const bad = fixture({ loadReference: async () => { throw new Error('参考图过小'); } });
  await bad.host.recognizeAnchor(); assert.equal(bad.native.size, 0); assert.match(bad.host.statuses.at(-1).message, /过小/);
  const stale = fixture({ fetchAnchorContent: async () => ({ statusCode: 409, data: { error: '参考图已更新，请重新扫描' } }) });
  await stale.host.recognizeAnchor(); await stale.host._acceptOSDMatch(target());
  assert.equal(stale.host._osdPhase, 'error'); assert.equal(stale.host._nextRecognitionAt, Infinity);
  assert.equal(stale.native.size, 0); assert.equal(stale.files.size, 0);
});
test('OSD session uses one native session, never probes v2, and discards callbacks after stop', () => {
  const { VKSessionController } = require(path.join(base, 'lib/three-runtime/vk-session'));
  let options, stopped = 0, destroyed = 0, observed = 0, start;
  const listeners = new Map();
  const native = { version: 'v1', getAllOSDMarker: () => [{ markerId: 0, path: '/private/user/reference.jpg?token=secret' }],
    on: (n, f) => listeners.set(n, f), off() {}, start: f => { start = f; },
    requestAnimationFrame: () => 1, cancelAnimationFrame() {}, stop: () => stopped++, destroy: () => destroyed++,
    addOSDMarker: () => 0, removeOSDMarker() {} };
  const session = new VKSessionController({ mode: 'osd', api: { isVKSupport() { throw Error('v2 forbidden'); }, createVKSession: o => { options = o; return native; } },
    size: () => ({ width: 10, height: 10 }), onState() {}, onAnchors: () => observed++, onFrame() {} });
  session.start(); start(); assert.deepEqual(options.track, { OSD: true }); assert.equal(options.version, 'v1');
  assert.equal(session.addOSDMarker('/reference.jpg'), 0);
  const snapshot = session.getOSDDiagnostics();
  assert.equal(snapshot.actualVersion, 'v1'); assert.equal(snapshot.planeEnabled, false);
  assert.equal(snapshot.nativeMarkerCount, 1); assert.equal(snapshot.nativeMarkers[0].file, 'reference.jpg');
  assert.ok(!JSON.stringify(snapshot).includes('secret'));
  assert.deepEqual(snapshot.anchorListeners, ['addAnchors', 'updateAnchors', 'removeAnchors']);
  assert.deepEqual(snapshot.anchorEvents, {});
  const old = listeners.get('updateAnchors'); old([]);
  assert.deepEqual(session.getOSDDiagnostics().anchorEvents, { updateAnchors: 1 });
  session.stop(); old([]);
  assert.equal(observed, 1); assert.equal(stopped, 1); assert.equal(destroyed, 1); assert.deepEqual(session.hitTest(), []);
  session.start(); start(); old([]);
  const restarted = session.getOSDDiagnostics();
  assert.ok(restarted.sessionGeneration > snapshot.sessionGeneration);
  assert.deepEqual(restarted.anchorEvents, {}, 'old session callbacks must not enter new-session diagnostics');
  session.stop();
});
test('switching OSD to SLAM destroys the old session, ignores planes, and rejects v1 fallback', () => {
  const { VKSessionController } = require(path.join(base, 'lib/three-runtime/vk-session'));
  let alive = 0, observed = 0, forceFallback = false;
  const instances = [], states = [];
  const api = { isVKSupport: () => true, createVKSession(options) {
    assert.equal(alive++, 0, 'two camera sessions must never coexist');
    const listeners = new Map();
    const native = { options, listeners, state: 3, version: forceFallback ? 'v1' : options.version,
      on: (n, f) => listeners.set(n, f), off() {}, start: f => f(),
      requestAnimationFrame: () => 1, cancelAnimationFrame() {}, stop() {}, destroy() { alive--; },
      hitTest() { throw Error('production must not use plane results'); } };
    instances.push(native); return native;
  } };
  const session = new VKSessionController({ mode: 'osd', api, size: () => ({ width: 1, height: 1 }),
    onState: (state, message) => states.push([state, message]), onAnchors: () => observed++, onFrame() {} });
  session.start(); const late = instances[0].listeners.get('updateAnchors');
  session.mode = 'slam'; session.start(); late([]);
  assert.equal(observed, 0);
  assert.equal(instances[1].options.version, 'v2');
  assert.deepEqual(instances[1].options.track, { plane: { mode: 1, force: true } });
  assert.equal(instances[1].listeners.size, 0); assert.deepEqual(session.hitTest(), []);
  assert.equal(session.isTracking(), false);
  instances[1].state = 1; assert.equal(session.isTracking(), true);
  session.mode = 'osd'; session.start();
  assert.deepEqual(instances[2].options.track, { OSD: true });
  forceFallback = true; session.mode = 'slam'; session.start();
  assert.equal(session.running, false); assert.equal(alive, 0);
  assert.equal(states.at(-1)[0], 'error'); assert.match(states.at(-1)[1], /v2/);
});

function referenceFixture({ width = 1600, height = 1200, deferExport = false } = {}) {
  const removed = [], drawn = [], progress = [];
  let current = true, exportOptions, canvasOptions;
  const { loadOSDReference } = load('components/xr-start/matching/reference.js', {
    '../../../lib/three-runtime/resources': { download: async () => '/source.png', removeFile: p => { if (p) removed.push(p); } },
  }, { wx: {
    getImageInfo: ({ success }) => success({ width, height }),
    createOffscreenCanvas(options) {
      canvasOptions = options;
      const ctx = { fillStyle: '', fillRect() { drawn.push(this.fillStyle); }, drawImage() { drawn.push('image'); } };
      return { getContext: () => ctx, createImage: () => ({ set src(_value) { this.onload(); } }) };
    },
    canvasToTempFilePath(options) { exportOptions = options; if (!deferExport) options.success({ tempFilePath: '/rgb.jpg' }); },
  } });
  return { run: () => loadOSDReference('https://media.test/source.png', () => current, (stage, fields) => progress.push({ stage, fields })), removed, drawn, progress,
    cancel: () => { current = false; }, finish: () => exportOptions.success({ tempFilePath: '/rgb.jpg' }),
    options: () => ({ canvasOptions, exportOptions }) };
}
test('reference conversion produces bounded RGB JPEG and releases source files', async () => {
  const f = referenceFixture(); assert.equal(await f.run(), '/rgb.jpg');
  assert.deepEqual(f.drawn, ['#ffffff', 'image']);
  assert.equal(f.options().canvasOptions.width, 1080); assert.equal(f.options().canvasOptions.height, 810);
  assert.equal(f.options().exportOptions.fileType, 'jpg');
  assert.deepEqual(f.progress.map(p => p.stage), ['downloaded', 'image_info', 'jpeg_ready']);
  assert.equal(f.progress.at(-1).fields.width, 1080);
  assert.deepEqual(f.removed, ['/source.png']);
  for (const dimensions of [{ width: 100, height: 100 }, { width: 2000, height: 300 }]) {
    const bad = referenceFixture(dimensions); await assert.rejects(bad.run(), /参考图/);
    assert.deepEqual(bad.removed, ['/source.png']); assert.equal(bad.options().exportOptions, undefined);
  }
});
test('reference export finishing after rescan releases both temporary files', async () => {
  const f = referenceFixture({ deferExport: true }), task = f.run();
  for (let i = 0; i < 12; i++) await Promise.resolve();
  f.cancel(); f.finish(); await assert.rejects(task, /取消/);
  assert.deepEqual(f.removed.sort(), ['/rgb.jpg', '/source.png']);
});
