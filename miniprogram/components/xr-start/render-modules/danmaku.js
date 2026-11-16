const { THREE } = require("../../../lib/three-runtime/runtime");
const { createTextAsset } = require("../../../lib/three-runtime/text");
const { disposeTree } = require("../../../lib/three-runtime/resources");
const { createActivitySource } = require("./activity-source");
const createRepulsion = require("../effects/repulsion");

/** Both history and acknowledged live messages belong exclusively to this layer. */
function registerDanmaku({ layers, getLocation, getStyle, onDiscovery, config, enabled = true }) {
  const policy = config.danmaku;
  const entries = new Map(), queue = new Map(), seen = new Map();
  const layout = { nodeList: [], flyingDanmakus: [], _frameDelta: 0 };
  const repulsion = createRepulsion(config);
  let camera, nextPlaceAt = 0, source;
  function remove(id) { const entry = entries.get(id); queue.delete(id); if (entry) layer.remove(entry.node); seen.delete(id); }
  function place(record, live = false) {
    if (!camera || !layer.active || entries.has(record.id)) return false;
    const group = [...entries.values()].filter(entry => entry.live === live);
    const capacity = live ? policy.liveCapacity : policy.historyCapacity;
    if (group.length >= capacity) layer.remove(group[0].node);
    const node = createTextAsset(record.text_content, record.config || {}, getStyle());
    const start = new THREE.Vector3(0, -0.4, 0.3).applyMatrix4(camera.matrixWorld);
    const end = new THREE.Vector3((Math.random() - 0.5) * 3, (Math.random() - 0.5) * 1.2,
      -(policy.minDistance + Math.random() * (policy.maxDistance - policy.minDistance))).applyMatrix4(camera.matrixWorld);
    node.position.copy(live ? start : end);
    if (live) node.scale.setScalar(0.15);
    node.lookAt(camera.position);
    node.userData.activityRecordId = record.id;
    const entry = { node, trs: node, live, text: record.text_content, start, end, age: 0, flying: live };
    entries.set(record.id, entry);
    return layer.mount(node, { dispose() {
      entries.delete(record.id); if (layer.active) seen.set(record.id, Date.now()); disposeTree(node);
    } });
  }
  function replace(records) {
    const next = new Set(records.map(record => record.id));
    for (const id of [...queue.keys(), ...entries.keys()]) if (!next.has(id)) remove(id);
    for (const record of records) {
      const entry = entries.get(record.id);
      if (entry && entry.text !== record.text_content) remove(record.id);
      if (entries.has(record.id) || queue.has(record.id)) continue;
      if (Date.now() - (seen.get(record.id) || 0) < 60000) continue;
      if (queue.size < policy.historyCapacity * 2) queue.set(record.id, record);
    }
  }
  function publish({ text, record }) {
    if (!camera || !record || typeof record.id !== "string" || typeof record.placement_id !== "string") return;
    source.accept(record.id, record.placement_id);
    queue.delete(record.id);
    place({ id: record.id, text_content: text }, true);
  }
  const layer = layers.register({
    id: "danmaku", label: "弹幕", order: 100, depth: "isolated", space: "world", lit: false, enabled,
    actions: { publish, availability: ({ activities, discoverySequence }) => source.applyAvailability(activities, discoverySequence) },
    onFrame(frame) {
      camera = frame.camera;
      if (getLocation()) void source.refresh();
      if (queue.size && frame.now >= nextPlaceAt) {
        const [id, record] = queue.entries().next().value;
        queue.delete(id); place(record); nextPlaceAt = frame.now + policy.placeStaggerMs;
      }
      layout.nodeList.length = 0; layout.flyingDanmakus.length = 0; layout._frameDelta = frame.dt;
      for (const entry of entries.values()) {
        if (entry.flying) {
          entry.age += frame.dt;
          const t = Math.min(1, entry.age / 0.6), ease = 1 - Math.pow(1 - t, 3);
          entry.node.position.lerpVectors(entry.start, entry.end, ease);
          entry.node.scale.setScalar(0.15 + ease * 0.85); entry.flying = t < 1;
          if (entry.flying) layout.flyingDanmakus.push(entry);
        }
        layout.nodeList.push(entry);
      }
      repulsion.tickRepulsion.call(layout);
      for (const entry of entries.values()) entry.node.lookAt(camera.position);
    },
    onPause() { layer.clear("pause"); },
    onReset() {
      source?.reset(); queue.clear(); seen.clear(); nextPlaceAt = 0; camera = null;
      layout.nodeList.length = 0; layout.flyingDanmakus.length = 0;
      if (layout._repTrs) layout._repTrs.length = 0;
    },
    onDispose() { layout.nodeList.length = 0; layout.flyingDanmakus.length = 0; },
  });
  source = createActivitySource({ capture: layer.capture, getLocation, onRecords: replace,
    onRemove: ids => { for (const id of ids) remove(id); }, onDiscovery, maxDistanceMeters: config.maxDistanceMeters });
  return { layer, refresh: source.refresh, replaceRecords: source.replace,
    snapshot: () => ({ records: [...entries.keys()], queued: [...queue.keys()], flying: [...entries.values()].filter(e => e.flying).length }) };
}
module.exports = { registerDanmaku };
