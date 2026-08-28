from __future__ import annotations

import json
import os
import sys
from collections import defaultdict
from datetime import datetime
from decimal import Decimal
from pathlib import Path
from urllib.request import Request, urlopen

import psycopg
from psycopg.types.json import Jsonb
from io_utils import atomic_write_json


ROOT = Path(__file__).resolve().parents[1]
DDL_PATH = ROOT / "sql" / "005_aps_hydration_requirement.sql"
OUTPUT_PATH = ROOT / "web" / "data" / "aps-lidding-requirement.json"
API_BASE_URL = os.environ.get("LFP_API_BASE_URL", "https://plan.interojo.net").rstrip("/")
DATABASE_URL = os.environ.get("DATABASE_URL") or os.environ.get("LFP_DATABASE_URL")


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


def fetch_aps() -> dict:
    request = Request(
        f"{API_BASE_URL}/api/aps-plan?oper=45&limit=0",
        headers={"Accept": "application/json", "User-Agent": "Lidding-Foil-Planner/0.1"},
    )
    with urlopen(request, timeout=180) as response:
        payload = json.load(response)
    if payload.get("truncated"):
        raise RuntimeError("APS 하이드레이션 API 응답이 잘렸습니다.")
    return payload


def aggregate(payload: dict) -> list[dict]:
    groups: dict[tuple[str, str], dict] = {}
    for row in payload.get("rows") or []:
        p_code = str(row.get("item_cd_5") or "").upper().strip()
        demand_type = str(row.get("demand_type") or "미분류").strip()
        qty = Decimal(str(row.get("plan_qty") or 0))
        if not p_code.startswith("P") or qty <= 0:
            continue
        key = (p_code, demand_type)
        current = groups.setdefault(key, {
            "p_code": p_code,
            "demand_type": demand_type,
            "demand_category": category(demand_type),
            "production_required_qty": Decimal("0"),
            "source_row_count": 0,
            "due_dates": [],
            "sample": row,
        })
        current["production_required_qty"] += qty
        current["source_row_count"] += 1
        if row.get("due_date"):
            current["due_dates"].append(str(row["due_date"]))
    return sorted(groups.values(), key=lambda row: (row["p_code"], row["demand_type"]))


def order_details(payload: dict) -> list[dict]:
    details = []
    for source_row_no, row in enumerate(payload.get("rows") or [], start=1):
        p_code = str(row.get("item_cd_5") or "").upper().strip()
        qty = Decimal(str(row.get("plan_qty") or 0))
        if not p_code.startswith("P") or qty <= 0:
            continue
        demand_type = str(row.get("demand_type") or "미분류").strip()
        details.append({
            "source_row_no": source_row_no,
            "p_code": p_code,
            "demand_type": demand_type,
            "demand_category": category(demand_type),
            "demand_id": str(row.get("demand_id") or "").strip(),
            "so_id": str(row.get("so_id") or "").strip(),
            "order_seq": int(row.get("seq") or 0),
            "initial_name": str(row.get("initial") or "").strip(),
            "customer_id": str(row.get("cust_id") or "").strip(),
            "customer_name": str(row.get("cust_name") or "").strip(),
            "plan_date": row.get("plan_date") or None,
            "due_date": row.get("due_date") or None,
            "target_datetime": row.get("target_datetime") or None,
            "production_required_qty": qty,
            "demand_qty": Decimal(str(row.get("demand_qty") or 0)),
            "source_payload": row,
        })
    return details


def decimal_json(value: Decimal) -> int | float:
    return int(value) if value == value.to_integral_value() else float(value)


