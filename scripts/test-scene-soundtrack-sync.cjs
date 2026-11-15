const assert = require('node:assert/strict');
const { createAudioPlayback } = require('../miniprogram/lib/scene-runtime/media-audio-buffered');
const { createVideoSoundtrack } = require('../miniprogram/lib/scene-runtime/media-video-audio');
const flush = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };
const settings = { trimStartSeconds: 0, trimEndSeconds: null, loop: false, muted: false };
const transport = (revision = 0, cycle = 0) => ({ revision, cycle });

function owner() {
  const cleanups = new Set(), errors = [];
  return { cleanups, errors, options: { isCancelled: () => false, onError: error => errors.push(error),
    mediaContext: { onDispose(callback) { cleanups.add(callback); return () => cleanups.delete(callback); } },
  } };
}
function bufferedPlatform({ suspended = false } = {}) {
  const state = owner(), sources = [], resumes = [];
  const gain = { gain: { value: 0 }, connect() {}, disconnect() { this.disconnected = true; } };
  const context = { currentTime: 0, state: suspended ? 'suspended' : 'running', destination: {},
    createGain: () => gain,
    resume() { return new Promise(resolve => resumes.push(() => { this.state = 'running'; resolve(); })); },
    createBufferSource() {
      const node = { starts: [], stops: [], connect() {}, disconnect() { this.disconnected = true; },
        start(...args) { this.starts.push(args); }, stop(...args) { this.stops.push(args); } };
      sources.push(node); return node;
    },
  };
  Object.assign(state.options.mediaContext, { getAudioContext: () => context, decode: async () => ({ duration: 4 }) });
  return { ...state, context, gain, sources, resumes };
}
function videoPlatform({ delayedSeek = false, delayedStart = false } = {}) {
  const state = owner(), seeks = [], pending = [], starts = [];
  const decoder = { position: 0, removed: 0, stopped: 0,
    start() { return Promise.resolve(); },
    seek(ms) {
      seeks.push(ms);
      const complete = () => { this.position = ms; };
      if (!delayedSeek) { complete(); return Promise.resolve(); }
      return new Promise(resolve => pending.push(() => { complete(); resolve(); }));
    },
    stop() { this.stopped++; return Promise.resolve(); }, remove() { this.removed++; return Promise.resolve(); },
  };
  const player = { volume: 0, destroyed: 0, stopped: 0,
    addAudioSource() { return Promise.resolve(); },
    start() { starts.push(decoder.position); return delayedStart ? new Promise(resolve => pending.push(resolve)) : Promise.resolve(); },
    stop() { this.stopped++; return Promise.resolve(); }, destroy() { this.destroyed++; return Promise.resolve(); },
  };
  global.wx = { createVideoDecoder: () => decoder, createMediaAudioPlayer: () => player };
  return { ...state, decoder, player, seeks, starts, pending,
    async settle() { for (let i = 0; i < 10; i++) { pending.splice(0).forEach(resolve => resolve()); await flush(); } },
  };
}

const tests = [];
function test(name, run) { tests.push({ name, run }); }

test('buffered continuous frames and local loops never recreate the native source', async () => {
  const state = bufferedPlatform();
  const audio = await createAudioPlayback('audio.wav', { ...settings, loop: true }, state.options);
  try {
    audio.sync(0, true, .5, transport());
    for (let i = 1; i <= 30; i++) {
      state.context.currentTime = Math.floor(i / 5) / 2;
      audio.sync(i / 10, true, .5, transport());
    }
    audio.sync(0, true, .5, transport(0, 1));
    assert.equal(state.sources.length, 1, 'quantized audio clocks and a local loop do not restart playback');
    audio.sync(.25, true, .5, transport(1, 1));
    assert.equal(state.sources.length, 2, 'an explicit seek does restart buffered playback');
    assert.deepEqual(state.sources[1].starts, [[0, .25]]);
  } finally { audio.dispose(); }
  assert.equal(state.cleanups.size, 0); assert.equal(state.errors.length, 0);
});

