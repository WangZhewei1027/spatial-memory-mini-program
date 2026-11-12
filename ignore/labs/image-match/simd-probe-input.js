// Deterministic input shared by the desktop oracle and WXWebAssembly probes.
const CASES = 12;
function fillInput(buffer, kind, index) {
  const bytes = new Uint8Array(buffer, 0, 160); bytes.fill(0);
  const words = new Uint32Array(buffer, 0, 24);
  let seed = (0x12569273 + index * 3433) >>> 0;
  for (let i = 0; i < words.length; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    words[i] = index === 0 ? 0 : index === 1 ? 0xffffffff : index === 2 ? 0x80007fff : seed;
  }
  if (kind === 'float') {
    const floats = new Float32Array(buffer, 0, 24);
    const boundaries = [0, -0, 1, -1, 0.5, -3.25, 255, 1e-20, 1e20, 0.1, 6, 127.5];
    for (let i = 0; i < floats.length; i++) floats[i] = index < 4 ? boundaries[(i + index * 3) % boundaries.length]
      : ((words[i] % 20001) - 10000) / 127;
  }
  bytes.fill(0xa5, 128, 144);
}
module.exports = { CASES, fillInput };
