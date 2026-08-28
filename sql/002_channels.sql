create schema if not exists lidding_foil_planner;

create table if not exists lidding_foil_planner.collection_run (
    run_id bigint generated always as identity primary key,
    channel text not null,
    status text not null check (status in ('running', 'success', 'failed')),
    requested_date_from date,
    requested_date_to date,
    source_refreshed_at timestamptz,
    source_total_count bigint,
    received_count bigint,
    replaced_count bigint,
    started_at timestamptz not null default now(),
    finished_at timestamptz,
    error_message text,
    metadata jsonb not null default '{}'::jsonb
);

create index if not exists idx_collection_run_channel_started
    on lidding_foil_planner.collection_run (channel, started_at desc);

create table if not exists lidding_foil_planner.aps_hydration_shortage (
    row_key text primary key check (length(row_key) = 64),
    source_refreshed_at timestamptz not null,
    plan_date date not null,
    oper_id text not null check (oper_id = '45'),
    res_id text,
    site_name text,
    demand_id text,
    item_id text not null,
    p_code text not null check (p_code like 'P%'),
    item_name text,
    shortage_qty numeric not null check (shortage_qty > 0),
    due_date date,
    demand_type text,
    sales_order_no text,
    collected_at timestamptz not null default now(),
    run_id bigint not null references lidding_foil_planner.collection_run (run_id)
);

create index if not exists idx_aps_hydration_shortage_p_code_due
    on lidding_foil_planner.aps_hydration_shortage (p_code, due_date);

create index if not exists idx_aps_hydration_shortage_plan_date
    on lidding_foil_planner.aps_hydration_shortage (plan_date);

create table if not exists lidding_foil_planner.production_performance_55 (
    row_key text primary key check (length(row_key) = 64),
    production_date date not null,
    factory_code text not null,
    item_code text not null,
    instruction_qty numeric not null,
    source_row_count bigint not null check (source_row_count > 0),
    source_extracted_at timestamptz,
    collected_at timestamptz not null default now(),
    run_id bigint not null references lidding_foil_planner.collection_run (run_id),
    unique (production_date, factory_code, item_code)
);

create index if not exists idx_production_performance_55_item_date
    on lidding_foil_planner.production_performance_55 (item_code, production_date desc);

create table if not exists lidding_foil_planner.bom_lidding_foil (
    row_key text primary key check (length(row_key) = 64),
    p_code text not null check (p_code like 'P%'),
    bs_code text not null check (bs_code like 'BS%'),
    lidding_foil_name text not null,
    specification text,
    usage_qty numeric not null,
    use_yn text not null check (use_yn = 'Y'),
    source_extracted_at timestamptz,
    collected_at timestamptz not null default now(),
    run_id bigint not null references lidding_foil_planner.collection_run (run_id),
    unique (p_code, bs_code, specification)
);

create index if not exists idx_bom_lidding_foil_bs_code
    on lidding_foil_planner.bom_lidding_foil (bs_code, p_code);

comment on table lidding_foil_planner.aps_hydration_shortage is
    'Latest APS outbound shortage rows for hydration process 45';

comment on table lidding_foil_planner.production_performance_55 is
    'Seven-day process 55 instruction quantity aggregated by date, factory and item';

comment on table lidding_foil_planner.bom_lidding_foil is
    'Active P-code to BS-code lidding foil mapping for P-codes in the current APS hydration snapshot';

