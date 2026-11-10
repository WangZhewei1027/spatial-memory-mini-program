const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const base = path.resolve(__dirname, '../miniprogram');
const config = require(path.join(base, 'components/xr-start/matching/config'));
const policy = require(path.join(base, 'lib/image-matcher/policy'));
const target = (id = 'a', version = `version-${id}`) => ({ id, name: id, image_url: `https://media.test/${id}.png`, reference_version: version });
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };
function load(file, dependencies, globals = {}) {
  const m = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(base, file), 'utf8'), {
    module: m, exports: m.exports, require: name => {
      assert.ok(name in dependencies, `unexpected dependency: ${name}`); return dependencies[name];
    }, console, setTimeout, clearTimeout, ...globals,
  }); return m.exports;
}
// Loads real modules by base-relative path and follows their relative requires,
// so splitting a module needs no test change; `mocks` replaces I/O boundaries.
function loadTree(mocks, globals = {}) {
  const loaded = new Map();
  const load = key => {
    key = key.replace(/\.js$/, '');
    if (key in mocks) return mocks[key];
    if (loaded.has(key)) return loaded.get(key).exports;
    const m = { exports: {} }; loaded.set(key, m);
    vm.runInNewContext(fs.readFileSync(path.join(base, `${key}.js`), 'utf8'), {
      module: m, exports: m.exports, require: name => {
        assert.ok(name.startsWith('.'), `unexpected dependency: ${name}`);
        return load(path.posix.join(path.posix.dirname(key), name));
      }, console, setTimeout, clearTimeout, ...globals,
    });
    return m.exports;
  };
  return load;
}
function fixture(overrides = {}) {
  let now = 1000, closed = 0, embedded = 0, loaded = 0, captures = 0, candidateCalls = 0;
  let gps = { latitude: 31, longitude: 121, accuracy: 10 };
  const calls = [], statuses = [], progress = [], logs = [], diagnosticTimers = new Map();
  let diagnosticTimerId = 0;
  const clock = { Date: class extends Date { static now() { return now; } } };
  const diagnostics = load('components/xr-start/matching/diagnostics.js', { './config': config }, { ...clock,
    setTimeout(fn) { const id = ++diagnosticTimerId; diagnosticTimers.set(id, fn); return id; }, clearTimeout(id) { diagnosticTimers.delete(id); },
  });
  const api = { CONFIG: { workspaceId: 'map' },
    async fetchAnchorCandidates(body) { calls.push(['candidates', body]); return { statusCode: 200, data: { candidates: [target()] } }; },
    async fetchAnchorContent(body) { calls.push(['content', body]); return { statusCode: 200, data: { anchor: { id: body.anchor_id }, assets: [{ id: 'text', file_type: 'text' }] } }; }, ...overrides };
  const fetchCandidates = api.fetchAnchorCandidates;
  api.fetchAnchorCandidates = async body => { candidateCalls++; return fetchCandidates(body); };
  class Matcher {
    async start() { await overrides.start?.(); return this; }
    async embed(pixels) { embedded++; return overrides.embed ? overrides.embed(pixels) : { vector: [1,0], inferenceMs: 200 }; }
    close() { if (!this.closed) closed++; this.closed = true; }
  }
  const matching = 'components/xr-start/matching';
  const loadModule = loadTree({
    [`${matching}/config`]: config, [`${matching}/log`]: (...args) => logs.push(args), [`${matching}/diagnostics`]: diagnostics,
    'utils/backend': api, 'lib/image-matcher/client': { ImageMatcher: Matcher }, 'lib/image-matcher/policy': policy,
    [`${matching}/reference`]: { async loadReferencePixels(url, current) { loaded++; return overrides.loadReference ? overrides.loadReference(url, current) : new ArrayBuffer(4); } },
  }, { Date: class extends Date { static now() { return now; } },
    wx: { uploadFile() { throw Error('camera upload forbidden'); }, getLocation({ success, fail }) { if (overrides.locate) overrides.locate({ success, fail }); else success(gps); } } });
  const methods = loadModule(`${matching}/index`);
  const host = { ...methods, ...loadModule(`${matching}/state`).initialRecognitionState(), retrievalMode: 'anchor', _arReady: true, _cameraReady: true, _sessionActive: true,
    _modeEpoch: 0, _contentEpoch: 0, _nextRecognitionAt: 0, _matchPhase: 'idle', _allowedAssetIds: new Set(),
    _seenAssets: new Map(), nodeList: [], displayed: [],
    setData() {}, triggerEvent(name, value) { (name === 'matchprogress' ? progress : statuses).push(value); },
    displayAssets(assets) { this.displayed.push(assets); }, _destroyNode() {}, fetchNearbyAssets() {}, fetchHugeAssets() {},
    // Asset-module boundary; its resource release is covered by test-ar-runtime.
    _clearRemoteAssets() { this._contentEpoch++; this._allowedAssetIds.clear(); this.nodeList = []; this._matchedAnchorId = null; },
    _ensureARSession() { return this._arReady; }, _runtime: { session: { mode: 'slam' } },
  };
  const pixels = new Uint8Array(224*224*4);
  for (let i=0;i<pixels.length;i++) pixels[i] = Math.floor(i/4)%251;
  const frame = { getCameraBuffer(w,h) { captures++; assert.equal(w,224); assert.equal(h,224); return pixels.buffer; } };
  const sample = async () => { host.handleRecognitionFrame(frame); await new Promise(resolve => setTimeout(resolve, 5)); await settle(); };
  return { host, api, calls, statuses, progress, logs, pixels, frame, sample, diagnosticTimers,
    heartbeat() { for (const [id, fn] of [...diagnosticTimers]) { diagnosticTimers.delete(id); fn(); } }, tick(ms=1000) { now += ms; }, now: () => now,
    move(meters, accuracy = 10) { gps = { latitude: 31 + meters / 6371000 * 180 / Math.PI, longitude: 121, accuracy }; host.currentGPS = { ...gps, sampledAt: now }; },
    counts: () => ({ closed, embedded, loaded, captures, candidateCalls }) };
}
test('three spaced Worker results lock once, release inference, and rescan reuses SLAM', async () => {
  const f=fixture(); await f.host.recognizeAnchor();
  assert.equal(f.host._matchPhase,'scanning');
  await f.sample(); f.tick(); await f.sample(); assert.equal(f.host.displayed.length,0);
  f.tick(); await f.sample(); assert.equal(f.host._matchPhase,'locked'); assert.equal(f.host.displayed.length,1);
  assert.equal(f.counts().closed,1); assert.equal(f.host._imageMatcher,null);
  f.tick(60000); await f.sample(); assert.equal(f.calls.length,2);
  f.host.rescan(); await settle(); assert.equal(f.host._matchPhase,'scanning'); assert.equal(f.host._matchedAnchorId,null);
  f.host.pauseRetrieval(); assert.equal(f.counts().closed,2);
});
test('recognition phases follow the declared lifecycle and cancellation restores every per-scan field', async () => {
  const state = require(path.join(base, 'components/xr-start/matching/state'));
  const { PHASES: P, canTransition } = state;
  for (const [from, to] of [[P.IDLE,P.PREPARING],[P.PREPARING,P.SCANNING],[P.SCANNING,P.LOADING],[P.LOADING,P.TRACKING],[P.TRACKING,P.LOCKED],[P.LOCKED,P.IDLE],[P.ERROR,P.IDLE]])
    assert.ok(canTransition(from, to), `${from} -> ${to}`);
  for (const [from, to] of [[P.IDLE,P.SCANNING],[P.LOCKED,P.SCANNING],[P.ERROR,P.SCANNING],[P.TRACKING,P.ERROR],[P.EMPTY,P.PREPARING]])
    assert.ok(!canTransition(from, to), `${from} -> ${to} must be rejected`);
  const f=fixture(); await f.host.recognizeAnchor();
  for (let i=0;i<3;i++) { await f.sample(); f.tick(); }
  assert.equal(f.host._matchPhase,'locked');
  f.host.rescan(); await settle(); f.host.pauseRetrieval();
  assert.ok(!f.logs.some(([event]) => event === '非法识别状态切换'), 'normal flow must not log illegal transitions');
  const fields = Object.fromEntries(Object.keys(state.scanState()).map(k => [k, f.host[k]]));
  assert.equal(JSON.stringify(fields), JSON.stringify(state.scanState()), 'pause restores every per-scan field');
  f.host._matchPhase='locked'; f.host._setMatchPhase('scanning');
  assert.equal(JSON.stringify(f.logs.at(-1).slice(0,2)), JSON.stringify(['非法识别状态切换', { run: f.host._modeEpoch, phase: 'locked', from: 'locked', to: 'scanning' }]));
});
test('pixels can be matched before SLAM tracking; content waits for pose and cancellation discards it', async () => {
  for (const cancel of [false,true]) {
    const f=fixture(); f.host._arReady=false; await f.host.recognizeAnchor();
    await f.host._acceptImageMatch(target()); assert.equal(f.host._matchPhase,'tracking'); assert.equal(f.host.displayed.length,0);
    if(cancel)f.host.pauseRetrieval(); f.host._arReady=true; f.host._finishMatchPlacement();
    assert.equal(f.host.displayed.length,cancel?0:1);
  }
});
test('busy frames are dropped, native pixels are copied, and slow responses reduce cadence', async () => {
  let pending, input;
  const f=fixture({embed: pixels => { if(!pending)return {vector:[1,0],inferenceMs:10};input=pixels;return pending.promise; }});
  await f.host.recognizeAnchor(); pending=deferred(); await f.sample();
  for(let i=0;i<30;i++){f.tick(40);f.host.handleRecognitionFrame(f.frame);}
  assert.equal(f.counts().captures,1); assert.notEqual(input,f.pixels.buffer);
  const copy=new Uint8Array(input)[20];f.pixels[20]=255;assert.equal(new Uint8Array(input)[20],copy);
  pending.resolve({vector:[1,0],inferenceMs:1200});await settle();
  assert.equal(f.host._nextMatchFrameAt,4000); assert.equal(f.host._matchFrameBusy,false);
  f.host.pauseRetrieval();
});
test('dark images and stale inference never confirm a target', async () => {
  const f=fixture();await f.host.recognizeAnchor();f.pixels.fill(0);await f.sample();assert.equal(f.counts().embedded,1);
  f.host._matchEvidence={id:'a',count:2,since:0,lastAt:1000};
  f.host._imageMatcher.embed=async()=>{f.tick(3000);return {vector:[1,0],inferenceMs:3000};};
  await f.host._matchCameraPixels(new ArrayBuffer(4),f.host._modeEpoch,f.now());assert.equal(f.host._matchEvidence,null);
  assert.equal(f.host.displayed.length,0);f.host.pauseRetrieval();
});
test('ambiguous scores, weak matches, changed targets and observation gaps reset confirmation', () => {
  const a={id:'a',vector:[1,0]}, b={id:'b',vector:[.99,.01]};
  assert.equal(policy.evaluateMatch([1,0],[a,b],config).match,null);assert.equal(policy.evaluateMatch([0,1],[a],config).match,null);
  let evidence=policy.observe(null,{reference:a},1000,config).evidence;
  evidence=policy.observe(evidence,{reference:b},2000,config).evidence;assert.equal(evidence.count,1);
  evidence=policy.observe(evidence,{reference:b},7000,config).evidence;assert.equal(evidence.count,1);
  assert.equal(policy.observe(evidence,null,8000,config).evidence,null);
});
test('all nearby references participate immediately, including targets beyond the old five-image batch', async () => {
  let embeddings = 0;
  const f = fixture({ fetchAnchorCandidates: async () => ({ statusCode: 200, data: { candidates: Array.from({ length: 7 }, (_, i) => target(String(i))) } }),
    embed: () => ({ vector: ++embeddings < 7 ? [0, 1] : [1, 0], inferenceMs: 150 }) });
  await f.host.recognizeAnchor(); assert.equal(f.counts().loaded, 7); assert.equal(f.host._matchReferences.length, 7);
  for (let i = 0; i < 3; i++) { f.tick(); await f.sample(); }
  assert.equal(f.host._matchedAnchorId, '6'); assert.equal(f.host._matchPhase, 'locked');
  f.host.pauseRetrieval();
});
test('stationary scanning never rotates or refetches candidates, and keeps one camera inference per sample', async () => {
  const f = fixture({ fetchAnchorCandidates: async () => ({ statusCode: 200, data: { candidates: Array.from({ length: 7 }, (_, i) => target(String(i))) } }) });
  await f.host.recognizeAnchor();
  for (let i = 0; i < 40; i++) { f.tick(); f.move(0); await f.sample(); }
  assert.equal(f.counts().candidateCalls, 1); assert.equal(f.counts().loaded, 7);
  assert.equal(f.counts().embedded, 47); assert.equal(f.host._matchReferences.length, 7);
  f.host.pauseRetrieval();
});
test('GPS movement refreshes the full set and reuses cached versions across areas and rescans', async () => {
  let candidates = [target('a'), target('b')];
  const f = fixture({ fetchAnchorCandidates: async () => ({ statusCode: 200, data: { candidates } }) });
  await f.host.recognizeAnchor(); assert.equal(f.counts().loaded, 2);
  candidates = [target('b'), target('c')]; f.tick(5000); f.move(30); await f.host.recognizeAnchor();
  assert.equal(f.counts().candidateCalls, 2); assert.equal(f.counts().loaded, 3);
  assert.equal(f.host._matchReferences.map(x => x.id).join(','), 'b,c');
  candidates = [target('a'), target('b', 'changed')]; f.tick(5000); f.move(0); await f.host.recognizeAnchor();
  assert.equal(f.counts().candidateCalls, 3); assert.equal(f.counts().loaded, 4);
  f.host.rescan(); await settle(); assert.equal(f.counts().loaded, 4, 'manual rescan revalidates metadata but reuses vectors');
  f.api.CONFIG.workspaceId = 'another-map'; f.host.rescan(); await settle();
  assert.equal(f.counts().loaded, 6, 'another map must not inherit cached reference vectors');
  f.host.pauseRetrieval();
});
test('GPS jitter and uncertain fixes do not refresh; displacement is measured from the last discovery', async () => {
  const f = fixture(); await f.host.recognizeAnchor();
  for (const [meters, accuracy] of [[5, 10], [15, 10], [30, 40]]) {
    f.tick(5000); f.move(meters, accuracy); await f.host.recognizeAnchor();
    assert.equal(f.counts().candidateCalls, 1);
  }
  f.tick(5000); f.move(30, 10); await f.host.recognizeAnchor(); assert.equal(f.counts().candidateCalls, 2);
  f.host.pauseRetrieval();
});
test('same-area GPS checks preserve confirmation; a slow fallback fix does not pause image inference', async () => {
  let pendingFix;
  const f = fixture({ locate: handlers => { pendingFix = handlers; } });
  f.move(0); await f.host.recognizeAnchor(); await f.sample(); const evidence = f.host._matchEvidence;
  f.tick(5000); f.move(1); await f.host.recognizeAnchor(); assert.equal(f.host._matchEvidence, evidence);
  f.tick(11000); const check = f.host.recognizeAnchor(); await settle();
  const before = f.counts().captures; await f.sample(); assert.equal(f.counts().captures, before + 1);
  pendingFix.success({ latitude: 31, longitude: 121, accuracy: 10 }); await check;
  assert.equal(f.counts().candidateCalls, 1); f.host.pauseRetrieval();
});
test('moving after a lock starts a new scan without discarding reference embeddings', async () => {
  const f = fixture(); await f.host.recognizeAnchor();
  for (let i = 0; i < 3; i++) { f.tick(); await f.sample(); }
  assert.equal(f.host._matchPhase, 'locked'); assert.equal(f.counts().loaded, 1);
  f.tick(5000); f.move(40); await f.host.recognizeAnchor();
  assert.equal(f.host._matchPhase, 'scanning'); assert.equal(f.host._matchedAnchorId, null);
  assert.equal(f.counts().loaded, 1); assert.equal(f.counts().candidateCalls, 2); f.host.pauseRetrieval();
});
test('movement discards in-flight matches and old discovery responses without losing the new scan', async () => {
  const inference = deferred(); let embeddings = 0;
  const f = fixture({ embed: () => ++embeddings === 2 ? inference.promise : { vector: [1, 0], inferenceMs: 150 } });
  await f.host.recognizeAnchor(); await f.sample(); const oldEpoch = f.host._modeEpoch;
  f.tick(5000); f.move(40); await f.host.recognizeAnchor();
  assert.ok(f.host._modeEpoch > oldEpoch); assert.equal(f.host._matchPhase, 'scanning');
  inference.resolve({ vector: [1, 0], inferenceMs: 150 }); await settle();
  assert.equal(f.host._matchEvidence, null); assert.equal(f.host.displayed.length, 0);
  assert.equal(f.counts().loaded, 1); f.host.pauseRetrieval();
  const discovery = deferred(); let requests = 0;
  const g = fixture({ fetchAnchorCandidates: async () => ++requests === 1 ? discovery.promise : { statusCode: 200, data: { candidates: [target('new')] } } });
  const old = g.host.recognizeAnchor(); await settle(); g.host.rescan(); await settle();
  discovery.resolve({ statusCode: 200, data: { candidates: [target('old')] } }); await old;
  assert.equal(g.host._matchReferences.map(x => x.id).join(','), 'new'); g.host.pauseRetrieval();
});
test('reference cache is bounded and preserves all reusable targets even when new targets come first', async () => {
  const limit = config.maxCachedReferences;
  let candidates = Array.from({ length: limit }, (_, i) => target(String(i)));
  const f = fixture({ fetchAnchorCandidates: async () => ({ statusCode: 200, data: { candidates } }) });
  await f.host.recognizeAnchor(); assert.equal(f.counts().loaded, limit);
  candidates = [...Array.from({ length: 10 }, (_, i) => target(`new-${i}`)), ...candidates.slice(0, limit - 10)];
  f.tick(5000); f.move(40); await f.host.recognizeAnchor();
  assert.equal(f.counts().loaded, limit + 10, 'unchanged references must not be evicted before they are reused');
  assert.equal(f.host._referenceCache.size, limit); assert.equal(f.host._matchReferences.length, limit);
  f.host.pauseRetrieval(); assert.equal(f.host._referenceCache.size, 0);
});
test('an unavailable competitor blocks matching; retry only computes missing reference features', async () => {
  let unavailable = true;
  const f = fixture({ fetchAnchorCandidates: async () => ({ statusCode: 200, data: { candidates: [target('a'), target('b')] } }),
    loadReference: url => { if (unavailable && url.endsWith('/b.png')) throw Error('reference unavailable'); return new ArrayBuffer(4); } });
  await f.host.recognizeAnchor(); assert.equal(f.host._matchPhase, 'error'); assert.equal(f.counts().embedded, 1);
  await f.sample(); assert.equal(f.counts().captures, 0);
  unavailable = false; f.host.rescan(); await settle();
  assert.equal(f.host._matchPhase, 'scanning'); assert.equal(f.host._matchReferences.length, 2);
  assert.equal(f.counts().embedded, 2); assert.equal(f.counts().loaded, 3); f.host.pauseRetrieval();
});
test('empty areas stay cached until movement or explicit rescan', async () => {
  let candidates = [];
  const f = fixture({ fetchAnchorCandidates: async () => ({ statusCode: 200, data: { candidates } }) });
  await f.host.recognizeAnchor(); f.tick(60000); f.move(0); await f.sample();
  assert.equal(f.counts().candidateCalls, 1); assert.equal(f.host._matchPhase, 'empty');
  candidates = [target()]; f.tick(5000); f.move(40); await f.host.recognizeAnchor();
  assert.equal(f.counts().candidateCalls, 2); assert.equal(f.host._matchPhase, 'scanning'); f.host.pauseRetrieval();
});
test('late discovery, reference embedding and inference cannot revive a cancelled generation', async () => {
  for(const stage of ['discovery','reference','embedding','frame']) {
    const pending=deferred();let embeds=0;
    const f=fixture(stage==='discovery'?{fetchAnchorCandidates:()=>pending.promise}:stage==='reference'?{loadReference:()=>pending.promise}:
      {embed:()=> (++embeds===(stage==='frame'?2:1))?pending.promise:{vector:[1,0],inferenceMs:200}});
    const run=f.host.recognizeAnchor();await settle();if(stage==='frame'){await run;await f.sample();}
    f.host.pauseRetrieval();
    pending.resolve(stage==='discovery'?{statusCode:200,data:{candidates:[target()]}}:stage==='reference'?new ArrayBuffer(4):{vector:[1,0],inferenceMs:200});
    await run;await settle();assert.equal(f.host._matchPhase,'idle');assert.equal(f.host._imageMatcher,null);assert.equal(f.host.displayed.length,0);
  }
});
test('late content errors cannot overwrite a new scan; paused or changed server references do not display', async () => {
  const pending=deferred(),f=fixture({fetchAnchorContent:()=>pending.promise});await f.host.recognizeAnchor();
  const loading=f.host._acceptImageMatch(target());await settle();f.host.rescan();await settle();
  pending.resolve({statusCode:409,data:{error:'参考图已更新'}});await loading;assert.equal(f.host._matchPhase,'scanning');f.host.pauseRetrieval();
  for(const statusCode of [404,409]) {const g=fixture({fetchAnchorContent:async()=>({statusCode,data:{error:'目标不可用'}})});await g.host.recognizeAnchor();await g.host._acceptImageMatch(target());assert.equal(g.host._matchPhase,'error');assert.equal(g.host.displayed.length,0);assert.equal(g.host._nextRecognitionAt,Infinity);}
});
test('empty candidates wait for movement; invalid candidates and failed Worker require explicit rescan', async () => {
  for(const candidates of [[],[target(),target()]]) {const f=fixture({fetchAnchorCandidates:async()=>({statusCode:200,data:{candidates}})});await f.host.recognizeAnchor();assert.equal(f.host._matchPhase,candidates.length?'error':'empty');assert.equal(f.host._imageMatcher,null);}
  const f=fixture();await f.host.recognizeAnchor();f.host._imageMatcher.embed=async()=>{throw Error('worker died');};await f.sample();
  assert.equal(f.host._matchPhase,'error');assert.equal(f.host._nextRecognitionAt,Infinity);assert.equal(f.host._imageMatcher,null);
});
test('one v2 session at a time: SLAM ignores plane anchors, lab plane mode discards stale callbacks, v1 fallback fails', () => {
  const { VKSessionController } = require(path.join(base, 'lib/three-runtime/vk-session'));
  let alive = 0, observed = 0, forceFallback = false;
  const instances = [], states = [];
  const api = { isVKSupport: () => true, createVKSession(options) {
    assert.equal(alive++, 0, 'two camera sessions must never coexist');
    const listeners = new Map();
    const native = { options, listeners, state: 3, version: forceFallback ? 'v1' : options.version,
      on: (n, f) => listeners.set(n, f), off() {}, start: f => f(),
      requestAnimationFrame: () => 1, cancelAnimationFrame() {}, stop() {}, destroy() { alive--; },
      hitTest() { return [{ id: 'hit' }]; } };
    instances.push(native); return native;
  } };
  const session = new VKSessionController({ mode: 'plane', api, size: () => ({ width: 1, height: 1 }),
    onState: (state, message) => states.push([state, message]), onAnchors: () => observed++, onFrame() {} });
  session.start();
  assert.deepEqual(instances[0].options.track, { plane: { mode: 1 } });
  const late = instances[0].listeners.get('updateAnchors'); late([]);
  assert.equal(observed, 1); assert.deepEqual(session.getDiagnostics().anchorEvents, { updateAnchors: 1 });
  assert.equal(session.hitTest().length, 1, 'lab plane mode keeps hit tests');
  session.mode = 'slam'; session.start(); late([]);
  assert.equal(observed, 1, 'callbacks from a stopped session are discarded');
  assert.deepEqual(session.getDiagnostics().anchorEvents, {}, 'old session callbacks must not enter new-session diagnostics');
  assert.equal(instances[1].options.version, 'v2');
  assert.deepEqual(instances[1].options.track, { plane: { mode: 1, force: true } });
  assert.equal(instances[1].listeners.size, 0); assert.deepEqual(session.hitTest(), []);
  assert.equal(session.isTracking(), false);
  instances[1].state = 1; assert.equal(session.isTracking(), true);
  forceFallback = true; session.start();
  assert.equal(session.running, false); assert.equal(alive, 0);
  assert.equal(states.at(-1)[0], 'error'); assert.match(states.at(-1)[1], /v2/);
  const unsupported = new VKSessionController({ mode: 'slam', api: { isVKSupport: () => false, createVKSession() { throw Error('must not create'); } },
    size: () => ({ width: 1, height: 1 }), onState: (state, message) => states.push([state, message]), onFrame() {} });
  unsupported.start(); assert.match(states.at(-1)[1], /不支持 VisionKit v2/);
});

