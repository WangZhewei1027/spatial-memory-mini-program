const emit = require("../../utils/ar-ui/action");
Component({ properties: { active: Boolean, activity: Object, activities: Array, selected: Number, submitting: Boolean, text: String,
  limit: Number, loading: Boolean, error: String, ready: Boolean, inRange: Boolean, located: Boolean, canSubmit: Boolean },
  methods: {
    onInput(e) { emit(this, "danmaku", "input", { value: e.detail.value }); },
    onSelect(e) { emit(this, "danmaku", "select", { value: e.detail.value }); },
    onSubmit() { emit(this, "danmaku", "submit"); }, onRetry() { emit(this, "danmaku", "retry"); },
    onKeyboard(e) { emit(this, "danmaku", "keyboard", { height: e.detail.height }); }, onBlur() { emit(this, "danmaku", "blur"); },
  },
});
