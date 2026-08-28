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

create table if not exists lidding_foil_planner.production_performance (
    record_key text primary key,
    row_hash text not null,
    check_sheet_no text,
    pr_no text,
    pr_dt date not null,
    gong_cd text,
    fac_cd text,
    sachul_fac_cd text,
    wa_gu text,
    gd_cd text,
    gd_nm text,
    sale_cd text,
    model_no text,
    model_no2 text,
    full_gu text,
    percontent numeric,
    spec text,
    spec30 text,
    size_spec text,
    jisi_spec text,
    unit_cd text,
    job_qty numeric,
    pr_qty numeric,
    ng_qty numeric,
    sample_qty numeric,
    tot_qty numeric,
    keep_sample_qty numeric,
    mate_no text,
    test_yn text,
    mc_cd text,
    pre_mc_cd text,
    mc_10 text,
    stts text,
    stts_label text,
    bc_result text,
    dia_result text,
    w_power text,
    size80 text,
    bc80 text,
    loss_cd text,
    loss_nm text,
    source_extracted_at timestamptz,
    api_endpoint text not null,
    raw_payload jsonb not null,
    collected_at timestamptz not null default now(),
    run_id bigint not null references lidding_foil_planner.collection_run (run_id),
    constraint production_performance_record_key_length check (length(record_key) = 64),
    constraint production_performance_row_hash_length check (length(row_hash) = 64)
);

create index if not exists idx_production_performance_date_process_item
    on lidding_foil_planner.production_performance (pr_dt desc, gong_cd, sale_cd);

create index if not exists idx_production_performance_sale_date
    on lidding_foil_planner.production_performance (sale_cd, pr_dt desc);

create index if not exists idx_production_performance_item_date
    on lidding_foil_planner.production_performance (gd_cd, pr_dt desc);

create index if not exists idx_production_performance_factory_process_date
    on lidding_foil_planner.production_performance (fac_cd, gong_cd, pr_dt desc);

create index if not exists idx_production_performance_mate_date
    on lidding_foil_planner.production_performance (mate_no, pr_dt desc);

create index if not exists idx_production_performance_run
    on lidding_foil_planner.production_performance (run_id);

comment on schema lidding_foil_planner is
    'Lidding Foil Planner automated dashboard data';

comment on table lidding_foil_planner.production_performance is
    'Dedicated current table for /api/production-performance; operator identifiers are intentionally excluded';