test('reference input is white-composited, model-sized, owns its buffer, and releases temporary files on cancellation', async () => {
  for(const cancel of [false,true]) {
    const removed=[],drawn=[];let current=true,decoded;
    const backing=new Uint8ClampedArray(224*224*4+16);backing.fill(42);
    const image={width:1600,height:1200,set src(value){decoded=()=>this.onload();}};
    const context={fillRect(...args){drawn.push(args);},drawImage(...args){drawn.push(args.slice(1));},getImageData(){return{data:backing.subarray(16)};}};
    const canvas={width:224,height:224,createImage:()=>image,getContext:()=>context};
    const {loadReferencePixels}=load('components/xr-start/matching/reference.js',{'../../../lib/three-runtime/resources':{
      download:async()=>'/tmp/reference.png',removeFile:path=>removed.push(path)},'../../../lib/image-matcher/spec':require(path.join(base,'lib/image-matcher/spec'))},{wx:{createOffscreenCanvas:()=>canvas}});
    const pending=loadReferencePixels('https://media.test/a.png',()=>current);await settle();
    if(cancel) current=false;
    decoded();
    if(cancel)await assert.rejects(pending,/取消/);
    else {const pixels=await pending;assert.equal(pixels.byteLength,224*224*4);assert.notEqual(pixels,backing.buffer);assert.equal(new Uint8Array(pixels)[0],42);assert.equal(context.fillStyle,'#ffffff');assert.deepEqual(drawn,[[0,0,224,224],[0,0,224,224]]);}
    assert.deepEqual(removed,['/tmp/reference.png']);assert.equal(canvas.width,1);assert.equal(image.onload,null);
  }
});

