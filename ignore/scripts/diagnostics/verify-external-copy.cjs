const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path'), zlib = require('node:zlib'), crypto = require('node:crypto');
const root = path.resolve(__dirname, '../../..');
const file = path.join(root, 'node_modules/@mediapipe/tasks-vision/wasm/vision_wasm_internal');
async function initialize(external) {
  class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : [0])); } static now() { return 0; } }
  const context = vm.createContext({ module: { exports: {} }, WebAssembly, Date: FixedDate,
    TextEncoder, TextDecoder, performance: { now: () => 0 }, console, setTimeout, clearTimeout, setInterval, clearInterval });
  context.exports = context.module.exports;
  vm.runInContext(fs.readFileSync(file + '.js', 'utf8'), context);
  let copyFunction, callbacks = 0;
  const module = await context.module.exports({ instantiateWasm(imports, receive) {
    const original = imports.a.ic;
    imports.a.ic = (...args) => { callbacks++; return external ? copyFunction(...args) : original(...args); };
    WebAssembly.instantiate(fs.readFileSync(file + '.wasm'), imports).then(async ({ instance }) => {
      if (external) {
        const helper = await WebAssembly.instantiate(zlib.brotliDecompressSync(fs.readFileSync(path.join(root, 'ignore/labs/image-match/memory-copy.wasm.br'))), { env: { memory: instance.exports.Xc } });
        copyFunction = helper.instance.exports.copy;
      }
      receive(instance);
    });
    return {};
  } });
  return { heapBytes: module.HEAPU8.length, sha256: crypto.createHash('sha256').update(module.HEAPU8).digest('hex'), callbacks };
}
(async () => {
  const original = await initialize(false), external = await initialize(true);
  console.log(JSON.stringify({ original, external, identical: original.sha256 === external.sha256 }));
  if (original.sha256 !== external.sha256) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
