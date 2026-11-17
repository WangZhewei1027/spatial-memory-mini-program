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
// The raw first-place score can guide the viewer before confirmation is possible.
// This signal has its own hysteresis and never contributes matching evidence.
function hintActive(active, best, shownId, config) {
  return !!best && Number.isFinite(best.score) &&
    (shownId == null || best.reference.id !== shownId) &&
    best.score >= (active ? config.hintReleaseScore : config.hintScore);
}
// Two look-alike targets can hold each other under the margin for good. While the same
// two both reach minimumScore on their averages and lead every other target by
// minimumMargin, their raw scores are compared on each frame. The window does not restart
// when their own gap passes the margin for a while; the other paths may confirm then.
// `ids[0]` is the pair's leader when the window opened; it wins a tie (mean lead >= 0).
function similarPair(previous, entries, now, config) {
  const [first, second, third] = [...entries].sort((a, b) => b.score - a.score);
  if (!second || second.score < config.minimumScore || (third && second.score - third.score < config.minimumMargin)) return null;
  const same = !!previous && [first, second].every(entry => previous.ids.includes(entry.reference.id));
  const ids = same ? previous.ids : [first.reference.id, second.reference.id];
  const [a, b] = ids.map(id => (id === first.reference.id ? first : second));
  const frames = (same ? previous.frames : 0) + 1, lead = (same ? previous.lead : 0) + a.raw - b.raw;
  const ahead = lead >= 0;
  return { state: { ids, since: same ? previous.since : now, frames, lead },
    leader: ahead ? a : b, other: ahead ? b : a, frames, lead: Math.abs(lead) / frames };
}
// Temporal evidence across frames, with three ways to confirm.
// Slow path: each target keeps a time-weighted moving average of its per-frame
// (best-image) score. Threshold and margin are applied to the averages; a step is
// counted on frames that would also pass on their own for the same target. A weak
// frame pauses the count while the averaged lead holds; once the lead is lost the
// target starts over. This is what confirms borderline targets.
// Fast path: consecutive frames that each put the leader clearly ahead on their own.
// Pair path: two similar targets still within the margin after pairDurationMs; the one
// with the higher mean raw score over that window is taken.
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
  const pair = similarPair(evidence.pair, entries, now, config);
  const next = { lastAt: now, scores, id, since, count, strongCount, strongSince, pair: pair ? pair.state : null };
  const fast = strong && strongCount >= config.strongObservations && now - strongSince >= config.strongConfirmDurationMs;
  const slow = !!leader && count >= config.minimumObservations && now - since >= config.confirmDurationMs;
  // The pair is ruled on a frame where the two are within the margin of each other.
  const pairMs = pair ? now - pair.state.since : 0;
  const ruled = !fast && !slow && !!pair && reason === 'ambiguous_targets' &&
    pair.frames >= config.pairMinimumFrames && pairMs >= config.pairDurationMs;
  // What the UI shows as "n / required": the streak while it runs, the slow count otherwise.
  const progress = strong ? strongCount : count, required = strong ? config.strongObservations : config.minimumObservations;
  return { evidence: next, scores: entries, strong, progress, required, ...ranking, reason, match: ruled ? pair.leader : leader, frame,
    pair: pair && { leader: pair.leader, other: pair.other, frames: pair.frames, elapsedMs: pairMs, lead: pair.lead },
    confirmed: fast || slow || ruled, via: fast ? 'fast' : slow ? 'slow' : ruled ? 'pair' : null };
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
// Where the locked viewing point is relative to the camera, on the ground plane.
// `focus.forward` preserves the locked heading when the camera reaches that point.
// Pitch is separate: content sits at any height, but a phone pointing at the floor or
// the sky is not looking at it, and its horizontal heading is meaningless.
function contentView(position, forward, focus, config) {
  const dx = focus.x - position.x, dz = focus.z - position.z, distance = Math.hypot(dx, dz);
  const horizontal = Math.hypot(forward.x, forward.z), degrees = 180 / Math.PI;
  const pitchDeg = Math.atan2(forward.y, horizontal) * degrees;
  const steep = Math.abs(pitchDeg) > config.awayPitchDeg;
  // Near the focus, its bearing becomes unstable. Keep turn detection by comparing
  // with the locked heading instead of treating every direction as looking at it.
  const near = distance < config.focusNearMeters && focus.forward;
  const lookX = near ? focus.forward.x : dx, lookZ = near ? focus.forward.z : dz;
  const denominator = horizontal * Math.hypot(lookX, lookZ);
  const offsetDeg = steep || denominator < 1e-8 ? null
    : Math.acos(Math.max(-1, Math.min(1, (forward.x * lookX + forward.z * lookZ) / denominator))) * degrees;
  return { distance, offsetDeg, pitchDeg, steep };
}
// Whether the user has left the shown content: turned away, lowered the phone or walked
// off. Either state has to hold for a while before it flips, with a narrower angle and a
// shorter distance to come back than to leave, so a glance or a threshold pose does not
// toggle it. Time without samples (tracking lost) does not count towards the delay.
function attention(state, view, now, config) {
  const away = !!state?.away;
  const off = view.steep || view.offsetDeg > (away ? config.returnAngleDeg : config.awayAngleDeg) ||
    view.distance > (away ? config.returnDistanceMeters : config.awayDistanceMeters);
  const continued = state && state.since != null && now - state.lastAt <= config.attentionMaxGapMs;
  const since = off === away ? null : continued ? state.since : now;
  const flipped = since != null && now - since >= (away ? config.returnDelayMs : config.awayDelayMs);
  return { away: flipped ? !away : away, since: flipped ? null : since, lastAt: now, flipped };
}
module.exports = { similarity, referenceScore, evaluateMatch, hintActive, track, intervalFor, inspectPixels, blurState, candidateMovement,
  contentView, attention };
