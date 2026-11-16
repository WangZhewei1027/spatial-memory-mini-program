import type { ArPageContext, DetailEvent } from "./context";
import type { createUiRegistry } from "../../../utils/ar-ui/registry";
export const recognitionData = { recognitionStatus: "等待 AR 相机就绪", matchProgress: "", recognitionLocked: false, recognitionDiagnostic: "", recognitionPhase: "idle" };
export const recognitionMethods = {
  onRecognitionStatus(event: DetailEvent) {
    if (event.detail.mode === this.data.retrievalMode) {
      this.setData({ recognitionStatus: event.detail.message, recognitionLocked: event.detail.locked === true, recognitionDiagnostic: event.detail.diagnostic || "", recognitionPhase: event.detail.phase || "idle" });
      this.syncUI();
    }
  },

  onMatchProgress(event: DetailEvent) {
    if (event.detail.mode === this.data.retrievalMode && event.detail.text !== this.data.matchProgress) {
      this.setData({ matchProgress: event.detail.text });
      this.syncUI();
    }
  },

  onRescan() {
    if (this.data.retrievalMode !== "anchor") return;
    this.selectComponent("#main-frame")?.rescan();
  },
} satisfies ThisType<ArPageContext>;
export function registerRecognition(page: ArPageContext, registry: ReturnType<typeof createUiRegistry>) {
  const module = registry.register({ id: "recognition", slot: "bottom", order: 10,
    navigation: { label: "识别", icon: "scan-line" }, actions: { rescan: () => page.onRescan() } });
  return { sync() {
    const enabled = page.data.mapConfigReady && page.data.retrievalMode === "anchor";
    module.update({ enabled, badge: page.data.recognitionLocked ? "ready" : "" });
    module.publishDebug(enabled ? [
      ...(page.data.recognitionDiagnostic ? [{ key: "status", label: "识别", value: page.data.recognitionDiagnostic,
        level: page.data.recognitionPhase === "error" ? "error" as const : "info" as const, order: 25 }] : []),
      ...(page.data.matchProgress ? [{ key: "match", label: "匹配", value: page.data.matchProgress, order: 30 }] : []),
    ] : []);
  } };
}
