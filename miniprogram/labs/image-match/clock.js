// Keep one clock origin. Some devtools clocks jitter backwards below 1 ms.
function createClock(source) {
  let previous = -Infinity;
  return () => (previous = Math.max(previous, source.now()));
}
module.exports = { createClock };
