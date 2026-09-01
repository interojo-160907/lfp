from __future__ import annotations

import importlib.util
import unittest
from decimal import Decimal
from datetime import date, datetime, timedelta
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
            "production": {"production"},
            "all": {"aps", "inventory", "purchase", "bom", "production"},
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
                    patch.object(collector, "collect_production_usage", return_value={}) as collect_production,
                ):
                    collector.collect_scope(scope, "manual", f"manual_{scope}")
                    actual = {
                        name
                        for name, mock in {
                            "aps": collect_aps,
                            "inventory": collect_inventory,
                            "purchase": collect_purchase,
                            "bom": collect_bom,
                            "production": collect_production,
                        }.items()
                        if mock.called
                    }
                    self.assertEqual(expected, actual)

    def test_regular_all_collection_does_not_repeat_daily_production_fetch(self) -> None:
        with (
            patch.object(collector, "read_json", side_effect=self.read_json),
            patch.object(collector, "atomic_write"),
            patch.object(collector, "publish_snapshot"),
            patch.object(collector, "write_status"),
            patch.object(collector, "collect_aps", return_value={}),
            patch.object(collector, "collect_inventory", return_value=self.inventory),
            patch.object(collector, "collect_purchase", return_value={}),
            patch.object(collector, "collect_bom", return_value=self.bom),
            patch.object(collector, "collect_production_usage") as collect_production,
        ):
            collector.collect_scope("all", "regular", "aps_changed")
            collect_production.assert_not_called()


class BomApiFilterTests(unittest.TestCase):
    def test_bom_uses_supported_product_filters_and_marks_bom_filter_as_local(self) -> None:
        products = [{"nm_cd": "P0001", "nm_nm": "제품", "use_yn": "Y"}]
        bom_rows = [{
            "root_cd": "P0001", "parent_cd": "P0001", "child_cd": "BS0001",
            "child_nm": "리드지", "child_spec": "BS0001-001", "lvl": 1,
            "use_yn": "Y", "qty": 1,
        }]

        def fetch(path, _params, _timeout=300):
            rows = products if path == "/api/product-names" else bom_rows
            return {
                "rows": rows, "total_count": len(rows),
                "returned_count": len(rows), "truncated": False,
            }

        with (
            patch.object(collector, "fetch_json", side_effect=fetch) as fetch_json,
            patch.object(collector, "read_json", return_value={}),
        ):
            result = collector.collect_bom()

        self.assertEqual(
            ("/api/product-names", {"nm_cd": "P", "use_yn": "Y", "limit": 0}),
            fetch_json.call_args_list[0].args,
        )
        self.assertEqual(
            ("/api/bom-explosion", {"limit": 0}),
            fetch_json.call_args_list[1].args,
        )
        self.assertTrue(result["productApiFilterApplied"])
        self.assertFalse(result["bomApiFilterApplied"])
        self.assertEqual(1, result["mappingCount"])


