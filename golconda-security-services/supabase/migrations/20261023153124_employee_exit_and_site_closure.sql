-- Record employee exits and site closures as atomic, additive lifecycle actions.
-- Financial rows, assignments, and audit events are retained.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';

alter table public.guards
  add column if not exists exit_reason text,
  add column if not exists exit_remarks text not null default '';
alter table public.supervisors
  add column if not exists exit_reason text,
  add column if not exists exit_remarks text not null default '';
alter table public.field_officers
  add column if not exists exit_reason text,
  add column if not exists exit_remarks text not null default '';
alter table public.sites
  add column if not exists contract_start_date date,
  add column if not exists contract_end_date date,
  add column if not exists closure_date date,
  add column if not exists closure_reason text,
  add column if not exists closure_remarks text not null default '';

alter table public.guards add constraint guards_exit_reason_check
  check (exit_reason is null or exit_reason in ('Resigned','Terminated','Left Company','Other'));
alter table public.supervisors add constraint supervisors_exit_reason_check
  check (exit_reason is null or exit_reason in ('Resigned','Terminated','Left Company','Other'));
alter table public.field_officers add constraint field_officers_exit_reason_check
  check (exit_reason is null or exit_reason in ('Resigned','Terminated','Left Company','Other'));
alter table public.sites add constraint sites_contract_dates_check
  check (contract_end_date is null or contract_start_date is null or contract_end_date >= contract_start_date);

create index guards_former_employee_idx on public.guards(employment_end_date desc, id) where status = 'relieved';
create index supervisors_former_employee_idx on public.supervisors(employment_end_date desc, id) where status = 'relieved';
create index field_officers_former_employee_idx on public.field_officers(employment_end_date desc, id) where status = 'relieved';
create index sites_closed_idx on public.sites(closure_date desc, id) where closure_date is not null;

create or replace function operations_private.prevent_closed_site_reopen()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  if old.closure_date is not null and new.status = 'active' then
    raise exception 'A closed site cannot be reactivated without an explicit reopening workflow' using errcode = '55000';
  end if;
  return new;
end;
$$;
revoke all on function operations_private.prevent_closed_site_reopen() from public, anon, authenticated;
create trigger prevent_closed_site_reopen before update of status on public.sites
for each row execute function operations_private.prevent_closed_site_reopen();

create or replace function operations_private.preserve_employee_exit()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  if old.exit_reason is not null and (
    new.status = 'active'
    or new.employment_end_date is distinct from old.employment_end_date
    or new.exit_reason is distinct from old.exit_reason
  ) then
    raise exception 'Former employee exit details are retained; use an explicit rehire workflow to change employment status' using errcode = '55000';
  end if;
  return new;
end;
$$;
revoke all on function operations_private.preserve_employee_exit() from public, anon, authenticated;
create trigger preserve_guard_exit before update of status, employment_end_date, exit_reason on public.guards
for each row execute function operations_private.preserve_employee_exit();
create trigger preserve_supervisor_exit before update of status, employment_end_date, exit_reason on public.supervisors
for each row execute function operations_private.preserve_employee_exit();
create trigger preserve_field_officer_exit before update of status, employment_end_date, exit_reason on public.field_officers
for each row execute function operations_private.preserve_employee_exit();

