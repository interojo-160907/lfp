create schema if not exists lidding_foil_planner;

create table if not exists lidding_foil_planner.aps_hydration_pcode (
    source_refreshed_at timestamp not null,
    plan_date date not null,
    p_code text not null,
    demand_type text not null,
    demand_category text not null,
    production_required_qty numeric(20, 4) not null,
    source_row_count integer not null,
    due_date_from date,
    due_date_to date,
    collected_at timestamptz not null default now(),
    source_sample jsonb not null,
    primary key (source_refreshed_at, p_code, demand_type)
);

create index if not exists ix_aps_hydration_pcode_latest
    on lidding_foil_planner.aps_hydration_pcode (source_refreshed_at desc, p_code);

create table if not exists lidding_foil_planner.aps_hydration_order_detail (
    source_refreshed_at timestamp not null,
    source_row_no integer not null,
    p_code text not null,
    demand_type text not null,
    demand_category text not null,
    demand_id text,
    so_id text,
    order_seq integer not null default 0,
    initial_name text,
    customer_id text,
    customer_name text,
    plan_date date,
    due_date date,
    target_datetime timestamp,
    production_required_qty numeric(20, 4) not null,
    demand_qty numeric(20, 4) not null default 0,
    source_payload jsonb not null,
    collected_at timestamptz not null default now(),
    primary key (source_refreshed_at, source_row_no)
);

create index if not exists ix_aps_hydration_order_latest
    on lidding_foil_planner.aps_hydration_order_detail
    (source_refreshed_at desc, p_code, due_date);

create or replace view lidding_foil_planner.v_aps_hydration_latest as
select a.*
from lidding_foil_planner.aps_hydration_pcode a
where a.source_refreshed_at = (
    select max(source_refreshed_at)
    from lidding_foil_planner.aps_hydration_pcode
);

create or replace view lidding_foil_planner.v_aps_hydration_order_latest as
select d.*
from lidding_foil_planner.aps_hydration_order_detail d
where d.source_refreshed_at = (
    select max(source_refreshed_at)
    from lidding_foil_planner.aps_hydration_order_detail
);

create or replace view lidding_foil_planner.v_lidding_aps_requirement as
select
    b.lidding_code,
    b.lidding_specification,
    max(b.lidding_name) as lidding_name,
    sum(a.production_required_qty) as production_required_qty,
    count(distinct a.p_code) as linked_p_code_count,
    min(a.due_date_from) as due_date_from,
    max(a.due_date_to) as due_date_to,
    max(a.source_refreshed_at) as source_refreshed_at
from lidding_foil_planner.v_aps_hydration_latest a
join lidding_foil_planner.bom_product_lidding b
  on b.product_code = a.p_code
group by b.lidding_code, b.lidding_specification;

create or replace view lidding_foil_planner.v_lidding_aps_requirement_by_category as
select
    b.lidding_code,
    b.lidding_specification,
    a.demand_category,
    sum(a.production_required_qty) as production_required_qty,
    count(distinct a.p_code) as linked_p_code_count
from lidding_foil_planner.v_aps_hydration_latest a
join lidding_foil_planner.bom_product_lidding b
  on b.product_code = a.p_code
group by b.lidding_code, b.lidding_specification, a.demand_category;

create or replace view lidding_foil_planner.v_lidding_aps_order_detail as
select
    b.lidding_code,
    b.lidding_specification,
    d.p_code,
    d.demand_category,
    d.demand_type,
    d.demand_id,
    d.so_id,
    d.order_seq,
    d.initial_name,
    d.customer_name,
    d.due_date,
    sum(d.production_required_qty) as production_required_qty
from lidding_foil_planner.v_aps_hydration_order_latest d
join lidding_foil_planner.bom_product_lidding b
  on b.product_code = d.p_code
group by
    b.lidding_code, b.lidding_specification, d.p_code,
    d.demand_category, d.demand_type, d.demand_id, d.so_id,
    d.order_seq, d.initial_name, d.customer_name, d.due_date;

comment on view lidding_foil_planner.v_lidding_aps_requirement is
    'APS P코드 PCS 부족수량을 연결된 BS 리드지별로 단순 합산한다. BOM 소요량은 곱하지 않는다.';
