module.exports = {
  debugLogs: true,
  // Field calibration: log every sampled frame with per-target scores. When false,
  // only the first result, reason changes and confirmation progress are logged.
  frameLogs: true,
  frameLogTargets: 5,
  diagnosticIntervalMs: 3000,
  candidateRefreshDistanceMeters: 20, // Also require displacement beyond the combined GPS accuracy.
  gpsCheckIntervalMs: 5000, // Checks location only; stationary scans do not re-fetch candidates.
  maxCachedReferences: 200,
  minimumObservations: 3,
  confirmDurationMs: 1800,
  // Fast path: two consecutive frames that each score and lead this much on their own.
  // Set between on-target frames (score >= 0.43, lead >= 0.23) and all other frames
  // (score <= 0.40, lead <= 0.18) of the 2026-11-16 iPhone logs; one site, 40 frames.
  strongScore: 0.45,
  strongMargin: 0.2,
  strongObservations: 2,
  strongConfirmDurationMs: 500,
  // Pair path: two look-alike targets that stay within minimumMargin of each other, both at
  // minimumScore or above and ahead of every other target by minimumMargin, for this long.
  // The one with the higher mean raw score over the window is taken. Not field-calibrated.
  pairDurationMs: 3000,
  pairMinimumFrames: 3,
  maxObservationGapMs: 4500,
  frameIntervalMs: 1000,
  leadFrameIntervalMs: 500, // Only while a target leads clearly (strongScore / strongMargin).
  // A frame much less sharp than recent ones is retried shortly instead of scored.
  blurSharpnessRatio: 0.5,
  sharpnessSmoothing: 0.3,
  blurRetryMs: 150,
  maxBlurRetries: 3,
  // Content requests started before confirmation, per scan (shares the device rate limit).
  maxContentPrefetches: 2,
  maxFrameIntervalMs: 3000,
  maxResultAgeMs: 2500,
  // Trial threshold for validating matched content placement; field calibration is pending.
  minimumScore: 0.4,
  minimumMargin: 0.08,
  // A visual hint only: raw first place may be a target before a match is eligible.
  hintScore: 0.30,
  hintReleaseScore: 0.26,
  hintStaleMs: 4500,
  // Time constant of the per-target score average (about half weight on a new frame at 1 fps).
  scoreSmoothingMs: 1500,
  // A frame score this far above the target's average is adopted directly (camera turned onto it).
  scoreJump: 0.25,
  // After content is shown: has the user left it? Leaving only resumes scanning in the
  // background; the content is replaced when a different target is confirmed.
  // Angles are relative to a stable point ahead of the locked camera pose.
  // None of these values has been calibrated on a phone yet.
  attentionIntervalMs: 200,
  attentionMaxGapMs: 1000,
  awayAngleDeg: 45, // Content is placed within 30 degrees of the heading it was shown at.
  returnAngleDeg: 30,
  awayPitchDeg: 60, // Phone pointing at the floor or the sky.
  awayDistanceMeters: 8,
  returnDistanceMeters: 6,
  awayDelayMs: 600,
  returnDelayMs: 1500,
  focusNearMeters: 1, // Near the viewing point, compare against the locked heading.
  focusAheadMeters: 2, // Fixed point ahead of the lock pose; independent of asset loading/origin.
  reacquireRetryMs: 10000, // After the background Worker failed.
  gpsCacheMs: 5000,
  gpsWatchMaxAgeMs: 10000,
};
