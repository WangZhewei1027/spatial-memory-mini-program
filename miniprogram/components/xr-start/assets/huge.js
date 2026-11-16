const { CONFIG, backendRpc } = require("../../../utils/backend");
const { THREE } = require("../../../lib/three-runtime/runtime");
const { disposeTree } = require("../../../lib/three-runtime/resources");
const { instantiateModel } = require("./model");
function gpsRelative(lat, lng, targetLat, targetLng) {
  const rad = Math.PI / 180,
    phi1 = lat * rad,
    phi2 = targetLat * rad,
    dphi = (targetLat - lat) * rad,
    dl = (targetLng - lng) * rad;
  const a =
    Math.sin(dphi / 2) ** 2 +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(dl / 2) ** 2;
  return {
    distance:
      6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a))),
    bearing:
      ((Math.atan2(
        Math.sin(dl) * Math.cos(phi2),
        Math.cos(phi1) * Math.sin(phi2) -
          Math.sin(phi1) * Math.cos(phi2) * Math.cos(dl),
      ) *
        180) /
        Math.PI +
        360) %
      360,
  };
}
module.exports = (XR_CONFIG) => ({
  async fetchHugeAssets() {
    if (
      this._disposed ||
      this._retrievalPaused ||
      this.retrievalMode === "anchor" ||
      !this.currentGPS ||
      !CONFIG.organizationId ||
      this._isFetchingHuge
    )
      return;
    const epoch = this._modeEpoch, current = this._getRenderLayer?.("world")?.capture();
    if (current && !current()) return;
    const request = this._hugeFetchRequest = {};
    this._isFetchingHuge = true;
    try {
      const { statusCode, data } = await backendRpc("get_huge_assets", {
        p_organization_id: CONFIG.organizationId,
        p_workspace_id: CONFIG.workspaceId ?? null,
      });
      if (epoch !== this._modeEpoch || this._disposed || (current && !current())) return;
      if (statusCode === 200 && Array.isArray(data)) {
        this._pendingHugeAssets = data.filter(
          (a) =>
            a.file_url &&
            Number.isFinite(a.latitude) &&
            Number.isFinite(a.longitude),
        );
        this._placeHugeAssets();
      }
    } catch (error) {
      console.warn("[huge] 请求失败", error);
    } finally {
      if (this._hugeFetchRequest === request) { this._hugeFetchRequest = null; this._isFetchingHuge = false; }
    }
  },
  async _placeHugeAssets() {
    if (
      !this._arReady ||
      this._hugePlacingBusy ||
      this._retrievalPaused ||
      this.retrievalMode === "anchor"
    )
      return;
    const drain = this._hugeDrain = {};
    this._hugePlacingBusy = true;
    try {
      while (
        this._hugeDrain === drain && this._pendingHugeAssets.length &&
        !this._disposed &&
        !this._retrievalPaused &&
        this.retrievalMode === "gps"
      ) {
        const asset = this._pendingHugeAssets.shift(),
          epoch = this._contentEpoch;
        const layer = this._getRenderLayer?.("world"), current = layer?.capture();
        if (current && !current()) break;
        if (this._hugeNodeList.some((e) => e.assetId === asset.id)) continue;
        let handle;
        try {
          const before = gpsRelative(
            this.currentGPS.latitude,
            this.currentGPS.longitude,
            asset.latitude,
            asset.longitude,
          );
          if (before.distance < 30) continue;
          handle = await this._hugeModelCache.acquire(asset.file_url);
          if (
            this._disposed ||
            epoch !== this._contentEpoch || (current && !current()) ||
            !this._arReady
          ) {
            disposeTree(handle.object);
            handle.release();
            continue;
          }
          const { distance, bearing } = gpsRelative(
            this.currentGPS.latitude,
            this.currentGPS.longitude,
            asset.latitude,
            asset.longitude,
          );
          if (distance < 30) {
            disposeTree(handle.object);
            handle.release();
            continue;
          }
          const camera = this._runtime.camera,
            forward = camera.getWorldDirection(new THREE.Vector3());
          // Three forward is -Z; positive geographic heading turns right.
          const yaw =
            Math.atan2(forward.x, -forward.z) +
            ((bearing - (this._compassHeading || 0)) * Math.PI) / 180;
          const instance = instantiateModel(handle, 15, asset.config),
            radius = Math.min(distance, 100);
          instance.root.position.set(
            camera.position.x + Math.sin(yaw) * radius,
            camera.position.y,
            camera.position.z - Math.cos(yaw) * radius,
          );
          const entry = {
            assetId: asset.id, node: instance.root, mixer: instance.mixer,
            dispose: instance.dispose, lat: asset.latitude, lng: asset.longitude, type: "model", layer,
          };
          if (layer) {
            if (!layer.mount(instance.root, { current, dispose: () => {
              const index = this._hugeNodeList.indexOf(entry);
              if (index >= 0) this._hugeNodeList.splice(index, 1);
              this._disposeNode(entry);
            } })) continue;
          } else this.shadowRoot.add(instance.root);
          this._hugeNodeList.push(entry);
        } catch (error) {
          if (handle) {
            disposeTree(handle.object);
            handle.release();
          }
          this.reportAssetError?.(asset, error);
        }
        await new Promise((resolve) =>
          setTimeout(resolve, XR_CONFIG.placeStaggerMs || 40),
        );
      }
    } finally {
      if (this._hugeDrain === drain) { this._hugeDrain = null; this._hugePlacingBusy = false; }
    }
  },
  tickHugeModels() {
    if (this._pendingHugeAssets.length) this._placeHugeAssets();
    if (!this.currentGPS || this.currentGPS === this._lastHugeTickGPS) return;
    this._lastHugeTickGPS = this.currentGPS;
    this._hugeNodeList = [...this._hugeNodeList].filter((entry) => {
      const near =
        gpsRelative(
          this.currentGPS.latitude,
          this.currentGPS.longitude,
          entry.lat,
          entry.lng,
        ).distance < 30;
      if (near) this._destroyNode(entry);
      return !near;
    });
  },
  _gpsToRelative: gpsRelative,
});
