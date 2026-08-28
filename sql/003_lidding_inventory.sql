create schema if not exists lidding_foil_planner;

create table if not exists lidding_foil_planner.lidding_inventory_snapshot (
    snapshot_date date not null,
    warehouse_code text not null,
    warehouse_name text not null,
    factory_code text,
    factory_name text,
    item_id bigint,
    item_code text not null,
    item_name text not null,
    specification text,
    unit_code text,
    unit_name text,
    stock_qty numeric(20, 4) not null default 0,
    inspection_wait_qty numeric(20, 4) not null default 0,
    collected_at timestamptz not null default now(),
    source_endpoint text not null,
    source_payload jsonb not null,
    primary key (snapshot_date, warehouse_code, item_code)
);

create index if not exists ix_lidding_inventory_snapshot_item
    on lidding_foil_planner.lidding_inventory_snapshot (item_code, snapshot_date desc);

comment on column lidding_foil_planner.lidding_inventory_snapshot.inspection_wait_qty is
    'API stay_qty 원본. 동일 품목 값이 여러 창고에 반복될 수 있어 전체 집계 시 합계가 아니라 max를 사용한다.';

create or replace view lidding_foil_planner.v_lidding_inventory_latest as
select s.*
from lidding_foil_planner.lidding_inventory_snapshot s
where s.snapshot_date = (
    select max(snapshot_date)
    from lidding_foil_planner.lidding_inventory_snapshot
);

create or replace view lidding_foil_planner.v_lidding_inventory_summary as
select
    snapshot_date,
    item_code,
    max(item_name) as item_name,
    max(specification) as specification,
    sum(stock_qty) as stock_qty,
    max(inspection_wait_qty) as inspection_wait_qty,
    count(*) as warehouse_row_count
from lidding_foil_planner.v_lidding_inventory_latest
group by snapshot_date, item_code;
