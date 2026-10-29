const { mediaOperation, releaseNative } = require("./media-operation");
// MediaAudioPlayer supports the MP4 audio track on iOS as well as Android.
// An audio-only decoder keeps its native PTS clock independent of image seeks.
async function createVideoSoundtrack(url, { onError, isCancelled, mediaContext, onCancel = () => () => {} }) {
  if (!wx.createMediaAudioPlayer) throw new Error('此微信版本不支持视频音轨，请升级微信后重试');
  const decoder = wx.createVideoDecoder(), player = wx.createMediaAudioPlayer();
  let disposed = false, desired = { time: 0, playing: false, volume: 0 };
  let operation = Promise.resolve(), busy = false, started = false, anchorTime = 0, anchorWall = 0;
  let lastRequested = null, correctionAfter = 0;
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
    if (disposed || isCancelled() || busy) return;
    player.volume = desired.playing ? desired.volume : 0;
    const position = anchorTime + (started ? Math.max(0, Date.now() - anchorWall) / 1000 : 0);
    const jump = !lastRequested || ((!desired.playing || Date.now() >= correctionAfter) && Math.abs(position - desired.time) > .2);
    if (!jump && desired.playing === started) return;
    const request = { ...desired }; lastRequested = request; busy = true;
    operation = operation.then(async () => {
      if (disposed || isCancelled()) return;
      if (started) { await nativeCall(player, "stop"); started = false; }
      if (disposed || isCancelled()) return;
      await nativeCall(decoder, "seek", request.time * 1000);
      if (disposed || isCancelled()) return;
      anchorTime = request.time; anchorWall = Date.now();
      // A pause or scrub arriving during seek wins over this queued request.
      if (desired.playing) {
        player.volume = desired.volume; await nativeCall(player, "start");
        started = true; anchorWall = Date.now(); correctionAfter = anchorWall + 500;
        if (!desired.playing || disposed) { player.volume = 0; await nativeCall(player, "stop"); started = false; }
      }
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
    return { get sourceTime() { return desired.time; }, sync(time, playing, volume) {
      if (disposed) return; if (time < desired.time || Math.abs(time - desired.time) > .3) correctionAfter = 0; desired = { time, playing, volume }; player.volume = playing ? volume : 0; apply();
    }, dispose };
  } catch (error) { dispose(); throw error; }
}
module.exports = { createVideoSoundtrack };
