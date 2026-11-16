const { CONFIG, backendRpc } = require("../../../utils/backend");
const { reportError } = require("../../../utils/report-error");
const { THREE } = require("../../../lib/three-runtime/runtime");
const { createCompositionPlayer } = require("../../../lib/scene-runtime/composition");
const { scenePlacementFromCamera } = require("../../../lib/scene-runtime/vendor/scene-core");

// One scene placement occupies one queue slot; all children share its lifetime.
module.exports = {
  async _loadScenePlayer(asset, manifest) {
    if (![4, 5, 7, 8, 9, 10].includes(manifest?.schemaVersion) || manifest.assetId !== asset.id || manifest.content?.kind !== "composition")
      throw new Error("不支持的场景内容");
    if (manifest.content.instances?.length === 0) return null;
    const player = createCompositionPlayer(manifest, {
      modelCache: this._modelCache, canvas: this._canvas,
      getListenerCamera: () => this.getCamTransform(),
      onState: (state, message, current) => this._scenePlayerState(asset, state, message, current),
      // A lost soundtrack keeps the scene playing; tell the viewer and report it.
      onWarning: error => { if (!this._disposed && this._isAssetPlacementCurrent(asset)) this.reportAssetError(asset, error); },
      onDiagnostic: event => reportError(`scene.${event.event || "diagnostic"}`, event.message || event.event, { ...event, assetId: asset.id }),
    });
    try {
      await player.load();
      if (!this._isAssetPlacementCurrent(asset)) { player.dispose(); return null; }
      if (player.state !== "ready") throw new Error(player.diagnostics?.message || "场景内容加载失败");
      return player;
    } catch (error) { player.dispose(); throw error; }
  },
  _scenePlayerState(asset, state, message, player) {
    const entry = this.nodeList?.find(item => item.node === player.root && !item._destroyed);
    const pending = this._scenePreviewPlayer === player;
    if (state === "error" && (entry || pending)) {
      if (pending) this._scenePreviewPlayer = null;
      if (this._mountedScenePreviewPlayer === player) this._mountedScenePreviewPlayer = null;
      if (entry) {
        this.nodeList.splice(this.nodeList.indexOf(entry), 1);
        this._destroyNode(entry);
      }
      if (this._scenePreviewMode) {
        reportError("scene.preview", message || "场景媒体播放失败", { assetId: asset?.id });
        this._scenePreviewPlaced = false;
        this._scenePreviewStatus("error", message || "场景媒体播放失败，请重试");
      } else this.reportAssetError(asset, new Error(message || "场景媒体播放失败"));
      return;
    }
    if (this._mountedScenePreviewPlayer === player && ["playing", "paused", "ended"].includes(state))
      this.triggerEvent("sceneplayback", { state });
  },
  _mountScenePlayer(asset, player) {
    const camera = this.getCamTransform();
    if (!camera || !this._isAssetPlacementCurrent(asset)) { player.dispose(); return false; }
    const forward = camera.getWorldDirection(new THREE.Vector3());
    forward.y = 0;
    if (forward.lengthSq() < 1e-8) forward.set(0, 0, -1);
    forward.normalize();
    const phonePosition = camera.getWorldPosition(new THREE.Vector3());
    const placement = scenePlacementFromCamera(phonePosition.toArray(), forward.toArray(), player.viewerPosition);
    const root = player.root;
    // Match the saved Web viewer position while keeping the authored ground level.
    root.position.fromArray(placement.position);
    root.rotation.set(0, placement.yaw, 0);
    if (!this._wouldSurvive(root.position, "scene")) { player.dispose(); return false; }
    this.shadowRoot.add(root);
    const entry = this._registerNode(asset.id, root, null, {
      type: "scene", contentEpoch: asset._contentEpoch, current: asset._layerCurrent, repulsionEnabled: false,
      dispose: () => {
        if (this._mountedScenePreviewPlayer === player) this._mountedScenePreviewPlayer = null;
        player.dispose();
      }, tick: (dt) => player.update(dt),
      // No canvas-tap transport: map, recognition and QR scenes play the same
      // way; only the QR scene page offers explicit pause/replay buttons.
    });
    if (!entry._destroyed) {
      if (this._scenePreviewMode) this._mountedScenePreviewPlayer = player;
      player.play();
    }
    return !entry._destroyed;
  },
  async _placeSceneAsset(asset) {
    let player;
    try {
      const { statusCode, data } = await backendRpc("get_scene_asset", {
        asset_id: asset.id, p_workspace_id: CONFIG.workspaceId, p_organization_id: CONFIG.organizationId,
      });
      if (!this._isAssetPlacementCurrent(asset)) return;
      if (statusCode !== 200) throw new Error(data?.error || "场景加载失败");
      player = await this._loadScenePlayer(asset, data);
      if (player) this._mountScenePlayer(asset, player);
    } catch (error) {
      player?.dispose();
      if (this._isAssetPlacementCurrent(asset)) throw error;
    }
  },
};
