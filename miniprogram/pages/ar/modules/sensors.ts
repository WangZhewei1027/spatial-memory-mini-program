import type { ArPageContext } from "./context";
import type { createUiRegistry } from "../../../utils/ar-ui/registry";
interface LocationData {
  latitude: number;
  longitude: number;
  altitude: number;
  latStr: string;
  lngStr: string;
  accuracyStr: string;
  altitudeStr: string;
}
export const sensorData = { location: null as LocationData | null, compassHeading: 0, compassDebugHeading: null as number | null };
export const sensorMethods = {
  startSensors() {
    this.getLocation();
    // 持续定位：使用 startLocationUpdate + onLocationChange，被动接收 GPS 更新，
    // 比 setInterval(getLocation, 5000) 更省电、回调更新更平滑（不会与 XR 渲染帧争用主线程）
    if (wx.startLocationUpdate) {
      wx.startLocationUpdate({
        success: () => {
          // 页面已卸载时，onUnload 的 stopLocationUpdate 早于本回调，需补停并跳过注册。
          if ((this as any)._unloaded) {
            wx.stopLocationUpdate?.();
            return;
          }
          (this as any)._locationListener = (
            res: WechatMiniprogram.OnLocationChangeCallbackResult,
          ) => {
            if ((this as any)._unloaded) return;
            this.setData({
              location: this._buildLocation(res),
            });
            this.refreshCanSubmit();
            this.syncUI();
          };
          wx.onLocationChange((this as any)._locationListener);
        },
        // 失败时退化为低频轮询（10s 一次，足够标记位置使用，且不阻塞渲染）
        fail: () => {
          if ((this as any)._unloaded) return;
          (this as any)._locationTimer = setInterval(
            () => this.getLocation(),
            10000,
          );
        },
      });
    } else {
      (this as any)._locationTimer = setInterval(
        () => this.getLocation(),
        10000,
      );
    }
    this._startCompassWatch();
  },
  stopSensors() {
    if ((this as any)._locationTimer) {
      clearInterval((this as any)._locationTimer);
      (this as any)._locationTimer = null;
    }
    if ((this as any)._locationListener && wx.offLocationChange) {
      try {
        wx.offLocationChange((this as any)._locationListener);
      } catch (_) {}
      (this as any)._locationListener = null;
    }
    if (wx.stopLocationUpdate) {
      try {
        wx.stopLocationUpdate();
      } catch (_) {}
    }
    this._stopCompassWatch();
  },
  /** 把 wx.getLocation / onLocationChange 的结果统一成页面用的 LocationData */
  _buildLocation(res: {
    latitude: number;
    longitude: number;
    accuracy?: number;
    altitude?: number;
  }): LocationData {
    const accuracy = res.accuracy;
    const altitude = res.altitude;
    return {
      latitude: res.latitude,
      longitude: res.longitude,
      altitude: altitude ?? 0,
      latStr: res.latitude.toFixed(6),
      lngStr: res.longitude.toFixed(6),
      accuracyStr:
        typeof accuracy === "number" ? `±${accuracy.toFixed(1)}m` : "--",
      altitudeStr:
        typeof altitude === "number" ? `${altitude.toFixed(1)}m` : "--",
    };
  },

  getLocation() {
    wx.getLocation({
      type: "wgs84",
      success: (res) => {
        if ((this as any)._unloaded) return;
        this.setData({
          location: this._buildLocation(res),
        });
        this.refreshCanSubmit();
        this.syncUI();
      },
      fail: () => {
        if ((this as any)._unloaded) return;
        this.setData({ location: null, canSubmit: false });
        this.syncUI();
      },
    });
  },
  _startCompassWatch() {
    wx.startCompass({
      success: () => {
        // 页面可能在异步回调前已卸载，此时不再注册监听。
        if ((this as any)._unloaded) {
          wx.stopCompass({});
          return;
        }
        // 罗盘传感器 10-60Hz，每 tick setData+selectComponent 会与 XR 渲染争用主线程。
        // 节流：变化 <2° 或距上次 <200ms 时跳过；组件引用只解析一次。
        let lastHeading: number | null = null;
        let lastTime = 0;
        let xrComp: any = null;
        // 保存监听引用，卸载时注销；否则重复进入 AR 页会累积指向旧页面的回调。
        (this as any)._compassListener = (res: any) => {
          if ((this as any)._unloaded) return;
          const heading: number = res.direction ?? res.heading ?? 0;
          const now = Date.now();
          const delta = lastHeading === null ? Infinity : Math.abs(((heading - lastHeading + 540) % 360) - 180);
          // Always accept the first sample; wrapping an Infinity sentinel would reject it forever.
          if (lastHeading !== null && (delta < 2 || now - lastTime < 200)) return;
          lastHeading = heading;
          lastTime = now;
          this.setData({ compassHeading: heading });
          if (now - ((this as any)._lastCompassDebugAt || 0) >= 1000) {
            (this as any)._lastCompassDebugAt = now;
            this.setData({ compassDebugHeading: Math.round(heading) });
            this.syncUI();
          }
          if (!xrComp) xrComp = this.selectComponent("#main-frame");
          if (xrComp) xrComp.updateCompassHeading(heading);
        };
        wx.onCompassChange((this as any)._compassListener);
      },
    });
  },

  _stopCompassWatch() {
    if ((this as any)._compassListener && wx.offCompassChange) {
      try {
        wx.offCompassChange((this as any)._compassListener);
      } catch (_) {}
      (this as any)._compassListener = null;
    }
    wx.stopCompass({});
  },
} satisfies ThisType<ArPageContext>;
export function registerSensors(page: ArPageContext, registry: ReturnType<typeof createUiRegistry>) {
  const module = registry.register({ id: "sensors", slot: "top", order: 10 });
  return { sync() {
    module.update({ enabled: true });
    const { location, compassDebugHeading } = page.data;
    module.publishDebug([
      { key: "gps", label: "GPS", value: location ? location.accuracyStr || "已定位" : "等待定位", level: location ? "info" : "warning", order: 10 },
      { key: "heading", label: "朝向", value: compassDebugHeading === null ? "等待罗盘" : `${compassDebugHeading}°`, order: 20 },
      ...(location ? [{ key: "coordinates", label: "经纬", value: `${location.lngStr}, ${location.latStr}`, order: 70 },
        { key: "altitude", label: "海拔", value: location.altitudeStr, order: 80 }] : []),
    ]);
  } };
}
