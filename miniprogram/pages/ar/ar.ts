import { CONFIG } from "../../utils/backend";
import { activityData, activityMethods } from "./modules/activities";
import { recognitionData, recognitionMethods } from "./modules/recognition";
import { runtimeData, runtimeMethods } from "./modules/runtime";
import { sensorData, sensorMethods } from "./modules/sensors";
import { uiData, uiMethods } from "./modules/ui";
import { shopData } from "./modules/shop";

Page({
  data: { width: 300, height: 300, renderWidth: 300, renderHeight: 300,
    ...activityData, ...recognitionData, ...runtimeData, ...sensorData, ...uiData, ...shopData },
  ...activityMethods, ...recognitionMethods, ...runtimeMethods, ...sensorMethods, ...uiMethods,
  onHide() {
    (this as any)._pageVisible = false;
    this.clearRecognitionHint();
    this.setData({ keyboardHeight: 0 });
    (this as any)._activityVisible = false;
    (this as any)._activityRequest = ((this as any)._activityRequest || 0) + 1;
    this.selectComponent("#main-frame")?.pauseRetrieval();
  },

  onShow() {
    (this as any)._pageVisible = true;
    this.syncUI();
    (this as any)._activityVisible = true;
    void this.refreshActivities();
    this.selectComponent("#main-frame")?.resumeRetrieval();
  },
  onLoad(_options: Record<string, string | undefined>) {
    // CONFIG 已由 index.ts 的 setConfig 设置（扫码 → Storage → 模块初始化）；
    // ar.ts 始终由 goToAR() 跳转进入，不应在此持久化 URL 参数，
    // 否则微信「最近使用」场景下的过期 URL 会覆盖更新的 Storage 扫码结果。
    if (!CONFIG.organizationId || !CONFIG.workspaceId) {
      wx.redirectTo({ url: "/pages/index/index?select=1" });
      return;
    }
    const {
      windowWidth: width,
      windowHeight: height,
      pixelRatio: dpi,
    } = wx.getSystemInfoSync();
    // 渲染分辨率降采样：GPU 像素量随系数平方下降（0.5 → 75% 省），
    // AR 相机背景本身有噪点，观感几乎无损；卡顿/发热时可再降，画质不满时上调。
    const RENDER_SCALE = 0.5;
    this.setData({
      width,
      height,
      renderWidth: Math.round(width * dpi * RENDER_SCALE),
      renderHeight: Math.round(height * dpi * RENDER_SCALE),
    });
    this.syncUI();
    this.startSensors();
  },
  onUnload() {
    (this as any)._pageVisible = false;
    this.clearRecognitionHint();
    (this as any)._unloaded = true;
    (this as any)._activityVisible = false;
    (this as any)._activityRequest = ((this as any)._activityRequest || 0) + 1;
    (this as any)._uiRegistry?.dispose();
    this.stopSensors();
  },
});
