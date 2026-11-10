module.exports = {
  debugLogs: true,
  diagnosticIntervalMs: 3000,
  candidateRefreshDistanceMeters: 20, // Also require displacement beyond the combined GPS accuracy.
  gpsCheckIntervalMs: 5000, // Checks location only; stationary scans do not re-fetch candidates.
  maxCachedReferences: 200,
  minimumObservations: 3,
  confirmDurationMs: 1800,
  maxObservationGapMs: 4500,
  frameIntervalMs: 1000,
  maxFrameIntervalMs: 3000,
  maxResultAgeMs: 2500,
  // Trial threshold for validating matched content placement; field calibration is pending.
  minimumScore: 0.5,
  minimumMargin: 0.08,
  gpsCacheMs: 5000,
  gpsWatchMaxAgeMs: 10000,
};
