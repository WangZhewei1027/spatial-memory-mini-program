// Request/response shaping for the nearby-target and content APIs.
// Pure functions: the backend CONFIG is passed in by the caller.
const MAX_CANDIDATES = 200; // Server-side limit; a larger list is a protocol error.

function referenceScope(config) {
  return JSON.stringify([config.organizationId || '', config.workspaceId || '']);
}
function gpsBody(config, gps) {
  return { workspace_id: config.workspaceId, latitude: gps.latitude, longitude: gps.longitude,
    accuracy: gps.accuracy, gps_timestamp: gps.sampledAt, coordinate_system: 'wgs84' };
}
function checked(response) {
  if (response.statusCode !== 200) throw new Error(response.data?.error || '请求失败，请重新扫描');
  return response.data;
}
function candidatesFrom(data) {
  if (!Array.isArray(data?.candidates) || data.candidates.length > MAX_CANDIDATES) throw new Error('识别目标数据无效');
  const ids = new Set();
  for (const item of data.candidates) {
    if (!item || typeof item.id !== 'string' || !item.id || ids.has(item.id) ||
        typeof item.name !== 'string' || typeof item.image_url !== 'string' || !/^https?:\/\//.test(item.image_url) ||
        typeof item.reference_version !== 'string' || !item.reference_version)
      throw new Error('识别目标数据无效');
    ids.add(item.id);
  }
  return data.candidates;
}
const CONTENT_TYPES = ['text', 'image', 'model', 'audio', 'video', 'scene'];
function contentFrom(data, anchorId) {
  if (data?.anchor?.id !== anchorId || !Array.isArray(data.assets)) throw new Error('目标内容数据无效，请重新扫描');
  return data.assets.filter(a => a && typeof a.id === 'string' && CONTENT_TYPES.includes(a.file_type));
}
module.exports = { referenceScope, gpsBody, checked, candidatesFrom, contentFrom };
