// Run the pinned MediaPipe MobileNet model on a CPU-only TFLite interpreter.
// Unlike Tasks Vision's browser graph, this entry has no Canvas/WebGL dependency.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const esbuild = require('esbuild');
const { useWasmMemoryCopy } = require('./image-match-wasm.cjs');
const root = path.resolve(__dirname, '..');
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const modelHash = 'bbbb4c51a55a53905af1daec995ca1aae355046f8839bb8c9f5ce9271394bc40';
const modelURL = 'https://storage.googleapis.com/mediapipe-models/image_embedder/mobilenet_v3_small/float32/1/mobilenet_v3_small.tflite';
function replaceFunction(source, name, definition) {
  const pattern = new RegExp(`^    function ${name}\\([^]*?^    }`, 'm');
  if (!pattern.test(source)) throw new Error(`Pinned loader changed: ${name}`);
  return source.replace(pattern, definition);
}
async function main() {
  const pkg = path.dirname(require.resolve('@tensorflow/tfjs-tflite/package.json'));
  if (JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'))).version !== '0.0.1-alpha.10') throw new Error('Revalidate TFLite before upgrading');
  let loader = esbuild.transformSync(fs.readFileSync(path.join(pkg, 'wasm/tflite_web_api_cc.js'), 'utf8'), { minify: false }).code;
  // Emscripten's dynamic embind wrappers are replaced by equivalent closures.
  // Mini-programs cannot evaluate generated JavaScript. No inference math changes.
  loader = replaceFunction(loader, 'createNamedFunction', `function createNamedFunction(name, body) { return function() { return body.apply(this, arguments); }; }`);
  loader = replaceFunction(loader, 'craftInvokerFunction', `function craftInvokerFunction(humanName, argTypes, classType, invoke, target) {
    const method = argTypes[1] !== null && classType !== null;
    const stacked = argTypes.slice(1).some(t => t && t.destructorFunction === undefined);
    return function(...args) {
      if (args.length !== argTypes.length - 2) throwBindingError(humanName + ': invalid argument count');
      const destructors = stacked ? [] : null, wired = [], types = [];
      if (method) { wired.push(argTypes[1].toWireType(destructors, this)); types.push(argTypes[1]); }
      args.forEach((a,i) => { wired.push(argTypes[i+2].toWireType(destructors, a)); types.push(argTypes[i+2]); });
      const result = invoke(target, ...wired);
      if (stacked) runDestructors(destructors);
      else types.forEach((t,i) => { if (t.destructorFunction) t.destructorFunction(wired[i]); });
      return argTypes[0].name === 'void' ? undefined : argTypes[0].fromWireType(result);
    };
  }`);
  loader = replaceFunction(loader, '__emval_get_method_caller', `function __emval_get_method_caller(count, pointers) {
    const types = emval_lookupTypes(count, pointers);
    return emval_addMethodCaller(function(handle, name, destructors, pointer) {
      const args = [];
      for (let i=1;i<count;i++) { args.push(types[i].readValueFromPointer(pointer)); pointer += types[i].argPackAdvance; }
      const result = handle[name](...args);
      args.forEach((a,i) => { if (types[i+1].deleteObject) types[i+1].deleteObject(a); });
      return types[0].isVoid ? undefined : types[0].toWireType(destructors, result);
    });
  }`);
  loader = replaceFunction(loader, 'craftEmvalAllocator', `function craftEmvalAllocator(count) {
    return function(constructor, pointers, pointer) {
      const args = [];
      for (let i=0;i<count;i++) { const type = requireRegisteredType(HEAPU32[pointers >> 2], 'parameter');
        args.push(type.readValueFromPointer(pointer)); pointer += type.argPackAdvance; pointers += 4; }
      return Emval.toHandle(new constructor(...args));
    };
  }`);
  if (/new Function\(|new_\(Function/.test(loader)) throw new Error('Dynamic code remains in loader');
  const vendor = path.join(root, 'miniprogram/workers/image-matcher/vendor');
  fs.mkdirSync(vendor, { recursive: true });
  esbuild.buildSync({ stdin: { contents: `module.exports = function(platform) {
    const window = undefined, document = undefined, process = undefined, importScripts = undefined;
    const self = {}, WebAssembly = platform.wasm, performance = { now: platform.now };
    const { TextDecoder, TextEncoder } = platform.textCodec;
    const module = { exports: {} }, exports = module.exports;
    ${loader}
    return module.exports;
  };`, resolveDir: root }, outfile: path.join(vendor, 'tflite.js'), minify: true, target: 'es2020', format: 'cjs', legalComments: 'eof' });
  esbuild.buildSync({ entryPoints: [require.resolve('text-encoding')], bundle: true, outfile: path.join(vendor, 'text-codec.js'), minify: true, target: 'es2020', format: 'cjs', legalComments: 'eof' });
  const upstream = fs.readFileSync(path.join(pkg, 'wasm/tflite_web_api_cc.wasm'));
  if (hash(upstream) !== 'f1eb42f96ae91e5ef34e2f833f011373ca1c40fdc9d4062ec21eb07b886ea54f') throw new Error('Pinned TFLite WASM changed');
  const wasm = await useWasmMemoryCopy(upstream, 'X');
  const brotli = zlib.brotliCompressSync(wasm, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } });
  const modelPath = path.join(root, '.cache/image-match/model.tflite');
  if (!fs.existsSync(modelPath)) { const response = await fetch(modelURL); if (!response.ok) throw new Error('Model download failed'); fs.mkdirSync(path.dirname(modelPath), { recursive: true }); fs.writeFileSync(modelPath, Buffer.from(await response.arrayBuffer())); }
  const model = fs.readFileSync(modelPath);
  if (hash(model) !== modelHash) throw new Error('MediaPipe model hash mismatch');
  const packages = [ ['image-match-runtime', 'inference.wasm.br', brotli],
    ['image-match-model-a', 'model.bin', model.subarray(0, 2058835)], ['image-match-model-b', 'model.bin', model.subarray(2058835)] ];
  for (const [name, filename, data] of packages) {
    if (data.length > 2*1024*1024-4096) throw new Error(name + ' exceeds package budget');
    const dir = path.join(root, 'miniprogram/packages', name); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, filename), data);
    fs.writeFileSync(path.join(dir, 'index.js'), 'Page({});\n');
    fs.writeFileSync(path.join(dir, 'index.json'), '{}\n');
    fs.writeFileSync(path.join(dir, 'index.wxml'), '<view />\n');
    fs.writeFileSync(path.join(dir, 'ready.js'), 'module.exports = true;\n');
  }
  const notices = path.join(root, 'miniprogram/packages/image-match-runtime');
  fs.copyFileSync(path.join(root, 'miniprogram/labs/image-match/vendor/MEDIAPIPE-LICENSE.txt'), path.join(notices, 'APACHE-2.0.txt'));
  fs.copyFileSync(path.join(root, 'node_modules/text-encoding/LICENSE.md'), path.join(notices, 'TEXT-ENCODING-LICENSE.txt'));
  fs.writeFileSync(path.join(notices, 'NOTICE.txt'), `TFLite runtime: @tensorflow/tfjs-tflite@0.0.1-alpha.10 (Google, Apache-2.0).\nSource: https://github.com/tensorflow/tfjs/tree/master/tfjs-tflite\nAdaptations: static embind closures, scoped WXWebAssembly loader, WASM memory.copy.\nMediaPipe model (unchanged): ${modelURL}\nModel SHA-256: ${modelHash}\nText encoding: text-encoding@0.7.0; see TEXT-ENCODING-LICENSE.txt.\n`);
  const info = { runtime: '@tensorflow/tfjs-tflite@0.0.1-alpha.10', model: modelURL, modelSha256: modelHash,
    modelBytes: model.length, simd: false, threads: 1, input: [1,224,224,3], output: 1024,
    normalization: 'RGB / 255 (model metadata: mean 0, std 255)', wasmSha256: hash(wasm), upstreamWasmSha256: hash(upstream),
    wasmBytes: wasm.length, brotliBytes: brotli.length, adapter: 'static embind closures; WXWebAssembly; WASM memory.copy',
    wasmPath: 'packages/image-match-runtime/inference.wasm.br',
    modelPaths: packages.filter(([, filename]) => filename === 'model.bin').map(([name, filename]) => `packages/${name}/${filename}`) };
  fs.writeFileSync(path.join(root, 'miniprogram/lib/image-matcher/build-info.js'), `module.exports = ${JSON.stringify(info, null, 2)};\n`);
  console.log(info);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
