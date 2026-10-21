export class GuardValidationError extends Error {
  constructor(message, field = "record") {
    super(message);
    this.name = "GuardValidationError";
    this.field = field;
  }
}

const fieldAliases = {
  employee_code: ["employee code", "employee id", "staff id"],
  full_name: ["full name", "fullname", "name", "guard name", "employee name"],
  phone: ["phone", "phone number", "mobile", "mobile number", "contact", "contact number"],
  email: ["email", "email address"],
  designation: ["designation", "role", "position"],
  status: ["status", "employment status"],
  joining_date: ["joining date", "date of joining", "doj"],
  employment_end_date: ["employment end date", "end date", "relieving date"],
  date_of_birth: ["date of birth", "dob"],
  residential_address: ["residential address", "home address", "address"],
  assigned_site: ["assigned site", "site", "site name", "deployment site", "location"],
  assigned_sites: ["assigned sites", "sites", "site names", "deployment sites", "locations"],
  salary_amount: ["salary amount", "salary amount inr", "salary", "salary inr", "pay", "pay amount"],
  salary_frequency: ["salary frequency", "pay frequency", "frequency"],
  salary_effective_date: ["salary effective date", "effective date"],
  salary_notes: ["salary notes", "salary note", "notes"],
};

const aliasToField = new Map(
  Object.entries(fieldAliases).flatMap(([field, aliases]) =>
    aliases.map(alias => [normalizeHeader(alias), field])
  )
);

function normalizeHeader(value) {
  return String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

function valueText(value) {
  if (value instanceof Date) return Number.isNaN(value.valueOf()) ? "" : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value && typeof value === "object") {
    if (value.formula || value.sharedFormula) throw new GuardValidationError("Spreadsheet formulas are not accepted.");
    if (Array.isArray(value.richText)) return value.richText.map(part => part.text || "").join("").trim();
    if (typeof value.text === "string") return value.text.trim();
    if (value.result !== undefined) return valueText(value.result);
  }
  return typeof value === "string" ? value.trim() : "";
}

function fieldValue(record, field) {
  for (const [header, value] of Object.entries(record)) {
    if (header.startsWith("__")) continue;
    const target = aliasToField.get(normalizeHeader(header));
    if (target === field) return value;
  }
  return undefined;
}

function requiredText(value, field, label, maxLength) {
  const result = valueText(value);
  if (typeof result !== "string" || !result) throw new GuardValidationError(`${label} is required.`, field);
  if (result.length > maxLength) throw new GuardValidationError(`${label} must be ${maxLength} characters or fewer.`, field);
  return result;
}

function optionalText(value, field, label, maxLength, fallback = "") {
  const result = valueText(value);
  if (typeof result !== "string") throw new GuardValidationError(`${label} must be text.`, field);
  if (result.length > maxLength) throw new GuardValidationError(`${label} must be ${maxLength} characters or fewer.`, field);
  return result || fallback;
}

function normalizedDate(value, field, label) {
  if (value === undefined || value === null || value === "") return null;
  let year;
  let month;
  let day;
  if (value instanceof Date) {
    if (Number.isNaN(value.valueOf())) throw new GuardValidationError(`${label} must be a valid date.`, field);
    year = value.getFullYear();
    month = value.getMonth() + 1;
    day = value.getDate();
  } else {
    const text = valueText(value);
    if (typeof text !== "string") throw new GuardValidationError(`${label} must be a valid date.`, field);
    const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
    const local = /^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})$/.exec(text);
    if (iso) {
      [, year, month, day] = iso.map(Number);
    } else if (local) {
      [, day, month, year] = local.map(Number);
    } else if (/^\d+(?:\.\d+)?$/.test(text) && Number(text) >= 20000 && Number(text) <= 80000) {
      const serial = Number(text);
      const date = new Date(Date.UTC(1899, 11, 30) + Math.floor(serial) * 86400000);
      year = date.getUTCFullYear();
      month = date.getUTCMonth() + 1;
      day = date.getUTCDate();
    } else {
      throw new GuardValidationError(`${label} must be YYYY-MM-DD or DD/MM/YYYY.`, field);
    }
  }
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() + 1 !== month || check.getUTCDate() !== day) {
    throw new GuardValidationError(`${label} must be a real calendar date.`, field);
  }
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function normalizedStatus(value) {
  const status = optionalText(value, "status", "Status", 30, "active")
    .toLowerCase().replace(/[\s-]+/g, "_");
  const aliases = { leave: "on_leave", onleave: "on_leave", terminated: "relieved", relieved: "relieved" };
  const result = aliases[status] || status;
  if (!["active", "inactive", "on_leave", "relieved"].includes(result)) {
    throw new GuardValidationError("Status must be Active, Inactive, On Leave, or Relieved.", "status");
  }
  return result;
}

