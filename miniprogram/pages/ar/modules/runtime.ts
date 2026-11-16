import type { ArPageContext, DetailEvent } from "./context";
import type { createUiRegistry } from "../../../utils/ar-ui/registry";
export const runtimeData = { retrievalMode: "gps", mapConfigReady: false, footerEnabled: false, runtimeState: "等待相机", runtimeError: "" };
export const runtimeMethods = {
  onAssetError(event: DetailEvent) {
    const message = event.detail?.message || "素材加载失败";
    this.setData({ runtimeError: String(message) });
    this.syncUI();
    const now = Date.now();
    if (now - ((this as any)._lastAssetErrorAt || 0) < 5000) return;
    (this as any)._lastAssetErrorAt = now;
    wx.showToast({ title: String(message).slice(0, 50), icon: "none", duration: 3000 });
  },
  onMapConfigLoad(e: DetailEvent) {
    const { ready, retrievalMode, footerEnabled } = e.detail;
    this.setData({ mapConfigReady: ready === true, footerEnabled: ready === true && footerEnabled === true,
      ...(ready === true ? { retrievalMode, recognitionLocked: false, recognitionStatus: "等待 AR 相机就绪", matchProgress: "", recognitionDiagnostic: "", recognitionPhase: "idle" } : {}) });
    this.refreshCanSubmit();
    this.syncUI();
  },
  onRenderStatus(event: DetailEvent) {
    this.setData({ runtimeState: event.detail.state || "未知", runtimeError: event.detail.state === "error" ? event.detail.message || "相机异常" : "" });
    this.syncUI();
  },
} satisfies ThisType<ArPageContext>;
export function registerRuntime(page: ArPageContext, registry: ReturnType<typeof createUiRegistry>) {
  const runtime = registry.register({ id: "runtime", slot: "scene" });
  const diagnostics = registry.register({ id: "diagnostics", slot: "top" });
  const branding = registry.register({ id: "branding", slot: "overlay" });
  return { sync() {
    runtime.update({ enabled: true }); diagnostics.update({ enabled: true }); branding.update({ enabled: page.data.footerEnabled });
    runtime.publishDebug([{ key: "camera", label: "相机", value: page.data.runtimeError || page.data.runtimeState, level: page.data.runtimeError ? "error" : "info", order: 40 }]);
  } };
}
