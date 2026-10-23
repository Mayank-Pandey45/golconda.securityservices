import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const coreMigration = await readFile(new URL("../supabase/migrations/20261021151502_operations_platform_core.sql", import.meta.url), "utf8");
const outboxMigration = await readFile(new URL("../supabase/migrations/20261021191500_advance_integrations_outbox.sql", import.meta.url), "utf8");
const preflight = await readFile(new URL("../supabase/preflight_staging.sql", import.meta.url), "utf8");
const payrollRecoveryMigration = await readFile(new URL("../supabase/migrations/20261023164027_payroll_advance_recovery_cap.sql", import.meta.url), "utf8");

function referenceMonthlyGross(monthlySalary, periodStart, joiningDate = null, employmentEndDate = null, status = "active") {
  const [year, month] = periodStart.split("-").map(Number);
  const periodEnd = new Date(Date.UTC(year, month, 1));
  const firstDay = new Date(Date.UTC(year, month - 1, 1));
  const lastDay = new Date(periodEnd.valueOf() - 86400000);
  const joining = joiningDate ? new Date(`${joiningDate}T00:00:00.000Z`) : firstDay;
  const ending = employmentEndDate ? new Date(`${employmentEndDate}T00:00:00.000Z`) : lastDay;
  const paidStart = joining > firstDay ? joining : firstDay;
  const paidEnd = ending < lastDay ? ending : lastDay;
  if (paidStart > paidEnd) return 0;
  const paidDays = Math.floor((paidEnd - paidStart) / 86400000) + 1;
  const daysInMonth = Math.floor((lastDay - firstDay) / 86400000) + 1;
  // Employment status intentionally does not change date-based accrual.
  void status;
  return Number((monthlySalary * paidDays / daysInMonth).toFixed(2));
}

test("payroll policy uses inclusive calendar dates and handles month boundaries and leap February", () => {
  assert.equal(referenceMonthlyGross(31000, "2026-10", "2026-10-01", "2026-10-31"), 31000);
  assert.equal(referenceMonthlyGross(31000, "2026-10", "2026-10-16"), 16000);
  assert.equal(referenceMonthlyGross(31000, "2026-10", null, "2026-10-16"), 16000);
  assert.equal(referenceMonthlyGross(29000, "2024-02", "2024-02-29", "2024-02-29"), 1000);
  assert.equal(referenceMonthlyGross(31000, "2026-10", null, "2026-09-30"), 0);
  assert.equal(referenceMonthlyGross(31000, "2026-10", "2026-10-16", null, "inactive"), 16000);
});

test("payroll assigns recoveries by salary_period and uses next-month Asia/Kolkata midnight exclusively", () => {
  const periodStart = Date.parse("2026-10-01T00:00:00+05:30");
  const cutoff = Date.parse("2026-11-01T00:00:00+05:30");
  const advanceInOctober = occurredAt => Date.parse(occurredAt) >= periodStart && Date.parse(occurredAt) < cutoff;
  const belongsToOctober = (salaryPeriod, createdAt) => salaryPeriod === "2026-10-01" && Date.parse(createdAt) < cutoff;
  assert.equal(advanceInOctober("2026-09-30T18:30:00.000Z"), true);
  assert.equal(advanceInOctober("2026-09-30T18:29:59.999Z"), false);
  assert.equal(advanceInOctober("2026-10-31T18:29:59.999Z"), true);
  assert.equal(advanceInOctober("2026-10-31T18:30:00.000Z"), false);
  assert.equal(belongsToOctober("2026-10-01", "2026-10-31T18:29:59.999Z"), true);
  assert.equal(belongsToOctober("2026-10-01", "2026-10-31T18:30:00.000Z"), false);
  assert.equal(belongsToOctober("2026-11-01", "2026-10-31T18:00:00.000Z"), false);
});

