// 本地微信类型快照缺少此 API；这里只补充项目读取的返回字段。
// https://developers.weixin.qq.com/miniprogram/dev/api/base/system/wx.getDeviceInfo.html
declare namespace WechatMiniprogram {
  interface Wx {
    getDeviceInfo(): Pick<SystemInfo, "platform">;
  }
}
