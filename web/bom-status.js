(() => {
  const state = {
    data: null,
    refreshTimer: null,
    filters: {
      productCode: "",
      productName: "",
      liddingCode: "",
      liddingName: "",
      liddingSpecification: "",
    },
  };
  const numberFormat = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 6 });
  const escapeHtml = (value) => String(value ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#039;");

  function findBomHeading() {
    return [...document.querySelectorAll("h1,h2,h3")].find((node) =>
      node.textContent.trim() === "BOM 구성 현황"
    );
  }

  function findBomPanel() {
    const heading = findBomHeading();
    return heading?.closest("[data-panel], .tab-panel, section, article") || heading?.parentElement;
  }

  function injectStyles() {
    const style = document.createElement("style");
    style.textContent = `
      #lfp-bom-live { margin: 14px 0 0; overflow: hidden; border: 1px solid #aec0d8; background: #fff; box-shadow: 0 12px 34px rgba(16, 45, 83, .09); }
      .lfp-bom-command { min-height: 84px; padding: 15px 18px; display: flex; align-items: center; justify-content: space-between; gap: 24px; color: #fff; background: #0b2f5d; border-bottom: 3px solid #10a7c4; }
      .lfp-bom-command__title { min-width: 260px; }
      .lfp-bom-command__eyebrow { display: block; margin-bottom: 5px; color: #68d5e6; font: 700 10px/1 'IBM Plex Sans KR', sans-serif; letter-spacing: .16em; }
      .lfp-bom-command h3 { margin: 0; color: #fff; font-size: 18px; letter-spacing: -.02em; }
      .lfp-bom-command p { margin: 5px 0 0; color: #bbcee4; font-size: 11px; }
      .lfp-bom-metrics { display: grid; grid-template-columns: repeat(3, minmax(112px, 1fr)); gap: 8px; }
      .lfp-bom-metric { min-width: 112px; padding: 9px 12px; background: #173f70; border: 1px solid #335b87; }
      .lfp-bom-metric span { display: block; color: #a9bfd8; font-size: 10px; }
      .lfp-bom-metric strong { display: block; margin-top: 3px; color: #fff; font-size: 18px; font-variant-numeric: tabular-nums; }
      .lfp-bom-scroll { max-height: 590px; overflow: auto; scrollbar-color: #7891ad #e8eef5; }
      .lfp-bom-table { width: 100%; min-width: 1080px; table-layout: fixed; border-collapse: separate; border-spacing: 0; font-size: 13px; }
      .lfp-bom-table th { position: sticky; z-index: 2; height: auto; padding: 9px 11px; color: #102a53; border-right: 1px solid #b8c8db; border-bottom: 1px solid #afc0d5; }
      .lfp-bom-group th { top: 0; z-index: 5; padding: 9px 12px; color: #fff; font-size: 11px; font-weight: 800; letter-spacing: .09em; text-align: left; text-transform: uppercase; }
      .lfp-bom-group .production { background: #1766b3; border-right: 4px solid #fff; }
      .lfp-bom-group .lidding { background: #9a6100; }
      .lfp-bom-group small { margin-left: 8px; color: #d8eaff; font-size: 10px; font-weight: 500; letter-spacing: 0; }
      .lfp-bom-group .lidding small { color: #ffedc6; }
      .lfp-bom-columns th { top: 35px; z-index: 4; height: 39px; font-weight: 700; }
      .lfp-bom-columns th:nth-child(-n+2) { background: #e6f1fc; }
      .lfp-bom-columns th:nth-child(n+3) { background: #fff0d2; }
      .lfp-bom-columns th:nth-child(1) { width: 8%; }
      .lfp-bom-columns th:nth-child(2) { width: 34%; }
      .lfp-bom-columns th:nth-child(3) { width: 9%; }
      .lfp-bom-columns th:nth-child(4) { width: 11%; }
      .lfp-bom-columns th:nth-child(5) { width: 38%; }
      .lfp-bom-columns th:nth-child(3), .lfp-bom-filter th:nth-child(3), .lfp-bom-table td:nth-child(3) { border-left: 4px solid #c6d2df; }
      .lfp-bom-filter th { top: 74px; z-index: 4; padding: 7px 9px; }
      .lfp-bom-filter th:nth-child(-n+2) { background: #f2f7fd; }
      .lfp-bom-filter th:nth-child(n+3) { background: #fff8e9; }
      .lfp-bom-filter input { width: 100%; min-width: 0; height: 34px; padding: 0 9px; border: 1px solid #a9bbd0; background: #fff; color: #173457; font-size: 12px; }
      .lfp-bom-filter input:focus { border-color: #0874d1; outline: 2px solid #d9edff; }
      .lfp-bom-table td { height: 43px; padding: 8px 11px; overflow: hidden; color: #17304f; border-right: 1px solid #d7e0eb; border-bottom: 1px solid #d7e0eb; text-overflow: ellipsis; white-space: nowrap; }
      .lfp-bom-table td:nth-child(-n+2) { background: #f8fbff; }
      .lfp-bom-table td:nth-child(n+3) { background: #fffbf3; }
      .lfp-bom-table tbody tr:nth-child(even) td:nth-child(-n+2) { background: #f1f7fd; }
      .lfp-bom-table tbody tr:nth-child(even) td:nth-child(n+3) { background: #fff7e8; }
      .lfp-bom-table tbody tr:hover td { background: #e8f4ff; box-shadow: inset 0 1px #8ec7ef, inset 0 -1px #8ec7ef; }
      .lfp-bom-code { font-family: 'IBM Plex Mono', Consolas, monospace; font-weight: 800; color: #075fbe; }
      .lfp-bom-code-badge { display: inline-block; min-width: 68px; padding: 4px 8px; color: #075fbe; background: #eaf4ff; border-left: 3px solid #1685dc; }
      .lfp-bom-code-badge.is-lidding { color: #8c5400; background: #fff0d0; border-left-color: #dc8b00; }
      .lfp-bom-spec { display: inline-block; padding: 3px 8px; color: #744500; background: #fff4da; border: 1px solid #e6ad42; font: 700 11px/1.25 'IBM Plex Mono', Consolas, monospace; }
      .lfp-bom-empty { height: 180px !important; color: #6e8099 !important; background: #fff !important; text-align: center !important; }
      .lfp-bom-page { position: relative; }
      .lfp-bom-page-heading { display: flex; align-items: center; justify-content: space-between; gap: 24px; }
      .lfp-bom-page-heading > div { min-width: 0; }
      .lfp-bom-page-tools { position: static; z-index: 7; display: flex; flex: 0 0 auto; align-items: center; gap: 12px; margin-left: auto; }
      .lfp-bom-page-tools span { color: #607894; font-size: 11px; font-weight: 700; white-space: nowrap; }
      .lfp-bom-page-tools strong { margin-left: 5px; color: #0567c8; font-family: 'IBM Plex Mono', Consolas, monospace; font-size: 12px; }
      .lfp-bom-refresh-button { min-width: 126px; height: 34px; border: 1px solid #0d5ea8; background: #0b3b70; color: #fff; font-size: 12px; font-weight: 800; cursor: pointer; }
      .lfp-bom-refresh-button:hover { background: #075094; }
      .lfp-bom-refresh-button:disabled { cursor: wait; opacity: .68; }
      @media (max-width: 1100px) { .lfp-bom-page-heading { align-items: stretch; flex-direction: column; } .lfp-bom-page-tools { justify-content: flex-end; width: 100%; margin: 0; } }
      @media (max-width: 900px) { .lfp-bom-command { align-items: flex-start; flex-direction: column; } .lfp-bom-metrics { width: 100%; } }
    `;
    document.head.appendChild(style);
  }

  function collectionVersion(data = state.data) {
    return String(data?.generatedAt || data?.collectedAt || data?.sourceRefreshedAt || "");
  }

  function formatCollectionTime(value) {
    if (!value) return "-";
    const parsed = new Date(String(value).replace(" ", "T"));
    if (Number.isNaN(parsed.getTime())) return String(value);
    return new Intl.DateTimeFormat("ko-KR", {
      month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
      hour12: false,
    }).format(parsed);
  }

  function updateMetrics(container) {
    const rows = state.data?.rows || [];
    const productCount = new Set(rows.map((row) => row.productCode)).size;
    const liddingCount = new Set(rows.map((row) => `${row.liddingCode}|${row.liddingSpecification}`)).size;
    const product = container.querySelector('[data-bom-metric="product"]');
    const lidding = container.querySelector('[data-bom-metric="lidding"]');
    if (product) product.textContent = productCount.toLocaleString("ko-KR");
    if (lidding) lidding.textContent = liddingCount.toLocaleString("ko-KR");
  }

  function updateCollectionTime(panel) {
    const target = panel?.querySelector("[data-bom-collected-at]");
    if (!target) return;
    const value = collectionVersion();
    target.textContent = formatCollectionTime(value);
    target.title = value;
  }

  function ensureBomTools(panel) {
    let tools = panel.querySelector(".lfp-bom-page-tools");
    if (!tools) {
      tools = document.createElement("div");
      tools.className = "lfp-bom-page-tools";
      tools.innerHTML = '<span>BOM 현황 수집시각 <strong data-bom-collected-at>-</strong></span><button type="button" class="lfp-bom-refresh-button">BOM 새로고침</button>';
      tools.querySelector("button").addEventListener("click", (event) => requestBomRefresh(event.currentTarget));
      (panel.querySelector(".lfp-bom-page-heading") || panel).appendChild(tools);
    }
    updateCollectionTime(panel);
  }

  function filteredRows() {
    const textMatch = (value, filter) => !filter || String(value || "").toLowerCase().includes(filter.toLowerCase());
    return state.data.rows.filter((row) =>
      textMatch(row.productCode, state.filters.productCode)
      && textMatch(row.productName, state.filters.productName)
      && textMatch(row.liddingCode, state.filters.liddingCode)
      && textMatch(row.liddingName, state.filters.liddingName)
      && textMatch(row.liddingSpecification, state.filters.liddingSpecification)
    );
  }

  function renderTable(container) {
    const rows = filteredRows();
    const body = rows.map((row) => `
      <tr>
        <td class="lfp-bom-code"><span class="lfp-bom-code-badge">${escapeHtml(row.productCode)}</span></td>
        <td title="${escapeHtml(row.productName)}">${escapeHtml(row.productName)}</td>
        <td class="lfp-bom-code"><span class="lfp-bom-code-badge is-lidding">${escapeHtml(row.liddingCode)}</span></td>
        <td><span class="lfp-bom-spec">${escapeHtml(row.liddingSpecification || "규격 없음")}</span></td>
        <td title="${escapeHtml(row.liddingName)}">${escapeHtml(row.liddingName)}</td>
      </tr>
    `).join("");
    container.querySelector("tbody").innerHTML = body || '<tr><td class="lfp-bom-empty" colspan="5">조회 결과가 없습니다.</td></tr>';
    const visible = container.querySelector("[data-bom-metric=visible]");
    if (visible) visible.textContent = rows.length.toLocaleString("ko-KR");
  }

  function buildPanel() {
    const panel = findBomPanel();
    if (!panel || panel.querySelector("#lfp-bom-live")) return;
    panel.classList.remove("placeholder");
    panel.classList.add("lfp-bom-page");
    const live = document.createElement("div");
    live.id = "lfp-bom-live";
    const allRows = state.data.rows || [];
    const productCount = new Set(allRows.map((row) => row.productCode)).size;
    const liddingCount = new Set(allRows.map((row) => `${row.liddingCode}|${row.liddingSpecification}`)).size;
    live.innerHTML = `
      <div class="lfp-bom-command">
        <div class="lfp-bom-command__title">
          <span class="lfp-bom-command__eyebrow">BOM RELATION CONTROL</span>
          <h3>P코드 ↔ 리드지 연결 맵</h3>
          <p>제품과 리드지 규격 버전의 최신 연결 관계</p>
        </div>
        <div class="lfp-bom-metrics">
          <div class="lfp-bom-metric"><span>연결 제품</span><strong data-bom-metric="product">${productCount.toLocaleString("ko-KR")}</strong></div>
          <div class="lfp-bom-metric"><span>리드지 규격</span><strong data-bom-metric="lidding">${liddingCount.toLocaleString("ko-KR")}</strong></div>
          <div class="lfp-bom-metric"><span>현재 표시</span><strong data-bom-metric="visible">${allRows.length.toLocaleString("ko-KR")}</strong></div>
        </div>
      </div>
      <div class="lfp-bom-scroll">
        <table class="lfp-bom-table">
          <colgroup>
            <col style="width: 8%">
            <col style="width: 34%">
            <col style="width: 9%">
            <col style="width: 11%">
            <col style="width: 38%">
          </colgroup>
          <thead>
            <tr class="lfp-bom-group"><th class="production" colspan="2">생산 제품 <small>PRODUCT</small></th><th class="lidding" colspan="3">리드지 자재 <small>LIDDING FOIL</small></th></tr>
            <tr class="lfp-bom-columns"><th>P코드</th><th>제품명</th><th>BS 리드지</th><th>규격 버전</th><th>리드지품명</th></tr>
            <tr class="lfp-bom-filter">
              <th><input data-filter="productCode" placeholder="P코드"></th>
              <th><input data-filter="productName" placeholder="제품명"></th>
              <th><input data-filter="liddingCode" placeholder="BS코드"></th>
              <th><input data-filter="liddingSpecification" placeholder="규격 버전"></th>
              <th><input data-filter="liddingName" placeholder="리드지 품명"></th>
            </tr>
          </thead>
          <tbody></tbody>
        </table>
      </div>
    `;
    panel.appendChild(live);
    ensureBomTools(panel);
    live.querySelectorAll("[data-filter]").forEach((control) => {
      const eventName = control.tagName === "SELECT" ? "change" : "input";
      control.addEventListener(eventName, () => {
        state.filters[control.dataset.filter] = control.value.trim();
        renderTable(live);
      });
    });
    renderTable(live);
  }

  async function loadBomData(forceRender = false, forceLoad = false) {
    const previousVersion = collectionVersion();
    const nextData = await window.LFPResources.json("data/bom-product-lidding.json", { force: forceLoad });
    const changed = collectionVersion(nextData) !== previousVersion;
    state.data = nextData;
    const panel = findBomPanel();
    if (!panel) return;
    buildPanel();
    ensureBomTools(panel);
    const live = panel.querySelector("#lfp-bom-live");
    if (live && (forceRender || changed)) {
      updateMetrics(live);
      renderTable(live);
    }
    updateCollectionTime(panel);
  }

  async function requestBomRefresh(button) {
    const original = button.textContent;
    const requestedAt = Date.now();
    button.disabled = true;
    button.textContent = "수집 요청 중";
    try {
      const response = await fetch("api/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope: "bom" }),
      });
      if (!response.ok) throw new Error("BOM 갱신 요청 실패");
      button.textContent = "BOM 수집 중";
      let observedRunning = false;
      for (let attempt = 0; attempt < 90; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 2000));
        const statusResponse = await fetch("api/monitor-status", { cache: "no-store" });
        if (!statusResponse.ok) continue;
        const status = await statusResponse.json();
        observedRunning = observedRunning || Boolean(status.running);
        const collectedAt = Date.parse(status.lastCollectedAt || "");
        if (!status.running && status.lastStatus === "error" && status.lastScope === "bom") {
          throw new Error(status.lastError || "BOM 갱신 실패");
        }
        if (!status.running && status.lastStatus === "success" && status.lastScope === "bom"
            && (observedRunning || (Number.isFinite(collectedAt) && collectedAt >= requestedAt - 2000))) {
          await loadBomData(true);
          button.textContent = "수집 완료";
          window.setTimeout(() => {
            button.disabled = false;
            button.textContent = original;
          }, 900);
          return;
        }
      }
      throw new Error("BOM 갱신 시간이 초과되었습니다.");
    } catch (error) {
      button.textContent = "수집 서버 연결 필요";
      button.title = error?.message || "BOM을 갱신하지 못했습니다.";
      window.setTimeout(() => {
        button.disabled = false;
        button.textContent = original;
      }, 2200);
    }
  }

  async function init() {
    injectStyles();
    try {
      await loadBomData(true);
      const tab = [...document.querySelectorAll("button,a")].find((node) => node.textContent.trim() === "BOM 구성 현황");
      tab?.addEventListener("click", () => setTimeout(() => {
        buildPanel();
        ensureBomTools(findBomPanel());
      }, 0));
      document.addEventListener("lfp:data-updated", () => loadBomData(false, true).catch(() => {}));
    } catch (error) {
      console.error("BOM 데이터 로드 실패", error);
    }
  }

  document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", init) : init();
})();
