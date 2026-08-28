create schema if not exists lidding_foil_planner;

create table if not exists lidding_foil_planner.product_master_pcode (
    product_code text primary key,
    product_name text not null,
    product_type_code text,
    product_type_name text,
    model_code text,
    model_name text,
    product_group_code text,
    product_group_name text,
    water_content numeric(10, 4),
    status_code text,
    use_yn text,
    collected_at timestamptz not null default now(),
    source_payload jsonb not null
);

create table if not exists lidding_foil_planner.bom_product_lidding (
    product_code text not null references lidding_foil_planner.product_master_pcode(product_code),
    product_name text not null,
    bom_level integer not null,
    parent_code text not null,
    lidding_code text not null,
    lidding_name text not null,
    lidding_specification text not null default '',
    requirement_qty numeric(20, 6) not null,
    bom_status_code text,
    bom_use_yn text,
    collected_at timestamptz not null default now(),
    source_payload jsonb not null,
    primary key (product_code, lidding_code, lidding_specification)
);

create index if not exists ix_bom_product_lidding_lidding
    on lidding_foil_planner.bom_product_lidding (lidding_code, lidding_specification);

comment on column lidding_foil_planner.bom_product_lidding.lidding_specification is
    '리드지 규격 버전. 예: BS0054 품목의 BS0054-003 사양을 코드와 별도로 보존한다.';

create or replace view lidding_foil_planner.v_bom_product_lidding as
select
    b.product_code,
    p.product_name,
    p.model_name,
    p.product_group_name,
    b.lidding_code,
    b.lidding_name,
    b.lidding_specification,
    b.requirement_qty,
    b.bom_level,
    b.bom_status_code,
    b.bom_use_yn
from lidding_foil_planner.bom_product_lidding b
join lidding_foil_planner.product_master_pcode p using (product_code);
