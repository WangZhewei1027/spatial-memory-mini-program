Component({
  options: { multipleSlots: true },
  properties: { items: { type: Array, value: [] }, active: String, expanded: { type: Boolean, value: true }, keyboardHeight: Number },
  methods: { onSelect(event) { this.triggerEvent("panelchange", { id: event.currentTarget.dataset.panel }); } },
});
