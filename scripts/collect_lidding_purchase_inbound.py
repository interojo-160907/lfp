from __future__ import annotations

import json
import os
from calendar import monthrange
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timezone
from decimal import Decimal
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen

import psycopg
from psycopg.types.json import Jsonb

from io_utils import atomic_write_json


ROOT = Path(__file__).resolve().parents[1]
DDL_PATH = ROOT / "sql" / "006_lidding_purchase_inbound.sql"
OUTPUT_PATH = ROOT / "web" / "data" / "lidding-purchase-inbound.json"
API_BASE_URL = os.environ.get("LFP_API_BASE_URL", "https://plan.interojo.net").rstrip("/")
DATABASE_URL = os.environ.get("DATABASE_URL") or os.environ.get("LFP_DATABASE_URL")
ACTIVE_ORDER_STATUSES = {"발주", "납품진행"}
PURCHASE_REQUEST_ENDPOINT = "/api/purchase-requests"
PURCHASE_ORDER_ENDPOINT = "/api/purchase-order-status"


def fetch_json(path: str, params: dict[str, str]) -> dict:
    url = f"{API_BASE_URL}{path}?{urlencode(params)}"
    request = Request(
        url,
        headers={"Accept": "application/json", "User-Agent": "Lidding-Foil-Planner/0.2"},
    )
    with urlopen(request, timeout=180) as response:
        return json.load(response)


def validated_rows(name: str, payload: dict) -> list[dict]:
    rows = payload.get("rows") or []
    total_count = int(payload.get("total_count") or 0)
    returned_count = int(payload.get("returned_count") or len(rows))
    if payload.get("truncated"):
        raise RuntimeError(f"{name} API 응답이 잘렸습니다.")
    if returned_count != len(rows) or total_count != returned_count:
        raise RuntimeError(
            f"{name} API 건수 불일치: total={total_count}, returned={returned_count}, rows={len(rows)}"
        )
    return rows


def number(value: object) -> Decimal:
    if value in (None, ""):
        return Decimal("0")
    return Decimal(str(value))


def decimal_json(value: Decimal) -> int | float:
    return int(value) if value == value.to_integral_value() else float(value)


def normalized(value: object) -> str:
    return " ".join(str(value or "").strip().upper().split())


def months_before(value: date, months: int) -> date:
    month_index = value.year * 12 + value.month - 1 - months
    year, zero_based_month = divmod(month_index, 12)
    month = zero_based_month + 1
    return date(year, month, min(value.day, monthrange(year, month)[1]))


def get_item(grouped: dict[tuple[str, str], dict], row: dict) -> dict:
    key = (row["item_code"], row["specification"])
    item = grouped[key]
    item["itemCode"] = row["item_code"]
    item["itemName"] = row["item_name"]
    item["specification"] = row["specification"]
    return item


