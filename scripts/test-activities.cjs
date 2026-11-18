const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { transformSync } = require("esbuild");
const root = path.resolve(__dirname, "../miniprogram");
const copy = (value) => JSON.parse(JSON.stringify(value));
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const at = { latitude: 31.2, longitude: 121.5 };
const point = (n) => ({ id: uuid(200 + n), point_id: uuid(200 + n), name: `Point ${n}`, description: "Point", image_url: null, reward_url: "https://example.test/reward.png", ...at });
const activity = (n, type = "danmaku", points = []) => ({ id: uuid(n), activity_id: uuid(20 + n), workspace_id: uuid(900 + n), workspace_name: `Map ${n}`, type, name: `Activity ${n}`, display_name: `Activity ${n}`, config: {}, location: null, radius_meters: null, points });
const tick = () => new Promise((resolve) => setImmediate(resolve));

// Evaluate the production bindings as well as the page state; retained navigation
// data must not make the compass visible outside its active panel.
const arWxml = fs.readFileSync(path.join(root, "pages/ar/ar.wxml"), "utf8");
const compassBinding = arWxml.match(/<ar-shop-compass\b[\s\S]*?active="\{\{(.*?)\}\}"/)[1];
const compassCondition = fs.readFileSync(path.join(root, "components/ar-shop-compass/index.wxml"), "utf8").match(/wx:if="\{\{(.*?)\}\}"/)[1];
function compassVisible(page) {
  const active = vm.runInNewContext(compassBinding, page.data);
  return vm.runInNewContext(compassCondition, { active, navigation: page.data.shopNavigation });
}

function launch(storage = new Map()) {
  const calls = { requests: [], toasts: [], writes: [], navigation: [], danmaku: [], reports: [], keyboardHides: 0, retrieval: [], moduleActions: [], headings: [], sensorStops: 0 };
  let sensorTime = Date.now(), compassCallback;
  const wx = {
    getAccountInfoSync: () => ({ miniProgram: { envVersion: "develop" } }),
    getDeviceInfo: () => ({ platform: "devtools" }),
    getStorageSync: (key) => storage.has(key) ? copy(storage.get(key)) : "",
    setStorageSync(key, value) { storage.set(key, copy(value)); calls.writes.push(key); },
    request(options) { calls.requests.push(options); },
    showToast(options) { calls.toasts.push(options.title); },
    hideKeyboard() { calls.keyboardHides++; },
    getLocation({ success }) { success({ ...at, accuracy: 5, altitude: 10 }); },
    startCompass({ success }) { success(); },
    onCompassChange(callback) { compassCallback = callback; },
    offCompassChange(callback) { assert.equal(callback, compassCallback); calls.sensorStops++; },
    stopCompass() {},
  };
  let pageDefinition, componentDefinition;
  const context = vm.createContext({ wx, Date: class extends Date { static now() { return sensorTime; } }, console: { log() {}, error() {} }, setTimeout, clearTimeout,
    Page(value) { pageDefinition = value; }, Component(value) { componentDefinition = value; } });
  const modules = new Map();
  modules.set(path.join(root, "utils/backend-environment.ts"), { exports: { resolveBackendBaseUrl: () => "https://example.test" } });
  // Error reports are covered by test-backend-environment; record them here.
  modules.set(path.join(root, "utils/report-error.ts"), { exports: { reportError: (source, error) => calls.reports.push({ source, message: error?.message || String(error) }) } });
  function load(file) {
    if (!path.extname(file)) file += fs.existsSync(file + ".ts") ? ".ts" : ".js";
    if (modules.has(file)) return modules.get(file).exports;
    const module = { exports: {} };
    modules.set(file, module);
    const code = transformSync(fs.readFileSync(file, "utf8"), { loader: file.endsWith(".ts") ? "ts" : "js", format: "cjs" }).code;
    vm.runInContext(`(function(require,module,exports){${code}\n})`, context, { filename: file })(
      (name) => load(path.resolve(path.dirname(file), name)), module, module.exports);
    return module.exports;
  }
  const backend = load(path.join(root, "utils/backend.ts"));
  backend.setConfig({ workspaceId: uuid(900), organizationId: uuid(901) });
  const state = load(path.join(root, "utils/activity-state.ts"));
  const frame = { updateCompassHeading(value) { calls.headings.push(value); }, pauseRetrieval() { calls.retrieval.push("pause"); }, resumeRetrieval() { calls.retrieval.push("resume"); }, rescan() { calls.retrieval.push("rescan"); }, setNavigationTarget(value) { calls.navigation.push(value); }, showDanmakuInXR(value) { calls.danmaku.push(value); }, setRetrievalMode() {} };
  function page() {
    load(path.join(root, "pages/ar/ar.ts"));
    return { ...pageDefinition, data: copy(pageDefinition.data), setData(patch) { Object.assign(this.data, patch); }, selectComponent() { return frame; } };
  }
  function component(activities, legacy = {}) {
    storage.set("checkedInShopIds", legacy);
    load(path.join(root, "components/shop-checkin/index.js"));
    const host = { ...componentDefinition.methods, data: copy(componentDefinition.data), properties: { activities, location: { ...at }, visible: false, compassHeading: 0 },
      setData(patch) { Object.assign(this.data, patch); }, triggerEvent(name, value) { if (name === "moduleaction") { calls.moduleActions.push(value); if (value.action === "target") calls.navigation.push(value.payload.shop); } } };
    componentDefinition.lifetimes.attached.call(host);
    return { host, definition: componentDefinition };
  }
  function uiComponent(name, dispatch = () => {}) {
    load(path.join(root, `components/${name}/index.js`));
    return { ...componentDefinition.methods, triggerEvent(event, detail) { dispatch(event, detail); } };
  }
  function respond(statusCode, data) {
    const request = calls.requests.shift();
    assert.ok(request, "a request is pending");
    request.success({ statusCode, data });
    return request;
  }
  return { backend, state, calls, page, component, uiComponent, storage, respond, compass: (heading, ms = 0) => { sensorTime += ms; compassCallback({ direction: heading }); }, activitySource: options => load(path.join(root, "components/xr-start/render-modules/activity-source.js")).createActivitySource(options) };
}

