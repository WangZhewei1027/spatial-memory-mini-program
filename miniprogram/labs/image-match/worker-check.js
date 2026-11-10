const { ImageMatcher } = require('../../lib/image-matcher/client');
const { fixtureFrame } = require('./images');
const { cosine } = require('./benchmark');
async function runWorkerCheck(page, current) {
  const matcher = page._workerMatcher = new ImageMatcher();
  let heartbeat;
  try {
    page.setData({ status: '验证后台识别…' });
    page.log('worker-start', {});
    await matcher.start();
    if (!current()) return;
    page.log('worker-ready', {});
    const comparisons = [], workerVectors = [], inputs = [];
    for (const variant of ['buildings', 'checker']) {
      const fixture = fixtureFrame(320, 320, variant);
      try {
        const pixels = fixture.getCameraBuffer(224, 224).slice(0);
        inputs.push(pixels);
        const prepared = await page._processor.prepare({ width: 224, height: 224, pixels: new Uint8Array(pixels), mode: 'rgba-small' }, current);
        const baseline = page._engine.embed(prepared.canvas);
        const result = await matcher.embed(pixels);
        if (!current()) return;
        workerVectors.push(result.vector);
        comparisons.push({ variant, cosine: cosine(baseline, result.vector), inferenceMs: result.inferenceMs });
      } finally { fixture.close(); }
    }
    const gaps = [], timings = [];
    let previous = Date.now();
    heartbeat = setInterval(() => { const time = Date.now(); gaps.push(time - previous); previous = time; }, 16);
    for (let i = 0; i < 12 && current(); i++) {
      const result = await matcher.embed(inputs[i % inputs.length]); timings.push(result.inferenceMs);
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    const report = { comparisons, distinctImageCosine: cosine(workerVectors[0], workerVectors[1]), timings,
      heartbeatCount: gaps.length, heartbeatMaxMs: Math.max(0, ...gaps), simd: false, model: require('../../lib/image-matcher/build-info') };
    page.log('worker-report', report);
    if (comparisons.some(item => item.cosine < 0.999) || report.distinctImageCosine > 0.99) throw new Error('后台识别结果与 MediaPipe 不一致');
    if (current()) page.setData({ status: '后台识别验证完成', report: JSON.stringify(report, null, 2) });
  } finally { clearInterval(heartbeat); matcher.close(); if (page._workerMatcher === matcher) page._workerMatcher = null; }
}
module.exports = { runWorkerCheck };
