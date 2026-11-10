const config = require('./config');
const { ReferenceCache } = require('./reference-cache');

// Recognition lifecycle. Any phase may return to IDLE through _cancelRetrieval.
const PHASES = Object.freeze({
  IDLE: 'idle',
  EMPTY: 'empty', // No nearby targets; wait for movement or rescan.
  PREPARING: 'preparing', // Worker + reference embeddings.
  SCANNING: 'scanning', // Camera frames are matched.
  LOADING: 'loading', // Confirmed; fetching content.
  TRACKING: 'tracking', // Content ready; waiting for a valid SLAM pose.
  LOCKED: 'locked', // Content placed in world space.
  ERROR: 'error', // Waits for an explicit rescan.
});
const TRANSITIONS = Object.freeze({
  idle: ['preparing', 'empty', 'error'],
  empty: [],
  preparing: ['scanning', 'error'],
  scanning: ['loading', 'error'],
  loading: ['tracking', 'error'],
  tracking: ['locked'],
  locked: [],
  error: [],
});
function canTransition(from, to) {
  return to === PHASES.IDLE || (TRANSITIONS[from] || []).includes(to);
}

// Per-scan fields; _cancelRetrieval restores exactly these, so a new field
// cannot be initialized in one place and forgotten in the other.
function scanState() {
  return {
    _matchPhase: PHASES.IDLE,
    _matchReferences: [],
    _matchCandidates: [],
    _matchEvidence: null,
    _matchPreparing: false,
    _matchFrameBusy: false,
    _matchLocating: false,
    _matchSubmitTimer: null,
    _pendingMatchPlacement: null,
    _candidateGPS: null,
    _candidateRefreshGPS: null,
    _nextRecognitionAt: 0,
    _nextMatchFrameAt: 0,
    _recognitionGPS: null,
    _recognitionGPSRequest: null,
  };
}
// Fields that live for the component instance (survive rescans).
function initialRecognitionState() {
  return {
    ...scanState(),
    _referenceCache: new ReferenceCache(config.maxCachedReferences),
    _imageMatcher: null,
    _cameraReady: false,
    _matchDiagnostics: null,
    _matchDiagnosticTimer: null,
    _lastRecognitionStatus: null,
    _scanStatusMessage: '',
  };
}
module.exports = { PHASES, canTransition, scanState, initialRecognitionState };
