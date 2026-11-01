const buffered = require('./media-audio-buffered');

// Native media decoders consume supported remote formats incrementally at 1x.
async function createAudioPlayback(url, settings, options) {
  const extension = url.split(/[?#]/)[0].split("/").pop().match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
  const legacyFormat = extension && !["mp3", "m4a", "aac", "wav"].includes(extension);
  if (options.forceBuffered || legacyFormat) {
    return buffered.createAudioPlayback(url, settings, options);
  }
  if (typeof wx.createInnerAudioContext !== 'function') throw new Error('此微信版本不支持演出音频，请升级微信后重试');
  const native = wx.createInnerAudioContext({ useWebAudioImplement: false });
  const { mediaContext, onError, isCancelled, onCancel = () => () => {} } = options;
  let disposed = false, ready = false, requestedPlay = false, desired = null;
  let intent = 0, alignedIntent = -1, endedIntent = -1, seekRequest = null, seekTimer = null;
  let positionedTime = settings.trimStartSeconds, positionKnown = true;
  const listeners = [];
  function on(name, callback) { native[`on${name}`](callback); listeners.push([name, callback]); }
  function pause() { requestedPlay = false; native.pause(); }
  function apply() {
    if (disposed || isCancelled() || !desired) return;
    native.volume = settings.muted ? 0 : desired.volume;
    if (!desired.playing && (requestedPlay || !native.paused)) pause();
    if (!ready || seekRequest) return;
    // Native currentTime can arrive in coarse steps. Continuous playback belongs
    // to the audio clock; only transport changes can request a new position.
    if (alignedIntent !== intent) {
      if (positionKnown && Math.abs(positionedTime - desired.time) < 1e-6) alignedIntent = intent;
      else {
        if (requestedPlay) pause();
        seekRequest = { intent, time: desired.time };
        seekTimer = setTimeout(() => { seekTimer = null; fail(new Error('音频定位超时')); }, 10000);
        try { native.seek(seekRequest.time); } catch (error) { fail(error); }
        return;
      }
    }
    if (desired.playing && !requestedPlay && endedIntent !== intent) {
      requestedPlay = true; positionKnown = false; native.play();
    }
  }
  function fail(error) {
    if (disposed || isCancelled()) return;
    dispose(); onError(new Error(`音频播放失败: ${error?.message || error?.errMsg || String(error)}`));
  }
  function dispose() {
    if (disposed) return;
    disposed = true; if (seekTimer) clearTimeout(seekTimer); seekTimer = null;
    unregister(); unregisterCancel(); for (const [name, callback] of listeners) native[`off${name}`]?.(callback);
    try { native.pause(); } catch (_) {}
    try { native.destroy(); } catch (_) {}
    desired = null;
  }
  const unregister = mediaContext.onDispose(dispose), unregisterCancel = onCancel(dispose);
  native.autoplay = false; native.loop = false; native.volume = 0;
  native.startTime = settings.trimStartSeconds;
  on('Canplay', () => { ready = true; apply(); });
  on('Seeked', () => {
    if (!seekRequest) return;
    if (seekTimer) clearTimeout(seekTimer); seekTimer = null;
    alignedIntent = seekRequest.intent; positionedTime = seekRequest.time; positionKnown = true; seekRequest = null;
    apply();
  });
  on('Ended', () => {
    // A stopped source may deliver its old EOF after a newer seek was requested.
    if (!requestedPlay || seekRequest) return;
    requestedPlay = false; endedIntent = intent; positionKnown = false;
  });
  on('Error', fail);
  native.src = url;
  return {
    get duration() { return native.duration > 0 && Number.isFinite(native.duration) ? native.duration : undefined; },
    get sourceTime() { return desired?.time || 0; },
    sync(time, playing, volume, { revision = 0, cycle = 0 } = {}) {
      if (disposed) return;
      if (!desired || revision !== desired.revision || cycle !== desired.cycle || playing !== desired.playing || (!playing && time !== desired.time)) intent++;
      desired = { time, playing, volume, revision, cycle }; apply();
    },
    dispose,
  };
}
module.exports = { createSceneMediaContext: buffered.createSceneMediaContext, createAudioPlayback };
