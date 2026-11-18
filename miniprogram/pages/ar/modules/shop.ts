import type { ArPageContext } from "./context";
import type { createUiRegistry } from "../../../utils/ar-ui/registry";

export const shopData = {
  showShopPanel: false,
  shopNavigation: { visible: false, title: "", distance: "", angle: 0 },
  shopReward: { visible: false, title: "", image: "" },
};

/** Shop state survives panel switches; each presentation registers its own shell slot. */
export function registerShop(page: ArPageContext, registry: ReturnType<typeof createUiRegistry>) {
  const shop = registry.register({ id: "shop", slot: "bottom", order: 30,
    navigation: { label: "打卡", icon: "circle-check-big" }, autoExpand: false,
    onActivate() {
      if (page.data.showShopPanel) page.selectComponent("#shop-checkin")?.loadProgress?.();
      else page.setData({ showShopPanel: true });
    },
    actions: {
      target: ({ shop }: any) => {
        page.selectComponent("#main-frame")?.setNavigationTarget(shop);
        if (!shop) page.setData({ shopNavigation: shopData.shopNavigation });
      },
      compass: navigation => page.setData({ shopNavigation: navigation }),
      reward: reward => page.setData({ shopReward: reward }),
      closeReward: () => page.selectComponent("#shop-checkin")?.closeCheckinModal(),
      saveReward: () => page.selectComponent("#shop-checkin")?.saveCheckinImage(),
    } });
  const compass = registry.register({ id: "shop-compass", slot: "top-center", order: 20 });
  const overlays = registry.register({ id: "shop-overlays", slot: "overlay", order: 20 });
  return { sync() {
    const d = page.data;
    const enabled = d.mapConfigReady && d.shopCheckinEnabled;
    shop.update({ enabled }); compass.update({ enabled }); overlays.update({ enabled });
    if (!enabled && (d.showShopPanel || d.shopNavigation.visible || d.shopReward.visible)) page.setData({ ...shopData });
  } };
}
