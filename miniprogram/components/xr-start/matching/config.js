module.exports = {
  debugLogs: true,
  diagnosticIntervalMs: 3000,
  batchSize: 5, // App limit, not a claimed native OSD limit; rotate through all nearby targets.
  batchDurationMs: 12000,
  minimumObservations: 3,
  confirmDurationMs: 700,
  maxObservationGapMs: 1500,
  emptyRetryMs: 30000,
  errorRetryMs: 10000,
  gpsCacheMs: 5000,
  gpsWatchMaxAgeMs: 10000,
};
