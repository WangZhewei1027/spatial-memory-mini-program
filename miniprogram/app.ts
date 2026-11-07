// app.ts
App<IAppOption>({
  globalData: {},
  onLaunch() {
    // 新版本就绪后立即重启应用：后端已从 Supabase 迁到 Web 平台接口，
    // 旧版本越早退出，Supabase 项目越早可以关闭。
    const updater = wx.getUpdateManager?.();
    if (updater) {
      updater.onUpdateReady(() => {
        wx.showModal({
          title: "更新提示",
          content: "新版本已经准备好，是否重启应用？",
          showCancel: false,
          success: () => updater.applyUpdate(),
        });
      });
    }

  },
})
