-- Use the configured monthly salary for an eligible employee in the selected
-- period. Joining and exit dates remain eligibility checks, never proration.
-- This function-only change preserves all financial and employment records.
create or replace function public.get_payroll_summary(p_period date, p_actor_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog
as $$
declare
  period_end date;
  period_start_timestamp timestamptz;
  period_end_timestamp timestamptz;
  result jsonb;
begin
  if p_actor_id is null or not exists (select 1 from public.admin_users where user_id = p_actor_id) then raise exception 'Administrator access is required'; end if;
  if p_period is null or date_trunc('month', p_period)::date <> p_period then raise exception 'Salary period must be the first day of a month'; end if;
  perform set_config('request.jwt.claim.sub', p_actor_id::text, true);
  period_end := (p_period + interval '1 month')::date;
  -- Payroll dates are local calendar dates. Convert each midnight explicitly
  -- to the timestamptz boundary and use the next month's start exclusively.
  period_start_timestamp := p_period::timestamp at time zone 'Asia/Kolkata';
  period_end_timestamp := period_end::timestamp at time zone 'Asia/Kolkata';
  -- Joining and employment end dates determine whether the employee overlaps
  -- the selected month. They never prorate the configured monthly salary.
  with people as (
    select 'guard'::text as employee_type, id as employee_id, employee_code, full_name, status, joining_date, employment_end_date from public.guards
    union all
    select 'supervisor', id, employee_code, full_name, status, joining_date, employment_end_date from public.supervisors
    union all
    select 'field_officer', id, employee_code, full_name, status, joining_date, employment_end_date from public.field_officers
  ), compensated as (
    select person.*,
      salary.gross_monthly_salary as configured_monthly_salary,
      salary.esi_applicable,
      salary.esi_contribution_rate,
      salary.pf_applicable,
      salary.pf_contribution_rate
    from people person
    left join lateral (
      select compensation.gross_monthly_salary, compensation.esi_applicable,
        compensation.esi_contribution_rate, compensation.pf_applicable,
        compensation.pf_contribution_rate
      from public.employee_compensation compensation
      where compensation.employee_type = person.employee_type
        and ((person.employee_type = 'guard' and compensation.guard_id = person.employee_id)
          or (person.employee_type = 'supervisor' and compensation.supervisor_id = person.employee_id)
          or (person.employee_type = 'field_officer' and compensation.field_officer_id = person.employee_id))
        and compensation.effective_from <= period_end - 1
        and (compensation.effective_to is null or compensation.effective_to >= p_period)
      order by compensation.effective_from desc limit 1
    ) salary on true
  ), calculated as (
    select person.*,
      case
        when (person.joining_date is null or person.joining_date <= period_end - 1)
          and (person.employment_end_date is null or person.employment_end_date >= p_period)
          and person.configured_monthly_salary is not null
        then person.configured_monthly_salary else 0
      end as gross_for_period,
      coalesce(person.configured_monthly_salary, 0) as configured_monthly_gross,
      ((person.joining_date is null or person.joining_date <= period_end - 1)
        and (person.employment_end_date is null or person.employment_end_date >= p_period)
        and person.configured_monthly_salary is not null) as salary_eligible,
      case
        when person.joining_date > period_end - 1 then 'Not eligible: joining date is after the selected month'
        when person.employment_end_date < p_period then 'Not eligible: employment ended before the selected month'
        when person.configured_monthly_salary is null then 'Monthly salary is not configured for the selected month'
        else 'Eligible for selected month'
      end as salary_eligibility_status,
      coalesce((select sum(case when adjustment.adjustment_type = 'addition' then adjustment.amount else 0 end)
        from public.salary_adjustments adjustment where adjustment.employee_type = person.employee_type
          and ((person.employee_type = 'guard' and adjustment.guard_id = person.employee_id)
            or (person.employee_type = 'supervisor' and adjustment.supervisor_id = person.employee_id)
            or (person.employee_type = 'field_officer' and adjustment.field_officer_id = person.employee_id))
          and adjustment.salary_period = p_period and adjustment.is_approved
          and adjustment.created_at < period_end_timestamp), 0) as approved_additions,
      coalesce((select sum(case when adjustment.adjustment_type = 'deduction' then adjustment.amount else 0 end)
        from public.salary_adjustments adjustment where adjustment.employee_type = person.employee_type
          and ((person.employee_type = 'guard' and adjustment.guard_id = person.employee_id)
            or (person.employee_type = 'supervisor' and adjustment.supervisor_id = person.employee_id)
            or (person.employee_type = 'field_officer' and adjustment.field_officer_id = person.employee_id))
          and adjustment.salary_period = p_period and adjustment.is_approved
          and adjustment.created_at < period_end_timestamp), 0) as approved_deductions,
      coalesce((select sum(advance.amount) from public.advances advance where advance.employee_type = person.employee_type
        and ((person.employee_type = 'guard' and advance.guard_id = person.employee_id)
          or (person.employee_type = 'supervisor' and advance.supervisor_id = person.employee_id)
          or (person.employee_type = 'field_officer' and advance.field_officer_id = person.employee_id))
        and advance.occurred_at >= period_start_timestamp and advance.occurred_at < period_end_timestamp), 0) as advances_given_period,
      coalesce((select sum(recovery.amount) from public.advance_recoveries recovery join public.advances advance on advance.id = recovery.advance_id
        where recovery.salary_period = p_period and recovery.created_at < period_end_timestamp
          and advance.employee_type = person.employee_type
          and ((person.employee_type = 'guard' and advance.guard_id = person.employee_id)
            or (person.employee_type = 'supervisor' and advance.supervisor_id = person.employee_id)
            or (person.employee_type = 'field_officer' and advance.field_officer_id = person.employee_id))), 0) as recovered_period,
      coalesce((select sum(advance.amount + coalesce((select sum(adj.amount_delta) from public.advance_adjustments adj where adj.advance_id = advance.id and adj.created_at < period_end_timestamp), 0)
        - coalesce((select sum(rec.amount) from public.advance_recoveries rec where rec.advance_id = advance.id and rec.salary_period < period_end and rec.created_at < period_end_timestamp), 0))
        from public.advances advance where advance.employee_type = person.employee_type
          and ((person.employee_type = 'guard' and advance.guard_id = person.employee_id)
            or (person.employee_type = 'supervisor' and advance.supervisor_id = person.employee_id)
            or (person.employee_type = 'field_officer' and advance.field_officer_id = person.employee_id))
          and advance.occurred_at < period_end_timestamp), 0) as remaining_advance_balance
    from compensated person
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'employee_type', employee_type, 'employee_id', employee_id, 'employee_code', employee_code,
    'full_name', full_name, 'status', status, 'joining_date', joining_date, 'employment_end_date', employment_end_date,
    'salary_eligible', salary_eligible, 'salary_eligibility_status', salary_eligibility_status,
    'configured_monthly_salary', configured_monthly_gross, 'total_salary', round(gross_for_period, 2),
    'configured_monthly_gross', configured_monthly_gross, 'gross_for_period', round(gross_for_period, 2),
    'esi_applicable', esi_applicable, 'esi_contribution_rate', esi_contribution_rate,
    'pf_applicable', pf_applicable, 'pf_contribution_rate', pf_contribution_rate,
    'approved_additions', approved_additions, 'approved_deductions', approved_deductions,
    'advances_given_period', advances_given_period, 'recovered_period', recovered_period,
    'remaining_advance_balance', remaining_advance_balance,
    'net_payable_estimate', round(gross_for_period + approved_additions - approved_deductions - recovered_period, 2)
  ) order by full_name), '[]'::jsonb)
  into result from calculated;
  return result;
end;
$$;
revoke all on function public.get_payroll_summary(date, uuid) from public, anon, authenticated;
grant execute on function public.get_payroll_summary(date, uuid) to service_role;
