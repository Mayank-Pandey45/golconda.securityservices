import test from "node:test";
import assert from "node:assert/strict";
import { calculatePayrollRecovery } from "./payrollCalculations.js";
import { isolatedDatabase, monthlySalaryMigration } from "../supabase/tests/isolatedDatabase.js";

const admin = "00000000-0000-4000-8000-000000000001";

test("salary RPC returns full configured salaries, explicit eligibility, and reconciled recovery totals", async () => {
  const db = await isolatedDatabase();
  const scalar = async (sql, params = []) => Object.values((await db.query(sql, params)).rows[0])[0];
  try {
    await db.exec(`
      insert into auth.users values ('${admin}');
      insert into public.admin_users(user_id) values ('${admin}');
      insert into public.sites(id,title) values (101,'Synthetic site A'),(102,'Synthetic site B');
      insert into public.guards(id,full_name,phone,joining_date,employment_end_date,status) values
        (901,'Synthetic mid-month exit','9000000001','2026-10-01','2026-10-15','relieved'),
        (902,'Synthetic mid-month join','9000000002','2026-10-20',null,'active'),
        (905,'Synthetic future join','9000000005','2026-11-01',null,'active'),
        (906,'Synthetic former employee','9000000006','2026-09-01','2026-09-30','relieved');
      insert into public.supervisors(id,full_name,phone,joining_date,status) values
        (903,'Synthetic supervisor','9000000003','2026-10-16','active');
      insert into public.field_officers(id,full_name,phone,status) values
        (904,'Synthetic field officer','9000000004','active');
      insert into public.employee_compensation(employee_type,guard_id,gross_monthly_salary,effective_from) values
        ('guard',901,19000,'2026-10-01'),('guard',902,18500,'2026-10-01'),
        ('guard',905,20000,'2026-11-01'),('guard',906,22000,'2026-09-01');
      insert into public.employee_compensation(employee_type,supervisor_id,gross_monthly_salary,effective_from) values
        ('supervisor',903,24000,'2026-10-01');
      insert into public.employee_compensation(employee_type,field_officer_id,gross_monthly_salary,effective_from) values
        ('field_officer',904,36000.01,'2026-10-01');
      insert into public.advances(id,employee_type,guard_id,site_id,amount,occurred_at,recorded_by) values
        (501,'guard',901,101,600,'2026-10-10T04:30:00Z','${admin}'),
        (502,'guard',901,102,400,'2026-10-11T04:30:00Z','${admin}');
      insert into public.advance_recoveries(advance_id,salary_period,amount) values (501,'2026-10-01',500);
      insert into public.salary_adjustments(employee_type,guard_id,salary_period,adjustment_type,amount,description,is_approved,approved_at,approved_by) values
        ('guard',901,'2026-10-01','addition',1500,'Synthetic approved addition',true,now(),'${admin}'),
        ('guard',901,'2026-10-01','deduction',500,'Synthetic approved deduction',true,now(),'${admin}');
    `);
    await db.exec(monthlySalaryMigration);
    await db.exec(`begin; set local role service_role; select set_config('request.jwt.claim.sub','${admin}',true);`);
    const data = await scalar("select public.get_payroll_summary('2026-10-01',$1::uuid)", [admin]);
    const byId = new Map(data.map(row => [`${row.employee_type}:${row.employee_id}`, row]));

    const exit = calculatePayrollRecovery(byId.get("guard:901"));
    assert.equal(exit.salary_eligible, true);
    assert.equal(exit.salary_eligibility_status, "Eligible for selected month");
    assert.equal(exit.total_salary, 19000);
    assert.equal(exit.advances_given_period, 1000);
    assert.equal(exit.advance_outstanding_before_payroll, 1000);
    assert.equal(exit.finalized_recovery_amount, 500);
    assert.equal(exit.proposed_advance_recovery, 500);
    assert.equal(exit.net_payable_after_proposed_recovery, 19000);
    assert.equal(exit.advance_outstanding_after_proposed_recovery, 0);

    assert.equal(byId.get("guard:902").total_salary, 18500);
    assert.equal(byId.get("supervisor:903").total_salary, 24000);
    assert.equal(byId.get("field_officer:904").total_salary, 36000.01);
    assert.equal(byId.get("guard:905").salary_eligible, false);
    assert.equal(byId.get("guard:905").total_salary, 0);
    assert.match(byId.get("guard:905").salary_eligibility_status, /joining date is after/);
    assert.equal(byId.get("guard:906").salary_eligible, false);
    assert.equal(byId.get("guard:906").total_salary, 0);
    assert.match(byId.get("guard:906").salary_eligibility_status, /employment ended before/);
  } finally {
    await db.close();
  }
});
