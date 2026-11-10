const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { stage, uploadProblems } = require('./release-package.cjs');

const root = path.resolve(__dirname, '..');
const readJSON = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'miniapp-release-'));

test('main project upload guard rejects lab subpackages and forced lab files', () => {
  const app = readJSON(path.join(root, 'miniprogram/app.json'));
  const labs = app.subpackages.filter(pkg => pkg.root.startsWith('labs/')).map(pkg => pkg.root);
  assert.ok(labs.length > 0, 'DevTools project keeps lab pages for compile and preview');
  const problems = uploadProblems(root);
  for (const lab of labs) assert.ok(problems.some(p => p.includes(lab)), `guard reports ${lab}`);
  const guard = spawnSync(process.execPath, [path.join(__dirname, 'check-upload-package.cjs')], { encoding: 'utf8' });
  assert.equal(guard.status, 1);
  assert.match(guard.stderr, /npm run release:stage/);
});

test('staged upload copy drops every lab page and file but keeps production packages intact', () => {
  const output = path.join(tempDir(), 'upload');
  try {
    const { sizes } = stage({ output });
    assert.deepEqual(uploadProblems(output), []);
    assert.equal(fs.existsSync(path.join(output, 'miniprogram/labs')), false);
    const source = readJSON(path.join(root, 'miniprogram/app.json'));
    const staged = readJSON(path.join(output, 'miniprogram/app.json'));
    assert.deepEqual(staged.pages, source.pages);
    assert.deepEqual(staged.workers, source.workers);
    assert.deepEqual(staged.subpackages, source.subpackages.filter(pkg => !pkg.root.startsWith('labs/')));
    for (const pkg of staged.subpackages) assert.ok(pkg.root in sizes, `${pkg.root} is reported separately`);

    const config = readJSON(path.join(output, 'project.config.json'));
    const sourceConfig = readJSON(path.join(root, 'project.config.json'));
    assert.equal(config.appid, sourceConfig.appid);
    assert.deepEqual(config.scripts, {}); assert.equal(config.setting.scriptsEnable, false);
    assert.deepEqual(config.packOptions.include, sourceConfig.packOptions.include.filter(item => !item.value.startsWith('labs/')));
    for (const item of config.packOptions.include) assert.ok(fs.existsSync(path.join(output, 'miniprogram', item.value)), item.value);

    const local = fs.readFileSync(path.join(output, 'miniprogram/utils/backend-development-local.js'), 'utf8');
    assert.match(local, /apiBaseUrl: ""/, 'release copy never carries a developer LAN address');
    assert.ok(fs.existsSync(path.join(output, 'tsconfig.json')) && fs.existsSync(path.join(output, 'typings')));
    assert.ok(!fs.existsSync(path.join(output, 'scripts')) && !fs.existsSync(path.join(output, 'node_modules')));
  } finally { fs.rmSync(path.dirname(output), { recursive: true, force: true }); }
});

test('staging fails when production code still references a lab page', () => {
  const project = tempDir();
  try {
    const mini = path.join(project, 'miniprogram');
    for (const dir of ['pages/index', 'labs/demo', 'utils']) fs.mkdirSync(path.join(mini, dir), { recursive: true });
    fs.writeFileSync(path.join(mini, 'app.json'), JSON.stringify({ pages: ['pages/index/index'], subpackages: [{ root: 'labs/demo', pages: ['index'] }] }));
    fs.writeFileSync(path.join(mini, 'labs/demo/index.js'), 'Page({});');
    fs.writeFileSync(path.join(project, 'project.config.json'), JSON.stringify({ projectname: 'fixture', packOptions: { include: [] } }));
    fs.writeFileSync(path.join(mini, 'pages/index/index.js'), "wx.navigateTo({ url: '/labs/demo/index' });");
    assert.throws(() => stage({ root: project, output: path.join(project, 'out') }), /pages\/index\/index\.js 仍引用实验页路径/);
    fs.writeFileSync(path.join(mini, 'pages/index/index.js'), 'Page({});');
    stage({ root: project, output: path.join(project, 'out') });
    assert.deepEqual(readJSON(path.join(project, 'out/miniprogram/app.json')).subpackages, []);
  } finally { fs.rmSync(project, { recursive: true, force: true }); }
});
