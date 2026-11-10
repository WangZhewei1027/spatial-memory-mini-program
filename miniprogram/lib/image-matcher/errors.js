// Stable codes for logs and tests; `message` stays user-facing Chinese text.
// The worker cannot import this file, so it posts the same code strings.
const CODES = Object.freeze({
  UNSUPPORTED: 'UNSUPPORTED',
  CANCELLED: 'CANCELLED',
  INIT_TIMEOUT: 'INIT_TIMEOUT',
  MODEL_INCOMPLETE: 'MODEL_INCOMPLETE',
  WORKER_KILLED: 'WORKER_KILLED',
  WORKER_FAILED: 'WORKER_FAILED',
  BUSY: 'BUSY',
  TIMEOUT: 'TIMEOUT',
  INVALID_INPUT: 'INVALID_INPUT',
  INVALID_OUTPUT: 'INVALID_OUTPUT',
  INFERENCE_FAILED: 'INFERENCE_FAILED',
});

class RecognitionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RecognitionError';
    this.code = code;
  }
}

module.exports = { CODES, RecognitionError };
