import test from "node:test";
import assert from "node:assert/strict";
import { isolatedDatabase, migration, lifecycleMigration } from "./isolatedDatabase.js";

const actor = "00000000-0000-4000-8000-000000000001";

test("employee exits and site closure are atomic, idempotent, authorized, and preserve history", async () => {
  const db = await isolatedDatabase();
  try {
    await db.exec(`insert into auth.users(id) values ('${actor}'); insert into public.admin_users(user_id) values ('${actor}');`);
    await db.exec(migration);
    await db.exec(lifecycleMigration);
    const { rows: [{ today }] } = await db.query("select (now() at time zone 'Asia/Kolkata')::date::text as today");
    const site = (await db.query("insert into public.sites(site_code,title,status,service_taken) values ('EXIT-A','Exit test site','active','SECURITY GUARD') returning id")).rows[0].id;
    const closedSite = (await db.query("insert into public.sites(site_code,title,status,service_taken) values ('EXIT-B','Closure test site','active','SECURITY GUARD') returning id")).rows[0].id;
    const employees = [];
    for (const [type, table, assignmentTable, fk, code, phone] of [
      ["guard", "guards", "guard_site_assignments", "guard_id", "TEST-GRD", "9999801001"],
      ["supervisor", "supervisors", "supervisor_site_assignments", "supervisor_id", "TEST-SUP", "9999801002"],
      ["field_officer", "field_officers", "field_officer_site_assignments", "field_officer_id", "TEST-FO", "9999801003"],
    ]) {
      const person = (await db.query(`insert into public.${table}(employee_code,full_name,phone,status,joining_date) values ($1,$2,$3,'active','2026-01-01') returning id`, [code, `${type} QA`, phone])).rows[0];
      await db.query(`insert into public.${assignmentTable}(${fk},site_id,valid_from) values ($1,$2,$3)`, [person.id, site, today]);
      employees.push({ type, table, assignmentTable, fk, id: person.id });
    }
    const guard = employees[0];
    const advance = (await db.query("insert into public.advances(employee_type,guard_id,site_id,amount,occurred_at,payment_mode,description,source,external_reference) values ('guard',$1,$2,1500,now(),'cash','Retained QA advance','dashboard','QA-EXIT-ADV') returning id", [guard.id, site])).rows[0].id;

    for (const [index, employee] of employees.entries()) {
      const reason = ["Resigned", "Terminated", "Left Company"][index];
      const { rows: [{ value }] } = await db.query("select public.exit_employee($1::text,$2::bigint,$3::text,$4::date,$5::text,$6::uuid) as value", [employee.type, employee.id, reason, today, "Synthetic lifecycle verification", actor]);
      assert.equal(value.status, "relieved");
      const saved = (await db.query(`select status,employment_end_date::text as employment_end_date,exit_reason,exit_remarks from public.${employee.table} where id=$1`, [employee.id])).rows[0];
      assert.deepEqual(saved, { status: "relieved", employment_end_date: today, exit_reason: reason, exit_remarks: "Synthetic lifecycle verification" });
      const ended = (await db.query(`select valid_to from public.${employee.assignmentTable} where ${employee.fk}=$1`, [employee.id])).rows[0];
      assert.equal(ended.valid_to.toISOString().slice(0, 10), today);
    }
    const { rows: [{ value: retried }] } = await db.query("select public.exit_employee('guard',$1::bigint,'Resigned',$2::date,'Synthetic lifecycle verification',$3::uuid) as value", [guard.id, today, actor]);
    assert.equal(retried.already_applied, true);
    await assert.rejects(db.query("select public.exit_employee('guard',$1::bigint,'Other',$2::date,'Different reason',$3::uuid)", [guard.id, today, actor]), /already has a recorded exit/);
    await assert.rejects(db.query("update public.guards set status='active' where id=$1", [guard.id]), /explicit rehire workflow/);
    assert.equal((await db.query("select count(*)::int as n from public.advances where id=$1 and guard_id=$2", [advance, guard.id])).rows[0].n, 1);

    const activeGuard = (await db.query("insert into public.guards(employee_code,full_name,phone,status,joining_date) values ('TEST-GRD2','Active retained worker','9999801004','active','2026-01-01') returning id")).rows[0].id;
    await db.query("insert into public.guard_site_assignments(guard_id,site_id,valid_from) values ($1,$2,$3)", [activeGuard, closedSite, today]);
    const closureAdvance = (await db.query("insert into public.advances(employee_type,guard_id,site_id,amount,occurred_at,payment_mode,description,source,external_reference) values ('guard',$1,$2,700,now(),'online','Retained closure advance','dashboard','QA-CLOSE-ADV') returning id", [activeGuard, closedSite])).rows[0].id;
    const { rows: [{ value: closure }] } = await db.query("select public.close_site($1::bigint,'Contract expired',$2::date,'Synthetic closure verification',$3::uuid) as value", [closedSite, today, actor]);
    assert.equal(closure.status, "inactive");
    assert.equal((await db.query("select status from public.guards where id=$1", [activeGuard])).rows[0].status, "active");
    assert.equal((await db.query("select status,closure_date,contract_end_date,closure_reason,closure_remarks from public.sites where id=$1", [closedSite])).rows[0].closure_reason, "Contract expired");
    assert.equal((await db.query("select valid_to from public.guard_site_assignments where guard_id=$1", [activeGuard])).rows[0].valid_to.toISOString().slice(0, 10), today);
    assert.equal((await db.query("select count(*)::int as n from public.advances where id=$1 and guard_id=$2", [closureAdvance, activeGuard])).rows[0].n, 1);
    const { rows: [{ value: closeRetry }] } = await db.query("select public.close_site($1::bigint,'Contract expired',$2::date,'Synthetic closure verification',$3::uuid) as value", [closedSite, today, actor]);
    assert.equal(closeRetry.already_applied, true);
    await assert.rejects(db.query("update public.sites set status='active' where id=$1", [closedSite]), /cannot be reactivated/);
    await assert.rejects(db.query("select public.close_site($1::bigint,'',$2::date,'',$3::uuid)", [site, today, "00000000-0000-4000-8000-000000000002"]), /Administrator access is required/);
    assert.equal((await db.query("select has_function_privilege('anon','public.exit_employee(text,bigint,text,date,text,uuid)','execute') as can_exit")).rows[0].can_exit, false);
  } finally { await db.close(); }
});
