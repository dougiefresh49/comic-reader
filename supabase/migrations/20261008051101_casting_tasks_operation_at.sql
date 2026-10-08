-- casting_tasks.operation_at (#390): the database-clock stamp of a live
-- carryOut run's operation record. Additive only: one nullable column.

alter table public.casting_tasks add column operation_at timestamptz;

comment on column public.casting_tasks.operation_at is
  'When a live carryOut last wrote this row''s operation record (database clock); null once the run returned, so reconcile need not wait.';