test('cold entry starts matching from camera frames without a rescan, even while model and pose initialize', async () => {
  const initialization = deferred();
  const f = fixture({ start: () => initialization.promise });
  f.host._cameraReady = false; f.host._arReady = false; f.host._sessionActive = false;
  f.host.rescan = () => { throw Error('automatic entry must not require a button'); };
  await f.sample(); assert.equal(f.calls.length, 0);
  f.host._sessionActive = true;
  await f.sample(); assert.equal(f.calls[0][0], 'candidates');
  f.tick(); await f.sample(); assert.equal(f.counts().captures, 0, 'wait for model without blocking camera callbacks');
  initialization.resolve(); await settle();
  assert.equal(f.host._matchPhase, 'scanning');
  for (let i = 0; i < 3; i++) { f.tick(); await f.sample(); }
  assert.equal(f.counts().captures, 3);
  assert.equal(f.host._matchPhase, 'tracking', 'automatic matching finishes before a SLAM pose');
  f.host._arReady = true; f.host._finishMatchPlacement();
  assert.equal(f.host._matchPhase, 'locked'); assert.equal(f.host.displayed.length, 1);
});
test('unmatched automatic scanning reports that inference ran and why the target was rejected', async () => {
  let embeddings = 0;
  const f = fixture({ embed: () => ({ vector: ++embeddings === 1 ? [1, 0] : [0.28, 0.96], inferenceMs: 150 }) });
  f.host._cameraReady = false;
  await f.sample(); f.tick(); await f.sample(); f.tick(); await f.sample();
  assert.equal(f.host._matchPhase, 'scanning'); assert.ok(f.counts().captures >= 1);
  assert.ok(f.logs.some(([event]) => event === '扫描开始'), 'must announce automatic scan startup');
  const result = f.logs.find(([event]) => event === '匹配结果');
  assert.ok(result, 'low scores must not be silent');
  assert.equal(result[1].reason, 'score_below_threshold'); assert.equal(result[1].topScore, 0.28);
  f.host.pauseRetrieval();
});

