(() => {
  const APS_URL = "data/aps-lidding-requirement.json";
  const INVENTORY_URL = "data/lidding-inventory.json";
  const STATUS_URL = "data/collection-status.json";
  let lastCollectionAt = "";

  function formatTime(value) {
    const source = String(value || "").trim();
    if (!source) return "확인 필요";
    const parsed = new Date(source.replace(" ", "T"));
    if (Number.isNaN(parsed.getTime())) return source;
    const pad = (number) => String(number).padStart(2, "0");
    return `${pad(parsed.getMonth() + 1)}. ${pad(parsed.getDate())}. ${pad(parsed.getHours())}:${pad(parsed.getMinutes())}:${pad(parsed.getSeconds())}`;
  }

  function mount() {
    const main = document.querySelector("main");
    if (!main) return null;
    let bar = main.querySelector(".lfp-global-statusbar");
    if (bar) return bar;
    bar = document.createElement("header");
    bar.className = "lfp-global-statusbar";
    bar.setAttribute("aria-label", "데이터 수집 시각");
    bar.innerHTML = `
      <span>APS 아웃바운드 시각 <strong data-lfp-global-time="aps">확인 중</strong></span>
      <i aria-hidden="true">|</i>
      <span>재고 수집시간 <strong data-lfp-global-time="inventory">확인 중</strong></span>`;
    main.prepend(bar);
    return bar;
  }

  function hideLegacyTimes() {
    const target = document.querySelector('#detail [data-lfp-time="aps"]');
    const host = target?.closest("span")?.parentElement;
    if (host) host.classList.add("lfp-legacy-time-hidden");
  }

  async function refreshTimes(force = false) {
    const bar = mount();
    if (!bar) return;
    const apsTarget = bar.querySelector('[data-lfp-global-time="aps"]');
    const inventoryTarget = bar.querySelector('[data-lfp-global-time="inventory"]');
    try {
      const [aps, inventory] = await Promise.all([
        window.LFPResources.json(APS_URL, { force }),
        window.LFPResources.json(INVENTORY_URL, { force }),
      ]);
      const apsTime = aps.sourceRefreshedAt || aps.generatedAt;
      const inventoryTime = inventory.generatedAt || inventory.sourceRefreshedAt;
      apsTarget.textContent = formatTime(apsTime);
      inventoryTarget.textContent = formatTime(inventoryTime);
      apsTarget.title = String(apsTime || "");
      inventoryTarget.title = String(inventoryTime || "");
    } catch (_) {
      apsTarget.textContent = "확인 필요";
      inventoryTarget.textContent = "확인 필요";
    }
    hideLegacyTimes();
  }

  async function checkForUpdates() {
    try {
      const status = await window.LFPResources.json(STATUS_URL, { force: true });
      const collectedAt = String(status.lastCollection?.at || "");
      if (!lastCollectionAt) {
        lastCollectionAt = collectedAt;
        return;
      }
      if (!collectedAt || collectedAt === lastCollectionAt) return;
      lastCollectionAt = collectedAt;
      await refreshTimes(true);
      document.dispatchEvent(new CustomEvent("lfp:data-updated", { detail: { collectedAt } }));
    } catch (_) {
      // Keep the last good screen when the lightweight status check is temporarily unavailable.
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    mount();
    refreshTimes();
    checkForUpdates();
    const detail = document.getElementById("detail");
    if (detail) new MutationObserver(hideLegacyTimes).observe(detail, { childList: true, subtree: true });
    window.setInterval(() => {
      if (!document.hidden) checkForUpdates();
    }, 60000);
  });
})();

(function syncSidebarNavigation() {
  "use strict";

  function activate(tabName) {
    if (!tabName) return;

    document.querySelectorAll("[data-tab]").forEach((button) => {
      const selected = button.dataset.tab === tabName;
      button.classList.toggle("active", selected);
      button.setAttribute("aria-selected", String(selected));
      if (selected) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    });

    document.querySelectorAll(".page[id]").forEach((page) => {
      const selected = page.id === tabName;
      page.hidden = !selected;
      page.classList.toggle("active", selected);
      if (selected) page.scrollTop = 0;
    });
  }

  document.addEventListener("click", (event) => {
    const button = event.target.closest("[data-tab]");
    if (button) activate(button.dataset.tab);
  });

  const initial = document.querySelector("[data-tab].active")?.dataset.tab
    || document.querySelector(".page.active:not([hidden])")?.id;
  activate(initial);
})();