async function main() {
  const first = launch();
  const participant = first.state.activityParticipantId();
  assert.match(participant, /^[0-9a-f-]{36}$/);
  assert.equal(launch(first.storage).state.activityParticipantId(), participant, "device participant survives relaunch");
  assert.equal(first.state.activityDistance(at, { latitude: null, longitude: null }), null, "directory points never become the equator");
  assert.equal(first.state.withinActivityScope(activity(1), null), false);
  const ranged = { ...activity(1), location: at, radius_meters: 50 };
  assert.equal(first.state.withinActivityScope(ranged, at), true);
  assert.equal(first.state.withinActivityScope(ranged, { latitude: 31.3, longitude: 121.5 }), false);
  assert.throws(() => first.state.parseActivityPlacements([{ ...ranged, location: null }]), /范围/);
  assert.throws(() => first.state.parseActivityPlacements([{ ...activity(1), points: [{ ...point(1), latitude: null }] }]), /打卡点/);
  assert.throws(() => first.state.parseActivityPlacements([{ ...activity(1), workspace_id: undefined }]), /活动格式/);
  assert.equal(first.state.parseActivityPlacements([activity(1)])[0].display_name, "Activity 1");
  const sharedMaps = [activity(1), { ...activity(2), activity_id: activity(1).activity_id, name: activity(1).name }];
  assert.deepEqual(copy(first.state.parseActivityPlacements(sharedMaps, true).map((item) => item.display_name)), ["Activity 1 · Map 1", "Activity 1 · Map 2"]);
  const sharedShop = activity(3, "shop_checkin", [point(1), point(2)]);
  const shopMaps = first.state.parseActivityPlacements([sharedShop, { ...sharedShop, id: uuid(4), workspace_id: uuid(904), workspace_name: "Map 4" }], true);
  assert.deepEqual(copy(shopMaps[0].points), copy(shopMaps[1].points), "both maps consume the same fixed activity locations and point IDs");
  assert.notEqual(shopMaps[0].id, shopMaps[1].id, "participation remains scoped to a map association");

  const sensors = launch(), sensorPage = sensors.page();
  sensorPage._startCompassWatch();
  sensors.compass(127);
  assert.equal(sensorPage.data.compassHeading, 127, "first compass sample is accepted");
  assert.equal(sensorPage.data.debugItems.find(item => item.key === "sensors:heading").value, "127°");
  sensors.compass(127, 250);
  assert.deepEqual(sensors.calls.headings, [127], "stationary readings do not redraw the compass");
  sensors.compass(130, 250);
  assert.equal(sensorPage.data.compassHeading, 130);
  assert.equal(sensorPage.data.compassDebugHeading, 127, "top diagnostics update at most once a second");
  sensors.compass(359, 1000); sensors.compass(0, 250);
  assert.equal(sensorPage.data.compassHeading, 359, "one-degree changes across north stay below the redraw threshold");
  sensorPage.onUnload(); sensors.compass(90, 1000);
  assert.equal(sensorPage.data.compassHeading, 359, "late sensor callbacks cannot update an unloaded page");
  assert.equal(sensors.calls.sensorStops, 1);

  // Recognition hints only decorate the AR controls; they never take over a panel or
  // revive after a map/page lifecycle reset, even if status and hint arrive apart.
  {
    const hints = launch(), hintPage = hints.page(), activities = [activity(31), activity(32)];
    let pageWrites = 0;
    const write = hintPage.setData;
    hintPage.setData = function(patch) { pageWrites++; write.call(this, patch); };
    const hint = (active, mode = "anchor") => hintPage.onRecognitionHint({ detail: { mode, active } });
    const map = (retrievalMode = "anchor", ready = true) => hintPage.onMapConfigLoad({ detail: { ready, retrievalMode } });
    const status = (phase, locked = false) => hintPage.onRecognitionStatus({ detail: { mode: "anchor", phase, locked, message: phase } });
    const recognitionAvailable = () => hintPage.data.slots["top-center"].includes("recognition");
    map(); hint(true);
    assert.equal(hintPage.data.recognitionHintActive, false, "events before the page is visible are ignored");
    hintPage.onShow(); hints.respond(200, activities); await tick();
    hintPage.onPanelChange({ detail: { id: "danmaku" } });
    assert.equal(hintPage.data.bottomPanelExpanded, false);
    const originalNavigation = copy(hintPage.data.bottomNavItems);
    hint(true);
    assert.equal(hintPage.data.recognitionHintActive, true, "a hint can arrive before its scanning status");
    assert.deepEqual(copy(hintPage.data.bottomNavItems), originalNavigation, "hints never change navbar icons or badges");
    assert.equal(hintPage.data.bottomPanelExpanded, false, "a collapsed panel stays collapsed when hinted");
    status("scanning");
    assert.equal(hintPage.data.recognitionHintActive, true, "the following scanning status must retain the hint");
    const writesBeforeRepeat = pageWrites;
    hint(true); hint(false, "gps");
    assert.equal(pageWrites, writesBeforeRepeat, "duplicate and other-mode hints do not call setData");
    hintPage.onPanelChange({ detail: { id: "danmaku" } });
    hintPage.onDanmakuActivityChange({ detail: { value: "1" } });
    hintPage.onTextInput({ detail: { value: "unfinished comment" } });
    hintPage.onKeyboardHeightChange({ detail: { height: 280 } });
    const selectedActivity = hintPage.data.activeDanmaku.id;
    const keyboardHides = hints.calls.keyboardHides;
    hint(false); hint(true); status("reacquiring", true);
    assert.equal(hintPage.data.recognitionHintActive, true);
    assert.equal(hintPage.data.recognitionLocked, true, "shown content remains locked while another target is hinted");
    assert.equal(recognitionAvailable(), true);
    assert.ok(!hintPage.data.bottomNavItems.some(item => item.key === "recognition"));
    assert.equal(hintPage.data.activeBottomPanel, "danmaku");
    assert.equal(hintPage.data.bottomPanelExpanded, true);
    assert.equal(hintPage.data.activeDanmaku.id, selectedActivity);
    assert.equal(hintPage.data.textContent, "unfinished comment");
    assert.equal(hintPage.data.keyboardHeight, 280);
    assert.equal(hints.calls.keyboardHides, keyboardHides, "a hint cannot interrupt composing");
    for (const phase of ["loading", "locked", "error", "idle"]) {
      hint(true); status(phase, phase === "locked");
      assert.equal(hintPage.data.recognitionHintActive, false, `${phase} clears the hint`);
    }
    hint(true); hintPage.onRescan();
    assert.equal(hints.calls.retrieval.at(-1), "rescan");
    assert.equal(hintPage.data.recognitionHintActive, false);
    hint(true); map("anchor", false); hint(true);
    assert.equal(hintPage.data.recognitionHintActive, false, "loading maps cannot accept hints");
    assert.equal(recognitionAvailable(), false);
    map();
    assert.equal(hintPage.data.recognitionHintActive, false, "loaded maps never restore a previous hint");
    hint(true); map("gps"); hint(true);
    assert.equal(hintPage.data.recognitionHintActive, false, "GPS mode ignores anchor hints");
    assert.equal(recognitionAvailable(), false);
    map(); hint(true); hintPage.onHide();
    assert.equal(hintPage.data.recognitionHintActive, false);
    const hiddenWrites = pageWrites;
    hint(true);
    assert.equal(pageWrites, hiddenWrites, "late hidden-page hints are ignored");
    hintPage.onShow(); hints.respond(200, activities); await tick();
    assert.equal(hintPage.data.recognitionHintActive, false);
    hint(true); hintPage.onUnload();
    assert.equal(hintPage.data.recognitionHintActive, false);
    const unloadedWrites = pageWrites;
    hint(true);
    assert.equal(pageWrites, unloadedWrites, "unloaded-page hints are ignored");
    console.log("PASS recognition hints preserve panel selection/drafts and reset across status, map, rescan and page lifecycles");
  }

  const app = launch();
  const page = app.page();
  page.data.location = { ...at };
  const definitions = [activity(1), { ...activity(2), config: { maxLength: 3 } }, activity(3, "shop_checkin", [point(1), point(2)])];
  const loading = page.refreshActivities();
  assert.match(app.calls.requests[0].url, /\/activities\?workspace_id=/);
  app.respond(200, definitions); await loading;
  assert.equal(page.data.shopActivities.length, 1);
  assert.equal(page.data.danmakuActivities.length, 2);
  page.onMapConfigLoad({ detail: { ready: true, retrievalMode: "gps", footerEnabled: true } });
  assert.equal(page.data.shopCheckinEnabled, true, "map display configuration does not hide active deployments");
  page.onTextInput({ detail: { value: "Hello" } });
  assert.equal(page.data.canSubmit, true);
  const failed = page.submitText();
  assert.equal(page.data.isSubmitting, true);
  assert.equal(page.data.textContent, "Hello", "do not clear drafts before acknowledgement");
  assert.equal(app.calls.danmaku.length, 0);
  await page.submitText();
  assert.equal(app.calls.requests.length, 1, "double taps cannot duplicate a request");
  const firstBody = copy(app.calls.requests[0].data);
  assert.equal(firstBody.placement_id, uuid(1));
  assert.match(app.calls.requests[0].url, /\/activity-records$/);
  assert.equal("p_workspace_id" in firstBody, false);
  app.calls.requests.shift().fail(new Error("connection lost after commit")); await failed;
  assert.ok(app.calls.reports.some(report => report.source === "activities.submit" && /connection lost/.test(report.message)), "a failed submission is reported");
  assert.equal(page.data.textContent, "Hello");
  assert.equal(page.data.isSubmitting, false);
  page.data.location = { latitude: 31.201, longitude: 121.501 };
  const retry = page.submitText();
  assert.deepEqual(copy(app.calls.requests[0].data), firstBody, "uncertain retry retains both idempotency key and original GPS body");
  app.respond(200, { id: uuid(500) }); await retry;
  assert.equal(page.data.textContent, "");
  assert.deepEqual(app.calls.danmaku, ["Hello"], "animate only acknowledged content");
  page.onDanmakuActivityChange({ detail: { value: "1" } });
  page.onTextInput({ detail: { value: "Long text" } });
  assert.equal(page.data.canSubmit, false);
  page.onTextInput({ detail: { value: "Hi" } });
  assert.equal(page.data.canSubmit, true);
  const second = page.submitText();
  assert.equal(app.calls.requests[0].data.placement_id, uuid(2));
  assert.notEqual(app.calls.requests[0].data.idempotency_key, firstBody.idempotency_key);
  app.respond(200, { id: uuid(501) }); await second;
  page.onMapConfigLoad({ detail: { ready: true, retrievalMode: "anchor", footerEnabled: false } });
  page.onTextInput({ detail: { value: "Hi" } });
  assert.equal(page.data.canSubmit, true, "matching and in-range danmaku must coexist");
  const anchorSubmission = page.submitText();
  assert.equal(app.calls.requests[0].data.placement_id, uuid(2));
  app.respond(200, { id: uuid(503), placement_id: uuid(2) }); await anchorSubmission;
  assert.equal(app.calls.danmaku.at(-1), "Hi", "matching uses acknowledged activity records too");
  const selectPanel = (panel) => page.onPanelChange({ detail: { id: panel } });
  assert.deepEqual(copy(page.data.bottomNavItems.map(item => item.key)), ["danmaku", "shop"]);
  assert.equal(page.data.activeBottomPanel, "danmaku", "recognition mode does not determine the selected activity");
  page.onTextInput({ detail: { value: "Hi" } });
  page.onKeyboardHeightChange({ detail: { height: 280 } });
  assert.equal(page.data.keyboardHeight, 280);
  selectPanel("shop");
  assert.equal(page.data.keyboardHeight, 0);
  assert.equal(page.data.showShopPanel, true);
  assert.equal(app.calls.keyboardHides, 1);
  selectPanel("recognition");
  assert.equal(page.data.activeBottomPanel, "shop", "recognition is not a selectable activity");
  selectPanel("danmaku"); selectPanel("danmaku");
  assert.equal(page.data.showShopPanel, true, "switching tabs leaves shop navigation mounted and active");
  assert.equal(page.data.textContent, "Hi", "tab changes preserve the comment draft");
  assert.deepEqual(app.calls.retrieval, [], "navbar never pauses or restarts recognition");
  page.onKeyboardHeightChange({ detail: { height: 280 } });
  assert.equal(page.data.keyboardHeight, 0, "late keyboard events from a removed composer cannot move other panels");
  assert.equal(page.data.bottomPanelExpanded, false);
  page.syncUI();
  assert.equal(page.data.bottomPanelExpanded, false, "discovery refresh does not reopen a collapsed panel");
  page.getLocation();
  page.onMatchProgress({ detail: { mode: "anchor", text: "42 特征点 · 3 候选" } });
  assert.equal(page.data.debugItems.find(item => item.key === "sensors:gps").value, "±5.0m");
  assert.equal(page.data.debugItems.find(item => item.key === "recognition:match").value, "42 特征点 · 3 候选");
  page.onRecognitionStatus({ detail: { mode: "anchor", message: "正在准备图像识别…", diagnostic: "正在准备参考图（2/7）…", phase: "preparing" } });
  assert.equal(page.data.recognitionStatus, "正在准备图像识别…");
  assert.equal(page.data.debugItems.find(item => item.key === "recognition:status").value, "正在准备参考图（2/7）…");
  selectPanel("location"); selectPanel("unknown");
  assert.equal(page.data.activeBottomPanel, "danmaku", "diagnostics are not a business navigation item");
  assert.equal(page.data.bottomPanelExpanded, false, "diagnostics cannot reopen the bottom panel");
  selectPanel("danmaku");
  assert.equal(page.data.textContent, "Hi");
  assert.equal(page.data.selectedDanmakuIdx, 1);
  page.syncUI();
  assert.equal(page.data.activeBottomPanel, "danmaku", "background refresh preserves manual selection");
  page.onKeyboardHeightChange({ detail: { height: 280 } });
  assert.equal(page.data.keyboardHeight, 280);
  page.onComposerBlur();
  assert.equal(page.data.keyboardHeight, 0);
  page.onKeyboardHeightChange({ detail: { height: -1 } });
  assert.equal(page.data.keyboardHeight, 0);
  page.onKeyboardHeightChange({ detail: { height: 280 } });
  const composer = app.uiComponent("ar-danmaku-panel", (name, detail) => { assert.equal(name, "moduleaction"); page.onModuleAction({ detail }); });
  composer.onInput({ detail: { value: "OK" } });
  assert.equal(page.data.textContent, "OK", "presentation events reach the registered feature handler");
  const recognitionControls = app.uiComponent("ar-recognition-controls", (name, detail) => page.onModuleAction({ detail }));
  recognitionControls.onRescan();
  assert.equal(app.calls.retrieval.at(-1), "rescan");
  assert.equal(page.onModuleAction({ detail: { moduleId: "recognition", action: "toString" } }), false);
  page.onModuleAction({ detail: { moduleId: "shop", action: "compass", payload: { visible: true, title: "Cafe", distance: "12m", angle: 90 } } });
  selectPanel("recognition");
  assert.equal(page.data.shopNavigation.visible, true, "navigation data survives a panel switch");
  assert.equal(compassVisible(page), false, "recognition actions do not open the shop compass");
  page.onHide();
  assert.equal(page.data.keyboardHeight, 0, "returning to AR cannot retain a stale keyboard offset");
  page._activityVisible = true;
  const refreshed = page.refreshActivities(); app.respond(200, []); await refreshed;
  assert.equal(page.data.shopCheckinEnabled, false);
  assert.equal(page.data.shopNavigation.visible, false, "removed deployments clear their overlay");
  assert.deepEqual(copy(page.data.slots["top-center"]), ["recognition"], "removing shops retains the independent recognition controls");
  assert.equal(page.data.activeDanmaku, null);
  assert.equal(page.data.activeBottomPanel, "", "removing all activities leaves no bottom panel");
  assert.deepEqual(copy(page.data.bottomNavItems), []);
  await page.submitText(); assert.equal(app.calls.requests.length, 0);
  const stale = page.refreshActivities(); page.onHide(); app.respond(200, definitions); await stale;
  assert.equal(page.data.activeDanmaku, null, "a response after hiding cannot re-enable activities");
  const failedLoad = page.refreshActivities(); app.respond(503, {}); await failedLoad;
  assert.ok(page.data.activitiesError);
  assert.ok(page.data.bottomNavItems.some(item => item.key === "danmaku"), "failed discovery keeps a retry entry in the navbar");
  app.backend.setConfig({ organizationId: uuid(901) });
  const allMaps = page.refreshActivities();
  assert.match(app.calls.requests[0].url, /\/activities\?organization_id=/);
  assert.doesNotMatch(app.calls.requests[0].url, /workspace_id=/);
  app.respond(200, definitions); await allMaps;
  assert.equal(page.data.danmakuActivities.length, 2, "organization-only QR retains activity access across all maps");
  assert.equal(page.data.danmakuActivities[0].display_name, "Activity 1 · Map 1");
  page._activityVisible = true;
  const oldPageDiscovery = page.refreshActivities();
  const newerDiscoverySequence = app.state.nextActivityDiscoverySequence();
  page.onActivitiesLoad({ detail: { activities: [], discoverySequence: newerDiscoverySequence } });
  app.respond(200, definitions); await oldPageDiscovery;
  assert.equal(page.data.activeDanmaku, null, "an older page response cannot undo the XR's newer paused activity list");
  const newPageDiscovery = page.refreshActivities();
  app.respond(200, definitions); await newPageDiscovery;
  page.onActivitiesLoad({ detail: { activities: [], error: true, discoverySequence: newerDiscoverySequence } });
  assert.equal(page.data.danmakuActivities.length, 2, "an older XR failure cannot erase newer page discovery");
  console.log("PASS activity discovery, multiple deployments, scope/limits, disabled entry points and acknowledged/idempotent danmaku");

  for (const mode of ["gps", "anchor", "hybrid"]) {
    const shops = launch(), shopPage = shops.page();
    const deployments = [activity(40, "shop_checkin", [point(1), point(2)])];
    const { host: shop, definition } = shops.component(deployments);
    const select = shopPage.selectComponent.bind(shopPage);
    shopPage.selectComponent = id => id === "#shop-checkin" ? shop : select(id);
    const setData = shopPage.setData.bind(shopPage);
    shopPage.setData = patch => {
      setData(patch);
      if ("showShopPanel" in patch && shop.properties.visible !== patch.showShopPanel) {
        shop.properties.visible = patch.showShopPanel;
        definition.observers.visible.call(shop, patch.showShopPanel);
      }
    };
    const trigger = shop.triggerEvent.bind(shop);
    shop.triggerEvent = (name, detail) => {
      trigger(name, detail);
      if (name === "moduleaction") shopPage.onModuleAction({ detail });
    };
    const choose = id => shopPage.onPanelChange({ detail: { id } });
    const apply = values => shopPage.applyActivities(values, shops.state.nextActivityDiscoverySequence());
    shopPage.onMapConfigLoad({ detail: { ready: true, retrievalMode: mode } });
    apply(deployments);
    assert.deepEqual(copy(shopPage.data.slots["top-center"]), mode === "gps" ? ["shop-compass"] : ["recognition", "shop-compass"]);
    assert.equal(shopPage.data.activeBottomPanel, "shop");
    assert.equal(shopPage.data.bottomPanelExpanded, false, "even a shop-only map waits for a tap");
    assert.equal(shopPage.data.showShopPanel, false);
    assert.equal(compassVisible(shopPage), false);
    assert.equal(shops.calls.requests.length, 0, "merely discovering shops does not start navigation or fetch progress");
    shopPage.syncUI();
    assert.equal(shopPage.data.showShopPanel, false);

    choose("shop");
    assert.equal(shopPage.data.bottomPanelExpanded, true);
    assert.equal(shops.calls.requests.length, 1);
    choose("shop"); // Collapse while progress is in flight.
    shops.respond(200, { point_ids: [point(1).point_id] }); await tick();
    assert.equal(shopPage.data.shopNavigation.visible, true);
    assert.equal(compassVisible(shopPage), false, "a late progress response cannot reveal a collapsed compass");
    assert.equal(shop.data.checkedInCount, 1);
    choose("shop");
    assert.equal(compassVisible(shopPage), true);
    shops.respond(200, { point_ids: [point(1).point_id] }); await tick();
    shop.onSwiperChange({ detail: { current: 1 } });
    assert.equal(shopPage.data.shopNavigation.title, point(2).name);
    shop._showReward(point(1));
    apply([...deployments, activity(41)]);
    choose("danmaku");
    assert.equal(compassVisible(shopPage), false);
    assert.equal(shop.data.selectedShopIdx, 1, "switching panels preserves the selected shop");
    assert.equal(shop.data.checkedInCount, 1, "switching panels preserves server progress");
    assert.equal(shopPage.data.shopReward.visible, true, "reward presentation has an independent overlay lifetime");
    shop.properties.compassHeading = 180;
    definition.observers.compassHeading.call(shop);
    assert.equal(compassVisible(shopPage), false, "sensor updates cannot reveal another panel's compass");
    const reward = shops.uiComponent("ar-shop-overlays", (name, detail) => shopPage.onModuleAction({ detail }));
    reward.onClose();
    assert.equal(shopPage.data.shopReward.visible, false, "reward actions still reach the shop module");

    choose("shop");
    assert.equal(compassVisible(shopPage), true);
    assert.equal(shopPage.data.shopNavigation.title, point(2).name);
    assert.equal(shops.calls.requests.length, 1, "reopening refreshes server progress");
    apply([]);
    definition.lifetimes.detached.call(shop);
    shops.respond(200, { point_ids: [] }); await tick();
    assert.equal(compassVisible(shopPage), false, "removed activities cannot be revived by pending progress");
    assert.equal(shopPage.data.shopNavigation.visible, false);
    assert.deepEqual(copy(shopPage.data.slots["top-center"]), mode === "gps" ? [] : ["recognition"]);
    assert.equal(shopPage.onModuleAction({ detail: { moduleId: "shop", action: "compass", payload: { visible: true } } }), false);
    console.log(`PASS ${mode}: shop compass requires a tap, follows panel visibility and preserves selection/progress across switches`);
  }

  const shops = launch();
  const a = activity(10, "shop_checkin", [point(1), point(2), { ...point(3), latitude: null, longitude: null }]);
  const b = { ...activity(11, "shop_checkin", [{ ...point(1), id: uuid(111) }]), activity_id: a.activity_id };
  const { host, definition } = shops.component([a, b], { [point(1).id]: true, [uuid(999)]: true });
  assert.equal(host.data.checkedInCount, 0, "old local storage is never used as activity progress");
  assert.equal(host.data.shops[2].canCheckin, false);
  assert.equal(shops.calls.requests.length, 0, "local history must not generate server records");
  const progress = host.loadProgress();
  shops.respond(200, { point_ids: [] }); await progress;
  const checkin = host.onCheckin({ currentTarget: { dataset: { idx: 1 } } });
  assert.equal(host.data.checkedInCount, 0, "pending check-in is not progress");
  assert.equal(host.data.showCheckinModal, false);
  await host.onCheckin({ currentTarget: { dataset: { idx: 1 } } });
  assert.equal(shops.calls.requests.length, 1);
  const checkinBody = copy(shops.calls.requests[0].data);
  assert.equal(checkinBody.point_id, point(2).point_id, "post definition point identity, not old placement identity");
  shops.calls.requests.shift().fail(new Error("offline")); await checkin;
  assert.equal(host.data.checkedInCount, 0);
  const checkinRetry = host.onCheckin({ currentTarget: { dataset: { idx: 1 } } });
  assert.deepEqual(copy(shops.calls.requests[0].data), checkinBody);
  shops.respond(200, { id: uuid(502) }); await checkinRetry;
  assert.equal(host.data.checkedInCount, 1);
  assert.equal(host.data.checkedPointIds[point(2).point_id], true);
  assert.equal(host.data.showCheckinModal, true);
  assert.equal(shops.calls.moduleActions.at(-1).action, "reward");
  assert.equal(shops.calls.moduleActions.at(-1).payload.visible, true);
  assert.equal(shops.calls.writes.includes("checkedInShopIds"), false, "only server records determine progress");
  host.closeCheckinModal();
  assert.equal(shops.calls.moduleActions.at(-1).payload.visible, false);
  const oldProgress = host.loadProgress();
  host.onActivityChange({ detail: { value: "1" } });
  assert.equal(host.data.checkedInCount, 0, "progress is scoped to deployment even when point definitions are shared");
  shops.respond(200, { point_ids: [point(1).point_id, point(2).point_id] }); await oldProgress;
  assert.equal(host.data.checkedInCount, 0, "stale progress cannot overwrite another deployment");
  const bProgress = host.loadProgress(); shops.respond(200, { point_ids: [point(1).point_id] }); await bProgress;
  assert.equal(host.data.checkedInCount, 1);
  const late = host.loadProgress(); definition.lifetimes.detached.call(host); shops.respond(200, { point_ids: [] }); await late;
  assert.equal(host.data.checkedInCount, 1);
  assert.equal(host._computeDistances(a.points, a)[2].hasLocation, false);
  host._activateNavigation(a.points[2]);
  assert.equal(host.data.isNavigating, false);
  console.log("PASS multi-point check-in, server-only progress, deployment isolation, race handling and directory points");

  for (const mode of ["gps", "anchor"]) {
    const runtime = launch();
    runtime.backend.setConfig({ organizationId: uuid(901) });
    const removed = [], events = [], displayed = new Map();
    let generation = 1;
    const source = runtime.activitySource({
      capture() { const initial = generation; return () => generation === initial; }, getLocation: () => at,
      onDiscovery(detail) { events.push(detail); },
      onRemove(ids) { for (const id of ids) { removed.push(id); displayed.delete(id); } },
      onRecords(records) { for (const record of records) displayed.set(record.id, record); },
    });
    const record = (id, deployment) => ({ id: uuid(id), activity_id: deployment.activity_id, activity_placement_id: deployment.id,
      file_type: "text", text_content: `Record ${id}`, metadata: at });
    const d1 = activity(1), d2 = activity(2), outOfRange = { ...activity(3), location: { latitude: 30, longitude: 120 }, radius_meters: 20 };
    const initial = source.refresh();
    assert.match(runtime.calls.requests[0].url, /\/activities\?organization_id=/);
    await source.refresh();
    assert.equal(runtime.calls.requests.length, 1, "frame polling cannot start parallel discovery requests");
    runtime.respond(200, [d1, d2, outOfRange]); await tick();
    assert.equal(runtime.calls.requests.length, 2, "fetch only in-range activity streams");
    assert.ok(runtime.calls.requests.every(request => request.url.includes("/activity-records?placement_id=")));
    runtime.respond(200, [record(710, d1), record(711, d2)]); // Wrong placement is ignored.
    runtime.respond(200, [record(712, d2)]); await initial;
    assert.deepEqual([...displayed.keys()], [uuid(710), uuid(712)]);
    await source.refresh(); assert.equal(runtime.calls.requests.length, 0, "stationary refresh is throttled");
    const paused = source.refresh(true);
    runtime.respond(200, [d2]); await tick(); runtime.respond(200, [record(712, d2)]); await paused;
    assert.deepEqual(removed, [uuid(710)]);
    const moderated = source.refresh(true);
    runtime.respond(200, [d2]); await tick(); runtime.respond(200, []); await moderated;
    assert.equal(displayed.size, 0, "hidden records are removed from their owner");
    const staleRecords = source.refresh(true);
    runtime.respond(200, [d1]); await tick(); generation++; source.reset();
    runtime.respond(200, [record(710, d1)]); await staleRecords;
    assert.equal(displayed.size, 0, "late responses cannot revive a cleared layer");
    source.replace([record(710, d1)]);
    const supersededRecords = source.refresh(true);
    runtime.respond(200, [d1]); await tick();
    const oldRecordResponse = runtime.calls.requests.shift();
    const newerPage = runtime.page();
    newerPage.selectComponent = () => ({ setNavigationTarget() {}, applyActivityAvailability: source.applyAvailability });
    const newDiscovery = newerPage.refreshActivities();
    runtime.respond(200, []); await newDiscovery;
    assert.equal(displayed.size, 0, "newer page availability immediately removes hidden activity content");
    oldRecordResponse.success({ statusCode: 200, data: [record(710, d1)] }); await supersededRecords;
    assert.equal(displayed.size, 0, "newer page discovery also invalidates older record responses");
    const offline = source.refresh(true);
    runtime.calls.requests.shift().fail(new Error("offline")); await offline;
    assert.equal(events.at(-1).error, true);
    console.log(`PASS ${mode}: independent discovery, throttling, moderation, scope and layer cancellation`);
  }

  const presentations = ["ar-shell", "ar-debug-bar", "ar-recognition-controls", "ar-danmaku-panel", "ar-shop-compass", "ar-shop-overlays"];
  for (const [file, handlers] of [["pages/ar/ar.wxml", page], ["components/shop-checkin/index.wxml", host],
    ...presentations.map(name => [`components/${name}/index.wxml`, launch().uiComponent(name)])]) {
    for (const match of fs.readFileSync(path.join(root, file), "utf8").matchAll(/bind[\w:]+="(\w+)"/g)) assert.equal(typeof handlers[match[1]], "function", `${file}: ${match[1]}`);
  }
  console.log("PASS activity WXML event handlers exist");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
