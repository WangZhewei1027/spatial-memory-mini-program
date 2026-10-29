const buffered = require('./media-audio-buffered');

// Native media decoders consume the remote URL incrementally. WebAudio remains
// a compatibility path for old scenes outside InnerAudioContext's .5–2 range.
async function createAudioPlayback(url, settings, options) {
  const extension = url.split(/[?#]/)[0].split("/").pop().match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
  const legacyFormat = extension && !["mp3", "m4a", "aac", "wav"].includes(extension);
  if (settings.playbackRate < .5 || settings.playbackRate > 2 || options.forceBuffered || legacyFormat) {
    return buffered.createAudioPlayback(url, settings, options);
  }
  if (typeof wx.createInnerAudioContext !== 'function') throw new Error('此微信版本不支持演出音频，请升级微信后重试');
  const native = wx.createInnerAudioContext({ useWebAudioImplement: false });
  const { mediaContext, onError, isCancelled, onCancel = () => () => {} } = options;
  let disposed = false, ready = false, seeking = false, requestedPlay = false, desired = null;
  let seekTarget = 0, seekTimer = null, correctionAfter = 0;
  const listeners = [];
  function on(name, callback) { native[`on${name}`](callback); listeners.push([name, callback]); }
  function pause() { requestedPlay = false; native.pause(); }
  function apply(seekCompleted = false) {
    if (disposed || isCancelled() || !desired) return;
    native.volume = settings.muted ? 0 : desired.volume;
    if (!desired.playing && (requestedPlay || !native.paused)) pause();
    if (!ready || seeking) return;
    if (!seekCompleted && !(desired.playing && requestedPlay && Date.now() < correctionAfter) && Math.abs(native.currentTime - desired.time) > (desired.playing && requestedPlay ? .2 : .02)) {
      seeking = true; seekTarget = desired.time;
      seekTimer = setTimeout(() => { seeking = false; seekTimer = null; fail(new Error('音频定位超时')); }, 10000);
      native.seek(seekTarget); return;
    }
    if (desired.playing && !requestedPlay) { requestedPlay = true; native.play(); }
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
  native.startTime = settings.trimStartSeconds; native.playbackRate = settings.playbackRate;
  on('Canplay', () => { ready = true; apply(); });
  on('Seeked', () => { if (seekTimer) clearTimeout(seekTimer); seekTimer = null; seeking = false; correctionAfter = Date.now() + 500; apply(desired?.playing); });
  on('Ended', () => { requestedPlay = false; });
  on('Error', fail);
  native.src = url;
  return {
    get duration() { return native.duration > 0 && Number.isFinite(native.duration) ? native.duration : undefined; },
    get sourceTime() { return desired?.time || 0; },
    sync(time, playing, volume) { if (disposed) return; if (desired && (time < desired.time || Math.abs(time - desired.time) > .3)) correctionAfter = 0; desired = { time, playing, volume }; apply(); },
    dispose,
  };
}
module.exports = { createSceneMediaContext: buffered.createSceneMediaContext, createAudioPlayback };