function normalizedSalary(value) {
  if (value === undefined || value === null || value === "") return null;
  const text = valueText(value);
  if (typeof text !== "string") throw new GuardValidationError("Salary amount must be a number.", "salary_amount");
  const cleaned = text.replace(/₹|\bINR\b/gi, "").replace(/[\s,]/g, "");
  if (!/^\d+(?:\.\d{1,2})?$/.test(cleaned)) throw new GuardValidationError("Salary amount must be a non-negative INR amount with up to two decimals.", "salary_amount");
  const amount = Number(cleaned);
  if (!Number.isFinite(amount) || amount > 100000000) throw new GuardValidationError("Salary amount is outside the supported range.", "salary_amount");
  return amount;
}

export function normalizeGuardRow(rawRecord) {
  if (!rawRecord || typeof rawRecord !== "object" || Array.isArray(rawRecord)) {
    throw new GuardValidationError("Row must contain named columns.");
  }
  if (Array.isArray(rawRecord.__formula_fields) && rawRecord.__formula_fields.length) {
    throw new GuardValidationError(`Formula cells are not accepted (${rawRecord.__formula_fields.join(", ")}).`);
  }

  const employee_code = optionalText(fieldValue(rawRecord, "employee_code"), "employee_code", "Employee Code", 64).toUpperCase();
  if (employee_code && !/^[A-Z0-9_-]+$/.test(employee_code)) throw new GuardValidationError("Employee Code may contain letters, numbers, hyphens, and underscores only.", "employee_code");

  const full_name = requiredText(fieldValue(rawRecord, "full_name"), "full_name", "Full Name", 160);
  const phone = requiredText(fieldValue(rawRecord, "phone"), "phone", "Phone", 24);
  if (!/^[+\d()\s.-]+$/.test(phone) || (phone.match(/\d/g) || []).length < 10 || (phone.match(/\d/g) || []).length > 15) {
    throw new GuardValidationError("Phone must contain 10–15 digits and only standard phone characters.", "phone");
  }

  const email = optionalText(fieldValue(rawRecord, "email"), "email", "Email", 254).toLowerCase();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new GuardValidationError("Email must be valid when supplied.", "email");

  const designation = optionalText(fieldValue(rawRecord, "designation"), "designation", "Designation", 100, "Security Guard");
  const status = normalizedStatus(fieldValue(rawRecord, "status"));
  const joining_date = normalizedDate(fieldValue(rawRecord, "joining_date"), "joining_date", "Joining Date");
  const employment_end_date = normalizedDate(fieldValue(rawRecord, "employment_end_date"), "employment_end_date", "Employment End Date");
  const date_of_birth = normalizedDate(fieldValue(rawRecord, "date_of_birth"), "date_of_birth", "Date of Birth");
  if (joining_date && employment_end_date && employment_end_date < joining_date) throw new GuardValidationError("Employment End Date cannot be before Joining Date.", "employment_end_date");
  const residential_address = optionalText(fieldValue(rawRecord, "residential_address"), "residential_address", "Residential Address", 1000);
  const assignedSitesInput = fieldValue(rawRecord, "assigned_sites") ?? fieldValue(rawRecord, "assigned_site");
  const assignedSites = (Array.isArray(assignedSitesInput) ? assignedSitesInput : String(valueText(assignedSitesInput) ?? "").split(/[;\n]/))
    .map(value => String(value ?? "").trim()).filter(Boolean);
  if (assignedSites.length > 100) throw new GuardValidationError("A guard may be assigned to at most 100 sites in one import row.", "assigned_sites");
  const normalizedSites = assignedSites.map(value => optionalText(value, "assigned_sites", "Assigned Site", 160));
  const uniqueSites = new Set(normalizedSites.map(value => value.trim().toLowerCase().replace(/\s+/g, " ")));
  if (uniqueSites.size !== normalizedSites.length) throw new GuardValidationError("Assigned Sites contains duplicates.", "assigned_sites");
  const assigned_sites = normalizedSites;
  const salary_amount = normalizedSalary(fieldValue(rawRecord, "salary_amount"));
  let salary_frequency = optionalText(fieldValue(rawRecord, "salary_frequency"), "salary_frequency", "Salary Frequency", 20, salary_amount === null ? "" : "monthly").toLowerCase();
  if (salary_frequency) {
    salary_frequency = salary_frequency.replace(/[\s-]+/g, "_");
    if (!["monthly", "daily"].includes(salary_frequency)) throw new GuardValidationError("Salary Frequency must be Monthly or Daily.", "salary_frequency");
  }
  const salary_effective_date = normalizedDate(fieldValue(rawRecord, "salary_effective_date"), "salary_effective_date", "Salary Effective Date");
  const salary_notes = optionalText(fieldValue(rawRecord, "salary_notes"), "salary_notes", "Salary Notes", 1000);

  return {
    employee_code: employee_code || null,
    full_name,
    phone,
    email: email || null,
    designation,
    status,
    joining_date,
    employment_end_date,
    date_of_birth,
    residential_address,
    assigned_site: assigned_sites[0] || null,
    assigned_sites,
    salary_amount,
    salary_frequency: salary_frequency || null,
    salary_effective_date,
    salary_notes: salary_notes || null,
  };
}

export function normalizePhoneKey(phone) {
  return String(phone ?? "").replace(/\D/g, "");
}

export function normalizeSiteKey(siteName) {
  return String(siteName ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}
