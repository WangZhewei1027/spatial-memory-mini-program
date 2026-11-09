const MODES = ['rgba-full', 'rgba-small', 'jpeg-small'];
function orderFor(index) { const offset = index % MODES.length; return [...MODES.slice(offset), ...MODES.slice(0, offset)]; }
function dimensions(width, height, edge = Infinity) {
  if (![width, height].every(n => Number.isFinite(n) && n >= 16)) throw new Error('无效相机尺寸');
  const scale = Math.min(1, edge / Math.max(width, height));
  const w = Math.max(16, Math.floor(width * scale / 16) * 16);
  return { width: w, height: Math.max(1, Math.round(w * height / width)) };
}
function cosine(a, b) {
  if (!a?.length || a.length !== b?.length) throw new Error('特征维度不一致');
  let dot = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) {
    if (!Number.isFinite(a[i]) || !Number.isFinite(b[i])) throw new Error('特征包含非有限值');
    dot += a[i] * b[i]; aa += a[i] ** 2; bb += b[i] ** 2;
  }
  if (!aa || !bb) throw new Error('特征向量为空');
  return Math.max(-1, Math.min(1, dot / Math.sqrt(aa * bb)));
}
function rank(vector, references) {
  return references.map(ref => ({ id: ref.id, name: ref.name, score: cosine(vector, ref.vector) }))
    .sort((a, b) => b.score - a.score);
}
function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))];
}
function summarize(rows) {
  return MODES.map(mode => {
    const samples = rows.filter(row => row.mode === mode && !row.warmup);
    const result = { mode, samples: samples.length };
    for (const stage of ['captureMs', 'prepareMs', 'encodeMs', 'decodeMs', 'preprocessMs', 'inferMs', 'rankMs', 'totalMs']) {
      result[stage] = { p50: percentile(samples.map(row => row[stage]), 0.5), p95: percentile(samples.map(row => row[stage]), 0.95) };
    }
    result.agreement = samples.length ? samples.filter(row => row.sameTopAsRaw).length / samples.length : null;
    result.embeddingCosineP50 = percentile(samples.map(row => row.embeddingCosineToRaw), 0.5);
    return result;
  });
}
// All three pipelines use the same owned snapshot. Inference order rotates to
// reduce warm-cache/thermal bias. Warm-up rows remain in raw data, not summaries.
async function runPair({ snapshots, order, processor, engine, references, now, current, warmup }) {
  const rows = [], vectors = {};
  for (const mode of order) {
    if (!current()) throw new Error('测试已取消');
    const snapshot = snapshots[mode];
    const { canvas, timings } = await processor.prepare(snapshot, current);
    if (!current()) throw new Error('测试已取消');
    const inferAt = now(), vector = engine.embed(canvas), inferMs = now() - inferAt;
    const rankAt = now(), ranked = rank(vector, references), rankMs = now() - rankAt;
    vectors[mode] = vector;
    const row = { mode, warmup, width: snapshot.width, height: snapshot.height,
      bytes: snapshot.pixels?.byteLength || snapshot.jpeg?.byteLength,
      converter: snapshot.converter, captureMs: snapshot.captureMs, ...timings, inferMs, rankMs,
      top: ranked.slice(0, 2) };
    row.preprocessMs = row.prepareMs + row.encodeMs + row.decodeMs;
    row.totalMs = row.captureMs + row.preprocessMs + inferMs + rankMs;
    rows.push(row);
  }
  const raw = rows.find(row => row.mode === 'rgba-full');
  for (const row of rows) {
    row.sameTopAsRaw = row.top[0]?.id === raw.top[0]?.id;
    row.embeddingCosineToRaw = cosine(vectors[row.mode], vectors['rgba-full']);
  }
  return rows;
}
module.exports = { MODES, orderFor, dimensions, cosine, rank, percentile, summarize, runPair };
