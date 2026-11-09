// Keep Emscripten's memmove-equivalent copies inside WASM instead of crossing
// into JS for HEAPU8.copyWithin. Model, graph, memory layout and math are unchanged.
async function useWasmMemoryCopy(binary, importBase = 'ic') {
  const { default: b } = await import('binaryen');
  const module = b.readBinary(binary);
  try {
    module.setFeatures(b.Features.All);
    let target;
    for (let i = 0; i < module.getNumFunctions(); i++) {
      const fn = b.getFunctionInfo(module.getFunctionByIndex(i));
      if (fn.module === 'a' && fn.base === importBase) target = fn;
    }
    if (!target || target.results !== b.none ||
        String(b.expandType(target.params)) !== String([b.i32, b.i32, b.i32]))
      throw new Error('Pinned MediaPipe memcpy import changed; revalidate before rebuilding');
    module.removeFunction(target.name);
    module.addFunction(target.name, target.params, target.results, [],
      module.memory.copy(module.local.get(0, b.i32), module.local.get(1, b.i32), module.local.get(2, b.i32)));
    if (!module.validate()) throw new Error('Invalid WASM after memcpy adaptation');
    return Buffer.from(module.emitBinary());
  } finally { module.dispose(); }
}
module.exports = { useWasmMemoryCopy };
