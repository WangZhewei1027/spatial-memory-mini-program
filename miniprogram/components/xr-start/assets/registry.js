// Capacity and repeat policy. GPU/media resources are owned by each Three entry.
module.exports = {
  text: { bucket: "light", repeatCooldownMs: 60000 },
  image: { bucket: "light", repeatCooldownMs: 60000 },
  scene: { bucket: "scene", async: true },
  model: { bucket: "heavy", async: true },
  video: { bucket: "heavy", async: true },
  audio: { bucket: "audio" },
};