create or replace function public.exit_employee(
  p_employee_type text,
  p_employee_id bigint,
  p_exit_reason text,
  p_last_working_date date,
  p_remarks text,
  p_actor_id uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog
as $$
declare
  old_status text;
  joining_date_value date;
  previous_end_date date;
  previous_reason text;
  previous_remarks text;
  reason_value text := btrim(coalesce(p_exit_reason, ''));
  remarks_value text := btrim(coalesce(p_remarks, ''));
begin
  if p_actor_id is null or not exists (select 1 from public.admin_users where user_id = p_actor_id) then
    raise exception 'Administrator access is required' using errcode = '42501';
  end if;
  if p_employee_type is null or p_employee_type not in ('guard','supervisor','field_officer') then raise exception 'Employee type is invalid' using errcode = '22023'; end if;
  if p_employee_id is null or p_employee_id < 1 then raise exception 'Employee ID is invalid' using errcode = '22023'; end if;
  if reason_value not in ('Resigned','Terminated','Left Company','Other') then raise exception 'Choose a valid employee exit reason' using errcode = '22023'; end if;
  if p_last_working_date is null or length(remarks_value) > 2000 then raise exception 'Last working date and remarks (maximum 2,000 characters) are required' using errcode = '22023'; end if;
  if p_last_working_date > (now() at time zone 'Asia/Kolkata')::date then raise exception 'Last working date cannot be in the future' using errcode = '22023'; end if;
  if reason_value = 'Other' and remarks_value = '' then raise exception 'Add remarks when the exit reason is Other' using errcode = '22023'; end if;

  if p_employee_type = 'guard' then
    select status, joining_date, employment_end_date, exit_reason, exit_remarks
      into old_status, joining_date_value, previous_end_date, previous_reason, previous_remarks
      from public.guards where id = p_employee_id for update;
  elsif p_employee_type = 'supervisor' then
    select status, joining_date, employment_end_date, exit_reason, exit_remarks
      into old_status, joining_date_value, previous_end_date, previous_reason, previous_remarks
      from public.supervisors where id = p_employee_id for update;
  else
    select status, joining_date, employment_end_date, exit_reason, exit_remarks
      into old_status, joining_date_value, previous_end_date, previous_reason, previous_remarks
      from public.field_officers where id = p_employee_id for update;
  end if;
  if old_status is null then raise exception 'Employee was not found' using errcode = 'P0002'; end if;
  if joining_date_value is not null and p_last_working_date < joining_date_value then raise exception 'Last working date cannot be before the joining date' using errcode = '22023'; end if;
  if old_status = 'relieved' then
    if previous_end_date = p_last_working_date and previous_reason = reason_value and previous_remarks = remarks_value then
      return jsonb_build_object('employee_id', p_employee_id, 'employee_type', p_employee_type, 'status', 'relieved', 'employment_end_date', previous_end_date, 'already_applied', true);
    end if;
    raise exception 'This employee already has a recorded exit. Review the profile before changing it' using errcode = '55000';
  end if;

  perform set_config('request.jwt.claim.sub', p_actor_id::text, true);
  if p_employee_type = 'guard' then
    update public.guards set status = 'relieved', employment_end_date = p_last_working_date, exit_reason = reason_value, exit_remarks = remarks_value, updated_at = now() where id = p_employee_id;
  elsif p_employee_type = 'supervisor' then
    update public.supervisors set status = 'relieved', employment_end_date = p_last_working_date, exit_reason = reason_value, exit_remarks = remarks_value, updated_at = now() where id = p_employee_id;
  else
    update public.field_officers set status = 'relieved', employment_end_date = p_last_working_date, exit_reason = reason_value, exit_remarks = remarks_value, updated_at = now() where id = p_employee_id;
  end if;

  -- Future scheduled assignments are cancelled on their start date, satisfying
  -- the assignment date-range constraint without inventing a prior work date.
  if p_employee_type = 'guard' then
    update public.guard_site_assignments set valid_to = greatest(valid_from, p_last_working_date) where guard_id = p_employee_id and valid_to is null;
  elsif p_employee_type = 'supervisor' then
    update public.supervisor_site_assignments set valid_to = greatest(valid_from, p_last_working_date) where supervisor_id = p_employee_id and valid_to is null;
    update public.supervisor_reporting set valid_to = greatest(valid_from, p_last_working_date) where supervisor_id = p_employee_id and valid_to is null;
  else
    update public.field_officer_site_assignments set valid_to = greatest(valid_from, p_last_working_date) where field_officer_id = p_employee_id and valid_to is null;
    update public.supervisor_reporting set valid_to = greatest(valid_from, p_last_working_date) where field_officer_id = p_employee_id and valid_to is null;
  end if;
  return jsonb_build_object('employee_id', p_employee_id, 'employee_type', p_employee_type, 'status', 'relieved', 'employment_end_date', p_last_working_date, 'already_applied', false);
end;
$$;
revoke all on function public.exit_employee(text,bigint,text,date,text,uuid) from public, anon, authenticated;
grant execute on function public.exit_employee(text,bigint,text,date,text,uuid) to service_role;

create or replace function public.close_site(
  p_site_id bigint,
  p_closure_reason text,
  p_contract_end_date date,
  p_remarks text,
  p_actor_id uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog
as $$
declare
  site_status_value text;
  old_closure_date date;
  old_reason text;
  old_remarks text;
  contract_start_value date;
  reason_value text := btrim(coalesce(p_closure_reason, ''));
  remarks_value text := btrim(coalesce(p_remarks, ''));
  guard_count integer := 0;
  supervisor_count integer := 0;
  officer_count integer := 0;
begin
  if p_actor_id is null or not exists (select 1 from public.admin_users where user_id = p_actor_id) then
    raise exception 'Administrator access is required' using errcode = '42501';
  end if;
  if p_site_id is null or p_site_id < 1 then raise exception 'Site ID is invalid' using errcode = '22023'; end if;
  if reason_value = '' or length(reason_value) > 200 then raise exception 'Closure reason must be 1 to 200 characters' using errcode = '22023'; end if;
  if p_contract_end_date is null or length(remarks_value) > 2000 then raise exception 'Contract end date and remarks (maximum 2,000 characters) are required' using errcode = '22023'; end if;
  if p_contract_end_date > (now() at time zone 'Asia/Kolkata')::date then raise exception 'Contract end date cannot be in the future when closing a Site' using errcode = '22023'; end if;
  select status, closure_date, closure_reason, closure_remarks, contract_start_date
    into site_status_value, old_closure_date, old_reason, old_remarks, contract_start_value
    from public.sites where id = p_site_id for update;
  if site_status_value is null then raise exception 'Site was not found' using errcode = 'P0002'; end if;
  if contract_start_value is not null and p_contract_end_date < contract_start_value then raise exception 'Contract end date cannot be before the contract start date' using errcode = '22023'; end if;
  if site_status_value = 'inactive' and old_closure_date is not null then
    if old_closure_date = p_contract_end_date and old_reason = reason_value and old_remarks = remarks_value then
      return jsonb_build_object('site_id', p_site_id, 'status', 'inactive', 'closure_date', old_closure_date, 'already_applied', true);
    end if;
    raise exception 'This site is already closed. Review the Site Profile before changing its closure' using errcode = '55000';
  end if;
  perform set_config('request.jwt.claim.sub', p_actor_id::text, true);
  update public.sites set status = 'inactive', contract_end_date = p_contract_end_date, closure_date = p_contract_end_date,
    closure_reason = reason_value, closure_remarks = remarks_value, updated_at = now() where id = p_site_id;
  update public.guard_site_assignments set valid_to = greatest(valid_from, p_contract_end_date) where site_id = p_site_id and valid_to is null;
  get diagnostics guard_count = row_count;
  update public.supervisor_site_assignments set valid_to = greatest(valid_from, p_contract_end_date) where site_id = p_site_id and valid_to is null;
  get diagnostics supervisor_count = row_count;
  update public.field_officer_site_assignments set valid_to = greatest(valid_from, p_contract_end_date) where site_id = p_site_id and valid_to is null;
  get diagnostics officer_count = row_count;
  return jsonb_build_object('site_id', p_site_id, 'status', 'inactive', 'closure_date', p_contract_end_date, 'guards_ended', guard_count, 'supervisors_ended', supervisor_count, 'field_officers_ended', officer_count, 'already_applied', false);
end;
$$;
revoke all on function public.close_site(bigint,text,date,text,uuid) from public, anon, authenticated;
grant execute on function public.close_site(bigint,text,date,text,uuid) to service_role;

commit;
