import { createCipheriv, randomBytes } from "node:crypto";

const TABLES = Object.freeze({ guard: "guards", supervisor: "supervisors", field_officer: "field_officers" });
export class EmployeeIdentityError extends Error {
  constructor(message, status = 400) { super(message); this.name = "EmployeeIdentityError"; this.status = status; }
}

function encryptionKey(env) {
  const encoded = String(env.EMPLOYEE_IDENTITY_ENCRYPTION_KEY || "");
  if (!/^[A-Za-z0-9+/]{43}=$/.test(encoded)) return null;
  const key = Buffer.from(encoded, "base64");
  return key.length === 32 ? key : null;
}

function encrypt(value, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `v1:${Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64url")}`;
}

function validEmployee(employeeType, employeeId) {
  const table = TABLES[employeeType];
  const id = Number(employeeId);
  if (!table || !Number.isSafeInteger(id) || id < 1) throw new EmployeeIdentityError("Employee details are invalid.");
  return { table, id };
}

const last4 = value => [...String(value || "")].slice(-4).join("");
function masked(row = {}) {
  return {
    aadhaar_reference: row.aadhaar_last4 ? `•••• •••• ${row.aadhaar_last4}` : "Not recorded",
    aadhaar_recorded: Boolean(row.aadhaar_reference_ciphertext),
    pan_number: row.pan_last4 ? `••••••${row.pan_last4}` : "Not recorded",
    pan_recorded: Boolean(row.pan_ciphertext),
    other_id_type: row.other_id_type || "",
    other_id_number: row.other_id_last4 ? `••••${row.other_id_last4}` : "Not recorded",
    other_id_recorded: Boolean(row.other_id_ciphertext),
    updated_at: row.updated_at || null,
  };
}

export async function getEmployeeIdentity(database, employeeType, employeeId) {
  const { id } = validEmployee(employeeType, employeeId);
  const { data, error } = await database.from("employee_identity_documents").select(
    "aadhaar_reference_ciphertext,aadhaar_last4,pan_ciphertext,pan_last4,other_id_type,other_id_ciphertext,other_id_last4,updated_at",
  ).eq("employee_type", employeeType).eq("employee_id", id).maybeSingle();
  if (error) throw new EmployeeIdentityError("Employee identity details could not be loaded.", 503);
  return { identity: masked(data || {}) };
}

export async function saveEmployeeIdentity(database, input, actorId, env = process.env) {
  const employeeType = input?.employee_type;
  const { table, id } = validEmployee(employeeType, input?.employee_id);
  const hasNewValues = Boolean(String(input?.aadhaar_reference || "").trim() || String(input?.pan_number || "").trim() || String(input?.other_id_number || "").trim());
  const key = encryptionKey(env);
  if (hasNewValues && !key) throw new EmployeeIdentityError("Secure identity storage is not configured. Ask the deployment administrator to set EMPLOYEE_IDENTITY_ENCRYPTION_KEY.", 503);
  const employee = await database.from(table).select("id").eq("id", id).maybeSingle();
  if (employee.error) throw new EmployeeIdentityError("Employee identity details could not be saved.", 503);
  if (!employee.data) throw new EmployeeIdentityError("Employee record was not found.", 404);

  const prior = await database.from("employee_identity_documents").select(
    "employee_type,employee_id,guard_id,supervisor_id,field_officer_id,aadhaar_reference_ciphertext,aadhaar_last4,pan_ciphertext,pan_last4,other_id_type,other_id_ciphertext,other_id_last4",
  ).eq("employee_type", employeeType).eq("employee_id", id).maybeSingle();
  if (prior.error) throw new EmployeeIdentityError("Employee identity details could not be saved.", 503);
  const old = prior.data || {};
  const changedFields = [];
  const row = { ...old, employee_type: employeeType, employee_id: id, updated_by: actorId, updated_at: new Date().toISOString() };
  row.guard_id = employeeType === "guard" ? id : null;
  row.supervisor_id = employeeType === "supervisor" ? id : null;
  row.field_officer_id = employeeType === "field_officer" ? id : null;

  const aadhaar = String(input?.aadhaar_reference || "").trim();
  if (input?.clear_aadhaar_reference) {
    row.aadhaar_reference_ciphertext = null; row.aadhaar_last4 = null; changedFields.push("aadhaar_reference");
  } else if (aadhaar) {
    const normalized = aadhaar.replace(/[\s-]/g, "");
    if (!/^\d{4}$/.test(normalized)) throw new EmployeeIdentityError("Enter only the last four Aadhaar digits. Full Aadhaar numbers are not accepted.");
    row.aadhaar_reference_ciphertext = encrypt(normalized, key); row.aadhaar_last4 = normalized; changedFields.push("aadhaar_reference");
  }

  const pan = String(input?.pan_number || "").replace(/\s/g, "").toUpperCase();
  if (input?.clear_pan_number) {
    row.pan_ciphertext = null; row.pan_last4 = null; changedFields.push("pan_number");
  } else if (pan) {
    if (!/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan)) throw new EmployeeIdentityError("Enter a valid PAN format.");
    row.pan_ciphertext = encrypt(pan, key); row.pan_last4 = last4(pan); changedFields.push("pan_number");
  }

  const otherNumber = String(input?.other_id_number || "").trim();
  const otherType = String(input?.other_id_type || "").trim();
  if (input?.clear_other_id) {
    row.other_id_type = null; row.other_id_ciphertext = null; row.other_id_last4 = null; changedFields.push("other_id_proof");
  } else if (otherNumber) {
    if (!otherType || otherType.length > 80 || otherNumber.length > 100) throw new EmployeeIdentityError("Choose an ID proof type and enter a value of 1 to 100 characters.");
    row.other_id_type = otherType; row.other_id_ciphertext = encrypt(otherNumber, key);
    row.other_id_last4 = [...otherNumber].slice(-4).join(""); changedFields.push("other_id_proof");
  } else if (otherType && old.other_id_ciphertext) {
    if (otherType.length > 80) throw new EmployeeIdentityError("ID proof type must be 80 characters or fewer.");
    row.other_id_type = otherType; changedFields.push("other_id_type");
  }
  if (!changedFields.length) return { ok: true, identity: masked(old), unchanged: true };

  const { data, error } = await database.rpc("save_employee_identity", {
    p_identity: row, p_changed_fields: changedFields, p_actor_id: actorId,
  });
  if (error || !data) throw new EmployeeIdentityError("Employee identity details could not be saved with an audit record.", 503);
  return { ok: true, identity: masked(data) };
}
