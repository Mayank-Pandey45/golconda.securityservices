export class OperationsValidationError extends Error {
  constructor(message, field = "record") {
    super(message);
    this.name = "OperationsValidationError";
    this.field = field;
  }
}

const statuses = new Set(["active", "inactive", "on_leave", "relieved"]);
const serviceTypes = new Set(["SECURITY GUARD", "ASO", "BOTH"]);
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function text(value, field, label, { required = false, max = 500, fallback = "" } = {}) {
  if (value === undefined || value === null) value = "";
  if (typeof value !== "string" && typeof value !== "number") throw new OperationsValidationError(`${label} must be text.`, field);
  const result = String(value).trim();
  if (required && !result) throw new OperationsValidationError(`${label} is required.`, field);
  if (result.length > max) throw new OperationsValidationError(`${label} must be ${max} characters or fewer.`, field);
  return result || fallback;
}

function amount(value, field, label, { required = false } = {}) {
  const raw = text(value, field, label);
  if (!raw) {
    if (required) throw new OperationsValidationError(`${label} is required.`, field);
    return null;
  }
  const cleaned = raw.replace(/₹|\bINR\b/gi, "").replace(/[\s,]/g, "");
  if (!/^\d+(?:\.\d{1,2})?$/.test(cleaned)) throw new OperationsValidationError(`${label} must be a non-negative INR amount with up to two decimals.`, field);
  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed) || parsed > 100000000) throw new OperationsValidationError(`${label} is outside the supported range.`, field);
  return parsed;
}

function date(value, field, label) {
  const raw = text(value, field, label);
  if (!raw) return null;
  const parsed = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(raw);
  const normalizedDate = parsed ? new Date(Date.UTC(Number(parsed[1]), Number(parsed[2]) - 1, Number(parsed[3]))) : null;
  if (!parsed || normalizedDate.toISOString().slice(0, 10) !== raw) {
    throw new OperationsValidationError(`${label} must use YYYY-MM-DD.`, field);
  }
  return raw;
}

export function normalizePhoneDigits(value) {
  const digits = String(value ?? "").replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("91")) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith("0")) return digits.slice(1);
  return digits;
}

function validatePhone(value, field, label, { required = false } = {}) {
  const phone = text(value, field, label, { max: 24 });
  if (!phone && !required) return "";
  const digits = normalizePhoneDigits(phone);
  if (!/^[+\d()\s.-]+$/.test(phone) || digits.length < 10 || digits.length > 15) {
    throw new OperationsValidationError(`${label} must contain 10–15 digits and standard phone characters.`, field);
  }
  return phone;
}

function validateEmail(value, field, label, { required = false } = {}) {
  const email = text(value, field, label, { max: 254 }).toLowerCase();
  if (!email && !required) return null;
  if (!emailPattern.test(email)) throw new OperationsValidationError(`${label} must be a valid email address.`, field);
  return email;
}

function normalizeStatus(value, field = "status") {
  const status = text(value, field, "Status", { max: 32, fallback: "active" }).toLowerCase().replace(/[ -]+/g, "_");
  if (!statuses.has(status)) throw new OperationsValidationError("Status must be Active, Inactive, On Leave, or Relieved.", field);
  return status;
}

function splitList(value, field, label, validator, maxEntries = 5) {
  const raw = text(value, field, label, { max: 1200 });
  if (!raw) return "";
  const items = raw.split(/[;,\n]/).map(item => item.trim()).filter(Boolean);
  if (items.length > maxEntries) throw new OperationsValidationError(`${label} supports up to ${maxEntries} entries.`, field);
  const normalized = items.map((item, index) => validator(item, `${field}.${index}`, `${label} entry ${index + 1}`, { required: true }));
  const unique = new Set(normalized.map(item => field === "phone_numbers" ? normalizePhoneDigits(item) : item.toLowerCase()));
  if (unique.size !== normalized.length) throw new OperationsValidationError(`${label} contains duplicates.`, field);
  return normalized.join(", ");
}

