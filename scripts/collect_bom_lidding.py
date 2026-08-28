from __future__ import annotations

import json
import hashlib
import os
import re
import sys
from datetime import datetime
from decimal import Decimal
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen

import psycopg
from psycopg.types.json import Jsonb
from io_utils import atomic_write_json


ROOT = Path(__file__).resolve().parents[1]
DDL_PATH = ROOT / "sql" / "004_bom_product_lidding.sql"
OUTPUT_PATH = ROOT / "web" / "data" / "bom-product-lidding.json"
API_BASE_URL = os.environ.get("LFP_API_BASE_URL", "https://plan.interojo.net").rstrip("/")
DATABASE_URL = os.environ.get("DATABASE_URL") or os.environ.get("LFP_DATABASE_URL")
PCODE = re.compile(r"^P\d{4}$", re.IGNORECASE)
LIDDING_NAME = re.compile(r"리드지|lidding|foil", re.IGNORECASE)


def fetch_json(path: str, params: dict[str, str], timeout: int = 300) -> dict:
    url = f"{API_BASE_URL}{path}?{urlencode(params)}"
    request = Request(url, headers={"Accept": "application/json", "User-Agent": "Lidding-Foil-Planner/0.1"})
    with urlopen(request, timeout=timeout) as response:
        return json.load(response)


def fetch_filtered_or_full(path: str, filtered_params: dict[str, str]) -> tuple[dict, bool]:
    try:
        payload = fetch_json(path, {**filtered_params, "limit": "0"})
        if payload.get("rows"):
            return payload, True
    except Exception:
        pass
    return fetch_json(path, {"limit": "0"}), False


def number(value: object) -> Decimal:
    if value in (None, ""):
        return Decimal("0")
    return Decimal(str(value))


def collect() -> tuple[list[dict], list[dict], dict]:
    products_payload, product_filter_applied = fetch_filtered_or_full(
        "/api/product-names",
        {"nm_cd": "P", "use_yn": "Y"},
    )
    if products_payload.get("truncated"):
        raise RuntimeError("제품명등록 API 응답이 잘렸습니다.")

    products = {
        str(row.get("nm_cd") or "").upper(): row
        for row in products_payload.get("rows") or []
        if PCODE.fullmatch(str(row.get("nm_cd") or ""))
        and str(row.get("use_yn") or "").upper() == "Y"
    }

    bom_payload, bom_filter_applied = fetch_filtered_or_full(
        "/api/bom-explosion",
        {"root_cd": "P", "child_cd": "BS", "lvl": "1", "use_yn": "Y"},
    )
    if bom_payload.get("truncated"):
        raise RuntimeError("BOM API 응답이 잘렸습니다.")

    mappings: dict[tuple[str, str, str], dict] = {}
    for row in bom_payload.get("rows") or []:
        product_code = str(row.get("root_cd") or "").upper().strip()
        parent_code = str(row.get("parent_cd") or "").upper().strip()
        lidding_code = str(row.get("child_cd") or "").upper().strip()
        lidding_name = str(row.get("child_nm") or "").strip()
        specification = str(row.get("child_spec") or "").strip()

        if product_code not in products:
            continue
        if int(row.get("lvl") or 0) != 1 or parent_code != product_code:
            continue
        if not lidding_code.startswith("BS") or not LIDDING_NAME.search(lidding_name):
            continue
        if str(row.get("use_yn") or "").upper() != "Y":
            continue

        key = (product_code, lidding_code, specification)
        current = mappings.get(key)
        if current is None:
            mappings[key] = {
                "product_code": product_code,
                "product_name": str(products[product_code].get("nm_nm") or row.get("parent_nm") or "").strip(),
                "bom_level": 1,
                "parent_code": parent_code,
                "lidding_code": lidding_code,
                "lidding_name": lidding_name,
                "lidding_specification": specification,
                "requirement_qty": number(row.get("qty")),
                "bom_status_code": row.get("stts"),
                "bom_use_yn": row.get("use_yn"),
                "source_rows": [row],
            }
        else:
            current["requirement_qty"] = max(current["requirement_qty"], number(row.get("qty")))
            current["source_rows"].append(row)

    metadata = {
        "productSourceCount": products_payload.get("total_count"),
        "bomSourceCount": bom_payload.get("total_count"),
        "activePProductCount": len(products),
        "productApiFilterApplied": product_filter_applied,
        "bomApiFilterApplied": bom_filter_applied,
        "storageScope": "active P-code + level-1 active BS lidding only",
    }
    return list(products.values()), sorted(mappings.values(), key=lambda row: (
        row["product_code"], row["lidding_code"], row["lidding_specification"]
    )), metadata


