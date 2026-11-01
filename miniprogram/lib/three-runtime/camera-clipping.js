const { THREE } = require('./runtime');

/** Keep the native camera projection wide enough for the current animated content. */
function sceneFarPlane(camera, content, minimum = 300) {
  const bounds = new THREE.Box3().setFromObject(content);
  if (bounds.isEmpty()) return minimum;
  const center = bounds.getCenter(new THREE.Vector3()), radius = bounds.getSize(new THREE.Vector3()).length() / 2;
  const far = camera.position.distanceTo(center) + radius * 1.05;
  return Number.isFinite(far) ? Math.max(minimum, far, camera.near * 2) : Math.max(minimum, camera.far);
}

module.exports = { sceneFarPlane };
