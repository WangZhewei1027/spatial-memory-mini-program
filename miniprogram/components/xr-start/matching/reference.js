const { download, removeFile } = require("../../../lib/three-runtime/resources");

/** Normalize existing PNG/WebP/JPEG references to the RGB JPEG required by OSD. */
async function loadOSDReference(url, current, onProgress = () => {}) {
  let source, output;
  const startedAt = Date.now();
  const report = (stage, fields) => { try { onProgress(stage, { ...fields, elapsedMs: Date.now() - startedAt }); } catch (_) {} };
  try {
    source = await download(url);
    if (!current()) throw new Error("识别已取消");
    report("downloaded", {});
    const info = await new Promise((resolve, reject) => wx.getImageInfo({ src: source, success: resolve, fail: reject }));
    if (!current()) throw new Error("识别已取消");
    report("image_info", { width: info.width, height: info.height, type: info.type, orientation: info.orientation });
    if (Math.min(info.width, info.height) < 240) throw new Error("参考图过小，请上传至少 240 × 240 的清晰图片");
    if (Math.max(info.width, info.height) / Math.min(info.width, info.height) > 16 / 9)
      throw new Error("参考图过于狭长，请裁剪为接近方形的目标图片");
    const scale = Math.min(1, 1080 / Math.max(info.width, info.height));
    const width = Math.round(info.width * scale), height = Math.round(info.height * scale);
    const canvas = wx.createOffscreenCanvas({ type: "2d", width, height });
    const image = canvas.createImage();
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { image.onload = image.onerror = null; reject(new Error("参考图解码超时")); }, 10000);
      image.onload = () => { clearTimeout(timer); resolve(); };
      image.onerror = () => { clearTimeout(timer); reject(new Error("参考图无法读取")); };
      image.src = source;
    });
    if (!current()) throw new Error("识别已取消");
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(image, 0, 0, width, height);
    output = await new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => { settled = true; reject(new Error("参考图转换超时")); }, 10000);
      wx.canvasToTempFilePath({ canvas, width, height, destWidth: width, destHeight: height, fileType: "jpg", quality: 0.9,
        success: ({ tempFilePath }) => {
          clearTimeout(timer);
          if (settled || !current()) { removeFile(tempFilePath); if (!settled) reject(new Error("识别已取消")); }
          else resolve(tempFilePath);
          settled = true;
        },
        fail: () => { clearTimeout(timer); settled = true; reject(new Error("参考图转换失败")); },
      });
    });
    if (!current()) throw new Error("识别已取消");
    report("jpeg_ready", { width, height, format: "jpg", quality: 0.9 });
    return output;
  } catch (error) {
    removeFile(output);
    throw error;
  } finally {
    if (source && source !== url) removeFile(source);
  }
}
module.exports = { loadOSDReference };
