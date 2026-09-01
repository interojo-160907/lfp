(() => {
  "use strict";

  const RELAY_URL = "https://lfp-schedule-relay.hwh2404.workers.dev";
  const STATUS_URL = "data/collection-status.json";
  const PASSWORD_KEY = "lfp-schedule-password";
  const VALID_SCOPES = new Set(["all", "aps", "inventory", "purchase", "bom", "production"]);
  const POLL_INTERVAL_MS = 4_000;
  const MAX_POLL_ATTEMPTS = 90;

  const delay = (milliseconds) => new Promise((resolve) => window.setTimeout(resolve, milliseconds));

  function collectionPassword(forcePrompt = false) {
    if (!forcePrompt) {
      const stored = sessionStorage.getItem(PASSWORD_KEY);
      if (stored) return stored;
    }
    const entered = window.prompt("ERP 수동수집 비밀번호를 입력하세요.");
    if (!entered) throw new Error("수동수집이 취소되었습니다.");
    sessionStorage.setItem(PASSWORD_KEY, entered);
    return entered;
  }

  async function readStatus() {
    return window.LFPResources.json(STATUS_URL, { force: true, maxAgeMs: 0 });
  }

  async function dispatch(scope, retry = true) {
    const password = collectionPassword(!retry);
    const response = await fetch(`${RELAY_URL}/collect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope, password }),
    });
    const result = await response.json().catch(() => ({}));
    if (response.status === 401 && retry) {
      sessionStorage.removeItem(PASSWORD_KEY);
      return dispatch(scope, false);
    }
    if (!response.ok || !result.ok) {
      throw new Error(result.detail || result.error || "ERP 수동수집을 요청하지 못했습니다.");
    }
    return result;
  }

  async function collect(scope, options = {}) {
    const normalizedScope = String(scope || "").trim().toLowerCase();
    if (!VALID_SCOPES.has(normalizedScope)) throw new Error("지원하지 않는 수집 범위입니다.");
    const before = await readStatus().catch(() => ({}));
    const baseline = String(before.lastManualCollection?.at || "");
    const accepted = await dispatch(normalizedScope);
    options.onProgress?.("ERP 수집 실행 중");

    for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt += 1) {
      await delay(POLL_INTERVAL_MS);
      const status = await readStatus().catch(() => null);
      const completed = status?.lastManualCollection;
      if (!completed || completed.status !== "success") continue;
      if (completed.scope !== normalizedScope || !completed.at || completed.at === baseline) continue;
      return { accepted, collection: completed, status };
    }
    throw new Error("ERP 수집은 요청됐지만 화면 갱신 확인 시간이 초과되었습니다. 잠시 후 새로고침해 주세요.");
  }

  window.LFPCollectionClient = Object.freeze({ collect, readStatus });
})();
