(function () {
  "use strict";

  const TAB_LABELS = ["대시보드 현황", "리드지별 상세내역", "BOM 구성 현황"];
  let sidebarMounted = false;
  let observerScheduled = false;

  function normalizedText(element) {
    return (element && element.textContent ? element.textContent : "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function findTab(label) {
    return Array.from(document.querySelectorAll("button, a, [role='tab']")).find(
      (element) => normalizedText(element) === label
    );
  }

  function mountSidebar() {
    if (sidebarMounted) return true;

    const tabs = TAB_LABELS.map(findTab);
    if (tabs.some((tab) => !tab)) return false;

    const originalParent = tabs.every((tab) => tab.parentElement === tabs[0].parentElement)
      ? tabs[0].parentElement
      : null;

    const sidebar = document.createElement("aside");
    sidebar.className = "ct-sidebar";
    sidebar.setAttribute("aria-label", "Lidding Foil Planner 업무 메뉴");
    sidebar.innerHTML = [
      '<div class="ct-side-brand">',
      '  <div class="ct-side-brand-copy">',
      '    <span class="ct-brand-kicker">MATERIAL CONTROL</span>',
      '    <strong>리드지 수급관리<br>대시보드</strong>',
      '    <small>Lidding Foil Planner</small>',
      '  </div>',
      '</div>',
      '<div class="ct-side-label">WORKSPACE / 01</div>',
      '<nav class="ct-side-nav" aria-label="주요 화면"></nav>',
      '<div class="ct-side-footer">',
      '  <div class="ct-side-footer-label">데이터 수집상태 : 양호</div>',
      '  <strong>생산기획팀</strong>',
      '</div>'
    ].join("");

    const nav = sidebar.querySelector(".ct-side-nav");
    tabs.forEach((tab, index) => {
      tab.classList.add("ct-nav-item");
      tab.dataset.ctIndex = String(index + 1).padStart(2, "0");
      nav.appendChild(tab);
    });

    if (originalParent && originalParent !== document.body) {
      originalParent.classList.add("ct-tab-origin");
    }

    document.body.prepend(sidebar);
    sidebarMounted = true;
    return true;
  }

  function decorateHeader() {
    const brandText = Array.from(document.querySelectorAll("h1, h2, strong, div")).find((element) =>
      !element.closest(".ct-sidebar") && (
        normalizedText(element).includes("Lidding Foil Planner")
        || normalizedText(element).includes("리드지 수급관리")
      )
    );
    const header = brandText && (brandText.closest("header") || brandText.parentElement);
    if (header && !header.classList.contains("ct-sidebar")) {
      header.classList.add("ct-top-command");
    }

    const main = document.querySelector("main");
    if (main) main.classList.add("ct-main-workspace");
  }

  function findCompactHost(element, requiredText) {
    let host = element;
    for (let depth = 0; host && depth < 4; depth += 1, host = host.parentElement) {
      const text = normalizedText(host);
      if (text.includes(requiredText) && text.length < 500) return host;
    }
    return element ? element.parentElement : null;
  }

  function decorateCommands() {
    const apsLabels = ["전체", "해외", "PB", "국내", "안전"];
    const apsButtons = Array.from(document.querySelectorAll("button")).filter((button) =>
      apsLabels.includes(normalizedText(button))
    );
    const scenarioButton = apsButtons[0];
    const scenarioHost = findCompactHost(scenarioButton, "해외");
    if (scenarioHost && !scenarioHost.closest(".ct-sidebar")) {
      scenarioHost.classList.add("ct-scenario-strip", "ct-enter");
      Array.from(scenarioHost.querySelectorAll("*")).forEach((element) => {
        if (normalizedText(element) === "APS 하이드레이션") {
          element.classList.add("ct-scenario-name");
        }
      });
      scenarioHost.setAttribute("role", "group");
      scenarioHost.setAttribute("aria-label", "APS 하이드레이션 분류 복수 선택");

      const isNativeSelected = (button) =>
        button.classList.contains("active") ||
        button.classList.contains("is-active") ||
        button.classList.contains("selected") ||
        button.getAttribute("aria-pressed") === "true";
      const categoryButtons = apsButtons.filter((button) => normalizedText(button) !== "전체");
      const allButton = apsButtons.find((button) => normalizedText(button) === "전체");
      const allCategoriesSelected =
        Boolean(allButton && isNativeSelected(allButton)) ||
        (categoryButtons.length === 4 && categoryButtons.every(isNativeSelected));

      apsButtons.forEach((button) => {
        const label = normalizedText(button);
        button.dataset.ctAps = label;
        button.dataset.ctSelected = String(
          label === "전체" ? allCategoriesSelected : allCategoriesSelected || isNativeSelected(button)
        );
        button.title = label === "전체"
          ? "해외·PB·국내·안전을 모두 선택"
          : `${label} 항목 복수 선택 또는 해제`;
      });

      if (!scenarioHost.dataset.ctSelectionBound) {
        scenarioHost.dataset.ctSelectionBound = "true";
        scenarioHost.addEventListener("click", (event) => {
          const button = event.target.closest("button[data-ct-aps]");
          if (!button || button.dataset.ctAps === "전체") return;
          window.setTimeout(() => {
            const categorySelection = Array.from(
              scenarioHost.querySelectorAll('button[data-ct-aps]:not([data-ct-aps="전체"])')
            );
            if (categorySelection.length === 4 && !categorySelection.some(isNativeSelected)) {
              const selectAll = scenarioHost.querySelector('button[data-ct-aps="전체"]');
              if (selectAll) selectAll.click();
            }
          }, 0);
        });
      }

      let commandShell = scenarioHost.parentElement;
      for (let depth = 0; commandShell && depth < 4; depth += 1, commandShell = commandShell.parentElement) {
        if (normalizedText(commandShell).includes("재고 기준")) {
          commandShell.classList.add("ct-page-command-shell");
          Array.from(commandShell.querySelectorAll("*")).forEach((element) => {
            const value = normalizedText(element);
            if (value.startsWith("재고 기준") && value.length < 30) {
              element.classList.add("ct-stock-date");
            }
          });
          if (!commandShell.querySelector(".ct-page-title")) {
            const pageTitle = document.createElement("div");
            pageTitle.className = "ct-page-title";
            pageTitle.innerHTML = "<strong>리드지별 상세내역</strong><span>재고부터 APS 생산필요까지 한눈에 확인</span>";
            commandShell.prepend(pageTitle);
          }
          break;
        }
      }
    }

    const searchInput = Array.from(document.querySelectorAll("input")).find((input) =>
      /품목코드|품목명|규격|통합/.test(input.placeholder || "")
    );
    let filterHost = searchInput;
    for (let depth = 0; filterHost && depth < 5; depth += 1, filterHost = filterHost.parentElement) {
      const text = normalizedText(filterHost);
      if (text.includes("창고") && (text.includes("조회") || filterHost.querySelector("select"))) {
        filterHost.classList.add("ct-filter-command", "ct-enter");
        break;
      }
    }
  }

  function decorateTable(table) {
    table.classList.add("ct-data-table");
    const heading = normalizedText(table.querySelector("thead"));
    if (heading.includes("P코드") && heading.includes("BS 리드지")) {
      table.classList.add("ct-bom-table");
    }
    if (heading.includes("재고") && (heading.includes("APS 생산필요") || heading.includes("사용량 환산"))) {
      table.classList.add("ct-inventory-table");
    }

    table.querySelectorAll("tbody tr").forEach((row) => {
      const text = normalizedText(row);
      if (text.includes("구매이력 확인 필요")) row.dataset.ctStatus = "risk";
      else if (text.includes("검사완료 대기")) row.dataset.ctStatus = "wait";
      else if (text.includes("재고 충족")) row.dataset.ctStatus = "ok";
      else delete row.dataset.ctStatus;
    });
  }

  function decorate() {
    document.body.classList.add("ct-control-tower");
    mountSidebar();
    decorateHeader();
    decorateCommands();
    document.querySelectorAll("table").forEach(decorateTable);
    document.documentElement.classList.remove("ct-booting");
    document.documentElement.classList.add("ct-ready");
  }

  function scheduleDecorate() {
    if (observerScheduled) return;
    observerScheduled = true;
    window.requestAnimationFrame(() => {
      observerScheduled = false;
      decorate();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", decorate, { once: true });
  } else {
    decorate();
  }

  const observer = new MutationObserver(scheduleDecorate);
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
