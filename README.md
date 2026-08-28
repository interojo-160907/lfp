# Lidding Foil Planner

리드지 수급관리 전용 자동화 대시보드 프로젝트다. 기존 SCM Control Tower와 별도 Git 저장소로 운영한다.

## 화면 범위

1. `현황`: 리드지별 APS 소요량, 현재고, 검사대기, 입고대기, 예상 부족량과 위험 상태
2. `세부 계획`: P코드별 APS 계획, BOM 소요계수, 생산실적 기반 실제 사용량, 입고예정과 일자별 수급 계획

## 데이터 원칙

- APS 계산 완료가 새 분석 판본의 트리거다.
- APS 신규 판본 적재 후 생산실적은 전일까지 최근 7일을 다시 수집한다.
- API 채널별 데이터를 서로 다른 PostgreSQL 테이블에 적재한다.
- API 호출과 검증은 DB 트랜잭션 밖에서 수행하고, 검증된 전체 판본만 짧은 트랜잭션으로 교체한다.
- 생산실적 API의 서버 응답 상한을 피하기 위해 기간을 일자별로 나누어 호출하고, 모든 일자의 검증이 끝난 뒤 한 판본으로 적재한다.
- 수집 실패 시 직전 정상 데이터를 유지한다.
- 비밀번호와 API 인증값은 Git에 저장하지 않는다.
- 리드지 수급 분석에 불필요한 작업자 코드와 작업자 이름은 DMZ에 적재하지 않는다.

## 자동 갱신 모니터

- APS는 `source_refreshed_at`을 60초마다 확인하고 값이 변경된 경우에만 최신 APS 현재본으로 교체한다.
- 모니터 최초 실행 시 기존 APS는 수집하지 않고 현재 `source_refreshed_at`을 기준값으로만 등록한다.
- APS 변경 시 생산실적 최근 7일, 리드지 재고·검사대기, 구매의뢰 기반 발주대기를 함께 갱신한다.
- BOM은 기본 10분마다 전체 채널을 확인하며, 제품+BOM 내용 해시가 변경된 경우에만 DB 현재본을 교체한다.
- 구매의뢰·구매발주는 기본 5분마다 독립 갱신하고 성공한 현재본만 통합 대시보드 스냅샷에 반영한다.
- BOM API는 `사용 중인 P코드 → 1단계 사용 중 BS 리드지` 필터를 우선 적용하며, API가 필터를 지원하지 않을 때만 전체 조회 후 동일 조건으로 축소한다.
- BOM DB에는 제품코드, 제품명, BS 리드지 코드, 규격 버전, 리드지명과 상태 등 대시보드 필수 필드만 저장한다.
- 성공한 최신 데이터 묶음은 `runtime/snapshots`에 ZIP으로 보관하고 최근 48개만 유지한다.
- 대시보드는 PostgreSQL을 직접 조회하지 않고 원자적으로 교체된 현재 JSON 판본을 읽어 수집 중에도 응답 속도를 유지한다.
- 대시보드의 `수동 데이터 갱신`은 `/api/refresh`를 통해 전체 채널 갱신을 요청한다.

```powershell
$env:DATABASE_URL = "postgresql://<사용자>:<비밀번호>@<DB호스트>:5432/sangho_db"
python .\scripts\serve_dashboard.py --host 127.0.0.1 --port 8877
```

모니터만 실행하거나 일회성 갱신할 수도 있다.

```powershell
python .\scripts\monitor_collections.py
python .\scripts\monitor_collections.py --once all
python .\scripts\monitor_collections.py --once inventory
python .\scripts\monitor_collections.py --once purchase
python .\scripts\monitor_collections.py --once bom
```

## 채널별 테이블 계획

| 단계 | API 채널 | PostgreSQL 테이블 |
|---:|---|---|
| 1 | `/api/production-performance` | `lidding_foil_planner.production_performance` |
| 2 | `/api/aps-plan` | `lidding_foil_planner.aps_outbound` |
| 3 | `/api/bom-explosion` | `lidding_foil_planner.bom_explosion` |
| 3 | `/api/bom-implosion` | `lidding_foil_planner.bom_implosion` |
| 4 | `/api/item-inventory-ledger` | `lidding_foil_planner.item_inventory_ledger` |
| 4 | `/api/item-inout-detail` | `lidding_foil_planner.item_inout_detail` |
| 4 | `/api/warehouse-item-stock` | `lidding_foil_planner.warehouse_item_stock` |
| 5 | `/api/purchase-requests` | `lidding_foil_planner.purchase_requests` |
| 5 | `/api/purchase-order-status` | `lidding_foil_planner.purchase_order_snapshot` |

구매 수급 수량은 다음 기준으로 계산한다.

- `입고대기`: 구매의뢰번호 및 초과입고 등록 여부와 관계없이 구매발주 상태가 `발주` 또는 `납품진행`인 행의 `미납수량(rem_qty)` 합계
- `발주대기`: 승인·완료 구매의뢰의 `미발주수량(not_inqty)` 합계
- 구매의뢰번호가 없는 `초과입고수량등록건`도 상태가 `발주` 또는 `납품진행`이면 입고대기에 포함한다.
- 구매 원본 연결키는 `구매의뢰번호 + 의뢰순번`, 화면 집계키는 `품목코드 + 규격`이다.

현재 1차 적재 테이블은 다음과 같다.

| 데이터 | 범위 | 테이블 |
|---|---|---|
| APS 부족수량 | 하이드레이션 공정 45, `plan_qty > 0` | `lidding_foil_planner.aps_hydration_shortage` |
| 생산실적 | 최근 7일 공정 55, 생산일자·공장·품목코드별 지시수량 | `lidding_foil_planner.production_performance_55` |
| 리드지 BOM | 현재 APS P코드 중 사용 중인 BS 리드지 | `lidding_foil_planner.bom_lidding_foil` |

```powershell
.\.venv\Scripts\lfp-collect-channels.exe
```

`lidding_foil_planner.collection_run`은 모든 채널이 공유하는 수집 실행 이력이다. 실제 원천 데이터는 채널별 전용 테이블에만 저장한다.

## 생산실적 최초 수집

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e .

$env:PGHOST = "<DB호스트>"
$env:PGPORT = "5432"
$env:PGDATABASE = "sangho_db"
$env:PGUSER = "<DB 사용자>"
$env:PGPASSWORD = "<DB 비밀번호>"

.\.venv\Scripts\lfp-collect-production.exe --date-from 2026-08-18 --date-to 2026-08-24
```

날짜를 생략하면 전일까지 최근 7일을 자동으로 사용한다.

```powershell
.\.venv\Scripts\lfp-collect-production.exe
```

수집기는 다음 조건을 모두 만족할 때만 PostgreSQL 현재본을 교체한다.

- API의 `truncated`가 `false`
- `total_count`와 `returned_count`가 일치
- 실제 `rows` 길이와 `returned_count`가 일치
- 동일 업무키에 서로 다른 행이 중복되지 않음

## DBeaver 확인 SQL

```sql
select
    run_id,
    channel,
    status,
    requested_date_from,
    requested_date_to,
    source_total_count,
    received_count,
    replaced_count,
    started_at,
    finished_at
from lidding_foil_planner.collection_run
order by run_id desc
limit 20;

select
    pr_dt,
    gong_cd,
    count(*) as row_count,
    sum(pr_qty) as good_qty,
    sum(ng_qty) as defect_qty,
    sum(tot_qty) as production_qty
from lidding_foil_planner.production_performance
group by pr_dt, gong_cd
order by pr_dt desc, gong_cd;
```
