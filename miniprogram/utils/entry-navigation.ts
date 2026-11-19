import type { ScanConfig } from "./backend";

export function scenePreviewUrl({ sceneId = "", organizationId = "" }: ScanConfig): string {
  return `/pages/scene/scene?sceneId=${encodeURIComponent(sceneId)}&organizationId=${encodeURIComponent(organizationId)}`;
}
