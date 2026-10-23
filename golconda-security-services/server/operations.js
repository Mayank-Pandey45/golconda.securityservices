import { normalizeEmployeeProfile, normalizePhoneDigits, normalizeSiteImportRows, normalizeSiteRecord, OperationsValidationError } from "../shared/operationsValidation.js";
import { readAllRows } from "./paginatedQuery.js";
import { isGoogleSheetsSyncConfigured } from "./googleSheetsIntegration.js";

export class OperationsRequestError extends Error {
  constructor(message, status = 400, details) {
    super(message);
    this.name = "OperationsRequestError";
    this.status = status;
    this.details = details;
  }
}

export async function requireAdmin(database, authorization) {
  const token = /^Bearer\s+(.+)$/i.exec(String(authorization || ""))?.[1];
  if (!token) throw new OperationsRequestError("Administrator authentication is required.", 401);
  const { data: userData, error: userError } = await database.auth.getUser(token);
  const user = userData?.user;
  if (userError || !user?.id) throw new OperationsRequestError("Administrator authentication is invalid or expired.", 401);
  const { data: admin, error: adminError } = await database.from("admin_users")
    .select("user_id").eq("user_id", user.id).maybeSingle();
  if (adminError) throw new OperationsRequestError("Administrator access could not be verified.", 503);
  if (!admin) throw new OperationsRequestError("Only authorized administrators can manage operations records.", 403);
  return user.id;
}

function throwRecordWriteError(error, fallback) {
  if (error.code === "P0002") throw new OperationsRequestError("The requested record was not found. Refresh the list and try again.", 404);
  if (error.code === "55000" && /Compensation history must be retained/.test(error.message || "")) throw new OperationsRequestError("This salary change would remove an existing compensation record for the same effective date. It was not saved. Review a dated salary transition that retains history.", 409);
  if (["55000", "P0001", "23503", "23505", "40P01", "40001"].includes(error.code)) throw new OperationsRequestError("This record or a selected relationship is archived, unavailable, changed concurrently or conflicts with retained history. Refresh, restore records if appropriate, and review assignments. No partial save was confirmed.", 409);
  if (["PGRST202", "42883", "42703"].includes(error.code)) throw new OperationsRequestError("The required database migration is unavailable. Contact the administrator.", 503);
  throw new Error(fallback);
}

