// Route AR sound as media rather than as a ringer-style effect.
//
// wx.setInnerAudioOption defaults to obeyMuteSwitch: true, so on iOS every
// InnerAudioContext goes silent when the ring/silent switch is on. The option
// is app-wide; it is applied once per runtime, right before the first sound is
// created, so opening the mini program without audible content leaves other
// apps' audio alone.
//
// speakerOn stays true (loudspeaker). The client then ignores mixWithOther and
// stops other audio anyway, so mixWithOther: false states the actual behaviour.
//
// The documented scope is InnerAudioContext. The docs say the option does not
// apply to WebAudioContext and are silent about VideoDecoder +
// MediaAudioPlayer; those paths still call this first, but only a device test
// shows whether they follow the switch.
const MEDIA_AUDIO_OPTION = Object.freeze({ obeyMuteSwitch: false, mixWithOther: false, speakerOn: true });
const SETTLE_TIMEOUT_MS = 1000;
// Keyed by the wx object so each test runtime starts unconfigured.
const requests = new WeakMap();

// Resolves true once applied and never rejects: a sound must still play when
// the option is unavailable. A failed request is retried before the next
// sound; an API that never answers is not, so it cannot delay every playback.
function ensureMediaAudioOutput() {
  if (typeof wx === "undefined" || typeof wx.setInnerAudioOption !== "function") return Promise.resolve(false);
  const runtime = wx;
  const pending = requests.get(runtime);
  if (pending) return pending;
  let resolve, settled = false;
  const request = new Promise((done) => { resolve = done; });
  requests.set(runtime, request);
  const finish = (applied, error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (!applied) {
      if (error) requests.delete(runtime);
      console.warn("[audio] 未能切换到媒体音频通道，iOS 静音模式下可能无声", error || "设置超时");
    }
    resolve(applied);
  };
  const timer = setTimeout(() => finish(false), SETTLE_TIMEOUT_MS);
  try {
    runtime.setInnerAudioOption({
      ...MEDIA_AUDIO_OPTION,
      success: () => finish(true),
      fail: (error) => finish(false, error || new Error("setInnerAudioOption 失败")),
    });
  } catch (error) {
    finish(false, error);
  }
  return request;
}

module.exports = { ensureMediaAudioOutput, MEDIA_AUDIO_OPTION, SETTLE_TIMEOUT_MS };