class ApsCategoryTests(unittest.TestCase):
    @staticmethod
    def mojibake(value: str) -> str:
        return value.encode("cp949").decode("latin-1")

    def test_cp949_mojibake_categories_are_repaired(self) -> None:
        cases = {
            "이니셜": "해외",
            "해외": "해외",
            "PB": "PB",
            "국내": "국내",
            "안전(국내)": "안전재고",
            "안전(해외)": "안전재고",
        }
        for demand_type, expected in cases.items():
            source = demand_type if demand_type == "PB" else self.mojibake(demand_type)
            with self.subTest(demand_type=demand_type):
                self.assertEqual(demand_type, collector.repair_legacy_korean_text(source))
                self.assertEqual(expected, collector.category(source))

    def test_collect_aps_reconciles_all_category_totals(self) -> None:
        source_rows = [
            {"item_cd_5": "P0001", "demand_type": self.mojibake("이니셜"), "plan_qty": 10},
            {"item_cd_5": "P0001", "demand_type": "PB", "plan_qty": 20},
            {"item_cd_5": "P0001", "demand_type": self.mojibake("국내"), "plan_qty": 30},
            {"item_cd_5": "P0001", "demand_type": self.mojibake("안전(국내)"), "plan_qty": 40},
        ]
        payload = {
            "rows": source_rows,
            "total_count": len(source_rows),
            "returned_count": len(source_rows),
            "total_plan_qty": 100,
            "source_refreshed_at": "2026-08-31 08:00:00",
        }
        bom = {"rows": [{
            "productCode": "P0001", "liddingCode": "BS0001",
            "liddingSpecification": "BS0001-001", "liddingName": "리드지",
        }]}
        with patch.object(collector, "fetch_json", return_value=payload) as fetch_json:
            result = collector.collect_aps(bom)
        fetch_json.assert_called_once_with(
            "/api/aps-plan", {"oper": 45, "item_cd": "P", "limit": 0}, 300
        )
        self.assertEqual(
            {"해외": 10, "PB": 20, "국내": 30, "안전재고": 40},
            result["categoryTotals"],
        )
        self.assertEqual(result["categoryTotals"], result["rows"][0]["categoryQuantities"])
        self.assertTrue(result["qualityChecks"]["categoryTotalReconciled"])

    def test_collect_aps_rejects_unknown_demand_type(self) -> None:
        payload = {
            "rows": [{"item_cd_5": "P0001", "demand_type": "NEW", "plan_qty": 1}],
            "total_count": 1,
            "returned_count": 1,
            "total_plan_qty": 1,
        }
        with (
            patch.object(collector, "fetch_json", return_value=payload),
            self.assertRaisesRegex(RuntimeError, "미지원 수요구분"),
        ):
            collector.collect_aps({"rows": []})


class ProductionUsageTests(unittest.TestCase):
    def test_seven_day_process_55_usage_is_bom_converted_and_averaged(self) -> None:
        period_to = date(2026, 8, 30)
        bom = {"rows": [
            {
                "productCode": "P0001", "liddingCode": "BS0001",
                "liddingName": "리드지", "liddingSpecification": "BS0001-001",
                "requirementQty": 1,
            },
            {
                "productCode": "P0002", "liddingCode": "BS0001",
                "liddingName": "리드지", "liddingSpecification": "BS0001-001",
                "requirementQty": 2,
            },
        ]}

        def fetch(_path, params, _timeout=300):
            self.assertEqual("55", params["gong_cd"])
            self.assertEqual(0, params["limit"])
            target = params["date_from"]
            rows = [
                {"pr_dt": target, "gong_cd": "55", "sale_cd": "P0001", "job_qty": 7},
                {"pr_dt": target, "gong_cd": "55", "sale_cd": "P0002", "job_qty": 3},
                {"pr_dt": target, "gong_cd": "45", "sale_cd": "P0001", "job_qty": 999},
            ]
            return {
                "key": "production_performance", "rows": rows,
                "total_count": len(rows), "returned_count": len(rows), "truncated": False,
            }

        with patch.object(collector, "fetch_json", side_effect=fetch) as fetch_json:
            result = collector.collect_production_usage(bom, period_to)

        self.assertEqual(7, fetch_json.call_count)
        self.assertEqual("2026-08-24", result["dateFrom"])
        self.assertEqual("2026-08-30", result["dateTo"])
        self.assertEqual(91, result["liddingUsageTotal"])
        self.assertEqual(13, result["rows"][0]["averageDailyUsage"])
        self.assertEqual(7, len(result["rows"][0]["dailyUsage"]))
        self.assertTrue(result["qualityChecks"]["liddingUsageTotalReconciled"])


