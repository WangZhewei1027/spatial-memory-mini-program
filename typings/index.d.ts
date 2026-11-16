/// <reference path="./types/index.d.ts" />
/// <reference path="./xr-frame.d.ts" />
/// <reference path="./wx-device-info.d.ts" />

interface IAppOption {
  globalData: {
    userInfo?: WechatMiniprogram.UserInfo;
  };
  userInfoReadyCallback?: WechatMiniprogram.GetUserInfoSuccessCallback;
}
