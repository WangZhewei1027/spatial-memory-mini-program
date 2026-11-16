// Validate the main project in place. DevTools uploads miniprogramRoot directly.
const fs = require("node:fs");
const path = require("node:path");
const readJSON = file => JSON.parse(fs.readFileSync(file, "utf8"));
// Conservative source budget; DevTools still verifies the compiled package.
const PACKAGE_SOURCE_BUDGET = 1.5 * 1024 * 1024;
const isArchivePath = value => /(^|\/)(labs|ignore)(\/|$)/.test(value);
const within = (parent, child) => {
  const relative = path.relative(parent, child);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

function walk(dir, visit, base = dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, visit, base);
    else visit(full, path.relative(base, full).split(path.sep).join("/"));
  }
}

function uploadProblems(root) {
  const problems = [];
  const config = readJSON(path.join(root, "project.config.json"));
  const miniRoot = path.resolve(root, config.miniprogramRoot || ".");
  const archive = path.join(root, "ignore");
  if (!within(root, miniRoot) || within(miniRoot, archive) || within(archive, miniRoot)) {
    return ["miniprogramRoot 必须位于项目内，并与 ignore/ 目录分离"];
  }
  const app = readJSON(path.join(miniRoot, "app.json"));
  const pages = [...app.pages, ...(app.subpackages || []).flatMap(pkg => pkg.pages.map(page => `${pkg.root}/${page}`))];
  for (const page of pages) {
    if (isArchivePath(page) || !within(miniRoot, path.resolve(miniRoot, page))) problems.push(`页面路径不属于正式代码：${page}`);
    for (const extensions of [[".js", ".ts"], [".json"], [".wxml"]]) {
      if (!extensions.some(ext => fs.existsSync(path.join(miniRoot, page + ext)))) problems.push(`页面文件缺失：${page}${extensions.join("/")}`);
    }
  }
  const workerPath = typeof app.workers === "string" ? app.workers : app.workers?.path;
  if (workerPath && (!within(miniRoot, path.resolve(miniRoot, workerPath)) || isArchivePath(workerPath) || !fs.existsSync(path.join(miniRoot, workerPath)))) problems.push(`Worker 目录无效：${workerPath}`);
  for (const item of config.packOptions?.include || []) {
    if (!within(miniRoot, path.resolve(miniRoot, item.value)) || isArchivePath(item.value)) problems.push(`强制打包路径不属于正式代码：${item.value}`);
    else if (!fs.existsSync(path.join(miniRoot, item.value))) problems.push(`强制打包的文件缺失：${item.value}`);
  }
  walk(miniRoot, (full, relative) => {
    if (isArchivePath(relative)) problems.push(`实验或临时文件应移到项目根目录 ignore/：${relative}`);
    else if (/\.(js|ts|json|wxml|wxss|wxs)$/.test(relative) && /(^|[^\w-])(?:labs|ignore)\//.test(fs.readFileSync(full, "utf8"))) problems.push(`${relative} 仍引用实验或临时目录`);
  });
  const sizes = packageSizes(root);
  for (const [name, bytes] of Object.entries(sizes)) {
    if (bytes >= PACKAGE_SOURCE_BUDGET) problems.push(`${name} 包源文件 ${(bytes / 1024 / 1024).toFixed(2)} MB，必须小于 1.5 MB；请拆分按需资源并在开发者工具复核实际包体积`);
  }
  // DevTools 2.02.2609250's quality scanner groups Worker files into main.
  if (app.workers?.isSubpackage && sizes.main + sizes[workerPath] >= PACKAGE_SOURCE_BUDGET) {
    problems.push(`开发者工具兼容统计（main + ${workerPath}）必须小于 1.5 MB`);
  }
  return problems;
}

function packageSizes(root) {
  const config = readJSON(path.join(root, "project.config.json"));
  const miniRoot = path.resolve(root, config.miniprogramRoot);
  const app = readJSON(path.join(miniRoot, "app.json"));
  const roots = [...(app.subpackages || []).map(pkg => pkg.root), app.workers?.isSubpackage ? app.workers.path : null].filter(Boolean);
  const sizes = Object.fromEntries([["main", 0], ...roots.map(r => [r, 0])]);
  walk(miniRoot, (full, relative) => {
    const owner = roots.find(r => relative.startsWith(`${r}/`)) || "main";
    sizes[owner] += fs.statSync(full).size;
  });
  return sizes;
}

module.exports = { uploadProblems, packageSizes };

if (require.main === module) {
  try {
    const root = path.resolve(__dirname, "..");
    const problems = uploadProblems(root);
    if (problems.length) throw new Error(problems.join("\n- "));
    console.log("[upload] 主项目检查通过，直接上传当前项目；ignore/ 位于 miniprogramRoot 之外。");
    for (const [name, bytes] of Object.entries(packageSizes(root))) console.log(`  ${name}: ${(bytes / 1024 / 1024).toFixed(2)} MB（源文件，实际包大小以开发者工具为准）`);
  } catch (error) {
    console.error(`[upload] ${error.message}`);
    process.exitCode = 1;
  }
}
