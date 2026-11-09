const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const base = '../miniprogram/labs/image-match/';
const { cosine, rank, dimensions, orderFor, runPair, summarize } = require(base + 'benchmark');
const { captureVariants } = require(base + 'capture');
const { createClock } = require(base + 'clock');
const { withTimeout } = require(base + 'timeout');
const { adaptReadPixels } = require(base + 'webgl-transfers');

test('camera benchmark waits for visible content and rejects persistently dark input', async () => {
  const vm = require('node:vm');
  let definition, clock = 0;
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, base + 'index.js'), 'utf8'), {
    require: name => name === './engine' ? { now: () => clock }
      : name === './images' ? { pixelSummary: pixels => pixels } : {},
    Page: value => { definition = value; }, setTimeout: callback => { clock += 200; callback(); },
  });
  const dark = { min: 0, max: 1, stddev: 0.1 }, visible = { min: 10, max: 220, stddev: 50 };
  let captures = 0;
  const page = { ...definition, setData() {},
    async nextFrame() { captures++; return { 'rgba-full': { pixels: captures < 3 ? dark : visible } }; },
  };
  const frame = await page.nextUsableFrame(['rgba-full'], () => true);
  assert.equal(captures, 3); assert.equal(frame.pixels, visible);
  page.nextFrame = async () => ({ 'rgba-full': { pixels: dark } });
  await assert.rejects(page.nextUsableFrame(['rgba-full'], () => true), /画面过暗/);
  await assert.rejects(page.nextUsableFrame(['rgba-full'], () => false), /取消/);
});

test('album selection survives page hide and imports into the replacement engine', async () => {
  const vm = require('node:vm');
  for (const readyBeforePicker of [false, true]) {
    let definition, selected, oldClosed = false;
    vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, base + 'index.js'), 'utf8'), {
      require: () => ({}), Page: value => { definition = value; },
      wx: { chooseMedia: options => { selected = options.success; } },
    });
    const page = { ...definition, data: { ready: true }, _active: true, _dead: false,
      _generation: 0, _references: [], _autoCameraBenchStarted: true,
      _engine: { close() { oldClosed = true; } }, stopCamera() {},
      setData(values) { Object.assign(this.data, values); },
    };
    const choosing = page.chooseReferences();
    page.onHide();
    assert.equal(oldClosed, true);
    assert.equal(page._autoCameraBenchStarted, false);
    const imported = [];
    function resume() {
      page._active = true;
      page._engine = { embed(canvas) { imported.push(canvas); return [1, 0]; } };
      page._processor = { fromPath: async path => path };
      page.data.ready = true;
    }
    if (readyBeforePicker) resume();
    selected({ tempFiles: [{ tempFilePath: 'chosen.jpg' }] });
    await choosing;
    if (!readyBeforePicker) {
      assert.equal(imported.length, 0);
      resume();
      await page.importPendingReferences(page._generation);
    }
    assert.deepEqual(imported, ['chosen.jpg']);
    assert.equal(page._references.length, 1);
    assert.equal(page.data.busy, false);
  }
});

test('WebGL heap-offset readback uses a bounded native buffer and preserves surrounding memory', () => {
  const heap = new Float32Array(1000).fill(-9);
  const gl = { readPixels(...args) {
    assert.equal(args.length, 7);
    assert.equal(args[6].length, 8);
    args[6].set([1,2,3,4,5,6,7,8]);
  } };
  const original = gl.readPixels, restore = adaptReadPixels(gl);
  gl.readPixels(0,0,2,1,6408,5126,heap,123);
  assert.deepEqual([...heap.slice(123,131)], [1,2,3,4,5,6,7,8]);
  assert.equal(heap[122], -9); assert.equal(heap[131], -9);
  restore(); assert.equal(gl.readPixels, original);
});

test('stalled asynchronous initialization rejects and closes a late engine', async () => {
  let finish, disposed = false;
  const pending = new Promise(resolve => { finish = resolve; });
  await assert.rejects(withTimeout(pending, 5, '初始化超时', engine => engine.close()), /初始化超时/);
  finish({ close() { disposed = true; } });
  await Promise.resolve();
  assert.equal(disposed, true);
});