test("payroll SQL keeps explicit Asia/Kolkata boundaries, exclusive next-month cutoff, and date-based accrual", () => {
  const start = coreMigration.indexOf("create or replace function public.get_payroll_summary(");
  const end = coreMigration.indexOf("create or replace function public.get_filtered_advances_total(", start);
  const payroll = coreMigration.slice(start, end);
  assert.match(payroll, /p_period::timestamp at time zone 'Asia\/Kolkata'/);
  assert.match(payroll, /period_end::timestamp at time zone 'Asia\/Kolkata'/);
  assert.match(payroll, /advance\.occurred_at >= period_start_timestamp and advance\.occurred_at < period_end_timestamp/);
  assert.match(payroll, /recovery\.salary_period = p_period and recovery\.created_at < period_end_timestamp/);
  assert.match(payroll, /generate_series\(\s*0,/);
  assert.match(payroll, /person\.employment_end_date, period_end - 1/);
  assert.match(payroll, /person\.joining_date, p_period/);
  assert.doesNotMatch(payroll, /period_end::timestamptz/);
  assert.doesNotMatch(payroll, /person\.status\s*=\s*'active'/);
});

test("advance recovery cap is admin-only, atomic across Sites, and leaves the append-only schema intact", () => {
  assert.match(payrollRecoveryMigration, /security invoker/i);
  assert.match(payrollRecoveryMigration, /p_actor_id is null or not exists\s*\(select 1 from public\.admin_users/i);
  assert.match(payrollRecoveryMigration, /from public\.advances[\s\S]*?for update/i);
  assert.match(payrollRecoveryMigration, /from public\.guards where id = employee_id_value for update/i);
  assert.match(payrollRecoveryMigration, /from public\.supervisors where id = employee_id_value for update/i);
  assert.match(payrollRecoveryMigration, /from public\.field_officers where id = employee_id_value for update/i);
  assert.match(payrollRecoveryMigration, /salary_available - already_recovered/i);
  assert.match(payrollRecoveryMigration, /errcode = '23514'/i);
  assert.match(coreMigration, /unique \(advance_id, salary_period\)/i);
  assert.doesNotMatch(payrollRecoveryMigration, /drop\s+(?:table|column)|truncate|delete from public\./i);
});

test("site import closes active assignments for inactive or relieved staff before considering new assignments", () => {
  const importStart = coreMigration.indexOf("create or replace function public.import_operations_sites(");
  const importEnd = coreMigration.indexOf("create or replace function public.get_payroll_summary(", importStart);
  const sql = coreMigration.slice(importStart, importEnd);
  const assignmentTargets = [
    ["guards", "guard_site_assignments", "guard_id"],
    ["supervisors", "supervisor_site_assignments", "supervisor_id"],
    ["field_officers", "field_officer_site_assignments", "field_officer_id"],
  ];
  for (const [peopleKey, assignmentTable, fk] of assignmentTargets) {
    const loop = new RegExp(`for person_record in select value from jsonb_array_elements\\(coalesce\\(site_record -> '${peopleKey}'.*?end loop;`, "s").exec(sql)?.[0];
    assert.ok(loop, `missing ${peopleKey} import loop`);
    const inactiveBranch = loop.indexOf("if employee_status_value in ('inactive', 'relieved') then");
    const assignmentClose = loop.indexOf(`update public.${assignmentTable} set valid_to = current_date`, inactiveBranch);
    const activeBranch = loop.indexOf("else\n        insert into public." + assignmentTable, inactiveBranch);
    assert.ok(inactiveBranch >= 0 && assignmentClose > inactiveBranch && activeBranch > assignmentClose, `${peopleKey} should close prior assignments and only add the imported site in the active branch`);
    assert.match(loop, new RegExp(`where ${fk} = person_id_value and valid_to is null`));
    if (peopleKey !== "guards") assert.match(loop, /update public\.supervisor_reporting set valid_to = current_date/);
  }

  const employeeSaveStart = coreMigration.indexOf("create or replace function public.save_employee_profile(");
  const employeeSaveEnd = coreMigration.indexOf("create or replace function public.record_advance(", employeeSaveStart);
  const employeeSave = coreMigration.slice(employeeSaveStart, employeeSaveEnd);
  assert.match(employeeSave, /if coalesce\(p_person ->> 'status', 'active'\) in \('inactive', 'relieved'\) then\s*requested_sites := array\[\]::bigint\[\];\s*requested_reports := array\[\]::bigint\[\];/);

  const guardSaveStart = coreMigration.indexOf("create or replace function public.save_guard_profile(");
  const guardSaveEnd = coreMigration.indexOf("create or replace function public.delete_guard_if_unreferenced(", guardSaveStart);
  const guardSave = coreMigration.slice(guardSaveStart, guardSaveEnd);
  assert.match(guardSave, /if coalesce\(p_person ->> 'status', 'active'\) in \('inactive', 'relieved'\) then site_ids_value := array\[\]::bigint\[\]; end if/);
});

test("advance outbox only enqueues when the server explicitly opts in; preflight is read-only and checks required prerequisites", () => {
  assert.match(coreMigration, /set_config\(\s*'operations\.google_sheets_sync_enabled',[\s\S]*?else 'false' end/);
  assert.match(outboxMigration, /if coalesce\(current_setting\('operations\.google_sheets_sync_enabled', true\), 'false'\) = 'true' then/);
  assert.match(outboxMigration, /insert into public\.advance_sheet_sync_outbox\(advance_id\)/);
  assert.match(preflight, /missing_tables/);
  assert.match(preflight, /missing_columns/);
  assert.match(preflight, /schema_migrations/);
  assert.match(preflight, /storage\.buckets/);
  assert.match(preflight, /duplicate normalized phone groups/);
  assert.doesNotMatch(preflight, /\b(insert into|update public\.|delete from|alter table|create table)\b/i);
});
