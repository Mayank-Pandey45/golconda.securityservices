-- Optional Google Sheets synchronization. Supabase remains authoritative. The
-- private outbox is opt-in per server-authorized record_advance call; disabled
-- or incomplete integration settings create no unsynced outbox items.
create table if not exists public.advance_sheet_sync_outbox (
  advance_id bigint primary key references public.advances(id) on delete restrict,
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  locked_until timestamptz,
  last_error text,
  synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists advance_sheet_sync_pending_idx
  on public.advance_sheet_sync_outbox(next_attempt_at, created_at)
  where synced_at is null;

alter table public.advance_sheet_sync_outbox enable row level security;
drop policy if exists "Admins read advance sheet sync status" on public.advance_sheet_sync_outbox;
create policy "Admins read advance sheet sync status" on public.advance_sheet_sync_outbox
  for select to authenticated
  using (exists (select 1 from public.admin_users where user_id = (select auth.uid())));
revoke all on table public.advance_sheet_sync_outbox from public, anon;
revoke insert, update, delete on table public.advance_sheet_sync_outbox from authenticated;
grant select on table public.advance_sheet_sync_outbox to authenticated;
grant all on table public.advance_sheet_sync_outbox to service_role;

create or replace function operations_private.enqueue_advance_sheet_sync()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if coalesce(current_setting('operations.google_sheets_sync_enabled', true), 'false') = 'true' then
    insert into public.advance_sheet_sync_outbox(advance_id)
    values (new.id)
    on conflict (advance_id) do nothing;
  end if;
  return new;
end;
$$;
revoke all on function operations_private.enqueue_advance_sheet_sync() from public, anon, authenticated;

drop trigger if exists advances_enqueue_sheet_sync on public.advances;
create trigger advances_enqueue_sheet_sync
  after insert on public.advances
  for each row execute function operations_private.enqueue_advance_sheet_sync();

create or replace function public.claim_advance_sheet_sync(p_limit integer default 20)
returns table (
  advance_id bigint,
  employee_type text,
  employee_code text,
  employee_name text,
  site_code text,
  site_name text,
  amount numeric,
  occurred_at timestamptz,
  payment_mode text,
  description text,
  source text
)
language sql
security definer
set search_path = pg_catalog
as $$
  with candidates as (
    select outbox.advance_id
    from public.advance_sheet_sync_outbox as outbox
    where outbox.synced_at is null
      and outbox.next_attempt_at <= now()
      and (outbox.locked_until is null or outbox.locked_until <= now())
    order by outbox.next_attempt_at, outbox.created_at, outbox.advance_id
    for update skip locked
    limit greatest(1, least(coalesce(p_limit, 20), 50))
  ), claimed as (
    update public.advance_sheet_sync_outbox as outbox
    set attempts = outbox.attempts + 1,
        locked_until = now() + interval '10 minutes',
        updated_at = now()
    from candidates
    where outbox.advance_id = candidates.advance_id
    returning outbox.advance_id
  )
  select advance.id,
    advance.employee_type,
    coalesce(guard.employee_code, supervisor.employee_code, officer.employee_code, ''),
    coalesce(guard.full_name, supervisor.full_name, officer.full_name, ''),
    coalesce(site.site_code, ''),
    coalesce(site.title, ''),
    advance.amount,
    advance.occurred_at,
    advance.payment_mode,
    advance.description,
    advance.source
  from claimed
  join public.advances as advance on advance.id = claimed.advance_id
  left join public.guards as guard on guard.id = advance.guard_id
  left join public.supervisors as supervisor on supervisor.id = advance.supervisor_id
  left join public.field_officers as officer on officer.id = advance.field_officer_id
  left join public.sites as site on site.id = advance.site_id
  order by advance.occurred_at, advance.id;
$$;

create or replace function public.complete_advance_sheet_sync(p_advance_id bigint)
returns boolean
language sql
security definer
set search_path = pg_catalog
as $$
  with completed as (
    update public.advance_sheet_sync_outbox
    set synced_at = now(), locked_until = null, last_error = null, updated_at = now()
    where advance_id = p_advance_id and synced_at is null
    returning 1
  )
  select exists(select 1 from completed);
$$;

create or replace function public.retry_advance_sheet_sync(p_advance_id bigint, p_error_code text)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare updated_count integer;
begin
  update public.advance_sheet_sync_outbox
  set next_attempt_at = now() + make_interval(mins => least(360, power(2, least(attempts, 8))::integer)),
      locked_until = null,
      last_error = case when p_error_code ~ '^[a-z0-9_]{1,64}$' then p_error_code else 'sync_failed' end,
      updated_at = now()
  where advance_id = p_advance_id and synced_at is null;
  get diagnostics updated_count = row_count;
  return updated_count > 0;
end;
$$;

revoke all on function public.claim_advance_sheet_sync(integer) from public, anon, authenticated;
revoke all on function public.complete_advance_sheet_sync(bigint) from public, anon, authenticated;
revoke all on function public.retry_advance_sheet_sync(bigint, text) from public, anon, authenticated;
grant execute on function public.claim_advance_sheet_sync(integer) to service_role;
grant execute on function public.complete_advance_sheet_sync(bigint) to service_role;
grant execute on function public.retry_advance_sheet_sync(bigint, text) to service_role;