test('diagnostic heartbeat distinguishes waiting for camera, model and inference, then stops on pause', async () => {
  const initialization = deferred(), inference = deferred();
  let embeddings = 0;
  const f = fixture({ start: () => initialization.promise,
    embed: () => ++embeddings === 1 ? { vector: [1, 0] } : inference.promise });
  f.host._cameraReady = false; f.host._startMatchDiagnostics('enter');
  const lastSummary = () => f.logs.filter(([event]) => event === '扫描摘要').at(-1)[1];
  f.tick(3000); f.heartbeat();
  assert.equal(lastSummary().stage, 'waiting_camera'); assert.equal(lastSummary().cameraFrames, 0);
  await f.sample(); f.tick(3000); f.heartbeat();
  assert.equal(lastSummary().stage, 'initializing_worker'); assert.equal(lastSummary().stageMs, 3000);
  initialization.resolve(); await settle(); await f.sample(); f.tick(3000); f.heartbeat();
  assert.equal(lastSummary().stage, 'scanning'); assert.equal(lastSummary().captured, 1);
  assert.equal(lastSummary().inferred, 0); assert.equal(lastSummary().workerBusy, true);
  assert.equal(lastSummary().inFlightMs, 3000);
  const lateHeartbeat = [...f.diagnosticTimers.values()][0];
  f.host.pauseRetrieval(); assert.equal(f.diagnosticTimers.size, 0);
  const stoppedLogCount = f.logs.length;
  lateHeartbeat(); inference.resolve({ vector: [1, 0], inferenceMs: 3000 }); await settle();
  assert.equal(f.logs.length, stoppedLogCount); assert.equal(f.diagnosticTimers.size, 0);
});

