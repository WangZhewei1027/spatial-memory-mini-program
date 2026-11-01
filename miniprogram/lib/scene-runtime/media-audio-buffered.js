const { readBytes } = require("../three-runtime/resources");

function failure(error, label) {
  return new Error(`${label}: ${error?.message || error?.errMsg || String(error)}`);
}
function ignore(promise) { if (promise?.catch) promise.catch(() => {}); }

// A performance shares one hardware context; text/image-only scenes create none.
function createSceneMediaContext() {
  let context = null, disposed = false;
  const buffers = new Map(), cleanups = new Set(), pendingDecodes = new Set();
  return {
    get disposed() { return disposed; },
    onDispose(cleanup) { cleanups.add(cleanup); return () => cleanups.delete(cleanup); },
    getAudioContext() {
      if (disposed) throw new Error("演出音频上下文已释放");
      if (!context) {
        if (typeof wx.createWebAudioContext !== "function") throw new Error("此微信版本不支持演出音频，请升级微信后重试");
        context = wx.createWebAudioContext();
      }
      return context;
    },
    decode(url) {
      if (!buffers.has(url)) buffers.set(url, (async () => {
        const audio = this.getAudioContext(), bytes = await readBytes(url);
        if (disposed) throw new Error("演出音频加载已取消");
        const buffer = await new Promise((resolve, reject) => {
          const cancel = error => finish(reject, error);
          const timer = setTimeout(() => cancel(new Error("音频解码超时")), 15000);
          function finish(callback, value) { clearTimeout(timer); pendingDecodes.delete(cancel); callback(value); }
          pendingDecodes.add(cancel);
          try {
            const result = audio.decodeAudioData(bytes, value => finish(resolve, value), cancel);
            if (result?.then) result.then(value => finish(resolve, value), cancel);
          } catch (error) { cancel(error); }
        });
        if (disposed) throw new Error("演出音频加载已取消");
        if (!(buffer?.duration > 0)) throw new Error("音频没有可播放的数据");
        return buffer;
      })().catch(error => { buffers.delete(url); throw failure(error, "音频解码失败"); }));
      return buffers.get(url);
    },
    dispose() {
      if (disposed) return;
      disposed = true; buffers.clear();
      for (const cleanup of cleanups) { try { cleanup(); } catch (_) {} }
      cleanups.clear();
      for (const cancel of pendingDecodes) cancel(new Error("演出音频加载已取消"));
      pendingDecodes.clear();
      if (context) { try { ignore(context.close()); } catch (_) {} context = null; }
    },
  };
}

async function createAudioPlayback(url, settings, { mediaContext, onError, isCancelled }) {
  const context = mediaContext.getAudioContext();
  const original = await mediaContext.decode(url);
  if (isCancelled()) throw new Error("演出音频加载已取消");
  let buffer = original;
  const gain = context.createGain(); gain.gain.value = 0; gain.connect(context.destination);
  let disposed = false, source = null, generation = 0, pending = false;
  const unregister = mediaContext.onDispose(dispose);
  let desired = null, intent = 0, endedIntent = -1;
  const start = Math.min(original.duration, settings.trimStartSeconds);
  const end = Math.max(start, Math.min(original.duration, settings.trimEndSeconds === null ? Infinity : settings.trimEndSeconds));
  function stop() {
    generation++; pending = false;
    if (!source) return;
    const previous = source; source = null; previous.onended = null;
    try { previous.stop(); } catch (_) {}
    try { previous.disconnect(); } catch (_) {}
  }
  function begin() {
    if (disposed || !desired?.playing || pending || source || endedIntent === intent || end <= start) return;
    const request = ++generation;
    function launch() {
      if (disposed || isCancelled() || request !== generation || !desired?.playing) return;
      pending = false;
      try {
        const node = context.createBufferSource();
        source = node;
        node.buffer = buffer;
        node.loop = settings.loop; node.loopStart = start; node.loopEnd = end;
        const offset = desired.time, startedAt = context.currentTime, sourceIntent = intent;
        node.connect(gain);
        node.onended = () => {
          if (source !== node) return;
          source = null; endedIntent = sourceIntent;
          try { node.disconnect(); } catch (_) {}
        };
        // Explicit stop uses the audio clock (start's duration semantics differ across SDKs).
        node.start(0, offset);
        if (!settings.loop) node.stop(startedAt + Math.max(0, end - offset));
      } catch (error) { dispose(); onError(failure(error, "音频播放失败")); }
    }
    if (context.state === "suspended") {
      pending = true;
      Promise.resolve(context.resume()).then(launch, error => {
        if (disposed || request !== generation) return;
        pending = false; onError(failure(error, "音频恢复失败"));
      });
    } else launch();
  }
  function dispose() {
    if (disposed) return;
    disposed = true; stop(); gain.gain.value = 0; unregister();
    try { gain.disconnect(); } catch (_) {}
    buffer = null; desired = null;
  }
  return {
    duration: original.duration,
    get sourceTime() { return desired?.time || 0; },
    sync(time, playing, volume, transport = { revision: 0, cycle: 0 }) {
      if (disposed) return;
      playing = playing && end > start && (settings.loop || time < end);
      const revision = transport.revision ?? 0;
      // Native loopStart/loopEnd already handle local cycles. Only transport
      // commands and playback edges may replace a running buffer source.
      if (!desired || revision !== desired.revision || playing !== desired.playing || (!playing && time !== desired.time)) {
        intent++; endedIntent = -1; stop();
      }
      desired = { time, playing, revision };
      gain.gain.value = settings.muted || !playing ? 0 : volume;
      begin();
    },
    dispose,
  };
}

module.exports = { createSceneMediaContext, createAudioPlayback };
