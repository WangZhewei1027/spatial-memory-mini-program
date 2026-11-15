// 小程序错误上报：复用 Web 平台公开的 /api/errors（写入 error_log，scope=client，
// method 以 "miniprogram:" 开头）。同时写入微信实时日志，便于在小程序后台按机型检索。
// 上报只做尽力而为：从不抛出、不重试，自身失败也不再上报，避免级联。
import { resolveBackendBaseUrl } from "./backend-environment";

const ERROR_PATH = "/api/errors";
const MAX_MESSAGE = 1000;
const MAX_STACK = 4000;
/** 同一条消息在窗口内只上报一次（各处 catch 会重复报告同一个网络失败）。 */
const DEDUPE_WINDOW_MS = 60_000;
/** 单次启动的上报上限，防止坏网络或循环错误刷满日志表。 */
const MAX_REPORTS_PER_LAUNCH = 50;

type Context = Record<string, unknown>;
// 项目内置的 typings 早于 getDeviceInfo/getAppBaseInfo，按可选接口访问。
type WxInfo = {
  getDeviceInfo?: () => { brand?: string; model?: string; system?: string; platform?: string };
  getAppBaseInfo?: () => { version?: string; SDKVersion?: string };
};
const wxInfo = (): WxInfo => wx as unknown as WxInfo;

const recent = new Map<string, number>();
let sentCount = 0;
let baseUrl: string | null | undefined;
let environment: Context | undefined;
let realtime: WechatMiniprogram.RealtimeLogManager | null | undefined;

export function errorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  const value = error as { message?: unknown; errMsg?: unknown } | null | undefined;
  if (value && typeof value.message === "string" && value.message) return value.message;
  if (value && typeof value.errMsg === "string" && value.errMsg) return value.errMsg;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch (_) {
    return String(error);
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function backendUrl(): string | null {
  if (baseUrl !== undefined) return baseUrl;
  try {
    baseUrl = resolveBackendBaseUrl(wx.getAccountInfoSync().miniProgram.envVersion, wxInfo().getDeviceInfo?.().platform);
  } catch (_) {
    // 环境未知或开发版缺少局域网地址：只写实时日志。
    baseUrl = null;
  }
  return baseUrl;
}

function environmentContext(): Context {
  if (environment) return environment;
  const env: Context = {};
  try {
    const { miniProgram } = wx.getAccountInfoSync();
    env.envVersion = miniProgram.envVersion;
    if (miniProgram.version) env.version = miniProgram.version;
  } catch (_) {}
  try {
    const device = wxInfo().getDeviceInfo?.();
    if (device) Object.assign(env, { brand: device.brand, model: device.model, system: device.system, platform: device.platform });
  } catch (_) {}
  try {
    const app = wxInfo().getAppBaseInfo?.();
    if (app) Object.assign(env, { wechat: app.version, sdk: app.SDKVersion });
  } catch (_) {}
  environment = env;
  return env;
}

function currentRoute(): string {
  try {
    const pages = getCurrentPages();
    return `/${pages[pages.length - 1]?.route || "app"}`;
  } catch (_) {
    return "/app";
  }
}

function writeRealtime(source: string, message: string, context: Context) {
  try {
    if (realtime === undefined) realtime = wx.getRealtimeLogManager?.() ?? null;
    realtime?.error(`[${source}] ${message}`, context);
  } catch (_) {}
}

/**
 * 上报一条错误。source 标明来源（如 "app.onError"、"scene.soundtrack"），
 * context 只放排查所需的少量字段，不放图像、请求体或个人信息。
 */
export function reportError(source: string, error: unknown, context: Context = {}): void {
  try {
    const message = truncate(errorMessage(error) || "未知错误", MAX_MESSAGE);
    const rawStack = (error as { stack?: unknown } | null | undefined)?.stack;
    const stack = typeof rawStack === "string" ? truncate(rawStack, MAX_STACK) : undefined;
    writeRealtime(source, message, context);

    const now = Date.now();
    if ((recent.get(message) ?? -Infinity) > now - DEDUPE_WINDOW_MS) return;
    recent.set(message, now);
    if (recent.size > 100) {
      for (const [key, at] of recent) if (at <= now - DEDUPE_WINDOW_MS) recent.delete(key);
    }
    if (sentCount >= MAX_REPORTS_PER_LAUNCH) return;
    const base = backendUrl();
    if (!base || typeof wx.request !== "function") return;
    sentCount++;

    const env = environmentContext();
    wx.request({
      url: `${base}${ERROR_PATH}`,
      method: "POST",
      timeout: 10000,
      header: { "Content-Type": "application/json" },
      data: {
        method: `miniprogram:${source}`,
        path: currentRoute(),
        status: 0,
        message,
        release: `miniprogram@${env.version || env.envVersion || "unknown"}`,
        context: { ...context, ...(stack ? { stack } : {}), ...env },
      },
      fail: () => {},
    });
  } catch (_) {
    // 上报绝不能影响调用方。
  }
}
