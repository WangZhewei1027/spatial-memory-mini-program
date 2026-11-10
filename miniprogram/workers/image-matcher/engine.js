const factoryFor = require('./vendor/tflite');
const textCodec = require('./vendor/text-codec');
// Workers cannot import lib/; error codes mirror lib/image-matcher/errors.js and
// the I/O shape arrives from lib/image-matcher/spec.js in the init message.
function fail(code, message) { const error = new Error(message); error.code = code; return error; }

function normalize(vector) {
  let norm = 0;
  for (const value of vector) { if (!Number.isFinite(value)) throw fail('INVALID_OUTPUT', '识别模型输出无效'); norm += value * value; }
  if (!(norm > 1e-12)) throw fail('INVALID_OUTPUT', '识别模型输出为空');
  norm = Math.sqrt(norm);
  return Float32Array.from(vector, value => value / norm);
}
async function createEngine({ wasm, wasmPath, modelParts, edge, dimensions, now = () => Date.now() }) {
  if (!(Number.isInteger(edge) && edge > 0 && Number.isInteger(dimensions) && dimensions > 0))
    throw fail('INVALID_INPUT', '识别模型参数无效');
  const factory = factoryFor({ wasm, now, textCodec });
  const module = await new Promise((resolve, reject) => {
    factory({ instantiateWasm(imports, receive) {
      wasm.instantiate(wasmPath, imports).then(result => {
        setTimeout(() => { try { receive(result.instance, result.module); } catch (error) { reject(error); } }, 0);
      }, reject);
      return {};
    } }).then(resolve, reject);
  });
  const size = modelParts.reduce((n, bytes) => n + bytes.byteLength, 0);
  let pointer, runner, input, output;
  try {
    pointer = module._malloc(size);
    if (!pointer) throw fail('INFERENCE_FAILED', '识别模型内存不足');
    let offset = pointer;
    for (const part of modelParts) { module.HEAPU8.set(new Uint8Array(part), offset); offset += part.byteLength; }
    const result = module.TFLiteWebModelRunner.CreateFromBufferAndOptions(pointer, size,
      { numThreads: 1, enableProfiling: false, maxProfilingBufferEntries: 16 });
    try { if (!result.ok()) throw fail('INFERENCE_FAILED', result.errorMessage()); runner = result.value(); }
    finally { result.delete(); }
    const inputs = runner.GetInputs(), outputs = runner.GetOutputs();
    try {
      if (inputs.size() !== 1 || outputs.size() !== 1) throw fail('INFERENCE_FAILED', '识别模型结构不匹配');
      input = inputs.get(0); output = outputs.get(0);
      if (input.shape !== `1,${edge},${edge},3` || input.dataType !== 'float32' || output.shape !== `1,${dimensions}`)
        throw fail('INFERENCE_FAILED', '识别模型维度不匹配');
    } finally { inputs.delete(); outputs.delete(); }
  } catch (error) { input?.delete(); output?.delete(); runner?.delete(); if (pointer) module._free(pointer); throw error; }
  let closed = false;
  return {
    embed(bytes) {
      if (closed) throw fail('CANCELLED', '识别已停止');
      const rgba = new Uint8Array(bytes);
      if (rgba.length !== edge * edge * 4) throw fail('INVALID_INPUT', '识别图像尺寸无效');
      const data = input.data();
      // Model metadata: RGB, mean 0, std 255. Resize is performed by native
      // getCameraBuffer / Canvas before posting; no JPEG encode/decode round trip.
      for (let i = 0, j = 0; i < rgba.length; i += 4) {
        data[j++] = rgba[i] / 255;
        data[j++] = rgba[i + 1] / 255;
        data[j++] = rgba[i + 2] / 255;
      }
      if (!runner.Infer()) throw fail('INFERENCE_FAILED', '图像特征计算失败');
      const vector = output.data();
      if (vector.length !== dimensions) throw fail('INVALID_OUTPUT', '图像特征维度无效');
      return normalize(vector);
    },
    close() { if (closed) return; closed = true; input.delete(); output.delete(); runner.delete(); module._free(pointer); },
  };
}
module.exports = { createEngine, normalize };
