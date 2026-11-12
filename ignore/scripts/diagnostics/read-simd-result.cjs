const fs = require('node:fs');
const path = require('node:path');
const folder = path.resolve(__dirname, '../../cache/image-match');
const cases = require('../../labs/image-match/simd-probe-cases');
let result;
for (const file of fs.readdirSync(folder).filter(f => /^events-.*\.jsonl$/.test(f)).sort().reverse()) {
  const rows = fs.readFileSync(path.join(folder, file), 'utf8').trim().split('\n').map(JSON.parse);
  const row = rows.reverse().find(r => r.environment?.platform === (process.argv.includes('--simulator') ? 'devtools' : 'ios')
    && r.event === '[DEBUG-simd] probe-result' && r.detail.sha256 === cases.sha256);
  if (row) { result = { file, ...row }; break; }
}
if (!result) { console.error('No matching device report yet'); process.exitCode = 2; }
else { console.log(JSON.stringify(result, null, 2)); process.exitCode = result.detail.failed ? 1 : 0; }
