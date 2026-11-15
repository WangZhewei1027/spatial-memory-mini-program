const assert = require("node:assert/strict");
const fs = require("node:fs");
const { isIP } = require("node:net");
const path = require("node:path");
const vm = require("node:vm");
const { buildSync } = require("esbuild");

// Exercise the real backend entry point: all data APIs and recognition must agree.
const code = buildSync({
  entryPoints: [path.join(__dirname, "../miniprogram/utils/backend.ts")],
  bundle: true,
  platform: "neutral",
  format: "cjs",
  write: false,
  external: ["./backend-development-local"],
}).outputFiles[0].text;

const testLanUrl = "http://192.168.20.5:3000";

function loadBackend(envVersion, failRequests = false, platform, developmentUrl = testLanUrl) {
  const calls = [];
  const diagnostics = [];
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module,
    exports: module.exports,
    console: { ...console, error: (...args) => diagnostics.push(args) },
    require(name) {
      assert.ok(name.endsWith("backend-development-local"));
      return { apiBaseUrl: developmentUrl };
    },
    wx: {
      getAccountInfoSync: () => ({ miniProgram: { envVersion } }),
      getDeviceInfo: () => ({ platform }),
      getStorageSync: () => undefined,
      request(options) {
        calls.push(options);
        if (typeof failRequests === "function") failRequests(options);
        else if (failRequests) options.fail(new Error("local backend unavailable"));
        else options.success({ statusCode: 200, data: [] });
      },
    },
  });
  return { backend: module.exports, calls, diagnostics };
}