test('timer uses a stable origin and tolerates backwards devtools jitter', () => {
  const values = [10, 10.9, 10.8, 11];
  const now = createClock({ now: () => values.shift() });
  assert.deepEqual([now(), now(), now(), now()], [10, 10.9, 10.9, 11]);
});
test('bundled codecs cover MediaPipe UTF-8 and Emscripten UTF-16 without native text globals', () => {
  const vm = require('node:vm');
  const context = vm.createContext({ module: { exports: {} } });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, base + 'vendor/text-codec.js'), 'utf8'), context);
  const { TextDecoder: Decoder, TextEncoder: Encoder } = context.module.exports;
  const value = '空间图像 🏠';
  const encoded = new Encoder().encode(value);
  assert.equal(new Decoder('utf-8', { fatal: true }).decode(encoded), value);
  assert.deepEqual([...encoded], [...new TextEncoder().encode(value)]);
  const utf16 = vm.runInContext(`new Uint8Array(${JSON.stringify([...Buffer.from(value, 'utf16le')])})`, context);
  assert.equal(new Decoder('utf-16le').decode(utf16), value);
  assert.throws(() => new Decoder('utf-8', { fatal: true }).decode(vm.runInContext('new Uint8Array([128])', context)));
});

test('similarity preserves identity, ordering and rejects corrupt/incompatible vectors', () => {
  assert.equal(cosine([3,4], [6,8]), 1);
  assert.equal(cosine([1,0], [0,1]), 0);
  assert.equal(cosine([1,0], [-1,0]), -1);
  assert.throws(() => cosine([0,0], [1,0]));
  assert.throws(() => cosine([NaN], [1]));
  assert.throws(() => cosine([1,2], [1]));
  assert.deepEqual(rank([1,0], [{ id:'b',vector:[0,1] },{ id:'a',vector:[1,0] }]).map(r=>r.id), ['a','b']);
});
test('capture owns native buffers and consumes one frame synchronously', () => {
  let clock = 0, valid = true;
  const buffers = [];
  const frame = { getCameraBuffer(w,h) { assert.ok(valid); clock += 2; const b = new Uint8Array(w*h*4).fill(12); buffers.push(b); return b.buffer; },
    getCameraJpgBuffer() { assert.ok(valid); clock += 4; const b = new Uint8Array([255,216,255]); buffers.push(b); return b.buffer; } };
  const snapshots = captureVariants(frame, 720, 960, ()=>clock);
  valid = false; buffers.forEach(b=>b.fill(0));
  assert.equal(snapshots['rgba-full'].pixels[0],12);
  assert.equal(snapshots['jpeg-small'].jpeg[0],255);
  assert.equal(snapshots['jpeg-small'].captureMs,4);
  assert.deepEqual(dimensions(720,960,640), { width:480,height:640 });
});
test('invalid native JPEG falls back to owned RGBA and records the selected converter', () => {
  const snapshots = captureVariants({ getCameraJpgBuffer: ()=>new Uint8Array([0,0]).buffer,
    getCameraBuffer: (w,h)=>new Uint8Array(w*h*4).buffer },32,32,()=>0,['jpeg-small']);
  assert.equal(snapshots['jpeg-small'].converter,'visionkit-rgba-canvas-jpeg');
  assert.equal(snapshots['jpeg-small'].pixels.byteLength,4096);
  assert.ok(snapshots['jpeg-small'].jpegError);
});
test('paired benchmark includes all per-path costs, rotates order and excludes warmup', async () => {
  let clock=0;
  const references=[{id:'a', name:'A', vector:[1,0]}];
  const snapshots=Object.fromEntries(orderFor(0).map(mode=>[mode,{mode,width:32,height:32,pixels:new Uint8Array(4096),captureMs:3}]));
  const processor={prepare:async snapshot=>({canvas:snapshot,timings:{prepareMs:2,encodeMs:snapshot.mode==='jpeg-small'?7:0,decodeMs:snapshot.mode==='jpeg-small'?8:0}})};
  const engine={embed:()=>{clock+=11;return [1,0];}};
  const rows=await runPair({snapshots,order:orderFor(1),processor,engine,references,now:()=>clock,current:()=>true,warmup:false});
  assert.deepEqual(rows.map(r=>r.mode),['rgba-small','jpeg-small','rgba-full']);
  assert.equal(rows.find(r=>r.mode==='jpeg-small').totalMs,31);
  assert.equal(rows.find(r=>r.mode==='rgba-full').totalMs,16);
  const summary=summarize([...rows,...rows.map(r=>({...r,warmup:true,totalMs:999}))]);
  assert.equal(summary[0].samples,1); assert.equal(summary[0].totalMs.p50,16);
  assert.ok(rows.every(r=>r.embeddingCosineToRaw===1));
});
test('cancellation after asynchronous preprocessing prevents inference and subsequent work', async () => {
  let active=true, inferred=false;
  await assert.rejects(runPair({snapshots:{'rgba-full':{}},order:['rgba-full'],
    processor:{prepare:async()=>{active=false;return {canvas:{},timings:{}};}},
    engine:{embed(){inferred=true;}},references:[],now:()=>0,current:()=>active,warmup:false}),/取消/);
  assert.equal(inferred,false);
});
test('bundled WASM matches its build manifest and fits its subpackage', () => {
  const root=path.resolve(__dirname,'../miniprogram/labs/image-match-wasm');
  const build=require(base+'vendor/build-info');
  assert.equal(build.upstreamWasmSha256, build.simd === false
    ? '3821ea9b1f7fb8c549ef2a064ef5c85750bf375c545a49fd6eea0df44a95f1f4'
    : 'f00ec4731faa23b3e714d00e88d4d10e2df5c0a427d3a2b4ae6e3526fdd14ef7');
  const br=fs.readFileSync(path.join(root,'vision.wasm.br'));
  assert.equal(crypto.createHash('sha256').update(zlib.brotliDecompressSync(br)).digest('hex'),build.wasmSha256);
  assert.ok(fs.readdirSync(root).reduce((sum,name)=>sum+fs.statSync(path.join(root,name)).size,0)<2*1024*1024);
});

