// Cosine similarity of two L2-normalized embeddings; null when not comparable.
function similarity(a, b) {
  if (!a || !b || a.length !== b.length) return null;
  let score = 0;
  for (let i = 0; i < a.length; i++) score += a[i] * b[i];
  return Number.isFinite(score) ? Math.max(-1, Math.min(1, score)) : null;
}
// A target may have several reference images; its score is the best one, so
// photos of the same target never compete with each other for the margin.
function referenceMatch(vector, reference) {
  let best = null, image = -1;
  (reference.vectors || [reference.vector]).forEach((item, index) => {
    const score = similarity(vector, item);
    if (score != null && (best == null || score > best)) { best = score; image = index; }
  });
  return best == null ? null : { score: best, image };
}
function referenceScore(vector, reference) {
  const match = referenceMatch(vector, reference);
  return match ? match.score : null;
}
function rankScores(entries) {
  let best = null, second = null;
  for (const entry of entries) {
    if (entry.score == null) continue;
    if (!best || entry.score > best.score) { second = best ? best.score : second; best = entry; }
    else second = second == null ? entry.score : Math.max(second, entry.score);
  }
  return { best, second, margin: best && second != null ? best.score - second : null };
}
function decide(ranking, { minimumScore, minimumMargin }) {
  const { best, margin } = ranking;
  return !best ? 'no_valid_reference' : best.score < minimumScore ? 'score_below_threshold'
    : margin != null && margin < minimumMargin ? 'ambiguous_targets' : 'eligible';
}
// Single-frame decision; used for the raw per-frame scores.
function evaluateMatch(vector, references, config) {
  const ranking = rankScores(references.map(reference => ({ reference, score: referenceScore(vector, reference) })));
  const reason = decide(ranking, config);
  return { ...ranking, reason, match: reason === 'eligible' ? ranking.best : null };
}
// Temporal evidence across frames, with two ways to confirm.
// Slow path: each target keeps a time-weighted moving average of its per-frame
// (best-image) score. Threshold and margin are applied to the averages; a step is
// counted on frames that would also pass on their own for the same target. A weak
// frame pauses the count while the averaged lead holds; once the lead is lost the
// target starts over. This is what confirms borderline targets.
// Fast path: consecutive frames that each put the leader clearly ahead on their own.
function track(evidence, vector, references, now, config) {
  if (!evidence || now - evidence.lastAt > config.maxObservationGapMs)
    evidence = { lastAt: now, scores: {}, id: null, since: now, count: 0 };
  const alpha = 1 - Math.exp(-Math.max(0, now - evidence.lastAt) / config.scoreSmoothingMs);
  const scores = {}, entries = [];
  for (const reference of references) {
    const raw = referenceMatch(vector, reference);
    if (!raw) continue;
    const previous = evidence.scores?.[reference.id];
    // Turning the camera onto a target is a step, not noise: a score far above its
    // average replaces the average instead of being pulled back by the previous view.
    // Falling scores always decay gradually, which keeps the margin conservative.
    const jumped = previous != null && raw.score - previous >= config.scoreJump;
    const score = previous == null || jumped ? raw.score : previous + alpha * (raw.score - previous);
    scores[reference.id] = score;
    // `image` is the index of the reference image that matched this frame best.
    entries.push({ reference, score, raw: raw.score, image: raw.image });
  }
  const frame = rankScores(entries.map(entry => ({ reference: entry.reference, score: entry.raw })));
  frame.reason = decide(frame, config); frame.match = frame.reason === 'eligible' ? frame.best : null;
  const ranking = rankScores(entries), reason = decide(ranking, config);
  const leader = reason === 'eligible' ? ranking.best : null;
  let { id, since, count, strongCount = 0, strongSince = now } = evidence;
  if (!leader) { id = null; count = 0; }
  else {
    if (id !== leader.reference.id) { id = leader.reference.id; since = now; count = 0; strongCount = 0; }
    if (frame.match?.reference.id === id) count++;
  }
  // Fast path: this frame on its own puts the leader clearly ahead. Judged on the raw
  // frame, because the averages trail a target that has just come into view; safe
  // because it must hold for consecutive frames. Any other frame ends the streak.
  const strong = !!leader && frame.best.reference.id === id && frame.best.score >= config.strongScore &&
    (frame.margin == null || frame.margin >= config.strongMargin);
  if (!strong) strongCount = 0;
  else if (++strongCount === 1) strongSince = now;
  const next = { lastAt: now, scores, id, since, count, strongCount, strongSince };
  const fast = strong && strongCount >= config.strongObservations && now - strongSince >= config.strongConfirmDurationMs;
  const slow = !!leader && count >= config.minimumObservations && now - since >= config.confirmDurationMs;
  // What the UI shows as "n / required": the streak while it runs, the slow count otherwise.
  const progress = strong ? strongCount : count, required = strong ? config.strongObservations : config.minimumObservations;
  return { evidence: next, scores: entries, strong, progress, required, ...ranking, reason, match: leader, frame,
    confirmed: fast || slow, via: fast ? 'fast' : slow ? 'slow' : null };
}
// Frame pacing follows the measured end-to-end time. While a target leads clearly,
// frames come faster so confirmation finishes sooner; everything else keeps the slow pace.
function intervalFor(elapsedMs, config, leading = false) {
  const floor = leading ? config.leadFrameIntervalMs : config.frameIntervalMs;
  return Math.max(floor, Math.min(config.maxFrameIntervalMs, elapsedMs * (leading ? 2 : 4)));
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
  return { min, max, mean, stddev, sharpness: sharpnessOf(pixels), usable: count > 0 && max - min > 8 && stddev > 3 };
}
// Mean absolute green-channel gradient on every other pixel of a square RGBA image.
// Only meaningful relative to recent frames of the same scan (see blurState).
function sharpnessOf(pixels) {
  const edge = Math.round(Math.sqrt(pixels.length / 4));
  if (edge < 3 || edge * edge * 4 !== pixels.length) return null;
  let total = 0, count = 0;
  for (let y = 0; y < edge - 1; y += 2) for (let x = 0; x < edge - 1; x += 2) {
    const i = (y * edge + x) * 4 + 1, value = pixels[i];
    total += Math.abs(pixels[i + 4] - value) + Math.abs(pixels[i + edge * 4] - value); count++;
  }
  return count ? total / count : null;
}
// Motion blur shows up as a sudden drop in sharpness against the recent average.
// The average follows every frame, so a genuinely plain scene stops being skipped
// after a few samples, and retries are capped.
function blurState(state, sharpness, config) {
  const baseline = state?.baseline ?? null, retries = state?.retries || 0;
  if (sharpness == null) return { baseline, retries: 0, blurred: false };
  const blurred = baseline != null && sharpness < baseline * config.blurSharpnessRatio && retries < config.maxBlurRetries;
  return { baseline: baseline == null ? sharpness : baseline + config.sharpnessSmoothing * (sharpness - baseline),
    retries: blurred ? retries + 1 : 0, blurred, previous: baseline };
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
module.exports = { similarity, referenceScore, evaluateMatch, track, intervalFor, inspectPixels, blurState, candidateMovement };
