import { normalizeSiteImportRows } from "../shared/operationsValidation.js";

export const MAX_SITE_IMPORT_BYTES = 3.5 * 1024 * 1024;
export const MAX_SITE_IMPORT_ROWS = 2000;

const headers = [
  "Site Code", "Site Name", "Site Status", "Services Taken", "Phone Numbers", "Given Emails",
  "Legacy Total Salary / Billing", "Security Guard Monthly Billing (INR)", "ASO Monthly Billing (INR)",
  "Payroll Effective Date", "ESI Applicable", "ESI Contribution Rate (%)", "PF Applicable",
  "PF Contribution Rate (%)", "Payroll Notes", "Guard Employee Code", "Guard Full Name", "Guard Phone",
  "Guard Email", "Guard Designation", "Guard Status", "Guard Joining Date",
  "Guard Gross Monthly Salary (INR)", "Guard Salary Effective From", "Supervisor Employee Code",
  "Supervisor Name", "Supervisor Phone", "Supervisor Email", "Supervisor Designation", "Supervisor Status",
  "Supervisor Joining Date", "Supervisor Gross Monthly Salary (INR)", "Supervisor Salary Effective From",
  "Field Officer Employee Code", "Field Officer Name", "Field Officer Phone", "Field Officer Email",
  "Field Officer Designation", "Field Officer Status", "Field Officer Joining Date",
  "Field Officer Gross Monthly Salary (INR)", "Field Officer Salary Effective From",
];

function parseCsvMatrix(text) {
  const source = String(text ?? "").replace(/^\uFEFF/, "");
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (character === '"' && source[index + 1] === '"') { cell += '"'; index += 1; }
      else if (character === '"') quoted = false;
      else cell += character;
    } else if (character === '"' && cell.length === 0) quoted = true;
    else if (character === ",") { row.push(cell); cell = ""; }
    else if (character === "\n" || character === "\r") {
      row.push(cell); rows.push(row); row = []; cell = "";
      if (character === "\r" && source[index + 1] === "\n") index += 1;
    } else cell += character;
  }
  if (quoted) throw new Error("CSV file has an unfinished quoted field.");
  if (cell.length || row.length || source.endsWith(",")) { row.push(cell); rows.push(row); }
  return rows;
}

function cellText(value) {
  if (value instanceof Date) return Number.isNaN(value.valueOf()) ? "" : value.toISOString().slice(0, 10);
  if (value === undefined || value === null) return "";
  if (typeof value === "object") {
    if (value.formula || value.sharedFormula) return value;
    if (Array.isArray(value.richText)) return value.richText.map(part => part.text || "").join("");
    if (typeof value.text === "string") return value.text;
    if (value.result !== undefined) return cellText(value.result);
  }
  return String(value).trim();
}

