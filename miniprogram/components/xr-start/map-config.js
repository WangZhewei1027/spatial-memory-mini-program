const { CONFIG, fetchWorkspaces } = require("../../utils/backend");
const { parseMapConfig } = require("../../utils/map-config");

module.exports = {
  loadMapConfig() {
    if (this._disposed || this._scenePreviewMode || this._pageVisible === false) return Promise.resolve();
    if (this._mapConfigRequest) return this._mapConfigRequest;
    const workspaceId = CONFIG.workspaceId, organizationId = CONFIG.organizationId;
    const epoch = ++this._mapConfigEpoch;
    this._mapConfigReady = false;
    this.triggerEvent("mapconfigload", { ready: false });
    this.setData({ renderError: "", renderStatus: "正在读取地图设置…", canRetry: true });
    const current = () => !this._disposed && this._pageVisible !== false && epoch === this._mapConfigEpoch &&
      workspaceId === CONFIG.workspaceId && organizationId === CONFIG.organizationId;
    const request = Promise.resolve().then(async () => {
      if (!current()) return;
      if (!workspaceId || !organizationId) throw new Error("请返回首页选择具体地图");
      const { statusCode, data } = await fetchWorkspaces([workspaceId], organizationId);
      if (!current()) return;
      const row = Array.isArray(data) ? data.find((item) => item.id === workspaceId && item.organization_id === organizationId) : null;
      if (statusCode !== 200 || !row) throw new Error("地图设置暂不可用，请重试");
      const config = parseMapConfig(row.config);
      this._textAssetStyle = config.text_asset_miniapp_style;
      this._confettiEnabled = config.confetti_enabled;
      this._mapConfigReady = true;
      this.triggerEvent("mapconfigload", { ready: true, retrievalMode: config.retrieval_mode, footerEnabled: config.footer_enabled });
      this.setRetrievalMode(config.retrieval_mode);
      this.startAR();
    }).catch((error) => {
      if (!current()) return;
      this.setData({ renderError: error.message || "地图设置加载失败，请重试", renderStatus: "", canRetry: !!workspaceId && !!organizationId });
    }).finally(() => {
      if (this._mapConfigRequest === request) this._mapConfigRequest = null;
    });
    this._mapConfigRequest = request;
    return request;
  },
};
