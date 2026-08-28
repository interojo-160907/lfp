from __future__ import annotations

import argparse
import hashlib
import json
import sys
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any
from urllib.parse import urlencode
from urllib.request import Request, urlopen

import psycopg
from psycopg.types.json import Jsonb

from .config import Settings


CHANNEL = "production_performance"
EXCLUDED_SOURCE_FIELDS = {"ps_cd", "ps_nm"}
STABLE_KEY_FIELDS = (
    "pr_no",
    "check_sheet_no",
    "pr_dt",
    "gong_cd",
    "gd_cd",
    "mate_no",
    "mc_cd",
)

COPY_COLUMNS = (
    "record_key",
    "row_hash",
    "check_sheet_no",
    "pr_no",
    "pr_dt",
    "gong_cd",
    "fac_cd",
    "sachul_fac_cd",
    "wa_gu",
    "gd_cd",
    "gd_nm",
    "sale_cd",
    "model_no",
    "model_no2",
    "full_gu",
    "percontent",
    "spec",
    "spec30",
    "size_spec",
    "jisi_spec",
    "unit_cd",
    "job_qty",
    "pr_qty",
    "ng_qty",
    "sample_qty",
    "tot_qty",
    "keep_sample_qty",
    "mate_no",
    "test_yn",
    "mc_cd",
    "pre_mc_cd",
    "mc_10",
    "stts",
    "stts_label",
    "bc_result",
    "dia_result",
    "w_power",
    "size80",
    "bc80",
    "loss_cd",
    "loss_nm",
    "source_extracted_at",
    "api_endpoint",
    "raw_payload",
    "run_id",
)


def _parse_date(value: str) -> date:
    return date.fromisoformat(value)


def _default_period() -> tuple[date, date]:
    date_to = date.today() - timedelta(days=1)
    return date_to - timedelta(days=6), date_to