const normalizeHeader = value => String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
const fieldMap = new Map([
  ["sitecode", ["site_code", "site"]], ["sitename", ["title", "site"]], ["title", ["title", "site"]],
  ["sitestatus", ["status", "site"]], ["status", ["status", "site"]], ["servicestaken", ["service_taken", "site"]], ["service", ["service_taken", "site"]],
  ["phonenumbers", ["phone_numbers", "site"]], ["givenemails", ["given_emails", "site"]], ["legacytotalsalarybilling", ["total_salary", "site"]],
  ["securityguardmonthlybillinginr", ["security_guard_monthly_billing", "site"]], ["asomonthlybillinginr", ["aso_monthly_billing", "site"]],
  ["payrolleffectivedate", ["payroll_effective_date", "site"]], ["esiapplicable", ["esi_applicable", "site"]], ["esicontributionrate", ["esi_contribution_rate", "site"]],
  ["esicontributionratepercent", ["esi_contribution_rate", "site"]], ["pfapplicable", ["pf_applicable", "site"]], ["pfcontributionrate", ["pf_contribution_rate", "site"]],
  ["pfcontributionratepercent", ["pf_contribution_rate", "site"]], ["payrollnotes", ["payroll_notes", "site"]],
  ["guardemployeecode", ["employee_code", "guard"]], ["guardfullname", ["full_name", "guard"]], ["guardname", ["full_name", "guard"]], ["guardphone", ["phone", "guard"]],
  ["guardemail", ["email", "guard"]], ["guarddesignation", ["designation", "guard"]], ["guardstatus", ["status", "guard"]], ["guardjoiningdate", ["joining_date", "guard"]],
  ["guardgrossmonthlysalaryinr", ["gross_monthly_salary", "guard"]], ["guardsalaryeffectivefrom", ["salary_effective_from", "guard"]],
  ["supervisoremployeecode", ["employee_code", "supervisor"]], ["supervisorname", ["full_name", "supervisor"]], ["supervisorphone", ["phone", "supervisor"]],
  ["supervisoremail", ["email", "supervisor"]], ["supervisordesignation", ["designation", "supervisor"]], ["supervisorstatus", ["status", "supervisor"]],
  ["supervisorjoiningdate", ["joining_date", "supervisor"]], ["supervisorgrossmonthlysalaryinr", ["gross_monthly_salary", "supervisor"]], ["supervisorsalaryeffectivefrom", ["salary_effective_from", "supervisor"]],
  ["fieldofficeremployeecode", ["employee_code", "field_officer"]], ["fieldofficername", ["full_name", "field_officer"]], ["fieldofficerphone", ["phone", "field_officer"]],
  ["fieldofficeremail", ["email", "field_officer"]], ["fieldofficerdesignation", ["designation", "field_officer"]], ["fieldofficerstatus", ["status", "field_officer"]],
  ["fieldofficerjoiningdate", ["joining_date", "field_officer"]], ["fieldofficergrossmonthlysalaryinr", ["gross_monthly_salary", "field_officer"]], ["fieldofficersalaryeffectivefrom", ["salary_effective_from", "field_officer"]],
]);

function recordsFromMatrix(matrix, formulaCells = new Map()) {
  const headerIndex = matrix.findIndex(row => row.some(value => String(value ?? "").trim()));
  if (headerIndex < 0) throw new Error("The selected file is empty.");
  const header = matrix[headerIndex].map(value => String(value ?? "").trim());
  const normalized = header.map(normalizeHeader);
  if (!normalized.includes("sitecode")) throw new Error("Required column missing: Site Code.");
  if (!normalized.includes("sitename") && !normalized.includes("title")) throw new Error("Required column missing: Site Name.");
  const seen = new Set();
  for (let index = 0; index < header.length; index += 1) {
    if (!normalized[index]) continue;
    if (seen.has(normalized[index])) throw new Error(`Duplicate column heading: ${header[index]}.`);
    seen.add(normalized[index]);
  }
  const rows = [];
  for (let matrixIndex = headerIndex + 1; matrixIndex < matrix.length; matrixIndex += 1) {
    const values = matrix[matrixIndex] || [];
    if (!values.some(value => String(value ?? "").trim())) continue;
    const row = { rowNumber: matrixIndex + 1, site: {}, __formula_fields: formulaCells.get(matrixIndex + 1) || [] };
    for (let column = 0; column < header.length; column += 1) {
      const target = fieldMap.get(normalized[column]);
      if (!target) continue;
      const [field, group] = target;
      const value = cellText(values[column]);
      if (value && typeof value === "object" && (value.formula || value.sharedFormula)) {
        row.__formula_fields.push(header[column]);
        continue;
      }
      if (group === "site") row.site[field] = value;
      else {
        row[group] ||= {};
        row[group][field] = value;
      }
    }
    if (!Object.keys(row.guard || {}).length) delete row.guard;
    if (!Object.keys(row.supervisor || {}).length) delete row.supervisor;
    if (!Object.keys(row.field_officer || {}).length) delete row.field_officer;
    rows.push(row);
    if (rows.length > MAX_SITE_IMPORT_ROWS) throw new Error(`A maximum of ${MAX_SITE_IMPORT_ROWS} non-empty rows can be imported at once.`);
  }
  if (!rows.length) throw new Error("The selected file contains no site rows.");
  return rows;
}