test('buffered EOF stays ended until a new transport intent', async () => {
  const state = bufferedPlatform();
  const audio = await createAudioPlayback('audio.wav', settings, state.options);
  try {
    audio.sync(0, true, .5, transport());
    state.sources[0].onended();
    audio.sync(.1, true, .5, transport());
    assert.equal(state.sources.length, 1, 'a lagging scene clock must not replay natural EOF');
    audio.sync(.25, true, .5, transport(1));
    assert.deepEqual(state.sources[1].starts, [[0, .25]]);
    audio.sync(.3, false, .5, transport(1));
    audio.sync(.31, false, .5, transport(1));
    audio.sync(.31, true, .5, transport(1));
    assert.deepEqual(state.sources[2].starts, [[0, .31]]);
  } finally { audio.dispose(); }
});

test('buffered pending resume only starts the latest transport intent', async () => {
  const state = bufferedPlatform({ suspended: true });
  const audio = await createAudioPlayback('audio.wav', settings, state.options);
  try {
    audio.sync(0, true, .5, transport());
    audio.sync(.25, true, .5, transport(1));
    audio.sync(.26, false, .5, transport(1));
    state.resumes.splice(0).forEach(resolve => resolve()); await flush();
    assert.equal(state.sources.length, 0);
    audio.sync(.26, true, .5, transport(1)); await flush();
    assert.equal(state.sources.length, 1); assert.deepEqual(state.sources[0].starts, [[0, .26]]);
  } finally { audio.dispose(); }
});

test('buffered disposal cancels a pending context resume', async () => {
  const state = bufferedPlatform({ suspended: true });
  const audio = await createAudioPlayback('audio.wav', settings, state.options);
  audio.sync(0, true, .5, transport()); audio.dispose();
  state.resumes.splice(0).forEach(resolve => resolve()); await flush();
  assert.equal(state.sources.length, 0); assert.equal(state.cleanups.size, 0);
  assert.equal(state.gain.gain.value, 0); assert.ok(state.gain.disconnected);
});

test('video soundtrack continuous frames never chase the estimated audio clock', async () => {
  const state = videoPlatform(), previousNow = Date.now;
  let wall = 0; Date.now = () => wall;
  const audio = await createVideoSoundtrack('video.mp4', state.options);
  try {
    audio.sync(0, true, .5, transport()); await flush();
    for (let i = 1; i <= 30; i++) { wall = i * 100; audio.sync(i * .03, true, .5, transport()); await flush(); }
    assert.deepEqual(state.seeks, [0], 'continuous scene/audio clock skew does not seek');
    assert.equal(state.starts.length, 1);
    audio.sync(.25, true, .5, transport(1)); await flush();
    assert.deepEqual(state.seeks, [0, 250]);
    audio.sync(.25, true, .5, transport(1, 1)); await flush();
    assert.deepEqual(state.seeks, [0, 250, 250], 'streamed video soundtrack seeks once at a local loop');
  } finally { audio.dispose(); Date.now = previousNow; }
  assert.equal(state.cleanups.size, 0); assert.equal(state.errors.length, 0);
});

test('video slow seek starts once without chasing ordinary frames', async () => {
  const state = videoPlatform({ delayedSeek: true });
  const audio = await createVideoSoundtrack('video.mp4', state.options);
  try {
    audio.sync(0, true, .5, transport()); await flush();
    audio.sync(.8, true, .5, transport());
    state.pending.shift()(); await flush();
    assert.deepEqual(state.seeks, [0]); assert.deepEqual(state.starts, [0]);
  } finally { audio.dispose(); await state.settle(); }
});

