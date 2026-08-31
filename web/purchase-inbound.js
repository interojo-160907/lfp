(function () {
  "use strict";

  const DATA_URL = "data/lidding-purchase-inbound.json";
  const state = { inboundMap: new Map(), loaded: false, scheduled: false, hideTimer: null };

  function text(element) {
    return (element?.textContent || "").replace(/\s+/g, " ").trim();
  }

  function key(itemCode, specification) {
    return `${String(itemCode || "").trim().toUpperCase()}|${String(specification || "").trim().toUpperCase()}`;
  }

  function number(value) {
    const parsed = Number(String(value || "").replace(/[^0-9.-]/g, ""));
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function format(value) {
    return Math.round(Number(value || 0)).toLocaleString("ko-KR");
  }

  function formatShortDate(value) {
    const matched = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!matched) return value || "-";
    return `${Number(matched[2])}/${Number(matched[3])}`;
  }

  function waitingValues(itemCode, specification) {
    const purchase = state.inboundMap.get(key(itemCode, specification));
    return {
      inboundWaitQty: Number(purchase?.inboundWaitQty || 0),
      purchaseWaitQty: Number(purchase?.purchaseWaitQty || 0),
    };
  }

  function setCell(cell, value, marker) {
    if (!cell || cell.dataset.purchaseInboundValue === marker) return;
    cell.textContent = value;
    cell.dataset.purchaseInboundValue = marker;
  }

  function markDetailCell(cell, purchaseKey, kind, quantity) {
    if (!cell) return;
    if (number(quantity) <= 0) {
      cell.classList.remove("lfp-purchase-detail");
      delete cell.dataset.purchaseKey;
      delete cell.dataset.purchaseKind;
      return;
    }
    if (!cell.classList.contains("lfp-purchase-detail")) cell.classList.add("lfp-purchase-detail");
    if (cell.dataset.purchaseKey !== purchaseKey) cell.dataset.purchaseKey = purchaseKey;
    if (cell.dataset.purchaseKind !== kind) cell.dataset.purchaseKind = kind;
  }

  function setPurchaseNote(cell, value, marker, quantity = 0, title = "") {
    if (!cell) return;

    Array.from(cell.childNodes).forEach((node) => {
      if (node.nodeType === Node.TEXT_NODE) node.remove();
    });

    let status = cell.querySelector(".lfp-auto-purchase-note");
    if (!value || quantity <= 0) {
      status?.remove();
      delete cell.dataset.lfpAutoPurchaseStatus;
      delete cell.dataset.lfpRecommendedOrderQuantity;
      cell.dataset.purchaseInboundValue = marker;
      return;
    }

    if (!status) {
      status = document.createElement("span");
      status.className = "lfp-auto-purchase-note lfp-status-buy";
      cell.prepend(status);
    }
    status.textContent = value;
    status.title = title;
    cell.dataset.lfpAutoPurchaseStatus = "risk";
    cell.dataset.lfpRecommendedOrderQuantity = String(quantity);
    cell.dataset.purchaseInboundValue = marker;
  }

  function decorateRow(row, indexes) {
    const cells = Array.from(row.cells || []);
    const itemCode = text(cells[indexes.itemCode]);
    const specification = text(cells[indexes.specification]);
    if (!/^BS\d+/i.test(itemCode) || !specification) return;

    const purchase = state.inboundMap.get(key(itemCode, specification));
    const inboundWait = purchase ? Number(purchase.inboundWaitQty || 0) : 0;
    const purchaseWait = purchase ? Number(purchase.purchaseWaitQty || 0) : 0;
    const stock = number(text(cells[indexes.stock]));
    const inspectionWait = number(text(cells[indexes.inspectionWait]));
    const productionRequired = number(text(cells[indexes.productionRequired]));
    const securedQuantity = stock + inspectionWait + inboundWait + purchaseWait;
    const targetQuantity = Math.ceil(productionRequired * 1.5);
    const shortageQuantity = Math.max(targetQuantity - securedQuantity, 0);
    const recommendedOrderQuantity = shortageQuantity > 0
      ? Math.max(20000, Math.ceil(shortageQuantity / 5000) * 5000)
      : 0;

    setCell(cells[indexes.inboundWait], inboundWait > 0 ? format(inboundWait) : "-", String(inboundWait));
    setCell(cells[indexes.purchaseWait], purchaseWait > 0 ? format(purchaseWait) : "-", String(purchaseWait));
    const purchaseKey = key(itemCode, specification);
    markDetailCell(cells[indexes.inboundWait], purchaseKey, "inbound", inboundWait);
    markDetailCell(cells[indexes.purchaseWait], purchaseKey, "purchaseWaiting", purchaseWait);
    if (purchase) {
      cells[indexes.inboundWait].title = [
        `유효 발주 ${purchase.openPurchaseOrderCount || 0}건`,
        `발주 ${format(purchase.purchaseOrderQty)}`,
        `가입고 ${format(purchase.provisionalReceiptQty)}`,
        `미납 ${format(inboundWait)}`,
      ].join(" · ");
      cells[indexes.purchaseWait].title = [
        `미발주 의뢰 ${purchase.openRequestCount || 0}건`,
        `의뢰 ${format(purchase.requestQty)}`,
        `발주누계 ${format(purchase.requestPurchaseOrderQty)}`,
        `미발주 ${format(purchaseWait)}`,
      ].join(" · ");
      setCell(
        cells[indexes.requestDate],
        formatShortDate(purchase.nextDeliveryDate),
        purchase.nextDeliveryDate || "-"
      );
      setCell(cells[indexes.deliveryDate], "-", "-");
      cells[indexes.requestDate].classList.add("lfp-purchase-date");
      cells[indexes.requestDate].dataset.purchaseKey = purchaseKey;
      cells[indexes.requestDate].dataset.purchaseKind = "all";
      cells[indexes.requestDate].dataset.purchaseCount = String(purchase.openRequestCount || 0);
    }

    const noteCell = cells[indexes.note];
    if (!noteCell) return;
    noteCell.classList.remove("lfp-status-ok", "lfp-status-wait", "lfp-status-buy", "lfp-status-inbound");

    if (productionRequired <= 0 || recommendedOrderQuantity <= 0) {
      setPurchaseNote(noteCell, "", `blank|${productionRequired}|${securedQuantity}`);
      row.dataset.ctStatus = productionRequired > 0 ? "ok" : "none";
      return;
    }

    const statusText = `구매 필요 ${format(recommendedOrderQuantity)}`;
    const calculationTitle = [
      `1.5배 목표 ${format(targetQuantity)}`,
      `확보 합계 ${format(securedQuantity)}`,
      `산출 부족 ${format(shortageQuantity)}`,
      `MOQ 20,000 · 5,000 단위 올림`,
    ].join(" · ");
    setPurchaseNote(
      noteCell,
      statusText,
      `lfp-status-buy|${statusText}`,
      recommendedOrderQuantity,
      calculationTitle
    );
    row.dataset.ctStatus = "risk";
  }

  function decorateTable(table) {
    const headerRow = Array.from(table.querySelectorAll("thead tr")).find((row) => {
      const labels = Array.from(row.cells || []).map(text);
      return labels.some((value) => value.includes("품목코드"))
        && labels.some((value) => value.includes("발주대기"));
    });
    const headers = Array.from(headerRow?.cells || []);
    const names = headers.map(text);
    const indexOf = (name) => names.findIndex((value) => value.includes(name));
    const indexes = {
      itemCode: indexOf("품목코드"),
      specification: indexOf("규격"),
      stock: indexOf("재고"),
      inspectionWait: indexOf("검사대기"),
      inboundWait: indexOf("입고대기"),
      purchaseWait: indexOf("발주대기"),
      productionRequired: indexOf("APS 생산필요"),
      requestDate: indexOf("납기요청일"),
      deliveryDate: indexOf("납기확정일"),
      note: indexOf("비고"),
    };
    if (Object.values(indexes).some((value) => value < 0)) return;
    table.querySelectorAll("tbody tr").forEach((row) => decorateRow(row, indexes));
  }

  function decorate() {
    if (!state.loaded) return;
    document.querySelectorAll("table").forEach(decorateTable);
    document.dispatchEvent(new CustomEvent("lfp:purchase-status-updated"));
  }

  window.lfpPurchaseWaitingValues = waitingValues;
  window.lfpDecoratePurchaseInbound = decorate;

  function schedule() {
    if (state.scheduled) return;
    state.scheduled = true;
    requestAnimationFrame(() => {
      state.scheduled = false;
      decorate();
    });
  }

  function scheduleAfterFilterChange() {
    schedule();
    setTimeout(schedule, 100);
    setTimeout(schedule, 350);
  }

  function getPopover() {
    let popover = document.getElementById("lfp-purchase-popover");
    if (popover) return popover;
    popover = document.createElement("div");
    popover.id = "lfp-purchase-popover";
    popover.className = "lfp-purchase-popover";
    popover.setAttribute("role", "tooltip");
    document.body.appendChild(popover);
    return popover;
  }

  function showPurchasePopover(cell) {
    const purchase = state.inboundMap.get(cell.dataset.purchaseKey || "");
    if (!purchase) return;
    clearTimeout(state.hideTimer);
    const kind = cell.dataset.purchaseKind || "all";
    const events = [];
    if (kind === "purchaseWaiting" || kind === "all") {
      (purchase.requests || []).forEach((request) => {
        if (number(request.purchaseWaitQty) <= 0) return;
        events.push({
          requestNo: request.requestNo || "구매의뢰번호 없음",
          orderNo: "미발주",
          status: "발주대기",
          date: request.requestedDeliveryDate,
          quantity: request.purchaseWaitQty,
        });
      });
    }
    if (kind === "inbound" || kind === "all") {
      (purchase.purchaseOrders || []).forEach((order) => {
        if (number(order.inboundWaitQty) <= 0) return;
        events.push({
          requestNo: order.requestNo || "구매의뢰번호 없음",
          orderNo: order.purchaseOrderNo || "발주번호 없음",
          status: order.orderStatus || "입고대기",
          date: order.deliveryDate,
          quantity: order.inboundWaitQty,
        });
      });
    }
    events.sort((left, right) =>
      String(left.date || "9999-12-31").localeCompare(String(right.date || "9999-12-31"))
    );
    if (!events.length) return;
    const popover = getPopover();
    popover.replaceChildren();
    const title = document.createElement("div");
    title.className = "lfp-purchase-popover-title";
    title.textContent = `${purchase.itemCode || ""} ${kind === "inbound" ? "입고대기" : kind === "purchaseWaiting" ? "발주대기" : "구매 대기"} 상세 ${events.length}건`;
    popover.append(title);
    const head = document.createElement("div");
    head.className = "lfp-purchase-popover-head";
    ["구매의뢰번호", "발주번호 · 상태", "납기", "대기수량"].forEach((label) => {
      const item = document.createElement("span");
      item.textContent = label;
      head.append(item);
    });
    popover.append(head);
    const list = document.createElement("div");
    list.className = "lfp-purchase-popover-list";
    events.forEach((event) => {
      const row = document.createElement("div");
      row.className = "lfp-purchase-popover-row";
      [event.requestNo, `${event.orderNo} · ${event.status}`, formatShortDate(event.date), format(event.quantity)].forEach((value) => {
        const item = document.createElement("span");
        item.textContent = value || "-";
        row.append(item);
      });
      list.append(row);
    });
    popover.append(list);
    popover.classList.add("is-visible");

    const cellRect = cell.getBoundingClientRect();
    const popoverRect = popover.getBoundingClientRect();
    const left = Math.min(Math.max(12, cellRect.left), window.innerWidth - popoverRect.width - 12);
    const belowTop = cellRect.bottom + 7;
    const top = belowTop + popoverRect.height <= window.innerHeight - 12
      ? belowTop
      : Math.max(12, cellRect.top - popoverRect.height - 7);
    popover.style.left = `${left}px`;
    popover.style.top = `${top}px`;
  }

  function hidePurchasePopover() {
    clearTimeout(state.hideTimer);
    document.getElementById("lfp-purchase-popover")?.classList.remove("is-visible");
  }

  function scheduleHidePurchasePopover() {
    clearTimeout(state.hideTimer);
    state.hideTimer = setTimeout(hidePurchasePopover, 260);
  }

  function loadPurchaseData() {
    fetch(`${DATA_URL}?v=${Date.now()}`, { cache: "no-store" })
      .then((response) => {
        if (!response.ok) throw new Error(`구매 데이터 로드 실패: ${response.status}`);
        return response.json();
      })
      .then((payload) => {
        state.inboundMap.clear();
        (payload.items || []).forEach((item) => state.inboundMap.set(key(item.itemCode, item.specification), item));
        state.loaded = true;
        scheduleAfterFilterChange();
      })
      .catch((error) => console.error(error));
  }

  loadPurchaseData();
  window.setInterval(loadPurchaseData, 60000);

  document.addEventListener("mouseover", (event) => {
    const cell = event.target.closest(".lfp-purchase-detail[data-purchase-key], .lfp-purchase-date[data-purchase-key]");
    if (cell) showPurchasePopover(cell);
  });
  document.addEventListener("mouseout", (event) => {
    const cell = event.target.closest(".lfp-purchase-detail[data-purchase-key], .lfp-purchase-date[data-purchase-key]");
    if (cell && !cell.contains(event.relatedTarget)) scheduleHidePurchasePopover();
  });
  document.addEventListener("click", (event) => {
    if (event.target.closest("button")) scheduleAfterFilterChange();
  });
  document.addEventListener("change", scheduleAfterFilterChange);
  window.addEventListener("scroll", hidePurchasePopover, true);
  window.addEventListener("resize", hidePurchasePopover);
  document.addEventListener("mouseenter", (event) => {
    if (event.target.closest?.("#lfp-purchase-popover")) clearTimeout(state.hideTimer);
  }, true);
  document.addEventListener("mouseleave", (event) => {
    if (event.target.closest?.("#lfp-purchase-popover")) scheduleHidePurchasePopover();
  }, true);

  new MutationObserver(schedule).observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
  });
})();
