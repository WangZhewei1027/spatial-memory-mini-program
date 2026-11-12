// Adapted from the SAGE capture path in commit 91a1e16^:
// frame.getCameraJpgBuffer -> getCameraBuffer + Canvas JPEG fallback.
// Native VKFrame/texture objects NEVER survive this synchronous call.
const { dimensions, MODES } = require('./benchmark');
function captureVariants(frame, width, height, now, order = MODES, edge = 640) {
  const output = {};
  for (const mode of order) {
    const size = dimensions(width, height, mode === 'rgba-full' ? Infinity : edge);
    const started = now();
    let jpeg, pixels, converter = 'visionkit-rgba', jpegError;
    if (mode === 'jpeg-small' && typeof frame.getCameraJpgBuffer === 'function') {
      try {
        const buffer = frame.getCameraJpgBuffer(size.width, size.height, 80);
        const bytes = buffer && new Uint8Array(buffer);
        if (!bytes || bytes.length < 3 || bytes[0] !== 255 || bytes[1] !== 216) throw new Error('原生 JPEG 无效');
        jpeg = bytes.slice(); converter = 'visionkit-jpeg';
      } catch (e) { jpegError = e.message || String(e); }
    }
    if (!jpeg) {
      const buffer = frame.getCameraBuffer(size.width, size.height);
      if (!buffer || buffer.byteLength !== size.width * size.height * 4) throw new Error('相机 RGBA 尺寸异常');
      pixels = new Uint8Array(buffer).slice();
      if (mode === 'jpeg-small') converter = 'visionkit-rgba-canvas-jpeg';
    }
    output[mode] = { mode, ...size, jpeg, pixels, converter, jpegError, captureMs: now() - started };
  }
  return output;
}
module.exports = { captureVariants };
