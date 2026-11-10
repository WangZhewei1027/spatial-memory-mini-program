// Builds the upload copy of the mini-program: everything under miniprogram/
// except the lab pages (labs/*), which stay available for DevTools compile and
// real-device preview but must never reach trial or release builds.
//
//   npm run release:stage   ->  .release/miniprogram-upload
//
// Upload that directory (DevTools "导入项目" or `wechatide ... upload --project`).
// The main project's beforeUpload hook rejects uploads that still contain labs.
const fs = require("node:fs");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");
const LAB_PREFIX = "labs/";
const OUTPUT = path.join(projectRoot, ".release/miniprogram-upload");
const SOURCE_EXTENSIONS = /\.(js|ts|json|wxml|wxss|wxs)$/;

const isLabPath = (value) => typeof value === "string" && value.replace(/^\/+/, "").startsWith(LAB_PREFIX);
const readJSON = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

function walk(dir, visit, base = dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, visit, base);
    else visit(full, path.relative(base, full).split(path.sep).join("/"));
  }
}

// Problems that make a project directory unfit for upload. Shared by the
// staging check and the main project's beforeUpload guard.
function uploadProblems(root) {
  const problems = [];
  const miniRoot = path.join(root, "miniprogram");
  const app = readJSON(path.join(miniRoot, "app.json"));
  for (const pkg of app.subpackages || []) if (isLabPath(pkg.root)) problems.push(`app.json 仍注册实验分包 ${pkg.root}`);
  const config = readJSON(path.join(root, "project.config.json"));
  for (const item of config.packOptions?.include || [])
    if (isLabPath(item.value)) problems.push(`project.config.json 仍强制打包 ${item.value}`);
  if (fs.existsSync(path.join(miniRoot, "labs"))) problems.push("miniprogram/labs 目录仍存在");
  return problems;
}

// Structural checks for the staged copy beyond "no labs".
function validateStage(root) {
  const problems = uploadProblems(root);
  const miniRoot = path.join(root, "miniprogram");
  const app = readJSON(path.join(miniRoot, "app.json"));
  const pages = [...app.pages, ...(app.subpackages || []).flatMap((pkg) => pkg.pages.map((page) => `${pkg.root}/${page}`))];
  for (const page of pages)
    if (![".js", ".ts"].some((ext) => fs.existsSync(path.join(miniRoot, page + ext)))) problems.push(`页面缺失：${page}`);
  const config = readJSON(path.join(root, "project.config.json"));
  for (const item of config.packOptions?.include || [])
    if (!fs.existsSync(path.join(miniRoot, item.value))) problems.push(`强制打包的文件缺失：${item.value}`);
  walk(miniRoot, (full, relative) => {
    if (SOURCE_EXTENSIONS.test(relative) && /(^|[^\w-])labs\//.test(fs.readFileSync(full, "utf8")))
      problems.push(`${relative} 仍引用实验页路径`);
  });
  return problems;
}

function packageSizes(root) {
  const miniRoot = path.join(root, "miniprogram");
  const app = readJSON(path.join(miniRoot, "app.json"));
  const roots = [...(app.subpackages || []).map((pkg) => pkg.root), app.workers?.isSubpackage ? app.workers.path : null]
    .filter(Boolean);
  const sizes = Object.fromEntries([["main", 0], ...roots.map((r) => [r, 0])]);
  // DevTools drops packOptions.ignore entries from the package; do not count them.
  const ignored = (readJSON(path.join(root, "project.config.json")).packOptions?.ignore || [])
    .map((item) => item.type === "folder" ? `${item.value.replace(/\/$/, "")}/` : item.value);
  walk(miniRoot, (full, relative) => {
    if (ignored.some((entry) => entry.endsWith("/") ? relative.startsWith(entry) : relative === entry)) return;
    const owner = roots.find((r) => relative.startsWith(`${r}/`)) || "main";
    sizes[owner] += fs.statSync(full).size;
  });
  return sizes;
}

function stage({ root = projectRoot, output = OUTPUT } = {}) {
  fs.rmSync(output, { recursive: true, force: true });
  fs.mkdirSync(output, { recursive: true });
  for (const name of ["tsconfig.json", "typings"])
    if (fs.existsSync(path.join(root, name))) fs.cpSync(path.join(root, name), path.join(output, name), { recursive: true });
  fs.cpSync(path.join(root, "miniprogram"), path.join(output, "miniprogram"), {
    recursive: true,
    filter: (source) => {
      const relative = path.relative(path.join(root, "miniprogram"), source).split(path.sep).join("/");
      return !isLabPath(`${relative}/`) && !/(^|\/)\.DS_Store$/.test(relative) &&
        !/^utils\/backend-development-local\.js/.test(relative);
    },
  });
  // Trial/release builds always use the online backend; never ship a developer's LAN address.
  fs.writeFileSync(path.join(output, "miniprogram/utils/backend-development-local.js"),
    "// 发布副本：开发地址留空，体验版／正式版使用线上后端。\nmodule.exports = { apiBaseUrl: \"\" };\n");

  const appFile = path.join(output, "miniprogram/app.json");
  const app = readJSON(appFile);
  app.subpackages = (app.subpackages || []).filter((pkg) => !isLabPath(`${pkg.root}/`));
  fs.writeFileSync(appFile, `${JSON.stringify(app, null, 2)}\n`);

  const config = readJSON(path.join(root, "project.config.json"));
  config.projectname = `${config.projectname}-release`;
  // The staged copy has no scripts/ directory, and needs no local-address hooks.
  config.scripts = {};
  config.setting = { ...config.setting, scriptsEnable: false };
  for (const key of ["include", "ignore"])
    if (config.packOptions?.[key]) config.packOptions[key] = config.packOptions[key].filter((item) => !isLabPath(item.value));
  fs.writeFileSync(path.join(output, "project.config.json"), `${JSON.stringify(config, null, 2)}\n`);

  const problems = validateStage(output);
  if (problems.length) throw new Error(`发布副本无效：\n- ${problems.join("\n- ")}`);
  return { output, sizes: packageSizes(output) };
}

module.exports = { stage, uploadProblems, validateStage, packageSizes, isLabPath };

if (require.main === module) {
  try {
    const { output, sizes } = stage();
    const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(2)} MB`;
    console.log(`[release] 已生成上传副本：${path.relative(projectRoot, output)}`);
    for (const [name, bytes] of Object.entries(sizes)) console.log(`  ${name.padEnd(36)} ${mb(bytes)}（源文件，未经开发者工具压缩）`);
    console.log(`  ${"total".padEnd(36)} ${mb(Object.values(sizes).reduce((a, b) => a + b, 0))}`);
  } catch (error) {
    console.error(`[release] ${error.message}`);
    process.exitCode = 1;
  }
}
