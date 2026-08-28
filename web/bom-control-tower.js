(() => {
  const state = { data: null, mode: "forward", query: "", selectedProduct: "P0007", selectedLidding: "BS0054|BS0054-003" };
  const escapeHtml = (value) => String(value ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#039;");

  function uniqueProducts(rows) {
    const map = new Map();
    rows.forEach((row) => map.set(row.productCode, { code: row.productCode, name: row.productName }));
    return [...map.values()].sort((a, b) => a.code.localeCompare(b.code));
  }

  function uniqueLiddings(rows) {
    const map = new Map();
    rows.forEach((row) => {
      const key = `${row.liddingCode}|${row.liddingSpecification}`;
      map.set(key, { key, code: row.liddingCode, name: row.liddingName, specification: row.liddingSpecification });
    });
    return [...map.values()].sort((a, b) => a.key.localeCompare(b.key));
  }

  function card(item, selected, kind) {
    const key = kind === "product" ? item.code : item.key;
    const title = kind === "product" ? item.code : item.code;
    const detail = kind === "product" ? item.name : item.name;
    const spec = kind === "lidding" ? `<span class="lfp-ct-spec">${escapeHtml(item.specification || "규격 없음")}</span>` : "";
    return `<button class="lfp-ct-card ${selected ? "is-selected" : ""}" type="button" data-kind="${kind}" data-key="${escapeHtml(key)}">
      <strong>${escapeHtml(title)}</strong>${spec}<span class="lfp-ct-name">${escapeHtml(detail)}</span><b>›</b>
    </button>`;
  }

  function render(tower) {
    const rows = state.data.rows;
    const query = state.query.toLowerCase();
    const leftTitle = state.mode === "forward" ? "제품 P코드" : "BS 리드지 · 규격";
    const rightTitle = state.mode === "forward" ? "연결 리드지" : "사용 제품 P코드";
    let leftItems;
    let rightItems;
    let selectedLabel;

    if (state.mode === "forward") {
      leftItems = uniqueProducts(rows).filter((item) => !query || `${item.code} ${item.name}`.toLowerCase().includes(query));
      if (!leftItems.some((item) => item.code === state.selectedProduct) && leftItems.length) state.selectedProduct = leftItems[0].code;
      rightItems = uniqueLiddings(rows.filter((row) => row.productCode === state.selectedProduct));
      const product = leftItems.find((item) => item.code === state.selectedProduct) || uniqueProducts(rows).find((item) => item.code === state.selectedProduct);
      selectedLabel = product ? `${product.code} ${product.name} → 리드지 ${rightItems.length}개` : "제품을 선택하세요";
    } else {
      leftItems = uniqueLiddings(rows).filter((item) => !query || `${item.code} ${item.specification} ${item.name}`.toLowerCase().includes(query));
      if (!leftItems.some((item) => item.key === state.selectedLidding) && leftItems.length) state.selectedLidding = leftItems[0].key;
      const [code, specification] = state.selectedLidding.split("|");
      rightItems = uniqueProducts(rows.filter((row) => row.liddingCode === code && row.liddingSpecification === specification));
      const lidding = leftItems.find((item) => item.key === state.selectedLidding) || uniqueLiddings(rows).find((item) => item.key === state.selectedLidding);
      selectedLabel = lidding ? `${lidding.code} · ${lidding.specification || "규격 없음"} → P코드 ${rightItems.length}개` : "리드지를 선택하세요";
    }

    tower.querySelector("[data-left-title]").textContent = leftTitle;
    tower.querySelector("[data-right-title]").textContent = rightTitle;
    tower.querySelector("[data-left-count]").textContent = leftItems.length.toLocaleString("ko-KR");
    tower.querySelector("[data-right-count]").textContent = rightItems.length.toLocaleString("ko-KR");
    tower.querySelector("[data-relation]").textContent = selectedLabel;
    tower.querySelector("[data-left-list]").innerHTML = leftItems.map((item) => card(
      item,
      state.mode === "forward" ? item.code === state.selectedProduct : item.key === state.selectedLidding,
      state.mode === "forward" ? "product" : "lidding",
    )).join("") || '<div class="lfp-ct-empty">검색 결과 없음</div>';
    tower.querySelector("[data-right-list]").innerHTML = rightItems.map((item) => card(
      item, false, state.mode === "forward" ? "lidding" : "product",
    )).join("") || '<div class="lfp-ct-empty">연결 정보 없음</div>';
    tower.querySelectorAll("[data-mode]").forEach((button) => button.classList.toggle("is-active", button.dataset.mode === state.mode));

    tower.querySelectorAll("[data-left-list] .lfp-ct-card").forEach((button) => {
      button.addEventListener("click", () => {
        if (state.mode === "forward") state.selectedProduct = button.dataset.key;
        else state.selectedLidding = button.dataset.key;
        render(tower);
      });
    });
  }

  function injectStyles() {
    const style = document.createElement("style");
    style.textContent = `
      #lfp-bom-control-tower { margin: 18px 0; border: 1px solid #bfcde0; background: #f5f8fc; }
      .lfp-ct-head { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 16px 18px; border-bottom: 1px solid #cbd7e8; background: #fff; }
      .lfp-ct-head strong { color: #071f48; font-size: 18px; }
      .lfp-ct-modes { display: flex; gap: 6px; }
      .lfp-ct-modes button { padding: 8px 14px; border: 1px solid #aebed3; background: #fff; color: #435773; cursor: pointer; }
      .lfp-ct-modes button.is-active { border-color: #075dcc; background: #075dcc; color: #fff; }
      .lfp-ct-search { display: flex; gap: 8px; padding: 12px 18px; background: #edf3fa; border-bottom: 1px solid #cbd7e8; }
      .lfp-ct-search input { flex: 1; padding: 10px 12px; border: 1px solid #aebed3; background: #fff; }
      .lfp-ct-relation { padding: 10px 18px; border-bottom: 1px solid #d7e0ec; background: #fff9e9; color: #694300; font-weight: 800; }
      .lfp-ct-grid { display: grid; grid-template-columns: minmax(290px, 1fr) 70px minmax(290px, 1fr); min-height: 430px; }
      .lfp-ct-column { padding: 14px; min-width: 0; }
      .lfp-ct-title { display: flex; justify-content: space-between; margin-bottom: 10px; color: #19365f; font-size: 13px; font-weight: 800; }
      .lfp-ct-list { display: grid; gap: 5px; max-height: 480px; overflow: auto; }
      .lfp-ct-card { position: relative; display: flex; align-items: center; gap: 9px; width: 100%; min-height: 40px; padding: 8px 36px 8px 13px; border: 1px solid #d6dfeb; border-left: 4px solid #7b9fe8; border-radius: 6px; background: #fff; text-align: left; cursor: pointer; }
      .lfp-ct-card strong { flex: 0 0 66px; color: #0b2349; font-size: 13px; }
      .lfp-ct-card .lfp-ct-name { flex: 1 1 auto; min-width: 0; overflow: hidden; color: #63758f; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
      .lfp-ct-card b { position: absolute; right: 13px; top: 50%; transform: translateY(-50%); color: #7790b1; }
      .lfp-ct-card.is-selected { border-color: #0874ef; border-left-color: #075dcc; box-shadow: 0 0 0 1px #0874ef; background: #f4f9ff; }
      .lfp-ct-spec { flex: 0 0 auto; padding: 2px 6px; border: 1px solid #efc36b; border-radius: 3px; background: #fff5dc; color: #815000; font-size: 11px; font-weight: 800; white-space: nowrap; }
      .lfp-ct-arrow { display: grid; place-items: center; border-left: 1px solid #dbe3ee; border-right: 1px solid #dbe3ee; color: #075dcc; font-size: 34px; font-weight: 300; }
      .lfp-ct-empty { padding: 48px 12px; text-align: center; color: #8493a9; }
      @media (max-width: 800px) { .lfp-ct-grid { grid-template-columns: 1fr; } .lfp-ct-arrow { min-height: 52px; transform: rotate(90deg); } .lfp-ct-head { align-items: flex-start; flex-direction: column; } }
    `;
    document.head.appendChild(style);
  }

  function mount() {
    const host = document.querySelector("#lfp-bom-live");
    if (!host || host.querySelector("#lfp-bom-control-tower")) return;
    const tower = document.createElement("section");
    tower.id = "lfp-bom-control-tower";
    tower.innerHTML = `
      <div class="lfp-ct-head"><strong>BOM Relation Control Tower</strong><div class="lfp-ct-modes"><button type="button" data-mode="forward">정전개 P → BS</button><button type="button" data-mode="reverse">역전개 BS → P</button></div></div>
      <div class="lfp-ct-search"><input type="search" placeholder="P코드, 제품명, BS코드, 규격 버전 검색"></div>
      <div class="lfp-ct-relation" data-relation></div>
      <div class="lfp-ct-grid">
        <div class="lfp-ct-column"><div class="lfp-ct-title"><span data-left-title></span><span><b data-left-count></b>개</span></div><div class="lfp-ct-list" data-left-list></div></div>
        <div class="lfp-ct-arrow">→</div>
        <div class="lfp-ct-column"><div class="lfp-ct-title"><span data-right-title></span><span><b data-right-count></b>개</span></div><div class="lfp-ct-list" data-right-list></div></div>
      </div>
    `;
    host.prepend(tower);
    tower.querySelectorAll("[data-mode]").forEach((button) => button.addEventListener("click", () => {
      state.mode = button.dataset.mode;
      state.query = "";
      tower.querySelector("input").value = "";
      render(tower);
    }));
    tower.querySelector("input").addEventListener("input", (event) => {
      state.query = event.target.value;
      render(tower);
    });
    render(tower);
  }

  async function init() {
    injectStyles();
    const response = await fetch(`data/bom-product-lidding.json?v=${Date.now()}`);
    if (!response.ok) return;
    state.data = await response.json();
    const tryMount = () => { mount(); if (!document.querySelector("#lfp-bom-control-tower")) setTimeout(tryMount, 100); };
    tryMount();
  }

  document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", init) : init();
})();
