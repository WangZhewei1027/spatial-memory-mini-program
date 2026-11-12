const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '../..');
const folder = path.join(root, 'ignore/cache/image-match');
const file = path.join(folder, 'model.tflite');
const source = 'https://storage.googleapis.com/mediapipe-models/image_embedder/mobilenet_v3_small/float32/1/mobilenet_v3_small.tflite';
async function main() {
  fs.mkdirSync(folder, { recursive: true });
  if (!fs.existsSync(file)) {
    const response = await fetch(source);
    if (!response.ok) throw new Error(`Model download HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.toString('ascii', 4, 8) !== 'TFL3') throw new Error('Invalid TFLite model');
    fs.writeFileSync(file, bytes);
  }
  const bytes = fs.readFileSync(file);
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== 'bbbb4c51a55a53905af1daec995ca1aae355046f8839bb8c9f5ce9271394bc40')
    throw new Error('Model SHA-256 does not match the pinned MediaPipe model');
  console.log(JSON.stringify({ model: source, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') }));
  const server = http.createServer((request, response) => {
    if (request.method === 'POST' && ['/report', '/event'].includes(request.url)) {
      const chunks = []; let size = 0;
      request.on('data', chunk => { size += chunk.length; if (size > 1024 * 1024) request.destroy(); else chunks.push(chunk); });
      request.on('end', () => {
        try {
          const report = JSON.parse(Buffer.concat(chunks));
          if (request.url === '/event') {
            if (!/^[0-9]+-[a-f0-9]+$/.test(report.runId) || typeof report.event !== 'string') throw new Error('Invalid diagnostic event');
            const event = { receivedAt: Date.now(), event: report.event, detail: report.detail, environment: report.environment };
            fs.appendFileSync(path.join(folder, `events-${report.runId}.jsonl`), JSON.stringify(event) + '\n');
            console.log(`Device ${report.environment?.platform}: ${report.event}`);
            response.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
            return;
          }
          if (report.schema !== 1 || !['camera', 'fixture'].includes(report.source) || !Array.isArray(report.summary)) throw new Error('Invalid report');
          const name = `report-${report.source}-${Date.now()}.json`;
          fs.writeFileSync(path.join(folder, name), JSON.stringify(report, null, 2));
          console.log(`Saved ${name}`);
          response.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
        } catch { response.writeHead(400).end(); }
      });
      return;
    }
    if (request.method !== 'GET' || request.url !== '/model.tflite') { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': bytes.length, 'Access-Control-Allow-Origin': '*' });
    response.end(bytes);
  });
  server.listen(8787, '0.0.0.0', () => console.log('Image matching lab: port 8787 (model, timing reports and initialization diagnostics)'));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
