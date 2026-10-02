-- #351: carryOut's in-flight voice work record, applied by the orchestrator
-- with the owner's yes (decisions row 263). Status stays 'pending' while an
-- operation is open, so every reader that checks for pending still sees the
-- item as unsettled.
alter table public.casting_tasks add column operation jsonb;
comment on column public.casting_tasks.operation is 'The in-flight voice work record carryOut writes before and after each paid step (#351). Null when no operation is open; status stays pending while it is set.';