async function main() {
  // Use the real scene entry and backend; stand in only for WeChat transport/GPU.
  // A public IP can work in curl or debug mode but is not a legal server domain.
  for (const env of ["trial", "release"]) {
    const manifest = { assetId: "scene" };
    const { backend } = loadBackend(env, (options) => {
      const url = new URL(options.url);
      if (url.protocol !== "https:" || isIP(url.hostname)) {
        options.fail({ errMsg: "request:fail url not in domain list" });
      } else options.success({ statusCode: 200, data: manifest });
    }, "ios", "");
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../miniprogram/components/xr-start/scene-preview.js"), "utf8"), {
      module,
      require(name) { assert.equal(name, "../../utils/backend"); return backend; },
    });
    const events = [];
    const host = {
      ...module.exports,
      data: { sceneId: "scene", sceneOrganizationId: "org" },
      _allowedAssetIds: new Set(),
      _isAssetPlacementCurrent: () => true,
      async _loadScenePlayer(asset, data) { assert.equal(data, manifest); return {}; },
      triggerEvent(name, event) { events.push(event); },
    };
    await host._beginScenePreview();
    assert.equal(events.at(-1).state, "tracking", `${env}: ${events.at(-1).message}`);
    console.log(`PASS ${env}: scene preview reaches tracking with public-IP requests rejected`);
  }

  for (const [env, base, platform] of [
    ["develop", testLanUrl],
    ["develop", testLanUrl, "ios"],
    ["develop", testLanUrl, "android"],
    ["develop", "http://127.0.0.1:3000", "devtools"],
    ["trial", "https://www.spatialmemory.online"],
    ["release", "https://www.spatialmemory.online"],
    ["trial", "https://www.spatialmemory.online", "devtools"],
    ["release", "https://www.spatialmemory.online", "devtools"],
  ]) {
    const { backend, calls } = loadBackend(env, false, platform);
    await backend.fetchOrganizations(["org"]);
    await backend.fetchWorkspaces(["workspace"]);
    await backend.fetchScenePreview("scene", "org");
    for (const name of ["get_nearby_assets", "get_scene_asset", "get_huge_assets"]) {
      await backend.backendRpc(name, { p_workspace_id: "workspace" });
    }
    await backend.fetchActivities("workspace", "org");
    await backend.fetchActivityRecords("placement", { latitude: 31, longitude: 121 }, 50);
    await backend.fetchActivityProgress("placement", "participant");
    await backend.submitActivityRecord({ placement_id: "placement" });
    await backend.fetchAnchorCandidates({ workspace_id: "workspace" });
    await backend.fetchAnchorContent({ workspace_id: "workspace", anchor_id: "target" });
    assert.match(calls.at(-1).header["X-Client-Id"], /^[A-Za-z0-9_-]{16,64}$/);
    assert.equal(calls.at(-1).header["X-Client-Id"], calls.at(-2).header["X-Client-Id"]);
    assert.deepEqual(calls.map((call) => call.url), [
      `${base}/api/miniapp/organizations?ids=org`,
      `${base}/api/miniapp/workspaces?ids=workspace`,
      `${base}/api/miniapp/scenes/preview`,
      `${base}/api/miniapp/assets/nearby`,
      `${base}/api/miniapp/assets/scene`,
      `${base}/api/miniapp/assets/huge`,
      `${base}/api/miniapp/activities?workspace_id=workspace&organization_id=org`,
      `${base}/api/miniapp/activity-records?placement_id=placement&user_lat=31&user_lng=121&max_distance_meters=50`,
      `${base}/api/miniapp/activity-progress?placement_id=placement&participant_id=participant`,
      `${base}/api/miniapp/activity-records`,
      `${base}/api/miniapp/anchors/candidates`,
      `${base}/api/miniapp/anchors/content`,
    ]);
    console.log(`PASS ${env}: all data APIs and recognition use ${base}`);
  }

  const { backend, calls } = loadBackend("develop", true);
  await assert.rejects(backend.submitActivityRecord({ placement_id: "placement" }), /unavailable/);
  assert.equal(calls.length, 2, "failed local writes must not retry against production");
  assert.equal(calls[0].url, `${testLanUrl}/api/miniapp/activity-records`);
  // The only follow-up is a best-effort error report to the same local backend.
  assert.equal(calls[1].url, `${testLanUrl}/api/errors`);
  assert.equal(calls[1].method, "POST");
  assert.equal(calls[1].data.method, "miniprogram:backend.request");
  assert.match(calls[1].data.message, /unavailable/);
  assert.equal(calls[1].data.context.endpoint, `${testLanUrl}/api/miniapp/activity-records`);
  console.log("PASS failed requests are reported once to the same backend's /api/errors");
  for (const errMsg of ["request:fail url not in domain list", "request:fail ssl hand shake error", "request:fail timeout"]) {
    const { backend, diagnostics } = loadBackend("trial", (options) => options.fail({ errMsg }), "ios");
    for (const request of [
      () => backend.fetchOrganizations(["org"]),
      () => backend.fetchScenes(["scene"], "org"),
      () => backend.fetchScenePreview("scene", "org"),
    ]) {
      await assert.rejects(request(), (error) => error.message === errMsg,
        "native wx.request errors must have the message consumed by scene UI");
    }
    assert.equal(diagnostics.length, 3, "name request failures remain diagnosable even when the caller catches them");
    assert.ok(diagnostics.every(([, detail]) => detail.message === errMsg && !detail.endpoint.includes("?")));
  }
  console.log("PASS native domain, TLS and timeout failures retain their cause for scene and name requests");
  assert.throws(() => loadBackend("develop", false, "ios", ""), /未检测到电脑局域网地址/);
  for (const [env, platform, lan, base] of [
    ["develop", "devtools", "", "http://127.0.0.1:3000"],
    ["trial", "ios", "", "https://www.spatialmemory.online"],
    ["release", "ios", "", "https://www.spatialmemory.online"],
    ["develop", "ios", "http://10.20.30.40:3000", "http://10.20.30.40:3000"],
  ]) {
    const { backend, calls } = loadBackend(env, false, platform, lan);
    await backend.fetchAnchorCandidates({});
    assert.equal(calls[0].url, `${base}/api/miniapp/anchors/candidates`);
  }
  for (const env of [undefined, "", "unknown"]) {
    assert.throws(() => loadBackend(env), /无法确定小程序环境/);
  }
  console.log("PASS local failures and unknown environments never fall back to production");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
