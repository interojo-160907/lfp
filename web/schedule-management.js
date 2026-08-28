(() => {
  "use strict";

  const API = "api/delivery-management";
  const PURCHASE_DATA_URL = "data/lidding-purchase-inbound.json";
  const state = {
    records: new Map(), scheduled: false, lastReset: "", noteOnly: false,
    noteHoverTimer: null, purchaseItems: new Map(),
  };
  const text = (value) => String(value == null ? "" : value).trim();
  const normalized = (value) => text(value).replace(/\s+/g, " ").toLowerCase();
  const numberValue = (value) => {
    const parsed = Number(text(value).replace(/,/g, ""));
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const itemKey = (code, spec) => `${text(code).toUpperCase()}|${text(spec).toUpperCase()}`;

  function findTable() {
    return Array.from(document.querySelectorAll("table")).find((table) => {
      const value = normalized(table.tHead?.textContent);
      return value.includes("품목코드") && value.includes("입고대기") && value.includes("발주대기");
    }) || null;
  }

  function descriptor(table) {
    const header = Array.from(table.tHead?.rows || []).find((row) => {
      const value = normalized(row.textContent);
      return !row.classList.contains("lfp-detail-filter-row") && value.includes("품목코드") && value.includes("비고");
    });
    if (!header) return null;
    const headers = Array.from(header.cells);
    const find = (label) => headers.findIndex((cell) => normalized(cell.textContent).includes(normalized(label)));
    return {
      header,
      columns: {
        code: find("품목코드"), name: find("품목명"), spec: find("규격"),
        inbound: find("입고대기"), purchase: find("발주대기"),
        requested: find("납기요청일"), confirmed: find("납기확정일"),
        riskOrder: find("리스크 수주"), note: find("비고"),
      },
    };
  }

  function tableRows() {
    const table = findTable();
    const info = table && descriptor(table);
    if (!table || !info) return [];
    return Array.from(table.tBodies).flatMap((body) => Array.from(body.rows)).map((row) => {
      const cell = (column) => text(row.cells[column]?.textContent);
      const value = {
        element: row,
        itemCode: cell(info.columns.code),
        itemName: cell(info.columns.name),
        spec: cell(info.columns.spec),
        inboundWaiting: numberValue(cell(info.columns.inbound)),
        purchaseWaiting: numberValue(cell(info.columns.purchase)),
        requestedDate: cell(info.columns.requested).replace(/^[-]$/, ""),
        confirmedDate: cell(info.columns.confirmed).replace(/^[-]$/, ""),
        riskOrderDate: cell(info.columns.riskOrder).replace(/^[-]$/, ""),
        noteCell: row.cells[info.columns.note],
        confirmedCell: row.cells[info.columns.confirmed],
      };
      value.key = itemKey(value.itemCode, value.spec);
      return value;
    }).filter((row) => row.itemCode);
  }

  function historyText(record) {
    return Array.isArray(record?.history) ? record.history.map((entry) => `${formatTime(entry.at)} ${entry.text}`).join("\n") : "";
  }

  function formatTime(value) {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return text(value);
    return new Intl.DateTimeFormat("ko-KR", {
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
    }).format(parsed);
  }

  async function post(path, payload) {
    const response = await fetch(`${API}/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ok) throw new Error(result.detail || result.error || "처리하지 못했습니다.");
    return result;
  }

  async function loadRecords() {
    try {
      const response = await fetch(API, { cache: "no-store" });
      const result = await response.json();
      state.records = new Map((result.records || []).map((record) => [itemKey(record.itemCode, record.spec), record]));
      scheduleDecorate();
    } catch (_) {
      state.records = new Map();
    }
  }

  async function loadPurchaseItems() {
    try {
      const response = await fetch(`${PURCHASE_DATA_URL}?v=${Date.now()}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const result = await response.json();
      state.purchaseItems = new Map((result.items || []).map((item) => [
        itemKey(item.itemCode, item.specification), item,
      ]));
    } catch (_) {
      state.purchaseItems = new Map();
    }
  }

  function purchaseIdentifiers(row) {
    const purchase = state.purchaseItems.get(row.key) || {};
    const requestNos = new Set();
    const orderNos = new Set();
    (purchase.requests || []).forEach((item) => {
      if (text(item.requestNo)) requestNos.add(text(item.requestNo));
    });
    (purchase.purchaseOrders || []).forEach((item) => {
      if (text(item.requestNo)) requestNos.add(text(item.requestNo));
      if (text(item.purchaseOrderNo)) orderNos.add(text(item.purchaseOrderNo));
    });
    return { requestNos: [...requestNos].sort(), orderNos: [...orderNos].sort() };
  }

  function removeNoteFilter(table, info) {
    const filterRow = table.tHead?.querySelector(".lfp-detail-filter-row");
    const cell = filterRow?.cells[info.columns.note];
    if (cell && cell.childNodes.length) cell.replaceChildren();
  }

  async function reconcileCompleted(rows) {
    const keys = rows.filter((row) => state.records.has(row.key)
      && row.inboundWaiting <= 0 && row.purchaseWaiting <= 0).map((row) => row.key).sort();
    const signature = keys.join(";");
    if (!keys.length || signature === state.lastReset) return;
    state.lastReset = signature;
    try {
      await post("reconcile", { keys });
      keys.forEach((key) => state.records.delete(key));
      scheduleDecorate();
    } catch (_) {
      state.lastReset = "";
    }
  }

  function decorate() {
    const table = findTable();
    const info = table && descriptor(table);
    if (!table || !info) return;
    removeNoteFilter(table, info);
    const rows = tableRows();
    let historyCount = 0;
    rows.forEach((row) => {
      const record = state.records.get(row.key);
      const hasHistory = Boolean(record?.history?.length);
      const hasPurchaseNeed = numberValue(row.noteCell?.dataset.lfpRecommendedOrderQuantity) > 0
        || Boolean(row.noteCell?.querySelector(".lfp-auto-purchase-note"));
      const hasRiskOrder = Boolean(row.riskOrderDate);
      const hasVisibleNote = hasPurchaseNeed || hasRiskOrder || hasHistory;
      const isScheduleManaged = row.inboundWaiting > 0 || row.purchaseWaiting > 0;
      const noteEnabled = isScheduleManaged || hasRiskOrder || hasHistory;
      if (hasVisibleNote) historyCount += 1;
      if (record?.confirmedDate && row.confirmedCell && text(row.confirmedCell.textContent) !== record.confirmedDate) {
        row.confirmedCell.textContent = record.confirmedDate;
      }
      if (!row.noteCell) return;
      row.noteCell.classList.toggle("lfp-note-cell", noteEnabled);
      row.noteCell.dataset.lfpHistoryCount = String(record?.history?.length || 0);
      row.noteCell.classList.toggle("has-history", hasHistory);
      row.element.classList.toggle("lfp-has-notes", hasVisibleNote);
      let riskNote = row.noteCell.querySelector(".lfp-auto-risk-note");
      if (hasRiskOrder) {
        if (!riskNote) {
          riskNote = document.createElement("span");
          riskNote.className = "lfp-auto-risk-note";
          row.noteCell.appendChild(riskNote);
        }
        riskNote.textContent = "리스크 수주 있음";
        riskNote.title = `최초 미커버 수주일 ${row.riskOrderDate}`;
      } else {
        riskNote?.remove();
      }
      let openButton = row.noteCell.querySelector(".lfp-note-open-button");
      if (!noteEnabled) {
        openButton?.remove();
        delete row.noteCell.dataset.lfpNoteKey;
        if (!row.noteCell.querySelector(".lfp-auto-purchase-note")) row.noteCell.removeAttribute("title");
        return;
      }
      row.noteCell.dataset.lfpNoteKey = row.key;
      row.noteCell.title = hasHistory ? "클릭하여 비고 이력 전체 보기" : "클릭하여 비고 입력";
      if (!openButton) {
        openButton = document.createElement("button");
        openButton.type = "button";
        openButton.className = "lfp-note-open-button";
        row.noteCell.appendChild(openButton);
      }
      const history = Array.isArray(record?.history) ? record.history : [];
      const latestNote = history.slice().reverse().find((entry) => entry.type === "note");
      const latestDate = history.slice().reverse().find((entry) => entry.type === "date");
      const priorityEntry = latestNote || latestDate;
      openButton.textContent = hasPurchaseNeed || !priorityEntry
        ? ""
        : text(priorityEntry.text).split(/\r?\n/)[0];
      openButton.setAttribute("aria-label", hasHistory ? "비고 이력 전체 보기" : "비고 입력");
    });
    ensureNoteHeaderButton(table, info, historyCount);
    reconcileCompleted(rows);
  }

  function ensureNoteHeaderButton(table, info, historyCount) {
    const cell = info.header.cells[info.columns.note];
    if (!cell) return;
    let button = cell.querySelector(".lfp-note-header-button");
    if (!button) {
      cell.replaceChildren();
      button = document.createElement("button");
      button.type = "button";
      button.className = "lfp-note-header-button";
      button.addEventListener("click", () => {
        window.lfpSetNoteFilter?.(!state.noteOnly);
      });
      cell.appendChild(button);
    }
    button.innerHTML = `<span>비고</span><small>${historyCount.toLocaleString("ko-KR")}건</small>`;
    button.classList.toggle("is-active", state.noteOnly);
    table.classList.toggle("lfp-note-filter-active", state.noteOnly);
  }

  window.lfpSetNoteFilter = (active, refresh = true) => {
    state.noteOnly = Boolean(active);
    const table = findTable();
    const button = table?.querySelector(".lfp-note-header-button");
    table?.classList.toggle("lfp-note-filter-active", state.noteOnly);
    button?.classList.toggle("is-active", state.noteOnly);
    button?.setAttribute("aria-pressed", String(state.noteOnly));
    if (refresh) window.lfpApplyDetailFilters?.();
  };

  function scheduleDecorate() {
    if (state.scheduled) return;
    state.scheduled = true;
    requestAnimationFrame(() => {
      state.scheduled = false;
      bindScheduleButton();
      decorate();
    });
  }

  function pendingRows() {
    return tableRows().filter((row) => row.inboundWaiting > 0 || row.purchaseWaiting > 0).map((row) => {
      const record = state.records.get(row.key);
      const identifiers = purchaseIdentifiers(row);
      return {
        itemCode: row.itemCode,
        itemName: row.itemName,
        spec: row.spec,
        inboundWaiting: row.inboundWaiting,
        purchaseWaiting: row.purchaseWaiting,
        requestedDate: row.requestedDate,
        confirmedDate: record?.confirmedDate || row.confirmedDate,
        notes: historyText(record),
        requestNos: identifiers.requestNos,
        orderNos: identifiers.orderNos,
      };
    });
  }

  async function downloadList(button) {
    const rows = pendingRows();
    if (!rows.length) {
      window.alert("입고대기 또는 발주대기가 남은 품목이 없습니다.");
      return;
    }
    const original = button.textContent;
    button.disabled = true;
    button.textContent = "생성 중";
    try {
      const result = await post("export", { rows });
      window.alert(`${result.count.toLocaleString("ko-KR")}건 저장 완료\n${result.path}`);
    } catch (error) {
      window.alert(error?.message || "납기관리 리스트를 저장하지 못했습니다.");
    } finally {
      button.disabled = false;
      button.textContent = original;
    }
  }

  function excelDate(value) {
    if (typeof value === "number" && Number.isFinite(value) && window.XLSX?.SSF?.parse_date_code) {
      const parsed = window.XLSX.SSF.parse_date_code(value);
      if (parsed) value = new Date(parsed.y, parsed.m - 1, parsed.d);
    }
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
      const year = value.getFullYear();
      const month = String(value.getMonth() + 1).padStart(2, "0");
      const day = String(value.getDate()).padStart(2, "0");
      return `${year}-${month}-${day}`;
    }
    const source = text(value).replace(/\s.*$/, "").replace(/[년월]/g, "-").replace(/일/g, "").replace(/[.\/]/g, "-");
    let match = source.match(/^(20\d{2})-(\d{1,2})-(\d{1,2})$/);
    if (!match) {
      const compact = source.replace(/-/g, "");
      if (/^20\d{6}$/.test(compact)) match = [compact, compact.slice(0, 4), compact.slice(4, 6), compact.slice(6, 8)];
    }
    if (!match) {
      const short = source.match(/^(\d{1,2})-(\d{1,2})$/);
      if (short) match = [source, String(new Date().getFullYear()), short[1], short[2]];
    }
    if (!match) return "";
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const parsed = new Date(year, month - 1, day);
    if (parsed.getFullYear() !== year || parsed.getMonth() !== month - 1 || parsed.getDate() !== day) return "";
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }

  async function uploadUpdate(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = "";
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
    }
    const result = await post("import", {
      filename: file.name,
      contentBase64: btoa(binary),
    });
    localStorage.removeItem("lfp-delivery-confirmations-v1");
    const summary = [
      `변경 ${result.updated || 0}건`,
      `비고 ${result.noted || 0}건`,
      `동일 ${result.unchanged || 0}건`,
      `공란 ${result.blank || 0}건`,
      `취소선 제외 ${result.struck || 0}건`,
      `미연결 ${result.unmatched || 0}건`,
      `충돌 ${result.conflicts || 0}건`,
    ].join(" · ");
    window.alert(`${result.formatLabel || "납기 파일"}: ${summary}`);
    if ((result.updated || 0) + (result.noted || 0) > 0) window.location.reload();
  }

  function ensureScheduleMenu(button) {
    const toolbar = button.closest(".lfp-detail-toolbar");
    let menu = toolbar?.querySelector(".lfp-schedule-menu");
    if (menu) return menu;
    menu = document.createElement("div");
    menu.className = "lfp-schedule-menu";
    const download = document.createElement("button");
    download.type = "button";
    download.textContent = "리스트 다운로드";
    download.addEventListener("click", () => downloadList(download));
    const update = document.createElement("button");
    update.type = "button";
    update.textContent = "확정일 업데이트";
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".xlsx,.xlsm";
    input.hidden = true;
    update.addEventListener("click", () => input.click());
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        await uploadUpdate(file);
      } catch (error) {
        window.alert(error?.message || "확정일을 업데이트하지 못했습니다.");
      } finally {
        input.value = "";
      }
    });
    menu.append(download, update, input);
    toolbar?.appendChild(menu);
    return menu;
  }

  function bindScheduleButton() {
    const button = document.querySelector(".lfp-schedule-button");
    if (!button || button.dataset.lfpBound) return;
    button.dataset.lfpBound = "true";
    button.disabled = false;
    button.title = "납기관리 리스트 다운로드 또는 확정일 업데이트";
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      ensureScheduleMenu(button).classList.toggle("is-open");
    });
  }

  function ensureNotesModal() {
    let modal = document.querySelector(".lfp-notes-modal");
    if (modal) return modal;
    modal = document.createElement("div");
    modal.className = "lfp-notes-modal";
    modal.innerHTML = `
      <div class="lfp-notes-dialog" role="dialog" aria-modal="true" aria-labelledby="lfp-notes-title">
        <header><div><strong id="lfp-notes-title">비고 이력</strong><span data-lfp-note-item></span></div><button type="button" data-lfp-note-close aria-label="닫기">×</button></header>
        <div class="lfp-notes-history" data-lfp-note-history></div>
        <div class="lfp-notes-compose"><textarea rows="3" maxlength="1000" placeholder="새 비고 내용을 입력하세요"></textarea><button type="button" data-lfp-note-save>비고 추가</button></div>
      </div>`;
    document.body.appendChild(modal);
    modal.addEventListener("click", (event) => {
      if (event.target === modal || event.target.closest("[data-lfp-note-close]")) modal.classList.remove("is-open");
    });
    return modal;
  }

  function ensureNoteHover() {
    let hover = document.querySelector(".lfp-note-hover");
    if (hover) return hover;
    hover = document.createElement("div");
    hover.className = "lfp-note-hover";
    hover.innerHTML = '<header data-lfp-hover-title></header><div data-lfp-hover-history></div>';
    hover.addEventListener("mouseenter", () => window.clearTimeout(state.noteHoverTimer));
    hover.addEventListener("mouseleave", scheduleHideNoteHover);
    document.body.appendChild(hover);
    return hover;
  }

  function hideNoteHover() {
    window.clearTimeout(state.noteHoverTimer);
    document.querySelector(".lfp-note-hover")?.classList.remove("is-open");
  }

  function scheduleHideNoteHover() {
    window.clearTimeout(state.noteHoverTimer);
    state.noteHoverTimer = window.setTimeout(hideNoteHover, 260);
  }

  function showNoteHover(cell) {
    const record = state.records.get(cell.dataset.lfpNoteKey);
    if (!record?.history?.length) return;
    window.clearTimeout(state.noteHoverTimer);
    const hover = ensureNoteHover();
    hover.querySelector("[data-lfp-hover-title]").textContent = `${record.itemCode} / ${record.spec} · 비고 ${record.history.length}건`;
    const history = hover.querySelector("[data-lfp-hover-history]");
    history.replaceChildren();
    record.history.slice().reverse().forEach((entry) => {
      const item = document.createElement("div");
      item.className = `lfp-note-hover-item is-${entry.type || "note"}`;
      const time = document.createElement("time");
      time.textContent = formatTime(entry.at);
      const content = document.createElement("p");
      content.textContent = text(entry.text);
      item.append(time, content);
      history.appendChild(item);
    });
    hover.classList.add("is-open");
    const rect = cell.getBoundingClientRect();
    const width = Math.min(430, window.innerWidth - 24);
    hover.style.width = `${width}px`;
    const left = Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12));
    let top = rect.bottom + 6;
    if (top + 300 > window.innerHeight) top = Math.max(12, rect.top - 286);
    hover.style.left = `${left}px`;
    hover.style.top = `${top}px`;
  }

  function renderHistory(modal, record) {
    const host = modal.querySelector("[data-lfp-note-history]");
    const history = Array.isArray(record?.history) ? record.history : [];
    host.replaceChildren();
    if (!history.length) {
      const empty = document.createElement("p");
      empty.className = "lfp-notes-empty";
      empty.textContent = "등록된 비고 이력이 없습니다.";
      host.appendChild(empty);
      return;
    }
    history.slice().reverse().forEach((entry) => {
      const item = document.createElement("div");
      item.className = `lfp-note-history-item is-${entry.type || "note"}`;
      const time = document.createElement("time");
      time.textContent = formatTime(entry.at);
      const content = document.createElement("p");
      content.textContent = text(entry.text);
      item.append(time, content);
      host.appendChild(item);
    });
  }

  function openNotes(row) {
    const modal = ensureNotesModal();
    const record = state.records.get(row.key);
    modal.dataset.key = row.key;
    modal.querySelector("[data-lfp-note-item]").textContent = `${row.itemCode} / ${row.spec}`;
    const textarea = modal.querySelector("textarea");
    textarea.value = "";
    renderHistory(modal, record);
    const save = modal.querySelector("[data-lfp-note-save]");
    save.onclick = async () => {
      const note = text(textarea.value);
      if (!note) return;
      save.disabled = true;
      try {
        const result = await post("note", { itemCode: row.itemCode, spec: row.spec, note });
        state.records.set(row.key, result.record);
        textarea.value = "";
        renderHistory(modal, result.record);
        scheduleDecorate();
      } catch (error) {
        window.alert(error?.message || "비고를 저장하지 못했습니다.");
      } finally {
        save.disabled = false;
      }
    };
    modal.classList.add("is-open");
    window.setTimeout(() => textarea.focus(), 0);
  }

  function installEvents() {
    document.addEventListener("click", (event) => {
      if (!event.target.closest(".lfp-schedule-menu, .lfp-schedule-button")) {
        document.querySelector(".lfp-schedule-menu")?.classList.remove("is-open");
      }
      const cell = event.target.closest("td.lfp-note-cell");
      if (!cell) return;
      const row = tableRows().find((entry) => entry.key === cell.dataset.lfpNoteKey);
      if (row) openNotes(row);
    });
    document.addEventListener("mouseover", (event) => {
      const cell = event.target.closest("td.lfp-note-cell.has-history");
      if (!cell || cell.contains(event.relatedTarget)) return;
      showNoteHover(cell);
    });
    document.addEventListener("mouseout", (event) => {
      const cell = event.target.closest("td.lfp-note-cell.has-history");
      if (!cell || cell.contains(event.relatedTarget)) return;
      scheduleHideNoteHover();
    });
    document.addEventListener("scroll", (event) => {
      if (event.target instanceof Element && event.target.closest(".lfp-note-hover")) return;
      hideNoteHover();
    }, true);
  }

  async function init() {
    installEvents();
    await Promise.allSettled([loadRecords(), loadPurchaseItems()]);
    bindScheduleButton();
    new MutationObserver(scheduleDecorate).observe(document.body, { childList: true, subtree: true, characterData: true });
    scheduleDecorate();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, { once: true });
  else init();
})();
