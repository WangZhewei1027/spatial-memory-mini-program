const cases = require('./simd-probe-cases');
const { fillInput } = require('./simd-probe-input');
const nan = word => (word & 0x7f800000) === 0x7f800000 && (word & 0x7fffff) !== 0;
function compare(probe, expected, actual) {
  return expected.every((word, i) => word === actual[i] || (probe.floatOutput && nan(word) && nan(actual[i])));
}
async function runSimdProbes(current, log) {
  const { instance } = await WXWebAssembly.instantiate('labs/image-match/simd-probe.wasm.br', {});
  const results = [], failures = [];
  const source = new ArrayBuffer(160);
  for (const base of [0, 26 * 1024 * 1024, 64 * 1024 * 1024 + 3]) {
    if (base) instance.exports.grow(Math.ceil((base + 160) / 65536) - instance.exports.memory.buffer.byteLength / 65536);
    const buffer = instance.exports.memory.buffer;
    const inputBytes = new Uint8Array(buffer, base, 160), output = new DataView(buffer, base + 128, 16);
    instance.exports.setBase(base);
    log('[DEBUG-simd] probe-phase', { base, bytes: buffer.byteLength });
    for (const probe of cases.probes) {
    if (!current()) throw new Error('诊断已取消');
    let failed = 0;
    for (let i = 0; i < probe.expected.length; i++) {
      fillInput(source, probe.kind, i);
      inputBytes.set(new Uint8Array(source));
      instance.exports[probe.name]();
      const actual = [0,1,2,3].map(lane => output.getUint32(lane * 4, true));
      if (!compare(probe, probe.expected[i], actual)) {
        failed++;
        if (failed <= 2) failures.push({ operation: probe.label, base, input: i, expected: probe.expected[i], actual });
      }
    }
    results.push({ operation: probe.label, base, failed, total: probe.expected.length });
    if (results.length % 20 === 0) await new Promise(resolve => setTimeout(resolve, 0));
  }
  }
  const report = { sha256: cases.sha256, operations: cases.operations,
    total: results.reduce((sum, r) => sum + r.total, 0), failed: results.reduce((sum, r) => sum + r.failed, 0),
    failedProbes: results.filter(r => r.failed), failures };
  log('[DEBUG-simd] probe-result', report);
  return report;
}
module.exports = { runSimdProbes, compare };