export async function parseSiteImportFile(file) {
  if (!file || typeof file.name !== "string") throw new Error("Select a CSV or Excel .xlsx file.");
  if (file.size > MAX_SITE_IMPORT_BYTES) throw new Error(`The file must be ${MAX_SITE_IMPORT_BYTES / (1024 * 1024)} MB or smaller.`);
  const extension = file.name.split(".").pop()?.toLowerCase();
  if (extension === "csv") {
    const text = typeof file.text === "function" ? await file.text() : new TextDecoder().decode(await file.arrayBuffer());
    return recordsFromMatrix(parseCsvMatrix(text));
  }
  if (extension !== "xlsx") throw new Error("Only CSV and .xlsx files are supported.");
  const { default: ExcelJS } = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await file.arrayBuffer());
  const worksheet = workbook.worksheets[0];
  if (!worksheet) throw new Error("The Excel workbook does not contain a worksheet.");
  const matrix = [];
  const formulas = new Map();
  for (let rowNumber = 1; rowNumber <= worksheet.rowCount; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    const values = [];
    const formulaFields = [];
    for (let column = 1; column <= worksheet.columnCount; column += 1) {
      const cell = row.getCell(column);
      if (cell.value && typeof cell.value === "object" && (cell.value.formula || cell.value.sharedFormula)) {
        formulaFields.push(String(worksheet.getRow(1).getCell(column).text || `Column ${column}`));
        values[column - 1] = "";
      } else values[column - 1] = cellText(cell.value);
    }
    matrix[rowNumber - 1] = values;
    if (formulaFields.length) formulas.set(rowNumber, formulaFields);
  }
  return recordsFromMatrix(matrix, formulas);
}

export function previewSiteImportRows(rows, existingSites = []) {
  const normalized = normalizeSiteImportRows(rows);
  const existing = new Set(existingSites.map(site => String(site.site_code || "").trim().toLowerCase()).filter(Boolean));
  return {
    sites: normalized.sites.map(site => ({ ...site, state: existing.has(site.site_code.toLowerCase()) ? "update" : "create" })),
    errors: normalized.errors,
    totalRows: rows.length,
  };
}

export function siteImportTemplateCsv() {
  return `\uFEFF${headers.map(header => `"${header.replace(/"/g, '""')}"`).join(",")}\r\n`;
}

export function siteRecordsToCsv(records) {
  const fields = [
    ["Site Code", "site_code"], ["Site Name", "title"], ["Site Status", "status"], ["Services Taken", "service_taken"],
    ["Phone Numbers", "phone_numbers"], ["Given Emails", "given_emails"], ["Legacy Total Salary / Billing", "total_salary"],
    ["Security Guard Monthly Billing (INR)", "security_guard_monthly_billing"], ["ASO Monthly Billing (INR)", "aso_monthly_billing"],
    ["Payroll Effective Date", "payroll_effective_date"], ["ESI Applicable", "esi_applicable"], ["ESI Contribution Rate (%)", "esi_contribution_rate"],
    ["PF Applicable", "pf_applicable"], ["PF Contribution Rate (%)", "pf_contribution_rate"], ["Payroll Notes", "payroll_notes"],
  ];
  const escape = value => {
    const text = value === null || value === undefined ? "" : String(value);
    const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
    return `"${safe.replace(/"/g, '""')}"`;
  };
  const matrix = [fields.map(([label]) => label), ...records.map(record => fields.map(([, key]) => record[key] ?? ""))];
  return `\uFEFF${matrix.map(row => row.map(escape).join(",")).join("\r\n")}`;
}
