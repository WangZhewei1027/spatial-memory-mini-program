import { fetchPublicScenes, setConfig } from "../../utils/backend";
import type { PublicScene, ScanConfig } from "../../utils/backend";
import { scenePreviewUrl } from "../../utils/entry-navigation";

const PAGE_SIZE = 12;

interface SceneCard {
  id: string;
  organizationId: string;
  name: string;
  cover: string;
}

function coverImage(thumbnail: PublicScene["thumbnail"]): string {
  if (thumbnail?.kind === "image") return thumbnail.url;
  if (thumbnail?.kind === "video" &&
      /^https:\/\/[^/]+\.oss-cn-[a-z-]+\.aliyuncs\.com\/[^?#]+$/.test(thumbnail.url)) {
    return `${thumbnail.url}?x-oss-process=video/snapshot,t_0,f_jpg,w_640`;
  }
  return "";
}

Page({
  _openingEntry: false,
  _requestedScenes: false,
  _nextOffset: 0,
  _retryFromStart: true,
  data: {
    scenes: [] as SceneCard[],
    loading: true,
    error: false,
    hasMore: false,
  },

  onLoad(options: ScanConfig & { select?: string }) {
    setConfig(options);

    // 已印制的二维码仍从主页分发到对应的体验页。
    if (options.sceneId && options.select !== "1") {
      this.openLinkedPage(scenePreviewUrl(options));
    } else if (options.select === "1" || options.workspaceId || options.organizationId) {
      this.openLinkedPage("/pages/entry/entry");
    }
  },

  onShow() {
    if (!this._openingEntry && !this._requestedScenes) void this.loadScenes(true);
  },

  openLinkedPage(url: string) {
    if (this._openingEntry) return;
    this._openingEntry = true;
    wx.navigateTo({
      url,
      fail: () => {
        wx.showToast({ title: "暂时无法打开，请重试", icon: "none" });
        if (!this._requestedScenes) void this.loadScenes(true);
      },
      complete: () => { this._openingEntry = false; },
    });
  },

  async loadScenes(reset: boolean) {
    if (this._requestedScenes && this.data.loading) return;
    this._requestedScenes = true;
    this._retryFromStart = reset;
    this.setData({ loading: true, error: false });
    try {
      const offset = reset ? 0 : this._nextOffset;
      const { scenes, hasMore } = await fetchPublicScenes(offset, PAGE_SIZE);
      this._nextOffset = offset + scenes.length;
      const cards = scenes.map((scene): SceneCard => ({
        id: scene.id,
        organizationId: scene.organization_id,
        name: scene.name?.trim() || "未命名场景",
        cover: coverImage(scene.thumbnail),
      }));
      const existing = reset ? [] : this.data.scenes;
      const ids = new Set(existing.map((scene) => scene.id));
      this.setData({
        scenes: existing.concat(cards.filter((scene) => !ids.has(scene.id))),
        hasMore: hasMore && scenes.length > 0,
      });
    } catch {
      this.setData({ error: true });
    } finally {
      this.setData({ loading: false });
    }
  },

  retryScenes() {
    return this.loadScenes(this._retryFromStart);
  },

  loadMoreScenes() {
    return this.loadScenes(false);
  },

  async onPullDownRefresh() {
    await this.loadScenes(true);
    wx.stopPullDownRefresh();
  },

  onCoverError(event: WechatMiniprogram.CustomEvent) {
    const { id, cover } = event.currentTarget.dataset;
    const index = this.data.scenes.findIndex((scene) => scene.id === id && scene.cover === cover);
    if (index >= 0) this.setData({ [`scenes[${index}].cover`]: "" });
  },

  onOpenScene(event: WechatMiniprogram.TouchEvent) {
    if (this._openingEntry) return;
    const scene = this.data.scenes.find((item) => item.id === event.currentTarget.dataset.id);
    if (!scene) return;
    const selection = { sceneId: scene.id, organizationId: scene.organizationId };
    setConfig(selection, { sceneName: scene.name });
    this.openLinkedPage(scenePreviewUrl(selection));
  },
});
