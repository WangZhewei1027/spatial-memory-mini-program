/** Real component lifecycle and mode selection; only native camera/network boundaries are replaced. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { transformSync } = require("esbuild");
const root = path.resolve(__dirname, "../miniprogram");
const config = { retrieval_mode: "anchor", text_asset_miniapp_style: "plain_white", confetti_enabled: true, footer_enabled: true };
const flush = () => new Promise((resolve) => setImmediate(resolve));

function launch(sceneId = "") {
  const CONFIG = { workspaceId: "map-a", organizationId: "team-a" };
  const requests = [], starts = [], events = [];
  let component;
  const backend = { CONFIG, fetchWorkspaces(ids, team) { return new Promise((resolve, reject) => requests.push({ ids, team, resolve, reject })); } };
  const context = vm.createContext({ console: { ...console, log() {}, warn() {} }, setTimeout, clearTimeout,
    wx: { env: { USER_DATA_PATH: "/tmp/map-config-test" }, getStorageSync(key) { assert.ok(!key.startsWith("config:org:"), "no retired team cache"); return ""; } },
    Component(value) { component = value; },
  });
  const modules = new Map([[path.join(root, "utils/backend.ts"), { exports: backend }]]);
  function load(file) {
    if (!path.extname(file)) file += fs.existsSync(file + ".js") ? ".js" : ".ts";
    if (modules.has(file)) return modules.get(file).exports;
    const module = { exports: {} }; modules.set(file, module);
    let code = fs.readFileSync(file, "utf8");
    if (file.endsWith(".ts")) code = transformSync(code, { loader: "ts", format: "cjs" }).code;
    vm.runInContext(`(function(require,module,exports){${code}\n})`, context, { filename: file })(
      (name) => load(path.resolve(path.dirname(file), name)), module, module.exports);
    return module.exports;
  }
  load(path.join(root, "components/xr-start/index.js"));
  const host = { ...component.methods, data: { ...component.data, sceneId },
    setData(patch) { Object.assign(this.data, patch); }, triggerEvent(name, detail) { events.push({ name, ...detail }); },
    startGPSWatch() {},
  };
  component.lifetimes.attached.call(host);
  host._runtime = { session: { mode: null, clearOSDMarkers() {} },
    start(mode) { this.session.mode = mode; starts.push(mode); }, stop() {}, dispose() {},
  };
  // No scene is rendered in this configuration test; cleanup of actual render resources has separate runtime coverage.
  host._clearRemoteAssets = () => {};
  const respond = (value = config, index = 0) => {
    const request = requests[index];
    request.resolve({ statusCode: 200, data: [{ id: request.ids[0], organization_id: request.team, config: value }] });
  };
  return { host, CONFIG, component, starts, requests, events, respond };
}

async function main() {
  for (const mode of ["anchor", "gps"]) {
    const app = launch(); await flush();
    app.host.startAR(); assert.deepEqual(app.starts, [], "slow configuration cannot start the default GPS camera");
    assert.equal(app.requests.length, 1);
    const pending = app.host.loadMapConfig(); assert.equal(app.requests.length, 1, "retry while pending shares the request");
    app.respond({ ...config, retrieval_mode: mode }); await pending;
    assert.deepEqual(app.starts, [mode === "anchor" ? "osd" : "slam"], "start the configured camera directly");
    assert.equal(app.host._textAssetStyle, "plain_white"); assert.equal(app.host._confettiEnabled, true);
    assert.ok(app.events.some((event) => event.ready && event.retrievalMode === mode && event.footerEnabled));
    app.component.pageLifetimes.hide.call(app.host);
    app.component.pageLifetimes.show.call(app.host);
    app.host.resumeRetrieval(); await flush();
    assert.equal(app.starts.length, 1, "returning waits for fresh map settings");
    app.respond({ ...config, retrieval_mode: mode === "anchor" ? "gps" : "anchor", footer_enabled: false }, 1);
    await app.host._mapConfigRequest;
    assert.equal(app.host._retrievalPaused, false);
    assert.equal(app.starts[1], mode === "anchor" ? "slam" : "osd");
    assert.equal(app.events.filter((event) => event.name === "mapconfigload").at(-1).footerEnabled, false);
    app.component.lifetimes.detached.call(app.host);
  }
  for (const invalid of [null, {}, { ...config, retrieval_mode: "unknown" }, { ...config, confetti_enabled: "true" }]) {
    const app = launch(); await flush(); app.respond(invalid); await app.host._mapConfigRequest;
    assert.equal(app.host._mapConfigReady, false); assert.deepEqual(app.starts, []); assert.ok(app.host.data.renderError);
    app.host.retryAR(); await flush(); app.respond(config, 1); await app.host._mapConfigRequest;
    assert.deepEqual(app.starts, ["osd"], "configuration failure can be retried");
    app.component.lifetimes.detached.call(app.host);
  }
  for (const result of [{ statusCode: 503, data: {} }, { statusCode: 200, data: [] },
    { statusCode: 200, data: [{ id: "map-a", organization_id: "other-team", config }] }]) {
    const app = launch(); await flush(); app.requests[0].resolve(result); await app.host._mapConfigRequest;
    assert.deepEqual(app.starts, []); assert.equal(app.host._mapConfigReady, false);
    assert.equal(app.host.data.canRetry, true); app.component.lifetimes.detached.call(app.host);
  }
  for (const invalidate of [app => { app.CONFIG.workspaceId = "map-b"; },
    app => app.component.pageLifetimes.hide.call(app.host), app => app.component.lifetimes.detached.call(app.host)]) {
    const app = launch(); await flush(); const pending = app.host._mapConfigRequest;
    invalidate(app); app.respond(); await pending;
    assert.deepEqual(app.starts, []); assert.equal(app.host._mapConfigReady, false, "late configuration must not revive old scope");
  }
  const team = launch(); team.CONFIG.workspaceId = undefined; await team.host._mapConfigRequest;
  assert.equal(team.requests.length, 0, "scope changed before dispatch");
  await team.host.loadMapConfig();
  assert.deepEqual(team.starts, []); assert.equal(team.host.data.canRetry, false);
  const scene = launch("scene-a"); await flush(); scene.host.startAR();
  assert.equal(scene.requests.length, 0); assert.deepEqual(scene.starts, ["slam"], "standalone Scene remains independent");
  scene.component.lifetimes.detached.call(scene.host);
  const wxml = fs.readFileSync(path.join(root, "pages/ar/ar.wxml"), "utf8");
  assert.doesNotMatch(wxml, /onRetrievalModeChange|retrieval-switch/);
  assert.match(wxml, /onRescan/);
  console.log("PASS map config: server-selected startup, errors/retry, hide/show refresh, stale responses, team scope and Scene isolation");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
