(() => {
  "use strict";

  const INVENTORY_URL = "data/lidding-inventory.json";
  const APS_URL = "data/aps-lidding-requirement.json";
  const CONFIRMATION_URL = "data/lidding-delivery-confirmations.xlsx";
  const COLLECTION_STATUS_URL = "data/collection-status.json";
  const SHEETJS_URL = "https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js";
  const LOCAL_STORAGE_KEY = "lfp-delivery-confirmations-v1";
  const WAREHOUSES = [
    { key: "ALL", label: "전체" },
    { key: "300", label: "L관", aliases: ["L관창고(자재)", "L관"] },
    { key: "P010", label: "A관", aliases: ["A관 공정부자재", "A관"] },
    { key: "P030", label: "C관", aliases: ["C관 공정부자재", "C관"] },
    { key: "S100", label: "S관", aliases: ["S관 공정부자재", "S관"] },
  ];
  const QUANTITY_COLUMNS = [
    { key: "stock", label: "재고" },
    { key: "inspection", label: "검사대기" },
    { key: "inbound", label: "입고대기" },
    { key: "purchaseWaiting", label: "발주대기" },
    { key: "required", label: "APS 생산필요" },
  ];

  const state = {
    inventoryByCode: new Map(),
    inventoryByKey: new Map(),
    repoConfirmations: new Map(),
    localConfirmations: new Map(),
    warehouses: new Set(["300", "P010", "P030", "S100"]),
    shortageOnly: false,
    productionRequiredOnly: false,
    deliveryManagementOnly: false,
    quantityFilters: new Set(),
    availableDaysMax: "",
    filters: { code: "", name: "", spec: "", status: "" },
    scheduled: false,
    applying: false,
    toolbarReady: false,
    observer: null,
    resizeObserver: null,
    monitorTimer: null,
  };

  const text = (value) => String(value == null ? "" : value).trim();
  const normalized = (value) => text(value).replace(/\s+/g, " ").toLowerCase();
  const numberValue = (value) => {
    const parsed = Number(String(value == null ? 0 : value).replace(/,/g, ""));
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const formatQty = (value) => Math.round(numberValue(value)).toLocaleString("ko-KR");
  const itemKey = (code, spec) => `${text(code).toUpperCase()}|${text(spec).toUpperCase()}`;

  function clearSelectionForTableChange() {
    if (typeof window.lfpClearSelection === "function") {
      window.lfpClearSelection();
      return;
    }
    document.querySelectorAll(".lfp-detail-table .lfp-row-select:checked, .lfp-detail-table [data-lfp-select-all]:checked")
      .forEach((checkbox) => { checkbox.checked = false; });
    document.querySelectorAll(".lfp-detail-table tbody tr.is-selected")
      .forEach((row) => row.classList.remove("is-selected"));
    window.lfpSyncSelectionHeader?.();
  }

  function clearSupplyFilterState() {
    state.shortageOnly = false;
    state.productionRequiredOnly = false;
    state.deliveryManagementOnly = false;
    document.querySelectorAll(".lfp-shortage-toggle, .lfp-production-toggle, .lfp-delivery-toggle")
      .forEach((button) => {
        button.classList.remove("is-active");
        button.setAttribute("aria-pressed", "false");
      });
  }

  function clearQuantityFilterState() {
    state.quantityFilters.clear();
    document.querySelectorAll(".lfp-quantity-header-button").forEach((button) => {
      button.classList.remove("is-active");
      button.setAttribute("aria-pressed", "false");
    });
  }

  function clearAvailableDaysFilterState() {
    state.availableDaysMax = "";
    const input = document.querySelector("[data-lfp-available-max]");
    if (input) input.value = "";
  }

  function clearOtherButtonFilters(activeGroup) {
    if (activeGroup !== "supply") clearSupplyFilterState();
    if (activeGroup !== "quantity") clearQuantityFilterState();
    if (activeGroup !== "available") clearAvailableDaysFilterState();
    if (activeGroup !== "note") window.lfpSetNoteFilter?.(false, false);
  }

  function parseTableDate(value) {
    const source = text(value).replace(/[.]/g, "/");
    if (!source || source === "-") return null;
    let match = source.match(/^(20\d{2})[-/](\d{1,2})[-/](\d{1,2})$/);
    let year;
    let month;
    let day;
    if (match) {
      [, year, month, day] = match;
    } else {
      match = source.match(/^(\d{1,2})\/(\d{1,2})$/);
      if (!match) return null;
      year = new Date().getFullYear();
      [, month, day] = match;
    }
    const parsed = new Date(Number(year), Number(month) - 1, Number(day));
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  function deliveryAlertStatus(row, columns) {
    const requested = parseTableDate(row.cells[columns.requestedDate]?.textContent);
    const confirmed = parseTableDate(row.cells[columns.confirmedDate]?.textContent);
    const effective = confirmed || requested;
    if (!effective) return "";
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    effective.setHours(0, 0, 0, 0);
    const days = Math.round((effective.getTime() - today.getTime()) / 86400000);
    if (days < 0) return "delivery-overdue";
    if (days <= 3) return "delivery-soon";
    return "";
  }

  function pick(object, keys, fallback = "") {
    if (!object || typeof object !== "object") return fallback;
    for (const key of keys) {
      if (object[key] !== undefined && object[key] !== null && object[key] !== "") return object[key];
    }
    return fallback;
  }

  function findDetailTable() {
    return Array.from(document.querySelectorAll("table")).find((table) => {
      const heading = normalized(table.tHead?.textContent);
      return heading.includes("품목코드") && heading.includes("검사대기") && heading.includes("aps 생산필요");
    }) || null;
  }

  function ensureWaitingColumns(table) {
    const headerRow = Array.from(table.tHead?.rows || []).find((row) => {
      const heading = normalized(row.textContent);
      return !row.classList.contains("lfp-detail-filter-row") && heading.includes("검사대기") && heading.includes("aps 생산필요");
    });
    if (!headerRow) return;

    const headers = Array.from(headerRow.cells);
    const hasInboundWaiting = headers.some((cell) => cell.dataset.lfpRole === "inbound-waiting");
    const purchaseWaiting = headers.find((cell) => normalized(cell.textContent) === "발주대기");
    if (hasInboundWaiting && purchaseWaiting) {
      const inboundIndex = headers.findIndex((cell) => cell.dataset.lfpRole === "inbound-waiting");
      Array.from(table.tBodies).forEach((body) => {
        Array.from(body.rows).forEach((row) => {
          if (row.cells.length !== headers.length - 1) return;
          const cell = row.insertCell(inboundIndex);
          cell.textContent = "-";
          cell.dataset.lfpSource = "purchase-order-api";
          cell.title = "구매발주현황 API 미납수량";
        });
      });
      return;
    }

    const oldInboundIndex = headers.findIndex((cell) => normalized(cell.textContent) === "입고대기");
    if (oldInboundIndex < 0) return;

    const oldInboundHeader = headerRow.cells[oldInboundIndex];
    oldInboundHeader.textContent = "발주대기";
    oldInboundHeader.dataset.lfpRole = "purchase-waiting";

    const inboundHeader = document.createElement("th");
    inboundHeader.textContent = "입고대기";
    inboundHeader.dataset.lfpRole = "inbound-waiting";
    headerRow.insertBefore(inboundHeader, oldInboundHeader);

    Array.from(table.tBodies).forEach((body) => {
      Array.from(body.rows).forEach((row) => {
        if (row.cells.length !== headers.length) return;
        const cell = row.insertCell(oldInboundIndex);
        cell.textContent = "-";
        cell.dataset.lfpSource = "purchase-order-api";
        cell.title = "구매발주현황 API 미납수량";
      });
    });
  }

  function getColumns(table) {
    const headerRow = Array.from(table.tHead?.rows || []).find((row) => {
      const heading = normalized(row.textContent);
      return !row.classList.contains("lfp-detail-filter-row") && heading.includes("품목코드") && heading.includes("aps 생산필요");
    });
    if (!headerRow) return null;

    const columns = {};
    Array.from(headerRow.cells).forEach((cell, index) => {
      const quantityButton = cell.querySelector(".lfp-quantity-header-button");
      const quantityKey = quantityButton?.dataset.quantityFilter;
      if (quantityKey) columns[quantityKey] = index;
      const noteHeaderLabel = cell.querySelector(".lfp-note-header-button span")?.textContent;
      const label = normalized(quantityButton?.querySelector("span")?.textContent || noteHeaderLabel || cell.textContent);
      if (label === "창고") columns.warehouse = index;
      if (label === "품목코드") columns.code = index;
      if (label === "품목명") columns.name = index;
      if (label === "규격") columns.spec = index;
      if (label === "재고") columns.stock = index;
      if (label === "검사대기") columns.inspection = index;
      if (label === "입고대기") columns.inbound = index;
      if (label === "발주대기") columns.purchaseWaiting = index;
      if (label.includes("aps 생산필요")) columns.required = index;
      if (label === "가용일수") columns.availableDays = index;
      if (label === "납기요청일") columns.requestedDate = index;
      if (label === "납기확정일") columns.confirmedDate = index;
      if (label === "리스크 수주") columns.riskOrder = index;
      if (label === "비고" || label.startsWith("비고")) columns.note = index;
    });
    return { headerRow, columns };
  }

  function loadInventory() {
    return window.LFPResources.json(INVENTORY_URL)
      .then((payload) => {
        const items = Array.isArray(payload) ? payload : (payload?.items || payload?.rows || payload?.data || []);
        items.forEach((item) => {
          const code = pick(item, ["itemCode", "item_code", "itm_cd", "품목코드"]);
          const spec = pick(item, ["spec", "itemSpec", "item_spec", "규격"]);
          if (!code) return;
          state.inventoryByCode.set(text(code).toUpperCase(), item);
          state.inventoryByKey.set(itemKey(code, spec), item);
        });
      })
      .catch(() => undefined);
  }

  function warehouseRows(item) {
    const rows = pick(item, ["warehouses", "warehouseRows", "warehouse_rows", "warehouseDetails"], []);
    return Array.isArray(rows) ? rows : [];
  }

  function matchesWarehouse(row, warehouse) {
    const code = text(pick(row, ["warehouseCode", "warehouse_code", "wh_cd", "창고코드"])).toUpperCase();
    const name = normalized(pick(row, ["warehouseName", "warehouse_name", "wh_nm", "창고"]));
    return code === warehouse.key || (warehouse.aliases || []).some((alias) => name.includes(normalized(alias)));
  }

  function inventoryValues(item) {
    if (!item) return null;
    const selectedKeys = Array.from(state.warehouses);
    const isAll = selectedKeys.length === WAREHOUSES.length - 1;
    if (isAll) {
      return {
        label: "전체 4개 창고",
        stock: numberValue(pick(item, ["stockQty", "stock_qty", "stock", "재고"])),
        inspection: numberValue(pick(item, ["inspectionWaitQty", "inspection_wait_qty", "inspectionWait", "검사대기"])),
      };
    }

    const selectedOptions = WAREHOUSES.filter((entry) => entry.key !== "ALL" && state.warehouses.has(entry.key));
    const matchedRows = warehouseRows(item).filter((row) => selectedOptions.some((option) => matchesWarehouse(row, option)));
    return {
      label: selectedOptions.map((option) => option.label).join(" + "),
      stock: matchedRows.reduce((sum, row) => sum + numberValue(pick(row, ["stockQty", "stock_qty", "stock", "재고"])), 0),
      inspection: matchedRows.reduce((maximum, row) => Math.max(maximum, numberValue(pick(row, ["inspectionWaitQty", "inspection_wait_qty", "inspectionWait", "검사대기"]))), 0),
    };
  }

  function ensureSheetJs() {
    return window.LFPResources.script(SHEETJS_URL, "XLSX");
  }

  function matchesSelectedWarehouse(item) {
    if (!item || state.warehouses.size === WAREHOUSES.length - 1) return true;
    const selectedOptions = WAREHOUSES.filter((entry) => entry.key !== "ALL" && state.warehouses.has(entry.key));
    return warehouseRows(item).some((row) => selectedOptions.some((option) => matchesWarehouse(row, option))
      && pick(row, ["hasSourceRow", "has_source_row"], true) !== false);
  }

  function updateWarehouseButtons(group) {
    const isAll = state.warehouses.size === WAREHOUSES.length - 1;
    group.querySelectorAll(".lfp-warehouse-button").forEach((button) => {
      const key = button.dataset.warehouse;
      const option = WAREHOUSES.find((entry) => entry.key === key);
      const active = key === "ALL" ? isAll : (!isAll && state.warehouses.has(key));
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
      button.textContent = key !== "ALL" && active ? `✓ ${option.label}` : option.label;
    });
  }

  function installDelegatedFilterActions() {
    if (document.documentElement.dataset.lfpFilterActions === "true") return;
    document.addEventListener("click", (event) => {
      const selectionResetControl = event.target.closest(
        "[data-aps-category], .lfp-warehouse-button, .lfp-shortage-toggle, .lfp-production-toggle, "
        + ".lfp-delivery-toggle, .lfp-quantity-header-button, .lfp-note-header-button, .lfp-filter-reset"
      );
      if (selectionResetControl) clearSelectionForTableChange();

      if (event.target.closest(".lfp-shortage-toggle, .lfp-production-toggle, .lfp-delivery-toggle")) {
        clearOtherButtonFilters("supply");
      } else if (event.target.closest(".lfp-quantity-header-button")) {
        clearOtherButtonFilters("quantity");
      } else if (event.target.closest(".lfp-note-header-button")) {
        clearOtherButtonFilters("note");
      }

      const button = event.target.closest(
        ".lfp-warehouse-button, .lfp-shortage-toggle, .lfp-production-toggle, .lfp-delivery-toggle, .lfp-quantity-header-button"
      );
      if (!button) return;
      event.preventDefault();
      event.stopImmediatePropagation();

      if (button.classList.contains("lfp-quantity-header-button")) {
        const key = button.dataset.quantityFilter;
        const shouldClear = state.quantityFilters.has(key);
        state.quantityFilters.clear();
        if (!shouldClear) state.quantityFilters.add(key);
        document.querySelectorAll(".lfp-quantity-header-button").forEach((item) => {
          const active = state.quantityFilters.has(item.dataset.quantityFilter);
          item.classList.toggle("is-active", active);
          item.setAttribute("aria-pressed", String(active));
        });
        scheduleApply(false);
        return;
      }

      if (button.classList.contains("lfp-warehouse-button")) {
        const warehouseKey = button.dataset.warehouse;
        const allKeys = WAREHOUSES.filter((entry) => entry.key !== "ALL").map((entry) => entry.key);
        const wasAll = state.warehouses.size === allKeys.length;
        if (warehouseKey === "ALL") {
          state.warehouses = new Set(allKeys);
        } else if (wasAll) {
          state.warehouses = new Set([warehouseKey]);
        } else if (state.warehouses.has(warehouseKey)) {
          if (state.warehouses.size > 1) state.warehouses.delete(warehouseKey);
        } else {
          state.warehouses.add(warehouseKey);
        }
        const group = button.closest(".lfp-warehouse-group");
        if (group) updateWarehouseButtons(group);
        scheduleApply(true);
        return;
      }

      if (button.classList.contains("lfp-shortage-toggle")) {
        state.shortageOnly = !state.shortageOnly;
        state.deliveryManagementOnly = false;
        button.classList.toggle("is-active", state.shortageOnly);
        button.setAttribute("aria-pressed", String(state.shortageOnly));
        const deliveryButton = document.querySelector(".lfp-delivery-toggle");
        deliveryButton?.classList.remove("is-active");
        deliveryButton?.setAttribute("aria-pressed", "false");
      } else if (button.classList.contains("lfp-production-toggle")) {
        state.productionRequiredOnly = !state.productionRequiredOnly;
        button.classList.toggle("is-active", state.productionRequiredOnly);
        button.setAttribute("aria-pressed", String(state.productionRequiredOnly));
      } else if (button.classList.contains("lfp-delivery-toggle")) {
        state.deliveryManagementOnly = !state.deliveryManagementOnly;
        state.shortageOnly = false;
        button.classList.toggle("is-active", state.deliveryManagementOnly);
        button.setAttribute("aria-pressed", String(state.deliveryManagementOnly));
        const shortageButton = document.querySelector(".lfp-shortage-toggle");
        shortageButton?.classList.remove("is-active");
        shortageButton?.setAttribute("aria-pressed", "false");
      }
      scheduleApply(false);
    }, true);
    document.documentElement.dataset.lfpFilterActions = "true";
  }

  function findLegacyQueryPanel() {
    const queryButton = Array.from(document.querySelectorAll("button")).find((button) => text(button.textContent) === "조회");
    if (!queryButton) return null;

    let cursor = queryButton.parentElement;
    while (cursor && cursor !== document.body) {
      const content = normalized(cursor.textContent);
      if (content.includes("통합 검색") && content.includes("납기 상태") && content.includes("재고 상태")) {
        return cursor;
      }
      cursor = cursor.parentElement;
    }
    return null;
  }

  function placeToolbar(toolbar, table) {
    const legacyPanel = findLegacyQueryPanel();
    if (legacyPanel?.parentElement) {
      if (legacyPanel.previousElementSibling !== toolbar) {
        legacyPanel.parentElement.insertBefore(toolbar, legacyPanel);
      }
      return;
    }
    const tablePanel = table.closest("section") || table.parentElement;
    if (tablePanel.previousElementSibling !== toolbar) {
      tablePanel.parentElement?.insertBefore(toolbar, tablePanel);
    }
  }

  function hideApsAppliedBadge() {
    Array.from(document.querySelectorAll("div, span, strong")).forEach((element) => {
      const value = normalized(element.textContent);
      if (value.startsWith("적용:") && value.length < 40) {
        element.classList.add("lfp-aps-applied-badge");
      }
    });
  }

  function placeInventoryRefreshControls(refresh, status) {
    const basis = Array.from(document.querySelectorAll("div, span, strong"))
      .filter((element) => {
        const value = normalized(element.textContent);
        return value.startsWith("재고 기준") && value.length < 35;
      })
      .sort((a, b) => normalized(a.textContent).length - normalized(b.textContent).length)[0];
    if (!basis?.parentElement) return;
    const host = basis.parentElement;
    host.classList.add("lfp-inventory-refresh-host");
    basis.classList.add("lfp-original-inventory-basis");

    const panel = document.createElement("div");
    panel.className = "lfp-refresh-panel";

    const times = document.createElement("div");
    times.className = "lfp-collection-times";
    times.innerHTML = [
      '<span>APS 아웃바운드 시각 <strong data-lfp-time="aps">-</strong></span>',
      '<i aria-hidden="true">|</i>',
      '<span>재고 수집시간 <strong data-lfp-time="inventory">-</strong></span>',
    ].join("");

    const actions = document.createElement("div");
    actions.className = "lfp-refresh-actions";
    actions.append(refresh);
    panel.append(times, actions);
    host.append(panel);
  }

  function createToolbar() {
    const existingToolbar = document.querySelector(".lfp-detail-toolbar");
    const table = findDetailTable();
    if (existingToolbar && table) {
      placeToolbar(existingToolbar, table);
      state.toolbarReady = true;
      return;
    }

    if (!table) return;
    const toolbar = document.createElement("div");
    toolbar.className = "lfp-detail-toolbar";

    const label = document.createElement("span");
    label.className = "lfp-detail-toolbar__label";
    label.textContent = "창고 구분";
    toolbar.appendChild(label);

    const group = document.createElement("div");
    group.className = "lfp-warehouse-group";
    WAREHOUSES.forEach((warehouse) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "lfp-warehouse-button";
      button.dataset.warehouse = warehouse.key;
      button.textContent = warehouse.label;
      group.appendChild(button);
    });
    group.addEventListener("click", (event) => {
      const button = event.target.closest(".lfp-warehouse-button");
      if (!button || !group.contains(button)) return;
      event.preventDefault();
      const warehouseKey = button.dataset.warehouse;
      const allKeys = WAREHOUSES.filter((entry) => entry.key !== "ALL").map((entry) => entry.key);
      const wasAll = state.warehouses.size === allKeys.length;
      if (warehouseKey === "ALL") {
        state.warehouses = new Set(allKeys);
      } else if (wasAll) {
        state.warehouses = new Set([warehouseKey]);
      } else if (state.warehouses.has(warehouseKey)) {
        if (state.warehouses.size > 1) state.warehouses.delete(warehouseKey);
      } else {
        state.warehouses.add(warehouseKey);
      }
      updateWarehouseButtons(group);
      scheduleApply(true);
    });
    updateWarehouseButtons(group);
    toolbar.appendChild(group);

    const supplyLabel = document.createElement("span");
    supplyLabel.className = "lfp-detail-toolbar__label lfp-detail-toolbar__section-label";
    supplyLabel.textContent = "수급 필터";
    toolbar.appendChild(supplyLabel);

    const shortage = document.createElement("button");
    shortage.type = "button";
    shortage.className = "lfp-shortage-toggle lfp-filter-toggle";
    shortage.textContent = "구매 필요";
    shortage.addEventListener("click", () => {
      state.shortageOnly = !state.shortageOnly;
      if (state.shortageOnly) {
        state.deliveryManagementOnly = false;
        delivery.classList.remove("is-active");
        delivery.setAttribute("aria-pressed", "false");
      }
      shortage.classList.toggle("is-active", state.shortageOnly);
      shortage.setAttribute("aria-pressed", String(state.shortageOnly));
      scheduleApply(false);
    });
    toolbar.appendChild(shortage);

    const delivery = document.createElement("button");
    delivery.type = "button";
    delivery.className = "lfp-delivery-toggle lfp-filter-toggle";
    delivery.textContent = "관리 대상";
    delivery.title = "입고대기 수량 또는 납기요청일·납기확정일이 있는 리드지만 표시";
    delivery.addEventListener("click", () => {
      state.deliveryManagementOnly = !state.deliveryManagementOnly;
      if (state.deliveryManagementOnly) {
        state.shortageOnly = false;
        shortage.classList.remove("is-active");
        shortage.setAttribute("aria-pressed", "false");
      }
      delivery.classList.toggle("is-active", state.deliveryManagementOnly);
      delivery.setAttribute("aria-pressed", String(state.deliveryManagementOnly));
      scheduleApply(false);
    });
    toolbar.appendChild(delivery);

    const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "lfp-filter-reset lfp-filter-toggle";
    reset.textContent = "필터 초기화";
    reset.title = "APS·창고·수급·납기·필터행을 기본값으로 복원";
    reset.addEventListener("click", resetAllFilters);
    toolbar.appendChild(reset);

    const exportButton = document.createElement("button");
    exportButton.type = "button";
    exportButton.className = "lfp-purchase-export-button";
    exportButton.textContent = "엑셀 내보내기(구매의뢰)";
    exportButton.title = "체크한 품목만 발주양식으로 바탕화면에 저장";
    exportButton.addEventListener("click", () => exportPurchaseRequest(exportButton));
    toolbar.appendChild(exportButton);

    const scheduleButton = document.createElement("button");
    scheduleButton.type = "button";
    scheduleButton.className = "lfp-schedule-button";
    scheduleButton.textContent = "스케줄 관리";
    scheduleButton.title = "다음 단계에서 수집 스케줄 관리 기능을 연결합니다.";
    scheduleButton.disabled = true;
    toolbar.appendChild(scheduleButton);

    const refresh = document.createElement("button");
    refresh.type = "button";
    refresh.className = "lfp-manual-refresh-button";
    refresh.textContent = "재고 새로고침";
    refresh.addEventListener("click", () => requestManualRefresh(refresh));

    placeInventoryRefreshControls(refresh, null);

    placeToolbar(toolbar, table);
    state.toolbarReady = true;
  }

  function createFilterRow(table, descriptor) {
    let row = table.tHead?.querySelector(".lfp-detail-filter-row");
    if (row) {
      if (descriptor.headerRow.nextElementSibling !== row) {
        descriptor.headerRow.insertAdjacentElement("afterend", row);
      }
      return;
    }
    row = document.createElement("tr");
    row.className = "lfp-detail-filter-row";

    Array.from(descriptor.headerRow.cells).forEach((_, index) => {
      const cell = document.createElement("th");
      let control = null;
      let key = "";
      let placeholder = "";

      if (index === descriptor.columns.code) [key, placeholder] = ["code", "품목코드"];
      if (index === descriptor.columns.name) [key, placeholder] = ["name", "품목명"];
      if (index === descriptor.columns.spec) [key, placeholder] = ["spec", "규격"];

      if (key) {
        control = document.createElement("input");
        control.type = "search";
        control.placeholder = placeholder;
        control.value = state.filters[key];
        control.dataset.filter = key;
        control.addEventListener("input", (event) => {
          clearSelectionForTableChange();
          state.filters[key] = normalized(event.target.value);
          scheduleApply(false);
        });
      } else if (index === descriptor.columns.note) {
        control = document.createElement("select");
        control.dataset.filter = "status";
        [
          ["", "전체 상태"],
          ["risk", "구매 필요"],
          ["delivery-soon", "납기 3일전"],
          ["delivery-overdue", "납기 확정일 수정필요"],
        ].forEach(([value, labelText]) => {
          const option = document.createElement("option");
          option.value = value;
          option.textContent = labelText;
          control.appendChild(option);
        });
        control.value = state.filters.status;
        control.addEventListener("change", (event) => {
          clearSelectionForTableChange();
          state.filters.status = event.target.value;
          scheduleApply(false);
        });
      }

      if (control) cell.appendChild(control);
      row.appendChild(cell);
    });
    descriptor.headerRow.insertAdjacentElement("afterend", row);
  }

  function hideLegacyQueryPanel() {
    findLegacyQueryPanel()?.classList.add("lfp-legacy-query-panel");
  }

  function findStickyTitle(table) {
    const candidates = Array.from(document.querySelectorAll("div, header, section"))
      .filter((element) => {
        const value = normalized(element.textContent);
        return value.includes("리드지 수급 상세 데이터") && value.length < 180;
      })
      .sort((a, b) => normalized(a.textContent).length - normalized(b.textContent).length);
    let title = candidates[0] || null;
    if (!title) return null;

    let cursor = title;
    while (cursor.parentElement && cursor.parentElement !== table.parentElement) {
      const parentText = normalized(cursor.parentElement.textContent);
      if (parentText.length > 260 || cursor.parentElement.contains(table)) break;
      title = cursor.parentElement;
      cursor = cursor.parentElement;
    }
    return title;
  }

  function installStickyLayout(table, descriptor) {
    table.classList.add("lfp-detail-table");
    table.parentElement?.classList.add("lfp-detail-scroll-host");
    const title = findStickyTitle(table);
    if (!title) return;
    title.classList.add("lfp-detail-sticky-title");

    const updateOffsets = () => {
      table.style.setProperty("--lfp-sticky-title-height", `${Math.max(1, title.getBoundingClientRect().height)}px`);
      table.style.setProperty("--lfp-sticky-header-height", `${Math.max(1, descriptor.headerRow.getBoundingClientRect().height)}px`);
    };
    updateOffsets();
    if (window.ResizeObserver && !state.resizeObserver) {
      state.resizeObserver = new ResizeObserver(updateOffsets);
      state.resizeObserver.observe(title);
      state.resizeObserver.observe(descriptor.headerRow);
    }
  }

  function disableDetailRowExpansion(table) {
    if (table.dataset.lfpExpansionDisabled === "true") return;
    const blockExpansion = (event) => {
      if (!event.target.closest("tbody")) return;
      if (event.target.closest("input, button, select, textarea, label, a")) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    table.addEventListener("click", blockExpansion, true);
    table.addEventListener("dblclick", blockExpansion, true);
    table.dataset.lfpExpansionDisabled = "true";
  }

  function enhanceToolbarLayout() {
    const toolbar = document.querySelector(".lfp-detail-toolbar");
    if (!toolbar) return;
    toolbar.classList.add("lfp-detail-toolbar--stacked");
    toolbar.querySelector(".lfp-production-toggle")?.remove();
    const delivery = toolbar.querySelector(".lfp-delivery-toggle");
    if (delivery) delivery.textContent = "관리 대상";
  }

  function detailHeaderRow(table) {
    return Array.from(table.tHead?.rows || []).find((row) => !row.classList.contains("lfp-detail-filter-row"));
  }

  function enhanceTableFilters(table, descriptor) {
    const header = detailHeaderRow(table);
    const filterRow = table.tHead?.querySelector(".lfp-detail-filter-row");
    if (!header || !filterRow) return;

    QUANTITY_COLUMNS.forEach(({ key, label }) => {
      const index = descriptor.columns[key];
      const headerCell = header.cells[index];
      const filterCell = filterRow.cells[index];
      if (headerCell && !headerCell.querySelector(".lfp-quantity-header-button")) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "lfp-quantity-header-button";
        button.dataset.quantityFilter = key;
        button.setAttribute("aria-pressed", "false");
        button.title = `${label}가 0보다 큰 행만 표시`;
        button.innerHTML = `<span>${label}</span>`;
        headerCell.replaceChildren(button);
      }
      if (filterCell && !filterCell.querySelector("[data-lfp-total]")) {
        const total = document.createElement("div");
        total.className = "lfp-column-total";
        total.dataset.lfpTotal = key;
        total.textContent = "합계 0";
        filterCell.replaceChildren(total);
      }
    });

    const availableCell = filterRow.cells[descriptor.columns.availableDays];
    if (availableCell && !availableCell.querySelector("[data-lfp-available-max]")) {
      const wrapper = document.createElement("label");
      wrapper.className = "lfp-available-days-filter";
      wrapper.innerHTML = '<span>≤</span><input type="number" min="0" step="1" inputmode="numeric" placeholder="일수" data-lfp-available-max><small>일</small>';
      const input = wrapper.querySelector("input");
      input.addEventListener("input", () => {
        clearSelectionForTableChange();
        if (input.value !== "") clearOtherButtonFilters("available");
        state.availableDaysMax = input.value === "" ? "" : Math.max(0, Number(input.value));
        scheduleApply(false);
      });
      availableCell.replaceChildren(wrapper);
    }
  }

  function availableDaysValue(cell) {
    const match = text(cell?.textContent).match(/\(\+(\d+)\)/);
    return match ? Number(match[1]) : null;
  }

  function matchesQuantityFilters(row, columns) {
    return [...state.quantityFilters].every((key) => numberValue(row.cells[columns[key]]?.textContent) > 0);
  }

  function matchesAvailableDaysFilter(row, columns) {
    if (state.availableDaysMax === "") return true;
    const days = availableDaysValue(row.cells[columns.availableDays]);
    return days !== null && days <= state.availableDaysMax;
  }

  function applyRowPriorityColor(row, status, columns) {
    row.classList.remove("lfp-row-purchase-needed", "lfp-row-delivery-soon", "lfp-row-delivery-overdue");
    const deliveryStatus = deliveryAlertStatus(row, columns);
    if (deliveryStatus === "delivery-overdue") row.classList.add("lfp-row-delivery-overdue");
    else if (deliveryStatus === "delivery-soon") row.classList.add("lfp-row-delivery-soon");
    else if (status === "risk") row.classList.add("lfp-row-purchase-needed");
  }

  function updateVisibleTotals(table, descriptor) {
    const rows = Array.from(table.tBodies).flatMap((body) => Array.from(body.rows))
      .filter((row) => !row.hidden && row.dataset.lfpMainRow === "true");
    QUANTITY_COLUMNS.forEach(({ key }) => {
      const total = rows.reduce((sum, row) => sum + numberValue(row.cells[descriptor.columns[key]]?.textContent), 0);
      const target = table.tHead?.querySelector(`[data-lfp-total="${key}"]`);
      const value = `합계 ${formatQty(total)}`;
      if (target && text(target.textContent) !== value) target.textContent = value;
    });
  }

  function rowStatus(row, noteCell) {
    if (noteCell?.dataset.lfpAutoPurchaseStatus === "risk"
      || numberValue(noteCell?.dataset.lfpRecommendedOrderQuantity) > 0) return "risk";
    const note = normalized(noteCell?.textContent);
    if (note.includes("구매 필요") || note.includes("발주 필요")) return "risk";
    if (note.includes("발주 대기")) return "purchase";
    if (note.includes("입고 대기")) return "inbound";
    if (note.includes("검사대기")) return "inspection";
    if (note.includes("재고 충족")) return "safe";
    if (note.includes("aps 연결 없음")) return "none";
    return row.dataset.ctStatus || "";
  }

  function matchesStatusFilter(row, columns) {
    if (!state.filters.status) return true;
    if (state.filters.status === "risk") {
      return rowStatus(row, row.cells[columns.note]) === "risk";
    }
    return deliveryAlertStatus(row, columns) === state.filters.status;
  }

  function resetApsFilters() {
    const desired = new Set(["해외", "PB", "국내"]);
    const buttons = Array.from(document.querySelectorAll(
      '.lfp-aps-filter [data-aps-category]:not([data-aps-category="전체"])'
    ));
    const selected = (button) => button.classList.contains("is-active") || button.dataset.ctSelected === "true";
    buttons.filter((button) => desired.has(button.dataset.apsCategory) && !selected(button))
      .forEach((button) => button.click());
    buttons.filter((button) => !desired.has(button.dataset.apsCategory) && selected(button))
      .forEach((button) => button.click());
  }

  function resetAllFilters() {
    clearSelectionForTableChange();
    window.lfpSetNoteFilter?.(false, false);
    state.warehouses = new Set(WAREHOUSES.filter((entry) => entry.key !== "ALL").map((entry) => entry.key));
    state.shortageOnly = false;
    state.productionRequiredOnly = false;
    state.deliveryManagementOnly = false;
    state.quantityFilters.clear();
    state.availableDaysMax = "";
    state.filters = { code: "", name: "", spec: "", status: "" };

    const warehouseGroup = document.querySelector(".lfp-warehouse-group");
    if (warehouseGroup) updateWarehouseButtons(warehouseGroup);
    document.querySelectorAll(".lfp-shortage-toggle, .lfp-production-toggle, .lfp-delivery-toggle")
      .forEach((button) => {
        button.classList.remove("is-active");
        button.setAttribute("aria-pressed", "false");
      });
    document.querySelectorAll(".lfp-detail-filter-row [data-filter]").forEach((control) => {
      control.value = "";
    });
    document.querySelectorAll(".lfp-quantity-header-button").forEach((button) => {
      button.classList.remove("is-active");
      button.setAttribute("aria-pressed", "false");
    });
    const availableDaysInput = document.querySelector("[data-lfp-available-max]");
    if (availableDaysInput) availableDaysInput.value = "";
    resetApsFilters();
    scheduleApply(true);
    setTimeout(() => scheduleApply(true), 180);
  }

  function confirmationFor(code, spec) {
    return state.localConfirmations.get(itemKey(code, spec))
      || state.localConfirmations.get(itemKey(code, ""))
      || state.repoConfirmations.get(itemKey(code, spec))
      || state.repoConfirmations.get(itemKey(code, ""));
  }

  function setText(cell, value, markerName, markerValue) {
    if (!cell) return;
    if (cell.dataset[markerName] === markerValue && text(cell.textContent) === value) return;
    cell.textContent = value;
    cell.dataset[markerName] = markerValue;
  }

  function applyRows(table, descriptor, updateInventory) {
    const { columns } = descriptor;
    Array.from(table.tBodies).forEach((body) => {
      const seenItems = new Set();
      Array.from(body.rows).forEach((row) => {
        const code = text(row.cells[columns.code]?.textContent).toUpperCase();
        const spec = text(row.cells[columns.spec]?.textContent);
        const rowKey = itemKey(code, spec);
        if (!/^BS\d+/i.test(code) || seenItems.has(rowKey)) {
          row.remove();
          return;
        }
        seenItems.add(rowKey);

        row.classList.remove("lfp-expanded-row");
        row.dataset.lfpMainRow = "true";
        const item = state.inventoryByKey.get(itemKey(code, spec)) || state.inventoryByCode.get(code);

        if (updateInventory && item) {
          const values = inventoryValues(item);
          const warehouseMarker = Array.from(state.warehouses).sort().join("+");
          const marker = `${warehouseMarker}:${values.stock}:${values.inspection}`;
          setText(row.cells[columns.warehouse], values.label, "lfpWarehouse", warehouseMarker);
          setText(row.cells[columns.stock], formatQty(values.stock), "lfpInventory", marker);
          setText(row.cells[columns.inspection], formatQty(values.inspection), "lfpInventory", marker);
        } else {
          const warehouseCell = row.cells[columns.warehouse];
          warehouseCell?.querySelectorAll("button").forEach((button) => {
            if (text(button.textContent) === "+") button.remove();
          });
        }

        const confirmedCell = row.cells[columns.confirmedDate];
        const confirmation = confirmationFor(code, spec);
        if (confirmedCell && confirmation) {
          setText(confirmedCell, confirmation.confirmedDate, "lfpConfirmation", `${confirmation.confirmedDate}|${confirmation.memo || ""}`);
          confirmedCell.classList.add("lfp-confirmed-date");
          confirmedCell.title = [confirmation.requestNo, confirmation.memo].filter(Boolean).join(" · ");
        } else if (confirmedCell?.classList.contains("lfp-confirmed-date")) {
          confirmedCell.textContent = "-";
          confirmedCell.classList.remove("lfp-confirmed-date");
          confirmedCell.removeAttribute("title");
          delete confirmedCell.dataset.lfpConfirmation;
        }

        const status = rowStatus(row, row.cells[columns.note]);
        const codeMatch = normalized(code).includes(state.filters.code);
        const nameMatch = normalized(row.cells[columns.name]?.textContent).includes(state.filters.name);
        const specMatch = normalized(spec).includes(state.filters.spec);
        const statusMatch = matchesStatusFilter(row, columns);
        const shortageMatch = !state.shortageOnly || status === "risk";
        let requiredQty = numberValue(row.cells[columns.required]?.textContent);
        const planning = window.lfpPlanningMetrics?.(
          code,
          spec,
          numberValue(row.cells[columns.stock]?.textContent),
          numberValue(row.cells[columns.inspection]?.textContent),
        );
        if (planning && Number.isFinite(Number(planning.productionRequired))) {
          requiredQty = Number(planning.productionRequired);
          setText(
            row.cells[columns.required],
            formatQty(requiredQty),
            "lfpApsRequirement",
            String(requiredQty),
          );
        }
        const availableCell = row.cells[columns.availableDays];
        const riskOrderCell = row.cells[columns.riskOrder];
        if (availableCell) {
          const value = Number(planning?.averageDailyUsage || 0) > 0 ? planning.availableLabel : "-";
          setText(availableCell, value, "lfpAvailability", `${requiredQty}|${value}`);
          availableCell.title = planning?.availableTitle || "";
        }
        if (riskOrderCell) {
          const value = requiredQty > 0 && planning ? planning.riskLabel : "-";
          setText(riskOrderCell, value, "lfpRiskOrder", `${requiredQty}|${value}`);
          riskOrderCell.removeAttribute("title");
          riskOrderCell.classList.toggle("has-risk", value !== "-");
        }
        const inboundQty = numberValue(row.cells[columns.inbound]?.textContent);
        const purchaseWaitingQty = numberValue(row.cells[columns.purchaseWaiting]?.textContent);
        const requestedDate = text(row.cells[columns.requestedDate]?.textContent);
        const confirmedDate = text(row.cells[columns.confirmedDate]?.textContent);
        const productionMatch = !state.productionRequiredOnly || requiredQty > 0;
        const quantityMatch = matchesQuantityFilters(row, columns);
        const warehouseScopedQuantity = [...state.quantityFilters].some((key) => key !== "required");
        const warehouseQuantityMatch = !warehouseScopedQuantity || matchesSelectedWarehouse(item);
        const availableDaysMatch = matchesAvailableDaysFilter(row, columns);
        const deliveryMatch = !state.deliveryManagementOnly
          || inboundQty > 0
          || purchaseWaitingQty > 0
          || (requestedDate && requestedDate !== "-")
          || (confirmedDate && confirmedDate !== "-");
        const noteMatch = !table.classList.contains("lfp-note-filter-active")
          || row.classList.contains("lfp-has-notes");
        applyRowPriorityColor(row, status, columns);
        row.hidden = !(codeMatch && nameMatch && specMatch && statusMatch && shortageMatch && productionMatch
          && quantityMatch && warehouseQuantityMatch && availableDaysMatch && deliveryMatch && noteMatch);
      });
    });
    updateVisibleTotals(table, descriptor);
    const visibleCount = Array.from(table.tBodies)
      .reduce((count, body) => count + Array.from(body.rows)
        .filter((row) => row.dataset.lfpMainRow === "true" && !row.hidden).length, 0);
    const countTarget = document.querySelector("#detail h3")?.nextElementSibling?.querySelector("strong");
    if (countTarget) countTarget.textContent = visibleCount.toLocaleString("ko-KR");
    window.lfpSyncSelectionHeader?.();
  }

  function applyControls(updateInventory = false) {
    if (state.applying) return;
    const table = findDetailTable();
    if (!table) return;
    ensureWaitingColumns(table);
    const descriptor = getColumns(table);
    if (!descriptor) return;

    state.applying = true;
    hideApsAppliedBadge();
    hideLegacyQueryPanel();
    createToolbar();
    enhanceToolbarLayout();
    createFilterRow(table, descriptor);
    enhanceTableFilters(table, descriptor);
    installStickyLayout(table, descriptor);
    disableDetailRowExpansion(table);
    applyRows(table, descriptor, updateInventory);
    state.applying = false;

    if (updateInventory) {
      window.setTimeout(() => {
        const currentTable = findDetailTable();
        const currentDescriptor = currentTable && getColumns(currentTable);
        if (currentTable && currentDescriptor) applyRows(currentTable, currentDescriptor, false);
      }, 0);
    }
  }

  function scheduleApply(updateInventory = false) {
    state.needsInventoryUpdate = state.needsInventoryUpdate || updateInventory;
    if (state.scheduled) return;
    state.scheduled = true;
    requestAnimationFrame(() => {
      state.scheduled = false;
      const shouldUpdateInventory = Boolean(state.needsInventoryUpdate);
      state.needsInventoryUpdate = false;
      applyControls(shouldUpdateInventory);
    });
  }

  window.lfpApplyDetailFilters = (updateInventory = false) => scheduleApply(Boolean(updateInventory));

  function normalizeExcelDate(value) {
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
      return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
    }
    if (typeof value === "number" && window.XLSX?.SSF?.parse_date_code) {
      const parsed = window.XLSX.SSF.parse_date_code(value);
      if (parsed) return `${parsed.y}-${String(parsed.m).padStart(2, "0")}-${String(parsed.d).padStart(2, "0")}`;
    }
    const source = text(value).replace(/[./]/g, "-");
    const match = source.match(/(20\d{2})-(\d{1,2})-(\d{1,2})/);
    return match ? `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}` : "";
  }

  function workbookRows(buffer) {
    if (!window.XLSX) throw new Error("Excel 모듈을 불러오지 못했습니다.");
    const workbook = window.XLSX.read(buffer, { type: "array", cellDates: true });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = window.XLSX.utils.sheet_to_json(sheet, { defval: "", raw: true });
    return rows.map((row) => {
      const normalizedRow = {};
      Object.keys(row).forEach((key) => { normalizedRow[normalized(key).replace(/\s/g, "")] = row[key]; });
      return {
        itemCode: pick(normalizedRow, ["품목코드", "itemcode", "itmcd"]),
        spec: pick(normalizedRow, ["규격", "규격버전", "spec"]),
        confirmedDate: normalizeExcelDate(pick(normalizedRow, ["납기확정일", "확정납기일", "confirmeddeliverydate"])),
        requestNo: pick(normalizedRow, ["구매의뢰번호", "의뢰번호", "requestno"]),
        memo: pick(normalizedRow, ["비고", "memo"]),
      };
    }).filter((row) => row.itemCode && row.confirmedDate);
  }

  function rowsToMap(rows) {
    const result = new Map();
    rows.forEach((row) => result.set(itemKey(row.itemCode, row.spec), row));
    return result;
  }

  function setUploadStatus(message, isError = false) {
    const status = document.querySelector(".lfp-upload-status");
    if (!status) return;
    status.textContent = message;
    status.style.color = isError ? "#b42318" : "";
  }

  function formatMonitorTime(value) {
    if (!value) return "";
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return text(value);
    return new Intl.DateTimeFormat("ko-KR", {
      month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
      hour12: false,
    }).format(parsed);
  }

  function formatCollectionTime(value) {
    if (!value) return "-";
    const source = text(value).replace(" ", "T");
    const parsed = new Date(source);
    if (Number.isNaN(parsed.getTime())) return text(value);
    return new Intl.DateTimeFormat("ko-KR", {
      month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
      hour12: false,
    }).format(parsed);
  }

  async function loadCollectionTimes() {
    const apsTarget = document.querySelector('[data-lfp-time="aps"]');
    const inventoryTarget = document.querySelector('[data-lfp-time="inventory"]');
    if (!apsTarget || !inventoryTarget) return;
    try {
      const [aps, inventory] = await Promise.all([
        window.LFPResources.json(APS_URL),
        window.LFPResources.json(INVENTORY_URL),
      ]);
      apsTarget.textContent = formatCollectionTime(aps.sourceRefreshedAt || aps.generatedAt);
      inventoryTarget.textContent = formatCollectionTime(inventory.generatedAt || inventory.sourceRefreshedAt);
      apsTarget.title = text(aps.sourceRefreshedAt || aps.generatedAt);
      inventoryTarget.title = text(inventory.generatedAt || inventory.sourceRefreshedAt);
    } catch (_) {
      apsTarget.textContent = "확인 필요";
      inventoryTarget.textContent = "확인 필요";
    }
  }

  function selectedPurchaseRows() {
    const table = findDetailTable();
    if (!table) return { rows: [], missing: [] };
    const headerRow = Array.from(table.tHead?.rows || []).find((row) => {
      const value = normalized(row.textContent);
      return !row.classList.contains("lfp-detail-filter-row") && value.includes("품목코드") && value.includes("비고");
    });
    if (!headerRow) return { rows: [], missing: [] };
    const headers = Array.from(headerRow.cells);
    const findColumn = (label) => headers.findIndex((cell) => normalized(cell.textContent).includes(normalized(label)));
    const columns = {
      code: findColumn("품목코드"),
      spec: findColumn("규격"),
      note: findColumn("비고"),
    };
    const rows = [];
    const missing = [];
    Array.from(table.tBodies).flatMap((body) => Array.from(body.rows)).forEach((row) => {
      const checkbox = row.querySelector(".lfp-row-select");
      if (!checkbox?.checked) return;
      const itemCode = text(row.cells[columns.code]?.textContent);
      const spec = text(row.cells[columns.spec]?.textContent);
      const noteCell = row.cells[columns.note];
      const note = text(noteCell?.textContent);
      const match = note.match(/발주\s*필요\s*([0-9][0-9,]*)/);
      const quantity = numberValue(noteCell?.dataset.lfpRecommendedOrderQuantity)
        || (match ? numberValue(match[1]) : 0);
      if (!itemCode || quantity <= 0) {
        missing.push(itemCode || "품목코드 없음");
        return;
      }
      rows.push({ itemCode, spec, quantity: Math.round(quantity) });
    });
    return { rows, missing };
  }

  function cloneWorkbookCell(cell) {
    if (!cell) return null;
    if (typeof structuredClone === "function") return structuredClone(cell);
    return JSON.parse(JSON.stringify(cell));
  }

  function setWorkbookCell(sheet, address, value, type = "s", numberFormat = "") {
    const cell = cloneWorkbookCell(sheet[address]) || {};
    cell.t = type;
    cell.v = value;
    if (numberFormat) cell.z = numberFormat;
    delete cell.w;
    sheet[address] = cell;
  }

  function cloneWorkbookRow(sheet, sourceRow, targetRow, lastColumn) {
    for (let column = 0; column <= lastColumn; column += 1) {
      const sourceAddress = window.XLSX.utils.encode_cell({ r: sourceRow, c: column });
      const targetAddress = window.XLSX.utils.encode_cell({ r: targetRow, c: column });
      const sourceCell = cloneWorkbookCell(sheet[sourceAddress]);
      if (sourceCell) sheet[targetAddress] = sourceCell;
    }
    if (Array.isArray(sheet["!rows"]) && sheet["!rows"][sourceRow]) {
      sheet["!rows"][targetRow] = cloneWorkbookCell(sheet["!rows"][sourceRow]);
    }
  }

  function purchaseDueDate() {
    const result = new Date();
    result.setHours(12, 0, 0, 0);
    result.setDate(result.getDate() + 14);
    return result;
  }

  function localIsoDate(value) {
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
  }

  async function downloadPurchaseWorkbook(rows) {
    await ensureSheetJs();
    const templateResponse = await fetch("templates/purchase-request-template.xlsx", { cache: "no-store" });
    if (!templateResponse.ok) throw new Error("발주 Excel 양식을 불러오지 못했습니다.");

    const workbook = window.XLSX.read(await templateResponse.arrayBuffer(), {
      type: "array",
      cellDates: true,
      cellStyles: true,
    });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    if (!sheet) throw new Error("발주 Excel 양식의 시트를 찾지 못했습니다.");

    const range = window.XLSX.utils.decode_range(sheet["!ref"] || "A1:Z2");
    const templateRow = 1;
    const dueDate = purchaseDueDate();
    rows.forEach((row, index) => {
      const targetRow = templateRow + index;
      if (targetRow !== templateRow) cloneWorkbookRow(sheet, templateRow, targetRow, Math.max(range.e.c, 25));
      setWorkbookCell(sheet, window.XLSX.utils.encode_cell({ r: targetRow, c: 4 }), index + 1, "n");
      setWorkbookCell(sheet, window.XLSX.utils.encode_cell({ r: targetRow, c: 5 }), row.itemCode, "s");
      setWorkbookCell(sheet, window.XLSX.utils.encode_cell({ r: targetRow, c: 8 }), row.spec, "s");
      setWorkbookCell(sheet, window.XLSX.utils.encode_cell({ r: targetRow, c: 11 }), "국내(원)", "s");
      setWorkbookCell(sheet, window.XLSX.utils.encode_cell({ r: targetRow, c: 12 }), row.quantity, "n", "#,##0");
      setWorkbookCell(sheet, window.XLSX.utils.encode_cell({ r: targetRow, c: 13 }), 0, "n");
      setWorkbookCell(sheet, window.XLSX.utils.encode_cell({ r: targetRow, c: 14 }), 0, "n");
      setWorkbookCell(sheet, window.XLSX.utils.encode_cell({ r: targetRow, c: 16 }), "KRW", "s");
      setWorkbookCell(sheet, window.XLSX.utils.encode_cell({ r: targetRow, c: 18 }), dueDate, "d", "yyyy-mm-dd");
    });
    range.e.r = Math.max(range.e.r, templateRow + rows.length - 1);
    range.e.c = Math.max(range.e.c, 25);
    sheet["!ref"] = window.XLSX.utils.encode_range(range);

    const today = localIsoDate(new Date());
    window.XLSX.writeFile(workbook, `${today}_구매의뢰 리스트.xlsx`, {
      compression: true,
      cellStyles: true,
    });
    return { count: rows.length, dueDate: localIsoDate(dueDate) };
  }

  async function exportPurchaseRequest(button) {
    const selected = document.querySelectorAll(".lfp-detail-table .lfp-row-select:checked").length;
    if (!selected) {
      window.alert("발주 Excel로 내보낼 품목을 먼저 체크해주세요.");
      return;
    }
    const { rows, missing } = selectedPurchaseRows();
    if (missing.length) {
      window.alert(`구매 필요 수량이 없는 선택 품목입니다.\n${missing.join(", ")}`);
      return;
    }

    const original = button.textContent;
    button.disabled = true;
    button.textContent = "Excel 생성 중";
    try {
      const result = await downloadPurchaseWorkbook(rows);
      window.alert(`${result.count.toLocaleString("ko-KR")}건 다운로드 완료\n납기요청일 ${result.dueDate}\n브라우저의 다운로드 폴더를 확인해주세요.`);
    } catch (error) {
      console.error("purchase workbook export failed", error);
      window.alert(error?.message || "발주 Excel 저장에 실패했습니다.");
    } finally {
      button.disabled = false;
      button.textContent = original;
    }
  }

  async function loadMonitorStatus() {
    const target = document.querySelector(".lfp-monitor-status");
    if (!target) return;
    try {
      const collection = await window.LFPCollectionClient.readStatus();
      const latest = collection.lastCollection || {};
      target.classList.toggle("is-error", latest.status === "error");
      target.textContent = latest.status === "success"
        ? `ERP 수집 정상 · ${formatMonitorTime(latest.at)}`
        : "ERP 수집 상태 확인 필요";
    } catch (_) {
      target.textContent = "ERP 수집 상태 확인 필요";
    }
  }

  async function requestManualRefresh(button) {
    button.disabled = true;
    const original = button.textContent;
    button.textContent = "수집 요청 중";
    try {
      await window.LFPCollectionClient.collect("inventory", {
        onProgress: (message) => { button.textContent = message; },
      });
      window.LFPResources.invalidate(INVENTORY_URL);
      await loadMonitorStatus();
      button.textContent = "수집 완료";
      window.setTimeout(() => window.location.reload(), 500);
    } catch (error) {
      button.textContent = "수집 실패";
      button.title = error?.message || "ERP 재고를 갱신하지 못했습니다.";
      window.alert(button.title);
      window.setTimeout(() => {
        button.disabled = false;
        button.textContent = original;
      }, 2200);
    }
  }

  async function handleWorkbookUpload(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      await ensureSheetJs();
      const rows = workbookRows(await file.arrayBuffer());
      state.localConfirmations = rowsToMap(rows);
      localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(rows));
      setUploadStatus(`${file.name} · 납기확정일 ${rows.length.toLocaleString("ko-KR")}건 적용`);
      scheduleApply(false);
    } catch (error) {
      setUploadStatus(error?.message || "Excel 파일을 읽지 못했습니다.", true);
    } finally {
      event.target.value = "";
    }
  }

  function restoreLocalConfirmations() {
    try {
      const rows = JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEY) || "[]");
      if (Array.isArray(rows)) state.localConfirmations = rowsToMap(rows);
    } catch (_) {
      state.localConfirmations = new Map();
    }
  }

  async function loadRepoConfirmations() {
    try {
      const response = await fetch(CONFIRMATION_URL, { cache: "no-store" });
      if (!response.ok) return;
      await ensureSheetJs();
      const rows = workbookRows(await response.arrayBuffer());
      state.repoConfirmations = rowsToMap(rows);
      setUploadStatus(`Git 납기확정일 ${rows.length.toLocaleString("ko-KR")}건 + 로컬 ${state.localConfirmations.size.toLocaleString("ko-KR")}건`);
      scheduleApply(false);
    } catch (_) {
      // The shared workbook is optional. A local upload remains available.
    }
  }

  async function init() {
    restoreLocalConfirmations();
    installDelegatedFilterActions();
    applyControls(false);
    await loadInventory();
    createToolbar();
    loadCollectionTimes();
    scheduleApply(true);
    loadRepoConfirmations();
    loadMonitorStatus();
    if (!state.monitorTimer) {
      state.monitorTimer = window.setInterval(() => {
        if (!document.hidden) loadMonitorStatus();
      }, 15000);
    }

    state.observer = new MutationObserver(() => {
      if (!state.applying) scheduleApply(false);
    });
    const table = findDetailTable();
    if (table) state.observer.observe(table, { childList: true, subtree: true });
    document.addEventListener("lfp:purchase-status-updated", () => scheduleApply(false));
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