def collect() -> tuple[list[dict], dict]:
    if not DATABASE_URL:
        raise RuntimeError("DATABASE_URL 또는 LFP_DATABASE_URL이 필요합니다.")

    today = date.today()
    date_from = os.environ.get("LFP_PURCHASE_DATE_FROM", months_before(today, 2).isoformat())
    date_to = os.environ.get("LFP_PURCHASE_DATE_TO", today.isoformat())
    params = {"date_from": date_from, "date_to": date_to, "itm_cd": "BS", "limit": "0"}
    with ThreadPoolExecutor(max_workers=2) as executor:
        request_future = executor.submit(fetch_json, PURCHASE_REQUEST_ENDPOINT, params)
        order_future = executor.submit(fetch_json, PURCHASE_ORDER_ENDPOINT, params)
        request_payload = request_future.result()
        order_payload = order_future.result()

    request_source_rows = validated_rows("구매 의뢰 현황", request_payload)
    order_source_rows = validated_rows("구매 발주 현황", order_payload)
    snapshot_at = datetime.now(timezone.utc)

    with psycopg.connect(DATABASE_URL) as connection:
        with connection.cursor() as cursor:
            cursor.execute(DDL_PATH.read_text(encoding="utf-8"))
            cursor.execute(
                """
                select distinct upper(trim(item_code)), upper(trim(specification))
                from lidding_foil_planner.lidding_inventory_snapshot
                where snapshot_date = (
                    select max(snapshot_date)
                    from lidding_foil_planner.lidding_inventory_snapshot
                )
                """
            )
            lidding_keys = {(normalized(code), normalized(spec)) for code, spec in cursor.fetchall()}
            if not lidding_keys:
                raise RuntimeError("최신 리드지 재고 기준키가 없습니다.")

            request_rows: list[dict] = []
            request_formula_mismatches = 0
            for row in request_source_rows:
                item_code = normalized(row.get("itm_cd"))
                specification = normalized(row.get("spec"))
                if (item_code, specification) not in lidding_keys:
                    continue

                request_qty = number(row.get("req_qty"))
                purchase_order_qty = number(row.get("po_tot"))
                not_ordered_qty = number(row.get("not_inqty"))
                expected_not_ordered = max(request_qty - purchase_order_qty, Decimal("0"))
                if not_ordered_qty != expected_not_ordered:
                    request_formula_mismatches += 1
                request_rows.append(
                    {
                        "snapshot_at": snapshot_at,
                        "request_no": str(row.get("req_no") or "").strip(),
                        "request_seq": int(row.get("req_sq") or 0),
                        "request_date": row.get("req_dt") or None,
                        "item_id": row.get("itm_id"),
                        "item_code": item_code,
                        "item_name": str(row.get("itm_nm") or "").strip(),
                        "specification": specification,
                        "request_qty": request_qty,
                        "purchase_order_qty": purchase_order_qty,
                        "received_qty": number(row.get("in_qty")),
                        "not_ordered_qty": not_ordered_qty,
                        "requested_delivery_date": row.get("dlv_dt") or None,
                        "request_status_code": row.get("stat_bc"),
                        "request_status_name": row.get("stat_bc_nm"),
                        "approval_status": row.get("gw_stat"),
                        "approval_status_name": row.get("gw_stat_label"),
                        "supplier_code": row.get("cust_cd"),
                        "supplier_name": row.get("cust_nm"),
                        "requester_name": row.get("fr_nm"),
                        "request_department": row.get("fr_dept_nm"),
                        "source_payload": row,
                    }
                )

            order_rows: list[dict] = []
            order_formula_mismatches = 0
            for row in order_source_rows:
                item_code = normalized(row.get("itm_cd"))
                specification = normalized(row.get("spec") or row.get("specc"))
                if (item_code, specification) not in lidding_keys:
                    continue

                purchase_order_qty = number(row.get("po_qty"))
                provisional_receipt_qty = number(row.get("dlv_qty"))
                remaining_qty = number(row.get("rem_qty"))
                expected_remaining = max(purchase_order_qty - provisional_receipt_qty, Decimal("0"))
                if remaining_qty != expected_remaining:
                    order_formula_mismatches += 1
                order_rows.append(
                    {
                        "snapshot_at": snapshot_at,
                        "purchase_order_no": str(row.get("po_no") or "").strip(),
                        "purchase_order_seq": int(row.get("po_sq") or 0),
                        "purchase_order_date": row.get("po_dt") or None,
                        "request_no": str(row.get("req_no") or "").strip(),
                        "request_seq": int(row.get("req_sq") or 0) or None,
                        "item_id": row.get("itm_id"),
                        "item_code": item_code,
                        "item_name": str(row.get("itm_nm") or "").strip(),
                        "specification": specification,
                        "purchase_order_qty": purchase_order_qty,
                        "provisional_receipt_qty": provisional_receipt_qty,
                        "received_qty": number(row.get("in_qty")),
                        "remaining_qty": remaining_qty,
                        "order_status_code": row.get("stat_bc"),
                        "order_status_name": row.get("stat_bc_nm"),
                        "delivery_date": row.get("dlv_dt") or None,
                        "supplier_code": row.get("cust_cd"),
                        "supplier_name": row.get("cust_nm"),
                        "remark": str(row.get("rmks") or "").strip(),
                        "source_payload": row,
                    }
                )

            if request_formula_mismatches or order_formula_mismatches:
                raise RuntimeError(
                    "구매 수량 산식 불일치: "
                    f"미발주={request_formula_mismatches}, 미납={order_formula_mismatches}"
                )

            # DMZ에는 화면 응답용 최신 현재본만 유지하고 이력은 ZIP 스냅샷으로 보관한다.
            cursor.execute("delete from lidding_foil_planner.purchase_request_snapshot")
            cursor.execute("delete from lidding_foil_planner.purchase_order_snapshot")
            cursor.executemany(
                """
                insert into lidding_foil_planner.purchase_request_snapshot (
                    snapshot_at, request_no, request_seq, request_date,
                    item_id, item_code, item_name, specification,
                    request_qty, purchase_order_qty, received_qty, not_ordered_qty,
                    requested_delivery_date, request_status_code, request_status_name,
                    approval_status, approval_status_name, supplier_code, supplier_name,
                    requester_name, request_department, source_endpoint, source_payload
                ) values (
                    %s, %s, %s, %s,
                    %s, %s, %s, %s,
                    %s, %s, %s, %s,
                    %s, %s, %s,
                    %s, %s, %s, %s,
                    %s, %s, %s, %s
                )
                """,
                [
                    (
                        row["snapshot_at"], row["request_no"], row["request_seq"], row["request_date"],
                        row["item_id"], row["item_code"], row["item_name"], row["specification"],
                        row["request_qty"], row["purchase_order_qty"], row["received_qty"],
                        row["not_ordered_qty"], row["requested_delivery_date"],
                        row["request_status_code"], row["request_status_name"],
                        row["approval_status"], row["approval_status_name"],
                        row["supplier_code"], row["supplier_name"], row["requester_name"],
                        row["request_department"], f"{API_BASE_URL}{PURCHASE_REQUEST_ENDPOINT}",
                        Jsonb(row["source_payload"]),
                    )
                    for row in request_rows
                ],
            )
            cursor.executemany(
                """
                insert into lidding_foil_planner.purchase_order_snapshot (
                    snapshot_at, purchase_order_no, purchase_order_seq, purchase_order_date,
                    request_no, request_seq, item_id, item_code, item_name, specification,
                    purchase_order_qty, provisional_receipt_qty, received_qty, remaining_qty,
                    order_status_code, order_status_name, delivery_date,
                    supplier_code, supplier_name, remark, source_endpoint, source_payload
                ) values (
                    %s, %s, %s, %s,
                    %s, %s, %s, %s, %s, %s,
                    %s, %s, %s, %s,
                    %s, %s, %s,
                    %s, %s, %s, %s, %s
                )
                """,
                [
                    (
                        row["snapshot_at"], row["purchase_order_no"], row["purchase_order_seq"],
                        row["purchase_order_date"], row["request_no"] or None, row["request_seq"],
                        row["item_id"], row["item_code"], row["item_name"], row["specification"],
                        row["purchase_order_qty"], row["provisional_receipt_qty"], row["received_qty"],
                        row["remaining_qty"], row["order_status_code"], row["order_status_name"],
                        row["delivery_date"], row["supplier_code"], row["supplier_name"],
                        row["remark"], f"{API_BASE_URL}{PURCHASE_ORDER_ENDPOINT}",
                        Jsonb(row["source_payload"]),
                    )
                    for row in order_rows
                ],
            )
        connection.commit()

    grouped: dict[tuple[str, str], dict] = defaultdict(
        lambda: {
            "requestQty": Decimal("0"),
            "requestPurchaseOrderQty": Decimal("0"),
            "purchaseWaitQty": Decimal("0"),
            "purchaseOrderQty": Decimal("0"),
            "provisionalReceiptQty": Decimal("0"),
            "receivedQty": Decimal("0"),
            "inboundWaitQty": Decimal("0"),
            "requests": [],
            "purchaseOrders": [],
        }
    )

    for row in request_rows:
        if row["approval_status"] != "Y" or row["request_status_name"] != "완료":
            continue
        if row["not_ordered_qty"] <= 0:
            continue
        item = get_item(grouped, row)
        item["requestQty"] += row["request_qty"]
        item["requestPurchaseOrderQty"] += row["purchase_order_qty"]
        item["purchaseWaitQty"] += row["not_ordered_qty"]
        item["requests"].append(
            {
                "requestNo": row["request_no"],
                "requestSeq": row["request_seq"],
                "requestDate": row["request_date"],
                "requestedDeliveryDate": row["requested_delivery_date"],
                "requestQty": decimal_json(row["request_qty"]),
                "purchaseOrderQty": decimal_json(row["purchase_order_qty"]),
                "purchaseWaitQty": decimal_json(row["not_ordered_qty"]),
            }
        )

    included_missing_request_rows = []
    for row in order_rows:
        is_active = row["order_status_name"] in ACTIVE_ORDER_STATUSES and row["remaining_qty"] > 0
        if is_active and not row["request_no"]:
            included_missing_request_rows.append(row)
        if not is_active:
            continue
        item = get_item(grouped, row)
        item["purchaseOrderQty"] += row["purchase_order_qty"]
        item["provisionalReceiptQty"] += row["provisional_receipt_qty"]
        item["receivedQty"] += row["received_qty"]
        item["inboundWaitQty"] += row["remaining_qty"]
        item["purchaseOrders"].append(
            {
                "purchaseOrderNo": row["purchase_order_no"],
                "purchaseOrderSeq": row["purchase_order_seq"],
                "purchaseOrderDate": row["purchase_order_date"],
                "requestNo": row["request_no"],
                "requestSeq": row["request_seq"],
                "deliveryDate": row["delivery_date"],
                "purchaseOrderQty": decimal_json(row["purchase_order_qty"]),
                "provisionalReceiptQty": decimal_json(row["provisional_receipt_qty"]),
                "receivedQty": decimal_json(row["received_qty"]),
                "inboundWaitQty": decimal_json(row["remaining_qty"]),
                "orderStatus": row["order_status_name"],
                "supplierName": row["supplier_name"],
            }
        )

    items: list[dict] = []
    for item in grouped.values():
        requests = sorted(
            item.pop("requests"),
            key=lambda value: (value["requestedDeliveryDate"] or "9999-12-31", value["requestNo"]),
        )
        purchase_orders = sorted(
            item.pop("purchaseOrders"),
            key=lambda value: (value["deliveryDate"] or "9999-12-31", value["purchaseOrderNo"]),
        )
        request_dates = [value["requestedDeliveryDate"] for value in requests if value["requestedDeliveryDate"]]
        order_dates = [value["deliveryDate"] for value in purchase_orders if value["deliveryDate"]]
        all_delivery_dates = request_dates + order_dates
        items.append(
            {
                **item,
                "requestQty": decimal_json(item["requestQty"]),
                "requestPurchaseOrderQty": decimal_json(item["requestPurchaseOrderQty"]),
                "purchaseWaitQty": decimal_json(item["purchaseWaitQty"]),
                "purchaseOrderQty": decimal_json(item["purchaseOrderQty"]),
                "provisionalReceiptQty": decimal_json(item["provisionalReceiptQty"]),
                "receivedQty": decimal_json(item["receivedQty"]),
                "inboundWaitQty": decimal_json(item["inboundWaitQty"]),
                "openRequestCount": len(requests),
                "openPurchaseOrderCount": len(purchase_orders),
                "nextRequestedDeliveryDate": min(request_dates) if request_dates else None,
                "nextOrderDeliveryDate": min(order_dates) if order_dates else None,
                "nextDeliveryDate": min(all_delivery_dates) if all_delivery_dates else None,
                "requests": requests,
                "purchaseOrders": purchase_orders,
            }
        )
    items.sort(key=lambda value: (value["itemCode"], value["specification"]))

    inbound_total = sum((number(item["inboundWaitQty"]) for item in items), Decimal("0"))
    purchase_wait_total = sum((number(item["purchaseWaitQty"]) for item in items), Decimal("0"))
    included_missing_request_qty = sum(
        (row["remaining_qty"] for row in included_missing_request_rows), Decimal("0")
    )
    output = {
        "collectedAt": snapshot_at.isoformat(),
        "queryDate": order_payload.get("query_date") or request_payload.get("query_date") or today.isoformat(),
        "dateFrom": date_from,
        "dateTo": date_to,
        "requestSourceRowCount": len(request_source_rows),
        "purchaseOrderSourceRowCount": len(order_source_rows),
        "matchedLiddingRequestRows": len(request_rows),
        "matchedLiddingPurchaseOrderRows": len(order_rows),
        "openLiddingItemCount": len(items),
        "inboundWaitItemCount": sum(1 for item in items if number(item["inboundWaitQty"]) > 0),
        "purchaseWaitItemCount": sum(1 for item in items if number(item["purchaseWaitQty"]) > 0),
        "inboundWaitTotal": decimal_json(inbound_total),
        "purchaseWaitTotal": decimal_json(purchase_wait_total),
        "excludedMissingRequestNoRows": 0,
        "excludedMissingRequestNoQty": 0,
        "includedMissingRequestNoRows": len(included_missing_request_rows),
        "includedMissingRequestNoQty": decimal_json(included_missing_request_qty),
        "formula": {
            "inboundWait": "sum(rem_qty) where stat_bc_nm in (발주, 납품진행), regardless of req_no or rmks",
            "purchaseWait": "sum(not_inqty) where gw_stat=Y and stat_bc_nm=완료",
            "grain": "item_code + specification",
            "requestLinkKey": "request_no + request_seq",
        },
        "items": items,
    }
    return items, output


def main() -> int:
    items, output = collect()
    atomic_write_json(OUTPUT_PATH, output)
    print(
        json.dumps(
            {
                "output": str(OUTPUT_PATH),
                "openItemCount": len(items),
                "inboundWaitTotal": output["inboundWaitTotal"],
                "purchaseWaitTotal": output["purchaseWaitTotal"],
                "includedMissingRequestNoQty": output["includedMissingRequestNoQty"],
                "matchedRequestRows": output["matchedLiddingRequestRows"],
                "matchedPurchaseOrderRows": output["matchedLiddingPurchaseOrderRows"],
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
