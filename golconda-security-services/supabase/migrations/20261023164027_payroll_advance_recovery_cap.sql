-- Finalized advance allocations for one employee and salary month must not
-- exceed that employee's available period salary. Locking the employee row
-- serializes allocations across different advances and Sites.
create or replace function public.append_advance_recovery(p_recovery jsonb, p_actor_id uuid)
returns bigint
language plpgsql
security invoker
set search_path = pg_catalog
as $$
declare
  recovery_id_value bigint;
  advance_record public.advances%rowtype;
  employee_id_value bigint;
  salary_period_value date;
  requested_amount numeric(12,2);
  payroll_result jsonb;
  payroll_row jsonb;
  salary_available numeric(12,2);
  already_recovered numeric(12,2);
begin
  if p_actor_id is null or not exists (select 1 from public.admin_users where user_id = p_actor_id) then
    raise exception 'Administrator access is required';
  end if;
  perform set_config('request.jwt.claim.sub', p_actor_id::text, true);

  select * into advance_record
  from public.advances
  where id = nullif(p_recovery ->> 'advance_id', '')::bigint
  for update;
  if not found then raise exception using errcode = 'P0002', message = 'Advance was not found'; end if;

  employee_id_value := coalesce(advance_record.guard_id, advance_record.supervisor_id, advance_record.field_officer_id);
  case advance_record.employee_type
    when 'guard' then perform 1 from public.guards where id = employee_id_value for update;
    when 'supervisor' then perform 1 from public.supervisors where id = employee_id_value for update;
    when 'field_officer' then perform 1 from public.field_officers where id = employee_id_value for update;
    else raise exception 'Employee type is invalid';
  end case;
  if not found then raise exception using errcode = 'P0002', message = 'Employee was not found'; end if;

  salary_period_value := nullif(p_recovery ->> 'salary_period', '')::date;
  requested_amount := nullif(p_recovery ->> 'amount', '')::numeric;
  if salary_period_value is null or date_trunc('month', salary_period_value)::date <> salary_period_value then
    raise exception 'Salary period must be the first day of a month';
  end if;
  if requested_amount is null or requested_amount <= 0 then raise exception 'Recovery amount must be greater than zero'; end if;

  payroll_result := public.get_payroll_summary(salary_period_value, p_actor_id);
  select element.value into payroll_row
  from jsonb_array_elements(coalesce(payroll_result, '[]'::jsonb)) as element(value)
  where element.value ->> 'employee_type' = advance_record.employee_type
    and element.value ->> 'employee_id' = employee_id_value::text;
  if payroll_row is null then raise exception using errcode = 'P0002', message = 'Payroll estimate was not found for this employee'; end if;

  salary_available := greatest(0::numeric, round(
    coalesce(nullif(payroll_row ->> 'gross_for_period', '')::numeric, 0)
    + coalesce(nullif(payroll_row ->> 'approved_additions', '')::numeric, 0)
    - coalesce(nullif(payroll_row ->> 'approved_deductions', '')::numeric, 0), 2
  ));
  select coalesce(sum(recovery.amount), 0)
  into already_recovered
  from public.advance_recoveries recovery
  join public.advances advance on advance.id = recovery.advance_id
  where recovery.salary_period = salary_period_value
    and advance.employee_type = advance_record.employee_type
    and ((advance_record.employee_type = 'guard' and advance.guard_id = employee_id_value)
      or (advance_record.employee_type = 'supervisor' and advance.supervisor_id = employee_id_value)
      or (advance_record.employee_type = 'field_officer' and advance.field_officer_id = employee_id_value));

  if requested_amount > greatest(0::numeric, salary_available - already_recovered) then
    raise exception using errcode = '23514', message = 'Recovery exceeds the salary available for this period';
  end if;

  insert into public.advance_recoveries(advance_id, salary_period, amount, notes, created_by)
  values (advance_record.id, salary_period_value, requested_amount, coalesce(p_recovery ->> 'notes', ''), p_actor_id)
  returning id into recovery_id_value;
  return recovery_id_value;
end;
$$;
