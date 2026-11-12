// Emscripten passes its entire WASM heap plus a destination offset to WebGL2.
// Use an explicit, tightly sized buffer at the native mini-program boundary.
function adaptReadPixels(gl, log = () => {}) {
  const original = gl.readPixels;
  let probes = 0;
  gl.readPixels = function(...args) {
    const [x, y, width, height, format, type, destination, offset] = args;
    if (args.length !== 8 || !ArrayBuffer.isView(destination)) return original.apply(this, args);
    const channels = { 6403: 1, 33319: 2, 6407: 3, 6408: 4, 36244: 1, 33320: 2, 36248: 3, 36249: 4 }[format];
    if (!channels) throw new Error(`未适配的 WebGL readPixels 格式 ${format}`);
    const pixels = new destination.constructor(width * height * channels);
    original.call(this, x, y, width, height, format, type, pixels);
    destination.set(pixels, offset);
    if (probes++ < 2) {
      let min = Infinity, max = -Infinity, sum = 0;
      for (let i = 0; i < pixels.length; i++) { min = Math.min(min, pixels[i]); max = Math.max(max, pixels[i]); sum += pixels[i]; }
      log('gl-readback', { width, height, format, type, offset, bytes: pixels.byteLength, min, max, mean: sum / pixels.length });
    }
  };
  return () => { gl.readPixels = original; };
}
module.exports = { adaptReadPixels };