test('video seek completion cannot play an obsolete intent after pause and a small seek', async () => {
  const state = videoPlatform({ delayedSeek: true });
  const audio = await createVideoSoundtrack('video.mp4', state.options);
  try {
    audio.sync(0, true, .5, transport()); await flush();
    audio.sync(.25, false, .5, transport(1));
    assert.equal(state.player.volume, 0);
    audio.sync(.25, true, .5, transport(1));
    state.pending.shift()(); await flush();
    assert.deepEqual(state.starts, [], 'an old seek must not briefly replay the wrong position');
    assert.deepEqual(state.seeks, [0, 250]);
    state.pending.shift()(); await flush();
    assert.deepEqual(state.starts, [250]);
    audio.sync(.25, false, .5, transport(1)); await flush();
    await state.settle();
    const before = state.seeks.length;
    audio.sync(.26, false, .5, transport(1)); await flush();
    assert.equal(state.seeks.length, before + 1); assert.equal(state.seeks.at(-1), 260);
  } finally { audio.dispose(); await state.settle(); }
});

test('video disposal releases a pending seek and rejects its late playback', async () => {
  const state = videoPlatform({ delayedSeek: true });
  const audio = await createVideoSoundtrack('video.mp4', state.options);
  audio.sync(0, true, .5, transport()); await flush();
  audio.dispose();
  assert.equal(state.player.volume, 0); assert.equal(state.cleanups.size, 0);
  assert.ok(state.player.destroyed > 0 && state.decoder.removed > 0);
  await state.settle();
  assert.deepEqual(state.starts, []); assert.equal(state.errors.length, 0);
});

test('video pause immediately mutes a pending native start', async () => {
  const state = videoPlatform({ delayedStart: true });
  const audio = await createVideoSoundtrack('video.mp4', state.options);
  try {
    audio.sync(0, true, .5, transport()); await flush();
    assert.deepEqual(state.starts, [0]);
    audio.sync(.25, false, .5, transport());
    assert.equal(state.player.volume, 0);
    state.pending.shift()(); await flush();
    assert.ok(state.player.stopped > 0);
    assert.deepEqual(state.seeks, [0, 250]); assert.deepEqual(state.starts, [0]);
    assert.equal(state.player.volume, 0);
    audio.sync(.25, true, .5, transport()); await flush();
    assert.deepEqual(state.starts, [0, 250]);
    state.pending.shift()(); await flush();
    assert.equal(state.player.volume, .5);
  } finally { audio.dispose(); await state.settle(); }
});

