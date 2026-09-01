import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("./collection-client.js", import.meta.url), "utf8");

function createHarness() {
  const requests = [];
  const progress = [];
  const storage = new Map();
  const statuses = [
    { lastManualCollection: { at: "2026-09-01T08:53:35+09:00", scope: "all", status: "success" } },
    { lastManualCollection: { at: "2026-09-01T09:30:00+09:00", scope: "inventory", status: "success" } },
  ];
  let statusIndex = 0;
  const window = {
    LFPResources: {
      json: async () => statuses[Math.min(statusIndex++, statuses.length - 1)],
    },
    prompt: () => "secret",
    setTimeout: (callback) => {
      callback();
      return 1;
    },
  };
  const context = vm.createContext({
    console,
    Error,
    fetch: async (url, init) => {
      requests.push({ url, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({
        ok: true,
        accepted: true,
        scope: "inventory",
        requestedAt: "2026-09-01T00:29:00Z",
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
    Promise,
    Response,
    sessionStorage: {
      getItem: (key) => storage.get(key) || null,
      removeItem: (key) => storage.delete(key),
      setItem: (key, value) => storage.set(key, value),
    },
    Set,
    window,
  });
  vm.runInContext(source, context);
  return { client: window.LFPCollectionClient, progress, requests };
}

test("inventory button client dispatches Cloudflare and waits for GitHub Pages status", async () => {
  const { client, progress, requests } = createHarness();
  const result = await client.collect("inventory", {
    onProgress: (message) => progress.push(message),
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://lfp-schedule-relay.hwh2404.workers.dev/collect");
  assert.deepEqual(requests[0].body, { scope: "inventory", password: "secret" });
  assert.deepEqual(progress, ["ERP 수집 실행 중"]);
  assert.equal(result.collection.scope, "inventory");
  assert.equal(result.collection.status, "success");
});

test("deployed collection client has no DMZ or local API dependency", () => {
  assert.doesNotMatch(source, /DMZ|localhost|127\.0\.0\.1|api\/refresh|api\/monitor-status/i);
});
