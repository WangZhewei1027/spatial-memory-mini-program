// Cosine similarity of two L2-normalized embeddings; null when not comparable.
function similarity(a, b) {
  if (!a || !b || a.length !== b.length) return null;
  let score = 0;
  for (let i = 0; i < a.length; i++) score += a[i] * b[i];
  return Number.isFinite(score) ? Math.max(-1, Math.min(1, score)) : null;
}
function evaluateMatch(vector, references, { minimumScore, minimumMargin }) {
  let best = null, second = null;
  for (const reference of references) {
    const score = similarity(vector, reference.vector);
    if (score == null) continue;
    if (!best || score > best.score) { second = best ? best.score : second; best = { reference, score }; }
    else second = second == null ? score : Math.max(second, score);
  }
  const margin = best && second != null ? best.score - second : null;
  const reason = !best ? 'no_valid_reference' : best.score < minimumScore ? 'score_below_threshold'
    : margin != null && margin < minimumMargin ? 'ambiguous_targets' : 'eligible';
  return { best, second, margin, reason, match: reason === 'eligible' ? best : null };
}
function observe(evidence, match, now, config) {
  if (!match) return { evidence: null, confirmed: false };
  const id = match.reference.id;
  if (!evidence || evidence.id !== id || now - evidence.lastAt > config.maxObservationGapMs)
    evidence = { id, since: now, lastAt: now, count: 0 };
  evidence = { ...evidence, count: evidence.count + 1, lastAt: now };
  return { evidence, confirmed: evidence.count >= config.minimumObservations && now - evidence.since >= config.confirmDurationMs };
}
function intervalFor(elapsedMs, config) {
  return Math.max(config.frameIntervalMs, Math.min(config.maxFrameIntervalMs, elapsedMs * 4));
}
function inspectPixels(buffer) {
  const pixels = new Uint8Array(buffer);
  let min = 255, max = 0, total = 0, squared = 0, count = 0;
  const stride = Math.max(4, Math.floor(pixels.length / 512 / 4) * 4);
  for (let i = 0; i + 3 < pixels.length; i += stride) {
    const value = (pixels[i] + pixels[i + 1] + pixels[i + 2]) / 3;
    min = Math.min(min, value); max = Math.max(max, value); total += value; squared += value * value; count++;
  }
  const mean = count ? total / count : 0;
  const stddev = Math.sqrt(Math.max(0, count ? squared / count - mean * mean : 0));
  return { min, max, mean, stddev, usable: count > 0 && max - min > 8 && stddev > 3 };
}
function candidateMovement(from, to, minimumMeters) {
  const valid = p => p && Number.isFinite(p.latitude) && Math.abs(p.latitude) <= 90 &&
    Number.isFinite(p.longitude) && Math.abs(p.longitude) <= 180 &&
    Number.isFinite(p.accuracy) && p.accuracy >= 0 && p.accuracy <= 100;
  if (!valid(from) || !valid(to)) return null;
  const rad = Math.PI / 180;
  const h = Math.sin((to.latitude - from.latitude) * rad / 2) ** 2 +
    Math.cos(from.latitude * rad) * Math.cos(to.latitude * rad) *
    Math.sin((to.longitude - from.longitude) * rad / 2) ** 2;
  const distanceMeters = 6371000 * 2 * Math.asin(Math.sqrt(Math.min(1, h)));
  const thresholdMeters = Math.max(minimumMeters, from.accuracy + to.accuracy);
  return distanceMeters >= thresholdMeters ? { distanceMeters, thresholdMeters } : null;
}
module.exports = { similarity, evaluateMatch, observe, intervalFor, inspectPixels, candidateMovement };
