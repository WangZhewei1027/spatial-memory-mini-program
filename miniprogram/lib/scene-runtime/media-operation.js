// Native decoder promises occasionally never settle on teardown/unsupported SDKs.
// Bound each operation so a failed source cannot retain the whole scene forever.
function mediaOperation(operation, label, timeoutMs = 15000, onCancel = () => () => {}) {
  return new Promise((resolve, reject) => {
    let settled = false, unregister = () => {};
    const timer = setTimeout(() => finish(reject, new Error(`${label}超时`)), timeoutMs);
    function finish(callback, value) { if (settled) return; settled = true; clearTimeout(timer); unregister(); callback(value); }
    unregister = onCancel(() => finish(reject, new Error(`${label}已取消`)));
    if (settled) unregister();
    Promise.resolve(operation).then(value => finish(resolve, value), error => finish(reject, error));
  });
}
function releaseNative(target, methods) {
  for (const method of methods) {
    try { const result = target?.[method]?.(); if (result?.catch) result.catch(() => {}); } catch (_) {}
  }
}
module.exports = { mediaOperation, releaseNative };
