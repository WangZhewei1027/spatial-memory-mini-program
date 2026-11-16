import type { activityData } from "./activities";
import type { recognitionData } from "./recognition";
import type { runtimeData } from "./runtime";
import type { sensorData } from "./sensors";
import type { uiData } from "./ui";
import type { ActivityPlacement } from "../../../utils/activity-state";

/** Composition-time host contract; feature modules retain their own data and actions. */
type ArPageData = typeof activityData & typeof recognitionData & typeof runtimeData & typeof sensorData & typeof uiData & {
  width: number; height: number; renderWidth: number; renderHeight: number;
};
export type DetailEvent = Pick<WechatMiniprogram.CustomEvent, "detail">;
interface ArPageMethods {
  ensureUI(): void;
  syncUI(): void;
  refreshActivities(): Promise<void>;
  applyActivities(activities: ActivityPlacement[], sequence: number): boolean;
  refreshCanSubmit(): void;
  onTextInput(event: DetailEvent): void;
  onDanmakuActivityChange(event: DetailEvent): void;
  submitText(): Promise<void>;
  onKeyboardHeightChange(event: DetailEvent): void;
  onComposerBlur(): void;
  onRescan(): void;
  startSensors(): void;
  stopSensors(): void;
  getLocation(): void;
  _buildLocation(result: { latitude: number; longitude: number; accuracy?: number; altitude?: number }): NonNullable<typeof sensorData.location>;
  _startCompassWatch(): void;
  _stopCompassWatch(): void;
}
export type ArPageContext = WechatMiniprogram.Page.Instance<ArPageData, ArPageMethods>;
