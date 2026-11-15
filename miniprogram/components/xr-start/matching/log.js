const config = require("./config");
const { reportError } = require("../../../utils/report-error");

// Only pass selected diagnostic fields, never headers, images or full API bodies.
module.exports = function matchLog(event, fields = {}, level = "info", requestId) {
  if (config.debugLogs === false && level === "info") return;
  try {
    const write = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
    // Serialize immediately so DevTools does not show subsequently mutated values.
    write.call(console, `[ImageMatch]${requestId ? `[${requestId}]` : ""} ${event}`,
      JSON.stringify(fields));
    if (level === "error") reportError("recognition", fields.message || event, { event, requestId, ...fields });
  } catch (_) {
    // Diagnostics must never interrupt recognition.
  }
};
