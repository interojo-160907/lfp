(() => {
  "use strict";

  const jsonCache = new Map();
  const scriptCache = new Map();
  const DEFAULT_MAX_AGE_MS = 45_000;

  function json(url, options = {}) {
    const { force = false, maxAgeMs = DEFAULT_MAX_AGE_MS } = options;
    const now = Date.now();
    const current = jsonCache.get(url);
    if (current?.promise) return current.promise;
    if (!force && current && now - current.loadedAt < maxAgeMs) {
      return Promise.resolve(current.value);
    }

    const request = fetch(url, { cache: "no-store" })
      .then((response) => {
        if (!response.ok) throw new Error(`${url} 로드 실패: HTTP ${response.status}`);
        return response.json();
      })
      .then((value) => {
        jsonCache.set(url, { value, loadedAt: Date.now(), promise: null });
        return value;
      })
      .catch((error) => {
        if (current?.value !== undefined) {
          jsonCache.set(url, current);
          return current.value;
        }
        if (jsonCache.get(url)?.promise === request) jsonCache.delete(url);
        throw error;
      });

    jsonCache.set(url, {
      value: current?.value,
      loadedAt: current?.loadedAt || 0,
      promise: request,
    });
    return request;
  }

  function script(url, globalName) {
    if (globalName && window[globalName]) return Promise.resolve(window[globalName]);
    if (scriptCache.has(url)) return scriptCache.get(url);

    const request = new Promise((resolve, reject) => {
      const existing = document.querySelector(`script[data-lfp-resource="${globalName || url}"]`);
      const element = existing || document.createElement("script");
      const complete = () => {
        if (globalName && !window[globalName]) {
          reject(new Error(`${globalName} 모듈을 초기화하지 못했습니다.`));
          return;
        }
        resolve(globalName ? window[globalName] : true);
      };
      element.addEventListener("load", complete, { once: true });
      element.addEventListener("error", () => {
        element.remove();
        reject(new Error(`${url} 모듈을 불러오지 못했습니다.`));
      }, { once: true });
      if (!existing) {
        element.src = url;
        element.async = true;
        element.dataset.lfpResource = globalName || url;
        document.head.appendChild(element);
      }
    }).catch((error) => {
      scriptCache.delete(url);
      throw error;
    });

    scriptCache.set(url, request);
    return request;
  }

  function invalidate(url) {
    jsonCache.delete(url);
  }

  window.LFPResources = Object.freeze({ json, script, invalidate });
})();