def _json_bytes(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def _sha256(value: Any) -> str:
    return hashlib.sha256(_json_bytes(value)).hexdigest()


def _fetch_production_day(settings: Settings, target_date: date) -> dict[str, Any]:
    query = urlencode(
        {
            "date_from": target_date.isoformat(),
            "date_to": target_date.isoformat(),
            "gong_cd": "55",
            "limit": settings.production_limit,
        }
    )
    url = f"{settings.api_base_url}/api/production-performance?{query}"
    request = Request(
        url,
        headers={
            "Accept": "application/json",
            "User-Agent": "lidding-foil-planner/0.1.0",
        },
        method="GET",
    )
    with urlopen(request, timeout=settings.http_timeout_seconds) as response:
        if response.status != 200:
            raise RuntimeError(f"Production API returned HTTP {response.status}")
        return json.load(response)


def fetch_production(
    settings: Settings, date_from: date, date_to: date
) -> dict[str, Any]:
    daily_payloads: list[dict[str, Any]] = []
    current_date = date_from
    while current_date <= date_to:
        payload = _fetch_production_day(settings, current_date)
        validate_response(payload)
        daily_payloads.append(payload)
        current_date += timedelta(days=1)

    combined = dict(daily_payloads[-1])
    combined_rows = [
        row
        for daily_payload in daily_payloads
        for row in daily_payload.get("rows", [])
    ]
    total_keys = {
        key
        for daily_payload in daily_payloads
        for key in (daily_payload.get("totals") or {})
    }
    combined["date_from"] = date_from.isoformat()
    combined["date_to"] = date_to.isoformat()
    combined["date_label"] = "생산일자"
    combined["rows"] = combined_rows
    combined["total_count"] = sum(
        int(daily_payload.get("total_count", 0))
        for daily_payload in daily_payloads
    )
    combined["returned_count"] = len(combined_rows)
    combined["truncated"] = False
    combined["totals"] = {
        key: sum(
            float((daily_payload.get("totals") or {}).get(key, 0) or 0)
            for daily_payload in daily_payloads
        )
        for key in total_keys
    }
    combined["daily_request_count"] = len(daily_payloads)
    refreshed_values = [
        daily_payload.get("source_refreshed_at")
        for daily_payload in daily_payloads
        if daily_payload.get("source_refreshed_at")
    ]
    combined["source_refreshed_at"] = (
        max(refreshed_values) if refreshed_values else ""
    )
    return combined


def validate_response(payload: dict[str, Any]) -> list[dict[str, Any]]:
    if payload.get("key") != CHANNEL:
        raise RuntimeError(f"Unexpected API key: {payload.get('key')!r}")
    if payload.get("truncated"):
        raise RuntimeError(
            "Production API response was truncated; raise LFP_PRODUCTION_LIMIT"
        )

    rows = payload.get("rows")
    if not isinstance(rows, list):
        raise RuntimeError("Production API response does not contain a rows array")

    total_count = int(payload.get("total_count", -1))
    returned_count = int(payload.get("returned_count", -1))
    if total_count != returned_count or returned_count != len(rows):
        raise RuntimeError(
            "Production API count mismatch: "
            f"total={total_count}, returned={returned_count}, rows={len(rows)}"
        )

    return rows


def prepare_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    prepared: dict[str, dict[str, Any]] = {}
    for source_row in rows:
        row = {
            key: value
            for key, value in source_row.items()
            if key not in EXCLUDED_SOURCE_FIELDS
        }
        if not row.get("pr_dt"):
            raise RuntimeError("Production row is missing pr_dt")

        stable_key = {field: row.get(field) for field in STABLE_KEY_FIELDS}
        record_key = _sha256(stable_key)
        row_hash = _sha256(row)
        existing = prepared.get(record_key)
        if existing and existing["row_hash"] != row_hash:
            raise RuntimeError(
                "Conflicting rows share the same production business key: "
                f"{stable_key}"
            )
        prepared[record_key] = {
            "record_key": record_key,
            "row_hash": row_hash,
            "payload": row,
        }
    return list(prepared.values())


def _schema_sql() -> str:
    project_root = Path(__file__).resolve().parents[2]
    return (project_root / "sql" / "001_init.sql").read_text(encoding="utf-8")


def _connect(settings: Settings) -> psycopg.Connection[Any]:
    return psycopg.connect(
        host=settings.pg_host,
        port=settings.pg_port,
        dbname=settings.pg_database,
        user=settings.pg_user,
        password=settings.pg_password,
        connect_timeout=settings.pg_connect_timeout,
        application_name="lidding-foil-planner",
    )


def _source_timestamp(payload: dict[str, Any]) -> str | None:
    value = str(payload.get("source_refreshed_at") or "").strip()
    return value or None


def _source_extracted_at(payload: dict[str, Any]) -> str | None:
    source = payload.get("source") or {}
    value = str(source.get("extracted_at") or "").strip()
    return value or None


def _copy_values(
    item: dict[str, Any],
    run_id: int,
    source_extracted_at: str | None,
    api_endpoint: str,
) -> tuple[Any, ...]:
    row = item["payload"]
    values = {
        **row,
        "record_key": item["record_key"],
        "row_hash": item["row_hash"],
        "source_extracted_at": source_extracted_at,
        "api_endpoint": api_endpoint,
        "raw_payload": Jsonb(row),
        "run_id": run_id,
    }
    return tuple(values.get(column) for column in COPY_COLUMNS)


def load_production(
    settings: Settings,
    payload: dict[str, Any],
    prepared_rows: list[dict[str, Any]],
    date_from: date,
    date_to: date,
) -> tuple[int, int]:
    api_endpoint = str(
        (payload.get("source") or {}).get("api_endpoint")
        or f"{settings.api_base_url}/api/production-performance"
    )
    source_extracted_at = _source_extracted_at(payload)
    metadata = {
        "query_date": payload.get("query_date"),
        "date_label": payload.get("date_label"),
        "totals": payload.get("totals"),
        "filters_applied": payload.get("filters_applied"),
        "daily_request_count": payload.get("daily_request_count", 1),
        "operator_fields_excluded": sorted(EXCLUDED_SOURCE_FIELDS),
    }

    with _connect(settings) as connection:
        with connection.cursor() as cursor:
            cursor.execute("set time zone 'Asia/Seoul'")
            cursor.execute(_schema_sql())
        connection.commit()

        with connection.cursor() as cursor:
            cursor.execute(
                """
                insert into lidding_foil_planner.collection_run (
                    channel,
                    status,
                    requested_date_from,
                    requested_date_to,
                    source_refreshed_at,
                    source_total_count,
                    received_count,
                    metadata
                ) values (%s, 'running', %s, %s, %s, %s, %s, %s)
                returning run_id
                """,
                (
                    CHANNEL,
                    date_from,
                    date_to,
                    _source_timestamp(payload),
                    payload.get("total_count"),
                    len(prepared_rows),
                    Jsonb(metadata),
                ),
            )
            run_id = int(cursor.fetchone()[0])
        connection.commit()

        try:
            with connection.transaction():
                with connection.cursor() as cursor:
                    cursor.execute(
                        "select pg_advisory_xact_lock(hashtext(%s))",
                        ("lidding_foil_planner.production_performance",),
                    )
                    cursor.execute(
                        """
                        delete from lidding_foil_planner.production_performance
                        where pr_dt between %s and %s
                        """,
                        (date_from, date_to),
                    )
                    replaced_count = cursor.rowcount

                    columns = ", ".join(COPY_COLUMNS)
                    copy_sql = (
                        "copy lidding_foil_planner.production_performance "
                        f"({columns}) from stdin"
                    )
                    with cursor.copy(copy_sql) as copy:
                        for item in prepared_rows:
                            copy.write_row(
                                _copy_values(
                                    item,
                                    run_id,
                                    source_extracted_at,
                                    api_endpoint,
                                )
                            )

                    cursor.execute(
                        """
                        update lidding_foil_planner.collection_run
                        set status = 'success',
                            replaced_count = %s,
                            finished_at = now()
                        where run_id = %s
                        """,
                        (replaced_count, run_id),
                    )
            return run_id, replaced_count
        except Exception as exc:
            connection.rollback()
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    update lidding_foil_planner.collection_run
                    set status = 'failed',
                        error_message = %s,
                        finished_at = now()
                    where run_id = %s
                    """,
                    (str(exc)[:4000], run_id),
                )
            connection.commit()
            raise


def _arguments(argv: list[str] | None = None) -> argparse.Namespace:
    default_from, default_to = _default_period()
    parser = argparse.ArgumentParser(
        description="Collect production performance into the DMZ PostgreSQL database"
    )
    parser.add_argument("--date-from", type=_parse_date, default=default_from)
    parser.add_argument("--date-to", type=_parse_date, default=default_to)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _arguments(argv)
    if args.date_from > args.date_to:
        raise SystemExit("--date-from must be on or before --date-to")

    settings = Settings.from_env()
    started_at = datetime.now().astimezone()
    print(
        f"[{started_at.isoformat(timespec='seconds')}] "
        f"Fetching {CHANNEL} for {args.date_from}..{args.date_to}"
    )
    payload = fetch_production(settings, args.date_from, args.date_to)
    source_rows = validate_response(payload)
    prepared_rows = prepare_rows(source_rows)
    run_id, replaced_count = load_production(
        settings,
        payload,
        prepared_rows,
        args.date_from,
        args.date_to,
    )
    print(
        f"Collection succeeded: run_id={run_id}, "
        f"source_rows={len(source_rows)}, stored_rows={len(prepared_rows)}, "
        f"replaced_rows={replaced_count}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
