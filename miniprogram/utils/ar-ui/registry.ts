export type UiSlot = "scene" | "top" | "overlay" | "bottom";
export type DebugItem = { key: string; label: string; value: string; level?: "info" | "warning" | "error"; order?: number };
export type ModuleAction = { moduleId: string; action: string; payload?: any };
export type ModuleDefinition = {
  id: string; slot: UiSlot; order?: number;
  navigation?: { label: string; icon: string };
  actions?: Record<string, (payload: any) => unknown>;
  onActivate?: () => void;
};
export const emptyUiSnapshot = () => ({ bottomNavItems: [] as { key: string; label: string; icon: string; badge: string }[],
  activeBottomPanel: "", bottomPanelExpanded: true, debugItems: [] as DebugItem[],
  slots: { scene: [] as string[], top: [] as string[], overlay: [] as string[], bottom: [] as string[] } });
type Snapshot = ReturnType<typeof emptyUiSnapshot>;

/** Per-page registry. It owns selection, scoped actions and diagnostic contributions, never business state. */
export function createUiRegistry(onChange: (snapshot: Snapshot) => void) {
  const modules = new Map<string, { definition: ModuleDefinition; enabled: boolean; badge: string; debug: DebugItem[] }>();
  let selected = "", expanded = true, chosen = false, disposed = false, batching = 0, last = "", active = "";
  function flush() {
    if (disposed || batching) return;
    const sorted = [...modules.values()].sort((a, b) => (a.definition.order || 0) - (b.definition.order || 0));
    const available = sorted.filter(m => m.enabled && m.definition.slot === "bottom" && m.definition.navigation);
    if (!chosen || !available.some(m => m.definition.id === selected)) selected = available[0]?.definition.id || "";
    const snapshot = emptyUiSnapshot();
    snapshot.activeBottomPanel = selected;
    snapshot.bottomPanelExpanded = expanded;
    for (const module of sorted) {
      const { definition, enabled, badge, debug } = module;
      if (enabled) snapshot.slots[definition.slot].push(definition.id);
      if (available.includes(module)) snapshot.bottomNavItems.push({ key: definition.id, ...definition.navigation!, badge });
      // Debug contributions may describe unavailable features (e.g. GPS failure), and are explicitly cleared by their owner.
      snapshot.debugItems.push(...debug.map(item => ({ ...item, key: `${definition.id}:${item.key}` })));
    }
    snapshot.debugItems.sort((a, b) => (a.order || 0) - (b.order || 0));
    const serialized = JSON.stringify(snapshot);
    if (serialized !== last) { last = serialized; onChange(snapshot); }
    const nextActive = expanded ? selected : "";
    if (nextActive !== active) { active = nextActive; if (active) modules.get(active)?.definition.onActivate?.(); }
  }
  return {
    register(definition: ModuleDefinition) {
      if (disposed) throw new Error("AR UI registry is disposed");
      if (!definition.id || modules.has(definition.id)) throw new Error(`Duplicate AR UI module: ${definition.id}`);
      if (!["scene", "top", "overlay", "bottom"].includes(definition.slot)) throw new Error(`Unknown AR UI slot: ${definition.slot}`);
      if (definition.navigation && definition.slot !== "bottom") throw new Error("Only bottom modules can register navigation");
      const entry = { definition, enabled: false, badge: "", debug: [] as DebugItem[] };
      modules.set(definition.id, entry);
      const current = () => !disposed && modules.get(definition.id) === entry;
      return {
        update(state: { enabled: boolean; badge?: string }) { if (!current()) return; entry.enabled = state.enabled; entry.badge = state.badge || ""; flush(); },
        publishDebug(items: DebugItem[]) {
          if (!current()) return;
          const keys = new Set<string>();
          entry.debug = items.filter(item => { if (!item.key || keys.has(item.key)) return false; keys.add(item.key); return true; })
            .map(item => ({ ...item, label: String(item.label).replace(/\s+/g, " ").slice(0, 24), value: String(item.value).replace(/\s+/g, " ").slice(0, 240) }));
          flush();
        },
        unregister() { if (!current()) return; modules.delete(definition.id); flush(); },
      };
    },
    batch(work: () => void) { if (disposed) return; batching++; try { work(); } finally { batching--; flush(); } },
    select(id: string) {
      const entry = modules.get(id);
      if (disposed || !entry?.enabled || entry.definition.slot !== "bottom" || !entry.definition.navigation) return;
      expanded = id !== selected || !expanded; selected = id; chosen = true; flush();
    },
    dispatch(event: ModuleAction) {
      const entry = event && modules.get(event.moduleId);
      const actions = entry?.definition.actions;
      if (disposed || !entry?.enabled || !actions || !Object.prototype.hasOwnProperty.call(actions, event.action)) return false;
      actions[event.action](event.payload); return true;
    },
    dispose() { disposed = true; modules.clear(); },
  };
}
