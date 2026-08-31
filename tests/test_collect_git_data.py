from __future__ import annotations

import importlib.util
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from unittest.mock import patch


SCRIPT_PATH = Path(__file__).resolve().parents[1] / "scripts" / "collect_git_data.py"
SPEC = importlib.util.spec_from_file_location("collect_git_data", SCRIPT_PATH)
assert SPEC and SPEC.loader
collector = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(collector)


class AutomaticCollectionTests(unittest.TestCase):
    def state(self, *, hours_ago: int, handled: str = "v1") -> dict:
        return {
            "lastRegularCollectionAt": (
                datetime.now(collector.KST) - timedelta(hours=hours_ago)
            ).isoformat(timespec="seconds"),
            "lastHandledApsVersion": handled,
        }

    def test_unchanged_aps_before_16_hours_does_nothing(self) -> None:
        state = self.state(hours_ago=1)
        with (
            patch.object(collector, "load_automation_state", return_value=state),
            patch.object(collector, "aps_source_version", return_value="v1"),
            patch.object(collector, "collect_scope") as collect_scope,
        ):
            self.assertFalse(collector.run_automatic())
            collect_scope.assert_not_called()

    def test_changed_aps_runs_regular_full_collection(self) -> None:
        state = self.state(hours_ago=1)
        with (
            patch.object(collector, "load_automation_state", return_value=state),
            patch.object(collector, "aps_source_version", return_value="v2"),
            patch.object(collector, "collect_scope", return_value=["dashboard-snapshot.json"]) as collect_scope,
            patch.object(collector, "finish_regular_collection") as finish,
        ):
            self.assertTrue(collector.run_automatic())
            collect_scope.assert_called_once_with("all", "regular", "aps_changed")
            finish.assert_called_once_with(state, "aps_changed", ["dashboard-snapshot.json"], "v2")

    def test_unchanged_aps_after_16_hours_runs_support_collection(self) -> None:
        state = self.state(hours_ago=17)
        with (
            patch.object(collector, "load_automation_state", return_value=state),
            patch.object(collector, "aps_source_version", return_value="v1"),
            patch.object(collector, "collect_scope", return_value=["dashboard-snapshot.json"]) as collect_scope,
            patch.object(collector, "finish_regular_collection") as finish,
        ):
            self.assertTrue(collector.run_automatic())
            collect_scope.assert_called_once_with("support", "regular", "regular_16h")
            finish.assert_called_once_with(state, "regular_16h", ["dashboard-snapshot.json"])

    def test_failed_aps_check_after_16_hours_still_runs_support_collection(self) -> None:
        state = self.state(hours_ago=17)
        error = RuntimeError("APS unavailable")
        with (
            patch.object(collector, "load_automation_state", return_value=state),
            patch.object(collector, "aps_source_version", side_effect=error),
            patch.object(collector, "collect_scope", return_value=["dashboard-snapshot.json"]) as collect_scope,
            patch.object(collector, "finish_regular_collection") as finish,
        ):
            self.assertTrue(collector.run_automatic())
            collect_scope.assert_called_once_with(
                "support", "regular", "regular_16h_aps_check_failed"
            )
            finish.assert_called_once_with(
                state,
                "regular_16h_aps_check_failed",
                ["dashboard-snapshot.json"],
                aps_error="RuntimeError: APS unavailable",
            )

    def test_manual_collection_does_not_touch_automatic_state(self) -> None:
        with (
            patch.object(collector, "collect_scope", return_value=["dashboard-snapshot.json"]) as collect_scope,
            patch.object(collector, "load_automation_state") as load_state,
            patch.object(collector, "finish_regular_collection") as finish,
        ):
            self.assertTrue(collector.run("inventory"))
            collect_scope.assert_called_once_with("inventory", "manual", "manual_inventory")
            load_state.assert_not_called()
            finish.assert_not_called()


class ManualScopeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.bom = {"rows": [{"productCode": "P0001"}]}
        self.inventory = {"rows": [{"itemCode": "BS0001"}]}

    def read_json(self, path: Path, default=None):
        if path.name == "bom-product-lidding.json":
            return self.bom
        if path.name == "lidding-inventory.json":
            return self.inventory
        return {} if default is None else default

    def test_each_manual_scope_fetches_only_the_selected_channel(self) -> None:
        cases = {
            "aps": {"aps"},
            "inventory": {"inventory"},
            "purchase": {"purchase"},
            "bom": {"bom"},
            "all": {"aps", "inventory", "purchase", "bom"},
        }
        for scope, expected in cases.items():
            with self.subTest(scope=scope):
                with (
                    patch.object(collector, "read_json", side_effect=self.read_json),
                    patch.object(collector, "atomic_write"),
                    patch.object(collector, "publish_snapshot"),
                    patch.object(collector, "write_status"),
                    patch.object(collector, "collect_aps", return_value={}) as collect_aps,
                    patch.object(collector, "collect_inventory", return_value=self.inventory) as collect_inventory,
                    patch.object(collector, "collect_purchase", return_value={}) as collect_purchase,
                    patch.object(collector, "collect_bom", return_value=self.bom) as collect_bom,
                ):
                    collector.collect_scope(scope, "manual", f"manual_{scope}")
                    actual = {
                        name
                        for name, mock in {
                            "aps": collect_aps,
                            "inventory": collect_inventory,
                            "purchase": collect_purchase,
                            "bom": collect_bom,
                        }.items()
                        if mock.called
                    }
                    self.assertEqual(expected, actual)


if __name__ == "__main__":
    unittest.main()
