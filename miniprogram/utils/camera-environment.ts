/** A phone preview is also a develop build. Only the IDE simulator gets a fixed camera. */
export function usesSimulatedCamera(): boolean {
  return wx.getAccountInfoSync?.()?.miniProgram?.envVersion === "develop" &&
    wx.getDeviceInfo?.()?.platform === "devtools";
}
