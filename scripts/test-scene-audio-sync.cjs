const assert = require('node:assert/strict');
const test = require('node:test');
const { createCompositionPlayer } = require('../miniprogram/lib/scene-runtime/composition');

const flush = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };
function fixture({ quantum = .5, delayedSeek = false, delayedCanplay = false, trimStart = 0, trimEnd = 60, loop = false, sceneDuration = 60, sceneLoop = false } = {}) {
  let now = 0;
  const contexts = [], errors = [], oldWx = global.wx, oldNow = Date.now;
  Date.now = () => Math.round(now * 1000);
  global.wx = { createInnerAudioContext() {
    const events = new Map();
    let offset = 0, startedAt = 0, playing = false;
    const audio = { duration: 60, plays: 0, destroys: 0, seeks: [], pending: [],
      get actualTime() { return offset + (playing ? now - startedAt : 0); },
      get currentTime() { return Math.floor(this.actualTime / quantum) * quantum; },
      get paused() { return !playing; },
      set src(value) { this.url = value; offset = this.startTime; if (!delayedCanplay) queueMicrotask(() => this.emit('Canplay')); },
      play() { if (!playing) startedAt = now; playing = true; this.plays++; },
      pause() { offset = this.actualTime; playing = false; },
      destroy() { playing = false; this.destroys++; },
      emit(name, value) { events.get(name)?.(value); },
      seek(time) {
        this.seeks.push(time);
        const complete = () => { offset = time; startedAt = now; this.emit('Seeked'); };
        if (delayedSeek) this.pending.push(complete); else queueMicrotask(complete);
      },
    };
    for (const name of ['Canplay', 'Seeked', 'Ended', 'Error']) {
      audio[`on${name}`] = callback => events.set(name, callback);
      audio[`off${name}`] = () => events.delete(name);
    }
    contexts.push(audio); return audio;
  } };
  const player = createCompositionPlayer({ schemaVersion: 8,
    resources: { music: { kind: 'audio', url: 'https://fixture.example/music.mp3' } },
    content: { kind: 'composition', units: 'meters', durationSeconds: sceneDuration, loop: sceneLoop, assets: { music: { assetId: 'music' } },
      instances: [{ id: 'music', asset: 'music', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], animation: null,
        timing: { startSeconds: 0, endSeconds: sceneDuration, fadeInSeconds: 0, fadeOutSeconds: 0 },
        media: { trimStartSeconds: trimStart, trimEndSeconds: trimEnd, playbackRate: 1, volume: .8, muted: false, loop } }] },
  }, { onState(state, message) { if (state === 'error') errors.push(message); } });
  return { player, contexts, errors,
    async start() { await player.load(); await flush(); player.play(); await flush(); return contexts[0]; },
    async tick(seconds) { now += seconds; player.update(seconds); await flush(); },
    dispose() { player.dispose(); global.wx = oldWx; Date.now = oldNow; },
  };
}

test('continuous composition playback never seeks against a quantized native clock', async t => {
  const f = fixture(); t.after(() => f.dispose()); const audio = await f.start();
  const seeks = audio.seeks.length, plays = audio.plays;
  for (let i = 0; i < 500; i++) await f.tick(.01);
  assert.equal(audio.seeks.length - seeks, 0, '5 seconds of continuous audio must cause zero corrective seeks');
  assert.equal(audio.plays, plays);
  assert.ok(Math.abs(audio.actualTime - 5) < 1e-6); assert.deepEqual(f.errors, []);
  f.player.seek(5.25); await flush();
  assert.equal(audio.seeks.length, seeks + 1, 'an explicit 250ms seek must not be hidden by a drift threshold');
  assert.equal(audio.actualTime, 5.25);
});

test('slow seek coalesces explicit changes, while pause prevents stale playback', async t => {
  const f = fixture({ delayedSeek: true }); t.after(() => f.dispose()); const audio = await f.start();
  while (audio.pending.length) { audio.pending.shift()(); await flush(); }
  const plays = audio.plays;
  f.player.seek(3); await flush(); await f.tick(.4);
  assert.deepEqual(audio.seeks.slice(-1), [3]);
  f.player.pause(); f.player.seek(3.25); await flush();
  assert.equal(audio.paused, true);
  audio.pending.shift()(); await flush();
  assert.equal(audio.plays, plays, 'an obsolete seek must not resume playback');
  assert.equal(audio.seeks.at(-1), 3.25);
  audio.pending.shift()(); await flush();
  assert.equal(audio.actualTime, 3.25); assert.equal(audio.paused, true);
  f.player.play(); await flush();
  while (audio.pending.length) { audio.pending.shift()(); await flush(); }
  assert.equal(audio.paused, false);
  f.player.seek(4); await flush();
  f.player.dispose(); audio.pending.shift()(); await flush();
  assert.equal(audio.destroys, 1); assert.equal(audio.paused, true);
});

test('trim loops and full scene wraps seek once per transport boundary', async t => {
  const f = fixture({ trimStart: 2, trimEnd: 4, loop: true, sceneDuration: 8, sceneLoop: true });
  t.after(() => f.dispose()); const audio = await f.start(); const before = audio.seeks.length;
  await f.tick(1); assert.equal(audio.seeks.length, before);
  await f.tick(1); assert.equal(audio.seeks.length, before + 1); assert.equal(audio.actualTime, 2);
  await f.tick(8); assert.equal(audio.seeks.length, before + 2, 'a full scene wrap is explicit even when source time repeats');
  assert.equal(audio.actualTime, 2); assert.deepEqual(f.errors, []);
});

test('late readiness aligns once, and coarse frames never interrupt native playback', async t => {
  const f = fixture({ delayedCanplay: true }); t.after(() => f.dispose()); const audio = await f.start();
  await f.tick(2); assert.equal(audio.plays, 0); assert.equal(audio.seeks.length, 0);
  audio.emit('Canplay'); await flush();
  assert.deepEqual(audio.seeks, [2]); assert.equal(audio.actualTime, 2);
  for (const elapsed of [.25, .5, 1.05, .4, .6]) await f.tick(elapsed);
  assert.deepEqual(audio.seeks, [2]); assert.equal(audio.plays, 1);
  assert.ok(Math.abs(audio.actualTime - f.player.time) < 1e-6);
  audio.emit('Ended'); await f.tick(0);
  assert.equal(audio.plays, 1, 'natural EOF must not restart on a stale logical frame');
  f.player.restart(); await flush(); assert.equal(audio.actualTime, 0); assert.equal(audio.plays, 2);
});

test('an old ended event cannot cancel an explicit seek that is still pending', async t => {
  const f = fixture({ delayedSeek: true }); t.after(() => f.dispose()); const audio = await f.start();
  assert.equal(audio.plays, 1);
  f.player.seek(.25); await flush();
  audio.emit('Ended'); audio.pending.shift()(); await flush();
  assert.equal(audio.actualTime, .25); assert.equal(audio.paused, false);
  assert.equal(audio.plays, 2);
});
