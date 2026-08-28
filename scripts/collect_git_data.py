from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
from calendar import monthrange
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo


ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "web" / "data"
API_BASE_URL = os.environ.get("LFP_API_BASE_URL", "https://plan.interojo.net").rstrip("/")
KST = ZoneInfo("Asia/Seoul")
PCODE = re.compile(r"^P\d{4}$", re.IGNORECASE)
LIDDING_NAME = re.compile(r"리드지|lidding|foil", re.IGNORECASE)
ACTIVE_ORDER_STATUSES = {"발주", "납품진행"}
WAREHOUSES = (
    ("300", "L관창고(자재)"),
    ("P010", "A관 공정부자재"),
    ("P030", "C관 공정부자재"),
    ("S100", "S관 공정부자재"),
)


def now_text() -> str:
    return datetime.now(KST).isoformat(timespec="seconds")


def atomic_write(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(path)


def read_json(path: Path, default: object | None = None) -> object:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {} if default is None else default


def fetch_json(path: str, params: dict[str, object], timeout: int = 300) -> dict:
    url = f"{API_BASE_URL}{path}?{urlencode(params)}"
    request = Request(
        url,
        headers={"Accept": "application/json", "User-Agent": "Lidding-Foil-Git-Collector/1.0"},
    )
    with urlopen(request, timeout=timeout) as response:
        return json.load(response)


def validated_rows(name: str, payload: dict) -> list[dict]:
    rows = payload.get("rows") or []
    if not isinstance(rows, list):
        raise RuntimeError(f"{name} API rows 형식이 올바르지 않습니다.")
    total = int(payload.get("total_count") if payload.get("total_count") is not None else len(rows))
    returned = int(payload.get("returned_count") if payload.get("returned_count") is not None else len(rows))
    if payload.get("truncated") or total != returned or returned != len(rows):
        raise RuntimeError(f"{name} API 건수 불일치: total={total}, returned={returned}, rows={len(rows)}")
    return rows


def number(value: object) -> Decimal:
    if value in (None, ""):
        return Decimal("0")
    return Decimal(str(value).replace(",", ""))


def decimal_json(value: Decimal) -> int | float:
    return int(value) if value == value.to_integral_value() else float(value)


def normalized(value: object) -> str:
    return " ".join(str(value or "").strip().upper().split())


def category(demand_type: str) -> str:
    if demand_type == "PB":
        return "PB"
    if demand_type == "국내":
        return "국내"
    if demand_type.startswith("안전("):
        return "안전재고"
    if demand_type in {"이니셜", "해외"}:
        return "해외"
    return "기타"


def months_before(value: date, months: int) -> date:
    month_index = value.year * 12 + value.month - 1 - months
    year, zero_based_month = divmod(month_index, 12)
    month = zero_based_month + 1
    return date(year, month, min(value.day, monthrange(year, month)[1]))


def fetch_filtered_or_full(path: str, filtered: dict[str, object]) -> tuple[dict, bool]:
    try:
        payload = fetch_json(path, {**filtered, "limit": 0})
        if payload.get("rows"):
            return payload, True
    except Exception:
        pass
    return fetch_json(path, {"limit": 0}), False


def collect_bom() -> dict:
    products_payload, product_filter_applied = fetch_filtered_or_full(
        "/api/product-names", {"nm_cd": "P", "use_yn": "Y"}
    )
    bom_payload, bom_filter_applied = fetch_filtered_or_full(
        "/api/bom-explosion", {"root_cd": "P", "child_cd": "BS", "lvl": 1, "use_yn": "Y"}
    )
    if products_payload.get("truncated") or bom_payload.get("truncated"):
        raise RuntimeError("제품 또는 BOM API 응답이 잘렸습니다.")

    products = {
        str(row.get("nm_cd") or "").upper(): row
        for row in products_payload.get("rows") or []
        if PCODE.fullmatch(str(row.get("nm_cd") or ""))
        and str(row.get("use_yn") or "").upper() == "Y"
    }
    mappings: dict[tuple[str, str, str], dict] = {}
    for row in bom_payload.get("rows") or []:
        product_code = str(row.get("root_cd") or "").upper().strip()
        parent_code = str(row.get("parent_cd") or "").upper().strip()
        lidding_code = str(row.get("child_cd") or "").upper().strip()
        lidding_name = str(row.get("child_nm") or "").strip()
        specification = str(row.get("child_spec") or "").strip()
        if product_code not in products or parent_code != product_code or int(row.get("lvl") or 0) != 1:
            continue
        if not lidding_code.startswith("BS") or not LIDDING_NAME.search(lidding_name):
            continue
        if str(row.get("use_yn") or "").upper() != "Y":
            continue
        key = (product_code, lidding_code, specification)
        current = mappings.setdefault(
            key,
            {
                "productCode": product_code,
                "productName": str(products[product_code].get("nm_nm") or row.get("parent_nm") or "").strip(),
                "liddingCode": lidding_code,
                "liddingName": lidding_name,
                "liddingSpecification": specification,
                "requirementQty": Decimal("0"),
                "bomLevel": 1,
                "statusCode": row.get("stts"),
                "useYn": row.get("use_yn"),
            },
        )
        current["requirementQty"] = max(current["requirementQty"], number(row.get("qty")))

    rows = sorted(mappings.values(), key=lambda row: (
        row["productCode"], row["liddingCode"], row["liddingSpecification"]
    ))
    signature_rows = [
        [row["productCode"], row["productName"], row["liddingCode"], row["liddingSpecification"],
         row["liddingName"], str(row["requirementQty"]), str(row["statusCode"]), str(row["useYn"])]
        for row in rows
    ]
    signature = hashlib.sha256(
        json.dumps(signature_rows, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    previous = read_json(DATA_DIR / "bom-product-lidding.json", {})
    mapped_products = {row["productCode"] for row in rows}
    return {
        "generatedAt": now_text(),
        "sourceSignature": signature,
        "productSourceCount": products_payload.get("total_count"),
        "bomSourceCount": bom_payload.get("total_count"),
        "activePProductCount": len(products),
        "productApiFilterApplied": product_filter_applied,
        "bomApiFilterApplied": bom_filter_applied,
        "storageScope": "active P-code + level-1 active BS lidding only",
        "mappingCount": len(rows),
        "mappedProductCount": len(mapped_products),
        "liddingCodeCount": len({row["liddingCode"] for row in rows}),
        "specificationVersionCount": len({(row["liddingCode"], row["liddingSpecification"]) for row in rows}),
        "unmappedProductCount": len(products) - len(mapped_products),
        "rows": [{**row, "requirementQty": decimal_json(row["requirementQty"])} for row in rows],
        "changed": signature != (previous.get("sourceSignature") if isinstance(previous, dict) else None),
    }


def collect_inventory() -> dict:
    collected: list[dict] = []
    channel_status: list[dict] = []
    for warehouse_code, warehouse_name in WAREHOUSES:
        payload = fetch_json(
            "/api/warehouse-item-stock", {"wh_cd": warehouse_code, "itm_cd": "BS", "limit": 0}, 180
        )
        if payload.get("truncated"):
            raise RuntimeError(f"{warehouse_name} API 응답이 잘렸습니다.")
        source_rows = payload.get("rows") or []
        grouped: dict[str, dict] = {}
        for row in source_rows:
            item_code = str(row.get("itm_cd") or "").strip()
            if str(row.get("wh_cd") or "") != warehouse_code or not item_code.upper().startswith("BS"):
                continue
            if not LIDDING_NAME.search(str(row.get("itm_nm") or "")):
                continue
            current = grouped.setdefault(
                item_code,
                {
                    "snapshotDate": row.get("std_dt") or datetime.now(KST).date().isoformat(),
                    "warehouseCode": warehouse_code,
                    "warehouseName": warehouse_name,
                    "itemCode": item_code,
                    "itemName": str(row.get("itm_nm") or "").strip(),
                    "specification": str(row.get("spec") or "").strip(),
                    "stockQty": Decimal("0"),
                    "inspectionWaitQty": Decimal("0"),
                },
            )
            current["stockQty"] += number(row.get("stock_qty"))
            current["inspectionWaitQty"] = max(current["inspectionWaitQty"], number(row.get("stay_qty")))
        collected.extend(grouped.values())
        channel_status.append({
            "warehouseCode": warehouse_code,
            "warehouseName": warehouse_name,
            "sourceRows": len(source_rows),
            "liddingRows": len(grouped),
            "truncated": False,
        })

    by_item: dict[str, list[dict]] = defaultdict(list)
    for row in collected:
        by_item[row["itemCode"]].append(row)
    summary_rows = []
    for item_code, item_rows in sorted(by_item.items()):
        representative = item_rows[0]
        warehouse_map = {row["warehouseCode"]: row for row in item_rows}
        warehouses = []
        for warehouse_code, warehouse_name in WAREHOUSES:
            row = warehouse_map.get(warehouse_code)
            warehouses.append({
                "warehouseCode": warehouse_code,
                "warehouseName": warehouse_name,
                "stockQty": decimal_json(row["stockQty"]) if row else 0,
                "inspectionWaitQty": decimal_json(row["inspectionWaitQty"]) if row else 0,
                "hasSourceRow": row is not None,
            })
        summary_rows.append({
            "itemCode": item_code,
            "itemName": representative["itemName"],
            "specification": representative["specification"],
            "stockQty": decimal_json(sum((row["stockQty"] for row in item_rows), Decimal("0"))),
            "inspectionWaitQty": decimal_json(max((row["inspectionWaitQty"] for row in item_rows), default=Decimal("0"))),
            "warehouses": warehouses,
            "note": "검사대기는 창고 간 반복되는 API 공통값으로 중복 합산하지 않음",
        })
    return {
        "generatedAt": now_text(),
        "snapshotDate": max((row["snapshotDate"] for row in collected), default=datetime.now(KST).date().isoformat()),
        "warehouseOptions": [{"code": code, "name": name} for code, name in WAREHOUSES],
        "itemCount": len(summary_rows),
        "sourceRowCount": len(collected),
        "inspectionAggregation": "max-per-item",
        "status": {"warehouses": channel_status},
        "rows": summary_rows,
    }


def collect_purchase(inventory: dict) -> dict:
    today = datetime.now(KST).date()
    date_from = os.environ.get("LFP_PURCHASE_DATE_FROM", months_before(today, 2).isoformat())
    date_to = os.environ.get("LFP_PURCHASE_DATE_TO", today.isoformat())
    params = {"date_from": date_from, "date_to": date_to, "itm_cd": "BS", "limit": 0}
    with ThreadPoolExecutor(max_workers=2) as executor:
        request_future = executor.submit(fetch_json, "/api/purchase-requests", params)
        order_future = executor.submit(fetch_json, "/api/purchase-order-status", params)
        request_payload = request_future.result()
        order_payload = order_future.result()
    request_source_rows = validated_rows("구매 의뢰 현황", request_payload)
    order_source_rows = validated_rows("구매 발주 현황", order_payload)
    lidding_keys = {
        (normalized(row.get("itemCode")), normalized(row.get("specification")))
        for row in inventory.get("rows") or []
    }
    if not lidding_keys:
        raise RuntimeError("리드지 재고 기준키가 없습니다.")

    request_rows = []
    request_formula_mismatches = 0
    for row in request_source_rows:
        item_code = normalized(row.get("itm_cd"))
        specification = normalized(row.get("spec"))
        if (item_code, specification) not in lidding_keys:
            continue
        request_qty = number(row.get("req_qty"))
        purchase_order_qty = number(row.get("po_tot"))
        not_ordered_qty = number(row.get("not_inqty"))
        if not_ordered_qty != max(request_qty - purchase_order_qty, Decimal("0")):
            request_formula_mismatches += 1
        request_rows.append({
            "request_no": str(row.get("req_no") or "").strip(),
            "request_seq": int(row.get("req_sq") or 0),
            "request_date": row.get("req_dt") or None,
            "item_code": item_code,
            "item_name": str(row.get("itm_nm") or "").strip(),
            "specification": specification,
            "request_qty": request_qty,
            "purchase_order_qty": purchase_order_qty,
            "not_ordered_qty": not_ordered_qty,
            "requested_delivery_date": row.get("dlv_dt") or None,
            "request_status_name": row.get("stat_bc_nm"),
            "approval_status": row.get("gw_stat"),
        })

    order_rows = []
    order_formula_mismatches = 0
    for row in order_source_rows:
        item_code = normalized(row.get("itm_cd"))
        specification = normalized(row.get("spec") or row.get("specc"))
        if (item_code, specification) not in lidding_keys:
            continue
        purchase_order_qty = number(row.get("po_qty"))
        provisional_receipt_qty = number(row.get("dlv_qty"))
        remaining_qty = number(row.get("rem_qty"))
        if remaining_qty != max(purchase_order_qty - provisional_receipt_qty, Decimal("0")):
            order_formula_mismatches += 1
        order_rows.append({
            "purchase_order_no": str(row.get("po_no") or "").strip(),
            "purchase_order_seq": int(row.get("po_sq") or 0),
            "purchase_order_date": row.get("po_dt") or None,
            "request_no": str(row.get("req_no") or "").strip(),
            "request_seq": int(row.get("req_sq") or 0) or None,
            "item_code": item_code,
            "item_name": str(row.get("itm_nm") or "").strip(),
            "specification": specification,
            "purchase_order_qty": purchase_order_qty,
            "provisional_receipt_qty": provisional_receipt_qty,
            "received_qty": number(row.get("in_qty")),
            "remaining_qty": remaining_qty,
            "order_status_name": row.get("stat_bc_nm"),
            "delivery_date": row.get("dlv_dt") or None,
            "supplier_name": row.get("cust_nm"),
        })
    if request_formula_mismatches or order_formula_mismatches:
        raise RuntimeError(
            f"구매 수량 산식 불일치: 미발주={request_formula_mismatches}, 미납={order_formula_mismatches}"
        )

    grouped: dict[tuple[str, str], dict] = defaultdict(lambda: {
        "requestQty": Decimal("0"), "requestPurchaseOrderQty": Decimal("0"),
        "purchaseWaitQty": Decimal("0"), "purchaseOrderQty": Decimal("0"),
        "provisionalReceiptQty": Decimal("0"), "receivedQty": Decimal("0"),
        "inboundWaitQty": Decimal("0"), "requests": [], "purchaseOrders": [],
    })

    def item_for(row: dict) -> dict:
        item = grouped[(row["item_code"], row["specification"])]
        item["itemCode"] = row["item_code"]
        item["itemName"] = row["item_name"]
        item["specification"] = row["specification"]
        return item

    for row in request_rows:
        if row["approval_status"] != "Y" or row["request_status_name"] != "완료" or row["not_ordered_qty"] <= 0:
            continue
        item = item_for(row)
        item["requestQty"] += row["request_qty"]
        item["requestPurchaseOrderQty"] += row["purchase_order_qty"]
        item["purchaseWaitQty"] += row["not_ordered_qty"]
        item["requests"].append({
            "requestNo": row["request_no"], "requestSeq": row["request_seq"],
            "requestDate": row["request_date"], "requestedDeliveryDate": row["requested_delivery_date"],
            "requestQty": decimal_json(row["request_qty"]),
            "purchaseOrderQty": decimal_json(row["purchase_order_qty"]),
            "purchaseWaitQty": decimal_json(row["not_ordered_qty"]),
        })

    included_missing = []
    for row in order_rows:
        active = row["order_status_name"] in ACTIVE_ORDER_STATUSES and row["remaining_qty"] > 0
        if active and not row["request_no"]:
            included_missing.append(row)
        if not active:
            continue
        item = item_for(row)
        item["purchaseOrderQty"] += row["purchase_order_qty"]
        item["provisionalReceiptQty"] += row["provisional_receipt_qty"]
        item["receivedQty"] += row["received_qty"]
        item["inboundWaitQty"] += row["remaining_qty"]
        item["purchaseOrders"].append({
            "purchaseOrderNo": row["purchase_order_no"],
            "purchaseOrderSeq": row["purchase_order_seq"],
            "purchaseOrderDate": row["purchase_order_date"],
            "requestNo": row["request_no"], "requestSeq": row["request_seq"],
            "deliveryDate": row["delivery_date"],
            "purchaseOrderQty": decimal_json(row["purchase_order_qty"]),
            "provisionalReceiptQty": decimal_json(row["provisional_receipt_qty"]),
            "receivedQty": decimal_json(row["received_qty"]),
            "inboundWaitQty": decimal_json(row["remaining_qty"]),
            "orderStatus": row["order_status_name"], "supplierName": row["supplier_name"],
        })

    items = []
    for item in grouped.values():
        requests = sorted(item.pop("requests"), key=lambda row: (row["requestedDeliveryDate"] or "9999-12-31", row["requestNo"]))
        orders = sorted(item.pop("purchaseOrders"), key=lambda row: (row["deliveryDate"] or "9999-12-31", row["purchaseOrderNo"]))
        request_dates = [row["requestedDeliveryDate"] for row in requests if row["requestedDeliveryDate"]]
        order_dates = [row["deliveryDate"] for row in orders if row["deliveryDate"]]
        items.append({
            **{key: decimal_json(value) if isinstance(value, Decimal) else value for key, value in item.items()},
            "openRequestCount": len(requests), "openPurchaseOrderCount": len(orders),
            "nextRequestedDeliveryDate": min(request_dates) if request_dates else None,
            "nextOrderDeliveryDate": min(order_dates) if order_dates else None,
            "nextDeliveryDate": min(request_dates + order_dates) if request_dates + order_dates else None,
            "requests": requests, "purchaseOrders": orders,
        })
    items.sort(key=lambda row: (row["itemCode"], row["specification"]))
    inbound_total = sum((number(item["inboundWaitQty"]) for item in items), Decimal("0"))
    purchase_total = sum((number(item["purchaseWaitQty"]) for item in items), Decimal("0"))
    return {
        "collectedAt": now_text(), "queryDate": order_payload.get("query_date") or today.isoformat(),
        "dateFrom": date_from, "dateTo": date_to,
        "requestSourceRowCount": len(request_source_rows), "purchaseOrderSourceRowCount": len(order_source_rows),
        "matchedLiddingRequestRows": len(request_rows), "matchedLiddingPurchaseOrderRows": len(order_rows),
        "openLiddingItemCount": len(items),
        "inboundWaitItemCount": sum(1 for item in items if number(item["inboundWaitQty"]) > 0),
        "purchaseWaitItemCount": sum(1 for item in items if number(item["purchaseWaitQty"]) > 0),
        "inboundWaitTotal": decimal_json(inbound_total), "purchaseWaitTotal": decimal_json(purchase_total),
        "excludedMissingRequestNoRows": 0, "excludedMissingRequestNoQty": 0,
        "includedMissingRequestNoRows": len(included_missing),
        "includedMissingRequestNoQty": decimal_json(sum((row["remaining_qty"] for row in included_missing), Decimal("0"))),
        "formula": {
            "inboundWait": "sum(rem_qty) where stat_bc_nm in (발주, 납품진행), regardless of req_no or rmks",
            "purchaseWait": "sum(not_inqty) where gw_stat=Y and stat_bc_nm=완료",
            "grain": "item_code + specification", "requestLinkKey": "request_no + request_seq",
        },
        "items": items,
    }


def collect_aps(bom: dict) -> dict:
    payload = fetch_json("/api/aps-plan", {"oper": 45, "limit": 0}, 300)
    source_rows = validated_rows("APS", payload)
    bom_by_product: dict[str, list[dict]] = defaultdict(list)
    for row in bom.get("rows") or []:
        bom_by_product[str(row.get("productCode") or "").upper()].append(row)

    aggregates: dict[tuple[str, str], Decimal] = defaultdict(lambda: Decimal("0"))
    details = []
    for source_row_no, row in enumerate(source_rows, start=1):
        p_code = str(row.get("item_cd_5") or "").upper().strip()
        qty = number(row.get("plan_qty"))
        if not p_code.startswith("P") or qty <= 0:
            continue
        demand_type = str(row.get("demand_type") or "미분류").strip()
        aggregates[(p_code, demand_type)] += qty
        details.append({
            "sourceRowNo": source_row_no, "pCode": p_code,
            "demandType": demand_type, "demandCategory": category(demand_type),
            "demandId": str(row.get("demand_id") or "").strip(),
            "salesOrderNo": str(row.get("so_id") or "").strip(),
            "sequence": int(row.get("seq") or 0),
            "initial": str(row.get("initial") or "").strip(),
            "customerName": str(row.get("cust_name") or "").strip(),
            "dueDate": row.get("due_date") or None,
            "productionRequiredQty": qty,
        })

    category_totals: dict[str, Decimal] = defaultdict(lambda: Decimal("0"))
    requirements: dict[tuple[str, str], dict] = {}
    unmatched = set()
    source_refreshed_at = payload.get("source_refreshed_at")
    for (p_code, demand_type), qty in aggregates.items():
        category_totals[category(demand_type)] += qty
        mappings = bom_by_product.get(p_code, [])
        if not mappings:
            unmatched.add(p_code)
        due_dates = [str(row["dueDate"]) for row in details if row["pCode"] == p_code and row["demandType"] == demand_type and row["dueDate"]]
        for mapping in mappings:
            key = (str(mapping.get("liddingCode") or ""), str(mapping.get("liddingSpecification") or ""))
            target = requirements.setdefault(key, {
                "liddingCode": key[0], "liddingSpecification": key[1],
                "liddingName": str(mapping.get("liddingName") or ""),
                "productionRequiredQty": Decimal("0"), "linkedPCodes": set(),
                "dueDates": [], "sourceRefreshedAt": source_refreshed_at,
                "categoryQuantities": defaultdict(lambda: Decimal("0")), "orderGroups": {},
            })
            target["productionRequiredQty"] += qty
            target["linkedPCodes"].add(p_code)
            target["dueDates"].extend(due_dates)
            target["categoryQuantities"][category(demand_type)] += qty

    for detail in details:
        for mapping in bom_by_product.get(detail["pCode"], []):
            key = (str(mapping.get("liddingCode") or ""), str(mapping.get("liddingSpecification") or ""))
            target = requirements[key]
            group_key = (
                detail["pCode"], detail["demandCategory"], detail["demandType"], detail["demandId"],
                detail["salesOrderNo"], detail["sequence"], detail["initial"], detail["customerName"], detail["dueDate"],
            )
            order = target["orderGroups"].setdefault(group_key, {**detail, "productionRequiredQty": Decimal("0")})
            order["productionRequiredQty"] += detail["productionRequiredQty"]

    output_rows = []
    for target in requirements.values():
        sales_orders = []
        for order in target.pop("orderGroups").values():
            order.pop("sourceRowNo", None)
            order["productionRequiredQty"] = decimal_json(order["productionRequiredQty"])
            sales_orders.append(order)
        sales_orders.sort(key=lambda row: (row["dueDate"] or "9999-12-31", row["salesOrderNo"], row["sequence"], row["pCode"]))
        due_dates = target.pop("dueDates")
        linked = target.pop("linkedPCodes")
        quantities = target.pop("categoryQuantities")
        output_rows.append({
            **target,
            "productionRequiredQty": decimal_json(target["productionRequiredQty"]),
            "linkedPCodeCount": len(linked),
            "dueDateFrom": min(due_dates) if due_dates else None,
            "dueDateTo": max(due_dates) if due_dates else None,
            "categoryQuantities": {name: decimal_json(quantities.get(name, Decimal("0"))) for name in ("해외", "PB", "국내", "안전재고", "기타")},
            "salesOrders": sales_orders,
        })
    output_rows.sort(key=lambda row: (row["liddingCode"], row["liddingSpecification"]))
    return {
        "generatedAt": now_text(), "sourceRefreshedAt": source_refreshed_at,
        "sourceRowCount": payload.get("returned_count"), "sourceTotalQty": payload.get("total_plan_qty"),
        "pCodeDemandRows": len(aggregates),
        "categoryTotals": {name: decimal_json(value) for name, value in category_totals.items()},
        "liddingRequirementCount": len(output_rows), "unmatchedPCodes": sorted(unmatched), "rows": output_rows,
    }


def aps_source_version() -> str:
    payload = fetch_json("/api/aps-plan", {"oper": 45, "limit": 1}, 120)
    version = str(payload.get("source_refreshed_at") or "").strip()
    if not version:
        raise RuntimeError("APS source_refreshed_at 값이 없습니다.")
    return version


def publish_snapshot(scope: str) -> None:
    channels = {}
    for name, filename in {
        "aps": "aps-lidding-requirement.json", "inventory": "lidding-inventory.json",
        "purchase": "lidding-purchase-inbound.json", "bom": "bom-product-lidding.json",
    }.items():
        payload = read_json(DATA_DIR / filename, None)
        if not isinstance(payload, dict) or not payload:
            raise RuntimeError(f"대시보드 채널 파일이 없습니다: {filename}")
        channels[name] = payload
    atomic_write(DATA_DIR / "dashboard-snapshot.json", {
        "snapshotAt": now_text(), "scope": scope, "reason": "github_actions", "channels": channels,
    })


def write_status(scope: str, files: list[str]) -> None:
    path = DATA_DIR / "collection-status.json"
    previous = read_json(path, {})
    cutoff = datetime.now(KST) - timedelta(hours=48)
    history = []
    if isinstance(previous, dict):
        for item in previous.get("history") or []:
            try:
                if datetime.fromisoformat(str(item.get("at"))) >= cutoff:
                    history.append(item)
            except (TypeError, ValueError):
                continue
    entry = {"at": now_text(), "scope": scope, "status": "success", "files": files}
    history.append(entry)
    atomic_write(path, {"lastCollection": entry, "history": history})


def run(scope: str) -> bool:
    if scope == "aps-watch":
        current = read_json(DATA_DIR / "aps-lidding-requirement.json", {})
        observed = aps_source_version()
        if isinstance(current, dict) and str(current.get("sourceRefreshedAt") or "") == observed:
            print(json.dumps({"changed": False, "sourceRefreshedAt": observed}, ensure_ascii=False))
            return False
        scope = "all"

    written = []
    bom = read_json(DATA_DIR / "bom-product-lidding.json", {})
    inventory = read_json(DATA_DIR / "lidding-inventory.json", {})
    if scope in {"all", "aps", "bom"}:
        bom = collect_bom()
        atomic_write(DATA_DIR / "bom-product-lidding.json", bom)
        written.append("bom-product-lidding.json")
    if scope in {"all", "aps", "inventory"}:
        inventory = collect_inventory()
        atomic_write(DATA_DIR / "lidding-inventory.json", inventory)
        written.append("lidding-inventory.json")
    if scope in {"all", "aps", "inventory", "purchase"}:
        if not isinstance(inventory, dict) or not inventory:
            inventory = collect_inventory()
            atomic_write(DATA_DIR / "lidding-inventory.json", inventory)
            written.append("lidding-inventory.json")
        purchase = collect_purchase(inventory)
        atomic_write(DATA_DIR / "lidding-purchase-inbound.json", purchase)
        written.append("lidding-purchase-inbound.json")
    if scope in {"all", "aps", "bom"}:
        if not isinstance(bom, dict) or not bom:
            bom = collect_bom()
            atomic_write(DATA_DIR / "bom-product-lidding.json", bom)
            written.append("bom-product-lidding.json")
        aps = collect_aps(bom)
        atomic_write(DATA_DIR / "aps-lidding-requirement.json", aps)
        written.append("aps-lidding-requirement.json")
    publish_snapshot(scope)
    written.append("dashboard-snapshot.json")
    write_status(scope, sorted(set(written)))
    print(json.dumps({"changed": True, "scope": scope, "files": sorted(set(written))}, ensure_ascii=False))
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description="Collect the latest API data for the Git dashboard")
    parser.add_argument("--scope", choices=("aps-watch", "aps", "inventory", "purchase", "bom", "all"), default="all")
    args = parser.parse_args()
    run(args.scope)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
