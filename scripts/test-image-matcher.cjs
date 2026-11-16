const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const root = path.resolve(__dirname, '../miniprogram');
const info = require('../miniprogram/lib/image-matcher/build-info');
const spec = require('../miniprogram/lib/image-matcher/spec');
const errors = require('../miniprogram/lib/image-matcher/errors');
const { similarity: cosine } = require('../miniprogram/lib/image-matcher/policy');
const { createEngine, normalize } = require('../miniprogram/workers/image-matcher/engine');
const flush = () => new Promise(resolve => setImmediate(resolve));
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const modelParts = spec.MODEL_PATHS.map(file => fs.readFileSync(path.join(root, file)));
const model = Buffer.concat(modelParts);
const wasm = zlib.brotliDecompressSync(fs.readFileSync(path.join(root, spec.WASM_PATH)));

test('bundled production model and scalar WASM are pinned and each subpackage fits', () => {
  assert.equal(info.simd,false); assert.equal(info.threads,1);
  assert.equal(hash(model),info.modelSha256);assert.equal(hash(wasm),info.wasmSha256);
  assert.ok(info.brotliBytes < 1.5*1024*1024-4096);
  for(const file of spec.MODEL_PATHS)assert.ok(fs.statSync(path.join(root,file)).size<1.5*1024*1024-4096);
  assert.ok(!/new Function\(|new_\(Function/.test(fs.readFileSync(path.join(root,'workers/image-matcher/vendor/tflite.js'),'utf8')));
});
test('client package loads, app.json subpackages and spec paths describe the same files', () => {
  const source=fs.readFileSync(path.join(root,'lib/image-matcher/client.js'),'utf8');
  const loaded=[...source.matchAll(/require\.async\('\.\.\/\.\.\/(packages\/[^/]+)\/ready\.js'\)/g)].map(m=>m[1]).sort();
  const expected=[...new Set([spec.WASM_PATH,...spec.MODEL_PATHS].map(file=>file.split('/').slice(0,2).join('/')))].sort();
  assert.deepEqual(loaded,expected);
  const roots=JSON.parse(fs.readFileSync(path.join(root,'app.json'),'utf8')).subpackages.map(p=>p.root);
  for(const pkg of expected)assert.ok(roots.includes(pkg),`${pkg} must be a subpackage`);
  assert.equal(spec.RGBA_BYTES,info.input[1]*info.input[2]*4);assert.equal(spec.DIMENSIONS,info.output);
});
test('production Worker codecs support UTF without legacy encoding tables or native text globals', () => {
  const code = fs.readFileSync(path.join(root, 'workers/image-matcher/vendor/text-codec.js'), 'utf8');
  assert.ok(Buffer.byteLength(code) < 32 * 1024, 'unused legacy encoding tables must stay out of the Worker');
  const context = { module: { exports: {} }, Uint8Array, ArrayBuffer };
  vm.runInNewContext(code, context);
  const { TextDecoder: Decoder, TextEncoder: Encoder } = context.module.exports;
  const value = '中文与耳机 🎧';
  const bytes = new Encoder().encode(value);
  assert.deepEqual([...bytes], [...new TextEncoder().encode(value)]);
  assert.equal(new Decoder('utf-8').decode(bytes), value);
  const stream = new Decoder('utf-8');
  assert.equal(stream.decode(bytes.slice(0, 2), { stream: true }) + stream.decode(bytes.slice(2)), value);
  const utf16 = Buffer.from(value, 'utf16le');
  assert.equal(new Decoder('utf-16le').decode(utf16), value);
  assert.equal(new Decoder('utf-16be').decode(Buffer.from(utf16).swap16()), value);
  assert.throws(() => new Decoder('utf-8', { fatal: true }).decode(Uint8Array.of(0xff)));
});
test('actual adapted scalar interpreter matches upstream inference and distinguishes images', async () => {
  await assert.rejects(createEngine({wasm:WebAssembly,wasmPath:wasm,modelParts:[model]}),e=>e.code==='INVALID_INPUT');
  const engine=await createEngine({wasm:WebAssembly,wasmPath:wasm,modelParts,edge:spec.INPUT_EDGE,dimensions:spec.DIMENSIONS});
  const pkg=path.dirname(require.resolve('@tensorflow/tfjs-tflite/package.json'));
  const upstream=await require(path.join(pkg,'wasm/tflite_web_api_cc.js'))({wasmBinary:fs.readFileSync(path.join(pkg,'wasm/tflite_web_api_cc.wasm'))});
  const pointer=upstream._malloc(model.length);upstream.HEAPU8.set(model,pointer);
  const status=upstream.TFLiteWebModelRunner.CreateFromBufferAndOptions(pointer,model.length,{numThreads:1,enableProfiling:false,maxProfilingBufferEntries:16});
  assert.equal(status.ok(),true);const runner=status.value();status.delete();
  const inputs=runner.GetInputs(),outputs=runner.GetOutputs(),input=inputs.get(0),output=outputs.get(0);inputs.delete();outputs.delete();
  const vectors=[];
  try {
    for(let variant=0;variant<2;variant++) {
      const pixels=new Uint8Array(224*224*4);
      for(let y=0;y<224;y++)for(let x=0;x<224;x++) {
        const i=(y*224+x)*4;
        pixels[i]=variant?(((x>>4)+(y>>4))%2)*255:x;
        pixels[i+1]=variant?pixels[i]:y;pixels[i+2]=variant?pixels[i]:(x+y)%256;pixels[i+3]=255;
      }
      const expectedInput=input.data();for(let i=0,j=0;i<pixels.length;i+=4){expectedInput[j++]=pixels[i]/255;expectedInput[j++]=pixels[i+1]/255;expectedInput[j++]=pixels[i+2]/255;}
      assert.equal(runner.Infer(),true);const expected=normalize(output.data()),actual=engine.embed(pixels.buffer);
      assert.ok(cosine(actual,expected)>0.9999999);vectors.push(actual);
    }
    assert.ok(cosine(vectors[0],vectors[1])<0.95);
    assert.throws(()=>engine.embed(new ArrayBuffer(4)),e=>/尺寸/.test(e.message)&&e.code==='INVALID_INPUT');
  } finally {engine.close();input.delete();output.delete();runner.delete();upstream._free(pointer);}
  assert.throws(()=>engine.embed(new ArrayBuffer(224*224*4)),/停止/);
});
function clientFixture({ delayPackage = false }={}) {
  let onMessage,onKilled,terminate=0,created=0,finishPackage;
  const timers=new Map(),sent=[];let timerId=0;
  const worker={onMessage(fn){onMessage=fn;},onProcessKilled(fn){onKilled=fn;},postMessage(msg){sent.push(msg);if(msg.type==='init')queueMicrotask(()=>onMessage({id:msg.id,ok:true}));},terminate(){terminate++;}};
  const api={createWorker(){created++;return worker;},preDownloadSubpackage(o){if(delayPackage)finishPackage=o.success;else o.success();},getFileSystemManager:()=>({readFile(o){o.success({data:new ArrayBuffer(3)});}})};
  const deps={'./spec':{...spec,MODEL_BYTES:3*spec.MODEL_PATHS.length},'./errors':errors};
  const requireMock=name=>{assert.ok(name in deps,`unexpected dependency: ${name}`);return deps[name];};requireMock.async=async()=>true;
  const module={exports:{}};
  vm.runInNewContext(fs.readFileSync(path.join(root,'lib/image-matcher/client.js'),'utf8'),{module,require:requireMock,Float32Array,ArrayBuffer,Error,
    setTimeout(fn,ms){const id=++timerId;timers.set(id,{fn,ms});return id;},clearTimeout(id){timers.delete(id);}});
  return {client:new module.exports.ImageMatcher(api),sent,timers,reply:r=>onMessage(r),kill:()=>onKilled(),finish:()=>finishPackage(),counts:()=>({terminate,created})};
}
test('transport rejects concurrent requests, ignores wrong IDs, and cancels on process death', async () => {
  const f=clientFixture();await f.client.start();
  const init=f.sent.find(m=>m.type==='init');assert.equal(init.edge,spec.INPUT_EDGE);assert.equal(init.dimensions,spec.DIMENSIONS);
  assert.deepEqual(init.modelParts.length,spec.MODEL_PATHS.length);assert.equal(init.wasmPath,spec.WASM_PATH);
  const one=f.client.embed(new ArrayBuffer(4));
  await assert.rejects(f.client.embed(new ArrayBuffer(4)),e=>/上一帧/.test(e.message)&&e.code==='BUSY');
  const id=f.sent.at(-1).id;f.reply({id:id+1,ok:true,vector:new Float32Array(1024).buffer});assert.equal(f.client.pending.id,id);
  f.reply({id,ok:true,vector:new Float32Array(1024).buffer,inferenceMs:200});assert.equal((await one).vector.length,1024);
  const failed=f.client.embed(new ArrayBuffer(4));f.reply({id:f.sent.at(-1).id,ok:false,code:'INFERENCE_FAILED',error:'图像特征计算失败'});
  await assert.rejects(failed,e=>e.code==='INFERENCE_FAILED'&&e.message==='图像特征计算失败');
  const two=f.client.embed(new ArrayBuffer(4));const rejection=assert.rejects(two,e=>/进程已停止/.test(e.message)&&e.code==='WORKER_KILLED');f.kill();await rejection;
  assert.equal(f.counts().terminate,1);assert.equal(f.timers.size,0);
});
test('cancelling pending package loading prevents creation of a late worker', async () => {
  const f=clientFixture({delayPackage:true});const start=f.client.start();const rejection=assert.rejects(start,/取消/);
  f.client.close();await rejection;f.finish();await flush();assert.equal(f.counts().created,0);assert.equal(f.timers.size,0);
});
test('package and inference timeouts terminate once and reject the pending operation', async () => {
  const f=clientFixture({delayPackage:true});const start=f.client.start(),rejection=assert.rejects(start,/准备超时/);
  [...f.timers.values()][0].fn();await rejection;f.finish();await flush();assert.equal(f.counts().created,0);
  const g=clientFixture();await g.client.start();const inference=g.client.embed(new ArrayBuffer(4)),failed=assert.rejects(inference,/识别超时/);
  [...g.timers.values()][0].fn();await failed;assert.equal(g.counts().terminate,1);assert.equal(g.timers.size,0);
});
