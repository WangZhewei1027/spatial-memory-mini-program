// Real backend/page modules, with a fresh runtime on each launch and JSON storage
// to reproduce WeChat dropping undefined fields between real-device debug runs.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { transformSync } = require("esbuild");
const root = path.resolve(__dirname, "../miniprogram");
const CURRENT = "config:scan:v1";
const HISTORY = "config:scan:history:v1";
const ORG = "512301ab-2679-4350-81e1-520a3ab2afd4";
const SCENE = "8a5219f1-a635-46f7-9b3e-70d7c02ec63a";
const SECOND = "9b5219f1-a635-46f7-9b3e-70d7c02ec63a";
const MAP = "388bc7ed-068e-4e20-8e66-53aa1e952b98";
const sceneTarget = { organizationId: ORG, sceneId: SCENE };
const mapTarget = { organizationId: ORG, workspaceId: MAP };
const copy = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const flush = () => new Promise((resolve) => setImmediate(resolve));

function launch(storage = new Map(), overrides = {}) {
  const calls = { writes: 0, requests: [], redirects: [], navigations: [], relaunches: [], permissions: 0 };
  const wx = {
    getAccountInfoSync: () => ({ miniProgram: { envVersion: "develop" } }),
    getDeviceInfo: () => ({ platform: "devtools" }),
    showToast() {},
    getSystemInfoSync: () => ({ windowWidth: 390, windowHeight: 753, pixelRatio: 3 }),
    getStorageSync: (key) => copy(storage.get(key)),
    setStorageSync(key, value) { calls.writes++; storage.set(key, copy(value)); },
    request(options) { calls.requests.push(options); options.fail(new Error("offline")); },
    redirectTo: ({ url }) => calls.redirects.push(url),
    navigateTo: ({ url }) => calls.navigations.push(url),
    reLaunch: ({ url }) => calls.relaunches.push(url),
    getSetting({ success }) { calls.permissions++; success({ authSetting: {} }); },
    ...overrides,
  };
  const context = vm.createContext({ wx, console: { log() {}, error() {} }, Page(value) { context.page = value; } });
  const modules = new Map();
  // Keep the test independent of the ignored, machine-specific backend address.
  modules.set(path.join(root, "utils/backend-environment.ts"), { exports: { resolveBackendBaseUrl: () => "http://localhost:3000" } });
  function load(file) {
    if (!path.extname(file)) file += ".ts";
    if (modules.has(file)) return modules.get(file).exports;
    const module = { exports: {} };
    modules.set(file, module);
    const code = transformSync(fs.readFileSync(file, "utf8"), { loader: "ts", format: "cjs" }).code;
    vm.runInContext(`(function(require,module,exports){${code}\n})`, context, { filename: file })(
      (name) => load(path.resolve(path.dirname(file), name)), module, module.exports,
    );
    return module.exports;
  }
  function page(name) {
    load(path.join(root, `pages/${name}/${name}.ts`));
    return { ...context.page, data: copy(context.page.data), setData(patch) { Object.assign(this.data, patch); } };
  }
  return { storage, calls, wx, backend: load(path.join(root, "utils/backend.ts")), page };
}

