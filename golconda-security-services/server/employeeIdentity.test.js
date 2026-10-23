import assert from "node:assert/strict";
import { test } from "node:test";
import { EmployeeIdentityError, getEmployeeIdentity, saveEmployeeIdentity } from "./employeeIdentity.js";

function identityDb() {
  const state = { identity: null, audit: [], failSave: false };
  return {
    state,
    from(table) {
      const query = { filters: {} };
      query.select = () => query;
      query.eq = (key, value) => { query.filters[key] = value; return query; };
      query.maybeSingle = async () => table === "guards" ? { data: { id: 7 }, error: null } : { data: state.identity, error: null };
      return query;
    },
    async rpc(name, args) {
      assert.equal(name, "save_employee_identity");
      if (state.failSave) return { data: null, error: { code: "audit_write_failed" } };
      state.identity = { ...args.p_identity, updated_by: args.p_actor_id, updated_at: new Date().toISOString() };
      state.audit.push({ changed_fields: args.p_changed_fields, changed_by: args.p_actor_id });
      return { data: state.identity, error: null };
    },
  };
}

const env = { EMPLOYEE_IDENTITY_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64") };

test("identity values are encrypted, masked on read, and audit records contain field names only", async () => {
  const database = identityDb();
  const saved = await saveEmployeeIdentity(database, {
    employee_type: "guard", employee_id: 7, aadhaar_reference: "1234",
    pan_number: "ABCDE1234F", other_id_type: "Driving licence", other_id_number: "DL-SECRET-7462",
  }, "12345678-1234-1234-1234-123456789012", env);
  assert.equal(saved.identity.aadhaar_reference, "•••• •••• 1234");
  assert.equal(saved.identity.pan_number, "••••••234F");
  assert.equal(saved.identity.other_id_type, "Driving licence");
  assert.equal(saved.identity.other_id_number, "••••7462");
  assert.ok(!JSON.stringify(database.state.identity).includes("ABCDE1234F"));
  assert.ok(!JSON.stringify(database.state.identity).includes("DL-SECRET-7462"));
  assert.deepEqual(database.state.audit[0].changed_fields, ["aadhaar_reference", "pan_number", "other_id_proof"]);
  assert.ok(!JSON.stringify(database.state.audit).includes("ABCDE1234F"));

  const loaded = await getEmployeeIdentity(database, "guard", 7);
  assert.deepEqual(loaded.identity, saved.identity);
  assert.equal(Object.hasOwn(loaded.identity, "pan_ciphertext"), false);
});

test("full Aadhaar numbers and invalid PAN formats are rejected without persistence", async () => {
  const database = identityDb();
  await assert.rejects(saveEmployeeIdentity(database, { employee_type: "guard", employee_id: 7, aadhaar_reference: "123456789012" }, "admin", env), EmployeeIdentityError);
  await assert.rejects(saveEmployeeIdentity(database, { employee_type: "guard", employee_id: 7, pan_number: "NOT-A-PAN" }, "admin", env), /valid PAN/);
  assert.equal(database.state.identity, null);
});

test("new sensitive values fail closed without the server encryption key; clears remain possible", async () => {
  const database = identityDb();
  await assert.rejects(saveEmployeeIdentity(database, { employee_type: "guard", employee_id: 7, pan_number: "ABCDE1234F" }, "admin", {}), error => error.status === 503);
  await saveEmployeeIdentity(database, { employee_type: "guard", employee_id: 7, pan_number: "ABCDE1234F" }, "admin", env);
  const result = await saveEmployeeIdentity(database, { employee_type: "guard", employee_id: 7, clear_pan_number: true }, "admin", {});
  assert.equal(result.identity.pan_recorded, false);
  assert.equal(result.identity.pan_number, "Not recorded");
});

test("identity persistence fails without leaving data behind when the atomic audit transaction fails", async () => {
  const database = identityDb(); database.state.failSave = true;
  await assert.rejects(saveEmployeeIdentity(database, {
    employee_type: "guard", employee_id: 7, pan_number: "ABCDE1234F",
  }, "12345678-1234-1234-1234-123456789012", env), /audit record/);
  assert.equal(database.state.identity, null);
  assert.deepEqual(database.state.audit, []);
});
