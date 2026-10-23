import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { isolatedDatabase } from "../supabase/tests/isolatedDatabase.js";

const migrationSql = await readFile(new URL("../supabase/migrations/20261023184408_secure_telegram_admin_and_employee_identity.sql", import.meta.url), "utf8");
const owner = "00000000-0000-4000-8000-000000000001";

test("Telegram and identity migration applies on PostgreSQL 17 with private RLS grants and atomic identity audit", async () => {
  const db = await isolatedDatabase();
  try {
    await db.exec(`
      insert into auth.users(id) values ('${owner}');
      insert into public.admin_users(user_id) values ('${owner}');
      insert into public.sites(id,title) values (101,'Synthetic site');
      insert into public.guards(id,employee_code,full_name,phone) values (201,'G-201','Synthetic guard','9999900201');
    `);
    const businessBefore = (await db.query("select (select count(*) from public.advances)::int as advances, (select count(*) from public.guards)::int as guards")).rows[0];
    await db.exec(migrationSql);

    const protectedTables = [
      "telegram_admin_links", "telegram_link_codes", "telegram_aliases", "telegram_pending_advances",
      "telegram_update_receipts", "telegram_wizard_sessions", "telegram_bot_events",
      "employee_identity_documents", "employee_identity_audit",
    ];
    const secured = await db.query("select c.relname, c.relrowsecurity from pg_class c where c.relnamespace='public'::regnamespace and c.relname = any($1::text[])", [protectedTables]);
    assert.equal(secured.rows.length, protectedTables.length);
    assert.ok(secured.rows.every(row => row.relrowsecurity));
    for (const table of protectedTables) assert.equal((await db.query("select has_table_privilege('anon',$1,'SELECT') as allowed", [`public.${table}`])).rows[0].allowed, false, table);
    assert.equal((await db.query("select has_function_privilege('anon','public.save_employee_identity(jsonb,text[],uuid)','EXECUTE') as allowed")).rows[0].allowed, false);
    assert.equal((await db.query("select has_function_privilege('service_role','public.save_employee_identity(jsonb,text[],uuid)','EXECUTE') as allowed")).rows[0].allowed, true);

    const identity = {
      employee_type: "guard", employee_id: 201, guard_id: 201, supervisor_id: null, field_officer_id: null,
      aadhaar_reference_ciphertext: "v1:synthetic-aadhaar", aadhaar_last4: "1234",
      pan_ciphertext: "v1:synthetic-pan", pan_last4: "234F",
      other_id_type: null, other_id_ciphertext: null, other_id_last4: null,
    };
    await db.exec("set role service_role");
    const saved = await db.query("select public.save_employee_identity($1::jsonb,$2::text[],$3::uuid) as identity", [JSON.stringify(identity), ["aadhaar_reference", "pan_number"], owner]);
    assert.equal(saved.rows[0].identity.pan_ciphertext, "v1:synthetic-pan");
    assert.deepEqual((await db.query("select changed_fields from public.employee_identity_audit")).rows[0].changed_fields, ["aadhaar_reference", "pan_number"]);

    await db.exec("reset role");
    await db.exec(`create function public.synthetic_fail_identity_audit() returns trigger language plpgsql as $$ begin raise exception 'synthetic audit failure'; end $$;
      create trigger synthetic_fail_identity_audit before insert on public.employee_identity_audit for each row execute function public.synthetic_fail_identity_audit();`);
    await db.exec("set role service_role");
    const changed = { ...identity, pan_ciphertext: "v1:must-rollback", pan_last4: "999F" };
    await assert.rejects(db.query("select public.save_employee_identity($1::jsonb,$2::text[],$3::uuid)", [JSON.stringify(changed), ["pan_number"], owner]));
    assert.equal((await db.query("select pan_ciphertext from public.employee_identity_documents where employee_id=201")).rows[0].pan_ciphertext, "v1:synthetic-pan");
    assert.equal((await db.query("select count(*)::int as n from public.employee_identity_audit")).rows[0].n, 1);
    assert.deepEqual((await db.query("select (select count(*)::int from public.advances) as advances, (select count(*)::int from public.guards) as guards")).rows[0], businessBefore);
  } finally {
    await db.close();
  }
});
