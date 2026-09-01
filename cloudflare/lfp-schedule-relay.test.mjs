import assert from "node:assert/strict";
import test from "node:test";

import { __test } from "./lfp-schedule-relay.js";

const originalFetch = global.fetch;

function repositoryDocument(payload, sha = "abc123") {
  return new Response(JSON.stringify({
    sha,
    content: Buffer.from(JSON.stringify(payload), "utf8").toString("base64"),
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

function mockFetch({ automation, apsVersion = "v1", apsStatus = 200, dispatchState = {} }) {
  const calls = [];
  global.fetch = async (input, init = {}) => {
    const url = String(input);
    const method = init.method || "GET";
    calls.push({ url, method, body: init.body ? JSON.parse(init.body) : null });

    if (url.includes("web/data/automation-state.json")) return repositoryDocument(automation);
    if (url.includes("/api/aps-plan")) {
      return new Response(JSON.stringify({ source_refreshed_at: apsVersion }), {
        status: apsStatus,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes(".github/lfp-dispatch-state.json") && method === "GET") {
      return repositoryDocument({
        version: 1,
        lastAutoDispatchAt: "",
        lastAutoSignature: "",
        lastProductionDate: "",
        lastProductionDispatchAt: "",
        ...dispatchState,
      });
    }
    if (url.includes(".github/lfp-dispatch-state.json") && method === "PUT") {
      return new Response(JSON.stringify({ commit: { sha: "lock123" } }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.endsWith("/dispatches") && method === "POST") return new Response(null, { status: 204 });
    throw new Error(`Unexpected request: ${method} ${url}`);
  };
  return calls;
}

test.afterEach(() => {
  global.fetch = originalFetch;
});

test("unchanged APS before 16 hours does not dispatch", async () => {
  const now = new Date("2026-09-01T00:00:00Z");
  const calls = mockFetch({
    automation: {
      lastHandledApsVersion: "v1",
      lastRegularCollectionAt: "2026-09-01T08:30:00+09:00",
    },
  });
  const result = await __test.runAutomaticMonitor({ GITHUB_TOKEN: "test" }, now);
  assert.equal(result.dispatched, false);
  assert.equal(result.reason, "aps_unchanged");
  assert.equal(calls.some((call) => call.url.endsWith("/dispatches")), false);
});

test("changed APS acquires a lock and dispatches automatic collection", async () => {
  const calls = mockFetch({
    automation: {
      lastHandledApsVersion: "v1",
      lastRegularCollectionAt: "2026-09-01T08:30:00+09:00",
    },
    apsVersion: "v2",
  });
  const result = await __test.runAutomaticMonitor(
    { GITHUB_TOKEN: "test" },
    new Date("2026-09-01T00:00:00Z"),
  );
  assert.equal(result.dispatched, true);
  assert.equal(result.reason, "aps_changed");
  const dispatch = calls.find((call) => call.url.endsWith("/dispatches"));
  assert.equal(dispatch.body.event_type, "lfp-auto-collect");
  assert.equal(dispatch.body.client_payload.observedVersion, "v2");
});

test("failed APS check after 16 hours still dispatches fallback collection", async () => {
  const calls = mockFetch({
    automation: {
      lastHandledApsVersion: "v1",
      lastRegularCollectionAt: "2026-08-31T16:00:00+09:00",
    },
    apsStatus: 503,
  });
  const result = await __test.runAutomaticMonitor(
    { GITHUB_TOKEN: "test" },
    new Date("2026-09-01T00:30:00Z"),
  );
  assert.equal(result.dispatched, true);
  assert.equal(result.reason, "regular_16h_aps_check_failed");
  const dispatch = calls.find((call) => call.url.endsWith("/dispatches"));
  assert.equal(dispatch.body.event_type, "lfp-auto-collect");
});

test("08:00 production dispatch runs once per Korea date", async () => {
  const now = new Date("2026-08-31T23:00:00Z");
  const firstCalls = mockFetch({ automation: {}, dispatchState: {} });
  const first = await __test.runProductionSchedule({ GITHUB_TOKEN: "test" }, now);
  assert.equal(first.dispatched, true);
  assert.equal(first.date, "2026-09-01");
  assert.equal(firstCalls.find((call) => call.url.endsWith("/dispatches")).body.event_type, "lfp-production-collect");

  const duplicateCalls = mockFetch({
    automation: {},
    dispatchState: { lastProductionDate: "2026-09-01" },
  });
  const duplicate = await __test.runProductionSchedule({ GITHUB_TOKEN: "test" }, now);
  assert.equal(duplicate.dispatched, false);
  assert.equal(duplicateCalls.some((call) => call.url.endsWith("/dispatches")), false);
});