// Each create returns a fresh native pair, as on device. `hang(kind, method, n)`
// decides whether the n-th call of that pipeline's method never settles.
function rebuildPlatform({ hang = () => false } = {}) {
  const state = owner(), decoders = [], players = [], diagnostics = [];
  state.options.onDiagnostic = event => diagnostics.push(event);
  state.options.stepTimeoutMs = 20;
  const never = () => new Promise(() => {});
  global.wx = {
    createVideoDecoder() {
      const index = decoders.length, listeners = {}, calls = { seek: 0 };
      const decoder = { index, seeks: [], removed: 0,
        on(name, callback) { listeners[name] = callback; }, emit(name) { listeners[name]?.(); },
        start() { return Promise.resolve(); },
        seek(ms) { calls.seek++; this.seeks.push(ms); return hang('decoder', 'seek', calls.seek, index) ? never() : Promise.resolve(); },
        stop() { return Promise.resolve(); }, remove() { this.removed++; return Promise.resolve(); },
      };
      decoders.push(decoder); return decoder;
    },
    createMediaAudioPlayer() {
      const index = players.length, calls = { start: 0, stop: 0 };
      const player = { index, volume: 0, starts: 0, destroyed: 0,
        addAudioSource() { return Promise.resolve(); },
        start() { calls.start++; this.starts++; return hang('player', 'start', calls.start, index) ? never() : Promise.resolve(); },
        stop() { calls.stop++; return hang('player', 'stop', calls.stop, index) ? never() : Promise.resolve(); },
        destroy() { this.destroyed++; return Promise.resolve(); },
      };
      players.push(player); return player;
    },
  };
  return { ...state, decoders, players, diagnostics };
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test('video soundtrack replaces an ended decoder at a loop instead of seeking it', async () => {
  const state = rebuildPlatform();
  const audio = await createVideoSoundtrack('video.mp4', state.options);
  try {
    audio.sync(0, true, .5, transport()); await flush();
    assert.equal(state.decoders.length, 1); assert.equal(state.players[0].starts, 1);
    state.decoders[0].emit('ended');
    audio.sync(0, true, .5, transport(0, 1)); await flush();
    assert.equal(state.decoders.length, 2, 'a loop after EOF opens a fresh decoder');
    assert.deepEqual(state.decoders[0].seeks, [0], 'the ended decoder is never sought again');
    assert.ok(state.decoders[0].removed > 0 && state.players[0].destroyed > 0, 'the ended pair is released');
    assert.deepEqual(state.decoders[1].seeks, [0]); assert.equal(state.players[1].starts, 1);
    assert.equal(state.players[1].volume, .5);
    audio.sync(0, true, .5, transport(0, 2)); await flush();
    assert.equal(state.decoders.length, 2, 'a loop before EOF still reuses the decoder');
    assert.deepEqual(state.decoders[1].seeks, [0, 0]);
  } finally { audio.dispose(); }
  assert.equal(state.errors.length, 0); assert.equal(state.diagnostics.length, 0); assert.equal(state.cleanups.size, 0);
});

test('video soundtrack recovers from a native seek that never settles', async () => {
  // The first decoder hangs on its second seek (the loop boundary).
  const state = rebuildPlatform({ hang: (kind, method, n, index) => kind === 'decoder' && index === 0 && n === 2 });
  const audio = await createVideoSoundtrack('video.mp4', state.options);
  try {
    audio.sync(0, true, .5, transport()); await flush();
    audio.sync(0, true, .5, transport(0, 1)); await flush();
    assert.equal(state.players[0].volume, 0, 'the pending loop is silent');
    await wait(40); await flush();
    assert.equal(state.errors.length, 0, 'one hung step is not fatal');
    assert.equal(state.diagnostics.length, 1);
    assert.equal(state.diagnostics[0].event, 'soundtrack_recover');
    assert.match(state.diagnostics[0].message, /视频音轨定位超时/);
    assert.equal(state.decoders.length, 2); assert.ok(state.decoders[0].removed > 0);
    assert.deepEqual(state.decoders[1].seeks, [0]); assert.equal(state.players[1].starts, 1);
    assert.equal(state.players[1].volume, .5);
  } finally { audio.dispose(); }
  assert.equal(state.cleanups.size, 0);
});

test('video soundtrack reports an error only after repeated failed rebuilds', async () => {
  // Every pipeline after the first hangs on start.
  const state = rebuildPlatform({ hang: (kind, method, n, index) => kind === 'player' && method === 'start' && index > 0 });
  const audio = await createVideoSoundtrack('video.mp4', state.options);
  audio.sync(0, true, .5, transport()); await flush();
  state.decoders[0].emit('ended');
  audio.sync(0, true, .5, transport(0, 1));
  await wait(150); await flush();
  assert.equal(state.diagnostics.length, 2);
  assert.equal(state.errors.length, 1);
  assert.match(state.errors[0].message, /视频音轨播放失败: 视频音轨播放超时/);
  assert.ok(state.players.every(player => player.destroyed > 0), 'every abandoned pair is released');
  assert.equal(state.cleanups.size, 0);
});

(async () => {
  let failures = 0;
  for (const { name, run } of tests) {
    try { await run(); console.log(`PASS ${name}`); }
    catch (error) { failures++; console.error(`FAIL ${name}\n${error.stack}`); }
  }
  if (failures) process.exitCode = 1;
  else console.log(`${tests.length} soundtrack synchronization regressions passed`);
})();
