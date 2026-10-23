import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const migration = await readFile(new URL("../supabase/migrations/20261022190000_record_management.sql",import.meta.url),"utf8");
test("draft lifecycle migration is additive and keeps constraints, financial records and audit history",()=>{
  assert.doesNotMatch(migration,/drop\s+(?:table|column)|disable\s+(?:row level security|trigger)|(?:^|;)\s*truncate\s|delete from public\.(?:advances|advance_adjustments|advance_recoveries|salary_adjustments|operations_audit_log)/im);
  assert.match(migration,/revoke truncate on public\.admin_users/);
  assert.match(migration,/add column if not exists archived_at/);
  assert.match(migration,/for update/);
  assert.match(migration,/ALL inbound FKs/);
  assert.match(migration,/c\.confrelid=to_regclass/);
  assert.match(migration,/current_setting\('app.lifecycle_delete'/);
  assert.match(migration,/Original submissions are immutable/);
  assert.match(migration,/retention policy pending/i);
  assert.match(migration,/Operational audit history must be preserved/);
});
test("RPC grants, restrictive public visibility, storage reservations and retained history fail closed",()=>{
  for(const fn of ["manage_admin_record","queue_media_cleanup","claim_media_cleanup","complete_media_cleanup"]){
    assert.ok(migration.includes("public."+fn));
  }
  assert.match(migration,/revoke all on function public\.manage_admin_record[^]*from public,anon,authenticated/);
  assert.match(migration,/grant execute on function public\.manage_admin_record[^]*to service_role/);
  assert.match(migration,/public\.record_admin_access\(\) or \(archived_at is null and is_active\)/);
  assert.match(migration,/Unarchived profile files only/);
  assert.match(migration,/as restrictive for delete to authenticated/);
  assert.match(migration,/status='processing'/);
  assert.match(migration,/pg_advisory_xact_lock/);
  assert.match(migration,/before_data->>'photo_storage_path'/);
  assert.match(migration,/before_data->>'category'='Registration & Compliance'/);
  assert.match(migration,/p_id and claim=p_claim and status='processing'/);
  assert.match(migration,/Asia\/Kolkata/);
  assert.match(migration,/greatest\(valid_from,today\)/);
  assert.doesNotMatch(migration,/update public\.employee_compensation set|employment_end_date\s*=/);
});
test("dashboard modules no longer perform inline record or Storage deletion",async()=>{
  for(const name of ["GuardManagement","SiteManagement","PeopleManagement","ProfileVault"]){
    const source=await readFile(new URL("../src/admin/"+name+".jsx",import.meta.url),"utf8");
    assert.ok(source.includes("<RecordActions"),name);
    assert.ok(source.includes("<RecordFilter"),name);
    assert.doesNotMatch(source,/\.remove\(|\.delete\(\)/,name);
  }
  const main=await readFile(new URL("../src/main.jsx",import.meta.url),"utf8");
  assert.ok(main.includes("<RecordFilter"));assert.ok(main.includes("<RecordActions"));
  assert.doesNotMatch(main,/\.delete\(\)/);
  assert.ok(main.includes('.is("archived_at", null).eq("is_active", true)'));
});

test("draft function bodies retain balanced PostgreSQL dollar delimiters",()=>{
 assert.doesNotMatch(migration,/as \$(?:\r?\n)|end \$;|^\$;/m);
 const delimiters=migration.match(/\$\$/g)||[];
 assert.equal(delimiters.length % 2,0);
 assert.ok(delimiters.length>=20);
});
