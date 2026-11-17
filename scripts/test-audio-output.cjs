const assert = require('node:assert/strict');
const test = require('node:test');
const { ensureMediaAudioOutput, SETTLE_TIMEOUT_MS } = require('../miniprogram/lib/three-runtime/audio-output');
const { createAudioPlayback, createSceneMediaContext } = require('../miniprogram/lib/scene-runtime/media-audio');
const { createVideoSoundtrack } = require('../miniprogram/lib/scene-runtime/media-video-audio');
const { createVideo } = require('../miniprogram/lib/three-runtime/video');

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const settings = { trimStartSeconds: 0, trimEndSeconds: null, playbackRate: 1, volume: 1, muted: false, loop: false };

// One wx runtime that records native creation order. setInnerAudioOption answers
// asynchronously like the client; `answer` can change between requests.
function runtime(t, answer = 'success') {
  const state = { answer, calls: [], requests: [] }, previous = global.wx;
  t.after(() => { global.wx = previous; });
  t.mock.method(console, 'warn', () => {});
  global.wx = {
    setInnerAudioOption(options) {
      state.calls.push('option'); state.requests.push(options);
      if (state.answer === 'throw') throw new Error('bridge unavailable');
      if (state.answer === 'success') queueMicrotask(() => options.success());
      if (state.answer === 'fail') queueMicrotask(() => options.fail({ errMsg: 'setInnerAudioOption:fail' }));
    },
    createInnerAudioContext() {
      state.calls.push('inner');
      const audio = { paused: true, volume: 0, play() { this.paused = false; }, pause() { this.paused = true; }, seek() {}, destroy() {} };
      for (const name of ['Canplay', 'Seeked', 'Ended', 'Error']) { audio[`on${name}`] = () => {}; audio[`off${name}`] = () => {}; }
      return audio;
    },
    createVideoDecoder() {
      state.calls.push('decoder');
      return { on() {}, off() {}, start: async () => {}, seek: async () => {}, stop: async () => {}, remove: async () => {}, getFrameData: () => null };
    },
    createMediaAudioPlayer() {
      state.calls.push('player');
      return { volume: 0, addAudioSource: async () => {}, removeAudioSource: async () => {}, start: async () => {}, stop: async () => {}, destroy: async () => {} };
    },
  };
  return state;
}
const playback = (isCancelled = () => false) => ({ mediaContext: createSceneMediaContext(), onError: error => { throw error; }, isCancelled });
// The buffered path's context factory stands in for wx.createWebAudioContext.
function bufferedPlayback(state) {
  const context = { destination: {}, createGain: () => ({ gain: { value: 0 }, connect() {}, disconnect() {} }) };
  return { forceBuffered: true, isCancelled: () => false, onError: error => { throw error; },
    mediaContext: { getAudioContext() { state.calls.push('webaudio'); return context; }, decode: async () => ({ duration: 4 }), onDispose: () => () => {} } };
}

test('applies the media route once per runtime, through the loudspeaker', async t => {
  const state = runtime(t);
  assert.deepEqual(await Promise.all([ensureMediaAudioOutput(), ensureMediaAudioOutput()]), [true, true]);
  await ensureMediaAudioOutput();
  assert.equal(state.requests.length, 1, 'concurrent and later sounds share one app-wide request');
  const { obeyMuteSwitch, mixWithOther, speakerOn } = state.requests[0];
  assert.deepEqual({ obeyMuteSwitch, mixWithOther, speakerOn }, { obeyMuteSwitch: false, mixWithOther: false, speakerOn: true },
    'iOS silent mode must not mute AR sound; loudspeaker output is exclusive per the client');
});

test('sound still plays when the option API is unavailable', async t => {
  runtime(t); delete global.wx.setInnerAudioOption;
  assert.equal(await ensureMediaAudioOutput(), false);
});

for (const answer of ['fail', 'throw']) {
  test(`a request that answers ${answer} is retried before the next sound`, async t => {
    const state = runtime(t, answer);
    assert.equal(await ensureMediaAudioOutput(), false);
    state.answer = 'success';
    assert.equal(await ensureMediaAudioOutput(), true);
    await ensureMediaAudioOutput();
    assert.equal(state.requests.length, 2);
  });
}

test('an unanswered request stops delaying sound and is not repeated', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const state = runtime(t, 'never');
  let settled = false;
  const request = ensureMediaAudioOutput().then(value => { settled = true; return value; });
  await flush(); assert.equal(settled, false);
  t.mock.timers.tick(SETTLE_TIMEOUT_MS);
  assert.equal(await request, false);
  await ensureMediaAudioOutput();
  assert.equal(state.requests.length, 1, 'a silent API must not add a timeout to every later sound');
});

test('every sound path sets the route before creating its native player', async t => {
  const state = runtime(t);
  const first = await createAudioPlayback('https://assets.example/a.mp3', settings, playback());
  const second = await createAudioPlayback('https://assets.example/b.m4a', settings, playback());
  const buffered = await createAudioPlayback('https://assets.example/c.webm', settings, bufferedPlayback(state));
  const soundtrack = await createVideoSoundtrack('https://assets.example/v.mp4', playback());
  const video = createVideo('https://assets.example/map.mp4', {}, error => { throw error; });
  await video.play();
  assert.deepEqual(state.calls, ['option', 'inner', 'inner', 'webaudio', 'decoder', 'player', 'decoder', 'player'],
    'scene audio, legacy WebAudio, scene video soundtracks and map videos share the one app-wide request');
  for (const owner of [first, second, buffered, soundtrack, video]) owner.dispose();
});

test('a muted map video does not touch the audio route', async t => {
  const state = runtime(t);
  const video = createVideo('https://assets.example/muted.mp4', { muted: true }, error => { throw error; });
  await video.play(); video.dispose();
  assert.deepEqual(state.calls, ['decoder']);
});

test('leaving while the route is being set creates no native player', async t => {
  const state = runtime(t, 'manual');
  let cancelled = false;
  const audio = createAudioPlayback('https://assets.example/a.mp3', settings, playback(() => cancelled));
  const soundtrack = createVideoSoundtrack('https://assets.example/v.mp4', playback(() => cancelled));
  const video = createVideo('https://assets.example/map.mp4', {}, error => { throw error; });
  const starting = video.play();
  await flush();
  cancelled = true; video.dispose();
  state.requests[0].success();
  await assert.rejects(audio, /演出音频加载已取消/);
  await assert.rejects(soundtrack, /视频音轨加载已取消/);
  await starting;
  assert.deepEqual(state.calls, ['option', 'decoder']);
});
