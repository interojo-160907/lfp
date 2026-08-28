from __future__ import annotations

import os
from dataclasses import dataclass


def _required(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise RuntimeError(f"Required environment variable is missing: {name}")
    return value


@dataclass(frozen=True)
class Settings:
    api_base_url: str
    production_limit: int
    http_timeout_seconds: int
    pg_host: str
    pg_port: int
    pg_database: str
    pg_user: str
    pg_password: str
    pg_connect_timeout: int

    @classmethod
    def from_env(cls) -> "Settings":
        return cls(
            api_base_url=os.getenv(
                "LFP_API_BASE_URL", "https://plan.interojo.net"
            ).rstrip("/"),
            production_limit=int(os.getenv("LFP_PRODUCTION_LIMIT", "100000")),
            http_timeout_seconds=int(
                os.getenv("LFP_HTTP_TIMEOUT_SECONDS", "180")
            ),
            pg_host=_required("PGHOST"),
            pg_port=int(os.getenv("PGPORT", "5432")),
            pg_database=_required("PGDATABASE"),
            pg_user=_required("PGUSER"),
            pg_password=_required("PGPASSWORD"),
            pg_connect_timeout=int(os.getenv("PGCONNECT_TIMEOUT", "15")),
        )

