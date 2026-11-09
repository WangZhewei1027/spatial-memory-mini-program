// MediaPipe's browser algorithms are unchanged. Only the loader environment is
// scoped so that the mini program can provide WXWebAssembly and native Canvas.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const esbuild = require('esbuild');
const { useWasmMemoryCopy } = require('./image-match-wasm.cjs');
const root = path.resolve(__dirname, '..');
async function main() {
  const source = path.join(root, 'node_modules/@mediapipe/tasks-vision');
  const target = path.join(root, 'miniprogram/labs/image-match/vendor');
  const wasmTarget = path.join(root, 'miniprogram/labs/image-match-wasm');
  const version = JSON.parse(fs.readFileSync(path.join(source, 'package.json'))).version;
  if (version !== '0.10.21') throw new Error('Revalidate the loader adapter before upgrading MediaPipe');
  fs.mkdirSync(target, { recursive: true });
  fs.mkdirSync(wasmTarget, { recursive: true });
  const sdk = fs.readFileSync(path.join(source, 'vision_bundle.cjs'), 'utf8');
  // The SIMD build returns nearly identical features for unrelated images on
  // the tested iPhone/WeChat runtime. Keep it opt-in for compatibility diagnosis.
  const simd = process.argv.includes('--simd');
  const stem = simd ? 'vision_wasm_internal' : 'vision_wasm_nosimd_internal';
  const memoryExport = simd ? 'Xc' : 'Wc', constructorExport = simd ? 'Yc' : 'Xc';
  const loader = fs.readFileSync(path.join(source, `wasm/${stem}.js`), 'utf8');
  const wrapped = `module.exports = function(platform) {
    const self = {};
    const { TextDecoder, TextEncoder } = platform.textCodec;
    const performance = { now: platform.now };
    const navigator = { userAgent: 'WeChat MiniProgram', platform: '' };
    const window = undefined, document = undefined, process = undefined;
    const WebAssembly = platform.wasm;
    const OffscreenCanvas = platform.Canvas;
    // We supply a WebGL2-only page Canvas; this constructor is only used by
    // Emscripten's legacy WebGL1 instanceof guard and is absent on real phones.
    const WebGLRenderingContext = function() {};
    const WebGL2RenderingContext = function() {};
    const factory = (() => { const module = { exports: {} }; const exports = module.exports;
      ${loader}
      return module.exports;
    })();
    const api = (() => { const module = { exports: {} }; const exports = module.exports;
      ${sdk}
      return module.exports;
    })();
    return { api, prepare(options) {
      self.ModuleFactory = optionsArg => new Promise((resolve, reject) => {
        factory({ ...optionsArg, ...options, instantiateWasm(imports, receive) {
          platform.trace('wasm-instantiate', {});
          platform.wasm.instantiate(platform.wasmPath, imports)
            .then(result => {
              platform.trace('wasm-instantiated', { hasInstance: !!result.instance, hasModule: !!result.module });
              // Leave the native completion callback before calling back into WASM.
              setTimeout(() => {
                try {
                  platform.trace('wasm-receive-start', {});
                  const exports = result.instance.exports;
                  platform.trace('wasm-memory-ready', { bytes: exports.${memoryExport}.buffer.byteLength });
                  const observed = { ...exports, ${constructorExport}: () => {
                    platform.trace('wasm-constructors-start', {});
                    const value = exports.${constructorExport}();
                    platform.trace('wasm-constructors-end', {});
                    return value;
                  }};
                  receive({ exports: observed }, result.module);
                  platform.trace('wasm-receive-end', {});
                } catch (error) { reject(error); }
              }, 0);
            }).catch(reject);
          return {};
        }}).then(result => { platform.trace('module-ready', {}); resolve(result); }, reject);
      });
    }};
  };`;
  esbuild.buildSync({ stdin: { contents: wrapped, resolveDir: root, sourcefile: 'mediapipe-mini-adapter.js' },
    outfile: path.join(target, 'mediapipe.js'), minify: true, target: 'es2020', format: 'cjs',
    legalComments: 'eof' });
  esbuild.buildSync({ entryPoints: [require.resolve('text-encoding')], bundle: true,
    outfile: path.join(target, 'text-codec.js'), minify: true, target: 'es2020', format: 'cjs', legalComments: 'eof' });
  fs.copyFileSync(path.join(root, 'node_modules/text-encoding/LICENSE.md'), path.join(target, 'TEXT-ENCODING-LICENSE.txt'));
  const upstream = fs.readFileSync(path.join(source, `wasm/${stem}.wasm`));
  const upstreamWasmSha256 = crypto.createHash('sha256').update(upstream).digest('hex');
  const expectedHash = simd ? 'f00ec4731faa23b3e714d00e88d4d10e2df5c0a427d3a2b4ae6e3526fdd14ef7'
    : '3821ea9b1f7fb8c549ef2a064ef5c85750bf375c545a49fd6eea0df44a95f1f4';
  if (upstreamWasmSha256 !== expectedHash)
    throw new Error('Upstream WASM changed; revalidate the adapter');
  const nativeCopy = !process.argv.includes('--upstream');
  const binary = nativeCopy ? await useWasmMemoryCopy(upstream, simd ? 'ic' : 'hc') : upstream;
  const wasmSha256 = crypto.createHash('sha256').update(binary).digest('hex');
  let brotli;
  try {
    const cached = fs.readFileSync(path.join(wasmTarget, 'vision.wasm.br'));
    if (crypto.createHash('sha256').update(zlib.brotliDecompressSync(cached)).digest('hex') === wasmSha256) brotli = cached;
  } catch { /* Rebuild when absent or corrupt. */ }
  brotli ||= zlib.brotliCompressSync(binary, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } });
  if (brotli.length > 2 * 1024 * 1024 - 4096) throw new Error('MediaPipe WASM exceeds the dedicated subpackage budget');
  fs.writeFileSync(path.join(wasmTarget, 'vision.wasm.br'), brotli);
  const info = { version, simd, wasmBytes: binary.length, brotliBytes: brotli.length,
    upstreamWasmSha256, wasmAdapter: nativeCopy ? 'WASM memory.copy replaces Emscripten JS memcpy' : 'upstream unchanged',
    adapterSha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(target, 'mediapipe.js'))).digest('hex'),
    wasmSha256, textCodec: 'text-encoding@0.7.0 (scoped UTF-8 / UTF-16LE compatibility)',
    adapter: 'scoped WXWebAssembly loader; original MediaPipe graph/model/inference',
    source: 'https://github.com/google-ai-edge/mediapipe', license: 'Apache-2.0' };
  fs.writeFileSync(path.join(target, 'build-info.js'), `module.exports = ${JSON.stringify(info, null, 2)};\n`);
  console.log(info);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
