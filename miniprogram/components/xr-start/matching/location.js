const config = require('./config');

const LOCATE_TIMEOUT_MS = 12000;

function locate() {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('定位超时，请检查定位权限')), LOCATE_TIMEOUT_MS);
    wx.getLocation({
      type: 'wgs84',
      isHighAccuracy: true,
      highAccuracyExpireTime: 3000,
      success: (res) => { clearTimeout(timer); resolve({ ...res, sampledAt: Date.now() }); },
      fail: () => { clearTimeout(timer); reject(new Error('定位失败，请开启微信定位权限')); },
    });
  });
}

// Component mixin: GPS for recognition, preferring the continuous watch.
module.exports = {
  _watchedGPS() {
    const gps = this.currentGPS;
    if (!gps || !Number.isFinite(gps.sampledAt)) return null;
    if (Date.now() - gps.sampledAt > config.gpsWatchMaxAgeMs) return null;
    if (!Number.isFinite(gps.accuracy) || gps.accuracy < 0 || gps.accuracy > 100) return null;
    return { ...gps, source: 'watch' };
  },
  _locateForRecognition(epoch) {
    // 首选持续定位：随人移动不断更新，大范围移动后也是最新位置，且无需等待。
    const watched = this._watchedGPS();
    if (watched) return Promise.resolve(watched);
    // 兜底：持续定位不可用或太旧时，才做单次高精度定位。
    if (this._recognitionGPS && Date.now() - this._recognitionGPS.sampledAt < config.gpsCacheMs)
      return Promise.resolve({ ...this._recognitionGPS, source: 'cache' });
    if (this._recognitionGPSRequest?.epoch === epoch)
      return this._recognitionGPSRequest.promise.then((gps) => ({ ...gps, source: 'shared' }));
    const request = { epoch };
    request.promise = locate().then((gps) => {
      gps = { ...gps, source: 'fresh' };
      if (this._modeEpoch === epoch && !this._disposed && !this._retrievalPaused) this._recognitionGPS = gps;
      return gps;
    }).finally(() => {
      if (this._recognitionGPSRequest === request) this._recognitionGPSRequest = null;
    });
    this._recognitionGPSRequest = request;
    return request.promise;
  },
};
