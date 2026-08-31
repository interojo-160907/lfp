(() => {
  const state = {
    data: null,
    aps: null,
    requirementMap: new Map(),
    productionUsageMap: new Map(),
    productionUsage: null,
    productMap: new Map(),
    productMapByCode: new Map(),
    selectedItems: new Set(),
    apsCategories: new Set(["해외", "PB", "국내"]),
    search: "",
    warehouse: "",
    expanded: new Set(),
  };
  const numberFormat = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 2 });

  const escapeHtml = (value) => String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

  function findDetailTable() {
    return [...document.querySelectorAll("table")].find((table) => {
      const headers = [...table.querySelectorAll("th")].map((cell) => cell.textContent.trim());
      return headers.includes("품목코드") && headers.includes("검사대기")
        && (headers.includes("사용량 환산") || headers.includes("APS 생산필요"));
    });
  }

  function replaceText(pattern, replacement) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (pattern.test(node.nodeValue)) node.nodeValue = node.nodeValue.replace(pattern, replacement);
    }
  }

  function injectStyles() {
    const style = document.createElement("style");
    style.textContent = `
      .lfp-summary-row { cursor: default; }
      .lfp-summary-row:hover { background: #f4f8ff; }
      .lfp-child-row { background: #f8fafc; color: #40516d; }
      .lfp-child-row td:first-child { padding-left: 32px; }
      .lfp-expand { width: 24px; height: 24px; margin-right: 8px; border: 1px solid #b9c8dc; background: #fff; color: #075ccb; cursor: pointer; }
      .lfp-number { text-align: right; font-variant-numeric: tabular-nums; }
      .lfp-muted { color: #8090a8; }
      .lfp-inspection { color: #b45309; font-weight: 700; }
      .lfp-aps-filter { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; min-height: 42px; }
      .lfp-aps-filter-label { margin-right: 8px; color: #102a53; font-weight: 900; }
      .lfp-aps-filter button { min-width: 68px; height: 36px; padding: 0 14px; border: 1px solid #b7c7dc; border-radius: 6px; background: #fff; color: #415571; font-weight: 700; cursor: pointer; }
      .lfp-aps-filter button.is-active { border-color: #075dcc; background: #075dcc; color: #fff; box-shadow: 0 3px 10px rgba(7, 93, 204, .18); }
      .lfp-aps-filter-summary { margin-left: auto; padding: 8px 12px; border-left: 3px solid #075dcc; background: #edf5ff; color: #0755a6; font-size: 12px; font-weight: 800; }
      .lfp-status-ok { color: #047857; font-weight: 800; }
      .lfp-status-wait { color: #b45309; font-weight: 800; }
      .lfp-status-buy { color: #c2410c; font-weight: 900; }
      .lfp-availability-cell { color: #075985; font-weight: 800; text-align: center; }
      .lfp-risk-order-cell { color: #64748b; font-weight: 800; text-align: center; }
      .lfp-risk-order-cell.has-risk { color: #b42318; background: #fff1ef; }
      .lfp-item-name-cell, .lfp-risk-order-cell.has-risk { cursor: help; }
      .lfp-item-name-cell:hover { color: #0759c7; text-decoration: underline dotted; text-underline-offset: 3px; }
      .lfp-hover-popover { position: fixed; z-index: 5000; width: min(390px, calc(100vw - 24px)); display: none; color: #102a4d; font-size: 12px; background: #fff; border: 1px solid #88a7c7; border-top: 3px solid #0aa9c5; border-radius: 5px; box-shadow: 0 16px 38px rgba(8, 35, 67, .24); }
      .lfp-hover-popover.is-visible { display: block; }
      .lfp-hover-popover__head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 12px; color: #0a2146; font-weight: 900; background: #f4f8fc; border-bottom: 1px solid #cfdae7; }
      .lfp-hover-popover__head small { color: #56718e; font-size: 10px; }
      .lfp-hover-popover__list { max-height: 260px; overflow-y: auto; overscroll-behavior: contain; scrollbar-width: thin; }
      .lfp-hover-popover__row { display: grid; grid-template-columns: 84px minmax(0, 1fr); gap: 9px; align-items: start; padding: 8px 12px; border-bottom: 1px solid #e3ebf3; }
      .lfp-hover-popover__row:last-child { border-bottom: 0; }
      .lfp-hover-popover__row strong { color: #0759c7; font-family: Consolas, monospace; font-size: 11px; }
      .lfp-hover-popover__row span { min-width: 0; line-height: 1.45; overflow-wrap: anywhere; }
      .lfp-hover-popover__row.is-risk { grid-template-columns: 1fr; color: #7d2723; font-family: Consolas, monospace; }
      .lfp-hover-popover__empty { padding: 18px 12px; color: #6d819d; text-align: center; }
      .lfp-hover-popover__item-name { margin: 0 0 8px; padding: 8px 10px; color: #102f55; font-weight: 800; line-height: 1.45; background: #edf6ff; border: 1px solid #bdd5ee; border-radius: 5px; overflow-wrap: anywhere; }
      .lfp-select-cell { text-align: center !important; }
      .lfp-row-select, [data-lfp-select-all] { width: 15px; height: 15px; margin: 0; accent-color: #0759c7; cursor: pointer; }
      .lfp-summary-row.is-selected td { background-color: #e8f3ff !important; }
      .lfp-selection-count { display: inline-flex; align-items: center; min-height: 22px; margin-left: 8px; padding: 1px 7px; color: #0759c7; font-size: 10px; font-weight: 800; background: #eaf3ff; border: 1px solid #a8c9ec; border-radius: 11px; }
    `;
    document.head.appendChild(style);
  }

  function getControls() {
    const warehouse = [...document.querySelectorAll("select")].find((select) =>
      [...select.options].some((option) => option.textContent.includes("전체 창고"))
    );
    const search = [...document.querySelectorAll("input")].find((input) =>
      (input.placeholder || "").includes("품목코드")
    );
    const buttons = [...document.querySelectorAll("button")];
    return {
      warehouse,
      search,
      query: buttons.find((button) => button.textContent.trim() === "조회"),
      reset: buttons.find((button) => button.textContent.trim() === "초기화"),
    };
  }

  function filteredRows() {
    const query = state.search.trim().toLowerCase();
    return state.data.rows.filter((row) => {
      const matchesSearch = !query || [row.itemCode, row.itemName, row.specification]
        .some((value) => String(value || "").toLowerCase().includes(query));
      const matchesWarehouse = !state.warehouse || row.warehouses.some((warehouse) =>
        warehouse.warehouseCode === state.warehouse && warehouse.hasSourceRow
      );
      return matchesSearch && matchesWarehouse;
    });
  }

  function applyApsRequirements() {
    for (const row of state.data.rows) {
      const requirement = state.requirementMap.get(`${row.itemCode}|${row.specification}`);
      const quantities = requirement?.categoryQuantities || {};
      row.productionRequiredQty = [...state.apsCategories]
        .reduce((sum, selected) => sum + Number(quantities[selected] || 0), 0);
      row.linkedPCodeCount = Number(requirement?.linkedPCodeCount || 0);
      row.purchaseReviewQty = Math.max(
        0,
        row.productionRequiredQty - Number(row.stockQty || 0) - Number(row.inspectionWaitQty || 0),
      );
      if (row.productionRequiredQty === 0) {
        row.planningNote = "APS 연결 없음";
        row.planningClass = "";
      } else if (row.productionRequiredQty <= Number(row.stockQty || 0)) {
        row.planningNote = `재고 충족 · P코드 ${row.linkedPCodeCount}개`;
        row.planningClass = "lfp-status-ok";
      } else if (row.productionRequiredQty <= Number(row.stockQty || 0) + Number(row.inspectionWaitQty || 0)) {
        row.planningNote = `검사완료 대기 · P코드 ${row.linkedPCodeCount}개`;
        row.planningClass = "lfp-status-wait";
      } else {
        row.planningNote = `구매이력 확인 필요 ${numberFormat.format(row.purchaseReviewQty)} · P코드 ${row.linkedPCodeCount}개`;
        row.planningClass = "lfp-status-buy";
      }
    }
  }

  function parseIsoDate(value) {
    const match = String(value || "").match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (!match) return null;
    const parsed = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  function startOfToday() {
    const today = new Date();
    return new Date(today.getFullYear(), today.getMonth(), today.getDate());
  }

  function formatShortDate(date) {
    return date instanceof Date && !Number.isNaN(date.getTime())
      ? `${date.getMonth() + 1}/${date.getDate()}`
      : "-";
  }

  function planningMetrics(itemCode, specification, stockQty, inspectionWaitQty) {
    const requirement = state.requirementMap.get(`${itemCode}|${specification}`);
    const quantities = requirement?.categoryQuantities || {};
    const productionRequired = [...state.apsCategories]
      .reduce((sum, category) => sum + Number(quantities[category] || 0), 0);
    const usage = state.productionUsageMap.get(`${itemCode}|${specification}`);
    const averageDailyUsage = Number(usage?.averageDailyUsage || 0);

    const orders = (requirement?.salesOrders || [])
      .filter((order) => state.apsCategories.has(order.demandCategory))
      .map((order) => ({ ...order, parsedDueDate: parseIsoDate(order.dueDate) }))
      .filter((order) => order.parsedDueDate && Number(order.productionRequiredQty || 0) > 0);
    const availableQty = Math.max(0, Number(stockQty || 0) + Number(inspectionWaitQty || 0));
    const availableDays = averageDailyUsage > 0
      ? Math.max(0, Math.floor(availableQty / averageDailyUsage))
      : null;
    const availableDate = availableDays === null ? null : startOfToday();
    if (availableDate) availableDate.setDate(availableDate.getDate() + availableDays);

    const groupedOrders = new Map();
    orders.forEach((order) => {
      const orderNumber = String(order.salesOrderNo || order.demandId || order.demandType || "수주번호 미연결");
      const key = `${order.dueDate}|${orderNumber}`;
      const current = groupedOrders.get(key) || {
        orderNumber,
        dueDate: order.dueDate,
        parsedDueDate: order.parsedDueDate,
        requiredQty: 0,
        initials: new Set(),
      };
      current.requiredQty += Number(order.productionRequiredQty || 0);
      if (order.initial) current.initials.add(String(order.initial));
      groupedOrders.set(key, current);
    });

    let remainingQty = availableQty;
    let riskOrder = null;
    let riskTriggered = false;
    const riskOrders = [];
    [...groupedOrders.values()]
      .sort((left, right) => left.dueDate.localeCompare(right.dueDate)
        || left.orderNumber.localeCompare(right.orderNumber))
      .forEach((order) => {
        const bufferedRequiredQty = Math.ceil(order.requiredQty * 1.5);
        if (!riskTriggered && remainingQty >= bufferedRequiredQty) {
          remainingQty -= bufferedRequiredQty;
          return;
        }
        if (!riskTriggered) {
          riskOrder = {
            ...order,
            bufferedRequiredQty,
            availableBeforeOrder: remainingQty,
            shortageQty: bufferedRequiredQty - remainingQty,
          };
          riskTriggered = true;
        }
        riskOrders.push({
          initial: [...order.initials].join(", ") || "-",
          orderNumber: order.orderNumber,
          dueDate: order.dueDate,
        });
      });

    return {
      productionRequired,
      averageDailyUsage,
      availableLabel: availableDate ? `${formatShortDate(availableDate)}(+${availableDays})` : "-",
      availableTitle: availableDate
        ? `가용 ${numberFormat.format(availableQty)} ÷ 최근 7일 실적 일평균 ${numberFormat.format(averageDailyUsage)} = ${availableDays}일 · 실적 ${state.productionUsage?.dateFrom || "-"}~${state.productionUsage?.dateTo || "-"}`
        : `최근 7일 생산실적 기준 사용량이 없습니다. · 실적 ${state.productionUsage?.dateFrom || "-"}~${state.productionUsage?.dateTo || "-"}`,
      riskLabel: riskOrder ? formatShortDate(riskOrder.parsedDueDate) : "-",
      riskTitle: riskOrder
        ? `${riskOrder.orderNumber} · 1.5배 필요 ${numberFormat.format(riskOrder.bufferedRequiredQty)} · 직전 가용 ${numberFormat.format(riskOrder.availableBeforeOrder)} · 부족 ${numberFormat.format(riskOrder.shortageQty)}`
        : "현재 재고와 검사대기로 선택된 APS 수주를 모두 커버합니다.",
      riskOrders,
    };
  }

  window.lfpPlanningMetrics = planningMetrics;

  function addProductMapping(map, key, product) {
    if (!map.has(key)) map.set(key, new Map());
    map.get(key).set(product.productCode, product);
  }

  function buildProductMaps(payload) {
    for (const row of payload?.rows || []) {
      const product = {
        productCode: String(row.productCode || "").trim(),
        productName: String(row.productName || "").trim(),
      };
      const itemCode = String(row.liddingCode || "").trim();
      const specification = String(row.liddingSpecification || "").trim();
      if (!product.productCode || !itemCode) continue;
      addProductMapping(state.productMap, `${itemCode}|${specification}`, product);
      addProductMapping(state.productMapByCode, itemCode, product);
    }
  }

  function linkedProducts(itemCode, specification) {
    const bomProducts = state.productMap.get(`${itemCode}|${specification}`)
      || state.productMapByCode.get(itemCode)
      || new Map();
    const requirement = state.requirementMap.get(`${itemCode}|${specification}`);
    const requiredByPCode = new Map();
    for (const order of requirement?.salesOrders || []) {
      const pCode = String(order.pCode || "").trim();
      const requiredQty = Number(order.productionRequiredQty || 0);
      if (!pCode || requiredQty <= 0 || !state.apsCategories.has(order.demandCategory)) continue;
      requiredByPCode.set(pCode, (requiredByPCode.get(pCode) || 0) + requiredQty);
    }
    return [...requiredByPCode.entries()]
      .map(([productCode, requiredQty]) => ({
        productCode,
        productName: bomProducts.get(productCode)?.productName || "품명 미연결",
        requiredQty,
      }))
      .sort((left, right) => left.productCode.localeCompare(right.productCode));
  }

  function hoverPopover() {
    let popover = document.querySelector(".lfp-hover-popover");
    if (popover) return popover;
    popover = document.createElement("div");
    popover.className = "lfp-hover-popover";
    popover.setAttribute("role", "tooltip");
    popover.addEventListener("mouseenter", () => window.clearTimeout(popover._hideTimer));
    popover.addEventListener("mouseleave", () => {
      popover._hideTimer = window.setTimeout(() => popover.classList.remove("is-visible"), 220);
    });
    const dismissOnTableMotion = (event) => {
      const target = event?.target;
      if (target === popover || (target instanceof Node && popover.contains(target))) return;
      window.clearTimeout(popover._hideTimer);
      popover.classList.remove("is-visible");
    };
    document.addEventListener("scroll", dismissOnTableMotion, true);
    window.addEventListener("resize", dismissOnTableMotion);
    document.body.appendChild(popover);
    return popover;
  }

  function positionPopover(popover, anchor) {
    const anchorRect = anchor.getBoundingClientRect();
    const popoverRect = popover.getBoundingClientRect();
    const left = Math.max(12, Math.min(anchorRect.left, window.innerWidth - popoverRect.width - 12));
    let top = anchorRect.bottom + 7;
    if (top + popoverRect.height > window.innerHeight - 12) {
      top = Math.max(12, anchorRect.top - popoverRect.height - 7);
    }
    popover.style.left = `${left}px`;
    popover.style.top = `${top}px`;
  }

  function showProductPopover(cell) {
    const products = linkedProducts(cell.dataset.itemCode, cell.dataset.itemSpec);
    const popover = hoverPopover();
    popover.innerHTML = `
      <div class="lfp-hover-popover__head"><span>${escapeHtml(cell.dataset.itemCode)} APS 부족 P코드</span><small>${products.length.toLocaleString("ko-KR")}개</small></div>
      <div class="lfp-hover-popover__list">
        <div class="lfp-hover-popover__item-name">${escapeHtml(cell.textContent.trim())}</div>
        ${products.length ? products.map((product) => `
          <div class="lfp-hover-popover__row"><strong>${escapeHtml(product.productCode)}</strong><span>${escapeHtml(product.productName || "품명 없음")}</span></div>
        `).join("") : '<div class="lfp-hover-popover__empty">선택된 APS 범주의 부족 P코드가 없습니다.</div>'}
      </div>`;
    popover.classList.add("is-visible");
    positionPopover(popover, cell);
  }

  function showRiskPopover(cell) {
    const row = cell.closest("tr");
    const table = cell.closest("table");
    const header = Array.from(table?.tHead?.rows || []).find((item) => !item.classList.contains("lfp-detail-filter-row"));
    const labels = Array.from(header?.cells || []).map((item) =>
      (item.querySelector(".lfp-quantity-header-button span")?.textContent || item.textContent).trim()
    );
    const stockIndex = labels.findIndex((label) => label === "재고" || label.startsWith("재고"));
    const inspectionIndex = labels.findIndex((label) => label === "검사대기" || label.startsWith("검사대기"));
    const metrics = planningMetrics(
      cell.dataset.itemCode,
      cell.dataset.itemSpec,
      Number(String(row?.cells[stockIndex]?.textContent || "0").replace(/,/g, "")),
      Number(String(row?.cells[inspectionIndex]?.textContent || "0").replace(/,/g, "")),
    );
    const popover = hoverPopover();
    popover.innerHTML = `
      <div class="lfp-hover-popover__head"><span>${escapeHtml(cell.dataset.itemCode)} 리스크 수주</span><small>${metrics.riskOrders.length.toLocaleString("ko-KR")}건</small></div>
      <div class="lfp-hover-popover__list">
        ${metrics.riskOrders.length ? metrics.riskOrders.map((order) => `
          <div class="lfp-hover-popover__row is-risk"><span>${escapeHtml(order.initial)} / ${escapeHtml(order.orderNumber)} / ${escapeHtml(order.dueDate)}</span></div>
        `).join("") : '<div class="lfp-hover-popover__empty">현재 리스크 수주가 없습니다.</div>'}
      </div>`;
    popover.classList.add("is-visible");
    positionPopover(popover, cell);
  }

  function bindHoverPopovers(tbody) {
    const popover = hoverPopover();
    tbody.querySelectorAll(".lfp-item-name-cell, .lfp-risk-order-cell").forEach((cell) => {
      cell.addEventListener("mouseenter", () => {
        window.clearTimeout(popover._hideTimer);
        if (cell.classList.contains("lfp-item-name-cell")) showProductPopover(cell);
        else if (cell.classList.contains("has-risk")) showRiskPopover(cell);
      });
      cell.addEventListener("mouseleave", () => {
        popover._hideTimer = window.setTimeout(() => popover.classList.remove("is-visible"), 600);
      });
    });
  }

  function mountApsFilter() {
    const heading = [...document.querySelectorAll("h1,h2,h3")]
      .find((node) => node.textContent.trim() === "리드지별 상세내역");
    if (!heading || document.querySelector(".lfp-aps-filter")) return;
    const host = heading.parentElement;
    heading.style.display = "none";
    const subtitle = [...host.children].find((node) => node.tagName === "P");
    if (subtitle) subtitle.style.display = "none";

    const filter = document.createElement("div");
    filter.className = "lfp-aps-filter";
    filter.innerHTML = `
      <span class="lfp-aps-filter-label">APS 하이드레이션</span>
      <button type="button" data-aps-category="전체">전체</button>
      <button type="button" data-aps-category="해외">해외</button>
      <button type="button" data-aps-category="PB">PB</button>
      <button type="button" data-aps-category="국내">국내</button>
      <button type="button" data-aps-category="안전재고">안전</button>
      <span class="lfp-aps-filter-summary"></span>
    `;
    host.prepend(filter);

    const refreshButtons = () => {
      const allSelected = state.apsCategories.size === 4;
      filter.querySelectorAll("[data-aps-category]").forEach((button) => {
        const value = button.dataset.apsCategory;
        button.classList.toggle(
          "is-active",
          value === "전체" ? allSelected : !allSelected && state.apsCategories.has(value),
        );
      });
      const labels = ["해외", "PB", "국내", "안전재고"].filter((value) => state.apsCategories.has(value));
      filter.querySelector(".lfp-aps-filter-summary").textContent = allSelected
        ? "적용: 전체"
        : `적용: ${labels.join(" + ")}`;
    };

    filter.querySelectorAll("[data-aps-category]").forEach((button) => {
      button.addEventListener("click", () => {
        const value = button.dataset.apsCategory;
        if (value === "전체") {
          state.apsCategories = new Set(["해외", "PB", "국내", "안전재고"]);
        } else if (state.apsCategories.has(value)) {
          if (state.apsCategories.size > 1) state.apsCategories.delete(value);
        } else {
          state.apsCategories.add(value);
        }
        applyApsRequirements();
        refreshButtons();
        render();
        window.lfpApplyDetailFilters?.(true);
      });
    });
    refreshButtons();
  }

  function selectionKey(itemCode, specification) {
    return `${String(itemCode || "").trim()}|${String(specification || "").trim()}`;
  }

  function selectionCountBadge() {
    const host = document.querySelector(".table-meta > div:first-child");
    if (!host) return null;
    let badge = host.querySelector(".lfp-selection-count");
    if (!badge) {
      badge = document.createElement("span");
      badge.className = "lfp-selection-count";
      host.appendChild(badge);
    }
    return badge;
  }

  function syncSelectionHeader() {
    const table = document.querySelector(".lfp-detail-table");
    const selectAll = table?.querySelector("[data-lfp-select-all]");
    if (!selectAll) return;
    const visible = [...table.querySelectorAll("tbody .lfp-row-select")]
      .filter((checkbox) => !checkbox.closest("tr")?.hidden && checkbox.closest("tr")?.style.display !== "none");
    const selectedVisible = visible.filter((checkbox) => checkbox.checked).length;
    selectAll.checked = visible.length > 0 && selectedVisible === visible.length;
    selectAll.indeterminate = selectedVisible > 0 && selectedVisible < visible.length;
    const badge = selectionCountBadge();
    if (badge) badge.textContent = `선택 ${state.selectedItems.size}건`;
    window.dispatchEvent(new CustomEvent("lfp:selection-change", {
      detail: { keys: [...state.selectedItems], count: state.selectedItems.size },
    }));
  }

  function clearSelection() {
    state.selectedItems.clear();
    document.querySelectorAll(".lfp-detail-table .lfp-row-select, .lfp-detail-table [data-lfp-select-all]")
      .forEach((checkbox) => {
        checkbox.checked = false;
        checkbox.indeterminate = false;
      });
    document.querySelectorAll(".lfp-detail-table tbody tr.is-selected")
      .forEach((row) => row.classList.remove("is-selected"));
    syncSelectionHeader();
  }

  function bindSelectionControls(tbody) {
    const table = tbody.closest("table");
    if (!table) return;

    if (table.dataset.lfpRowSelectionBound !== "true") {
      table.dataset.lfpRowSelectionBound = "true";
      const updateRowSelection = (event) => {
        const checkbox = event.target.closest?.(".lfp-row-select");
        if (!checkbox || !table.contains(checkbox)) return;
        const row = checkbox.closest("tr");
        if (checkbox.checked) state.selectedItems.add(checkbox.value);
        else state.selectedItems.delete(checkbox.value);
        row?.classList.toggle("is-selected", checkbox.checked);
        syncSelectionHeader();
      };
      table.addEventListener("input", updateRowSelection, true);
      table.addEventListener("change", updateRowSelection, true);
    }

    tbody.querySelectorAll("tr").forEach((row) => {
      if (row.cells.length < 3 || row.querySelector(".lfp-row-select")) return;
      const itemCode = row.dataset.itemCode || row.cells[0]?.textContent.trim();
      const specification = row.dataset.specification || row.cells[2]?.textContent.trim();
      if (!itemCode) return;
      const key = selectionKey(itemCode, specification);
      const cell = row.insertCell(0);
      cell.className = "lfp-select-cell";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.className = "lfp-row-select";
      checkbox.value = key;
      checkbox.checked = state.selectedItems.has(key);
      checkbox.setAttribute("aria-label", `${itemCode} 선택`);
      cell.appendChild(checkbox);
      row.classList.toggle("is-selected", checkbox.checked);
      checkbox.addEventListener("click", (event) => event.stopPropagation());
      checkbox.addEventListener("change", () => syncSelectionHeader());
    });

    const selectAll = table.querySelector("[data-lfp-select-all]");
    if (selectAll && !selectAll.dataset.bound) {
      selectAll.dataset.bound = "true";
      selectAll.addEventListener("change", () => {
        table.querySelectorAll("tbody .lfp-row-select").forEach((checkbox) => {
          const row = checkbox.closest("tr");
          if (row?.hidden || row?.style.display === "none") return;
          checkbox.checked = selectAll.checked;
          if (checkbox.checked) state.selectedItems.add(checkbox.value);
          else state.selectedItems.delete(checkbox.value);
          row?.classList.toggle("is-selected", checkbox.checked);
        });
        syncSelectionHeader();
      });
    }

    if (!table.dataset.selectionFilterSyncBound) {
      table.dataset.selectionFilterSyncBound = "true";
      document.addEventListener("click", () => setTimeout(syncSelectionHeader, 0), true);
      document.addEventListener("change", () => setTimeout(syncSelectionHeader, 0), true);
    }
    syncSelectionHeader();
  }

  window.lfpSelectedItemKeys = () => [...state.selectedItems];
  window.lfpSyncSelectionHeader = syncSelectionHeader;
  window.lfpClearSelection = clearSelection;

  function purchaseWaitingValues(itemCode, specification) {
    const values = window.lfpPurchaseWaitingValues?.(itemCode, specification) || {};
    return {
      inboundWaitQty: Number(values.inboundWaitQty || 0),
      purchaseWaitQty: Number(values.purchaseWaitQty || 0),
    };
  }

  function waitingCell(quantity) {
    const value = Number(quantity || 0);
    return `<td class="lfp-number" data-purchase-inbound-value="${value}">${value > 0 ? numberFormat.format(value) : "-"}</td>`;
  }

  function rowCells(
    _warehouseName,
    row,
    stockQty,
    inspectionWaitQty,
    productionRequiredQty = null,
    note = "",
    separatedWaitingColumns = false,
  ) {
    const metrics = planningMetrics(row.itemCode, row.specification, stockQty, inspectionWaitQty);
    const selectedProductionRequiredQty = Number(metrics.productionRequired ?? productionRequiredQty ?? 0);
    const hasProductionRequirement = selectedProductionRequiredQty > 0;
    const hasAverageUsage = Number(metrics.averageDailyUsage || 0) > 0;
    const waiting = purchaseWaitingValues(row.itemCode, row.specification);
    const waitingCells = separatedWaitingColumns
      ? `${waitingCell(waiting.inboundWaitQty)}${waitingCell(waiting.purchaseWaitQty)}`
      : waitingCell(waiting.purchaseWaitQty);
    return `
      <td>${escapeHtml(row.itemCode)}</td>
      <td class="lfp-item-name-cell" data-item-code="${escapeHtml(row.itemCode)}" data-item-spec="${escapeHtml(row.specification || "")}">${escapeHtml(row.itemName)}</td>
      <td>${escapeHtml(row.specification || "-")}</td>
      <td class="lfp-number">${numberFormat.format(stockQty)}</td>
      <td class="lfp-number ${inspectionWaitQty ? "lfp-inspection" : ""}">${numberFormat.format(inspectionWaitQty)}</td>
      ${waitingCells}
      <td class="lfp-number">${numberFormat.format(selectedProductionRequiredQty)}</td>
      <td class="lfp-availability-cell" title="${escapeHtml(metrics.availableTitle || "")}">${hasAverageUsage ? escapeHtml(metrics.availableLabel) : "-"}</td>
      <td>-</td>
      <td>-</td>
      <td class="lfp-risk-order-cell ${hasProductionRequirement && metrics.riskLabel !== "-" ? "has-risk" : ""}" data-item-code="${escapeHtml(row.itemCode)}" data-item-spec="${escapeHtml(row.specification || "")}">${hasProductionRequirement ? escapeHtml(metrics.riskLabel) : "-"}</td>
      <td class="lfp-muted ${escapeHtml(row.planningClass || "")}">${escapeHtml(note)}</td>
    `;
  }

  function render() {
    const table = findDetailTable();
    if (!table || !state.data) return;
    const tbody = table.tBodies[0] || table.appendChild(document.createElement("tbody"));
    const rows = filteredRows();
    const html = [];
    const separatedWaitingColumns = Boolean(
      table.querySelector('th[data-lfp-role="inbound-waiting"]')
      && table.querySelector('th[data-lfp-role="purchase-waiting"]'),
    );

    for (const row of rows) {
      if (state.warehouse) {
        const warehouse = row.warehouses.find((item) => item.warehouseCode === state.warehouse);
        html.push(`<tr>${rowCells(
          escapeHtml(warehouse.warehouseName), row, warehouse.stockQty,
          warehouse.inspectionWaitQty, row.productionRequiredQty,
          warehouse.inspectionWaitQty ? "검사대기 API 원본값 · APS 필요량은 전체 기준" : "APS 필요량은 전체 기준",
          separatedWaitingColumns,
        )}</tr>`);
        continue;
      }

      html.push(`<tr class="lfp-summary-row" data-item-code="${escapeHtml(row.itemCode)}">
        ${rowCells(
          "",
          row, row.stockQty, row.inspectionWaitQty, row.productionRequiredQty, row.planningNote,
          separatedWaitingColumns,
        )}
      </tr>`);
    }

    tbody.innerHTML = html.join("") || `<tr><td colspan="13" style="padding:48px;text-align:center;">조회 조건에 맞는 리드지가 없습니다.</td></tr>`;
    replaceText(/총\s*\d+건/, `총 ${rows.length}건`);
    bindSelectionControls(tbody);
    bindHoverPopovers(tbody);
    window.lfpDecoratePurchaseInbound?.();
    document.dispatchEvent(new CustomEvent("lfp:detail-rendered"));
  }

  function bindControls() {
    const controls = getControls();
    if (controls.warehouse) {
      controls.warehouse.innerHTML = [
        '<option value="">전체 창고</option>',
        ...state.data.warehouseOptions.map((item) =>
          `<option value="${escapeHtml(item.code)}">${escapeHtml(item.name)}</option>`
        ),
      ].join("");
      controls.warehouse.addEventListener("change", () => {
        state.warehouse = controls.warehouse.value;
        state.expanded.clear();
        render();
      });
    }
    controls.query?.addEventListener("click", () => {
      state.search = controls.search?.value || "";
      render();
    });
    controls.search?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        state.search = controls.search.value;
        render();
      }
    });
    controls.reset?.addEventListener("click", () => {
      state.search = "";
      state.warehouse = "";
      state.expanded.clear();
      if (controls.search) controls.search.value = "";
      if (controls.warehouse) controls.warehouse.value = "";
      render();
    });
  }

  async function init() {
    injectStyles();
    try {
      const [inventory, aps, bom, production] = await Promise.allSettled([
        window.LFPResources.json("data/lidding-inventory.json"),
        window.LFPResources.json("data/aps-lidding-requirement.json"),
        window.LFPResources.json("data/bom-product-lidding.json"),
        window.LFPResources.json("data/lidding-production-usage.json"),
      ]);
      if (inventory.status !== "fulfilled" || aps.status !== "fulfilled") {
        throw inventory.reason || aps.reason || new Error("필수 데이터를 불러오지 못했습니다.");
      }
      state.data = inventory.value;
      state.aps = aps.value;
      state.data.rows = Array.isArray(state.data.rows) ? state.data.rows : [];
      const inventoryKeys = new Set(state.data.rows.map((row) => `${row.itemCode}|${row.specification}`));
      for (const requirement of state.aps.rows || []) {
        const rowKey = `${requirement.liddingCode}|${requirement.liddingSpecification}`;
        if (inventoryKeys.has(rowKey)) continue;
        state.data.rows.push({
          itemCode: requirement.liddingCode,
          itemName: requirement.liddingName || "품명 미연결",
          specification: requirement.liddingSpecification,
          stockQty: 0,
          inspectionWaitQty: 0,
          warehouses: [],
          note: "APS 요구량 존재 · 재고 마스터 미연결",
        });
        inventoryKeys.add(rowKey);
      }
      state.data.rows.sort((left, right) => String(left.itemCode).localeCompare(String(right.itemCode))
        || String(left.specification).localeCompare(String(right.specification)));
      state.data.itemCount = state.data.rows.length;
      if (bom.status === "fulfilled") buildProductMaps(bom.value);
      if (production.status === "fulfilled") {
        state.productionUsage = production.value;
        state.productionUsageMap = new Map((state.productionUsage.rows || []).map((row) => [
          `${row.itemCode}|${row.specification}`,
          row,
        ]));
      }
      state.requirementMap = new Map(state.aps.rows.map((row) => [`${row.liddingCode}|${row.liddingSpecification}`, row]));
      applyApsRequirements();
      const detailTable = findDetailTable();
      const usageHeader = [...(detailTable?.querySelectorAll("th") || [])].find((cell) => cell.textContent.trim() === "사용량 환산");
      if (usageHeader) usageHeader.textContent = "APS 생산필요";
      mountApsFilter();
      bindControls();
      render();
      replaceText(/리드지 데이터 연결 대기/g, `리드지 재고 ${state.data.itemCount}품목 · APS ${state.aps.liddingRequirementCount}품목 연결`);
      replaceText(/데이터 연결 준비/g, `재고 기준 ${state.data.snapshotDate}`);
    } catch (error) {
      console.error("리드지 재고 데이터 로드 실패", error);
      replaceText(/리드지 데이터 연결 대기/g, "리드지 재고 데이터 로드 실패");
    }
  }

  document.readyState === "loading"
    ? document.addEventListener("DOMContentLoaded", init)
    : init();
})();