class SupplyFormulaTests(unittest.TestCase):
    @staticmethod
    def payload(rows: list[dict]) -> dict:
        return {
            "rows": rows,
            "total_count": len(rows),
            "returned_count": len(rows),
            "truncated": False,
        }

    def test_inventory_sums_stock_and_deduplicates_repeated_inspection_wait(self) -> None:
        rows_by_warehouse = {
            "300": [
                {"wh_cd": "300", "itm_cd": "BS0001", "itm_nm": "리드지", "spec": "BS0001-001", "stock_qty": 10, "stay_qty": 5},
                {"wh_cd": "300", "itm_cd": "BS0001", "itm_nm": "리드지", "spec": "BS0001-001", "stock_qty": 2, "stay_qty": 5},
            ],
            "P010": [
                {"wh_cd": "P010", "itm_cd": "BS0001", "itm_nm": "리드지", "spec": "BS0001-001", "stock_qty": 20, "stay_qty": 0},
            ],
            "P030": [
                {"wh_cd": "P030", "itm_cd": "BS0001", "itm_nm": "리드지", "spec": "BS0001-001", "stock_qty": 30, "stay_qty": 5},
            ],
            "S100": [],
        }

        requested_params = []

        def fetch(_path, params, _timeout=300):
            requested_params.append(params)
            return self.payload(rows_by_warehouse[params["wh_cd"]])

        with patch.object(collector, "fetch_json", side_effect=fetch):
            result = collector.collect_inventory()
        self.assertEqual(62, result["stockTotal"])
        self.assertEqual(5, result["inspectionWaitTotal"])
        self.assertEqual(5, result["rows"][0]["inspectionWaitQty"])
        self.assertEqual(1, result["qualityChecks"]["duplicateWarehouseItemSourceRowCount"])
        self.assertEqual(1, result["qualityChecks"]["inspectionRepeatedWarehouseRowCount"])
        self.assertTrue(result["qualityChecks"]["stockTotalReconciled"])
        self.assertTrue(all(params["itm_cd"] == "BS" for params in requested_params))
        self.assertTrue(all(params["itm_nm"] == "리드지" for params in requested_params))

    def test_purchase_wait_formulas_reconcile_to_grouped_totals(self) -> None:
        request_rows = [{
            "itm_cd": "BS0001", "itm_nm": "리드지", "spec": "BS0001-001",
            "req_no": "REQ1", "req_sq": 1, "req_qty": 10, "po_tot": 5,
            "not_inqty": 5, "stat_bc_nm": "완료", "gw_stat": "Y",
        }]
        order_rows = [{
            "itm_cd": "BS0001", "itm_nm": "리드지", "spec": "BS0001-001",
            "po_no": "PO1", "po_sq": 1, "req_no": "REQ1", "req_sq": 1,
            "po_qty": 10, "dlv_qty": 3, "in_qty": 3, "rem_qty": 7,
            "stat_bc_nm": "발주",
        }]

        requested_params = {}

        def fetch(path, params, _timeout=300):
            requested_params[path] = params
            return self.payload(request_rows if path == "/api/purchase-requests" else order_rows)

        inventory = {"rows": [{"itemCode": "BS0001", "specification": "BS0001-001"}]}
        with patch.object(collector, "fetch_json", side_effect=fetch):
            result = collector.collect_purchase(inventory)
        self.assertEqual(7, result["inboundWaitTotal"])
        self.assertEqual(5, result["purchaseWaitTotal"])
        self.assertEqual("request_no + specification", result["formula"]["requestLinkKey"])
        self.assertTrue(result["qualityChecks"]["inboundWaitTotalReconciled"])
        self.assertTrue(result["qualityChecks"]["purchaseWaitTotalReconciled"])
        self.assertEqual(1, requested_params["/api/purchase-requests"]["not_ordered"])
        self.assertEqual(1, requested_params["/api/purchase-order-status"]["open_only"])
        self.assertEqual("BS", requested_params["/api/purchase-requests"]["itm_cd"])
        self.assertEqual("BS", requested_params["/api/purchase-order-status"]["itm_cd"])


class WorkflowConfigurationTests(unittest.TestCase):
    def test_daily_production_dispatch_is_registered_and_routed(self) -> None:
        workflow_dir = Path(__file__).resolve().parents[1] / ".github" / "workflows"
        general_workflow = (workflow_dir / "collect-data.yml").read_text(encoding="utf-8")
        production_workflow = (workflow_dir / "collect-production.yml").read_text(encoding="utf-8")
        self.assertNotIn("- lfp-production-collect", general_workflow)
        self.assertIn("- lfp-production-collect", production_workflow)

    def test_collection_workflows_checkout_latest_main(self) -> None:
        workflow_dir = Path(__file__).resolve().parents[1] / ".github" / "workflows"
        for name in ("collect-data.yml", "collect-production.yml"):
            with self.subTest(workflow=name):
                workflow = (workflow_dir / name).read_text(encoding="utf-8")
                self.assertIn("ref: main", workflow)


if __name__ == "__main__":
    unittest.main()
