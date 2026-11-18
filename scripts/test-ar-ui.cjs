const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { transformSync } = require("esbuild");
const file = path.resolve(__dirname, "../miniprogram/utils/ar-ui/registry.ts");
const mod = { exports: {} };
vm.runInNewContext(transformSync(fs.readFileSync(file, "utf8"), { loader: "ts", format: "cjs" }).code, { module: mod, exports: mod.exports });
const { createUiRegistry } = mod.exports;
const snapshots = [], actions = [], activations = [];
const registry = createUiRegistry(snapshot => snapshots.push(JSON.parse(JSON.stringify(snapshot))));
const last = () => snapshots.at(-1);
const first = registry.register({ id: "first", slot: "bottom", order: 20, navigation: { label: "First", icon: "first" },
  actions: { select: payload => actions.push(payload) }, onActivate: () => activations.push("first") });
const second = registry.register({ id: "second", slot: "bottom", order: 10, navigation: { label: "Second", icon: "second" }, onActivate: () => activations.push("second") });
const sensor = registry.register({ id: "sensor", slot: "top" });
registry.batch(() => {
  first.update({ enabled: true }); second.update({ enabled: true }); sensor.update({ enabled: true });
  first.publishDebug([{ key: "state", label: "业务", value: "ready", order: 20 }]);
  sensor.publishDebug([{ key: "state", label: "GPS", value: "line one\nline two", order: 10 }]);
});
assert.equal(snapshots.length, 1, "a composite refresh commits one coherent snapshot");
assert.deepEqual(last().bottomNavItems.map(item => item.key), ["second", "first"]);
assert.deepEqual(last().slots.top, ["sensor"]);
assert.equal(last().activeBottomPanel, "second");
assert.deepEqual(last().debugItems.map(item => item.key), ["sensor:state", "first:state"], "debug namespaces cannot overwrite one another");
assert.equal(last().debugItems[0].value, "line one line two", "one-line diagnostics normalize newlines");
assert.equal(registry.dispatch({ moduleId: "first", action: "select", payload: 42 }), true);
assert.deepEqual(actions, [42]);
assert.equal(registry.dispatch({ moduleId: "first", action: "toString" }), false);
assert.equal(registry.dispatch({ moduleId: "unknown", action: "select" }), false);
registry.select("first"); registry.select("first");
assert.equal(last().bottomPanelExpanded, false);
const count = snapshots.length;
first.update({ enabled: true });
assert.equal(snapshots.length, count, "unchanged contributions do not resend page data");
assert.equal(last().bottomPanelExpanded, false, "background refresh does not reopen a panel");
registry.select("sensor");
assert.equal(last().activeBottomPanel, "first", "top-slot contributions are not navigable features");
registry.select("first");
assert.deepEqual(activations, ["second", "first", "first"], "activation only runs on opening or switching");
second.update({ enabled: false });
assert.equal(last().activeBottomPanel, "first");
first.update({ enabled: false });
assert.equal(registry.dispatch({ moduleId: "first", action: "select", payload: 43 }), false);
assert.equal(last().activeBottomPanel, "");
assert.deepEqual(actions, [42]);
first.unregister();
assert.ok(!last().debugItems.some(item => item.key.startsWith("first:")));
const replacement = registry.register({ id: "first", slot: "bottom", navigation: { label: "New", icon: "new" } });
replacement.update({ enabled: true });
first.update({ enabled: false }); first.publishDebug([{ key: "late", label: "Late", value: "stale" }]); first.unregister();
assert.equal(last().bottomNavItems[0].label, "New", "late callbacks from an unregistered module cannot alter its replacement");
const isolated = [];
const other = createUiRegistry(snapshot => isolated.push(snapshot));
other.register({ id: "first", slot: "top" }).update({ enabled: true });
assert.equal(last().bottomNavItems.length, 1, "registries are page-local");
assert.throws(() => registry.register({ id: "first", slot: "bottom" }), /Duplicate/);
assert.throws(() => registry.register({ id: "invalid", slot: "top", navigation: { label: "No", icon: "no" } }), /Only bottom/);
const beforeDispose = snapshots.length;
registry.dispose(); replacement.update({ enabled: false }); registry.select("first");
assert.equal(registry.dispatch({ moduleId: "first", action: "select" }), false);
assert.equal(snapshots.length, beforeDispose, "disposed page ignores callbacks");
assert.throws(() => registry.register({ id: "late", slot: "top" }), /disposed/);
console.log("PASS AR UI slots, scoped actions/debug, selection, batching, unregister and per-page disposal");

