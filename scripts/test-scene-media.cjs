const assert = require('node:assert/strict');
const { createSceneSurface, createSceneMediaContext } = require('../miniprogram/lib/scene-runtime/media');
const { inspectMoov, inspectRemoteMp4 } = require('../miniprogram/lib/scene-runtime/media-mp4');
const flush = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`);
function box(kind, ...data) { const payload = Buffer.concat(data); const b = Buffer.alloc(8 + payload.length); b.writeUInt32BE(b.length); b.write(kind, 4); payload.copy(b, 8); return b; }
function mp4(sound = true, tail = false) {
  const mvhd = Buffer.alloc(20); mvhd.writeUInt32BE(1000, 12); mvhd.writeUInt32BE(20000, 16);
  const hdlr = Buffer.alloc(12); hdlr.write(sound ? 'soun' : 'vide', 8);
  const moov = box('moov', box('mvhd', mvhd), box('trak', box('mdia', box('hdlr', hdlr))));
  const ftyp = box('ftyp', Buffer.alloc(8)), mdat = box('mdat', Buffer.alloc(100));
  return Buffer.concat(tail ? [ftyp, mdat, moov] : [ftyp, moov, mdat]);
}
function platform({ sound = true, tail = false, delayedSeek = false, delayedRange = false, legacy = false, delayedStart = false } = {}) {
  const bytes = mp4(sound, tail), state = { ranges: [], audio: [], decoders: [], players: [], downloads: 0, aborts: 0 };
  global.wx = {
    request({ header, success }) { const [, start, end] = /bytes=(\d+)-(\d+)/.exec(header.Range); state.ranges.push([+start, +end]); if (!delayedRange) queueMicrotask(() => {
      const b = bytes.subarray(+start, +end + 1); success({ statusCode: legacy ? 200 : 206, data: b.buffer.slice(b.byteOffset, b.byteOffset + b.length) });
    }); return { abort() { state.aborts++; } }; },
    downloadFile({ success }) { state.downloads++; if (legacy) { queueMicrotask(() => success({ statusCode: 200, tempFilePath: '/tmp/legacy.webm' })); return { abort() {} }; } throw new Error('streaming must not download the whole file'); },
    getVideoInfo({ success }) { success({ width: 8, height: 4, duration: 20, fps: 30 }); },
    createMediaContainer() { return { extractDataSource({ success }) { success({ tracks: [] }); }, destroy() {} }; },
    getFileSystemManager() { return { unlink() {} }; },
    createInnerAudioContext(options) {
      const events = new Map();
      const audio = { options, currentTime: 0, duration: 20, paused: true, plays: 0, destroys: 0, seeks: [], volume: 0,
        emit(name, value) { events.get(name)?.(value); },
        set src(value) { this.url = value; this.currentTime = this.startTime; queueMicrotask(() => this.emit('Canplay')); },
        play() { this.plays++; this.paused = false; }, pause() { this.paused = true; }, destroy() { this.destroys++; },
        seek(time) { this.seeks.push(time); if (!delayedSeek) { this.currentTime = time; queueMicrotask(() => this.emit('Seeked')); } },
      };
      for (const name of ['Canplay', 'Seeked', 'Ended', 'Error']) { audio[`on${name}`] = cb => events.set(name, cb); audio[`off${name}`] = () => events.delete(name); }
      state.audio.push(audio); return audio;
    },
    createVideoDecoder() {
      const decoder = { seeks: [], removed: 0, stopped: 0, pending: null,
        start(args) { this.args = args; if (delayedStart) return new Promise(resolve => { this.completeStart = () => resolve({ width: 8, height: 4 }); }); return Promise.resolve({ width: 8, height: 4 }); },
        seek(ms) { this.seeks.push(ms); this.pending = { width: 2, height: 1, data: new Uint8Array(8).fill(Math.round(ms / 1000)).buffer }; return Promise.resolve(); },
        getFrameData() { const frame = this.pending; this.pending = null; return frame; }, stop() { this.stopped++; return Promise.resolve(); }, remove() { this.removed++; return Promise.resolve(); },
      }; state.decoders.push(decoder); return decoder;
    },
    createMediaAudioPlayer() {
      const player = { volume: 0, starts: 0, stops: 0, destroyed: 0, addAudioSource(decoder) { this.decoder = decoder; return Promise.resolve(); },
        removeAudioSource() { return Promise.resolve(); }, start() { this.starts++; return Promise.resolve(); }, stop() { this.stops++; return Promise.resolve(); }, destroy() { this.destroyed++; return Promise.resolve(); } };
      state.players.push(player); return player;
    },
    createOffscreenCanvas({ width, height }) {
      const canvas = { width, height }; const context = { measureText: text => ({ width: text.length * 50 }), scale() {}, fillRect() {}, fillText() {}, getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }) }; canvas.getContext = () => context; return canvas;
    },
  }; return state;
}
const settings = { trimStartSeconds: 2, trimEndSeconds: 10, playbackRate: 1, volume: .8, muted: false, loop: false };
const instance = overrides => ({ id: 'cue', asset: 'asset', timing: { startSeconds: 2, endSeconds: 12, fadeInSeconds: 2, fadeOutSeconds: 2 }, media: settings, ...overrides });
const resource = kind => ({ kind, url: `https://assets.example/${kind}.${kind === 'video' ? 'mp4' : 'mp3'}` });
async function main() {
  for (const tail of [false, true]) {
    const state = platform({ tail }); const info = await inspectRemoteMp4(resource('video').url);
    assert.deepEqual(info, { duration: 20, hasAudio: true }); assert.equal(state.downloads, 0);
    assert.ok(state.ranges.reduce((sum, [a, b]) => sum + b - a + 1, 0) < 200, 'only headers and moov are fetched');
  }
  assert.throws(() => inspectMoov(Uint8Array.from([0,0,0,2,109,111,111,118]).buffer), /无效/);
  {
    const state = platform(), owner = createSceneMediaContext();
    const a = await createSceneSurface(instance(), resource('audio'), { mediaContext: owner });
    assert.equal(state.audio.length, 0, 'surface construction does not start network or allocate decoders');
    a.sync(0, true, 20, false); await flush(); assert.equal(state.audio.length, 0);
    a.sync(1, true, 20, true); await flush(); const native = state.audio[0];
    assert.deepEqual(native.options, { useWebAudioImplement: false }); assert.equal(native.url, resource('audio').url);
    assert.equal(native.plays, 0, 'preloading is silent');
    a.sync(3, true, 20, true); await flush(); near(a.audio.sourceTime, 3); near(native.volume, .4); assert.equal(native.paused, false);
    native.currentTime = 3.1; a.sync(3.1, true, 20, true); assert.equal(native.seeks.length, 1, 'continuous playback does not keep seeking');
    a.sync(7, false, 20, true); await flush(); near(native.currentTime, 7); assert.equal(native.paused, true);
    a.sync(11, true, 20, true); await flush(); near(native.volume, .4); assert.equal(native.paused, true, 'trimmed EOF stays silent');
    a.sync(15, true, 20, false); assert.equal(native.destroys, 1); assert.equal(a.audio, null);
    a.sync(3, true, 20, true); await flush(); assert.equal(state.audio.length, 2, 'scrubbing back creates a fresh source');
    owner.dispose(); assert.equal(state.audio[1].destroys, 1); a.dispose(); assert.equal(state.downloads, 0);
  }
  {
    const state = platform({ delayedSeek: true }); const a = await createSceneSurface(instance(), resource('audio'));
    a.sync(3, true, 20); await flush(); const native = state.audio[0];
    a.sync(7, false, 20); native.currentTime = 3; native.emit('Seeked'); await flush();
    assert.deepEqual(native.seeks, [3, 7]); native.currentTime = 7; native.emit('Seeked');
    assert.equal(native.plays, 0, 'late seek cannot undo a pause'); a.dispose(); native.emit('Canplay'); assert.equal(native.destroys, 1);
  }
  for (const kind of ['audio', 'video']) {
    const state = platform();
    const key = (time, value) => ({ time, value, handles: [0, 0, 1, 1], connectedRight: true });
    const a = await createSceneSurface(instance({ opacity: 0, tracks: { volume: [key(2, .2), key(4, .8)] } }), resource(kind));
    a.sync(3, true, 20, true, { gain: .5, pan: 1 }); await flush();
    const native = kind === 'audio' ? state.audio[0] : state.players[0];
    near(native.volume, .125, 'volume automation × cue fade × distance');
    assert.ok(kind === 'audio' ? native.plays > 0 : native.starts > 0, 'zero visual opacity does not mute the soundtrack');
    a.sync(3, true, 20, true, { gain: .25, pan: -1 }); await flush(); near(native.volume, .0625);
    assert.equal(state.downloads, 0, 'spatial gain preserves streaming');
    a.sync(3, false, 20, true, { gain: .25, pan: -1 }); await flush();
    assert.ok(kind === 'audio' ? native.paused : native.volume === 0, 'pause remains silent after spatial updates');
    a.dispose();
  }
  {
    const state = platform(); const a = await createSceneSurface(instance({ media: { ...settings, loop: true, playbackRate: 2 } }), resource('audio'));
    a.sync(7, true, 20); await flush(); near(a.audio.sourceTime, 4); near(state.audio[0].playbackRate, 2); a.dispose();
  }
  {
    const state = platform({ delayedSeek: true }); const a = await createSceneSurface(instance(), resource('audio'));
    a.sync(3, true, 20); await flush(); const native = state.audio[0];
    a.sync(4, true, 20); native.currentTime = 3; native.emit('Seeked'); await flush();
    assert.equal(native.plays, 1, 'slow seek starts playback even when timeline advanced >200ms');
    assert.equal(native.seeks.length, 1, 'initial seek does not chase a moving timeline forever'); a.dispose();
  }
  {
    const state = platform({ delayedRange: true }); const a = await createSceneSurface(instance(), resource('video'));
    a.sync(3, true, 20); await flush(); assert.equal(state.ranges.length, 1);
    a.sync(15, true, 20, false); await flush(); assert.equal(state.aborts, 1, 'leaving window aborts pending metadata immediately');
    assert.equal(state.decoders.length, 0); a.dispose();
  }
  {
    const state = platform({ delayedStart: true }); const a = await createSceneSurface(instance(), resource('video'));
    a.sync(3, true, 20); await flush(); const native = state.decoders[0]; assert.ok(native.completeStart);
    a.sync(15, true, 20, false); assert.equal(native.removed, 1, 'window release removes decoder even if native start is pending');
    native.completeStart(); await flush(); assert.ok(native.removed >= 1); assert.equal(state.players.length, 0); a.dispose();
  }
  {
    const state = platform({ legacy: true }); const a = await createSceneSurface(instance(), resource('video'));
    a.sync(3, true, 20); await flush(); assert.equal(state.downloads, 1, 'legacy non-Range container retains compatibility download');
    assert.equal(state.decoders[0].args.source, '/tmp/legacy.webm'); a.dispose(); await flush();
  }
  {
    const state = platform(); const a = await createSceneSurface(instance(), resource('video'));
    a.sync(1, false, 20); await flush();
    let resolveSeek; const decoder = state.decoders[1];
    decoder.seek = ms => { decoder.seeks.push(ms); return new Promise(resolve => { resolveSeek = resolve; }); };
    a.sync(3, true, 20); await flush(); a.sync(4, true, 20); resolveSeek(); await flush();
    assert.equal(state.players[0].starts, 1, 'slow soundtrack seek must start rather than chase current timeline');
    a.sync(4, false, 20); await flush(); resolveSeek(); await flush(); a.dispose(); await flush();
  }
  for (const sound of [true, false]) {
    const state = platform({ sound }), owner = createSceneMediaContext();
    const a = await createSceneSurface(instance(), resource('video'), { mediaContext: owner });
    assert.equal(state.decoders.length, 0);
    a.sync(3, true, 20); await flush();
    assert.equal(state.decoders[0].args.source, resource('video').url); assert.equal(state.downloads, 0);
    near(a.video.sourceTime, 3); assert.ok(a.materials[0].map);
    if (sound) {
      assert.deepEqual(state.decoders[1].args, { source: resource('video').url, mode: 0, abortVideo: true });
      near(state.players[0].volume, .4); assert.equal(state.players[0].starts, 1);
      a.sync(7, false, 20); await flush(); near(state.players[0].volume, 0); near(a.audio.sourceTime, 7);
      a.sync(8, true, 20); await flush(); assert.equal(state.players[0].starts, 2);
    } else assert.equal(state.players.length, 0, 'silent MP4 allocates no soundtrack');
    owner.dispose(); await flush(); assert.ok(state.decoders.every(d => d.removed === 1));
    assert.ok(state.players.every(p => p.destroyed === 1)); a.dispose();
  }
  {
    const state = platform(), owner = createSceneMediaContext();
    const a = await createSceneSurface(instance(), resource('video'), { mediaContext: owner }); a.sync(3, true, 20); owner.dispose(); await flush();
    assert.ok(state.decoders.every(d => d.removed === 1)); assert.equal(state.players.length, 0, 'cancelled preload cannot start sound');
  }
  {
    const state = platform(); const a = await createSceneSurface({ id: 'text', text: { content: 'AB\nCD', fontSize: 1, width: 2, align: 'left', color: '#ffffff' } });
    assert.equal(state.audio.length, 0); assert.equal(a.materials[0].depthWrite, false); a.dispose();
  }
  console.log('scene media: incremental MP4 metadata, streaming, silent lookahead, volume keyframes/spatial gain independent of opacity, trim/rate/fades/seek, cancellation and teardown passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
