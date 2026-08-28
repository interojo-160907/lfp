from __future__ import annotations

import json
import os
import re
import sys
from collections import defaultdict
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen

import psycopg
from psycopg.types.json import Jsonb
from io_utils import atomic_write_json


ROOT = Path(__file__).resolve().parents[1]
DDL_PATH = ROOT / "sql" / "003_lidding_inventory.sql"
OUTPUT_PATH = ROOT / "web" / "data" / "lidding-inventory.json"
API_BASE_URL = os.environ.get("LFP_API_BASE_URL", "https://plan.interojo.net").rstrip("/")
DATABASE_URL = os.environ.get("DATABASE_URL") or os.environ.get("LFP_DATABASE_URL")
LIDDING_NAME = re.compile(r"리드지|lidding|foil", re.IGNORECASE)

WAREHOUSES = (
    ("300", "L관창고(자재)"),
    ("P010", "A관 공정부자재"),
    ("P030", "C관 공정부자재"),
    ("S100", "S관 공정부자재"),
)


def fetch_json(path: str, params: dict[str, str]) -> dict:
    url = f"{API_BASE_URL}{path}?{urlencode(params)}"
    request = Request(url, headers={"Accept": "application/json", "User-Agent": "Lidding-Foil-Planner/0.1"})
    with urlopen(request, timeout=120) as response:
        return json.load(response)


def number(value: object) -> Decimal:
    if value in (None, ""):
        return Decimal("0")
    return Decimal(str(value))


def decimal_json(value: Decimal) -> int | float:
    return int(value) if value == value.to_integral_value() else float(value)


def collect() -> tuple[list[dict], dict]:
    collected: list[dict] = []
    channel_status: list[dict] = []

    for warehouse_code, warehouse_name in WAREHOUSES:
        payload = fetch_json(
            "/api/warehouse-item-stock",
            {"wh_cd": warehouse_code, "itm_cd": "BS", "limit": "0"},
        )
        if payload.get("truncated"):
            raise RuntimeError(f"{warehouse_name} API 응답이 잘렸습니다.")

        source_rows = payload.get("rows") or []
        lidding_rows = [
            row
            for row in source_rows
            if str(row.get("wh_cd") or "") == warehouse_code
            and str(row.get("itm_cd") or "").upper().startswith("BS")
            and LIDDING_NAME.search(str(row.get("itm_nm") or ""))
        ]

        grouped: dict[str, dict] = {}
        for row in lidding_rows:
            item_code = str(row.get("itm_cd") or "").strip()
            current = grouped.setdefault(
                item_code,
                {
                    "snapshot_date": row.get("std_dt") or date.today().isoformat(),
                    "warehouse_code": warehouse_code,
                    "warehouse_name": warehouse_name,
                    "factory_code": row.get("fac_cd"),
                    "factory_name": row.get("fac_nm"),
                    "item_id": row.get("itm_id"),
                    "item_code": item_code,
                    "item_name": str(row.get("itm_nm") or "").strip(),
                    "specification": str(row.get("spec") or "").strip(),
                    "unit_code": row.get("um_bc"),
                    "unit_name": row.get("um_bc_nm"),
                    "stock_qty": Decimal("0"),
                    "inspection_wait_qty": Decimal("0"),
                    "source_rows": [],
                },
            )
            current["stock_qty"] += number(row.get("stock_qty"))
            current["inspection_wait_qty"] = max(
                current["inspection_wait_qty"], number(row.get("stay_qty"))
            )
            current["source_rows"].append(row)

        collected.extend(grouped.values())
        channel_status.append(
            {
                "warehouseCode": warehouse_code,
                "warehouseName": warehouse_name,
                "sourceRows": len(source_rows),
                "liddingRows": len(grouped),
                "truncated": False,
            }
        )

    return collected, {"warehouses": channel_status}