async function main() {
  // Existing map and organization-only caches retain their exact scope after JSON reload.
  for (const saved of [mapTarget, { organizationId: ORG }]) {
    const app = launch(new Map([[CURRENT, saved]]));
    assert.deepEqual(copy(app.backend.CONFIG), saved);
    app.backend.setConfig({});
    assert.equal(app.calls.writes, 0, "empty launch query must not rewrite the selection");
    await app.page("index").onLoad({});
    assert.equal(app.calls.navigations.length, 0);
  }

  const first = launch();
  first.wx.navigateTo = ({ url }) => {
    assert.deepEqual(first.storage.get(CURRENT), sceneTarget, "persist before redirect");
    assert.equal(first.storage.get(HISTORY)[0].sceneId, SCENE, "record before redirect");
    first.calls.navigations.push(url);
  };
  const index = first.page("index");
  await index.onLoad(sceneTarget);
  index.onShow();
  assert.equal(first.calls.requests.length, 0, "Scene entry must not wait for names or maps");
  assert.equal(first.calls.permissions, 0, "Scene entry must not invoke map permissions");
  assert.equal(first.calls.navigations[0], `/pages/scene/scene?sceneId=${SCENE}&organizationId=${ORG}`);

  // Ordinary cold starts stay on the public catalog, with no synthetic history.
  const cold = launch(first.storage);
  assert.deepEqual(copy(cold.backend.CONFIG), sceneTarget, "default map must not leak into Scene");
  const coldHome = cold.page("index");
  coldHome.onLoad({});
  coldHome.onShow();
  await flush();
  assert.equal(cold.calls.navigations.length, 0);
  assert.match(cold.calls.requests[0].url, /api\/templates\?type=scene/);
  assert.equal(cold.backend.loadScanHistory().length, 1);
  const scene = cold.page("scene");
  scene.onLoad({});
  assert.equal(scene.data.sceneId, SCENE, "direct developer preview can still restore the saved Scene");
  assert.equal(scene.data.organizationId, ORG);
  assert.equal(scene.data.invalid, false);

  // Historical maps still show the map entry, while scenes open directly.
  first.backend.setConfig(mapTarget);
  const historyApp = launch(first.storage);
  const me = historyApp.page("me");
  me.onShow();
  await flush();
  assert.equal(me.data.history.length, 2);
  me.onSelectHistory({ currentTarget: { dataset: { key: historyApp.backend.scanHistoryKey(mapTarget) } } });
  assert.equal(historyApp.calls.navigations[0], "/pages/entry/entry");
  const entry = historyApp.page("entry");
  await entry.onLoad();
  assert.equal(entry.data.isScene, false);
  assert.deepEqual(historyApp.storage.get(CURRENT), mapTarget);
  entry.goToAR();
  assert.equal(historyApp.calls.navigations[1], `/pages/ar/ar?organizationId=${ORG}&workspaceId=${MAP}`);
  me.onSelectHistory({ currentTarget: { dataset: { key: historyApp.backend.scanHistoryKey(sceneTarget) } } });
  assert.equal(historyApp.calls.navigations[2], first.calls.navigations[0]);
  assert.deepEqual(historyApp.storage.get(CURRENT), sceneTarget);
  const selectorApp = launch(first.storage);
  await selectorApp.page("index").onLoad({ select: "1" });
  assert.equal(selectorApp.calls.navigations[0], "/pages/entry/entry");

  // Explicit scans supersede cache; incomplete or invalid Scene links never borrow the previous organization.
  for (const target of [{ organizationId: ORG, sceneId: SECOND }, mapTarget, { organizationId: ORG }]) {
    const app = launch(new Map([[CURRENT, sceneTarget]]));
    await app.page("index").onLoad(target);
    assert.deepEqual(app.storage.get(CURRENT), target);
    assert.deepEqual(copy(launch(app.storage).backend.CONFIG), target);
    assert.equal(app.calls.navigations[0], target.sceneId
      ? `/pages/scene/scene?sceneId=${SECOND}&organizationId=${ORG}` : "/pages/entry/entry");
  }
  for (const target of [{ sceneId: SECOND }, { organizationId: ORG, sceneId: "invalid" }]) {
    const app = launch(new Map([[CURRENT, sceneTarget]]));
    await app.page("index").onLoad(target);
    assert.deepEqual(app.storage.get(CURRENT), sceneTarget);
    assert.ok(app.calls.navigations[0].includes(`sceneId=${target.sceneId}`));
    const invalid = app.page("scene");
    invalid.onLoad(target);
    assert.equal(invalid.data.invalid, true);
    assert.equal(invalid.data.sceneId, "");
  }

  // Same UUID can identify a map and Scene; distinct Scenes within one team remain selectable.
  const history = launch();
  const targets = [sceneTarget, { organizationId: ORG, workspaceId: SCENE }, { organizationId: ORG, sceneId: SECOND }];
  targets.forEach(history.backend.setConfig);
  history.backend.recordScanHistory({ ...sceneTarget, orgName: "Team" });
  history.backend.setConfig(sceneTarget);
  assert.equal(history.backend.loadScanHistory().length, 3);
  assert.equal(history.backend.loadScanHistory()[0].orgName, "Team");
  assert.equal(new Set(history.backend.loadScanHistory().map(history.backend.scanHistoryKey)).size, 3);
  for (let i = 0; i < 25; i++) history.backend.setConfig({ organizationId: ORG, sceneId: `${String(i).padStart(8, "0")}-a635-46f7-9b3e-70d7c02ec63a` });
  assert.equal(history.backend.loadScanHistory().length, 20);
  assert.equal(history.backend.loadScanHistory()[0].sceneId.slice(0, 8), "00000024");

  // An in-flight name refresh cannot erase a Scene scanned after the request started.
  const pending = [];
  const race = launch(new Map([[HISTORY, [{ ...mapTarget, ts: 1 }]]]), { request: (options) => pending.push(options) });
  const refresh = race.page("me").refreshHistoryNames();
  race.backend.setConfig(sceneTarget);
  pending.forEach((request) => request.success({ statusCode: 200, data: [{ id: request.url.includes("organizations") ? ORG : MAP, name: "Renamed" }] }));
  await refresh;
  assert.equal(race.backend.loadScanHistory().length, 2);
  assert.ok(race.backend.loadScanHistory().some((e) => e.sceneId === SCENE));

  // Scene labels come from the server, remain cached offline and refresh after a rename.
  let sceneName = "老街舞台";
  const names = launch(new Map([[CURRENT, sceneTarget], [HISTORY, [
    { ...mapTarget, workspaceName: "老街地图", orgName: "Team", ts: 1 },
    { ...sceneTarget, ts: 2 },
  ]]]), { request(options) {
    const url = new URL(options.url);
    let data;
    if (url.pathname.endsWith("/scenes")) {
      assert.equal(url.searchParams.get("organization_id"), ORG);
      data = [{ id: SCENE, name: sceneName }];
    } else if (url.pathname.endsWith("/organizations")) {
      data = [{ id: ORG, name: "Team", config: { footer_enabled: true } }];
    } else data = [{ id: MAP, name: "老街地图" }];
    options.success({ statusCode: 200, data });
  } });
  const namesPage = names.page("me");
  namesPage.onShow();
  await flush();
  assert.equal(namesPage.data.history.find((e) => e.kind === "场景").name, sceneName);
  assert.equal(namesPage.data.history.find((e) => e.kind === "地图").name, "老街地图");
  sceneName = "新舞台";
  await namesPage.refreshHistoryNames();
  assert.equal(namesPage.data.history.find((e) => e.kind === "场景").name, sceneName);
  const offlinePage = launch(names.storage).page("me");
  offlinePage.onShow();
  assert.equal(offlinePage.data.history.find((e) => e.kind === "场景").name, sceneName);

  // Team-only QR requires explicit selection; even one available map is not selected silently.
  const maps = [{ id: MAP, organization_id: ORG, name: "河岸", config: { footer_enabled: true } }];
  const chooserApp = launch(new Map(), { request(options) {
    const url = new URL(options.url);
    options.success({ statusCode: 200, data: url.pathname.endsWith("/workspaces") ? maps : [{ id: ORG, name: "Team", config: { footer_enabled: false } }] });
  } });
  await chooserApp.page("index").onLoad({ organizationId: ORG });
  assert.deepEqual(chooserApp.calls.navigations.splice(0), ["/pages/entry/entry"]);
  const chooser = chooserApp.page("entry");
  await chooser.onLoad();
  assert.equal(chooser.data.needsMap, true);
  assert.equal(chooser.data.mapChoices.length, 1);
  chooser.goToAR();
  assert.equal(chooserApp.calls.navigations.length, 0);
  assert.equal(chooser.data.showFooter, false);
  chooser.onChooseMap({ detail: { value: "0" } }); await flush();
  assert.equal(chooser.data.needsMap, false);
  assert.equal(chooser.data.subtitle, "河岸");
  assert.equal(chooser.data.showFooter, true, "home uses map watermark, never team config");
  chooser.goToAR();
  assert.match(chooserApp.calls.navigations[0], new RegExp(`workspaceId=${MAP}`));
  const offlineTeam = launch(new Map([[CURRENT, { organizationId: ORG }]]));
  const offlineChooser = offlineTeam.page("entry"); await offlineChooser.onLoad();
  assert.equal(offlineChooser.data.needsMap, true); assert.ok(offlineChooser.data.mapsError);
  offlineChooser.goToAR(); assert.equal(offlineTeam.calls.navigations.length, 0);
  const emptyTeam = launch(new Map(), { request(options) { options.success({ statusCode: 200, data: [] }); } });
  emptyTeam.backend.setConfig({ organizationId: ORG });
  const emptyChooser = emptyTeam.page("entry"); await emptyChooser.onLoad();
  assert.equal(emptyChooser.data.mapChoices.length, 0); assert.equal(emptyChooser.data.mapsError, "");
  emptyTeam.page("ar").onLoad({});
  assert.equal(emptyTeam.calls.redirects[0], "/pages/entry/entry");

  // Denied/full storage must not stop an explicit Scene preview.
  const broken = launch(new Map(), {
    getStorageSync() { throw new Error("unavailable"); },
    setStorageSync() { throw new Error("full"); },
  });
  await broken.page("index").onLoad(sceneTarget);
  assert.equal(broken.calls.navigations[0], first.calls.navigations[0]);
  assert.deepEqual(copy(broken.backend.CONFIG), sceneTarget);
  // The real catalog client paginates, retries the failed page and stores the selected scene name.
  let failPage = true;
  const catalog = launch(new Map(), { request(options) {
    const url = new URL(options.url);
    assert.equal(url.pathname, "/api/templates");
    assert.equal(url.searchParams.get("type"), "scene");
    const offset = Number(url.searchParams.get("offset"));
    if (offset === 1 && failPage) {
      failPage = false;
      options.success({ statusCode: 503, data: { error: "offline" } });
      return;
    }
    options.success({ statusCode: 200, data: {
      data: [{ id: offset ? SECOND : SCENE, organization_id: ORG, name: offset ? "雨过营地" : "路口让行", thumbnail: null }],
      page: { hasMore: offset === 0 },
    } });
  } });
  const home = catalog.page("index");
  home.onLoad({});
  home.onShow();
  await flush();
  assert.deepEqual(copy(home.data.scenes.map((item) => item.name)), ["路口让行"]);
  assert.equal(catalog.backend.loadScanHistory().length, 0);
  await home.loadMoreScenes();
  assert.equal(home.data.error, true);
  assert.equal(home.data.scenes.length, 1);
  await home.retryScenes();
  assert.deepEqual(copy(home.data.scenes.map((item) => item.name)), ["路口让行", "雨过营地"]);
  assert.equal(home.data.hasMore, false);
  home.onOpenScene({ currentTarget: { dataset: { id: SECOND } } });
  assert.equal(catalog.calls.navigations[0], `/pages/scene/scene?sceneId=${SECOND}&organizationId=${ORG}`);
  assert.equal(catalog.backend.loadScanHistory()[0].sceneName, "雨过营地");

  console.log("PASS public catalog, map and Scene QR routing, browse history, retry and storage failures");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
