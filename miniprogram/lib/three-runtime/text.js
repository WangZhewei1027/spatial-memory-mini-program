const { THREE } = require("./runtime");
function splitGraphemes(text) {
  if (typeof Intl !== "undefined" && Intl.Segmenter)
    return Array.from(
      new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text),
      (part) => part.segment,
    );
  // Keep common emoji modifiers, combining marks and ZWJ sequences together.
  const result = [];
  for (const char of Array.from(text)) {
    if (
      result.length &&
      (/^[\u0300-\u036f\ufe00-\ufe0f\u200d]$/.test(char) ||
        /[\u{1f3fb}-\u{1f3ff}]/u.test(char) ||
        result[result.length - 1].endsWith("\u200d"))
    )
      result[result.length - 1] += char;
    else result.push(char);
  }
  return result;
}
const NO_LINE_START = /^[，。！？、；：）」』》】〉,.!?;:)\]}…—~～]$/;
function layoutText(text, measure, maxWidth = 560) {
  const lines = [];
  for (const paragraph of String(text).replace(/\r\n?/g, "\n").split("\n")) {
    let line = "";
    for (const char of splitGraphemes(paragraph)) {
      if (line && measure(line + char) > maxWidth) {
        // Closing punctuation never starts a line; it takes the previous
        // character along instead.
        const graphemes = splitGraphemes(line);
        if (NO_LINE_START.test(char) && graphemes.length > 1) {
          lines.push(graphemes.slice(0, -1).join(""));
          line = graphemes[graphemes.length - 1];
        } else {
          lines.push(line);
          line = "";
        }
      }
      line += char;
    }
    lines.push(line);
  }
  return { lines, width: Math.max(1, ...lines.map(measure)) };
}
function roundedShape(width, height, radius) {
  const x = -width / 2,
    y = -height / 2,
    r = Math.min(radius, width / 2, height / 2),
    shape = new THREE.Shape();
  shape.moveTo(x + r, y);
  shape.lineTo(x + width - r, y);
  shape.quadraticCurveTo(x + width, y, x + width, y + r);
  shape.lineTo(x + width, y + height - r);
  shape.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  shape.lineTo(x + r, y + height);
  shape.quadraticCurveTo(x, y + height, x, y + height - r);
  shape.lineTo(x, y + r);
  shape.quadraticCurveTo(x, y, x + r, y);
  return shape;
}
/** Translucent speech bubble: dark glass, white hairline, centred tail. */
const BUBBLE = {
  color: "#1d1a2b",
  opacity: 0.6,
  borderOpacity: 0.38,
  border: 0.007,
  radius: 0.09,
  tailWidth: 0.12,
  tailHeight: 0.075,
};
/** Rounded rectangle whose bottom edge carries a softly pointed tail. */
function traceBubble(
  path,
  width,
  height,
  radius,
  tailWidth = BUBBLE.tailWidth,
  tailHeight = BUBBLE.tailHeight,
) {
  const x = -width / 2,
    y = -height / 2,
    r = Math.min(radius, width / 2, height / 2),
    tw = Math.max(0, Math.min(tailWidth, width - r * 2)) / 2;
  path.moveTo(x + r, y);
  if (tw > 0 && tailHeight > 0) {
    path.lineTo(-tw, y);
    path.lineTo(-tw * 0.18, y - tailHeight * 0.86);
    path.quadraticCurveTo(0, y - tailHeight, tw * 0.18, y - tailHeight * 0.86);
    path.lineTo(tw, y);
  }
  path.lineTo(x + width - r, y);
  path.quadraticCurveTo(x + width, y, x + width, y + r);
  path.lineTo(x + width, y + height - r);
  path.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  path.lineTo(x + r, y + height);
  path.quadraticCurveTo(x, y + height, x, y + height - r);
  path.lineTo(x, y + r);
  path.quadraticCurveTo(x, y, x + r, y);
  return path;
}
function safeColor(value, fallback) {
  return typeof value === "string" &&
    /^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(value)
    ? value
    : fallback;
}
function createTextAsset(
  text,
  config = {},
  style = "dialog_decorated",
  createCanvas = (options) => wx.createOffscreenCanvas(options),
) {
  const canvas = createCanvas({ type: "2d", width: 1, height: 1 }),
    ctx = canvas.getContext("2d");
  const fontPx = 48,
    lineHeight = 64,
    padding = 12;
  ctx.font = `${fontPx}px sans-serif`;
  const content = String(text || "无内容").slice(0, 2000);
  const layout = layoutText(
    content,
    (value) => ctx.measureText(value).width,
    560,
  );
  const truncated = layout.lines.length > 32;
  if (truncated) {
    layout.lines = layout.lines.slice(0, 32);
    layout.lines[31] = layout.lines[31].slice(0, -1) + "…";
  }
  canvas.width = Math.min(1024, Math.ceil(layout.width + padding * 2));
  canvas.height = layout.lines.length * lineHeight + padding * 2;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.font = `${fontPx}px sans-serif`;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.fillStyle = safeColor(config.text_color, "#ffffff");
  if (style !== "plain_white") {
    // Keeps light text legible where the camera image shows through.
    ctx.shadowColor = "rgba(0, 0, 0, 0.45)";
    ctx.shadowBlur = 4;
    ctx.shadowOffsetY = 1;
  }
  layout.lines.forEach((line, index) =>
    ctx.fillText(line, padding, padding + lineHeight * (index + 0.5)),
  );
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const texture = new THREE.DataTexture(
    new Uint8Array(
      pixels.data.buffer,
      pixels.data.byteOffset,
      pixels.data.byteLength,
    ),
    canvas.width,
    canvas.height,
    THREE.RGBAFormat,
    THREE.UnsignedByteType,
  );
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.flipY = true;
  texture.magFilter = texture.minFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  const size = Number(config.text_size),
    glyphMeters = Math.min(
      0.4,
      Math.max(0.06, (Number.isFinite(size) && size > 0 ? size : 1.5) * 0.1),
    );
  const ratio = glyphMeters / fontPx,
    width = canvas.width * ratio,
    height = canvas.height * ratio;
  const root = new THREE.Group();
  if (style !== "plain_white") {
    const padX = 0.08,
      padY = 0.055,
      bgWidth = width + padX * 2,
      bgHeight = height + padY * 2,
      radius = Math.min(BUBBLE.radius, bgHeight / 2),
      line = BUBBLE.border;
    // One outline with an integrated tail: overlapping translucent meshes
    // would double their alpha at the seams.
    const body = new THREE.Mesh(
      new THREE.ShapeGeometry(
        traceBubble(new THREE.Shape(), bgWidth, bgHeight, radius),
      ),
      new THREE.MeshBasicMaterial({
        color: safeColor(config.background_color, BUBBLE.color),
        transparent: true,
        opacity: BUBBLE.opacity,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    // The hairline is a ring, so the translucent body never shows it through.
    const ring = traceBubble(
      new THREE.Shape(),
      bgWidth + line * 2,
      bgHeight + line * 2,
      radius + line,
      BUBBLE.tailWidth + line * 2.4,
      BUBBLE.tailHeight + line * 1.6,
    );
    ring.holes.push(traceBubble(new THREE.Shape(), bgWidth, bgHeight, radius));
    const border = new THREE.Mesh(
      new THREE.ShapeGeometry(ring),
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: BUBBLE.borderOpacity,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    body.position.z = -0.003;
    border.position.z = -0.002;
    root.add(body, border);
    root.userData.bubble = { width: bgWidth, height: bgHeight, opacity: BUBBLE.opacity };
  }
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(width, height),
    new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      alphaTest: 0.01,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  mesh.position.z = 0.001;
  root.add(mesh);
  root.userData.textLayout = {
    truncated,
    lines: layout.lines.length,
    width,
    height,
    textureWidth: canvas.width,
    textureHeight: canvas.height,
    content,
  };
  return root;
}
module.exports = { createTextAsset, layoutText, splitGraphemes, roundedShape, traceBubble, BUBBLE };
