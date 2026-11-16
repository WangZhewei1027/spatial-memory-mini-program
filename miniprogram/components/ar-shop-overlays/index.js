const emit = require("../../utils/ar-ui/action");
Component({ properties: { navigation: Object, reward: Object }, methods: {
  onClose() { emit(this, "shop", "closeReward"); }, onSave() { emit(this, "shop", "saveReward"); },
} });
