import type { ArPageContext, DetailEvent } from "./context";
import { CONFIG, fetchActivities, submitActivityRecord } from "../../../utils/backend";
import { reportError } from "../../../utils/report-error";
import { acceptActivityDiscovery, activityParticipantId, activityRequestKey, danmakuMaxLength, nextActivityDiscoverySequence,
  parseActivityPlacements, withinActivityScope, type ActivityPlacement, type ActivitySubmission } from "../../../utils/activity-state";
import type { createUiRegistry } from "../../../utils/ar-ui/registry";

export const activityData = {
  textContent: "", isSubmitting: false, canSubmit: false, showShopPanel: false, shopCheckinEnabled: false,
  shopActivities: [] as ActivityPlacement[], danmakuActivities: [] as ActivityPlacement[], activeDanmaku: null as ActivityPlacement | null,
  selectedDanmakuIdx: 0, danmakuLimit: 200, danmakuInRange: false, activitiesLoading: false, activitiesError: "",
  shopNavigation: { visible: false, title: "", distance: "", angle: 0 }, shopReward: { visible: false, title: "", image: "" },
};
export const activityMethods = {
  onTextInput(e: DetailEvent) {
    if (this.data.isSubmitting) return;
    const textContent = e.detail.value;
    if (textContent !== this.data.textContent) (this as any)._danmakuIntent = null;
    this.setData({ textContent });
    this.refreshCanSubmit();
  },
  async refreshActivities() {
    const requestId = ((this as any)._activityRequest || 0) + 1;
    (this as any)._activityRequest = requestId;
    const workspaceId = CONFIG.workspaceId;
    const organizationId = CONFIG.organizationId;
    if (!organizationId || CONFIG.sceneId) {
      this.setData({ shopActivities: [], danmakuActivities: [], activeDanmaku: null, shopCheckinEnabled: false, showShopPanel: false, canSubmit: false, activitiesLoading: false, activitiesError: "" });
      this.syncUI();
      return;
    }
    this.setData({ activitiesLoading: true, activitiesError: "" });
    this.syncUI();
    const discoverySequence = nextActivityDiscoverySequence();
    try {
      const response = await fetchActivities(workspaceId, organizationId);
      if (response.statusCode !== 200) throw new Error("活动加载失败");
      const activities = parseActivityPlacements(response.data, !workspaceId);
      if ((this as any)._unloaded || requestId !== (this as any)._activityRequest) return;
      this.applyActivities(activities, discoverySequence);
    } catch (error) {
      if ((this as any)._unloaded || requestId !== (this as any)._activityRequest) return;
      if (!this.applyActivities([], discoverySequence)) return;
      console.error("[活动] 加载失败:", error);
      reportError("activities.load", error);
      this.setData({ shopActivities: [], danmakuActivities: [], activeDanmaku: null, shopCheckinEnabled: false, showShopPanel: false, canSubmit: false, activitiesError: "活动加载失败，点击重试" });
      this.selectComponent("#main-frame")?.setNavigationTarget(null);
    } finally {
      if (!(this as any)._unloaded && requestId === (this as any)._activityRequest) {
        this.setData({ activitiesLoading: false });
        this.syncUI();
      }
    }
  },

  onActivitiesLoad(event: DetailEvent) {
    if ((this as any)._unloaded || (this as any)._activityVisible === false) return;
    // The XR module validates the discovery response before emitting it.
    if (!Number.isInteger(event.detail.discoverySequence)) return;
    if (this.applyActivities(event.detail.activities, event.detail.discoverySequence)) {
      this.setData({ activitiesError: event.detail.error ? "活动加载失败，点击重试" : "" });
      this.syncUI();
    }
  },

  applyActivities(activities: ActivityPlacement[], discoverySequence: number): boolean {
    if (discoverySequence < ((this as any)._appliedActivityDiscovery || 0)) return false;
    if (!acceptActivityDiscovery(discoverySequence)) return false;
    (this as any)._appliedActivityDiscovery = discoverySequence;
    const shopActivities = activities.filter((activity) => activity.type === "shop_checkin");
    const danmakuActivities = activities.filter((activity) => activity.type === "danmaku");
    const selected = Math.max(0, danmakuActivities.findIndex((activity) => activity.id === this.data.activeDanmaku?.id));
    const activeDanmaku = danmakuActivities[selected] || null;
    this.setData({ shopActivities, danmakuActivities, activeDanmaku, selectedDanmakuIdx: selected, danmakuLimit: danmakuMaxLength(activeDanmaku),
      shopCheckinEnabled: shopActivities.length > 0, showShopPanel: shopActivities.length > 0 && this.data.showShopPanel });
    this.selectComponent("#main-frame")?.applyActivityAvailability?.(activities, discoverySequence);
    if (!shopActivities.length) this.selectComponent("#main-frame")?.setNavigationTarget(null);
    this.refreshCanSubmit();
    this.syncUI();
    return true;
  },

  onDanmakuActivityChange(event: DetailEvent) {
    if (this.data.isSubmitting) return;
    const selectedDanmakuIdx = Number(event.detail.value);
    const activeDanmaku = this.data.danmakuActivities[selectedDanmakuIdx];
    if (!activeDanmaku) return;
    (this as any)._danmakuIntent = null;
    this.setData({ selectedDanmakuIdx, activeDanmaku, danmakuLimit: danmakuMaxLength(activeDanmaku) });
    this.refreshCanSubmit();
  },

  refreshCanSubmit() {
    const text = this.data.textContent.trim();
    const danmakuInRange = withinActivityScope(this.data.activeDanmaku, this.data.location);
    this.setData({ danmakuInRange, canSubmit: this.data.mapConfigReady && !!text && text.length <= this.data.danmakuLimit && danmakuInRange && !this.data.isSubmitting });
  },
  async submitText() {
    if (this.data.isSubmitting) return;
    this.refreshCanSubmit();
    const { textContent, location, activeDanmaku } = this.data;
    if (!this.data.canSubmit || !location || !activeDanmaku) {
      wx.showToast({ title: !this.data.mapConfigReady ? "请等待地图设置加载" : !activeDanmaku ? "当前没有留言活动" : !location ? "请等待定位" : !this.data.danmakuInRange ? "请进入活动范围" : "请检查留言内容", icon: "none" });
      return;
    }
    const sendText = textContent.trim();
    let intent = (this as any)._danmakuIntent as ActivitySubmission | null;
    if (!intent || intent.placement_id !== activeDanmaku.id || intent.content !== sendText) {
      intent = { placement_id: activeDanmaku.id, kind: "danmaku", content: sendText, user_lat: location.latitude, user_lng: location.longitude,
        participant_id: activityParticipantId(), idempotency_key: activityRequestKey() };
      (this as any)._danmakuIntent = intent;
    }
    this.setData({ isSubmitting: true, canSubmit: false });
    try {
      const response = await submitActivityRecord(intent);
      if (response.statusCode !== 200 || typeof response.data?.id !== "string") {
        if (response.statusCode >= 400 && response.statusCode < 500) (this as any)._danmakuIntent = null;
        throw new Error(response.data?.error || "发送失败，请重试");
      }
      (this as any)._danmakuIntent = null;
      if ((this as any)._unloaded) return;
      if (this.data.textContent === textContent) this.setData({ textContent: "" });
      if ((this as any)._activityVisible !== false && this.data.activeDanmaku?.id === intent.placement_id) this.selectComponent("#main-frame")?.showDanmakuInXR(sendText, response.data);
    } catch (err) {
      console.error("[活动留言] 发送失败:", err);
      reportError("activities.submit", err);
      if (!(this as any)._unloaded) wx.showToast({ title: "发送失败，内容已保留", icon: "none" });
    } finally {
      if (!(this as any)._unloaded) {
        this.setData({ isSubmitting: false });
        this.refreshCanSubmit();
      }
    }
  },
} satisfies ThisType<ArPageContext>;

