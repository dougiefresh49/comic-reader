-- casting_tasks.operation_at (#390): the database-clock stamp of a live
-- carryOut run's operation record. Additive only: one nullable column.

alter table public.casting_tasks add column operation_at timestamptz;

comment on column public.casting_tasks.operation_at is
  'When a live carryOut last wrote this row''s operation record (database clock). A returned run clears it at claimed, archived, added or retired, so reconcile need not wait; at archiving, retiring or adding it stays, since a request that timed out may still land.';
