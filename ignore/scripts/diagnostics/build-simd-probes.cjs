// Diagnostic only: actual SIMD operations used by the pinned MediaPipe binary.
// No optimizer is run, so each probe retains the operation being tested.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '../../..');
async function main() {
  const { default: b } = await import('binaryen');
  const upstream = fs.readFileSync(path.join(root, 'node_modules/@mediapipe/tasks-vision/wasm/vision_wasm_internal.wasm'));
  const source = b.readBinary(upstream);
  source.setFeatures(b.Features.All);
  const wat = source.emitText(); source.dispose();
  const used = [...new Set([...wat.matchAll(/\(((?:f32x4|f64x2|i8x16|i16x8|i32x4|i64x2|v128)\.[a-z0-9_]+)/g)].map(m => m[1]))].sort();
  const shuffles = [...new Set([...wat.matchAll(/\(i8x16.shuffle ((?:\d+\s+){15}\d+)/g)].map(m => m[1].replace(/\s+/g, ' ')))];
  const probes = [];
  const a = '(v128.load (i32.const 0))', c = '(v128.load (i32.const 32))', d = '(v128.load (i32.const 64))';
  function add(op, body, suffix = '', kind = op.startsWith('f32x4') && !op.includes('convert') ? 'float' : 'int') {
    probes.push({ op, name: 'p' + probes.length, label: op + suffix, kind, floatOutput: op.startsWith('f32x4') && !/\.(eq|ne|lt|le|gt|ge)$/.test(op), body });
  }
  function vector(op, expression, suffix, kind) { add(op, `(v128.store (i32.const 128) ${expression})`, suffix, kind); }
  for (const op of used) {
    if (op === 'v128.const') vector(op, '(v128.const i32x4 0x3f800000 0x80000001 0x7fffffff 0x12345678)');
    else if (op === 'i8x16.shuffle') for (const mask of shuffles) vector(op, `(${op} ${mask} ${a} ${c})`, ':' + mask);
    else if (op === 'v128.store') vector(op, a);
    else if (/^v128\.store\d+_lane$/.test(op)) {
      const bits = +op.match(/\d+/g)[1];
      for (let lane = 0; lane < 128 / bits; lane++) add(op, `(${op} ${lane} (i32.const 128) ${a})`, ':' + lane);
    } else if (/^v128\.load\d+_lane$/.test(op)) {
      const bits = +op.match(/\d+/g)[1];
      for (let lane = 0; lane < 128 / bits; lane++) vector(op, `(${op} ${lane} (i32.const 32) ${a})`, ':' + lane);
    } else if (op.startsWith('v128.load')) {
      for (const offset of [0, 1, 3, 7]) vector(op, `(${op} (i32.const ${offset}))`, ':offset' + offset);
    } else if (op.endsWith('.extract_lane')) {
      const bits = +op.match(/\d+/)[0], type = op.startsWith('f') ? 'f32' : bits === 64 ? 'i64' : 'i32';
      for (let lane = 0; lane < 128 / bits; lane++) add(op, `(${type}.store (i32.const 128) (${op} ${lane} ${a}))`, ':' + lane);
    } else if (op.endsWith('.replace_lane')) {
      for (let lane = 0; lane < 4; lane++) vector(op, `(${op} ${lane} ${a} (f32.load (i32.const 32)))`, ':' + lane);
    } else if (op.endsWith('.splat')) vector(op, `(${op} (${op.startsWith('f') ? 'f32' : 'i32'}.load (i32.const 0)))`);
    else if (/\.(shl|shr_s|shr_u)$/.test(op)) vector(op, `(${op} ${a} (i32.load (i32.const 32)))`);
    else if (op === 'v128.bitselect') vector(op, `(${op} ${a} ${c} ${d})`);
    else if (/\.(abs|neg|sqrt|ceil|nearest|floor|convert_[a-z0-9_]+|extend_[a-z0-9_]+)$/.test(op)) vector(op, `(${op} ${a})`);
    else vector(op, `(${op} ${a} ${c})`);
  }
  const helpers = [];
  for (const lanes of [4, 16, 40]) {
    const locals = Array.from({length:lanes}, (_,i) => '(local $v' + i + ' v128)').join(' ');
    const assignments = Array.from({length:lanes}, (_,i) => '(local.set $v' + i + ' (f32x4.mul (v128.load (i32.const 0)) (f32x4.splat (f32.const ' + (i+1) + '))))').join(' ');
    let sum = '(local.get $v0)'; for(let i=1;i<lanes;i++) sum='(f32x4.add ' + sum + ' (local.get $v' + i + '))';
    add('composition.locals', '(block ' + assignments + ' (v128.store (i32.const 128) ' + sum + '))', ':'+lanes, 'float');
    probes.at(-1).locals=locals; probes.at(-1).floatOutput=true;
  }
  helpers.push('(func $vectorCall (param $a v128) (param $b v128) (result v128) (f32x4.add (f32x4.mul (local.get $a) (local.get $b)) (f32x4.splat (f32.const 0.5))))');
  vector('composition.call', '(call $vectorCall ' + a + ' ' + c + ')', '', 'float'); probes.at(-1).floatOutput=true;
  helpers.push('(table 1 funcref) (elem (i32.const 0) $vectorCall) (type $vecType (func (param v128 v128) (result v128)))');
  vector('composition.indirect', '(call_indirect (type $vecType) '+a+' '+c+' (i32.sub (global.get $base) (global.get $base)))', '', 'float'); probes.at(-1).floatOutput=true;
  const address = body => body.replace(/\(i32.const (\d+)\)/g, '(i32.add (global.get $base) (i32.const $1))');
  const text = '(module (memory (export "memory") 1) (global $base (mut i32) (i32.const 0)) (func (export "setBase") (param i32) (global.set $base (local.get 0))) (func (export "grow") (param i32) (result i32) (memory.grow (local.get 0))) ' + helpers.join(' ') + ' ' + probes.map(p => '(func (export "'+p.name+'") '+(p.locals||'')+' '+address(p.body)+')').join('\n') + ')';
  const module = b.parseText(text); module.setFeatures(b.Features.All);
  if (!module.validate()) throw new Error('Probe module validation failed');
  const binary = Buffer.from(module.emitBinary()); module.dispose();
  const { instance } = await WebAssembly.instantiate(binary);
  const input = require('../../labs/image-match/simd-probe-input');
  const cases = probes.map(({ body, ...p }) => {
    const expected = [];
    for (let i = 0; i < input.CASES; i++) {
      input.fillInput(instance.exports.memory.buffer, p.kind, i);
      instance.exports[p.name]();
      expected.push([...new Uint32Array(instance.exports.memory.buffer, 128, 4)]);
    }
    return { ...p, expected };
  });
  const target = path.join(root, 'ignore/labs/image-match');
  fs.writeFileSync(path.join(target, 'simd-probe.wasm.br'), zlib.brotliCompressSync(binary));
  const info = { sha256: crypto.createHash('sha256').update(binary).digest('hex'), operations: used.length, inputCases: input.CASES, source: 'MediaPipe 0.10.21 SIMD; Node WebAssembly reference', probes: cases };
  fs.writeFileSync(path.join(target, 'simd-probe-cases.js'), `module.exports = ${JSON.stringify(info)};\n`);
  fs.mkdirSync(path.join(root, 'ignore/cache/image-match/simd'), { recursive: true });
  fs.writeFileSync(path.join(root, 'ignore/cache/image-match/simd/probes.wat'), text);
  console.log(JSON.stringify({ operations: used.length, functions: probes.length, cases: probes.length * input.CASES, wasmBytes: binary.length, compressed: fs.statSync(path.join(target, 'simd-probe.wasm.br')).size }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
