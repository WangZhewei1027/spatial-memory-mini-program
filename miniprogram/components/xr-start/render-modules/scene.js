/** Scene playback has its own loading queue and generation, independent of asset IO. */
function registerScene({ layers, host, staggerMs }) {
  let queue = [], loading = null, nextAt = 0, frameNow = 0;
  const layer = layers.register({ id: "scene", label: "场景", order: 10,
    onPause() { layer.clear("pause"); },
    onReset() { queue = []; loading = null; nextAt = 0; host._cancelScenePreview(); host._clearAssetState(true); },
    onFrame({ dt, now }) {
      frameNow = now;
      host._frameDelta = dt; host.tickModelAnimation("scene");
      if (loading || !queue.length || now < nextAt || !host._arReady) return;
      const asset = queue.shift(), request = { id: asset.id, current: layer.capture() };
      loading = request;
      Promise.resolve().then(() => {
        if (request.current() && host._isAssetPlacementCurrent(asset)) return host._placeSceneAsset(asset);
      }).catch(error => {
        if (request.current()) host.reportAssetError(asset, error);
      }).finally(() => {
        if (loading !== request) return;
        loading = null; nextAt = frameNow + staggerMs;
        if (request.current() && !host._arReady && host._isAssetPlacementCurrent(asset)) queue.unshift(asset);
      });
    },
  });
  return { layer,
    enqueue(assets) {
      const ids = new Set(queue.map(asset => asset.id));
      if (loading) ids.add(loading.id);
      for (const asset of assets) if (!ids.has(asset.id)) { ids.add(asset.id); queue.push(asset); }
    },
    pendingIds: () => [...queue.map(asset => asset.id), ...(loading ? [loading.id] : [])],
    remove(ids) {
      queue = queue.filter(asset => !ids.has(asset.id));
      // The asset's recognition token rejects its eventual async result. Releasing
      // this queue slot lets unrelated GPS scenes continue without clearing the layer.
      if (loading && ids.has(loading.id)) loading = null;
    },
  };
}
module.exports = { registerScene };
