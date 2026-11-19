import {
  setConfig,
  CONFIG,
  fetchOrganizations,
  fetchWorkspaces,
  fetchTeamWorkspaces,
  fetchScenes,
  loadScanHistory,
  saveScanHistory,
  scanHistoryKey,
  WorkspaceSummary,
} from "../../utils/backend";
import { scenePreviewUrl } from "../../utils/entry-navigation";
import { reportError } from "../../utils/report-error";
import { usesSimulatedCamera } from "../../utils/camera-environment";

/** AR 体验依赖的授权 scope 及其展示名 */
const REQUIRED_SCOPES: { scope: keyof WechatMiniprogram.AuthSetting; label: string }[] = [
  { scope: "scope.userLocation", label: "位置" },
];
if (!usesSimulatedCamera()) REQUIRED_SCOPES.push({ scope: "scope.camera", label: "相机" });

Page({
  data: {
    title: "",
    subtitle: "",
    loaded: false,
    showFooter: false,
    /** 被用户明确拒绝的权限名称，如「位置、相机」；为空则不显示引导条 */
    deniedPermText: "",
    isScene: false,
    needsMap: false,
    mapChoices: [] as WorkspaceSummary[],
    mapsError: "",
  },

  onLoad() {
    return this.fetchNames();
  },

  onShow() {
    this.checkPermissions();
  },

  /**
   * 检查 AR 所需权限是否被用户明确拒绝过。
   * authSetting 中 undefined 表示从未询问（首次使用时会正常弹授权框），
   * 只有显式为 false 才需要引导去设置页——拒绝后 wx.authorize 不会再弹窗。
   */
  checkPermissions() {
    wx.getSetting({
      success: (res) => {
        const denied = REQUIRED_SCOPES.filter(
          (s) => res.authSetting[s.scope] === false,
        ).map((s) => s.label);
        this.setData({ deniedPermText: denied.join("、") });
      },
    });
  },

  /** 设置页返回后的回调：直接用返回的 authSetting 刷新引导条 */
  onOpenSetting(e: WechatMiniprogram.CustomEvent) {
    const authSetting =
      (e.detail && e.detail.authSetting) || ({} as Record<string, boolean>);
    const denied = REQUIRED_SCOPES.filter(
      (s) => authSetting[s.scope] === false,
    ).map((s) => s.label);
    this.setData({ deniedPermText: denied.join("、") });
    if (!denied.length) {
      wx.showToast({ title: "权限已开启", icon: "success" });
    }
  },

  async fetchNames() {
    const selected = { ...CONFIG };
    const cached = loadScanHistory().find((e) => scanHistoryKey(e) === scanHistoryKey(selected));
    try {
      // 并行拉取团队与内容名称，避免串行 await 阻塞首屏渲染。
      const orgPromise = selected.organizationId
        ? fetchOrganizations([selected.organizationId]).catch(() => null)
        : Promise.resolve(null);
      const wsPromise = selected.workspaceId
        ? fetchWorkspaces([selected.workspaceId], selected.organizationId).catch(() => null)
        : Promise.resolve(null);
      const needsMap = !selected.sceneId && !selected.workspaceId;
      const mapsPromise = needsMap && selected.organizationId
        ? fetchTeamWorkspaces(selected.organizationId).catch(() => null)
        : Promise.resolve(null);
      const scenePromise = selected.sceneId && selected.organizationId
        ? fetchScenes([selected.sceneId], selected.organizationId).catch(() => null)
        : Promise.resolve(null);

      const [orgRes, wsRes, sceneRes, mapsRes] = await Promise.all([orgPromise, wsPromise, scenePromise, mapsPromise]);
      if (scanHistoryKey(selected) !== scanHistoryKey(CONFIG)) return;

      // 只使用当前目标的缓存，切换时不能残留其他目标的标题或 footer。
      const patch = {
        title: cached?.orgName || "",
        subtitle: selected.sceneId ? cached?.sceneName || "场景名称暂不可用" : cached?.workspaceName || "",
        isScene: !!selected.sceneId,
        showFooter: false,
        needsMap,
        mapChoices: needsMap && mapsRes?.statusCode === 200 && Array.isArray(mapsRes.data)
          ? mapsRes.data.filter((map) => map.organization_id === selected.organizationId) : [],
        mapsError: needsMap && (!mapsRes || mapsRes.statusCode !== 200) ? "地图加载失败，点击重试" : "",
      };
      if (
        orgRes &&
        orgRes.statusCode === 200 &&
        Array.isArray(orgRes.data) &&
        orgRes.data.length > 0
      ) {
        patch.title = orgRes.data[0].name;
      }
      if (
        wsRes &&
        wsRes.statusCode === 200 &&
        Array.isArray(wsRes.data) &&
        wsRes.data.length > 0
      ) {
        const map = wsRes.data.find((row) => row.id === selected.workspaceId && row.organization_id === selected.organizationId);
        if (map) {
          patch.subtitle = map.name;
          patch.showFooter = map.config?.footer_enabled === true;
        }
      }
      const sceneName = sceneRes?.statusCode === 200 && Array.isArray(sceneRes.data)
        ? sceneRes.data.find((s) => s.id === selected.sceneId)?.name
        : undefined;
      if (sceneName) patch.subtitle = sceneName;
      // 单次 setData 批量更新，减少 WXML diff
      this.setData({ ...patch, loaded: true });

      // 名称刷新保留最近浏览时间，且不会为默认调试入口新增历史。
      const history = loadScanHistory();
      const current = history.find((item) => scanHistoryKey(item) === scanHistoryKey(selected));
      if (current) {
        const orgName = patch.title || current.orgName;
        const workspaceName = selected.sceneId ? current.workspaceName : patch.subtitle || current.workspaceName;
        if (orgName !== current.orgName || workspaceName !== current.workspaceName || (sceneName && sceneName !== current.sceneName)) {
          current.orgName = orgName;
          current.workspaceName = workspaceName;
          current.sceneName = sceneName || current.sceneName;
          saveScanHistory(history);
        }
      }
    } catch (err) {
      console.error("[entry] fetchNames error:", err);
      reportError("entry.fetchNames", err);
      this.setData({ loaded: true });
    }
  },

  goToAR() {
    if (CONFIG.sceneId) {
      setConfig(CONFIG);
      wx.navigateTo({ url: scenePreviewUrl(CONFIG) });
      return;
    }
    if (!CONFIG.organizationId || !CONFIG.workspaceId) {
      wx.showToast({ title: "请先选择地图合集", icon: "none" });
      return;
    }
    setConfig(CONFIG);
    wx.navigateTo({
      url: `/pages/ar/ar?organizationId=${encodeURIComponent(CONFIG.organizationId)}&workspaceId=${encodeURIComponent(CONFIG.workspaceId)}`,
    });
  },

  onChooseMap(e: WechatMiniprogram.CustomEvent) {
    const map = this.data.mapChoices[Number(e.detail.value)];
    if (!map || map.organization_id !== CONFIG.organizationId) return;
    setConfig({ organizationId: map.organization_id, workspaceId: map.id });
    this.setData({ loaded: false, showFooter: false });
    void this.fetchNames();
  },

  retryMaps() {
    this.setData({ loaded: false });
    void this.fetchNames();
  },
});
