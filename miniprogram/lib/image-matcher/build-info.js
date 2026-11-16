module.exports = {
  "runtime": "@tensorflow/tfjs-tflite@0.0.1-alpha.10",
  "model": "https://storage.googleapis.com/mediapipe-models/image_embedder/mobilenet_v3_small/float32/1/mobilenet_v3_small.tflite",
  "modelSha256": "bbbb4c51a55a53905af1daec995ca1aae355046f8839bb8c9f5ce9271394bc40",
  "modelBytes": 4117670,
  "simd": false,
  "threads": 1,
  "input": [
    1,
    224,
    224,
    3
  ],
  "output": 1024,
  "normalization": "RGB / 255 (model metadata: mean 0, std 255)",
  "wasmSha256": "d173b90aaeba5f2eac30d2592770ea49c956ac2f7134a04725b602566c8bf869",
  "upstreamWasmSha256": "f1eb42f96ae91e5ef34e2f833f011373ca1c40fdc9d4062ec21eb07b886ea54f",
  "wasmBytes": 3592024,
  "brotliBytes": 868115,
  "adapter": "static embind closures; WXWebAssembly; WASM memory.copy",
  "wasmPath": "packages/image-match-runtime/inference.wasm.br",
  "modelPaths": [
    "packages/image-match-model-a/model.bin",
    "packages/image-match-model-b/model.bin",
    "packages/image-match-model-c/model.bin"
  ]
};
