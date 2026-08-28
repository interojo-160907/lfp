from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from contextlib import contextmanager
from datetime import datetime, timedelta
from pathlib import Path
from typing import Iterator
from urllib.parse import urlencode
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parents[1]


def load_local_environment(path: Path) -> None:
    """Load uncommitted runtime settings without overriding server-provided values."""
    if not path.exists():
        return
    for raw_line in path.read_text(encoding="utf-8-sig").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if value[:1] == value[-1:] and value[:1] in {"'", '"'}:
            value = value[1:-1]
        if key:
            os.environ.setdefault(key, value)


load_local_environment(ROOT / ".env.local")
RUNTIME_DIR = ROOT / "runtime"
STATE_PATH = Path(os.environ.get("LFP_MONITOR_STATE_PATH", RUNTIME_DIR / "collection-monitor.json"))
LOCK_PATH = RUNTIME_DIR / "collection-monitor.lock"
API_BASE_URL = os.environ.get("LFP_API_BASE_URL", "https://plan.interojo.net").rstrip("/")
APS_POLL_SECONDS = max(30, int(os.environ.get("LFP_APS_POLL_SECONDS", "60")))
COMMAND_TIMEOUT_SECONDS = max(60, int(os.environ.get("LFP_COLLECTION_TIMEOUT_SECONDS", "900")))
COLLECTION_HISTORY_HOURS = 48
DASHBOARD_SNAPSHOT_PATH = ROOT / "web" / "data" / "dashboard-snapshot.json"
DASHBOARD_CHANNEL_FILES = {
    "aps": ROOT / "web" / "data" / "aps-lidding-requirement.json",
    "inventory": ROOT / "web" / "data" / "lidding-inventory.json",
    "purchase": ROOT / "web" / "data" / "lidding-purchase-inbound.json",
    "bom": ROOT / "web" / "data" / "bom-product-lidding.json",
}