test('native memcpy preserves both real WASM heaps and removes JS copy callbacks', async () => {
  const vm = require('node:vm');
  const { useWasmMemoryCopy } = require('./image-match-wasm.cjs');
  const codec = fs.readFileSync(path.resolve(__dirname, base + 'vendor/text-codec.js'), 'utf8');
  async function initialize(bytes, loader, copyImport) {
    class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : [0])); } static now() { return 0; } }
    const context = vm.createContext({ module: { exports: {} }, WebAssembly, Date: FixedDate,
      performance: { now: () => 0 }, console, setTimeout, clearTimeout, setInterval, clearInterval });
    vm.runInContext(codec, context);
    context.TextDecoder = context.module.exports.TextDecoder;
    context.TextEncoder = context.module.exports.TextEncoder;
    context.module = { exports: {} }; context.exports = context.module.exports;
    vm.runInContext(loader, context);
    let instantiated, copies = 0;
    const ready = context.module.exports({ instantiateWasm(imports, receive) {
      const copy = imports.a[copyImport];
      imports.a[copyImport] = (...args) => { copies++; return copy(...args); };
      instantiated = WebAssembly.instantiate(bytes, imports).then(({ instance }) => receive(instance));
      return {};
    } });
    const [module] = await Promise.all([ready, instantiated]);
    return { heapHash: crypto.createHash('sha256').update(module.HEAPU8).digest('hex'), copies };
  }
  for (const [stem, copyImport] of [['vision_wasm_internal', 'ic'], ['vision_wasm_nosimd_internal', 'hc']]) {
    const source = path.resolve(__dirname, '../node_modules/@mediapipe/tasks-vision/wasm', stem);
    const upstream = fs.readFileSync(source + '.wasm');
    const loader = fs.readFileSync(source + '.js', 'utf8');
    const optimized = await useWasmMemoryCopy(upstream, copyImport);
    const original = await initialize(upstream, loader, copyImport);
    const adapted = await initialize(optimized, loader, copyImport);
    assert.equal(original.copies, 409, stem);
    assert.equal(adapted.copies, 0, stem);
    assert.equal(adapted.heapHash, original.heapHash, stem);
  }
});