function calendarDate(value, label) {
  const date = String(value ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new OperationsRequestError(`${label} must be a valid YYYY-MM-DD date.`);
  const timestamp = Date.parse(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== date) throw new OperationsRequestError(`${label} must be a valid YYYY-MM-DD date.`);
  return date;
}

function idList(value, name) {
  if (!Array.isArray(value)) throw new OperationsRequestError(`${name} must be an array of record IDs.`);
  const values = value.map(id => Number(id));
  if (values.some(id => !Number.isSafeInteger(id) || id < 1)) throw new OperationsRequestError(`${name} contains an invalid record ID.`);
  if (new Set(values).size !== values.length) throw new OperationsRequestError(`${name} contains duplicate record IDs.`);
  return values;
}

export async function saveSite(database, input, actorId) {
  let site;
  try { site = normalizeSiteRecord(input?.site); }
  catch (error) {
    if (error instanceof OperationsValidationError) throw new OperationsRequestError(error.message, 400, { field: error.field });
    throw error;
  }
  const siteId = input.site_id === null || input.site_id === undefined || input.site_id === "" ? null : Number(input.site_id);
  if (siteId !== null && (!Number.isSafeInteger(siteId) || siteId < 1)) throw new OperationsRequestError("Site ID is invalid.");
  const guardIds = idList(input.guard_ids ?? [], "Guard assignments");
  const supervisorIds = idList(input.supervisor_ids ?? [], "Supervisor assignments");
  const fieldOfficerIds = idList(input.field_officer_ids ?? [], "Field officer assignments");
  const { data, error } = await database.rpc("save_site_with_assignments", {
    p_site: site,
    p_site_id: siteId,
    p_guard_ids: guardIds,
    p_supervisor_ids: supervisorIds,
    p_field_officer_ids: fieldOfficerIds,
    p_actor_id: actorId,
  });
  if (error) throwRecordWriteError(error, "Site details and assignments could not be saved.");
  if (!Number.isSafeInteger(Number(data)) || Number(data) <= 0) throw new OperationsRequestError("Site save was not confirmed. Refresh the record.", siteId ? 404 : 500);
  return { ok: true, site_id: data };
}

async function validateStableMatches(database, sites) {
  let guards;
  let supervisors;
  let fieldOfficers;
  try {
    [guards, supervisors, fieldOfficers] = await Promise.all([
      readAllRows(() => database.from("guards").select("id,employee_code,phone,phone_normalized").order("id", { ascending: true })),
      readAllRows(() => database.from("supervisors").select("id,employee_code,phone,phone_normalized").order("id", { ascending: true })),
      readAllRows(() => database.from("field_officers").select("id,employee_code,phone,phone_normalized").order("id", { ascending: true })),
    ]);
  } catch {
    throw new OperationsRequestError("Current employee records could not be checked. No import was saved.", 503);
  }

  const indexes = {
    guard: { phone: new Map(), code: new Map(), records: guards },
    supervisor: { phone: new Map(), code: new Map(), records: supervisors },
    field_officer: { phone: new Map(), code: new Map(), records: fieldOfficers },
  };
  for (const [kind, index] of Object.entries(indexes)) {
    for (const person of index.records) {
      const phone = person.phone_normalized || normalizePhoneDigits(person.phone);
      if (phone) index.phone.set(phone, person);
      if (person.employee_code) index.code.set(String(person.employee_code).toLowerCase(), person);
    }
  }

  const errors = [];
  const seenByKind = { guard: new Map(), supervisor: new Map(), field_officer: new Map() };
  const seenCodesByKind = { guard: new Map(), supervisor: new Map(), field_officer: new Map() };
  const allKnownTypesByPhone = new Map();
  for (const [kind, index] of Object.entries(indexes)) {
    for (const [phone, person] of index.phone) {
      const found = allKnownTypesByPhone.get(phone) || [];
      found.push({ kind, person });
      allKnownTypesByPhone.set(phone, found);
    }
  }
  for (const site of sites) {
    for (const kind of Object.keys(indexes)) {
      const plural = kind === "field_officer" ? "field_officers" : `${kind}s`;
      for (const person of site[plural] || []) {
        const phone = normalizePhoneDigits(person.phone);
        const code = String(person.employee_code || "").toLowerCase();
        const oldByPhone = indexes[kind].phone.get(phone);
        const oldByCode = code ? indexes[kind].code.get(code) : null;
        const crossType = (allKnownTypesByPhone.get(phone) || []).filter(match => match.kind !== kind);
        if (crossType.length) {
          errors.push({ site_code: site.site_code, kind, phone, message: `This phone is already present as ${crossType.map(match => match.kind.replace("_", " ")).join(" and ")}; review the identity before importing.` });
        }
        if (oldByCode && normalizePhoneDigits(oldByCode.phone) !== phone) {
          errors.push({ site_code: site.site_code, kind, phone, message: `Employee code ${person.employee_code} belongs to a different ${kind.replace("_", " ")} phone number.` });
        }
        if (oldByPhone?.employee_code && code && oldByPhone.employee_code.toLowerCase() !== code) {
          errors.push({ site_code: site.site_code, kind, phone, message: `Employee code ${person.employee_code} conflicts with the existing code for this ${kind.replace("_", " ")} phone number.` });
        }
        if (oldByPhone && oldByCode && oldByPhone !== oldByCode) {
          errors.push({ site_code: site.site_code, kind, phone, message: `The ${kind.replace("_", " ")} phone and employee code match different records.` });
        }
        const withinFile = seenByKind[kind].get(phone);
        const sameCode = code ? seenCodesByKind[kind].get(code) : null;
        if (sameCode && normalizePhoneDigits(sameCode.phone) !== phone) {
          errors.push({ site_code: site.site_code, kind, phone, message: `Employee code ${person.employee_code} is paired with a different phone elsewhere in this import.` });
        }
        if (withinFile && code && withinFile.employee_code && code !== withinFile.employee_code.toLowerCase()) {
          errors.push({ site_code: site.site_code, kind, phone, message: `Phone ${person.phone} is paired with different employee codes in this import.` });
        }
        if (withinFile && JSON.stringify(withinFile) !== JSON.stringify(person)) {
          errors.push({ site_code: site.site_code, kind, phone, message: `This ${kind.replace("_", " ")} phone has conflicting details in multiple import rows.` });
        }
        if (!withinFile) seenByKind[kind].set(phone, person);
        if (code && !sameCode) seenCodesByKind[kind].set(code, person);
      }
    }
  }
  if (errors.length) throw new OperationsRequestError("Some employee matches are ambiguous. Review the reported rows; no import was saved.", 400, { matches: errors });
}

export async function importSiteRows(database, inputRows, actorId) {
  let normalized;
  try { normalized = normalizeSiteImportRows(inputRows); }
  catch (error) {
    if (error instanceof OperationsValidationError) throw new OperationsRequestError(error.message);
    throw error;
  }
  if (normalized.errors.length) {
    throw new OperationsRequestError("Some spreadsheet rows are invalid. Correct them before saving; no rows were imported.", 400, { rows: normalized.errors });
  }
  await validateStableMatches(database, normalized.sites);
  const { data, error } = await database.rpc("import_operations_sites", {
    p_sites: normalized.sites,
    p_actor_id: actorId,
  });
  if (error) throw new Error("The site import transaction failed. No import rows were saved.");
  return { ok: true, ...data };
}

export async function saveEmployee(database, input, actorId) {
  const employeeType = input?.employee_type;
  let person;
  try { person = normalizeEmployeeProfile(input?.person, employeeType); }
  catch (error) {
    if (error instanceof OperationsValidationError) throw new OperationsRequestError(error.message, 400, { field: error.field });
    throw error;
  }
  const employeeId = input.employee_id === null || input.employee_id === undefined || input.employee_id === "" ? null : Number(input.employee_id);
  if (employeeId !== null && (!Number.isSafeInteger(employeeId) || employeeId < 1)) throw new OperationsRequestError("Employee ID is invalid.");
  const siteIds = idList(input.site_ids ?? [], "Site assignments");
  const reportingIds = idList(input.reporting_ids ?? [], "Reporting assignments");
  const { data, error } = await database.rpc("save_employee_profile", {
    p_employee_type: employeeType,
    p_employee_id: employeeId,
    p_person: person,
    p_site_ids: siteIds,
    p_reporting_ids: reportingIds,
    p_actor_id: actorId,
  });
  if (error) throwRecordWriteError(error, "Employee details, compensation, and assignments could not be saved.");
  if (!Number.isSafeInteger(Number(data)) || Number(data) <= 0) throw new OperationsRequestError("Employee save was not confirmed. Refresh the record.", employeeId ? 404 : 500);
  return { ok: true, employee_id: data };
}

export async function exitEmployee(database, input, actorId) {
  const employeeType = input?.employee_type;
  if (!new Set(["guard", "supervisor", "field_officer"]).has(employeeType)) throw new OperationsRequestError("Employee type is invalid.");
  const employeeId = positiveId(input?.employee_id, "Employee");
  const reason = String(input?.exit_reason ?? "").trim();
  if (!new Set(["Resigned", "Terminated", "Left Company", "Other"]).has(reason)) throw new OperationsRequestError("Choose a valid employee exit reason.");
  const lastWorkingDate = calendarDate(input?.last_working_date, "Last working date");
  const indiaToday = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
  if (lastWorkingDate > indiaToday) throw new OperationsRequestError("Last working date cannot be in the future.");
  const remarks = String(input?.remarks ?? "").trim();
  if (remarks.length > 2000) throw new OperationsRequestError("Remarks must be 2,000 characters or fewer.");
  if (reason === "Other" && !remarks) throw new OperationsRequestError("Add remarks when the exit reason is Other.");
  const { data, error } = await database.rpc("exit_employee", {
    p_employee_type: employeeType, p_employee_id: employeeId, p_exit_reason: reason,
    p_last_working_date: lastWorkingDate, p_remarks: remarks, p_actor_id: actorId,
  });
  if (error) throwRecordWriteError(error, "Employee exit could not be saved. No partial update was confirmed.");
  if (!data || Number(data.employee_id) !== employeeId || data.status !== "relieved") throw new OperationsRequestError("Employee exit was not confirmed. Refresh before retrying.", 503);
  return { ok: true, ...data };
}

export async function closeSite(database, input, actorId) {
  const siteId = positiveId(input?.site_id, "Site");
  const reason = String(input?.closure_reason ?? "").trim();
  if (!reason || reason.length > 200) throw new OperationsRequestError("Closure reason must be 1 to 200 characters.");
  const endDate = calendarDate(input?.contract_end_date, "Contract end date");
  const indiaToday = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
  if (endDate > indiaToday) throw new OperationsRequestError("Contract end date cannot be in the future when closing a Site.");
  const remarks = String(input?.remarks ?? "").trim();
  if (remarks.length > 2000) throw new OperationsRequestError("Remarks must be 2,000 characters or fewer.");
  const { data, error } = await database.rpc("close_site", {
    p_site_id: siteId, p_closure_reason: reason, p_contract_end_date: endDate,
    p_remarks: remarks, p_actor_id: actorId,
  });
  if (error) throwRecordWriteError(error, "Site closure could not be saved. No partial update was confirmed.");
  if (!data || Number(data.site_id) !== siteId || data.status !== "inactive") throw new OperationsRequestError("Site closure was not confirmed. Refresh before retrying.", 503);
  return { ok: true, ...data };
}

export async function saveGuard(database, input, actorId) {
  let person;
  try { person = normalizeEmployeeProfile({ ...input?.person, salary_effective_from: input?.person?.salary_effective_date }, "supervisor"); }
  catch (error) {
    if (error instanceof OperationsValidationError) throw new OperationsRequestError(error.message, 400, { field: error.field });
    throw error;
  }
  const employeeCode = String(input?.person?.employee_code ?? "").trim().toUpperCase();
  if (employeeCode.length > 64 || (employeeCode && !/^[A-Z0-9_-]+$/.test(employeeCode))) {
    throw new OperationsRequestError("Employee Code may contain up to 64 letters, numbers, hyphens, and underscores.", 400, { field: "employee_code" });
  }
  const guardId = input.guard_id === null || input.guard_id === undefined || input.guard_id === "" ? null : positiveId(input.guard_id, "Guard");
  const siteIds = idList(input.site_ids ?? [], "Site assignments");
  const extra = input.person || {};
  const salaryAmount = extra.salary_amount === "" || extra.salary_amount === null || extra.salary_amount === undefined ? null : currency(extra.salary_amount, "Salary amount");
  const salaryFrequency = extra.salary_frequency || "monthly";
  if (!new Set(["monthly", "daily"]).has(salaryFrequency)) throw new OperationsRequestError("Salary frequency must be monthly or daily.");
  const salaryEffectiveDate = person.salary_effective_from;
  const { data, error } = await database.rpc("save_guard_profile", {
    p_guard_id: guardId,
    p_person: { ...person, employee_code: employeeCode, designation: String(extra.designation || "Security Guard").trim(), salary_amount: salaryAmount, salary_frequency: salaryFrequency, salary_effective_date: salaryEffectiveDate,
      salary_notes: String(extra.salary_notes || "").trim(), photo_storage_path: String(extra.photo_storage_path || "").trim() },
    p_site_ids: siteIds,
    p_actor_id: actorId,
  });
  if (error) throwRecordWriteError(error, "Guard details, compensation, and site assignments could not be saved.");
  if (!Number.isSafeInteger(Number(data)) || Number(data) <= 0) throw new OperationsRequestError("Guard save was not confirmed. Refresh the record.", guardId ? 404 : 500);
  return { ok: true, guard_id: data };
}

export async function deleteGuard(database, guardId, actorId) {
  const id = positiveId(guardId, "Guard");
  const { data, error } = await database.rpc("delete_guard_if_unreferenced", { p_guard_id: id, p_actor_id: actorId });
  if (error) throw new Error("Guard record has assignment, payroll, or advance history and cannot be deleted. Deactivate it to preserve that history.");
  return Boolean(data);
}

function currency(value, label, { allowSigned = false } = {}) {
  const raw = String(value ?? "").trim().replace(/₹|\bINR\b/gi, "").replace(/[\s,]/g, "");
  const pattern = allowSigned ? /^-?\d+(?:\.\d{1,2})?$/ : /^\d+(?:\.\d{1,2})?$/;
  const parsed = Number(raw);
  if (!raw || !pattern.test(raw) || !Number.isFinite(parsed) || Math.abs(parsed) > 100000000) throw new OperationsRequestError(`${label} must be a valid INR amount with up to two decimals.`);
  return parsed;
}

function parseEmployeeType(value) {
  if (!new Set(["guard", "supervisor", "field_officer"]).has(value)) throw new OperationsRequestError("Employee type is invalid.");
  return value;
}

function positiveId(value, label, optional = false) {
  if ((value === null || value === undefined || value === "") && optional) return null;
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw new OperationsRequestError(`${label} is invalid.`);
  return id;
}

function monthDate(value) {
  const match = /^(\d{4})-(\d{2})$/.exec(String(value ?? ""));
  if (!match) throw new OperationsRequestError("Choose a valid salary month.");
  const month = Number(match[2]);
  if (month < 1 || month > 12) throw new OperationsRequestError("Choose a valid salary month.");
  return `${match[1]}-${match[2]}-01`;
}

export async function recordAdvance(database, input, actorId, env = process.env) {
  const employeeType = parseEmployeeType(input?.employee_type);
  const employeeId = positiveId(input.employee_id, "Employee");
  const siteId = positiveId(input.site_id, "Site", true);
  const amount = currency(input.amount, "Advance amount");
  if (amount <= 0) throw new OperationsRequestError("Advance amount must be greater than zero.");
  const occurredAt = input.occurred_at ? new Date(input.occurred_at) : new Date();
  if (Number.isNaN(occurredAt.valueOf()) || occurredAt.valueOf() > Date.now() + 5 * 60 * 1000) throw new OperationsRequestError("Advance date and time must be valid and cannot be in the future.");
  const paymentMode = String(input.payment_mode ?? "").trim();
  const description = String(input.description ?? "").trim();
  const externalReference = String(input.external_reference ?? "").trim();
  if (paymentMode.length > 60 || description.length > 500 || externalReference.length > 255) throw new OperationsRequestError("Advance description or reference is too long.");
  const payload = {
    employee_type: employeeType,
    guard_id: employeeType === "guard" ? employeeId : null,
    supervisor_id: employeeType === "supervisor" ? employeeId : null,
    field_officer_id: employeeType === "field_officer" ? employeeId : null,
    site_id: siteId,
    amount,
    occurred_at: occurredAt.toISOString(),
    payment_mode: paymentMode,
    description,
    source: "dashboard",
    external_reference: externalReference || null,
    enqueue_sheet_sync: isGoogleSheetsSyncConfigured(env),
  };
  const { data, error } = await database.rpc("record_advance", { p_advance: payload, p_actor_id: actorId });
  if (error) throwRecordWriteError(error, "Advance could not be recorded. Verify the employee, site assignment, and amount.");
  if (!Number.isSafeInteger(Number(data)) || Number(data) <= 0) throw new OperationsRequestError("Advance save was not confirmed. Refresh before retrying.", 500);
  if (externalReference) {
    const { data: saved, error: readError } = await database.from("advances")
      .select("id,employee_type,guard_id,supervisor_id,field_officer_id,site_id,amount,occurred_at,payment_mode,description")
      .eq("id", data).maybeSingle();
    if (readError || !saved) throw new OperationsRequestError("Advance confirmation could not be read. Keep the same reference when retrying.", 503);
    const same = saved.employee_type === employeeType
      && Number(saved.guard_id ?? saved.supervisor_id ?? saved.field_officer_id) === employeeId
      && (saved.site_id == null ? null : Number(saved.site_id)) === siteId
      && Number(saved.amount) === amount && saved.payment_mode === paymentMode && saved.description === description
      && (!input.occurred_at || new Date(saved.occurred_at).valueOf() === occurredAt.valueOf());
    if (!same) throw new OperationsRequestError("This payment reference already belongs to different advance details. Refresh the register before recording another payment.", 409);
  }
  return { ok: true, advance_id: data };
}

export async function adjustAdvance(database, input, actorId) {
  const advanceId = positiveId(input?.advance_id, "Advance");
  const adjustmentType = input.adjustment_type === "reversal" ? "reversal" : input.adjustment_type === "correction" ? "correction" : null;
  if (!adjustmentType) throw new OperationsRequestError("Correction type is invalid.");
  const reason = String(input.reason ?? "").trim();
  if (!reason || reason.length > 500) throw new OperationsRequestError("A correction reason of 1 to 500 characters is required.");

  let amountDelta;
  if (adjustmentType === "correction") {
    amountDelta = currency(input.amount_delta, "Correction amount", { allowSigned: true });
    if (!amountDelta) throw new OperationsRequestError("Correction amount cannot be zero.");
  } else {
    const [{ data: advance, error: advanceError }, { data: adjustments, error: adjustmentError }, { data: recoveries, error: recoveryError }] = await Promise.all([
      database.from("advances").select("id,amount").eq("id", advanceId).maybeSingle(),
      database.from("advance_adjustments").select("amount_delta").eq("advance_id", advanceId),
      database.from("advance_recoveries").select("amount").eq("advance_id", advanceId),
    ]);
    if (advanceError || adjustmentError || recoveryError) throw new OperationsRequestError("Advance balance could not be checked.", 503);
    if (!advance) throw new OperationsRequestError("Advance was not found.", 404);
    const principal = Number(advance.amount) + (adjustments || []).reduce((sum, row) => sum + Number(row.amount_delta), 0);
    const recovered = (recoveries || []).reduce((sum, row) => sum + Number(row.amount), 0);
    const remaining = principal - recovered;
    if (remaining <= 0) throw new OperationsRequestError("This advance has no remaining balance to reverse.");
    amountDelta = -Number(remaining.toFixed(2));
  }
  const { data, error } = await database.rpc("append_advance_adjustment", {
    p_adjustment: { advance_id: advanceId, adjustment_type: adjustmentType, amount_delta: amountDelta, reason },
    p_actor_id: actorId,
  });
  if (error) throw new Error("Advance correction failed. Another administrator may have changed its balance; refresh and retry.");
  return { ok: true, adjustment_id: data };
}

export async function recoverAdvance(database, input, actorId) {
  const advanceId = positiveId(input?.advance_id, "Advance");
  const amount = currency(input.amount, "Recovery amount");
  if (amount <= 0) throw new OperationsRequestError("Recovery amount must be greater than zero.");
  const salaryPeriod = monthDate(input.salary_period);
  const notes = String(input.notes ?? "").trim();
  if (notes.length > 500) throw new OperationsRequestError("Recovery notes must be 500 characters or fewer.");
  const { data, error } = await database.rpc("append_advance_recovery", {
    p_recovery: { advance_id: advanceId, salary_period: salaryPeriod, amount, notes },
    p_actor_id: actorId,
  });
  if (error?.code === "23505") throw new OperationsRequestError("This advance already has a recovery allocated to this salary month. Refresh before retrying.", 409);
  if (error && ["23514", "P0001", "55000", "40001", "40P01"].includes(error.code)) throw new OperationsRequestError("Recovery conflicts with the available balance or a concurrent change. Refresh and review the amount before retrying.", 409);
  if (error) throw new OperationsRequestError("Recovery could not be recorded. Refresh and retry; no success was confirmed.", 503);
  return { ok: true, recovery_id: data };
}

export async function createSalaryAdjustment(database, input, actorId) {
  const employeeType = parseEmployeeType(input?.employee_type);
  const employeeId = positiveId(input.employee_id, "Employee");
  const amount = currency(input.amount, "Adjustment amount");
  if (amount <= 0) throw new OperationsRequestError("Adjustment amount must be greater than zero.");
  if (!new Set(["addition", "deduction"]).has(input.adjustment_type)) throw new OperationsRequestError("Choose an addition or deduction.");
  const description = String(input.description ?? "").trim();
  if (!description || description.length > 500) throw new OperationsRequestError("A reason of 1 to 500 characters is required.");
  const payload = {
    employee_type: employeeType,
    guard_id: employeeType === "guard" ? employeeId : null,
    supervisor_id: employeeType === "supervisor" ? employeeId : null,
    field_officer_id: employeeType === "field_officer" ? employeeId : null,
    salary_period: monthDate(input.salary_period),
    adjustment_type: input.adjustment_type,
    amount,
    description,
  };
  const { data, error } = await database.rpc("save_salary_adjustment", { p_adjustment: payload, p_actor_id: actorId });
  if (error) throw new Error("Salary adjustment could not be created.");
  return { ok: true, adjustment_id: data };
}

export async function listAdvances(database, query, actorId) {
  const page = Math.max(1, Math.min(100000, Number.parseInt(query.page, 10) || 1));
  const pageSize = Math.max(1, Math.min(200, Number.parseInt(query.page_size, 10) || 50));
  const from = String(query.from || "");
  const to = String(query.to || "");
  const validCalendarDate = value => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const timestamp = Date.parse(`${value}T00:00:00.000Z`);
    return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
  };
  if (from && !validCalendarDate(from)) throw new OperationsRequestError("Start date must be a valid YYYY-MM-DD date.");
  if (to && !validCalendarDate(to)) throw new OperationsRequestError("End date must be a valid YYYY-MM-DD date.");
  if (from && to && to < from) throw new OperationsRequestError("End date must be on or after the start date.");
  const fromTimestamp = from ? new Date(`${from}T00:00:00+05:30`).toISOString() : null;
  const toExclusive = to ? new Date(Date.parse(`${to}T00:00:00+05:30`) + 86400000).toISOString() : null;
  let request = database.from("advances").select("*", { count: "exact" }).order("occurred_at", { ascending: false });
  if (fromTimestamp) request = request.gte("occurred_at", fromTimestamp);
  if (toExclusive) request = request.lt("occurred_at", toExclusive);
  if (query.site_id) request = request.eq("site_id", positiveId(query.site_id, "Site"));
  if (query.employee_type) {
    const kind = parseEmployeeType(query.employee_type);
    request = request.eq("employee_type", kind);
    if (query.employee_id) request = request.eq(kind === "guard" ? "guard_id" : kind === "supervisor" ? "supervisor_id" : "field_officer_id", positiveId(query.employee_id, "Employee"));
  }
  request = request.range((page - 1) * pageSize, page * pageSize - 1);
  const { data: amountTotal, error: totalError } = await database.rpc("get_filtered_advances_total", {
    p_site_id: query.site_id ? positiveId(query.site_id, "Site") : null,
    p_employee_type: query.employee_type ? parseEmployeeType(query.employee_type) : null,
    p_employee_id: query.employee_id ? positiveId(query.employee_id, "Employee") : null,
    p_from: fromTimestamp,
    p_to: toExclusive,
    p_actor_id: actorId,
  });
  if (totalError) throw new OperationsRequestError("Filtered advance total could not be calculated.", 503);
  const { data, error, count } = await request;
  if (error) throw new OperationsRequestError("Advance records could not be loaded.", 503);
  const records = data || [];
  const idLists = {
    guard: [...new Set(records.filter(row => row.guard_id).map(row => row.guard_id))],
    supervisor: [...new Set(records.filter(row => row.supervisor_id).map(row => row.supervisor_id))],
    field_officer: [...new Set(records.filter(row => row.field_officer_id).map(row => row.field_officer_id))],
  };
  const ids = records.map(row => row.id);
  const [guardRows, supervisorRows, officerRows, siteRows, adjustmentRows, recoveryRows] = await Promise.all([
    idLists.guard.length ? database.from("guards").select("id,employee_code,full_name").in("id", idLists.guard) : Promise.resolve({ data: [], error: null }),
    idLists.supervisor.length ? database.from("supervisors").select("id,employee_code,full_name").in("id", idLists.supervisor) : Promise.resolve({ data: [], error: null }),
    idLists.field_officer.length ? database.from("field_officers").select("id,employee_code,full_name").in("id", idLists.field_officer) : Promise.resolve({ data: [], error: null }),
    [...new Set(records.map(row => row.site_id).filter(Boolean))].length ? database.from("sites").select("id,site_code,title").in("id", [...new Set(records.map(row => row.site_id).filter(Boolean))]) : Promise.resolve({ data: [], error: null }),
    ids.length ? database.from("advance_adjustments").select("advance_id,amount_delta,adjustment_type,reason,created_at").in("advance_id", ids) : Promise.resolve({ data: [], error: null }),
    ids.length ? database.from("advance_recoveries").select("advance_id,salary_period,amount,created_at").in("advance_id", ids) : Promise.resolve({ data: [], error: null }),
  ]);
  if ([guardRows, supervisorRows, officerRows, siteRows, adjustmentRows, recoveryRows].some(result => result.error)) throw new OperationsRequestError("Advance details could not be loaded.", 503);
  const people = {
    guard: new Map((guardRows.data || []).map(person => [String(person.id), person])),
    supervisor: new Map((supervisorRows.data || []).map(person => [String(person.id), person])),
    field_officer: new Map((officerRows.data || []).map(person => [String(person.id), person])),
  };
  const sites = new Map((siteRows.data || []).map(site => [String(site.id), site]));
  const adjustments = new Map();
  for (const row of adjustmentRows.data || []) adjustments.set(String(row.advance_id), [...(adjustments.get(String(row.advance_id)) || []), row]);
  const recoveries = new Map();
  for (const row of recoveryRows.data || []) recoveries.set(String(row.advance_id), [...(recoveries.get(String(row.advance_id)) || []), row]);
  return {
    page, page_size: pageSize, total: count || 0, amount_total: Number(amountTotal || 0),
    advances: records.map(record => {
      const employeeId = record.guard_id ?? record.supervisor_id ?? record.field_officer_id;
      const employee = people[record.employee_type].get(String(employeeId));
      const adjustmentList = adjustments.get(String(record.id)) || [];
      const recoveryList = recoveries.get(String(record.id)) || [];
      const balance = Number(record.amount) + adjustmentList.reduce((sum, row) => sum + Number(row.amount_delta), 0) - recoveryList.reduce((sum, row) => sum + Number(row.amount), 0);
      return { ...record, employee_name: employee?.full_name || "Unknown employee", employee_code: employee?.employee_code || "", site_title: sites.get(String(record.site_id))?.title || "Unassigned", adjustments: adjustmentList, recoveries: recoveryList, remaining_balance: Math.max(0, Number(balance.toFixed(2))) };
    }),
  };
}

export async function getPayrollSummary(database, period, actorId) {
  const date = monthDate(period);
  const { data, error } = await database.rpc("get_payroll_summary", { p_period: date, p_actor_id: actorId });
  if (error) throw new OperationsRequestError("Salary estimates could not be calculated.", 503);
  return { period: date.slice(0, 7), employees: Array.isArray(data) ? data : [] };
}