def write_database(payload: dict, rows: list[dict], detail_rows: list[dict]) -> tuple[list[dict], list[str]]:
    if not DATABASE_URL:
        raise RuntimeError("DATABASE_URL 또는 LFP_DATABASE_URL이 필요합니다.")

    source_refreshed_at = payload.get("source_refreshed_at") or f"{payload.get('query_date')} 00:00:00"
    plan_date = payload.get("plan_date_from") or payload.get("query_date")
    ddl = DDL_PATH.read_text(encoding="utf-8")
    with psycopg.connect(DATABASE_URL) as connection:
        with connection.cursor() as cursor:
            cursor.execute(ddl)
            cursor.execute("delete from lidding_foil_planner.aps_hydration_pcode")
            cursor.execute("delete from lidding_foil_planner.aps_hydration_order_detail")
            cursor.executemany(
                """
                insert into lidding_foil_planner.aps_hydration_pcode (
                    source_refreshed_at, plan_date, p_code, demand_type, demand_category,
                    production_required_qty, source_row_count, due_date_from, due_date_to,
                    source_sample
                ) values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                """,
                [
                    (
                        source_refreshed_at, plan_date, row["p_code"], row["demand_type"],
                        row["demand_category"], row["production_required_qty"],
                        row["source_row_count"], min(row["due_dates"]) if row["due_dates"] else None,
                        max(row["due_dates"]) if row["due_dates"] else None, Jsonb(row["sample"]),
                    )
                    for row in rows
                ],
            )
            cursor.executemany(
                """
                insert into lidding_foil_planner.aps_hydration_order_detail (
                    source_refreshed_at, source_row_no, p_code, demand_type, demand_category,
                    demand_id, so_id, order_seq, initial_name, customer_id, customer_name,
                    plan_date, due_date, target_datetime, production_required_qty,
                    demand_qty, source_payload
                ) values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                """,
                [
                    (
                        source_refreshed_at, row["source_row_no"], row["p_code"],
                        row["demand_type"], row["demand_category"], row["demand_id"],
                        row["so_id"], row["order_seq"], row["initial_name"],
                        row["customer_id"], row["customer_name"], row["plan_date"],
                        row["due_date"], row["target_datetime"],
                        row["production_required_qty"], row["demand_qty"],
                        Jsonb(row["source_payload"]),
                    )
                    for row in detail_rows
                ],
            )
            cursor.execute(
                """
                select lidding_code, lidding_specification, lidding_name,
                       production_required_qty, linked_p_code_count,
                       due_date_from, due_date_to, source_refreshed_at
                from lidding_foil_planner.v_lidding_aps_requirement
                order by lidding_code, lidding_specification
                """
            )
            requirements = [
                {
                    "liddingCode": record[0],
                    "liddingSpecification": record[1],
                    "liddingName": record[2],
                    "productionRequiredQty": decimal_json(record[3]),
                    "linkedPCodeCount": record[4],
                    "dueDateFrom": record[5].isoformat() if record[5] else None,
                    "dueDateTo": record[6].isoformat() if record[6] else None,
                    "sourceRefreshedAt": record[7].isoformat(sep=" "),
                }
                for record in cursor.fetchall()
            ]
            requirement_map = {
                (row["liddingCode"], row["liddingSpecification"]): row
                for row in requirements
            }
            for row in requirements:
                row["categoryQuantities"] = {"해외": 0, "PB": 0, "국내": 0, "안전재고": 0}
                row["salesOrders"] = []
            cursor.execute(
                """
                select lidding_code, lidding_specification, demand_category,
                       production_required_qty
                from lidding_foil_planner.v_lidding_aps_requirement_by_category
                order by lidding_code, lidding_specification, demand_category
                """
            )
            for lidding_code, specification, demand_category, required_qty in cursor.fetchall():
                target = requirement_map.get((lidding_code, specification))
                if target:
                    target["categoryQuantities"][demand_category] = decimal_json(required_qty)
            cursor.execute(
                """
                select lidding_code, lidding_specification, p_code, demand_category,
                       demand_type, demand_id, so_id, order_seq, initial_name,
                       customer_name, due_date, production_required_qty
                from lidding_foil_planner.v_lidding_aps_order_detail
                order by lidding_code, lidding_specification, due_date nulls last,
                         so_id, order_seq, p_code
                """
            )
            for record in cursor.fetchall():
                target = requirement_map.get((record[0], record[1]))
                if target:
                    target["salesOrders"].append({
                        "pCode": record[2],
                        "demandCategory": record[3],
                        "demandType": record[4],
                        "demandId": record[5],
                        "salesOrderNo": record[6],
                        "sequence": record[7],
                        "initial": record[8],
                        "customerName": record[9],
                        "dueDate": record[10].isoformat() if record[10] else None,
                        "productionRequiredQty": decimal_json(record[11]),
                    })
            cursor.execute(
                """
                select distinct a.p_code
                from lidding_foil_planner.v_aps_hydration_latest a
                left join lidding_foil_planner.bom_product_lidding b on b.product_code = a.p_code
                where b.product_code is null
                order by a.p_code
                """
            )
            unmatched = [record[0] for record in cursor.fetchall()]
    return requirements, unmatched


def main() -> int:
    payload = fetch_aps()
    aggregates = aggregate(payload)
    detail_rows = order_details(payload)
    requirements, unmatched = write_database(payload, aggregates, detail_rows)
    category_totals: dict[str, Decimal] = defaultdict(lambda: Decimal("0"))
    for row in aggregates:
        category_totals[row["demand_category"]] += row["production_required_qty"]
    output = {
        "generatedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
        "sourceRefreshedAt": payload.get("source_refreshed_at"),
        "sourceRowCount": payload.get("returned_count"),
        "sourceTotalQty": payload.get("total_plan_qty"),
        "pCodeDemandRows": len(aggregates),
        "categoryTotals": {key: decimal_json(value) for key, value in category_totals.items()},
        "liddingRequirementCount": len(requirements),
        "unmatchedPCodes": unmatched,
        "rows": requirements,
    }
    atomic_write_json(OUTPUT_PATH, output)
    print(json.dumps({
        "sourceRows": output["sourceRowCount"],
        "sourceTotalQty": output["sourceTotalQty"],
        "pCodeDemandRows": output["pCodeDemandRows"],
        "liddingRequirements": output["liddingRequirementCount"],
        "unmatchedPCodes": len(unmatched),
        "categoryTotals": output["categoryTotals"],
        "output": str(OUTPUT_PATH),
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