def write_database(rows: list[dict]) -> int:
    if not DATABASE_URL:
        raise RuntimeError("DATABASE_URL 또는 LFP_DATABASE_URL이 필요합니다.")

    ddl = DDL_PATH.read_text(encoding="utf-8")
    snapshot_dates = sorted({row["snapshot_date"] for row in rows})
    warehouse_codes = [code for code, _ in WAREHOUSES]

    with psycopg.connect(DATABASE_URL) as connection:
        with connection.cursor() as cursor:
            cursor.execute(ddl)
            cursor.execute(
                """
                delete from lidding_foil_planner.lidding_inventory_snapshot
                where snapshot_date = any(%s::date[])
                  and warehouse_code = any(%s::text[])
                """,
                (snapshot_dates, warehouse_codes),
            )
            cursor.executemany(
                """
                insert into lidding_foil_planner.lidding_inventory_snapshot (
                    snapshot_date, warehouse_code, warehouse_name, factory_code, factory_name,
                    item_id, item_code, item_name, specification, unit_code, unit_name,
                    stock_qty, inspection_wait_qty, source_endpoint, source_payload
                ) values (
                    %s, %s, %s, %s, %s,
                    %s, %s, %s, %s, %s, %s,
                    %s, %s, %s, %s
                )
                """,
                [
                    (
                        row["snapshot_date"], row["warehouse_code"], row["warehouse_name"],
                        row["factory_code"], row["factory_name"], row["item_id"],
                        row["item_code"], row["item_name"], row["specification"],
                        row["unit_code"], row["unit_name"], row["stock_qty"],
                        row["inspection_wait_qty"],
                        f"{API_BASE_URL}/api/warehouse-item-stock",
                        Jsonb(row["source_rows"]),
                    )
                    for row in rows
                ],
            )
    return len(rows)


def build_dashboard_payload(rows: list[dict], status: dict) -> dict:
    by_item: dict[str, list[dict]] = defaultdict(list)
    for row in rows:
        by_item[row["item_code"]].append(row)

    summary_rows = []
    for item_code, item_rows in sorted(by_item.items()):
        representative = item_rows[0]
        warehouse_map = {row["warehouse_code"]: row for row in item_rows}
        warehouse_details = []
        for warehouse_code, warehouse_name in WAREHOUSES:
            row = warehouse_map.get(warehouse_code)
            warehouse_details.append(
                {
                    "warehouseCode": warehouse_code,
                    "warehouseName": warehouse_name,
                    "stockQty": decimal_json(row["stock_qty"]) if row else 0,
                    "inspectionWaitQty": decimal_json(row["inspection_wait_qty"]) if row else 0,
                    "hasSourceRow": row is not None,
                }
            )

        summary_rows.append(
            {
                "itemCode": item_code,
                "itemName": representative["item_name"],
                "specification": representative["specification"],
                "stockQty": decimal_json(sum((row["stock_qty"] for row in item_rows), Decimal("0"))),
                "inspectionWaitQty": decimal_json(
                    max((row["inspection_wait_qty"] for row in item_rows), default=Decimal("0"))
                ),
                "warehouses": warehouse_details,
                "note": "검사대기는 창고 간 반복되는 API 공통값으로 중복 합산하지 않음",
            }
        )

    snapshot_date = max(row["snapshot_date"] for row in rows) if rows else date.today().isoformat()
    return {
        "generatedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
        "snapshotDate": snapshot_date,
        "warehouseOptions": [
            {"code": code, "name": name} for code, name in WAREHOUSES
        ],
        "itemCount": len(summary_rows),
        "sourceRowCount": len(rows),
        "inspectionAggregation": "max-per-item",
        "status": status,
        "rows": summary_rows,
    }


def main() -> int:
    rows, status = collect()
    inserted = write_database(rows)
    payload = build_dashboard_payload(rows, status)
    atomic_write_json(OUTPUT_PATH, payload)
    print(
        json.dumps(
            {
                "snapshotDate": payload["snapshotDate"],
                "databaseRows": inserted,
                "uniqueLiddingItems": payload["itemCount"],
                "output": str(OUTPUT_PATH),
                "warehouses": status["warehouses"],
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
