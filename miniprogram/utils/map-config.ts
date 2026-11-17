export interface MapConfig {
  retrieval_mode: "hybrid" | "gps" | "anchor";
  text_asset_miniapp_style: "plain_white" | "dialog_decorated";
  confetti_enabled: boolean;
  footer_enabled: boolean;
}

/** No cached team defaults: a map must supply its own complete configuration. */
export function parseMapConfig(value: unknown): MapConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("地图设置无效");
  const config = value as Record<string, unknown>;
  if ((config.retrieval_mode !== "hybrid" && config.retrieval_mode !== "gps" && config.retrieval_mode !== "anchor") ||
      (config.text_asset_miniapp_style !== "plain_white" && config.text_asset_miniapp_style !== "dialog_decorated") ||
      typeof config.confetti_enabled !== "boolean" || typeof config.footer_enabled !== "boolean") throw new Error("地图设置无效");
  return { retrieval_mode: config.retrieval_mode, text_asset_miniapp_style: config.text_asset_miniapp_style,
    confetti_enabled: config.confetti_enabled, footer_enabled: config.footer_enabled };
}
