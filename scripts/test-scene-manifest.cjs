const assert = require('node:assert/strict');
const { validateManifest } = require('../miniprogram/lib/scene-runtime/manifest');
const { THREE } = require('../miniprogram/lib/three-runtime/runtime');
const { sceneFarPlane } = require('../miniprogram/lib/three-runtime/camera-clipping');
const { syncVKCamera } = require('../miniprogram/lib/three-runtime/vk-renderer');

const base = id => ({ id, position: [1000, -1000, 0], rotation: [200, -200, 0], scale: [.00001, 200, 1], animation: null });
const manifest = { schemaVersion: 8, resources: {}, content: { kind: 'composition', units: 'meters', loop: false,
  durationSeconds: 100_000, assets: {}, groups: [], instances: [] } };
for (let i = 0; i < 10; i++) {
  manifest.resources[`asset_${i}`] = { kind: i === 0 ? 'audio' : 'model', url: `https://fixture.example/${i}` };
  manifest.content.assets[`asset_${i}`] = { assetId: `asset-${i}` };
}
for (let i = 0; i < 20; i++) manifest.content.groups.push({ ...base(`group_${i}`), name: 'Group', ...(i ? { parent: `group_${i - 1}` } : {}) });
for (let i = 0; i < 25; i++) manifest.content.instances.push({ ...base(`object_${i}`), asset: `asset_${i % 10}` });
Object.assign(manifest.content.instances[0], { parent: 'group_19',
  tracks: { 'position.x': Array.from({ length: 2401 }, (_, i) => ({ time: i, value: i, handles: [.1, -200, .9, 200], connectedRight: true })) },
  timing: { startSeconds: 700, endSeconds: 99_999, fadeInSeconds: 1000, fadeOutSeconds: 1000 },
  media: { trimStartSeconds: 90_000, trimEndSeconds: 99_999, playbackRate: 1, volume: 1, loop: true, muted: false,
    spatial: { enabled: true, refDistance: 200, maxDistance: 20_000, rolloffFactor: 20 } } });
manifest.content.instances[24] = { ...base('text'), text: { content: 'x'.repeat(5000), fontSize: .001, width: 200, color: '#ffffff', align: 'left' } };
assert.equal(validateManifest(manifest).list.length, 25);
const withViewer = structuredClone(manifest);
withViewer.schemaVersion = 9; withViewer.content.viewerPosition = [2, 1.8, 0];
withViewer.content.instances[0].opacity = .7;
withViewer.content.instances[0].tracks.volume = [{ time: 0, value: .5, handles: [0, 0, 1, 1], connectedRight: true }];
assert.equal(validateManifest(withViewer).list.length, 25);
for (const viewerPosition of [undefined, null, [0, 1.5, 0], [0, Infinity, 2], [0, '1.5', 2], [0, 1.5], [0, 1.5, 2, 3]]) {
  const invalid = structuredClone(withViewer); invalid.content.viewerPosition = viewerPosition;
  assert.throws(() => validateManifest(invalid), error => error.kind === 'protocol');
}
const oldViewerProtocol = structuredClone(withViewer); oldViewerProtocol.schemaVersion = 8;
assert.throws(() => validateManifest(oldViewerProtocol), error => error.kind === 'protocol');
for (const edit of [
  data => { data.content.groups[0].parent = 'group_2'; },
  data => { data.content.groups[0].parent = 'missing'; },
  data => { data.content.instances[0].position[0] = Infinity; },
  data => { data.content.instances[0].scale[0] = 0; },
  data => { data.content.instances[0].media.playbackRate = 0; },
  data => { data.content.instances[0].media.playbackRate = 2; },
  data => { data.content.instances[0].media.volume = 2; },
  data => { data.content.instances[0].tracks['position.x'][0].time = -1; },
]) {
  const invalid = structuredClone(manifest); edit(invalid);
  assert.throws(() => validateManifest(invalid), error => error.kind === 'protocol');
}
const scene = new THREE.Group();
const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshBasicMaterial());
mesh.position.set(10_000, 0, 0); mesh.scale.setScalar(1000); scene.add(mesh);
const camera = new THREE.PerspectiveCamera(60, 1, .01, 300);
const far = sceneFarPlane(camera, scene);
assert.ok(far > 11_000);
camera.updateMatrixWorld();
const source = { viewMatrix: camera.matrixWorldInverse.elements, getProjectionMatrix(near, far) {
  return new THREE.PerspectiveCamera(60, 1, near, far).projectionMatrix.elements;
} };
assert.equal(syncVKCamera(camera, source, .01, far), true);
assert.equal(camera.far, far, 'native projection and camera metadata use the same adaptive far plane');
mesh.geometry.dispose(); mesh.material.dispose();
console.log('PASS large manifests, cyclic and invalid input rejection, adaptive native camera clipping');

const { DEFAULT_SCENE_LIGHTING } = require('../miniprogram/lib/three-runtime/runtime').THREE;
const lit = structuredClone(manifest);
lit.schemaVersion = 10; lit.content.lighting = { ...DEFAULT_SCENE_LIGHTING };
assert.doesNotThrow(() => validateManifest(lit));
for (const change of [value => { value.schemaVersion = 8; }, value => { delete value.content.lighting; }, value => { value.content.lighting.environmentIntensity = -1; }, value => { value.content.lighting.url = 'external'; }]) {
  const invalid = structuredClone(lit); change(invalid); assert.throws(() => validateManifest(invalid));
}
console.log('PASS schema 10 lighting validation before native allocations');