test('steady weak results update summary without spamming logs or UI, and dark frames explain rejection', async () => {
  let embeddings = 0;
  const f = fixture({ embed: () => ({ vector: ++embeddings === 1 ? [1, 0] : [0.28, 0.96], inferenceMs: 150 }) });
  await f.host.recognizeAnchor(); const statusCount = f.statuses.length;
  for (let i = 0; i < 5; i++) { f.tick(); await f.sample(); }
  assert.equal(f.logs.filter(([event]) => event === '匹配结果').length, 1);
  assert.equal(f.statuses.length, statusCount, 'unchanged scan status must not trigger setData every sample');
  // The progress line reports every sampled frame: in-flight first, then its scores.
  const texts = f.progress.map(p => p.text);
  assert.equal(texts.filter(t => t.startsWith('匹配中')).length, 5);
  assert.equal(texts.filter(t => /相似度 0\.280 /.test(t)).length, 5);
  assert.match(texts.at(-1), /^\d\d:\d\d:\d\d #5 相似度 0\.280 .*下次 \d+\.\ds 后$/);
  assert.ok(texts.at(-1).includes(` 阈值 ${config.minimumScore} `));
  f.heartbeat(); const summary = f.logs.filter(([event]) => event === '扫描摘要').at(-1)[1];
  assert.equal(summary.inferred, 5); assert.equal(summary.lastResult.topScore, 0.28);
  assert.equal(summary.lastResult.minimumScore, config.minimumScore);
  assert.ok(!JSON.stringify(summary).includes('image_url')); assert.ok(!JSON.stringify(summary).includes('latitude'));
  f.pixels.fill(0); f.tick(); await f.sample();
  assert.equal(f.logs.filter(([event]) => event === '匹配结果').at(-1)[1].reason, 'invalid_pixels');
  assert.match(f.statuses.at(-1).message, /画面过暗/);
  assert.match(f.progress.at(-1).text, /跳过：画面过暗/);
  f.host.pauseRetrieval(); assert.equal(f.diagnosticTimers.size, 0);
});
