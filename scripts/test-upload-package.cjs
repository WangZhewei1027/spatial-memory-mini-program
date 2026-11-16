const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { uploadProblems, packageSizes } = require('./check-upload-package.cjs');
const root = path.resolve(__dirname, '..');
const readJSON = file => JSON.parse(fs.readFileSync(file, 'utf8'));

test('the main project uploads directly with all production models and Worker files', () => {
  assert.deepEqual(uploadProblems(root), []);
  const config = readJSON(path.join(root, 'project.config.json'));
  assert.equal(config.miniprogramRoot, 'miniprogram/');
  const included = config.packOptions.include.map(item => item.value);
  const build = require('../miniprogram/lib/image-matcher/build-info');
  for (const file of [build.wasmPath, ...build.modelPaths]) assert.ok(included.includes(file), file);
  const { headphonePath } = require('../miniprogram/packages/audio-assets/ready');
  assert.ok(included.includes(headphonePath.replace(/^\//, '')), 'the audio model must survive unused-file filtering');
  const app = readJSON(path.join(root, 'miniprogram/app.json'));
  assert.deepEqual(app.subpackages.map(pkg => pkg.root), [
    'packages/audio-assets',
    'packages/image-match-runtime', 'packages/image-match-model-a', 'packages/image-match-model-b', 'packages/image-match-model-c',
  ]);
  assert.deepEqual(app.workers, { path: 'workers', isSubpackage: true });
  const sizes = packageSizes(root);
  assert.equal(Object.keys(sizes).length, 7);
  assert.ok(Object.values(sizes).every(bytes => bytes > 0));
  const guard = spawnSync(process.execPath, [path.join(__dirname, 'check-upload-package.cjs')], { encoding: 'utf8' });
  assert.equal(guard.status, 0, guard.stderr);
  assert.match(guard.stdout, /直接上传当前项目/);
  assert.equal('release:stage' in readJSON(path.join(root, 'package.json')).scripts, false);
});

function fixture(t) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'miniapp-upload-'));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  const write = (file, content) => {
    const full = path.join(project, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, typeof content === 'string' ? content : JSON.stringify(content));
  };
  write('project.config.json', { miniprogramRoot: 'miniprogram/', packOptions: { include: [] } });
  write('miniprogram/app.json', { pages: ['pages/index/index'] });
  write('miniprogram/pages/index/index.js', 'Page({});');
  write('miniprogram/pages/index/index.json', {});
  write('miniprogram/pages/index/index.wxml', '<view />');
  return { project, write };
}

test('archive contents are outside the upload root and do not affect package sizes', t => {
  const { project, write } = fixture(t);
  const sizes = packageSizes(project);
  write('ignore/labs/experiment.js', 'Page({});');
  write('ignore/cache/temporary.bin', 'temporary model');
  assert.deepEqual(uploadProblems(project), []);
  assert.deepEqual(packageSizes(project), sizes);
  write('project.config.json', { miniprogramRoot: './' });
  assert.match(uploadProblems(project).join('\n'), /与 ignore\/ 目录分离/);
});

test('upload rejects both main and subpackage source growth at the quality budget', t => {
  const { project, write } = fixture(t);
  const initialBytes = packageSizes(project).main;
  write('miniprogram/assets/large.bin', 'x'.repeat(1.5 * 1024 * 1024 - initialBytes - 1));
  assert.deepEqual(uploadProblems(project), []);
  fs.appendFileSync(path.join(project, 'miniprogram/assets/large.bin'), 'x');
  assert.match(uploadProblems(project).join('\n'), /main 包源文件.*必须小于 1.5 MB/);
  write('miniprogram/app.json', { pages: ['pages/index/index'], subpackages: [{ root: 'assets', pages: [] }] });
  assert.deepEqual(uploadProblems(project), []);
  fs.appendFileSync(path.join(project, 'miniprogram/assets/large.bin'), 'x'.repeat(initialBytes));
  assert.match(uploadProblems(project).join('\n'), /assets 包源文件.*必须小于 1.5 MB/);
});

test('upload catches broken page files, assets and imports after a move', t => {
  const { project, write } = fixture(t);
  fs.rmSync(path.join(project, 'miniprogram/pages/index/index.wxml'));
  write('project.config.json', { miniprogramRoot: 'miniprogram/', packOptions: { include: [{ type: 'file', value: 'packages/missing.bin' }] } });
  write('miniprogram/pages/index/index.js', "require('../../../ignore/labs/experiment');");
  const problems = uploadProblems(project).join('\n');
  assert.match(problems, /页面文件缺失：pages\/index\/index.wxml/);
  assert.match(problems, /强制打包的文件缺失：packages\/missing.bin/);
  assert.match(problems, /仍引用实验或临时目录/);
});

test('upload budgets Worker files with main for the current DevTools quality scanner', t => {
  const { project, write } = fixture(t);
  write('miniprogram/app.json', { pages: ['pages/index/index'], workers: { path: 'workers', isSubpackage: true } });
  write('miniprogram/workers/index.js', '');
  const mainBytes = packageSizes(project).main;
  write('miniprogram/workers/index.js', ' '.repeat(1.5 * 1024 * 1024 - mainBytes));
  assert.match(uploadProblems(project).join('\n'), /兼容统计（main \+ workers）必须小于 1.5 MB/);
});

test('upload catches restored experimental subpackages or forced archive files', t => {
  const { project, write } = fixture(t);
  write('miniprogram/app.json', { pages: ['pages/index/index'], subpackages: [{ root: 'labs/demo', pages: ['index'] }] });
  write('project.config.json', { miniprogramRoot: 'miniprogram/', packOptions: { include: [{ type: 'folder', value: '../ignore' }] } });
  const problems = uploadProblems(project).join('\n');
  assert.match(problems, /页面路径不属于正式代码：labs\/demo\/index/);
  assert.match(problems, /强制打包路径不属于正式代码：..\/ignore/);
});
