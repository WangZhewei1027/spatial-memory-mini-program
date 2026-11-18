const emit = require("../../utils/ar-ui/action");
Component({ properties: { reward: Object }, methods: {
  onClose() { emit(this, "shop", "closeReward"); }, onSave() { emit(this, "shop", "saveReward"); },
} });