export function normalizeSiteRecord(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new OperationsValidationError("Site details are required.");
  const title = text(input.title, "title", "Site name", { required: true, max: 160 });
  const site_code = text(input.site_code, "site_code", "Site code", { required: true, max: 64 }).toUpperCase();
  if (!/^[A-Z0-9_-]+$/.test(site_code)) throw new OperationsValidationError("Site code may contain letters, numbers, hyphens, and underscores.", "site_code");
  const service_taken = text(input.service_taken, "service_taken", "Services taken", { max: 30, fallback: "SECURITY GUARD" }).toUpperCase();
  if (!serviceTypes.has(service_taken)) throw new OperationsValidationError("Services taken must be Security Guard, ASO, or Both.", "service_taken");
  const status = normalizeStatus(input.status);
  if (!new Set(["active", "inactive"]).has(status)) throw new OperationsValidationError("Site status must be Active or Inactive.", "status");
  const rate = (value, field, label) => amount(value, field, label);
  const percent = (value, field, label) => {
    const raw = text(value, field, label);
    if (!raw) return null;
    const cleaned = raw.replace(/%/g, "").replace(/[\s,]/g, "");
    if (!/^\d+(?:\.\d{1,4})?$/.test(cleaned)) throw new OperationsValidationError(`${label} must be between 0 and 100 with up to four decimals.`, field);
    const parsed = Number(cleaned);
    if (!Number.isFinite(parsed) || parsed > 100) throw new OperationsValidationError(`${label} must be between 0 and 100.`, field);
    return parsed;
  };
  const booleanOrNull = (value, field) => {
    if (value === "" || value === undefined || value === null) return null;
    if (typeof value === "boolean") return value;
    const normalized = String(value).trim().toLowerCase();
    if (["true", "yes", "1", "applicable"].includes(normalized)) return true;
    if (["false", "no", "0", "not applicable"].includes(normalized)) return false;
    throw new OperationsValidationError("Choose Yes or No.", field);
  };
  return {
    site_code,
    title,
    phone_numbers: splitList(input.phone_numbers, "phone_numbers", "Phone numbers", validatePhone),
    total_salary: text(input.total_salary, "total_salary", "Legacy total salary / billing", { max: 120 }),
    service_taken,
    given_emails: splitList(input.given_emails, "given_emails", "Given emails", validateEmail),
    status,
    security_guard_monthly_billing: rate(input.security_guard_monthly_billing, "security_guard_monthly_billing", "Security guard monthly billing"),
    aso_monthly_billing: rate(input.aso_monthly_billing, "aso_monthly_billing", "ASO monthly billing"),
    payroll_effective_date: date(input.payroll_effective_date, "payroll_effective_date", "Payroll effective date"),
    esi_applicable: booleanOrNull(input.esi_applicable, "esi_applicable"),
    esi_contribution_rate: percent(input.esi_contribution_rate, "esi_contribution_rate", "ESI contribution rate"),
    pf_applicable: booleanOrNull(input.pf_applicable, "pf_applicable"),
    pf_contribution_rate: percent(input.pf_contribution_rate, "pf_contribution_rate", "PF contribution rate"),
    payroll_notes: text(input.payroll_notes, "payroll_notes", "Payroll notes", { max: 1000 }),
  };
}

export function normalizeImportedPerson(person, kind) {
  const label = kind === "guard" ? "Guard" : kind === "supervisor" ? "Supervisor" : "Field officer";
  if (!person || typeof person !== "object" || Array.isArray(person)) throw new OperationsValidationError(`${label} record is invalid.`);
  const full_name = text(person.full_name, "full_name", `${label} name`, { required: true, max: 160 });
  const phone = validatePhone(person.phone, "phone", `${label} phone`, { required: true });
  const email = validateEmail(person.email, "email", `${label} email`);
  const designation = text(person.designation, "designation", `${label} designation`, { max: 100, fallback: label });
  const status = normalizeStatus(person.status);
  const joining_date = date(person.joining_date, "joining_date", `${label} joining date`);
  const gross_monthly_salary = amount(person.gross_monthly_salary, "gross_monthly_salary", `${label} gross monthly salary`);
  const salary_effective_from = date(person.salary_effective_from, "salary_effective_from", `${label} salary effective date`);
  const employee_code = text(person.employee_code, "employee_code", `${label} employee code`, { max: 64 }).toUpperCase() || null;
  if (employee_code && !/^[A-Z0-9_-]+$/.test(employee_code)) throw new OperationsValidationError(`${label} employee code may contain letters, numbers, hyphens, and underscores.`, "employee_code");
  return { employee_code, full_name, phone, email, designation, status, joining_date, gross_monthly_salary, salary_effective_from };
}

