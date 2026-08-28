(function () {
  "use strict";

  const SNAPSHOT_URL = "data/dashboard-snapshot.json";
  const DELIVERY_URL = "api/delivery-management";
  const state = {
    purchaseMap: new Map(),
    apsMap: new Map(),
    deliveryMap: new Map(),
    inventoryRows: [],
    apsCategories: new Set(["해외", "PB", "국내"]),
    riskFilter: "managed",
    snapshotAt: "",
    scheduled: false,
    observedTable: null,
  };

  function text(element) {
    return (element?.textContent || "").replace(/\s+/g, " ").trim();
  }

  function number(value) {
    const parsed = Number(String(value || "").replace(/[^0-9.-]/g, ""));
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function formatNumber(value) {
    return Math.round(Number(value || 0)).toLocaleString("ko-KR");
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function key(itemCode, specification) {
    return `${String(itemCode || "").trim().toUpperCase()}|${String(specification || "").trim().toUpperCase()}`;
  }

  function parseDate(value) {
    const source = String(value || "").trim();
    let matched = source.match(/(\d{4})[-./](\d{1,2})[-./](\d{1,2})/);
    if (matched) {
      return new Date(Number(matched[1]), Number(matched[2]) - 1, Number(matched[3]));
    }
    matched = source.match(/(?:^|\s)(\d{1,2})\/(\d{1,2})(?:\s|$)/);
    if (matched) {
      return new Date(new Date().getFullYear(), Number(matched[1]) - 1, Number(matched[2]));
    }
    return null;
  }

  function formatShortDate(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "미정";
    return `${date.getMonth() + 1}/${date.getDate()}`;
  }

  function startOfToday() {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate());
  }

  function daysFromToday(date) {
    if (!date) return null;
    return Math.ceil((date.getTime() - startOfToday().getTime()) / 86400000);
  }

  function dueLabel(days) {
    if (days === null) return "납기 미정";
    if (days < 0) return `${Math.abs(days)}일 지연`;
    if (days === 0) return "오늘 납기";
    return `D-${days}`;
  }

  function findDetailTable() {
    return Array.from(document.querySelectorAll("table")).find((table) => {
      const rows = Array.from(table.querySelectorAll("thead tr"));
      return rows.some((row) => {
        const labels = Array.from(row.cells || []).map(text);
        return labels.includes("품목코드") && labels.includes("APS 생산필요") && labels.includes("비고");
      });
    });
  }

  function getTableState() {
    const rowsByKey = new Map(state.inventoryRows.map((inventory) => [
      key(inventory.itemCode, inventory.specification),
      inventory,
    ]));
    state.apsMap.forEach((aps, itemKey) => {
      if (rowsByKey.has(itemKey)) return;
      rowsByKey.set(itemKey, {
        itemCode: aps.liddingCode,
        itemName: aps.liddingName || "품명 미연결",
        specification: aps.liddingSpecification,
        stockQty: 0,
        inspectionWaitQty: 0,
      });
    });
    return [...rowsByKey.values()].map((inventory) => {
      const itemCode = String(inventory.itemCode || "").trim();
      const specification = String(inventory.specification || "").trim();
      const aps = state.apsMap.get(key(itemCode, specification));
      const purchase = state.purchaseMap.get(key(itemCode, specification));
      const quantities = aps?.categoryQuantities || {};
      const productionRequired = Array.from(state.apsCategories)
        .reduce((sum, category) => sum + number(quantities[category]), 0);
      const inboundWait = number(purchase?.inboundWaitQty);
      const purchaseWait = number(purchase?.purchaseWaitQty);
      const secured = number(inventory.stockQty) + number(inventory.inspectionWaitQty) + inboundWait + purchaseWait;
      const shortage = Math.max(Math.ceil(productionRequired * 1.5) - secured, 0);
      const recommended = shortage > 0 ? Math.max(20000, Math.ceil(shortage / 5000) * 5000) : 0;
      const requestDate = parseDate(purchase?.nextDeliveryDate);
      const delivery = state.deliveryMap.get(key(itemCode, specification));
      const confirmedDate = parseDate(delivery?.confirmedDate);
      const effectiveDate = confirmedDate || requestDate;
      const requestNumbers = Array.from(new Set(
        (purchase?.requests || []).map((request) => request.requestNo).filter(Boolean)
      ));
      const salesOrders = (aps?.salesOrders || [])
        .filter((order) => state.apsCategories.has(order.demandCategory))
        .sort((left, right) => String(left.dueDate || "9999-12-31").localeCompare(String(right.dueDate || "9999-12-31")));
      return {
        itemCode,
        itemName: inventory.itemName || aps?.liddingName || "",
        specification,
        inboundWait,
        purchaseWait,
        productionRequired,
        requestDate,
        confirmedDate,
        effectiveDate,
        requestNumbers,
        salesOrders,
        recommended,
      };
    });
  }

  function riskRow(item) {
    const days = daysFromToday(item.effectiveDate);
    const severity = riskSeverity(item);
    const tone = days === null ? "is-undated" : days < 0 ? "is-overdue" : days <= 3 ? "is-soon" : "is-normal";
    const dateBasis = item.confirmedDate ? "확정일 기준" : item.requestDate ? "요청일 기준" : "납기 미정";
    const waits = [];
    if (item.inboundWait > 0) waits.push(`<span><b>입고대기</b><strong>${formatNumber(item.inboundWait)}</strong></span>`);
    if (item.purchaseWait > 0) waits.push(`<span><b>발주대기</b><strong>${formatNumber(item.purchaseWait)}</strong></span>`);
    const hoverText = [
      `${item.itemCode} / ${item.specification}`,
      item.itemName,
      item.inboundWait > 0 ? `입고대기 ${formatNumber(item.inboundWait)}` : "",
      item.purchaseWait > 0 ? `발주대기 ${formatNumber(item.purchaseWait)}` : "",
      `${dateBasis}: ${formatShortDate(item.effectiveDate)} (${dueLabel(days)})`,
    ].filter(Boolean).join("\n");

    return `
      <div class="lfp-alert-row ${tone}" title="${escapeHtml(hoverText)}">
        <div class="lfp-alert-item">
          <span class="lfp-risk-level ${severity.className}">${escapeHtml(severity.label)}</span>
          <strong>${escapeHtml(item.itemCode)} · ${escapeHtml(item.specification)}</strong>
          <span title="${escapeHtml(item.itemName)}">${escapeHtml(item.itemName)}</span>
        </div>
        <div class="lfp-alert-waits">${waits.join("")}</div>
        <div class="lfp-alert-due">
          <strong>${formatShortDate(item.effectiveDate)}</strong>
          <span>${escapeHtml(dateBasis)} · ${escapeHtml(dueLabel(days))}</span>
        </div>
      </div>`;
  }

  function riskSeverity(item) {
    const days = daysFromToday(item.effectiveDate);
    if (days !== null && days < 0) return { key: "emergency", label: "긴급", className: "is-emergency" };
    if (days !== null && days <= 3) return { key: "check", label: "확인 필요", className: "is-check" };
    return { key: "managed", label: "관리대상", className: "is-monitor" };
  }

  function purchaseRow(item) {
    const hoverText = `${item.itemCode} / ${item.specification}\n${item.itemName}\n구매 필요 ${formatNumber(item.recommended)}`;
    return `
      <div class="lfp-order-row" title="${escapeHtml(hoverText)}">
        <div class="lfp-order-item">
          <strong>${escapeHtml(item.itemCode)} · ${escapeHtml(item.specification)}</strong>
          <span title="${escapeHtml(item.itemName)}">${escapeHtml(item.itemName)}</span>
        </div>
        <div class="lfp-order-quantity">
          <strong>${formatNumber(item.recommended)}</strong>
          <span>구매 필요</span>
        </div>
      </div>`;
  }

  function emptyState(message, detail) {
    return `
      <div class="lfp-dashboard-empty">
        <strong>${escapeHtml(message)}</strong>
        <span>${escapeHtml(detail)}</span>
      </div>`;
  }

  function render() {
    const overview = document.getElementById("overview");
    if (!overview || !document.getElementById("lfp-risk-list")) return;

    const items = getTableState();
    const risks = items
      .filter((item) => item.inboundWait + item.purchaseWait > 0)
      .sort((left, right) => {
        const leftTime = left.effectiveDate?.getTime() ?? Number.MAX_SAFE_INTEGER;
        const rightTime = right.effectiveDate?.getTime() ?? Number.MAX_SAFE_INTEGER;
        if (leftTime !== rightTime) return leftTime - rightTime;
        return (right.inboundWait + right.purchaseWait) - (left.inboundWait + left.purchaseWait);
      });
    const orders = items
      .filter((item) => item.recommended > 0)
      .sort((left, right) => right.recommended - left.recommended || left.itemCode.localeCompare(right.itemCode));
    const visibleRisks = risks.filter((item) => {
      if (state.riskFilter === "emergency") return riskSeverity(item).key === "emergency";
      if (state.riskFilter === "check") return riskSeverity(item).key === "check";
      return true;
    });
    const orderQuantity = orders.reduce((sum, item) => sum + item.recommended, 0);
    const severityCounts = risks.reduce((counts, item) => {
      const keyName = riskSeverity(item).key;
      counts[keyName] = (counts[keyName] || 0) + 1;
      return counts;
    }, {});

    document.getElementById("lfp-risk-count").textContent = `${visibleRisks.length}건`;
    document.getElementById("lfp-order-count").textContent = `${orders.length}건`;
    document.getElementById("lfp-order-quantity").textContent = formatNumber(orderQuantity);
    document.getElementById("lfp-kpi-total").textContent = `${risks.length}건`;
    document.getElementById("lfp-kpi-emergency").textContent = `${severityCounts.emergency || 0}건`;
    document.getElementById("lfp-kpi-check").textContent = `${severityCounts.check || 0}건`;
    document.getElementById("lfp-kpi-order").textContent = `${orders.length}건`;
    document.querySelectorAll("[data-risk-filter]").forEach((button) => {
      const active = button.dataset.riskFilter === state.riskFilter;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    });

    document.getElementById("lfp-risk-list").innerHTML = visibleRisks.length
      ? visibleRisks.map(riskRow).join("")
      : emptyState("해당 관리 품목 없음", "선택한 납기 기준에 해당하는 품목이 없습니다.");
    document.getElementById("lfp-order-list").innerHTML = orders.length
      ? orders.map(purchaseRow).join("")
      : emptyState("구매 필요 없음", "현재 선택 APS 기준 1.5배 목표수량을 충족합니다.");
  }

  function schedule() {
    if (state.scheduled) return;
    state.scheduled = true;
    requestAnimationFrame(() => {
      state.scheduled = false;
      render();
    });
  }

  function detailApsButton(category) {
    return document.querySelector(`.lfp-aps-filter [data-aps-category="${category}"]`);
  }

  function syncApsFilterControls() {
    const selected = [];
    document.querySelectorAll("[data-dashboard-aps]").forEach((input) => {
      const isSelected = state.apsCategories.has(input.dataset.dashboardAps);
      input.checked = isSelected;
      if (isSelected) selected.push(input.dataset.dashboardAps);
    });
    const summary = document.getElementById("lfp-dashboard-aps-summary");
    if (summary) summary.textContent = selected.length ? selected.join(" + ") : "선택 없음";
  }

  function applyDashboardApsFilter(input) {
    const category = input.dataset.dashboardAps;
    if (input.checked) state.apsCategories.add(category);
    else if (state.apsCategories.size > 1) state.apsCategories.delete(category);
    else input.checked = true;
    const button = detailApsButton(input.dataset.dashboardAps);
    const isSelected = button && (button.classList.contains("is-active") || button.dataset.ctSelected === "true");
    if (button && isSelected !== input.checked) button.click();
    syncApsFilterControls();
    schedule();
    setTimeout(() => {
      schedule();
    }, 120);
  }

  function observeTable(table) {
    if (!table || state.observedTable === table) return;
    state.observedTable = table;
    new MutationObserver(schedule).observe(table, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }

  function injectStyles() {
    if (document.getElementById("lfp-dashboard-styles")) return;
    const style = document.createElement("style");
    style.id = "lfp-dashboard-styles";
    style.textContent = `
      .lfp-risk-kpi-strip {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: 10px;
        margin: 0 0 12px;
      }
      .lfp-risk-kpi {
        min-height: 74px;
        padding: 12px 15px;
        display: grid;
        align-content: center;
        gap: 4px;
        background: #fff;
        border: 1px solid #c8d5e5;
        border-top: 4px solid #224f80;
        box-shadow: 0 7px 18px rgba(20, 51, 86, .06);
        color: inherit;
        font: inherit;
        text-align: left;
        cursor: pointer;
      }
      .lfp-risk-kpi span { color: #687d98; font-size: 11px; font-weight: 700; }
      .lfp-risk-kpi strong { color: #0a2a52; font-size: 22px; font-variant-numeric: tabular-nums; }
      .lfp-risk-kpi small { color: #8a9ab0; font-size: 10px; }
      .lfp-risk-kpi.is-emergency { border-top-color: #df3345; background: #fff7f8; }
      .lfp-risk-kpi.is-emergency strong { color: #d52238; }
      .lfp-risk-kpi.is-danger { border-top-color: #f06a2b; background: #fff9f5; }
      .lfp-risk-kpi.is-danger strong { color: #d65318; }
      .lfp-risk-kpi.is-caution { border-top-color: #e3a008; background: #fffbef; }
      .lfp-risk-kpi.is-caution strong { color: #a96e00; }
      .lfp-risk-kpi.is-check { border-top-color: #2585d8; background: #f5faff; }
      .lfp-risk-kpi.is-check strong { color: #1269b4; }
      .lfp-risk-kpi.is-order { border-top-color: #d98210; background: #fffaf3; }
      .lfp-risk-kpi.is-order strong { color: #b65c00; }
      .lfp-risk-kpi.is-active { border-color: #1c78d4; box-shadow: 0 0 0 2px rgba(28, 120, 212, .16), 0 8px 20px rgba(20, 51, 86, .09); }
      .lfp-risk-level {
        width: max-content;
        margin-bottom: 4px;
        padding: 2px 7px;
        color: #31506f;
        background: #eef3f8;
        border: 1px solid #bfd0e1;
        font-size: 10px !important;
        font-weight: 800;
      }
      .lfp-risk-level.is-emergency { color: #cc2036; background: #fff0f2; border-color: #f2a6af; }
      .lfp-risk-level.is-danger { color: #c24b15; background: #fff1e9; border-color: #efb090; }
      .lfp-risk-level.is-caution { color: #916000; background: #fff7d8; border-color: #e6c35f; }
      .lfp-risk-level.is-check { color: #1263aa; background: #edf6ff; border-color: #9bc8ee; }
      .lfp-risk-panel .lfp-list-head,
      .lfp-risk-panel .lfp-alert-row {
        grid-template-columns: minmax(220px, 1.6fr) minmax(150px, .8fr) 120px !important;
      }
      .lfp-alert-waits { display: grid; gap: 5px; }
      .lfp-alert-waits > span { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
      .lfp-alert-waits b { color: #698097; font-size: 9px; }
      .lfp-alert-waits strong { color: #0a315c; font-size: 13px; font-variant-numeric: tabular-nums; }
      #overview.lfp-dashboard-page {
        min-height: 0;
        padding: 0;
        border: 0;
        background: transparent;
      }

      .lfp-dashboard-shell {
        --lfp-navy: #0b2e59;
        --lfp-blue: #1268d7;
        --lfp-cyan: #12adc1;
        --lfp-red: #df3c45;
        --lfp-amber: #d98210;
        --lfp-green: #078565;
        --lfp-border: #cbd9e9;
        --lfp-muted: #667d98;
        color: #0b2445;
        font-family: "Pretendard Variable", Pretendard, "Noto Sans KR", sans-serif;
      }

      .lfp-dashboard-titlebar {
        display: flex;
        align-items: flex-end;
        justify-content: space-between;
        gap: 24px;
        min-height: 86px;
        box-sizing: border-box;
        padding: 14px 20px;
        margin-bottom: 12px;
        border: 1px solid var(--lfp-border);
        background: rgba(255,255,255,.96);
        box-shadow: 0 8px 24px rgba(33, 74, 118, .06);
      }

      .lfp-dashboard-titlebar h2 {
        margin: 0;
        font-size: 24px;
        line-height: 1.25;
        letter-spacing: -.04em;
        color: #071f41;
      }

      .lfp-dashboard-titlebar p {
        margin: 7px 0 0;
        font-size: 12px;
        color: var(--lfp-muted);
      }

      .lfp-dashboard-updated {
        padding: 9px 12px;
        border-left: 3px solid var(--lfp-cyan);
        background: #eef8fb;
        color: #215276;
        font-size: 11px;
        font-weight: 700;
        white-space: nowrap;
      }

      .lfp-dashboard-grid {
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
        gap: 12px;
        align-items: stretch;
      }

      .lfp-command-panel {
        min-width: 0;
        min-height: 610px;
        border: 1px solid var(--lfp-border);
        background: #fff;
        box-shadow: 0 10px 28px rgba(30, 71, 116, .07);
        overflow: hidden;
      }

      .lfp-risk-panel { box-shadow: inset 0 4px 0 var(--lfp-red), 0 10px 28px rgba(30, 71, 116, .07); }
      .lfp-order-panel { box-shadow: inset 0 4px 0 var(--lfp-amber), 0 10px 28px rgba(30, 71, 116, .07); }

      .lfp-panel-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        padding: 22px 22px 18px;
        border-bottom: 1px solid #dce6f1;
      }

      .lfp-panel-title h3 {
        margin: 0;
        font-size: 19px;
        letter-spacing: -.035em;
        color: #0a2346;
      }

      .lfp-panel-title p {
        margin: 6px 0 0;
        font-size: 11px;
        line-height: 1.5;
        color: var(--lfp-muted);
      }

      .lfp-panel-count {
        min-width: 64px;
        padding: 9px 13px;
        border: 1px solid #d1deec;
        background: #f5f8fc;
        color: var(--lfp-navy);
        font-size: 16px;
        font-weight: 800;
        text-align: center;
      }

      .lfp-order-head-tools {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        flex: 0 0 auto;
        min-width: 0;
        gap: 8px;
        white-space: nowrap;
      }

      .lfp-order-panel-head {
        gap: 10px;
      }

      .lfp-order-panel-head .lfp-panel-title {
        flex: 1 1 auto;
        min-width: 0;
      }

      .lfp-dashboard-aps-filter {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        flex-wrap: nowrap;
        gap: 5px;
        white-space: nowrap;
      }

      .lfp-dashboard-aps-filter > span {
        margin-right: 2px;
        color: #607a96;
        font-size: 10px;
        font-weight: 800;
      }

      .lfp-dashboard-aps-filter label {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        min-height: 30px;
        padding: 0 7px;
        border: 1px solid #c5d5e6;
        background: #f8fbfe;
        color: #244765;
        cursor: pointer;
        font-size: 10px;
        font-weight: 750;
        user-select: none;
      }

      .lfp-dashboard-aps-filter label:has(input:checked) {
        border-color: #3d91e7;
        background: #eaf4ff;
        color: #065ebc;
      }

      .lfp-dashboard-aps-filter input {
        width: 14px;
        height: 14px;
        margin: 0;
        accent-color: #176b82;
      }

      .lfp-panel-summary {
        display: grid;
        grid-template-columns: 1fr 1fr;
        border-bottom: 1px solid #dce6f1;
        background: #f7f9fc;
      }

      .lfp-summary-metric {
        padding: 14px 20px;
      }

      .lfp-summary-metric + .lfp-summary-metric { border-left: 1px solid #dce6f1; }
      .lfp-summary-metric span { display: block; font-size: 10px; color: var(--lfp-muted); }
      .lfp-summary-metric strong { display: block; margin-top: 4px; font-size: 19px; color: #0a2346; }
      .lfp-summary-metric small { display: block; margin-top: 4px; color: #1570c8; font-size: 9px; font-weight: 750; }
      .lfp-summary-metric.is-danger strong { color: var(--lfp-red); }
      .lfp-summary-metric.is-order strong { color: #b65c00; }

      .lfp-list-head,
      .lfp-alert-row {
        display: grid;
        grid-template-columns: minmax(180px, 1.7fr) minmax(145px, 1.05fr) 100px 104px;
        align-items: center;
        gap: 12px;
      }

      .lfp-order-list-head,
      .lfp-order-row {
        display: grid;
        grid-template-columns: minmax(0, 1fr) 132px;
        align-items: center;
        gap: 18px;
      }

      .lfp-list-head,
      .lfp-order-list-head {
        min-height: 38px;
        padding: 0 18px;
        border-bottom: 1px solid #dce6f1;
        background: #edf3f9;
        color: #49647f;
        font-size: 10px;
        font-weight: 800;
      }

      .lfp-panel-list {
        max-height: calc(100vh - 380px);
        min-height: 410px;
        overflow: auto;
        scrollbar-width: thin;
        scrollbar-color: #aabbd0 transparent;
      }

      .lfp-alert-row,
      .lfp-order-row {
        min-height: 72px;
        padding: 10px 18px 10px 15px;
        border-bottom: 1px solid #e0e8f1;
        border-left: 4px solid #9eb1c5;
        background: #fff;
        transition: background-color .16s ease, transform .16s ease;
      }

      .lfp-alert-row:nth-child(even),
      .lfp-order-row:nth-child(even) { background: #f8fafc; }
      .lfp-alert-row:hover,
      .lfp-order-row:hover { background: #edf6ff; }
      .lfp-alert-row.is-overdue { border-left-color: var(--lfp-red); background: #fff7f7; }
      .lfp-alert-row.is-soon { border-left-color: var(--lfp-amber); }
      .lfp-alert-row.is-normal { border-left-color: var(--lfp-green); }
      .lfp-alert-row.is-undated { border-left-color: #8aa0b8; }
      .lfp-order-row { border-left-color: var(--lfp-amber); }

      .lfp-alert-item,
      .lfp-order-item { min-width: 0; }
      .lfp-alert-item strong,
      .lfp-order-item strong { display: block; margin-bottom: 4px; font-size: 13px; color: #075fc8; }
      .lfp-alert-item span,
      .lfp-order-item span {
        display: block;
        overflow: hidden;
        color: #16324f;
        font-size: 11px;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .lfp-alert-request {
        overflow: hidden;
        color: #536d88;
        font-size: 10px;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .lfp-alert-quantity,
      .lfp-alert-due,
      .lfp-order-quantity { text-align: right; }
      .lfp-alert-quantity strong,
      .lfp-alert-due strong,
      .lfp-order-quantity strong { display: block; font-size: 14px; color: #0a2346; }
      .lfp-alert-quantity span,
      .lfp-alert-due span,
      .lfp-order-quantity span { display: block; margin-top: 4px; color: #758ba2; font-size: 9px; }
      .lfp-alert-row.is-overdue .lfp-alert-due strong,
      .lfp-alert-row.is-overdue .lfp-alert-due span { color: var(--lfp-red); }
      .lfp-order-quantity strong { color: #c45d00; font-size: 17px; }

      .lfp-dashboard-empty {
        display: flex;
        min-height: 320px;
        align-items: center;
        justify-content: center;
        flex-direction: column;
        gap: 8px;
        color: #7890a8;
        text-align: center;
      }
      .lfp-dashboard-empty strong { color: #294968; font-size: 14px; }
      .lfp-dashboard-empty span { font-size: 11px; }

      @media (max-width: 1100px) {
        .lfp-dashboard-grid { grid-template-columns: 1fr; }
        .lfp-command-panel { min-height: 520px; }
        .lfp-panel-list { max-height: 520px; min-height: 330px; }
        .lfp-order-panel-head { align-items: flex-start; flex-direction: column; }
        .lfp-order-head-tools { width: 100%; justify-content: space-between; }
      }

      @media (max-width: 720px) {
        .lfp-dashboard-titlebar { align-items: flex-start; flex-direction: column; }
        .lfp-list-head { display: none; }
        .lfp-alert-row { grid-template-columns: minmax(0, 1fr) 92px; }
        .lfp-alert-request { grid-column: 1 / 2; }
        .lfp-alert-quantity { grid-column: 2; grid-row: 1; }
        .lfp-alert-due { grid-column: 2; grid-row: 2; }
      }
    `;
    document.head.appendChild(style);
  }

  function buildShell() {
    const overview = document.getElementById("overview");
    if (!overview) return false;
    overview.classList.remove("placeholder");
    overview.classList.add("lfp-dashboard-page");
    overview.innerHTML = `
      <div class="lfp-dashboard-shell">
        <header class="lfp-dashboard-titlebar">
          <div>
            <h2>리드지 수급 관리</h2>
            <p>납기 리스크와 구매 필요 품목을 한 화면에서 우선순위대로 확인합니다.</p>
          </div>
          <div class="lfp-dashboard-updated">APS · 재고 · 구매 최신 연결 기준</div>
        </header>

        <section class="lfp-risk-kpi-strip" aria-label="리드지 리스크 KPI">
          <button type="button" class="lfp-risk-kpi" data-risk-filter="managed" title="입고대기 또는 발주대기 수량이 남아 있는 전체 관리 품목"><span>관리대상</span><strong id="lfp-kpi-total">0건</strong><small>입고·발주 대기 기준</small></button>
          <button type="button" class="lfp-risk-kpi is-emergency" data-risk-filter="emergency" title="확정일 우선, 없으면 요청일 기준으로 납기가 지난 품목"><span>긴급</span><strong id="lfp-kpi-emergency">0건</strong><small>납기일 경과</small></button>
          <button type="button" class="lfp-risk-kpi is-check" data-risk-filter="check" title="확정일 우선, 없으면 요청일 기준으로 오늘부터 3일 이내인 품목"><span>확인 필요</span><strong id="lfp-kpi-check">0건</strong><small>납기 D-3 이내</small></button>
          <button type="button" class="lfp-risk-kpi is-order" title="APS 필요량 대비 확보량이 부족해 구매가 필요한 품목"><span>구매 필요</span><strong id="lfp-kpi-order">0건</strong><small>구매 필요수량 발생</small></button>
        </section>

        <div class="lfp-dashboard-grid">
          <article class="lfp-command-panel lfp-risk-panel">
            <header class="lfp-panel-head">
              <div class="lfp-panel-title">
                <h3>리스크 알림</h3>
                <p>납기확정일을 우선하고, 확정일이 없으면 납기요청일 기준으로 정렬합니다.</p>
              </div>
              <div class="lfp-panel-count" id="lfp-risk-count">0건</div>
            </header>
            <div class="lfp-list-head">
              <span>품번 · 규격 · 품명</span><span>대기구분 · 수량</span><span>유효 납기</span>
            </div>
            <div class="lfp-panel-list" id="lfp-risk-list" aria-live="polite"></div>
          </article>

          <article class="lfp-command-panel lfp-order-panel">
            <header class="lfp-panel-head lfp-order-panel-head">
              <div class="lfp-panel-title">
                <h3>구매의뢰 필요알림</h3>
                <p>APS 1.5배 목표와 MOQ·5,000개 단위 올림을 반영한 구매 필요수량입니다.</p>
              </div>
              <div class="lfp-order-head-tools">
                <div class="lfp-dashboard-aps-filter" role="group" aria-label="구매 필요 APS 산출 범위">
                  <span>APS 산출 범위</span>
                  <label><input type="checkbox" data-dashboard-aps="해외" checked>해외</label>
                  <label><input type="checkbox" data-dashboard-aps="PB" checked>PB</label>
                  <label><input type="checkbox" data-dashboard-aps="국내" checked>국내</label>
                  <label><input type="checkbox" data-dashboard-aps="안전재고">안전재고</label>
                </div>
                <div class="lfp-panel-count" id="lfp-order-count">0건</div>
              </div>
            </header>
            <div class="lfp-panel-summary">
              <div class="lfp-summary-metric is-order">
                <span>총 구매 필요수량</span>
                <strong id="lfp-order-quantity">0</strong>
              </div>
              <div class="lfp-summary-metric">
                <span>산출 기준</span>
                <strong>APS × 1.5</strong>
                <small id="lfp-dashboard-aps-summary">해외 + PB + 국내</small>
              </div>
            </div>
            <div class="lfp-order-list-head">
              <span>리드지 · 품명</span><span>구매 필요수량</span>
            </div>
            <div class="lfp-panel-list" id="lfp-order-list" aria-live="polite"></div>
          </article>
        </div>
      </div>`;
    return true;
  }

  function loadDashboardSnapshot() {
    const stamp = Date.now();
    Promise.all([
      fetch(`${SNAPSHOT_URL}?v=${stamp}`, { cache: "no-store" }),
      fetch(`${DELIVERY_URL}?v=${stamp}`, { cache: "no-store" }),
    ])
      .then(async ([snapshotResponse, deliveryResponse]) => {
        if (!snapshotResponse.ok) throw new Error(`대시보드 스냅샷 로드 실패: ${snapshotResponse.status}`);
        const payload = await snapshotResponse.json();
        const deliveryPayload = deliveryResponse.ok ? await deliveryResponse.json() : { records: [] };
        return { payload, deliveryPayload };
      })
      .then(({ payload, deliveryPayload }) => {
        const channels = payload.channels || {};
        state.snapshotAt = payload.snapshotAt || "";
        state.inventoryRows = channels.inventory?.rows || [];
        state.apsMap.clear();
        state.purchaseMap.clear();
        state.deliveryMap.clear();
        (channels.aps?.rows || []).forEach((item) => {
          state.apsMap.set(key(item.liddingCode, item.liddingSpecification), item);
        });
        (channels.purchase?.items || []).forEach((item) => {
          state.purchaseMap.set(key(item.itemCode, item.specification), item);
        });
        (deliveryPayload.records || []).forEach((item) => {
          state.deliveryMap.set(key(item.itemCode, item.spec), item);
        });
        schedule();
      })
      .catch((error) => console.error(error));
  }

  function boot() {
    injectStyles();
    if (!buildShell()) return;
    observeTable(findDetailTable());
    loadDashboardSnapshot();
    window.setInterval(loadDashboardSnapshot, 60000);
    syncApsFilterControls();
    schedule();
    setTimeout(schedule, 200);
    setTimeout(schedule, 600);

    document.addEventListener("lfp:purchase-status-updated", schedule);

    document.addEventListener("click", (event) => {
      if (event.target.closest('[data-tab="overview"]')) setTimeout(schedule, 0);
      const riskKpi = event.target.closest("[data-risk-filter]");
      if (riskKpi) {
        state.riskFilter = riskKpi.dataset.riskFilter;
        schedule();
      }
      if (event.target.closest(".lfp-aps-filter [data-aps-category]")) {
        setTimeout(() => {
          state.apsCategories = new Set(
            Array.from(document.querySelectorAll('.lfp-aps-filter [data-aps-category]:not([data-aps-category="전체"])'))
              .filter((button) => button.classList.contains("is-active") || button.dataset.ctSelected === "true")
              .map((button) => button.dataset.apsCategory)
          );
          syncApsFilterControls();
          schedule();
        }, 0);
      }
    });
    document.addEventListener("change", (event) => {
      const input = event.target.closest("[data-dashboard-aps]");
      if (input) applyDashboardApsFilter(input);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
