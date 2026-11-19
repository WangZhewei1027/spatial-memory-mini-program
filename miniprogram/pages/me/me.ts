import {
  fetchOrganizations,
  fetchScenes,
  fetchWorkspaces,
  loadScanHistory,
  saveScanHistory,
  scanHistoryKey,
  setConfig,
} from "../../utils/backend";
import { scenePreviewUrl } from "../../utils/entry-navigation";
import { reportError } from "../../utils/report-error";

interface HistoryItem {
  key: string;
  kind: "场景" | "地图";
  name: string;
  organization: string;
  viewedAt: string;
}

function formatViewedAt(timestamp: number): string {
  const date = new Date(timestamp);
  if (!timestamp || Number.isNaN(date.getTime())) return "";
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()} ${hour}:${minute}`;
}

Page({
  _refreshingNames: false,
  data: { history: [] as HistoryItem[] },

  onShow() {
    this.refreshHistory();
    void this.refreshHistoryNames();
  },

  refreshHistory() {
    const history = loadScanHistory().map((entry): HistoryItem => ({
      key: scanHistoryKey(entry),
      kind: entry.sceneId ? "场景" : "地图",
      name: entry.sceneId
        ? entry.sceneName || "场景名称暂不可用"
        : entry.workspaceName || (entry.workspaceId ? "地图名称暂不可用" : "选择地图合集"),
      organization: entry.orgName || "",
      viewedAt: formatViewedAt(entry.ts),
    }));
    this.setData({ history });
  },

  onSelectHistory(event: WechatMiniprogram.TouchEvent) {
    const { key } = event.currentTarget.dataset;
    const entry = loadScanHistory().find((item) => scanHistoryKey(item) === key);
    if (!entry) return;

    setConfig(entry);
    wx.navigateTo({ url: entry.sceneId ? scenePreviewUrl(entry) : "/pages/entry/entry" });
  },

  /**
   * 批量异步刷新历史记录的展示名称，反映后端重命名。
   * 团队和地图批量查询；Scene 按团队分组，名称变化时写回 Storage。
   */
  async refreshHistoryNames() {
    const list = loadScanHistory();
    if (this._refreshingNames || !list.length) return;
    this._refreshingNames = true;

    const orgIds = [
      ...new Set(list.map((e) => e.organizationId).filter(Boolean)),
    ];
    const wsIds = [
      ...new Set(list.map((e) => e.workspaceId).filter(Boolean)),
    ] as string[];
    const scenesByOrg = new Map<string, string[]>();
    list.forEach((e) => {
      if (e.sceneId) scenesByOrg.set(e.organizationId, [...(scenesByOrg.get(e.organizationId) || []), e.sceneId]);
    });

    try {
      const [orgRes, wsRes, sceneResults] = await Promise.all([
        orgIds.length
          ? fetchOrganizations(orgIds).catch(() => null)
          : Promise.resolve(null),
        wsIds.length
          ? fetchWorkspaces(wsIds).catch(() => null)
          : Promise.resolve(null),
        Promise.all([...scenesByOrg].map(async ([organizationId, ids]) => ({
          organizationId, response: await fetchScenes(ids, organizationId).catch(() => null),
        }))),
      ]);

      const orgMap: Record<string, string> = {};
      if (orgRes && orgRes.statusCode === 200 && Array.isArray(orgRes.data)) {
        orgRes.data.forEach((o) => (orgMap[o.id] = o.name));
      }
      const wsMap: Record<string, string> = {};
      if (wsRes && wsRes.statusCode === 200 && Array.isArray(wsRes.data)) {
        wsRes.data.forEach((w) => (wsMap[w.id] = w.name));
      }
      const sceneMap: Record<string, string> = {};
      sceneResults.forEach(({ organizationId, response }) => {
        if (response?.statusCode === 200 && Array.isArray(response.data)) {
          response.data.forEach((s) => (sceneMap[scanHistoryKey({ organizationId, sceneId: s.id })] = s.name));
        }
      });

      // 仅在确有名称变化时写回，避免无谓的 Storage 写入与重渲染。
      // 后端查不到（已删除）的条目保留旧名，不清空。
      let changed = false;
      const updated = loadScanHistory().map((e) => {
        const next = { ...e };
        const newOrg = orgMap[e.organizationId];
        if (newOrg && newOrg !== e.orgName) {
          next.orgName = newOrg;
          changed = true;
        }
        const newWs = e.workspaceId ? wsMap[e.workspaceId] : undefined;
        if (newWs && newWs !== e.workspaceName) {
          next.workspaceName = newWs;
          changed = true;
        }
        const newScene = e.sceneId ? sceneMap[scanHistoryKey(e)] : undefined;
        if (newScene && newScene !== e.sceneName) {
          next.sceneName = newScene;
          changed = true;
        }
        return next;
      });

      if (changed) {
        saveScanHistory(updated);
        this.refreshHistory();
      }
    } catch (err) {
      console.error("[me] refreshHistoryNames error:", err);
      reportError("me.refreshHistoryNames", err);
    } finally {
      this._refreshingNames = false;
    }
  },
});