def publish_dashboard_snapshot(scope: str, reason: str) -> str:
    channels: dict[str, object] = {}
    for name, source in DASHBOARD_CHANNEL_FILES.items():
        if not source.exists():
            raise RuntimeError(f"대시보드 스냅샷 채널 파일이 없습니다: {source.name}")
        channels[name] = json.loads(source.read_text(encoding="utf-8"))
    payload = {
        "snapshotAt": now_text(),
        "scope": scope,
        "reason": reason,
        "channels": channels,
    }
    DASHBOARD_SNAPSHOT_PATH.parent.mkdir(parents=True, exist_ok=True)
    temporary = DASHBOARD_SNAPSHOT_PATH.with_suffix(".tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(DASHBOARD_SNAPSHOT_PATH)
    return str(DASHBOARD_SNAPSHOT_PATH.relative_to(ROOT))


def now_text() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def read_state() -> dict:
    try:
        return json.loads(STATE_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def write_state(state: dict) -> None:
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    temporary = STATE_PATH.with_suffix(".tmp")
    temporary.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(STATE_PATH)


def update_state(**values: object) -> dict:
    state = read_state()
    state.update(values)
    write_state(state)
    return state


def recent_collection_history(entry: dict | None = None) -> list[dict]:
    cutoff = datetime.now().astimezone() - timedelta(hours=COLLECTION_HISTORY_HOURS)
    retained = []
    for item in read_state().get("collectionHistory", []) or []:
        try:
            occurred_at = datetime.fromisoformat(str(item.get("at") or ""))
            if occurred_at.tzinfo is None:
                occurred_at = occurred_at.astimezone()
            if occurred_at >= cutoff:
                retained.append(item)
        except (TypeError, ValueError):
            continue
    if entry:
        retained.append(entry)
    return retained


@contextmanager
def collection_lock() -> Iterator[None]:
    RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
    if LOCK_PATH.exists():
        owner_is_running = False
        try:
            owner_pid = int(LOCK_PATH.read_text(encoding="utf-8").split()[0])
            if os.name == "nt":
                import ctypes

                kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
                handle = kernel32.OpenProcess(0x1000, False, owner_pid)
                if handle:
                    kernel32.CloseHandle(handle)
                    owner_is_running = True
                elif ctypes.get_last_error() == 5:
                    owner_is_running = True
            else:
                os.kill(owner_pid, 0)
                owner_is_running = True
        except (FileNotFoundError, IndexError, OSError, ValueError):
            owner_is_running = False
        lock_expired = time.time() - LOCK_PATH.stat().st_mtime > COMMAND_TIMEOUT_SECONDS * 2
        if not owner_is_running or lock_expired:
            LOCK_PATH.unlink(missing_ok=True)
    try:
        descriptor = os.open(LOCK_PATH, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError as error:
        raise RuntimeError("다른 데이터 갱신 작업이 이미 실행 중입니다.") from error
    try:
        os.write(descriptor, f"{os.getpid()} {now_text()}".encode("utf-8"))
        os.close(descriptor)
        yield
    finally:
        LOCK_PATH.unlink(missing_ok=True)


def command_environment() -> dict[str, str]:
    environment = os.environ.copy()
    source_path = str(ROOT / "src")
    current = environment.get("PYTHONPATH", "")
    environment["PYTHONPATH"] = source_path if not current else f"{source_path}{os.pathsep}{current}"
    return environment


def collector_commands(scope: str) -> list[tuple[str, list[str]]]:
    python = sys.executable
    scripts = ROOT / "scripts"
    aps_steps = [
        ("aps", [python, str(scripts / "collect_aps_hydration.py")]),
        ("production", [python, "-m", "lidding_foil_planner.collect_production"]),
    ]
    inventory_steps = [
        ("inventory", [python, str(scripts / "collect_lidding_inventory.py")]),
        ("purchase_request", [python, str(scripts / "collect_lidding_purchase_inbound.py")]),
    ]
    bom_step = ("bom", [python, str(scripts / "collect_bom_lidding.py")])
    if scope == "aps":
        return [*aps_steps, *inventory_steps, bom_step]
    if scope == "inventory":
        return inventory_steps
    if scope == "purchase":
        return [inventory_steps[1]]
    if scope == "bom":
        return [bom_step]
    if scope == "all":
        return [*aps_steps, *inventory_steps, bom_step]
    raise ValueError(f"지원하지 않는 갱신 범위: {scope}")


def run_scope(scope: str, reason: str, aps_source_version: str | None = None) -> dict:
    with collection_lock():
        started_at = now_text()
        update_state(
            running=True,
            runningScope=scope,
            runningReason=reason,
            startedAt=started_at,
            lastError="",
        )
        step_results = []
        try:
            for name, command in collector_commands(scope):
                step_started = time.monotonic()
                completed = subprocess.run(
                    command,
                    cwd=ROOT,
                    env=command_environment(),
                    capture_output=True,
                    text=True,
                    timeout=COMMAND_TIMEOUT_SECONDS,
                    check=False,
                )
                result = {
                    "channel": name,
                    "status": "success" if completed.returncode == 0 else "error",
                    "returnCode": completed.returncode,
                    "durationSeconds": round(time.monotonic() - step_started, 2),
                    "output": (completed.stdout or completed.stderr or "")[-2000:],
                }
                step_results.append(result)
                if completed.returncode != 0:
                    raise RuntimeError(f"{name} 수집 실패: {result['output'][-500:]}")

            values: dict[str, object] = {
                "running": False,
                "lastStatus": "success",
                "lastScope": scope,
                "lastReason": reason,
                "lastCollectedAt": now_text(),
                "lastSteps": step_results,
                "lastError": "",
                "collectionHistory": recent_collection_history({
                    "at": now_text(), "scope": scope, "reason": reason, "status": "success",
                }),
            }
            values["dashboardSnapshot"] = publish_dashboard_snapshot(scope, reason)
            if aps_source_version:
                values["apsSourceRefreshedAt"] = aps_source_version
            return update_state(**values)
        except Exception as error:
            update_state(
                running=False,
                lastStatus="error",
                lastScope=scope,
                lastReason=reason,
                lastFailedAt=now_text(),
                lastSteps=step_results,
                lastError=str(error),
                collectionHistory=recent_collection_history({
                    "at": now_text(), "scope": scope, "reason": reason,
                    "status": "error", "message": str(error)[:500],
                }),
            )
            raise


def fetch_aps_source_version() -> str:
    query = urlencode({"oper": "45", "limit": "1"})
    request = Request(
        f"{API_BASE_URL}/api/aps-plan?{query}",
        headers={"Accept": "application/json", "User-Agent": "Lidding-Foil-Planner-Monitor/0.1"},
    )
    with urlopen(request, timeout=60) as response:
        payload = json.load(response)
    source_version = str(payload.get("source_refreshed_at") or "").strip()
    if not source_version:
        raise RuntimeError("APS API source_refreshed_at 값이 없습니다.")
    update_state(
        lastApsCheckedAt=now_text(),
        observedApsSourceRefreshedAt=source_version,
        apsSourceTotalCount=payload.get("source_total_count"),
    )
    return source_version


def monitor_forever() -> None:
    update_state(
        monitorStartedAt=now_text(),
        monitorPid=os.getpid(),
        apsPollSeconds=APS_POLL_SECONDS,
    )
    while True:
        try:
            source_version = fetch_aps_source_version()
            state = read_state()
            collected_version = str(state.get("apsSourceRefreshedAt") or "")
            baseline_version = str(state.get("apsBaselineSourceRefreshedAt") or "")
            if not collected_version and not baseline_version:
                update_state(
                    apsBaselineSourceRefreshedAt=source_version,
                    lastStatus="watching",
                    lastMessage="현재 APS 판본을 기준값으로 등록했습니다. 다음 갱신부터 수집합니다.",
                )
            elif source_version not in {collected_version, baseline_version}:
                run_scope("aps", "aps_source_changed", source_version)
                update_state(apsBaselineSourceRefreshedAt=source_version)
        except Exception as error:
            update_state(lastMonitorError=str(error), lastMonitorErrorAt=now_text())

        time.sleep(APS_POLL_SECONDS)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Lidding Foil Planner collection monitor")
    parser.add_argument("--once", choices=("aps", "inventory", "purchase", "bom", "all"))
    parser.add_argument("--reason", default="manual")
    args = parser.parse_args(argv)
    try:
        if args.once:
            source_version = fetch_aps_source_version() if args.once in {"aps", "all"} else None
            run_scope(args.once, args.reason, source_version)
        else:
            monitor_forever()
        return 0
    except KeyboardInterrupt:
        return 0
    except Exception as error:
        print(str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
