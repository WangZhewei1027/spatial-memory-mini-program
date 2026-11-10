// Single source for model I/O shape and packaged asset paths, derived from the
// generated build-info. Callers must not hard-code 224 / 1024 or package paths.
const info = require('./build-info');

const [batch, height, width, channels] = info.input;
if (batch !== 1 || channels !== 3 || width !== height) throw new Error('Unsupported image matcher input shape');

module.exports = Object.freeze({
  INPUT_EDGE: width,
  // Camera and reference pixels are RGBA; the worker drops alpha.
  RGBA_BYTES: width * height * 4,
  DIMENSIONS: info.output,
  MODEL_BYTES: info.modelBytes,
  WASM_PATH: info.wasmPath,
  MODEL_PATHS: Object.freeze([...info.modelPaths]),
});
