import type { ArPageContext, DetailEvent } from "./context";
import type { createUiRegistry } from "../../../utils/ar-ui/registry";
export const recognitionData = { recognitionStatus: "等待 AR 相机就绪", matchProgress: "", recognitionLocked: false, recognitionDiagnostic: "", recognitionPhase: "idle", recognitionHintActive: false };
export const recognitionMethods = {
  onRecognitionStatus(event: DetailEvent) {
    if (event.detail.mode === this.data.retrievalMode) {
      const phase = event.detail.phase || "idle";
      this.setData({ recognitionStatus: event.detail.message, recognitionLocked: event.detail.locked === true, recognitionDiagnostic: event.detail.diagnostic || "", recognitionPhase: phase,
        ...(!["scanning", "reacquiring"].includes(phase) ? { recognitionHintActive: false } : {}) });
      this.syncUI();
    }
  },

  onRecognitionHint(event: DetailEvent) {
    if ((this as any)._unloaded || (this as any)._pageVisible !== true || !this.data.mapConfigReady ||
        this.data.retrievalMode === "gps" || event.detail.mode !== this.data.retrievalMode) return;
    // Hints may precede the matching status event; the producer owns the phase gate.
    const active = event.detail.active === true;
    if (active === this.data.recognitionHintActive) return;
    this.setData({ recognitionHintActive: active });
  },

  clearRecognitionHint() {
    if (!this.data.recognitionHintActive) return;
    this.setData({ recognitionHintActive: false });
  },

  onMatchProgress(event: DetailEvent) {
    if (event.detail.mode === this.data.retrievalMode && event.detail.text !== this.data.matchProgress) {
      this.setData({ matchProgress: event.detail.text });
      this.syncUI();
    }
  },

  onRescan() {
    if (this.data.retrievalMode === "gps") return;
    this.clearRecognitionHint();
    this.selectComponent("#main-frame")?.rescan();
  },
} satisfies ThisType<ArPageContext>;
export function registerRecognition(page: ArPageContext, registry: ReturnType<typeof createUiRegistry>) {
  const module = registry.register({ id: "recognition", slot: "bottom", order: 10,
    navigation: { label: "识别", icon: "scan-line" }, actions: { rescan: () => page.onRescan() } });
  return { sync() {
    const enabled = page.data.mapConfigReady && page.data.retrievalMode !== "gps";
    module.update({ enabled, badge: page.data.recognitionLocked ? "ready" : "" });
    module.publishDebug(enabled ? [
      ...(page.data.recognitionDiagnostic ? [{ key: "status", label: "识别", value: page.data.recognitionDiagnostic,
        level: page.data.recognitionPhase === "error" ? "error" as const : "info" as const, order: 25 }] : []),
      ...(page.data.matchProgress ? [{ key: "match", label: "匹配", value: page.data.matchProgress, order: 30 }] : []),
    ] : []);
  } };
}
