const { mediaOperation, releaseNative } = require("./media-operation");
// MediaAudioPlayer supports the MP4 audio track on iOS as well as Android.
// An audio-only decoder keeps its native PTS clock independent of image seeks.
async function createVideoSoundtrack(url, { onError, isCancelled, mediaContext, onCancel = () => () => {} }) {
  if (!wx.createMediaAudioPlayer) throw new Error('此微信版本不支持视频音轨，请升级微信后重试');
  const decoder = wx.createVideoDecoder(), player = wx.createMediaAudioPlayer();
  let disposed = false, desired = null;
  let operation = Promise.resolve(), busy = false, started = false;
  let intent = 0, appliedIntent = -1;
  const unregister = mediaContext.onDispose(dispose), unregisterCancel = onCancel(dispose);
  function nativeCall(target, method, ...args) {
    const native = Promise.resolve(target[method](...args));
    native.then(() => { if (disposed) { releaseNative(player, ["stop", "destroy"]); releaseNative(decoder, ["stop", "remove"]); } }, () => {});
    return mediaOperation(native, "视频音轨操作", 15000, onCancel);
  }
  function dispose() {
    if (disposed) return; disposed = true; unregister(); unregisterCancel(); player.volume = 0;
    // Release immediately even while a native start/seek is pending. nativeCall
    // repeats teardown if the SDK completes that old operation afterwards.
    releaseNative(player, ['stop', 'destroy']); releaseNative(decoder, ['stop', 'remove']);
  }

  function apply() {
    if (disposed || isCancelled() || busy || !desired) return;
    player.volume = desired.playing && started && appliedIntent === desired.intent ? desired.volume : 0;
    if (appliedIntent === desired.intent && desired.playing === started) return;
    const request = { ...desired }; busy = true;
    operation = operation.then(async () => {
      if (disposed || isCancelled()) return;
      if (started) { await nativeCall(player, "stop"); started = false; }
      if (disposed || isCancelled() || request.intent !== desired.intent) return;
      await nativeCall(decoder, "seek", request.time * 1000);
      // Ordinary frame time may advance while seeking; only a newer transport
      // intent invalidates this result. Never chase the moving scene clock.
      if (disposed || isCancelled() || request.intent !== desired.intent) return;
      if (request.playing) {
        player.volume = desired.volume; await nativeCall(player, "start");
        started = true;
        if (disposed || isCancelled() || request.intent !== desired.intent) {
          player.volume = 0; await nativeCall(player, "stop"); started = false; return;
        }
      }
      appliedIntent = request.intent;
    });
    operation.then(() => { busy = false; if (!disposed) apply(); }, error => {
      busy = false; if (disposed || isCancelled()) return; dispose(); onError(new Error(`视频音轨播放失败: ${error?.message || error?.errMsg || error}`));
    });
  }
  try {
    player.volume = 0;
    operation = nativeCall(decoder, "start", { source: url, mode: 0, abortVideo: true });
    await operation;
    if (disposed || isCancelled()) throw new Error('视频音轨加载已取消');
    operation = nativeCall(player, "addAudioSource", decoder); await operation;
    if (disposed || isCancelled()) throw new Error('视频音轨加载已取消');
    return { get sourceTime() { return desired?.time || 0; }, sync(time, playing, volume, transport = { revision: 0, cycle: 0 }) {
      if (disposed) return;
      const revision = transport.revision ?? 0, cycle = transport.cycle ?? 0;
      if (!desired || revision !== desired.revision || cycle !== desired.cycle || playing !== desired.playing || (!playing && time !== desired.time)) intent++;
      desired = { time, playing, volume, revision, cycle, intent };
      // Silence obsolete playback immediately, including while a native seek
      // or start promise is still pending.
      player.volume = playing && started && appliedIntent === intent ? volume : 0;
      apply();
    }, dispose };
  } catch (error) { dispose(); throw error; }
}
module.exports = { createVideoSoundtrack };
