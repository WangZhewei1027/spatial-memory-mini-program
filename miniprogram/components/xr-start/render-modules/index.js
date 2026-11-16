const { registerScene } = require("./scene");
const { registerDanmaku } = require("./danmaku");

/** Feature assembly only. RenderLayers itself has no knowledge of these modules. */
module.exports = (config) => ({
  _attachRenderModules() {
    const layers = this._runtime.layers;
    const world = layers.register({ id: "world", label: "投放", order: 0,
      onResume: () => { this._lastFetchTime = 0; },
      onPause: () => world.clear("pause"),
      onReset: () => this._clearAssetState(false),
      onFrame: ({ dt, camera }) => {
        this._frameDelta = dt;
        if (this.retrievalMode !== "anchor") this.tickRepulsion();
        this.tickAudioVolume(); this.tickModelAnimation("world"); this.tickHugeModels();
        for (const entry of this.nodeList) if (entry.type !== "scene" && entry.billboardEl) entry.billboardEl.lookAt(camera.position);
      },
    });
    const scene = registerScene({ layers, host: this, staggerMs: config.placeStaggerMs });
    const danmaku = registerDanmaku({ layers, config, enabled: !this._scenePreviewMode,
      getLocation: () => this.currentGPS, getStyle: () => this._textAssetStyle,
      onDiscovery: detail => this.triggerEvent("activitiesload", detail),
    });
    const confetti = layers.register({ id: "confetti", label: "彩带", order: 200, depth: "isolated", lit: false, enabled: false,
      onPause: () => this.stopRandomConfetti(), onReset: () => this.stopRandomConfetti(),
      onFrame: ({ dt }) => { this._frameDelta = dt; this.startRandomConfetti(); this.tickConfetti(); },
    });
    this._renderModules = { world, scene, danmaku, confetti };
    this.scene = world.root.parent;
    this.shadowRoot = world.root;
    this._syncRenderModules();
  },
  _syncRenderModules() {
    const modules = this._renderModules;
    if (!modules) return;
    modules.world.setEnabled(!this._scenePreviewMode);
    modules.danmaku.layer.setEnabled(!this._scenePreviewMode);
    modules.confetti.setEnabled(!this._scenePreviewMode && this._confettiEnabled && this.retrievalMode === "gps");
  },
  _getRenderLayer(type) { return type === "scene" ? this._renderModules?.scene.layer : this._renderModules?.world; },
  refreshActivityContent() { return this._renderModules?.danmaku.refresh(); },
  applyActivityAvailability(activities, discoverySequence) {
    return this._runtime?.layers.dispatch("danmaku", "availability", { activities, discoverySequence });
  },
  showDanmakuInXR(text, record) {
    return this._runtime?.layers.dispatch("danmaku", "publish", { text, record });
  },
  onRenderLayersChange(layers) { if (!this._disposed) this.triggerEvent("renderlayers", { layers }); },
  onRenderLayerError({ moduleId, phase, error }) {
    this.reportAssetError({ id: moduleId, file_type: "render-layer" }, new Error(`${moduleId}/${phase}: ${error.message || error}`));
  },
});
