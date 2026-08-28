create schema if not exists lidding_foil_planner;

create table if not exists lidding_foil_planner.purchase_request_snapshot (
    snapshot_at timestamptz not null,
    request_no text not null,
    request_seq integer not null,
    request_date date,
    item_id bigint,
    item_code text not null,
    item_name text,
    specification text not null default '',
    request_qty numeric(18, 3) not null default 0,
    purchase_order_qty numeric(18, 3) not null default 0,
    received_qty numeric(18, 3) not null default 0,
    inbound_wait_qty numeric(18, 3) not null default 0,
    not_ordered_qty numeric(18, 3) not null default 0,
    requested_delivery_date date,
    request_status_code text,
    request_status_name text,
    approval_status text,
    approval_status_name text,
    supplier_code text,
    supplier_name text,
    requester_name text,
    request_department text,
    source_endpoint text not null,
    source_payload jsonb not null,
    primary key (snapshot_at, request_no, request_seq)
);

alter table lidding_foil_planner.purchase_request_snapshot
    add column if not exists not_ordered_qty numeric(18, 3) not null default 0;

create index if not exists ix_purchase_request_snapshot_item
    on lidding_foil_planner.purchase_request_snapshot
    (item_code, specification, snapshot_at desc);

create table if not exists lidding_foil_planner.purchase_order_snapshot (
    snapshot_at timestamptz not null,
    purchase_order_no text not null,
    purchase_order_seq integer not null,
    purchase_order_date date,
    request_no text,
    request_seq integer,
    item_id bigint,
    item_code text not null,
    item_name text,
    specification text not null default '',
    purchase_order_qty numeric(18, 3) not null default 0,
    provisional_receipt_qty numeric(18, 3) not null default 0,
    received_qty numeric(18, 3) not null default 0,
    remaining_qty numeric(18, 3) not null default 0,
    order_status_code text,
    order_status_name text,
    delivery_date date,
    supplier_code text,
    supplier_name text,
    remark text,
    source_endpoint text not null,
    source_payload jsonb not null,
    primary key (snapshot_at, purchase_order_no, purchase_order_seq)
);

create index if not exists ix_purchase_order_snapshot_item
    on lidding_foil_planner.purchase_order_snapshot
    (item_code, specification, snapshot_at desc);

create index if not exists ix_purchase_order_snapshot_request
    on lidding_foil_planner.purchase_order_snapshot
    (request_no, request_seq, snapshot_at desc);

create or replace view lidding_foil_planner.v_lidding_purchase_request_latest as
select p.*
from lidding_foil_planner.purchase_request_snapshot p
where p.snapshot_at = (
    select max(snapshot_at)
    from lidding_foil_planner.purchase_request_snapshot
);

create or replace view lidding_foil_planner.v_lidding_purchase_order_latest as
select p.*
from lidding_foil_planner.purchase_order_snapshot p
where p.snapshot_at = (
    select max(snapshot_at)
    from lidding_foil_planner.purchase_order_snapshot
);

create or replace view lidding_foil_planner.v_lidding_inbound_wait as
select
    item_code,
    specification,
    max(item_name) as item_name,
    sum(purchase_order_qty) as request_qty,
    sum(provisional_receipt_qty) as received_qty,
    sum(remaining_qty) as inbound_wait_qty,
    count(*) filter (where remaining_qty > 0) as open_request_count,
    min(purchase_order_date) filter (where remaining_qty > 0) as first_request_date,
    max(purchase_order_date) filter (where remaining_qty > 0) as latest_request_date,
    min(delivery_date) filter (where remaining_qty > 0) as next_delivery_date,
    max(snapshot_at) as snapshot_at
from lidding_foil_planner.v_lidding_purchase_order_latest
where order_status_name in ('발주', '납품진행')
  and remaining_qty > 0
group by item_code, specification;

create or replace view lidding_foil_planner.v_lidding_purchase_wait as
select
    item_code,
    specification,
    max(item_name) as item_name,
    sum(request_qty) as request_qty,
    sum(purchase_order_qty) as purchase_order_qty,
    sum(not_ordered_qty) as purchase_wait_qty,
    count(*) as open_request_count,
    min(request_date) as first_request_date,
    max(request_date) as latest_request_date,
    min(requested_delivery_date) as next_delivery_date,
    max(snapshot_at) as snapshot_at
from lidding_foil_planner.v_lidding_purchase_request_latest
where approval_status = 'Y'
  and request_status_name = '완료'
  and not_ordered_qty > 0
group by item_code, specification;

comment on table lidding_foil_planner.purchase_request_snapshot is
    '구매 의뢰 현황 API의 BS 리드지 최신 원본 스냅샷. 발주대기는 승인·완료 건의 미발주수량';

comment on table lidding_foil_planner.purchase_order_snapshot is
    '구매 발주 현황 API의 BS 리드지 최신 원본 스냅샷';

comment on view lidding_foil_planner.v_lidding_inbound_wait is
    '구매의뢰번호 및 초과입고 등록 여부와 관계없이 발주·납품진행인 발주행의 품목코드+규격별 미납수량';

comment on view lidding_foil_planner.v_lidding_purchase_wait is
    '승인·완료 구매의뢰의 품목코드+규격별 미발주수량';
