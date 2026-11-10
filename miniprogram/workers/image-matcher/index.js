const { createEngine } = require('./engine');
let engine;
// The caller sends at most one request at a time. Inference is synchronous here,
// on the worker thread, never on the camera/rendering thread.
worker.onMessage(async message => {
  const { id, type } = message;
  try {
    if (type === 'init') {
      if (engine) throw Object.assign(new Error('识别模型已初始化'), { code: 'WORKER_FAILED' });
      engine = await createEngine({ wasm: WXWebAssembly, wasmPath: message.wasmPath, modelParts: message.modelParts,
        edge: message.edge, dimensions: message.dimensions });
      worker.postMessage({ id, ok: true });
    } else if (type === 'embed') {
      if (!engine) throw Object.assign(new Error('识别模型未就绪'), { code: 'WORKER_FAILED' });
      const started = Date.now(), vector = engine.embed(message.pixels);
      worker.postMessage({ id, ok: true, vector: vector.buffer, inferenceMs: Date.now() - started });
    } else throw Object.assign(new Error('识别任务无效'), { code: 'WORKER_FAILED' });
  } catch (error) {
    worker.postMessage({ id, ok: false, code: error.code || 'INFERENCE_FAILED', error: error.message || String(error) });
  }
});