export function normalizeEmployeeProfile(person, kind) {
  if (!new Set(["supervisor", "field_officer"]).has(kind)) throw new OperationsValidationError("Employee type is invalid.");
  const base = normalizeImportedPerson(person, kind);
  const optionalDate = (key, label) => date(person[key], key, label);
  const percent = (value, field, label) => {
    const raw = text(value, field, label);
    if (!raw) return null;
    const cleaned = raw.replace(/%/g, "").replace(/[\s,]/g, "");
    if (!/^\d+(?:\.\d{1,4})?$/.test(cleaned)) throw new OperationsValidationError(`${label} must be between 0 and 100 with up to four decimals.`, field);
    const parsed = Number(cleaned);
    if (!Number.isFinite(parsed) || parsed > 100) throw new OperationsValidationError(`${label} must be between 0 and 100.`, field);
    return parsed;
  };
  const optionalBoolean = (value, field) => {
    if (value === "" || value === undefined || value === null) return null;
    if (typeof value === "boolean") return value;
    const normalized = String(value).trim().toLowerCase();
    if (["true", "yes", "1"].includes(normalized)) return true;
    if (["false", "no", "0"].includes(normalized)) return false;
    throw new OperationsValidationError("Choose applicable, not applicable, or not configured.", field);
  };
  const photo_storage_path = text(person.photo_storage_path, "photo_storage_path", "Photo path", { max: 500 });
  if (photo_storage_path && (photo_storage_path.startsWith("/") || photo_storage_path.split("/").some(part => part === ".." || part === ""))) {
    throw new OperationsValidationError("Photo path is invalid.", "photo_storage_path");
  }
  return {
    ...base,
    joining_date: optionalDate("joining_date", "Joining date"),
    employment_end_date: optionalDate("employment_end_date", "Employment end date"),
    date_of_birth: optionalDate("date_of_birth", "Date of birth"),
    residential_address: text(person.residential_address, "residential_address", "Residential address", { max: 1000 }),
    photo_storage_path: photo_storage_path || null,
    salary_notes: text(person.salary_notes, "salary_notes", "Salary notes", { max: 1000 }),
    esi_applicable: optionalBoolean(person.esi_applicable, "esi_applicable"),
    esi_contribution_rate: percent(person.esi_contribution_rate, "esi_contribution_rate", "ESI contribution rate"),
    pf_applicable: optionalBoolean(person.pf_applicable, "pf_applicable"),
    pf_contribution_rate: percent(person.pf_contribution_rate, "pf_contribution_rate", "PF contribution rate"),
  };
}

export function normalizeSiteImportRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) throw new OperationsValidationError("The import contains no site rows.");
  if (rows.length > 2000) throw new OperationsValidationError("A maximum of 2,000 spreadsheet rows can be imported at once.");

  const sites = new Map();
  const errors = [];
  for (let index = 0; index < rows.length; index += 1) {
    const input = rows[index] || {};
    const row = Number.isInteger(input.rowNumber) ? input.rowNumber : index + 2;
    try {
      if (Array.isArray(input.__formula_fields) && input.__formula_fields.length) {
        throw new OperationsValidationError(`Spreadsheet formulas are not accepted (${input.__formula_fields.join(", ")}).`);
      }
      const site = normalizeSiteRecord(input.site ?? input);
      const siteKey = site.site_code.toLowerCase();
      let group = sites.get(siteKey);
      if (!group) {
        group = { ...site, guards: [], supervisors: [], field_officers: [], _rowNumbers: [row] };
        sites.set(siteKey, group);
      } else {
        for (const key of Object.keys(site)) {
          if (String(group[key] ?? "") !== String(site[key] ?? "")) throw new OperationsValidationError(`Rows for site code ${site.site_code} contain conflicting ${key.replaceAll("_", " ")} values.`, key);
        }
        group._rowNumbers.push(row);
      }

      for (const kind of ["guard", "supervisor", "field_officer"]) {
        const source = input[kind] ?? input[`${kind}s`];
        const list = source ? (Array.isArray(source) ? source : [source]) : [];
        const outputKey = kind === "field_officer" ? "field_officers" : `${kind}s`;
        for (const candidate of list) {
          if (!candidate || !Object.values(candidate).some(value => String(value ?? "").trim())) continue;
          const person = normalizeImportedPerson(candidate, kind);
          const key = normalizePhoneDigits(person.phone);
          const previous = group[outputKey].find(entry => normalizePhoneDigits(entry.phone) === key);
          if (previous) {
            if (JSON.stringify(previous) !== JSON.stringify(person)) throw new OperationsValidationError(`The same ${kind.replace("_", " ")} phone has conflicting details within this site.`, "phone");
          } else group[outputKey].push(person);
        }
      }
    } catch (error) {
      errors.push({ row, message: error.message || "Row validation failed." });
    }
  }
  if (errors.length) return { sites: [...sites.values()].map(stripImportMeta), errors };
  return { sites: [...sites.values()].map(stripImportMeta), errors: [] };
}

function stripImportMeta(site) {
  const { _rowNumbers, ...result } = site;
  return result;
}
