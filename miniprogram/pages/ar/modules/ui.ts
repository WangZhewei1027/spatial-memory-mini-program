import type { ArPageContext, DetailEvent } from "./context";
import { createUiRegistry, emptyUiSnapshot } from "../../../utils/ar-ui/registry";
import { registerActivities } from "./activities";
import { registerRecognition } from "./recognition";
import { registerRuntime } from "./runtime";
import { registerSensors } from "./sensors";
import { registerShop } from "./shop";

export const uiData = { ...emptyUiSnapshot(), keyboardHeight: 0 };
export const uiMethods = {
  ensureUI() {
    if ((this as any)._uiRegistry || (this as any)._unloaded) return;
    const registry = createUiRegistry(snapshot => {
      const selectionChanged = snapshot.activeBottomPanel !== this.data.activeBottomPanel || !snapshot.bottomPanelExpanded;
      if (selectionChanged && this.data.keyboardHeight) wx.hideKeyboard?.();
      this.setData({ ...snapshot, ...(selectionChanged ? { keyboardHeight: 0 } : {}) });
    });
    (this as any)._uiRegistry = registry;
    (this as any)._uiModules = [registerRuntime(this, registry), registerRecognition(this, registry), registerActivities(this, registry), registerShop(this, registry), registerSensors(this, registry)];
  },
  syncUI() {
    if ((this as any)._unloaded) return;
    this.ensureUI();
    (this as any)._uiRegistry.batch(() => { for (const module of (this as any)._uiModules) module.sync(); });
    if (!this.data.activeDanmaku && this.data.keyboardHeight) { wx.hideKeyboard?.(); this.setData({ keyboardHeight: 0 }); }
  },
  onModuleAction(event: DetailEvent) {
    this.ensureUI();
    return (this as any)._uiRegistry?.dispatch(event.detail);
  },
  onPanelChange(event: DetailEvent) {
    this.ensureUI();
    (this as any)._uiRegistry?.select(event.detail.id);
  },
  onKeyboardHeightChange(event: DetailEvent) {
    const height = Number(event.detail?.height);
    if (!Number.isFinite(height)) return;
    const keyboardHeight = this.data.activeBottomPanel === "danmaku" && this.data.bottomPanelExpanded ? Math.max(0, height) : 0;
    if (keyboardHeight !== this.data.keyboardHeight) this.setData({ keyboardHeight });
  },
  onComposerBlur() { this.setData({ keyboardHeight: 0 }); },
} satisfies ThisType<ArPageContext>;