export function registerActivities(page: ArPageContext, registry: ReturnType<typeof createUiRegistry>) {
  const danmaku = registry.register({ id: "danmaku", slot: "bottom", order: 20,
    navigation: { label: "留言", icon: "message-circle" }, actions: {
      input: payload => page.onTextInput({ detail: payload }), select: payload => page.onDanmakuActivityChange({ detail: payload }),
      submit: () => page.submitText(), retry: () => page.refreshActivities(),
      keyboard: payload => page.onKeyboardHeightChange({ detail: payload }), blur: () => page.onComposerBlur(),
    } });
  const shop = registry.register({ id: "shop", slot: "bottom", order: 30,
    navigation: { label: "打卡", icon: "circle-check-big" },
    onActivate() { if (page.data.showShopPanel) page.selectComponent("#shop-checkin")?.loadProgress?.(); else page.setData({ showShopPanel: true }); },
    actions: {
      target: ({ shop }: any) => { page.selectComponent("#main-frame")?.setNavigationTarget(shop); if (!shop) page.setData({ shopNavigation: { visible: false, title: "", distance: "", angle: 0 } }); },
      compass: navigation => page.setData({ shopNavigation: navigation }), reward: reward => page.setData({ shopReward: reward }),
      closeReward: () => page.selectComponent("#shop-checkin")?.closeCheckinModal(), saveReward: () => page.selectComponent("#shop-checkin")?.saveCheckinImage(),
    } });
  const overlays = registry.register({ id: "shop-overlays", slot: "overlay", order: 20 });
  return { sync() {
    const d = page.data;
    danmaku.update({ enabled: !!d.activeDanmaku || d.activitiesLoading || !!d.activitiesError, badge: d.activitiesError ? "warning" : "" });
    shop.update({ enabled: d.mapConfigReady && d.shopCheckinEnabled });
    overlays.update({ enabled: d.mapConfigReady && d.shopCheckinEnabled });
    danmaku.publishDebug([{ key: "activities", label: "活动", value: d.activitiesError ? "读取失败" : d.activitiesLoading ? "加载中" : `${d.danmakuActivities.length} 留言 / ${d.shopActivities.length} 打卡`, level: d.activitiesError ? "error" : "info", order: 60 }]);
    if (!d.shopCheckinEnabled && (d.shopNavigation.visible || d.shopReward.visible)) page.setData({ shopNavigation: activityData.shopNavigation, shopReward: activityData.shopReward });
  } };
}
