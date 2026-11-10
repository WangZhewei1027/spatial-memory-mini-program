// DevTools beforeUpload guard for the main project: lab subpackages must not be
// uploaded. Upload the staged copy from `npm run release:stage` instead.
const path = require("node:path");
const { uploadProblems } = require("./release-package.cjs");

const problems = uploadProblems(path.resolve(__dirname, ".."));
if (problems.length) {
  console.error([
    "[upload] 当前项目包含实验页，不能直接上传体验版/正式版：",
    ...problems.map((problem) => `  - ${problem}`),
    "请运行 npm run release:stage，然后上传 .release/miniprogram-upload 目录。",
  ].join("\n"));
  process.exit(1);
}
