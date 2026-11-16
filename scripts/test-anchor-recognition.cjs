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
  const calls = [], statuses = [], progress = [], hints = [], logs = [], diagnosticTimers = new Map(), hintTimers = new Map();
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
    setTimeout(fn, delay) {
      if (delay !== config.hintStaleMs) return setTimeout(fn, delay);
      const timer = { fn, dueAt: now + delay }; hintTimers.set(timer, timer); return timer;
    },
    clearTimeout(timer) { if (!hintTimers.delete(timer)) clearTimeout(timer); },
    wx: { uploadFile() { throw Error('camera upload forbidden'); }, getLocation({ success, fail }) { if (overrides.locate) overrides.locate({ success, fail }); else success(gps); } } });
  const methods = loadModule(`${matching}/index`);
  const host = { ...methods, ...loadModule(`${matching}/state`).initialRecognitionState(), retrievalMode: 'anchor', _arReady: true, _cameraReady: true, _sessionActive: true,
    _modeEpoch: 0, _contentEpoch: 0, _nextRecognitionAt: 0, _matchPhase: 'idle', _allowedAssetIds: new Set(),
    _seenAssets: new Map(), nodeList: [], displayed: [],
    setData() {}, triggerEvent(name, value) { (name === 'recognitionhint' ? hints : name === 'matchprogress' ? progress : statuses).push(value); },
    displayAssets(assets) { this.displayed.push(assets); }, _destroyNode() {}, fetchNearbyAssets() {}, fetchHugeAssets() {},
    // Asset-module boundary; its resource release is covered by test-ar-runtime.
    _clearRemoteAssets() { this._contentEpoch++; this._allowedAssetIds.clear(); this.nodeList = []; this._matchedAnchorId = null; },
    _ensureARSession() { return this._arReady; }, _runtime: { session: { mode: 'slam' } },
  };
  const pixels = new Uint8Array(224*224*4);
  for (let i=0;i<pixels.length;i++) pixels[i] = Math.floor(i/4)%251;
  const frame = { getCameraBuffer(w,h) { captures++; assert.equal(w,224); assert.equal(h,224); return pixels.buffer; } };
  const sample = async () => { host.handleRecognitionFrame(frame); await new Promise(resolve => setTimeout(resolve, 5)); await settle(); };
  return { host, api, calls, statuses, progress, hints, logs, pixels, frame, sample, diagnosticTimers, hintTimers,
    expireHints() { for (const [id, timer] of [...hintTimers]) if (timer.dueAt <= now) { hintTimers.delete(id); timer.fn(); } },
    heartbeat() { for (const [id, fn] of [...diagnosticTimers]) { diagnosticTimers.delete(id); fn(); } }, tick(ms=1000) { now += ms; }, now: () => now,
    move(meters, accuracy = 10) { gps = { latitude: 31 + meters / 6371000 * 180 / Math.PI, longitude: 121, accuracy }; host.currentGPS = { ...gps, sampledAt: now }; },
    counts: () => ({ closed, embedded, loaded, captures, candidateCalls }) };
}
test('a clear match locks after two spaced Worker results, releases inference, and rescan reuses SLAM', async () => {
  const f=fixture(); await f.host.recognizeAnchor();
  assert.equal(f.host._matchPhase,'scanning');
  await f.sample(); assert.equal(f.host.displayed.length,0);
  f.tick(); await f.sample(); assert.equal(f.host._matchPhase,'locked'); assert.equal(f.host.displayed.length,1);
  assert.equal(f.counts().closed,1); assert.equal(f.host._imageMatcher,null);
  f.tick(60000); await f.sample(); assert.equal(f.calls.length,2);
  f.host.rescan(); await settle(); assert.equal(f.host._matchPhase,'scanning'); assert.equal(f.host._matchedAnchorId,null);
  f.host.pauseRetrieval(); assert.equal(f.counts().closed,2);
});
test('recognition phases follow the declared lifecycle and cancellation restores every per-scan field', async () => {
  const state = require(path.join(base, 'components/xr-start/matching/state'));
  const { PHASES: P, canTransition } = state;
  for (const [from, to] of [[P.IDLE,P.PREPARING],[P.PREPARING,P.SCANNING],[P.SCANNING,P.LOADING],[P.LOADING,P.TRACKING],[P.TRACKING,P.LOCKED],[P.LOCKED,P.IDLE],[P.ERROR,P.IDLE],[P.LOCKED,P.REACQUIRING],[P.REACQUIRING,P.LOCKED],[P.REACQUIRING,P.LOADING]])
    assert.ok(canTransition(from, to), `${from} -> ${to}`);
  for (const [from, to] of [[P.IDLE,P.SCANNING],[P.LOCKED,P.SCANNING],[P.ERROR,P.SCANNING],[P.TRACKING,P.ERROR],[P.EMPTY,P.PREPARING],[P.SCANNING,P.REACQUIRING],[P.REACQUIRING,P.SCANNING],[P.REACQUIRING,P.ERROR]])
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
  pending.resolve({vector:[0,1],inferenceMs:1200});await settle();
  assert.equal(f.host._nextMatchFrameAt,4000,'no leading target: four times the measured time'); assert.equal(f.host._matchFrameBusy,false);
  f.host.pauseRetrieval();
});
test('frames come faster only while a target leads clearly, still bounded by the measured time', async () => {
  assert.equal(policy.intervalFor(150, config), config.frameIntervalMs);
  assert.equal(policy.intervalFor(150, config, true), config.leadFrameIntervalMs);
  assert.equal(policy.intervalFor(700, config, true), 1400); assert.equal(policy.intervalFor(5000, config, true), config.maxFrameIntervalMs);
  const weak = fixture({ embed: pixels => ({ vector: pixels.byteLength === 4 ? [1, 0] : [.2, .98], inferenceMs: 100 }) });
  await weak.host.recognizeAnchor(); await weak.sample();
  assert.equal(weak.host._nextMatchFrameAt, weak.now() + config.frameIntervalMs); weak.host.pauseRetrieval();
  const borderline = fixture({ embed: pixels => ({ vector: pixels.byteLength === 4 ? [1, 0] : [.42, .9075], inferenceMs: 100 }) });
  await borderline.host.recognizeAnchor(); await borderline.sample(); assert.equal(borderline.host._matchEvidence.id, 'a');
  assert.equal(borderline.host._nextMatchFrameAt, borderline.now() + config.frameIntervalMs, 'a borderline lead keeps the slow pace');
  borderline.host.pauseRetrieval();
  const lead = fixture(); await lead.host.recognizeAnchor(); await lead.sample();
  assert.equal(lead.host._nextMatchFrameAt, lead.now() + config.leadFrameIntervalMs);
  lead.tick(config.leadFrameIntervalMs); await lead.sample(); assert.equal(lead.host._matchPhase, 'locked', 'confirmed half a second later');
});
test('a blurred frame is retried shortly without inference and keeps the evidence', async () => {
  const f = fixture({ embed: pixels => ({ vector: pixels.byteLength === 4 ? [1, 0] : [.42, .9075], inferenceMs: 100 }) });
  await f.host.recognizeAnchor(); await f.sample();
  const sharp = f.pixels.slice(), evidence = f.host._matchEvidence, embedded = f.counts().embedded;
  assert.equal(evidence.count, 1);
  // Same brightness range, but neighbouring pixels are almost equal: low gradient energy.
  for (let i = 0; i < f.pixels.length; i++) f.pixels[i] = Math.floor(i / 4 / 224) % 251;
  for (let retry = 1; retry <= config.maxBlurRetries; retry++) {
    f.tick(); await f.sample();
    assert.equal(f.counts().embedded, embedded, 'blurred frames are not sent to the Worker');
    assert.equal(f.host._nextMatchFrameAt, f.now() + config.blurRetryMs); assert.equal(f.host._matchFrameBusy, false);
  }
  assert.equal(f.host._matchEvidence, evidence); assert.match(f.progress.at(-1).text, /画面模糊/);
  assert.equal(f.logs.filter(([event]) => event === '匹配结果').at(-1)[1].reason, 'blurred_frame');
  // Retries are capped: a scene that stays plain is scored anyway.
  f.tick(); await f.sample(); assert.equal(f.counts().embedded, embedded + 1);
  // A sharp frame after one blurred frame is scored immediately.
  const g = fixture(); await g.host.recognizeAnchor(); await g.sample(); const before = g.counts().embedded;
  for (let i = 0; i < g.pixels.length; i++) g.pixels[i] = Math.floor(i / 4 / 224) % 251;
  g.tick(); await g.sample(); g.pixels.set(sharp); g.tick(config.blurRetryMs); await g.sample();
  assert.equal(g.counts().embedded, before + 1);
  f.heartbeat(); assert.equal(f.logs.filter(([event]) => event === '扫描摘要').at(-1)[1].blurredFrames, config.maxBlurRetries);
  f.host.pauseRetrieval(); g.host.pauseRetrieval();
  const state = policy.blurState(null, 10, config); assert.equal(state.blurred, false); assert.equal(state.baseline, 10);
  assert.equal(policy.blurState(state, 6, config).blurred, false); assert.equal(policy.blurState(state, 4, config).blurred, true);
  assert.equal(policy.blurState(null, null, config).blurred, false);
});
test('content for the leading target is prefetched once and reused at confirmation', async () => {
  const content = deferred(); let requests = 0;
  const f = fixture({ embed: pixels => ({ vector: pixels.byteLength === 4 ? [1, 0] : [.42, .9075], inferenceMs: 100 }),
    fetchAnchorContent: async body => { requests++; await content.promise; return { statusCode: 200, data: { anchor: { id: body.anchor_id }, assets: [{ id: 'text', file_type: 'text' }] } }; } });
  await f.host.recognizeAnchor(); await f.sample();
  assert.equal(requests, 1, 'requested on the first leading frame'); assert.equal(f.host._matchPhase, 'scanning');
  f.tick(); await f.sample(); f.tick(); await f.sample();
  assert.equal(f.host._matchPhase, 'loading'); assert.equal(requests, 1, 'confirmation waits for the same request');
  content.resolve(); await settle();
  assert.equal(f.host._matchPhase, 'locked'); assert.equal(f.host.displayed.length, 1);
  assert.equal(f.logs.find(([event]) => event === '内容就绪')[1].prefetched, true);
  // A failed prefetch falls back to a fresh request at confirmation.
  let attempts = 0;
  const g = fixture({ fetchAnchorContent: async body => { if (++attempts === 1) throw Error('offline');
    return { statusCode: 200, data: { anchor: { id: body.anchor_id }, assets: [] } }; } });
  await g.host.recognizeAnchor(); await g.sample(); g.tick(); await g.sample();
  assert.equal(attempts, 2); assert.equal(g.host._matchPhase, 'locked');
  // Leaving the scan drops prefetched content; an unconfirmed guess is never displayed.
  const h = fixture(); await h.host.recognizeAnchor(); await h.sample(); assert.equal(h.host._matchContentPrefetch.size, 1);
  h.host.rescan(); await settle(); assert.equal(h.host._matchContentPrefetch.size, 0); assert.equal(h.host.displayed.length, 0);
  h.host.pauseRetrieval();
  // At most maxContentPrefetches requests per scan.
  const epoch = f.host._modeEpoch; f.host._matchContentPrefetch = new Map(); requests = 0;
  for (const id of ['x', 'y', 'z']) f.host._prefetchMatchContent({ id, reference_version: 'v' }, epoch);
  await settle(); assert.equal(f.host._matchContentPrefetch.size, config.maxContentPrefetches);
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
  const c={id:'c',vector:[0,1]}, refs=[a,c];
  let evidence=policy.track(null,[.8,.6],refs,1000,config).evidence;assert.equal(evidence.id,'a');
  // A moderate rise of another target is averaged in: the two are ambiguous, nobody leads.
  evidence=policy.track(evidence,[.6,.8],refs,2000,config).evidence;assert.equal(evidence.id,null);
  // A large jump onto another target switches the leader at once and counting restarts.
  evidence=policy.track(policy.track(null,[1,0],refs,1000,config).evidence,[0,1],refs,2000,config).evidence;
  assert.equal(evidence.id,'c');assert.equal(evidence.count,1);
  evidence=policy.track(evidence,[1,0],refs,9000,config).evidence;assert.equal(evidence.id,'a','a long gap restarts the average');
  evidence=policy.track(evidence,[0,1],[a],13000,config).evidence;assert.equal(evidence.id,null,'a sustained weak score drops the leader');
});
// Unit vector with cosine `score` to the x axis, `other` to the y axis, the rest on z.
const toward = (score, other = .1) => [score, other, Math.sqrt(1 - score * score - other * other), 0];
test('smoothed evidence survives one weak frame while walking towards a target', () => {
  const target = { id: 't', vectors: [[1, 0, 0, 0], [.6, 0, 0, .8]] }, other = { id: 'o', vectors: [[0, 1, 0, 0]] };
  // Raw cosine to the target rises as the camera approaches; the third frame is blurred.
  const slowOnly = { ...config, strongObservations: Infinity }; // The averaged path on its own.
  const raw = [.45, .55, .3, .65, .75];
  let evidence = null, confirmedAt = null, oldCount = 0, oldConfirmed = false;
  raw.forEach((score, i) => {
    const result = policy.track(evidence, toward(score), [target, other], 1000 * (i + 1), slowOnly);
    oldCount = result.frame.match ? oldCount + 1 : 0; oldConfirmed ||= oldCount >= config.minimumObservations;
    evidence = result.evidence;
    if (result.confirmed && confirmedAt == null) confirmedAt = i;
  });
  assert.equal(oldConfirmed, false, 'per-frame gating resets on the blurred frame and never reaches three');
  assert.equal(evidence.id, 't'); assert.equal(confirmedAt, 3);
  // A raw winner that is not the leader does not advance confirmation.
  const before = policy.track(null, toward(.8), [target, other], 0, config).evidence;
  const after = policy.track(before, toward(.1, .9), [target, other], 500, config);
  assert.equal(after.evidence.count, before.count);
});
test('a borderline match keeps three confirmations; a clear lead needs two', async () => {
  const f = fixture({ embed: pixels => ({ vector: pixels.byteLength === 4 ? [1, 0] : [.42, .9075], inferenceMs: 150 }) });
  await f.host.recognizeAnchor();
  for (let i = 0; i < 2; i++) { await f.sample(); f.tick(); }
  assert.equal(f.host._matchPhase, 'scanning'); assert.match(f.statuses.at(-1).diagnostic, /确认 2\/3/);
  await f.sample(); assert.equal(f.host._matchPhase, 'locked');
  const a = { id: 'a', vector: [1, 0, 0, 0] }, b = { id: 'b', vector: [0, 1, 0, 0] };
  const first = policy.track(null, toward(.7), [a, b], 0, config);
  assert.equal(first.strong, true); assert.equal(first.required, config.strongObservations); assert.equal(first.confirmed, false);
  assert.equal(policy.track(first.evidence, toward(.7), [a, b], 300, config).confirmed, false, 'two clear frames must be half a second apart');
  assert.equal(policy.track(first.evidence, toward(.7), [a, b], 500, config).confirmed, true);
  // A frame that is not clear on its own ends the streak; the next clear frame starts over.
  const dip = policy.track(first.evidence, toward(.43, .3), [a, b], 500, config);
  assert.equal(dip.strong, false); assert.equal(dip.confirmed, false);
  const again = policy.track(dip.evidence, toward(.7), [a, b], 1000, config);
  assert.equal(again.progress, 1); assert.equal(again.confirmed, false);
  // A high score with a close competitor is not a clear lead.
  const close = policy.track(null, toward(.7, .58), [a, b], 0, config);
  assert.equal(close.strong, false); assert.equal(close.required, config.minimumObservations);
});
test('clear frames confirm on the second one, replaying five iPhone 15 Pro scans of 2026-11-16', () => {
  const ids = ['outdoor', 'indoor', 'rest', 'lift9', 'lift3', 'market', 'house'];
  const refs = ids.map((id, i) => ({ id, vector: [...ids, ''].map((_, j) => +(i === j)) }));
  // Logged raw scores per frame, highest first; unlisted targets sit just below the last one.
  const frame = scores => { const low = Math.min(...Object.values(scores)) - .01, v = ids.map(id => scores[id] ?? low);
    return [...v, Math.sqrt(1 - v.reduce((sum, x) => sum + x * x, 0))]; };
  const replay = (frames, settings) => { let evidence = null, leads = 0;
    for (const [i, [at, scores]] of frames.entries()) {
      const result = policy.track(evidence, frame(scores), refs, at, settings); evidence = result.evidence;
      if (result.match) leads++;
      if (result.confirmed) return `${result.match.reference.id} F${i + 1} ${result.via}`;
    }
    return `none, ${leads} leads`; };
  const scans = {
    turnIndoor: [[4373, { indoor: .253, lift9: .108, outdoor: .102 }], [5372, { indoor: .236, outdoor: .093, lift3: .072 }],
      [6376, { indoor: .57, outdoor: .331, rest: .26 }], [7407, { indoor: .572, rest: .266, outdoor: .258 }],
      [8407, { indoor: .547, rest: .243, outdoor: .214 }]],
    turnOutdoor: [[12435, { outdoor: .255, indoor: .208, lift9: .203 }], [13604, { outdoor: .606, lift9: .221, indoor: .218 }],
      [14602, { outdoor: .493, lift9: .267, lift3: .223 }], [15602, { outdoor: .662, market: .242, indoor: .227 }]],
    risingIndoor: [[3041, { indoor: .399, lift9: .216, rest: .181 }], [4042, { indoor: .499, rest: .253, lift9: .233 }],
      [5041, { indoor: .554, rest: .269, outdoor: .2 }], [6041, { indoor: .553, rest: .295, outdoor: .196 }]],
    steadyOutdoor: [[250, { outdoor: .483, lift9: .164, lift3: .125 }], [1254, { outdoor: .519, lift9: .16, lift3: .11 }],
      [2255, { outdoor: .5, indoor: .209, rest: .182 }]],
    // Target in view, lost for seven seconds, then back.
    lostOutdoor: [[353, { outdoor: .506, indoor: .218, lift9: .189 }], [1366, { outdoor: .25, lift9: .194, lift3: .186 }],
      [2367, { outdoor: .379, lift3: .326, lift9: .322 }], [3533, { outdoor: .221, rest: .213, indoor: .152 }],
      [4535, { outdoor: .307, rest: .21, indoor: .129 }], [5568, { outdoor: .26, rest: .219, lift9: .135 }],
      [6568, { outdoor: .351, lift9: .29, indoor: .228 }], [7568, { market: .174, outdoor: .139, rest: .126 }],
      [8734, { outdoor: .43, indoor: .13, market: .128 }], [9735, { outdoor: .556, indoor: .238, market: .236 }],
      [10734, { outdoor: .531, market: .277, house: .233 }], [11735, { outdoor: .531, market: .289, indoor: .257 }]],
  };
  const slowOnly = { ...config, strongObservations: Infinity };
  const outcome = settings => Object.values(scans).map(frames => replay(frames, settings)).join(' | ');
  // What the phone did before the fast path judged raw frames: three counted frames every time.
  assert.equal(outcome(slowOnly), 'indoor F5 slow | outdoor F4 slow | indoor F4 slow | outdoor F3 slow | outdoor F12 slow');
  assert.equal(outcome(config), 'indoor F4 fast | outdoor F3 fast | indoor F3 fast | outdoor F2 fast | outdoor F11 fast');
  // Thirteen frames of looking around before the target came into view: no lead at all.
  const searching = [[.265, .144], [.246, .255], [.159, .184], [.285, .294], [.31, .321], [.235, .3], [.055, .182],
    [.051, .211], [.124, .221], [.251, .295], [.204, .154], [.274, .324], [.208, .255]]
    .map(([other, target], i) => [392 + i * 1000, { rest: other, outdoor: target, indoor: other - .02 }]);
  assert.equal(replay(searching, config), 'none, 0 leads');
});
test('a single-frame spike on a competitor does not confirm it', () => {
  const a = { id: 'a', vector: [1, 0, 0, 0] }, b = { id: 'b', vector: [0, 1, 0, 0] };
  let evidence = null;
  for (let i = 0; i < 4; i++) evidence = policy.track(evidence, toward(.8), [a, b], i * 1000, config).evidence;
  const spike = policy.track(evidence, toward(.1, .95), [a, b], 4000, config);
  assert.equal(spike.evidence.id, 'b', 'a large jump takes the lead for that frame');
  assert.equal(spike.evidence.count, 1); assert.equal(spike.confirmed, false);
  // The previous leader only decays, so it is back in front as soon as the spike is gone.
  const back = policy.track(spike.evidence, toward(.8), [a, b], 4500, config);
  assert.equal(back.evidence.id, 'a'); assert.equal(back.evidence.count, 1); assert.equal(back.confirmed, false);
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
// Heading in degrees clockwise from -Z (the Three camera's forward), pitch upwards.
const heading = (deg, pitch = 0) => { const r = deg * Math.PI / 180, p = pitch * Math.PI / 180;
  return { x: Math.sin(r) * Math.cos(p), y: Math.sin(p), z: -Math.cos(r) * Math.cos(p) }; };
test('leaving shown content is decided from heading, pitch and distance, with a delay each way', () => {
  const focus = { x: 0, z: -3, forward: heading(0) };
  const view = (deg, { x = 0, z = 0, pitch = 0 } = {}) => policy.contentView({ x, y: 1.5, z }, heading(deg, pitch), focus, config);
  assert.equal(Math.round(view(0).offsetDeg), 0); assert.equal(Math.round(view(90).offsetDeg), 90); assert.equal(view(0).distance, 3);
  assert.equal(Math.round(view(0, { x: 3, z: -3 }).offsetDeg), 90, 'walked past it without turning');
  assert.equal(Math.round(view(170, { z: -2.5 }).offsetDeg), 170, 'near the focus, turning still uses the locked heading');
  assert.equal(Math.round(view(180, { z: -3 }).offsetDeg), 180, 'turning at the exact focus is well-defined');
  assert.ok(view(0, { pitch: -75 }).steep, 'phone lowered'); assert.ok(!view(0, { pitch: -40 }).steep);
  // Feeds one view every attention interval for a duration; returns the state and when it flipped.
  let now = 0;
  const feed = (state, v, ms) => { let flippedAt = null;
    for (let t = 0; t < ms; t += config.attentionIntervalMs) { now += config.attentionIntervalMs; state = policy.attention(state, v, now, config); if (state.flipped) flippedAt = now; }
    return { ...state, flippedAt }; };
  let s = feed(null, view(0), 2000); assert.equal(s.away, false);
  s = feed(s, view(40), 3000); assert.equal(s.away, false, 'content is placed within 30 degrees; looking at its edge is not leaving');
  s = feed(s, view(90), config.awayDelayMs - 200); assert.equal(s.away, false);
  s = feed(s, view(0), 400); s = feed(s, view(90), config.awayDelayMs - 200); assert.equal(s.away, false, 'a glance restarts the delay');
  const turnedAt = now; s = feed(s, view(90), 2000); assert.equal(s.away, true); assert.equal(s.flippedAt - turnedAt, 400, 'the delay runs from the first sample of this turn');
  s = feed(s, view(40), 5000); assert.equal(s.away, true, 'coming back needs the narrower angle');
  s = feed(s, view(10), config.returnDelayMs); assert.equal(s.away, true);
  s = feed(s, view(10), 200); assert.equal(s.away, false);
  s = feed(s, view(0, { pitch: -80 }), 1000); assert.equal(s.away, true, 'lowered phone');
  s = feed(s, view(0), 2000); assert.equal(s.away, false);
  s = feed(s, view(0, { z: 6 }), 1000); assert.equal(s.away, true, 'walked 9 m back while still facing it');
  s = feed(s, view(0, { z: 4 }), 5000); assert.equal(s.away, true); s = feed(s, view(0, { z: 2 }), 2000); assert.equal(s.away, false);
  // Samples stop while tracking is lost; that time does not count towards the delay.
  s = policy.attention(s, view(90), now += 200, config); s = policy.attention(s, view(90), now += 5000, config);
  assert.equal(s.away, false); s = feed(s, view(90), config.awayDelayMs); assert.equal(s.away, true);
});
// Two nearby targets and a posed camera. The camera sees target a until `seen.vector` changes.
function shownContent(overrides = {}) {
  const seen = { vector: [1, 0, 0] };
  const f = fixture({ fetchAnchorCandidates: async () => ({ statusCode: 200, data: { candidates: [target('a'), target('b')] } }),
    loadReference: async url => new ArrayBuffer(url.includes('/a.') ? 4 : 8),
    embed: pixels => pixels.byteLength === 4 ? { vector: [1, 0, 0] } : pixels.byteLength === 8 ? { vector: [0, 1, 0] }
      : overrides.cameraEmbed ? overrides.cameraEmbed() : { vector: seen.vector, inferenceMs: 100 }, ...overrides });
  const camera = { position: { x: 0, y: 1.5, z: 0 }, forward: heading(0), getWorldDirection() { return this.forward; } };
  f.host.getCamTransform = () => camera;
  const contentCalls = () => f.calls.filter(([type]) => type === 'content').map(([, body]) => body.anchor_id);
  return { ...f, seen, camera, contentCalls,
    turn(deg, pitch) { camera.forward = heading(deg, pitch); },
    attend(ms) { for (let t = 0; t < ms; t += config.attentionIntervalMs) { f.tick(config.attentionIntervalMs); f.host._tickAttention(); } },
    async lock() { await f.host.recognizeAnchor(); await f.sample(); f.tick(); await f.sample(); assert.equal(f.host._matchPhase, 'locked'); } };
}
test('turning away keeps the content and matches again; only a different target replaces it', async () => {
  const f = shownContent(); await f.lock();
  assert.equal(f.host._matchedAnchorId, 'a'); assert.equal(f.counts().closed, 1);
  f.attend(3000); f.turn(40); f.attend(3000); assert.equal(f.host._matchPhase, 'locked');
  f.turn(90); f.attend(config.awayDelayMs - 200); f.turn(0); f.attend(400); assert.equal(f.host._matchPhase, 'locked', 'a glance');
  f.turn(90); f.attend(config.awayDelayMs + 200); await settle();
  assert.equal(f.host._matchPhase, 'reacquiring'); assert.equal(f.host._matchedAnchorId, 'a'); assert.equal(f.host.displayed.length, 1);
  assert.equal(f.counts().candidateCalls, 1, 'no new discovery'); assert.equal(f.counts().loaded, 2, 'embeddings come from the cache');
  assert.equal(f.statuses.at(-1).locked, true); assert.match(f.statuses.at(-1).message, /已识别：a · 对准其他目标可自动切换/);
  assert.deepEqual({ ...f.logs.find(([event]) => event === '离开内容')[1], run: 0 }, { run: 0, phase: 'locked', offsetDeg: 90, pitchDeg: 0, distanceMeters: 2 });
  // The shown target in view again (say, another of its reference images): nothing happens.
  for (let i = 0; i < 4; i++) { await f.sample(); f.tick(); }
  assert.equal(f.host._matchPhase, 'reacquiring'); assert.equal(f.host.displayed.length, 1); assert.deepEqual(f.contentCalls(), ['a']);
  assert.doesNotMatch(f.statuses.at(-1).message, /正在确认/);
  assert.equal(f.host._nextMatchFrameAt - f.now(), 0, 'the shown target does not speed up sampling');
  f.seen.vector = [0, 1, 0]; await f.sample();
  assert.match(f.statuses.at(-1).message, /正在确认：b/); assert.deepEqual(f.contentCalls(), ['a', 'b'], 'prefetched');
  f.tick(); await f.sample(); await settle();
  assert.equal(f.host._matchPhase, 'locked'); assert.equal(f.host._matchedAnchorId, 'b'); assert.equal(f.host.displayed.length, 2);
  assert.equal(f.counts().closed, 2); assert.equal(f.host._imageMatcher, null); assert.deepEqual(f.contentCalls(), ['a', 'b']);
  const change = f.logs.find(([event]) => event === '切换目标')[1]; assert.equal(change.from, 'a'); assert.equal(change.to, 'b');
  assert.match(f.statuses.at(-1).message, /已识别：b · 内容已固定在空间中/);
  // The new content is ahead of the new lock pose: facing it is watching again.
  f.attend(3000); assert.equal(f.host._matchPhase, 'locked');
  assert.ok(!f.logs.some(([event]) => event === '非法识别状态切换')); f.host.pauseRetrieval();
});
test('looking back stops the background scan, and its late result cannot touch the content', async () => {
  for (const late of ['resolve', 'reject']) {
    let pending = null;
    const f = shownContent({ cameraEmbed: () => pending ? pending.promise : { vector: [0, 1, 0], inferenceMs: 100 } });
    await f.host.recognizeAnchor(); f.host._acceptImageMatch(f.host._matchReferences[0]); await settle();
    assert.equal(f.host._matchPhase, 'locked');
    // Late assets follow the camera at load time, but cannot move the viewing baseline.
    f.turn(90);
    f.host.nodeList = [{ node: { position: { x: 3, y: 1.5, z: 0 } } }, { trs: { position: { x: 5, y: 1.5, z: 0 } } }];
    f.attend(config.awayDelayMs + 200); await settle(); assert.equal(f.host._matchPhase, 'reacquiring');
    assert.equal(f.logs.find(([event]) => event === '离开内容')[1].distanceMeters, 2);
    pending = deferred(); await f.sample(); assert.equal(f.host._matchFrameBusy, true);
    f.turn(0); f.attend(config.returnDelayMs); assert.equal(f.host._matchPhase, 'reacquiring');
    f.attend(200); assert.equal(f.host._matchPhase, 'locked'); assert.equal(f.host._imageMatcher, null); assert.equal(f.host._matchFrameBusy, false);
    assert.match(f.statuses.at(-1).message, /内容已固定在空间中/); assert.equal(f.counts().closed, 2);
    if (late === 'resolve') pending.resolve({ vector: [0, 1, 0], inferenceMs: 100 }); else pending.reject(Error('识别已取消'));
    pending = null; await settle();
    assert.equal(f.host._matchPhase, 'locked'); assert.equal(f.host._matchedAnchorId, 'a'); assert.equal(f.host.displayed.length, 1);
    // Leaving again starts a fresh scan that can still switch.
    f.turn(90); f.attend(config.awayDelayMs + 200); await settle(); assert.equal(f.host._matchPhase, 'reacquiring');
    await f.sample(); f.tick(); await f.sample(); await settle();
    assert.equal(f.host._matchedAnchorId, 'b'); assert.equal(f.host._matchPhase, 'locked');
    assert.ok(!f.logs.some(([event, , level]) => level === 'error')); f.host.pauseRetrieval();
  }
});
test('nearby turns and walking restart matching, regardless of Scene origins or late content', async () => {
  const f = shownContent(); await f.lock();
  f.host.nodeList = [{ type: 'scene', node: { position: { x: 0, y: 0, z: -10 } } }];
  f.attend(3000); assert.equal(f.host._matchPhase, 'locked', 'a distant authored Scene origin is not walking away');
  f.camera.position.z = -1.5; // Half a metre from the stable viewing point.
  f.turn(180); f.attend(config.awayDelayMs + 200); await settle();
  assert.equal(f.host._matchPhase, 'reacquiring', 'nearby in-place turn restarts matching');
  f.host.nodeList.push({ node: { position: { x: 0, y: 1.5, z: 2 } } });
  f.attend(3000); assert.equal(f.host._matchPhase, 'reacquiring', 'late content in the new direction does not count as looking back');
  f.turn(0); f.attend(config.returnDelayMs + 200); assert.equal(f.host._matchPhase, 'locked');
  f.camera.position.z = 7;
  f.attend(config.awayDelayMs + 200); await settle();
  assert.equal(f.host._matchPhase, 'reacquiring', 'walking away while facing the target also restarts matching');
  f.host.pauseRetrieval();
});
test('a lone target or a failing background Worker leaves the shown content alone', async () => {
  const lone = fixture(); lone.host.getCamTransform = () => ({ position: { x: 0, y: 1.5, z: 0 }, getWorldDirection: () => heading(180) });
  await lone.host.recognizeAnchor(); await lone.sample(); lone.tick(); await lone.sample(); assert.equal(lone.host._matchPhase, 'locked');
  lone.host._matchLockPose = { position: { x: 0, y: 1.5, z: 0 }, forward: heading(0) };
  for (let i = 0; i < 10; i++) { lone.tick(200); lone.host._tickAttention(); }
  assert.equal(lone.host._matchPhase, 'locked'); assert.equal(lone.counts().closed, 1, 'no Worker is started with nothing to switch to');
  assert.equal(lone.logs.filter(([event]) => event === '不启动后台扫描').length, 1); lone.host.pauseRetrieval();
  let broken = false;
  const f = shownContent({ cameraEmbed: () => { if (broken) throw Error('WORKER_KILLED'); return { vector: [1, 0, 0], inferenceMs: 100 }; } });
  await f.lock(); f.turn(120); f.attend(config.awayDelayMs + 200); await settle(); assert.equal(f.host._matchPhase, 'reacquiring');
  broken = true; await f.sample();
  assert.equal(f.host._matchPhase, 'locked'); assert.equal(f.host._matchedAnchorId, 'a'); assert.equal(f.host.displayed.length, 1);
  assert.notEqual(f.statuses.at(-1).phase, 'error'); assert.match(f.statuses.at(-1).message, /内容已固定在空间中/);
  assert.equal(f.logs.at(-1)[0] === '后台识别失败' || f.logs.some(([event]) => event === '后台识别失败'), true);
  f.attend(config.reacquireRetryMs - 400); assert.equal(f.host._matchPhase, 'locked', 'waits before retrying');
  broken = false; f.attend(400); await settle(); assert.equal(f.host._matchPhase, 'reacquiring');
  // GPS movement still restarts everything, also during a background scan.
  f.tick(5000); f.move(40); await f.host.recognizeAnchor();
  assert.equal(f.host._matchPhase, 'scanning'); assert.equal(f.host._matchedAnchorId, null); assert.equal(f.host._matchAttention, null);
  f.host.pauseRetrieval();
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
  assert.equal(f.counts().captures, 2, 'a clear match confirms on the second frame and stops sampling');
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

test('steady weak results update summary without spamming logs or UI, and dark frames explain rejection', async t => {
  let embeddings = 0;
  const f = fixture({ embed: () => ({ vector: ++embeddings === 1 ? [1, 0] : [0.28, 0.96], inferenceMs: 150 }) });
  // Without per-frame logging, unchanged decisions are logged once.
  config.frameLogs = false; t.after(() => { config.frameLogs = true; });
  await f.host.recognizeAnchor(); const statusCount = f.statuses.length;
  for (let i = 0; i < 5; i++) { f.tick(); await f.sample(); }
  assert.equal(f.logs.filter(([event]) => event === '匹配结果').length, 1);
  assert.equal(f.statuses.length, statusCount, 'unchanged scan status must not trigger setData every sample');
  // The progress line reports every sampled frame: in-flight first, then its scores.
  const texts = f.progress.map(p => p.text);
  assert.equal(texts.filter(t => t.startsWith('匹配中')).length, 5);
  assert.equal(texts.filter(t => /相似度 0\.280（本帧 0\.280） /.test(t)).length, 5);
  assert.match(texts.at(-1), /^\d\d:\d\d:\d\d #5 相似度 0\.280（本帧 0\.280） .*下次 \d+\.\ds 后$/);
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
test('field calibration logs every sampled frame with per-target scores, timing and sharpness', async () => {
  assert.equal(config.frameLogs, true);
  const targets = [{ ...target('a'), image_urls: ['https://media.test/a.png', 'https://media.test/a-near.png'] }, target('b')];
  let references = 0;
  const f = fixture({ fetchAnchorCandidates: async () => ({ statusCode: 200, data: { candidates: targets } }),
    // Reference order: a, a-near, b. Camera frames match a-near best.
    embed: pixels => ({ vector: pixels.byteLength !== 4 ? [.1, .45, .8874] : [[1, 0, 0], [.6, .8, 0], [.8, -.6, 0]][references++], inferenceMs: 120 }) });
  await f.host.recognizeAnchor();
  const start = f.logs.find(([event]) => event === '扫描开始')[1];
  assert.equal(JSON.stringify(start.targets.map(t => [t.id, t.name, t.images])), JSON.stringify([['a', 'a', 2], ['b', 'b', 1]]));
  for (const key of ['minimumScore', 'minimumMargin', 'scoreSmoothingMs', 'strongScore', 'strongMargin', 'strongConfirmDurationMs',
    'leadFrameIntervalMs', 'blurSharpnessRatio', 'maxBlurRetries', 'maxContentPrefetches']) assert.equal(start[key], config[key], key);
  for (let i = 0; i < 3; i++) { await f.sample(); f.tick(); }
  const frames = f.logs.filter(([event]) => event === '匹配结果').map(([, fields]) => fields);
  assert.equal(frames.length, 3, 'one line per sampled frame');
  assert.equal(frames.map(frame => frame.frame).join(), '1,2,3'); assert.ok(frames[1].tMs > frames[0].tMs);
  const first = frames[0];
  assert.equal(JSON.stringify(first.scores[0]), JSON.stringify({ id: 'a', raw: 0.42, smooth: 0.42, image: 1 }));
  assert.equal(JSON.stringify(first.scores[1]), JSON.stringify({ id: 'b', raw: -0.19, smooth: -0.19, image: 0 }));
  for (const key of ['topScore', 'secondScore', 'margin', 'frameTopScore', 'frameMargin', 'observations', 'observationsRequired',
    'strong', 'leadMs', 'sharpness', 'captureMs', 'inferenceMs', 'elapsedMs', 'nextIntervalMs'])
    assert.ok(first[key] !== undefined && first[key] !== null, key);
  assert.equal(first.sharpnessBaseline, null, 'no baseline before the first frame'); assert.ok(frames[1].sharpnessBaseline > 0);
  const confirmed = f.logs.find(([event]) => event === '确认命中')[1];
  for (const key of ['via', 'score', 'margin', 'strong', 'observations', 'frames', 'leadMs', 'scanMs']) assert.ok(confirmed[key] != null, key);
  const prefetch = f.logs.find(([event]) => event === '预取内容')[1]; assert.equal(prefetch.frame, 1);
  assert.ok(f.logs.find(([event]) => event === '预取完成')[1].elapsedMs >= 0);
  assert.equal(f.logs.find(([event]) => event === '内容就绪')[1].prefetched, true);
  assert.ok(f.logs.find(([event]) => event === '内容已锁定')[1].scanMs >= 0);
  const text = JSON.stringify(f.logs);
  assert.ok(!text.includes('media.test') && !text.includes('latitude'), 'no image URLs or coordinates in logs');
});
test('candidate image lists accept one to five http images and fall back to image_url for older servers', () => {
  const { candidatesFrom } = require(path.join(base, 'components/xr-start/matching/candidates'));
  const urls = n => Array.from({ length: n }, (_, i) => `https://media.test/a-${i}.png`);
  assert.deepEqual(candidatesFrom({ candidates: [target()] })[0].image_urls, ['https://media.test/a.png']);
  assert.deepEqual(candidatesFrom({ candidates: [{ ...target(), image_urls: urls(5) }] })[0].image_urls, urls(5));
  for (const image_urls of [[], urls(6), ['ftp://media.test/a.png'], 'https://media.test/a.png'])
    assert.throws(() => candidatesFrom({ candidates: [{ ...target(), image_urls }] }), /识别目标数据无效/);
});
test('a target with several reference images embeds each one and is scored by its best image', async () => {
  const front = { id: 'a', vectors: [[0, 1], [1, 0]] }, other = { id: 'b', vectors: [[.6, .8]] };
  const result = policy.evaluateMatch([1, 0], [front, other], config);
  assert.equal(result.match.reference.id, 'a'); assert.equal(result.best.score, 1); assert.equal(result.second, .6);
  // Two near-identical photos of one target are not competitors.
  assert.equal(policy.evaluateMatch([1, 0], [{ id: 't', vectors: [[1, 0], [.99, .141]] }], config).match.reference.id, 't');
  assert.equal(policy.referenceScore([1, 0], { vector: [1, 0] }), 1, 'single-vector references still score');
  const loaded = [], image_urls = ['https://media.test/a.png', 'https://media.test/a-side.png'];
  const f = fixture({
    async fetchAnchorCandidates() { return { statusCode: 200, data: { candidates: [{ ...target(), image_urls }] } }; },
    loadReference(url) { loaded.push(url); return new ArrayBuffer(4); },
  });
  await f.host.recognizeAnchor();
  assert.equal(f.host._matchPhase, 'scanning'); assert.deepEqual(loaded, image_urls);
  assert.equal(f.host._matchReferences[0].vectors.length, 2); assert.equal(f.counts().embedded, 2);
  f.host.rescan(); await settle();
  assert.deepEqual(loaded, image_urls, 'an unchanged version reuses every cached image embedding');
  f.host.pauseRetrieval();
});

test('recognition events separate technical diagnostics from actionable panel hints', async () => {
  const f = fixture();
  await f.host.recognizeAnchor();
  const preparation = f.statuses.find(event => event.diagnostic.includes('参考图'));
  assert.equal(preparation.message, '正在准备图像识别…');
  assert.equal(preparation.phase, 'preparing');
  await f.sample();
  const confirmation = f.statuses.at(-1);
  assert.match(confirmation.diagnostic, /确认 1\/2/);
  assert.match(confirmation.message, /请保持镜头稳定/);
  assert.doesNotMatch(confirmation.message, /1\/2/);
  f.host._failFrameRecognition(new Error('WORKER_KILLED'), f.host._modeEpoch);
  assert.equal(f.statuses.at(-1).message, '图像识别失败，请重新扫描');
  assert.equal(f.statuses.at(-1).diagnostic, 'WORKER_KILLED');
  assert.equal(f.statuses.at(-1).phase, 'error');
});

test('replacement keeps the old content until the new response and a valid pose are ready', async t => {
  const content = deferred();
  const response = id => ({ statusCode: 200, data: { anchor: { id }, assets: [{ id: `${id}-text`, file_type: 'text' }] } });
  const f = shownContent({ fetchAnchorContent: body => body.anchor_id === 'b' ? content.promise : Promise.resolve(response('a')) });
  t.after(() => f.host.pauseRetrieval());
  await f.lock();
  const epoch = f.host._contentEpoch;
  const oldNodes = f.host.nodeList = [{ node: { position: { x: 0, y: 1.5, z: -2 } } }];
  f.turn(120); f.attend(config.awayDelayMs + 200); await settle();
  f.seen.vector = [0, 1, 0]; await f.sample(); f.tick(); await f.sample();
  assert.equal(f.host._matchPhase, 'loading');
  assert.equal(f.host._matchedAnchorId, 'a', 'confirmation must not remove the shown target before its replacement is available');
  assert.equal(f.host._contentEpoch, epoch); assert.equal(f.host.nodeList, oldNodes); assert.equal(f.host.displayed.length, 1);
  f.host._arReady = false;
  content.resolve(response('b')); await settle();
  assert.equal(f.host._matchPhase, 'tracking');
  assert.equal(f.host._matchedAnchorId, 'a'); assert.equal(f.host._contentEpoch, epoch); assert.equal(f.host.nodeList, oldNodes);
  f.host._finishMatchPlacement(); assert.equal(f.host.displayed.length, 1, 'a response alone cannot place without SLAM');
  f.host._arReady = true; f.host._finishMatchPlacement();
  assert.equal(f.host._matchPhase, 'locked'); assert.equal(f.host._matchedAnchorId, 'b');
  assert.equal(f.host._contentEpoch, epoch + 1, 'the replacement clears once, when placement can proceed');
  assert.notEqual(f.host.nodeList, oldNodes); assert.equal(f.host.displayed.length, 2);
  assert.equal(f.host.displayed.at(-1)[0].id, 'b-text');
  assert.ok(!f.logs.some(([event]) => event === '非法识别状态切换'));
});

test('a replacement request failure preserves the shown target and retries after the cooldown', async t => {
  let failReplacement = true, replacementRequests = 0;
  const f = shownContent({ async fetchAnchorContent(body) {
    if (body.anchor_id === 'b') {
      replacementRequests++;
      if (failReplacement) throw Error('content offline');
    }
    return { statusCode: 200, data: { anchor: { id: body.anchor_id }, assets: [{ id: `${body.anchor_id}-text`, file_type: 'text' }] } };
  } });
  t.after(() => f.host.pauseRetrieval());
  await f.lock();
  const epoch = f.host._contentEpoch;
  const oldNodes = f.host.nodeList = [{ node: { position: { x: 0, y: 1.5, z: -2 } } }];
  f.turn(120); f.attend(config.awayDelayMs + 200); await settle();
  f.seen.vector = [0, 1, 0]; await f.sample(); f.tick(); await f.sample(); await settle();
  assert.equal(replacementRequests, 2, 'failed prefetch is retried once on confirmation');
  assert.equal(f.host._matchPhase, 'locked'); assert.equal(f.host._matchedAnchorId, 'a');
  assert.equal(f.host._contentEpoch, epoch); assert.equal(f.host.nodeList, oldNodes); assert.equal(f.host.displayed.length, 1);
  assert.equal(f.host._imageMatcher, null); assert.equal(f.statuses.at(-1).locked, true);
  f.attend(config.reacquireRetryMs - 200); await settle();
  assert.equal(f.host._matchPhase, 'locked'); assert.equal(replacementRequests, 2);
  failReplacement = false; f.attend(200); await settle();
  assert.equal(f.host._matchPhase, 'reacquiring');
  await f.sample(); f.tick(); await f.sample(); await settle();
  assert.equal(f.host._matchedAnchorId, 'b'); assert.equal(f.host._matchPhase, 'locked');
  assert.equal(f.host._contentEpoch, epoch + 1); assert.equal(f.host.displayed.length, 2);
  assert.ok(!f.logs.some(([event]) => event === '非法识别状态切换'));
  const first = fixture({ async fetchAnchorContent() { throw Error('content offline'); } });
  t.after(() => first.host.pauseRetrieval());
  await first.host.recognizeAnchor(); await first.sample(); first.tick(); await first.sample(); await settle();
  assert.equal(first.host._matchPhase, 'error', 'without shown content the initial failure still requires rescan');
  assert.ok(first.host._matchedAnchorId == null); assert.equal(first.host.displayed.length, 0);
});

test('late background Worker initialization cannot undo a return, pause or replacement scan', async t => {
  for (const action of ['return', 'pause', 'rescan']) for (const late of ['resolve', 'reject']) {
    const oldStart = deferred(), newStart = deferred(); let starts = 0;
    const f = shownContent({ start: () => {
      starts++;
      return starts === 2 ? oldStart.promise : starts === 3 ? newStart.promise : undefined;
    } });
    t.after(() => f.host.pauseRetrieval());
    await f.lock(); f.turn(120); f.attend(config.awayDelayMs + 200); await settle();
    const oldMatcher = f.host._imageMatcher;
    assert.equal(f.host._matchPhase, 'reacquiring'); assert.equal(f.host._matchPreparing, true); assert.equal(starts, 2);
    if (action === 'return') {
      f.turn(0); f.attend(config.returnDelayMs + 400); await settle();
      assert.equal(f.host._matchPhase, 'locked'); assert.equal(f.host._matchedAnchorId, 'a');
      f.turn(120); f.attend(config.awayDelayMs + 200); await settle();
    } else if (action === 'pause') f.host.pauseRetrieval();
    else { f.host.rescan(); await settle(); }
    const currentMatcher = f.host._imageMatcher, phase = f.host._matchPhase, epoch = f.host._contentEpoch;
    assert.equal(oldMatcher.closed, true);
    assert.equal(f.host._matchPreparing, action !== 'pause');
    if (action !== 'pause') assert.notEqual(currentMatcher, oldMatcher);
    if (late === 'resolve') oldStart.resolve(); else oldStart.reject(Error('late Worker initialization failure'));
    await settle();
    assert.equal(f.host._imageMatcher, currentMatcher, `${action}/${late}: old start cannot replace the active matcher`);
    assert.equal(f.host._matchPhase, phase); assert.equal(f.host._contentEpoch, epoch);
    assert.equal(f.host._matchPreparing, action !== 'pause', 'an old finally cannot release a newer initialization');
    assert.equal(f.logs.filter(([event]) => event === '后台识别失败').length, 0);
    if (action !== 'pause') {
      newStart.resolve(); await settle();
      assert.equal(f.host._matchPreparing, false);
      assert.equal(f.host._matchPhase, action === 'return' ? 'reacquiring' : 'scanning');
    }
    assert.ok(!f.logs.some(([event]) => event === '非法识别状态切换'));
    f.host.pauseRetrieval();
  }
});

test('a retired background inference cannot release a newer Worker request', async t => {
  for (const late of ['resolve', 'reject']) {
    let pending = null;
    const f = shownContent({ cameraEmbed: () => pending ? pending.promise : { vector: [1, 0, 0], inferenceMs: 100 } });
    t.after(() => f.host.pauseRetrieval());
    await f.lock(); f.turn(120); f.attend(config.awayDelayMs + 200); await settle();
    const oldInference = pending = deferred();
    await f.sample(); assert.equal(f.host._matchFrameBusy, true);
    const oldMatcher = f.host._imageMatcher;
    f.turn(0); f.attend(config.returnDelayMs + 400); await settle();
    assert.equal(f.host._matchPhase, 'locked'); assert.equal(oldMatcher.closed, true);
    const newInference = pending = deferred();
    f.turn(120); f.attend(config.awayDelayMs + 200); await settle(); await f.sample();
    const newMatcher = f.host._imageMatcher, epoch = f.host._contentEpoch;
    assert.notEqual(newMatcher, oldMatcher); assert.equal(f.host._matchFrameBusy, true);
    if (late === 'resolve') oldInference.resolve({ vector: [0, 1, 0], inferenceMs: 100 });
    else oldInference.reject(Error('late Worker inference failure'));
    await settle();
    assert.equal(f.host._imageMatcher, newMatcher); assert.equal(f.host._matchFrameBusy, true);
    assert.equal(f.host._matchEvidence, null); assert.equal(f.host._matchPhase, 'reacquiring');
    assert.equal(f.host._matchedAnchorId, 'a'); assert.equal(f.host._contentEpoch, epoch); assert.equal(f.host.displayed.length, 1);
    assert.equal(f.logs.filter(([event]) => event === '后台识别失败').length, 0);
    newInference.resolve({ vector: [0, 1, 0], inferenceMs: 100 }); pending = null; await settle();
    assert.equal(f.host._matchFrameBusy, false); assert.equal(f.host._matchEvidence.id, 'b');
    assert.equal(f.host._matchPhase, 'reacquiring'); assert.equal(f.host.displayed.length, 1);
    f.host.pauseRetrieval();
  }
});

test('recognition hints use raw scores and hysteresis without changing confirmation or sampling', async t => {
  const best = score => ({ reference: { id: 'a' }, score });
  assert.equal(policy.hintActive(false, best(.29), null, config), false);
  assert.equal(policy.hintActive(false, best(.30), null, config), true);
  assert.equal(policy.hintActive(true, best(.26), null, config), true);
  assert.equal(policy.hintActive(true, best(.259), null, config), false);
  assert.equal(policy.hintActive(true, best(.9), 'a', config), false);
  assert.equal(policy.hintActive(true, null, null, config), false);
  assert.equal(policy.hintActive(true, best(NaN), null, config), false);
  const f = shownContent(); t.after(() => f.host.pauseRetrieval());
  await f.host.recognizeAnchor();
  const sampleScores = async (a, b) => {
    f.seen.vector = [a, b, Math.sqrt(1 - a * a - b * b)]; f.tick(); await f.sample();
    assert.equal(f.host._nextMatchFrameAt - f.now(), config.frameIntervalMs, 'a hint alone never speeds up inference');
    assert.equal(f.host._matchEvidence.count, 0); assert.equal(f.host.displayed.length, 0);
    assert.equal(f.contentCalls().length, 0, 'a hint alone does not prefetch content');
  };
  await sampleScores(.32, .31);
  assert.equal(f.host._matchHintActive, true, 'low scores can hint even with an insufficient margin');
  await sampleScores(.28, .27); assert.equal(f.host._matchHintActive, true);
  await sampleScores(.25, .24); assert.equal(f.host._matchHintActive, false, 'raw scores release while the average still exceeds the hint threshold');
  assert.ok(f.host._matchEvidence.scores.a > config.hintReleaseScore);
  await sampleScores(.28, .27); assert.equal(f.host._matchHintActive, false, 'enter and exit have different thresholds');
  await sampleScores(.31, .30); assert.equal(f.host._matchHintActive, true);
  await sampleScores(.60, .59); assert.equal(f.host._matchHintActive, true, 'high but ambiguous scores still only hint');
  assert.equal(JSON.stringify(f.hints), JSON.stringify([
    { mode: 'anchor', active: true }, { mode: 'anchor', active: false }, { mode: 'anchor', active: true },
  ]), 'only state changes emit an independent hint event');
});

test('recognition hints expire without camera frames and invalid results turn them off immediately', async t => {
  const f = shownContent(); t.after(() => f.host.pauseRetrieval());
  f.seen.vector = [.35, .1, Math.sqrt(1 - .35 ** 2 - .1 ** 2)];
  await f.host.recognizeAnchor(); await f.sample();
  const oldTimer = [...f.hintTimers.values()][0];
  f.tick(); await f.sample();
  assert.equal(f.hintTimers.size, 1); oldTimer.fn();
  assert.equal(f.host._matchHintActive, true, 'a refreshed hint ignores its old timer in the same Worker');
  f.tick(config.hintStaleMs - 1); f.expireHints(); assert.equal(f.host._matchHintActive, true);
  f.tick(1); f.expireHints(); assert.equal(f.host._matchHintActive, false, 'time alone expires the hint');
  assert.equal(f.hintTimers.size, 0); assert.equal(f.host._matchHintTimer, null);
  await f.sample(); assert.equal(f.host._matchHintActive, true);
  const sharp = f.pixels.slice(); f.pixels.fill(0); f.tick(); await f.sample();
  assert.equal(f.host._matchHintActive, false); assert.equal(f.hintTimers.size, 0);
  f.pixels.set(sharp); f.tick(); await f.sample(); assert.equal(f.host._matchHintActive, true);
  const inference = deferred(); f.host._imageMatcher.embed = () => inference.promise;
  f.tick(); await f.sample(); f.tick(config.maxResultAgeMs + 1);
  inference.resolve({ vector: f.seen.vector, inferenceMs: config.maxResultAgeMs + 1 }); await settle();
  assert.equal(f.host._matchHintActive, false, 'an expired result cannot refresh a still-active hint');
  assert.equal(f.hintTimers.size, 0);
});

test('a blurred frame keeps a recognition hint briefly without extending its lifetime', async t => {
  const f = shownContent(); t.after(() => f.host.pauseRetrieval());
  f.seen.vector = [.35, .1, Math.sqrt(1 - .35 ** 2 - .1 ** 2)];
  await f.host.recognizeAnchor(); await f.sample();
  const timer = f.host._matchHintTimer, embedded = f.counts().embedded;
  for (let i = 0; i < f.pixels.length; i++) f.pixels[i] = Math.floor(i / 4 / 224) % 251;
  f.tick(); await f.sample();
  assert.equal(f.counts().embedded, embedded); assert.equal(f.host._matchHintActive, true);
  assert.equal(f.host._matchHintTimer, timer, 'skipped blur is not a fresh valid result');
  f.tick(config.hintStaleMs - config.frameIntervalMs); f.expireHints();
  assert.equal(f.host._matchHintActive, false); assert.equal(f.hintTimers.size, 0);
});

test('recognition hints end on confirmation and every scan cancellation path', async t => {
  const content = deferred(), confirming = shownContent({ fetchAnchorContent: () => content.promise });
  t.after(() => confirming.host.pauseRetrieval());
  await confirming.host.recognizeAnchor(); await confirming.sample();
  assert.equal(confirming.host._matchHintActive, true);
  confirming.host._arReady = false; confirming.tick(); await confirming.sample();
  assert.equal(confirming.host._matchPhase, 'loading'); assert.equal(confirming.host._matchHintActive, false);
  assert.equal(confirming.hintTimers.size, 0); assert.deepEqual(confirming.hints.map(h => h.active), [true, false]);
  content.resolve({ statusCode: 200, data: { anchor: { id: 'a' }, assets: [] } }); await settle();
  assert.equal(confirming.host._matchPhase, 'tracking'); assert.equal(confirming.host._matchHintActive, false);
  for (const action of ['rescan', 'pause', 'mode', 'exit', 'failure']) {
    const f = shownContent(); t.after(() => f.host.pauseRetrieval());
    f.seen.vector = [.35, .1, Math.sqrt(1 - .35 ** 2 - .1 ** 2)];
    await f.host.recognizeAnchor(); await f.sample();
    const timer = [...f.hintTimers.values()][0];
    if (action === 'rescan') f.host.rescan();
    else if (action === 'pause') f.host.pauseRetrieval();
    else if (action === 'mode') f.host.setRetrievalMode('gps');
    else if (action === 'failure') f.host._failFrameRecognition(Error('Worker failed'), f.host._modeEpoch);
    else { f.host.pauseRetrieval(); f.host._disposed = true; }
    await settle();
    assert.equal(f.host._matchHintActive, false, action); assert.equal(f.hintTimers.size, 0, action);
    assert.deepEqual(f.hints.map(h => h.active), [true, false]);
    timer.fn(); assert.deepEqual(f.hints.map(h => h.active), [true, false], 'cancelled timers cannot revive a hint');
  }
});

test('background recognition hints suppress the raw shown target and ignore retired timers and results', async t => {
  for (const late of ['resolve', 'reject']) {
    const f = shownContent(); t.after(() => f.host.pauseRetrieval());
    await f.lock(); f.turn(120); f.attend(config.awayDelayMs + 200); await settle();
    await f.sample(); assert.equal(f.host._matchHintActive, false, 'even a strong current-target result has no background hint');
    f.seen.vector = [.1, .35, Math.sqrt(1 - .1 ** 2 - .35 ** 2)]; f.tick(); await f.sample();
    assert.equal(f.host._matchHintActive, true, 'the raw new target hints while the smoothed old target still leads');
    assert.equal(f.host._matchEvidence.scores.a > f.host._matchEvidence.scores.b, true);
    f.seen.vector = [.35, .34, Math.sqrt(1 - .35 ** 2 - .34 ** 2)]; f.tick(); await f.sample();
    assert.equal(f.host._matchHintActive, false, 'a raw shown-target lead suppresses hints without a formal match');
    f.seen.vector = [.1, .35, Math.sqrt(1 - .1 ** 2 - .35 ** 2)]; f.tick(); await f.sample();
    const oldTimer = [...f.hintTimers.values()][0], oldInference = deferred();
    f.host._imageMatcher.embed = () => oldInference.promise; f.tick(); await f.sample();
    f.turn(0); f.attend(config.returnDelayMs + 400); await settle();
    assert.equal(f.host._matchHintActive, false); assert.equal(f.hintTimers.size, 0);
    f.turn(120); f.attend(config.awayDelayMs + 200); await settle(); await f.sample();
    assert.equal(f.host._matchHintActive, true); const newTimer = f.host._matchHintTimer, events = f.hints.length;
    oldTimer.fn();
    if (late === 'resolve') oldInference.resolve({ vector: [1, 0, 0], inferenceMs: 100 });
    else oldInference.reject(Error('retired inference failed'));
    await settle();
    assert.equal(f.host._matchHintActive, true); assert.equal(f.host._matchHintTimer, newTimer); assert.equal(f.hints.length, events);
    f.host._failFrameRecognition(Error('background Worker failed'), f.host._modeEpoch);
    assert.equal(f.host._matchPhase, 'locked'); assert.equal(f.host._matchHintActive, false); assert.equal(f.hintTimers.size, 0);
  }
});
