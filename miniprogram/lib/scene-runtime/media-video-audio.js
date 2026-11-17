const { mediaOperation, releaseNative } = require("./media-operation");
const { ensureMediaAudioOutput } = require("../three-runtime/audio-output");
// MediaAudioPlayer supports the MP4 audio track on iOS as well as Android.
// An audio-only decoder keeps its native PTS clock independent of image seeks.
//
// Reusing a decoder that already delivered its last packet can leave a later
// stop/seek/start promise pending forever on device, which surfaced at loop
// boundaries. A decoder/player pair is therefore replaced rather than reused
// after EOF, and once more after any failed transport step. Only repeated
// failures are reported to the owner.
const LOAD_TIMEOUT_MS = 15000, STEP_TIMEOUT_MS = 6000, MAX_RECOVERIES = 2;

function errorText(error) { return error?.message || error?.errMsg || String(error); }

async function createVideoSoundtrack(url, { onError, onDiagnostic = () => {}, isCancelled, mediaContext, onCancel = () => () => {}, stepTimeoutMs = STEP_TIMEOUT_MS }) {
  if (!wx.createMediaAudioPlayer) throw new Error('此微信版本不支持视频音轨，请升级微信后重试');
  await ensureMediaAudioOutput();
  if (isCancelled()) throw new Error('视频音轨加载已取消');
  let disposed = false, desired = null, pipeline = null;
  let operation = Promise.resolve(), busy = false;
  let intent = 0, appliedIntent = -1, recoveries = 0;
  const unregister = mediaContext.onDispose(dispose), unregisterCancel = onCancel(dispose);

  function releasePipeline(owner) {
    releaseNative(owner.player, ['stop', 'destroy']); releaseNative(owner.decoder, ['stop', 'remove']);
  }
  function closePipeline(owner) {
    if (!owner || owner.closed) return;
    owner.closed = true; owner.player.volume = 0;
    // Release immediately even while a native start/seek is pending. nativeCall
    // repeats teardown if the SDK completes that old operation afterwards.
    releasePipeline(owner);
    if (pipeline === owner) pipeline = null;
  }
  function nativeCall(owner, target, method, label, timeoutMs, ...args) {
    let native;
    try { native = Promise.resolve(target[method](...args)); } catch (error) { native = Promise.reject(error); }
    native.then(() => { if (owner.closed) releasePipeline(owner); }, () => {});
    return mediaOperation(native, `视频音轨${label}`, timeoutMs, onCancel);
  }
  async function openPipeline(timeoutMs) {
    const owner = { decoder: wx.createVideoDecoder(), player: wx.createMediaAudioPlayer(), closed: false, started: false, ended: false };
    pipeline = owner; owner.player.volume = 0;
    try { owner.decoder.on?.('ended', () => { owner.ended = true; }); } catch (_) {}
    await nativeCall(owner, owner.decoder, 'start', '加载', timeoutMs, { source: url, mode: 0, abortVideo: true });
    if (disposed || isCancelled() || owner.closed) throw new Error('视频音轨加载已取消');
    await nativeCall(owner, owner.player, 'addAudioSource', '连接', timeoutMs, owner.decoder);
    if (disposed || isCancelled() || owner.closed) throw new Error('视频音轨加载已取消');
    return owner;
  }
  function dispose() {
    if (disposed) return; disposed = true; unregister(); unregisterCancel();
    closePipeline(pipeline);
  }

  const stale = request => disposed || isCancelled() || request.intent !== desired.intent;
  async function transport(request) {
    let owner = pipeline;
    if (!owner || owner.ended) {
      closePipeline(owner);
      owner = await openPipeline(stepTimeoutMs);
      if (stale(request)) return;
    }
    if (owner.started) { await nativeCall(owner, owner.player, 'stop', '停止', stepTimeoutMs); owner.started = false; }
    if (stale(request)) return;
    await nativeCall(owner, owner.decoder, 'seek', '定位', stepTimeoutMs, request.time * 1000);
    // Ordinary frame time may advance while seeking; only a newer transport
    // intent invalidates this result. Never chase the moving scene clock.
    if (stale(request)) return;
    if (request.playing) {
      owner.player.volume = desired.volume; await nativeCall(owner, owner.player, 'start', '播放', stepTimeoutMs);
      owner.started = true;
      if (stale(request)) {
        owner.player.volume = 0; await nativeCall(owner, owner.player, 'stop', '停止', stepTimeoutMs); owner.started = false; return;
      }
    }
    appliedIntent = request.intent; recoveries = 0;
  }
  function recover(request, error) {
    const failed = pipeline;
    if (recoveries >= MAX_RECOVERIES) {
      dispose(); onError(new Error(`视频音轨播放失败: ${errorText(error)}`)); return;
    }
    recoveries++;
    try {
      onDiagnostic({ event: 'soundtrack_recover', message: errorText(error), attempt: recoveries,
        ended: !!failed?.ended, time: request.time, playing: request.playing });
    } catch (_) {}
    // The failed native pair may never settle; abandon it and rebuild.
    closePipeline(failed); appliedIntent = -1;
    apply();
  }
  function apply() {
    if (disposed || isCancelled() || busy || !desired) return;
    const owner = pipeline;
    if (owner) owner.player.volume = desired.playing && owner.started && appliedIntent === desired.intent ? desired.volume : 0;
    if (owner && appliedIntent === desired.intent && desired.playing === owner.started) return;
    const request = { ...desired }; busy = true;
    operation = transport(request);
    operation.then(() => { busy = false; if (!disposed) apply(); }, error => {
      busy = false; if (disposed || isCancelled()) return; recover(request, error);
    });
  }
  try {
    operation = openPipeline(LOAD_TIMEOUT_MS); await operation;
    return { get sourceTime() { return desired?.time || 0; }, sync(time, playing, volume, transport = { revision: 0, cycle: 0 }) {
      if (disposed) return;
      const revision = transport.revision ?? 0, cycle = transport.cycle ?? 0;
      if (!desired || revision !== desired.revision || cycle !== desired.cycle || playing !== desired.playing || (!playing && time !== desired.time)) intent++;
      desired = { time, playing, volume, revision, cycle, intent };
      // Silence obsolete playback immediately, including while a native seek
      // or start promise is still pending.
      if (pipeline) pipeline.player.volume = playing && pipeline.started && appliedIntent === intent ? volume : 0;
      apply();
    }, dispose };
  } catch (error) { dispose(); throw error; }
}
module.exports = { createVideoSoundtrack, STEP_TIMEOUT_MS };