def write_database(products: list[dict], mappings: list[dict]) -> None:
    if not DATABASE_URL:
        raise RuntimeError("DATABASE_URL 또는 LFP_DATABASE_URL이 필요합니다.")

    ddl = DDL_PATH.read_text(encoding="utf-8")
    with psycopg.connect(DATABASE_URL) as connection:
        with connection.cursor() as cursor:
            cursor.execute(ddl)
            cursor.execute("delete from lidding_foil_planner.bom_product_lidding")
            cursor.execute("delete from lidding_foil_planner.product_master_pcode")
            cursor.executemany(
                """
                insert into lidding_foil_planner.product_master_pcode (
                    product_code, product_name, product_type_code, product_type_name,
                    model_code, model_name, product_group_code, product_group_name,
                    water_content, status_code, use_yn, source_payload
                ) values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                """,
                [
                    (
                        str(row.get("nm_cd") or "").upper(), row.get("nm_nm"), row.get("nm_gu"),
                        row.get("nm_gu_nm"), row.get("model_no"), row.get("model_nm"),
                        row.get("full_gu"), row.get("full_gu_nm"), row.get("percontent"),
                        row.get("stts"), row.get("use_yn"), Jsonb({
                            "productCode": str(row.get("nm_cd") or "").upper(),
                            "productName": row.get("nm_nm"),
                            "statusCode": row.get("stts"),
                            "useYn": row.get("use_yn"),
                        }),
                    )
                    for row in products
                ],
            )
            cursor.executemany(
                """
                insert into lidding_foil_planner.bom_product_lidding (
                    product_code, product_name, bom_level, parent_code,
                    lidding_code, lidding_name, lidding_specification,
                    requirement_qty, bom_status_code, bom_use_yn, source_payload
                ) values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                """,
                [
                    (
                        row["product_code"], row["product_name"], row["bom_level"],
                        row["parent_code"], row["lidding_code"], row["lidding_name"],
                        row["lidding_specification"], row["requirement_qty"],
                        row["bom_status_code"], row["bom_use_yn"], Jsonb({
                            "productCode": row["product_code"],
                            "liddingCode": row["lidding_code"],
                            "liddingSpecification": row["lidding_specification"],
                            "bomLevel": row["bom_level"],
                            "sourceRowCount": len(row["source_rows"]),
                        }),
                    )
                    for row in mappings
                ],
            )


def decimal_json(value: Decimal) -> int | float:
    return int(value) if value == value.to_integral_value() else float(value)


def build_payload(products: list[dict], mappings: list[dict], metadata: dict) -> dict:
    mapped_products = {row["product_code"] for row in mappings}
    lidding_codes = {row["lidding_code"] for row in mappings}
    specification_versions = {
        (row["lidding_code"], row["lidding_specification"]) for row in mappings
    }
    signature_source = {
        "products": sorted(
            (
                str(row.get("nm_cd") or "").upper(),
                str(row.get("nm_nm") or ""),
                str(row.get("stts") or ""),
                str(row.get("use_yn") or ""),
            )
            for row in products
        ),
        "mappings": [
            (
                row["product_code"], row["product_name"], row["lidding_code"],
                row["lidding_specification"], row["lidding_name"],
                str(row["requirement_qty"]), str(row["bom_status_code"]),
                str(row["bom_use_yn"]),
            )
            for row in mappings
        ],
    }
    source_signature = hashlib.sha256(
        json.dumps(signature_source, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    return {
        "generatedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
        "sourceSignature": source_signature,
        **metadata,
        "mappingCount": len(mappings),
        "mappedProductCount": len(mapped_products),
        "liddingCodeCount": len(lidding_codes),
        "specificationVersionCount": len(specification_versions),
        "unmappedProductCount": len(products) - len(mapped_products),
        "rows": [
            {
                "productCode": row["product_code"],
                "productName": row["product_name"],
                "liddingCode": row["lidding_code"],
                "liddingName": row["lidding_name"],
                "liddingSpecification": row["lidding_specification"],
                "requirementQty": decimal_json(row["requirement_qty"]),
                "bomLevel": row["bom_level"],
                "statusCode": row["bom_status_code"],
                "useYn": row["bom_use_yn"],
            }
            for row in mappings
        ],
    }


def main() -> int:
    products, mappings, metadata = collect()
    payload = build_payload(products, mappings, metadata)
    previous_signature = None
    if OUTPUT_PATH.exists():
        try:
            previous_signature = json.loads(OUTPUT_PATH.read_text(encoding="utf-8")).get("sourceSignature")
        except (OSError, json.JSONDecodeError):
            previous_signature = None
    changed = payload["sourceSignature"] != previous_signature
    if changed:
        write_database(products, mappings)
    payload["changed"] = changed
    atomic_write_json(OUTPUT_PATH, payload)
    print(json.dumps({
        "activePProducts": payload["activePProductCount"],
        "mappingRows": payload["mappingCount"],
        "mappedProducts": payload["mappedProductCount"],
        "liddingCodes": payload["liddingCodeCount"],
        "specificationVersions": payload["specificationVersionCount"],
        "changed": changed,
        "p0007": [row for row in payload["rows"] if row["productCode"] == "P0007"],
        "output": str(OUTPUT_PATH),
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
