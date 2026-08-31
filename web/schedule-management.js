(() => {
  "use strict";

  const SCHEDULE_DATA_URL = "data/lidding-delivery-management.json";
  const RELAY_URL = "https://lfp-schedule-relay.hwh2404.workers.dev";
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

  function schedulePassword(forcePrompt = false) {
    if (!forcePrompt) {
      const stored = sessionStorage.getItem("lfp-schedule-password");
      if (stored) return stored;
    }
    const entered = window.prompt("일정 관리 업데이트 비밀번호를 입력하세요.");
    if (!entered) throw new Error("업데이트가 취소되었습니다.");
    sessionStorage.setItem("lfp-schedule-password", entered);
    return entered;
  }

  async function post(path, payload, retry = true) {
    const password = schedulePassword(!retry);
    const response = await fetch(`${RELAY_URL}/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, password }),
    });
    const result = await response.json().catch(() => ({}));
    if (response.status === 401 && retry) {
      sessionStorage.removeItem("lfp-schedule-password");
      return post(path, payload, false);
    }
    if (!response.ok || !result.ok) throw new Error(result.detail || result.error || "처리하지 못했습니다.");
    return result;
  }

  async function loadRecords() {
    try {
      let response;
      try {
        response = await fetch(`${RELAY_URL}/data?v=${Date.now()}`, { cache: "no-store" });
      } catch (_) {
        response = null;
      }
      if (!response?.ok) response = await fetch(`${SCHEDULE_DATA_URL}?v=${Date.now()}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const result = await response.json();
      const records = Array.isArray(result.records) ? result.records : Object.values(result.records || {});
      state.records = new Map(records.map((record) => [itemKey(record.itemCode, record.spec), record]));
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

  function reconcileCompleted(rows) {
    const keys = rows.filter((row) => state.records.has(row.key)
      && row.inboundWaiting <= 0 && row.purchaseWaiting <= 0).map((row) => row.key).sort();
    const signature = keys.join(";");
    if (!keys.length || signature === state.lastReset) return;
    state.lastReset = signature;
    keys.forEach((key) => state.records.delete(key));
    scheduleDecorate();
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
      const summaryEntries = [latestDate, latestNote].filter(Boolean);
      openButton.replaceChildren();
      summaryEntries.forEach((entry) => {
        const line = document.createElement("span");
        line.className = `lfp-note-summary-line is-${entry.type || "note"}`;
        let summary = text(entry.text).split(/\r?\n/)[0];
        if (entry.type === "date" && row.requestedDate && /^납기요청일\s+-\s*→/.test(summary)) {
          summary = summary.replace(/^납기요청일\s+-/, `납기요청일 ${row.requestedDate}`);
        }
        if (entry.type === "note") summary = `비고: ${summary}`;
        line.textContent = summary;
        line.title = summary;
        openButton.appendChild(line);
      });
      openButton.title = summaryEntries.length
        ? Array.from(openButton.children).map((line) => line.textContent).join("\n")
        : "";
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

  function solidFill(color) {
    return { type: "pattern", pattern: "solid", fgColor: { argb: `FF${color}` } };
  }

  function downloadBuffer(buffer, filename) {
    const blob = new Blob([buffer], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }

  function pendingDetailRows(rows) {
    const details = [];
    rows.forEach((row) => {
      const purchase = state.purchaseItems.get(itemKey(row.itemCode, row.spec)) || {};
      (purchase.requests || []).forEach((request) => {
        if (numberValue(request.purchaseWaitQty) <= 0) return;
        details.push([
          row.itemCode,
          row.spec,
          "발주대기",
          text(request.requestNo) || null,
          null,
          "미발주",
          numberValue(request.purchaseWaitQty),
          text(request.requestedDeliveryDate) || null,
        ]);
      });
      (purchase.purchaseOrders || []).forEach((order) => {
        if (numberValue(order.inboundWaitQty) <= 0) return;
        details.push([
          row.itemCode,
          row.spec,
          "입고대기",
          text(order.requestNo) || null,
          text(order.purchaseOrderNo) || null,
          text(order.orderStatus) || null,
          numberValue(order.inboundWaitQty),
          text(order.deliveryDate) || null,
        ]);
      });
    });
    return details;
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
      if (!window.ExcelJS) throw new Error("서식 Excel 모듈을 불러오지 못했습니다. 페이지를 새로고침한 뒤 다시 시도하세요.");
      const headers = [
        "품목코드", "품목명", "규격", "입고대기", "발주대기", "납기요청일",
        "납기확정일", "납기조정일", "비고", "구매의뢰번호", "발주번호", "대기상태",
      ];
      const workbook = new window.ExcelJS.Workbook();
      workbook.creator = "Lidding Foil Planner";
      workbook.created = new Date();
      const sheet = workbook.addWorksheet("납기관리", {
        views: [{ state: "frozen", xSplit: 0, ySplit: 2, topLeftCell: "A3", activeCell: "A3" }],
      });
      sheet.addRow([null, null, null, null, null, null, null, "기입 필요", "기입 가능", null, null, null]);
      sheet.addRow(headers);
      rows.forEach((row) => {
        sheet.addRow([
          row.itemCode,
          row.itemName,
          row.spec,
          row.inboundWaiting,
          row.purchaseWaiting,
          row.requestedDate || null,
          row.confirmedDate || null,
          null,
          null,
          row.requestNos.join("\n") || null,
          row.orderNos.join("\n") || null,
          [row.inboundWaiting > 0 ? "입고대기" : "", row.purchaseWaiting > 0 ? "발주대기" : ""].filter(Boolean).join("+"),
        ]);
      });

      sheet.columns = [14, 38, 18, 14, 14, 16, 16, 16, 44, 24, 24, 18].map((width) => ({ width }));
      sheet.autoFilter = { from: "A2", to: `L${sheet.rowCount}` };
      sheet.getRow(1).height = 22;
      sheet.getRow(2).height = 24;
      sheet.getRow(2).eachCell((cell) => {
        cell.fill = solidFill("164B7A");
        cell.font = { color: { argb: "FFFFFFFF" }, bold: true };
        cell.alignment = { horizontal: "center", vertical: "middle" };
      });
      sheet.getCell("H1").fill = solidFill("FCE8E6");
      sheet.getCell("H1").font = { color: { argb: "FFB42318" }, bold: true };
      sheet.getCell("I1").fill = solidFill("E6F4EA");
      sheet.getCell("I1").font = { color: { argb: "FF137044" }, bold: true };
      sheet.getCell("H2").fill = solidFill("A43A34");
      sheet.getCell("I2").fill = solidFill("267158");

      for (let rowNumber = 3; rowNumber <= sheet.rowCount; rowNumber += 1) {
        sheet.getCell(rowNumber, 4).numFmt = "#,##0";
        sheet.getCell(rowNumber, 5).numFmt = "#,##0";
        [6, 7, 8].forEach((column) => { sheet.getCell(rowNumber, column).numFmt = "yyyy-mm-dd"; });
        sheet.getCell(rowNumber, 8).fill = solidFill("FCE8E6");
        sheet.getCell(rowNumber, 9).fill = solidFill("E6F4EA");
        sheet.getCell(rowNumber, 9).alignment = { wrapText: true, vertical: "top" };
        [10, 11].forEach((column) => {
          sheet.getCell(rowNumber, column).alignment = { wrapText: true, vertical: "top" };
        });
      }

      const detailSheet = workbook.addWorksheet("대기번호 상세", {
        views: [{ state: "frozen", xSplit: 0, ySplit: 1, topLeftCell: "A2", activeCell: "A2" }],
      });
      detailSheet.addRow(["품목코드", "규격", "대기구분", "구매의뢰번호", "발주번호", "상태", "연결수량", "납기일"]);
      pendingDetailRows(rows).forEach((detail) => detailSheet.addRow(detail));
      detailSheet.columns = [14, 18, 14, 22, 22, 16, 16, 16].map((width) => ({ width }));
      detailSheet.autoFilter = { from: "A1", to: `H${Math.max(detailSheet.rowCount, 1)}` };
      detailSheet.getRow(1).eachCell((cell) => {
        cell.fill = solidFill("164B7A");
        cell.font = { color: { argb: "FFFFFFFF" }, bold: true };
        cell.alignment = { horizontal: "center", vertical: "middle" };
      });
      for (let rowNumber = 2; rowNumber <= detailSheet.rowCount; rowNumber += 1) {
        detailSheet.getCell(rowNumber, 7).numFmt = "#,##0";
        detailSheet.getCell(rowNumber, 8).numFmt = "yyyy-mm-dd";
      }

      const today = new Date();
      const stamp = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
      downloadBuffer(await workbook.xlsx.writeBuffer(), `${stamp}_납기관리 리스트.xlsx`);
    } catch (error) {
      window.alert(error?.message || "납기관리 리스트를 저장하지 못했습니다.");
    } finally {
      button.disabled = false;
      button.textContent = original;
    }
  }

  function cleanHeader(value) {
    return text(value).replace(/\s+/g, "").toLowerCase();
  }

  function workbookYear(filename) {
    const long = text(filename).match(/(20\d{2})/);
    if (long) return Number(long[1]);
    const short = text(filename).match(/(^|\D)(\d{2})년/);
    return short ? 2000 + Number(short[2]) : new Date().getFullYear();
  }

  function excelDate(value, yearHint = new Date().getFullYear()) {
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
      if (short) match = [source, String(yearHint), short[1], short[2]];
    }
    if (!match) return "";
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const parsed = new Date(year, month - 1, day);
    if (parsed.getFullYear() !== year || parsed.getMonth() !== month - 1 || parsed.getDate() !== day) return "";
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }

  function columnFor(headers, ...aliases) {
    for (const alias of aliases) {
      const column = headers.get(cleanHeader(alias));
      if (column !== undefined) return column;
    }
    return -1;
  }

  function workbookHeader(workbook, requiredGroups) {
    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      const matrix = window.XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null });
      for (let rowIndex = 0; rowIndex < Math.min(matrix.length, 40); rowIndex += 1) {
        const headers = new Map();
        (matrix[rowIndex] || []).forEach((value, column) => {
          if (value !== null && value !== "") headers.set(cleanHeader(value), column);
        });
        const matches = requiredGroups.every((aliases) => aliases.some((alias) => headers.has(cleanHeader(alias))));
        if (matches) return { sheet, matrix, rowIndex, headers };
      }
    }
    return null;
  }

  function identifiers(value) {
    return text(value).split(/[\r\n,;]+/).map((part) => part.trim()).filter(Boolean);
  }

  function itemPurchaseDates(item) {
    const values = new Set([
      item?.nextDeliveryDate,
      item?.nextRequestedDeliveryDate,
      item?.nextOrderDeliveryDate,
      ...(item?.requests || []).map((row) => row.requestedDeliveryDate),
      ...(item?.purchaseOrders || []).map((row) => row.deliveryDate),
    ]);
    return new Set([...values].filter(Boolean).map((value) => text(value).slice(0, 10)));
  }

  function sourceRowStruck(sheet, rowIndex, row) {
    return row.some((value, columnIndex) => {
      if (value === null || value === "") return false;
      const address = window.XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex });
      const font = sheet[address]?.s?.font || {};
      return Boolean(font.strike || font.strikeout);
    });
  }

  function parseDeliveryWorkbook(content, filename) {
    if (!window.XLSX) throw new Error("Excel 모듈을 불러오지 못했습니다. 페이지를 새로고침한 뒤 다시 시도하세요.");
    const workbook = window.XLSX.read(content, { type: "array", cellDates: true, cellStyles: true });
    const yearHint = workbookYear(filename);
    const stats = { parsed: 0, blank: 0, struck: 0, unmatched: 0, conflicts: 0 };
    const management = workbookHeader(workbook, [["품목코드"], ["납기조정일"]]);

    if (management) {
      const { matrix, rowIndex, headers } = management;
      const columns = {
        itemCode: columnFor(headers, "품목코드"),
        itemName: columnFor(headers, "품목명"),
        spec: columnFor(headers, "규격"),
        requestedDate: columnFor(headers, "납기요청일"),
        confirmedDate: columnFor(headers, "납기확정일"),
        adjustedDate: columnFor(headers, "납기조정일"),
        note: columnFor(headers, "비고"),
        requestNos: columnFor(headers, "구매의뢰번호"),
        orderNos: columnFor(headers, "발주번호"),
        waitingStatus: columnFor(headers, "대기상태"),
      };
      const valueAt = (row, column) => column >= 0 ? row[column] : "";
      const activeRequestNos = new Set();
      const activeOrderNos = new Set();
      state.purchaseItems.forEach((item) => {
        [...(item.requests || []), ...(item.purchaseOrders || [])].forEach((row) => {
          if (text(row.requestNo)) activeRequestNos.add(text(row.requestNo));
        });
        (item.purchaseOrders || []).forEach((row) => {
          if (text(row.purchaseOrderNo)) activeOrderNos.add(text(row.purchaseOrderNo));
        });
      });
      const rows = [];
      for (let index = rowIndex + 1; index < matrix.length; index += 1) {
        const row = matrix[index] || [];
        const itemCode = text(valueAt(row, columns.itemCode));
        if (!itemCode) continue;
        const adjustedDate = excelDate(valueAt(row, columns.adjustedDate), yearHint);
        const note = text(valueAt(row, columns.note));
        if (!adjustedDate && !note) {
          stats.blank += 1;
          continue;
        }
        const requestNos = identifiers(valueAt(row, columns.requestNos));
        const orderNos = identifiers(valueAt(row, columns.orderNos));
        if (requestNos.length && activeRequestNos.size && !requestNos.some((number) => activeRequestNos.has(number))) {
          stats.unmatched += 1;
          continue;
        }
        if (orderNos.length && activeOrderNos.size && !orderNos.some((number) => activeOrderNos.has(number))) {
          stats.unmatched += 1;
          continue;
        }
        rows.push({
          itemCode,
          itemName: text(valueAt(row, columns.itemName)),
          spec: text(valueAt(row, columns.spec)),
          requestedDate: excelDate(valueAt(row, columns.requestedDate), yearHint),
          confirmedDate: excelDate(valueAt(row, columns.confirmedDate), yearHint),
          adjustedDate,
          note,
          requestNos,
          orderNos,
          waitingStatus: text(valueAt(row, columns.waitingStatus)),
        });
      }
      stats.parsed = rows.length;
      return { rows, stats: { ...stats, format: "management", formatLabel: "납기관리 리스트" } };
    }

    const pnp = workbookHeader(workbook, [["규격"], ["요청납기", "요청납기일"], ["조정납기", "조정납기일"]]);
    if (!pnp) throw new Error("지원하는 납기관리 또는 납품일정 양식을 찾지 못했습니다.");
    const codeColumn = columnFor(pnp.headers, "규격");
    const requestedColumn = columnFor(pnp.headers, "요청납기", "요청납기일");
    const adjustedColumn = columnFor(pnp.headers, "조정납기", "조정납기일");
    const purchaseItems = [...state.purchaseItems.values()];
    const rows = [];

    for (let index = pnp.rowIndex + 1; index < pnp.matrix.length; index += 1) {
      const row = pnp.matrix[index] || [];
      if (sourceRowStruck(pnp.sheet, index, row)) {
        stats.struck += 1;
        continue;
      }
      const itemCode = text(row[codeColumn]);
      if (!itemCode) continue;
      const requestedDate = excelDate(row[requestedColumn], yearHint);
      const adjustedDate = excelDate(row[adjustedColumn], yearHint);
      if (!adjustedDate) {
        stats.blank += 1;
        continue;
      }
      let candidates = purchaseItems.filter((item) => text(item.itemCode).toUpperCase() === itemCode.toUpperCase()
        && (!requestedDate || itemPurchaseDates(item).has(requestedDate)));
      if (!candidates.length && requestedDate) {
        candidates = purchaseItems.filter((item) => text(item.itemCode).toUpperCase() === itemCode.toUpperCase());
      }
      const byKey = new Map(candidates.map((item) => [itemKey(item.itemCode, item.specification), item]));
      if (!byKey.size) {
        stats.unmatched += 1;
        continue;
      }
      if (byKey.size > 1) {
        stats.conflicts += 1;
        continue;
      }
      const item = [...byKey.values()][0];
      const key = itemKey(item.itemCode, item.specification);
      const requestNos = [...new Set([...(item.requests || []), ...(item.purchaseOrders || [])]
        .map((entry) => text(entry.requestNo)).filter(Boolean))].sort();
      const orderNos = [...new Set((item.purchaseOrders || [])
        .map((entry) => text(entry.purchaseOrderNo)).filter(Boolean))].sort();
      rows.push({
        itemCode: text(item.itemCode),
        itemName: text(item.itemName),
        spec: text(item.specification),
        requestedDate,
        confirmedDate: text(state.records.get(key)?.confirmedDate),
        adjustedDate,
        note: "",
        requestNos,
        orderNos,
        waitingStatus: [numberValue(item.inboundWaitQty) > 0 ? "입고대기" : "", numberValue(item.purchaseWaitQty) > 0 ? "발주대기" : ""].filter(Boolean).join("+"),
      });
    }
    stats.parsed = rows.length;
    return { rows, stats: { ...stats, format: "pnp-schedule", formatLabel: "피앤피 납품일정" } };
  }

  async function uploadUpdate(file) {
    const parsed = parseDeliveryWorkbook(await file.arrayBuffer(), file.name);
    if (!parsed.rows.length) {
      window.alert(`${parsed.stats.formatLabel}: 반영 가능한 일정이 없습니다.\n공란 ${parsed.stats.blank}건 · 취소선 제외 ${parsed.stats.struck}건 · 미연결 ${parsed.stats.unmatched}건 · 충돌 ${parsed.stats.conflicts}건`);
      return;
    }
    const result = await post("update", { rows: parsed.rows, importStats: parsed.stats });
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
    window.alert(`${result.formatLabel || "납기 파일"}: ${summary}\nGit 저장과 화면 반영이 완료됐습니다.`);
    await loadRecords();
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
