const emit = require("../../utils/ar-ui/action");
Component({ properties: { active: Boolean, status: String, hintActive: Boolean }, methods: { onRescan() { emit(this, "recognition", "rescan"); } } });