{
  let snapshot, opened = 0;
  const ui = createUiRegistry(value => { snapshot = value; });
  const manual = ui.register({ id: "manual", slot: "bottom", autoExpand: false,
    navigation: { label: "Manual", icon: "manual" }, onActivate() { opened++; } });
  const compass = ui.register({ id: "compass", slot: "top-center" });
  ui.batch(() => { manual.update({ enabled: true }); compass.update({ enabled: true }); });
  assert.equal(snapshot.activeBottomPanel, "manual");
  assert.equal(snapshot.bottomPanelExpanded, false, "an opt-in feature does not open just because it is the only entry");
  assert.deepEqual(Array.from(snapshot.slots["top-center"]), ["compass"]);
  assert.equal(opened, 0);
  ui.select("compass");
  assert.equal(snapshot.bottomPanelExpanded, false, "top-center is a presentation slot, not a bottom entry");
  manual.update({ enabled: true });
  assert.equal(opened, 0, "background availability updates cannot activate an opt-in feature");
  ui.select("manual");
  assert.equal(snapshot.bottomPanelExpanded, true);
  assert.equal(opened, 1, "the first tap opens the automatically selected but collapsed feature");
  ui.select("manual"); manual.update({ enabled: true });
  assert.equal(snapshot.bottomPanelExpanded, false);
  manual.update({ enabled: false }); manual.update({ enabled: true });
  assert.equal(snapshot.bottomPanelExpanded, false, "returning availability still requires a tap");
  assert.equal(opened, 1);
  compass.unregister();
  assert.equal(snapshot.slots["top-center"].length, 0);
  ui.dispose();
}
console.log("PASS top-center contributions and explicit activation of opt-in panels");

const recognitionModule = { exports: {} };
const recognitionFile = path.resolve(__dirname, "../miniprogram/pages/ar/modules/recognition.ts");
vm.runInNewContext(transformSync(fs.readFileSync(recognitionFile, "utf8"), { loader: "ts", format: "cjs" }).code,
  { module: recognitionModule, exports: recognitionModule.exports });
const recognition = recognitionModule.exports;
const controlsTag = fs.readFileSync(path.resolve(__dirname, "../miniprogram/pages/ar/ar.wxml"), "utf8").match(/<ar-recognition-controls\b[^>]+>/)[0];
assert.match(controlsTag, /slot="top-center"/);
const controlsCondition = controlsTag.match(/wx:if="\{\{(.*?)\}\}"/)[1];
for (const mode of ["hybrid", "anchor", "gps"]) {
  let snapshot, binding, rescans = 0;
  const ui = createUiRegistry(value => { snapshot = value; });
  const page = { ...recognition.recognitionMethods,
    data: { ...recognition.recognitionData, retrievalMode: mode, mapConfigReady: true }, _pageVisible: true,
    setData(patch) { Object.assign(this.data, patch); }, syncUI() { binding.sync(); },
    selectComponent() { return { rescan() { rescans++; } }; },
  };
  binding = recognition.registerRecognition(page, ui); binding.sync();
  assert.equal(snapshot.bottomNavItems.length, 0, "recognition never registers as an activity, even without other modules");
  assert.equal(snapshot.slots["top-center"].includes("recognition"), mode !== "gps");
  assert.equal(vm.runInNewContext(controlsCondition, page.data), mode !== "gps", "recognition controls do not need an activity panel");
  ui.select("recognition");
  assert.equal(snapshot.activeBottomPanel, "", "recognition cannot be selected as a bottom activity");
  page.onRecognitionHint({ detail: { mode, active: true } });
  assert.equal(page.data.recognitionHintActive, mode !== "gps");
  assert.equal(ui.dispatch({ moduleId: "recognition", action: "rescan" }), mode !== "gps");
  assert.equal(rescans, mode === "gps" ? 0 : 1);
  assert.equal(page.data.recognitionHintActive, false);
  page.data.mapConfigReady = false; binding.sync();
  assert.equal(snapshot.slots["top-center"].length, 0, "recognition waits for a valid map config");
  assert.equal(vm.runInNewContext(controlsCondition, page.data), false);
  assert.equal(ui.dispatch({ moduleId: "recognition", action: "rescan" }), false);
  ui.dispose();
}
console.log("PASS recognition controls live outside activity navigation and retain hints/rescan in hybrid and image modes");
