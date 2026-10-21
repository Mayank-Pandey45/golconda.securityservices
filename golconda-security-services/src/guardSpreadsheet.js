import { normalizeGuardRow } from "../shared/guardValidation.js";
import { normalizePhoneDigits } from "../shared/operationsValidation.js";

export const MAX_GUARD_IMPORT_BYTES = 5 * 1024 * 1024;
export const MAX_GUARD_IMPORT_ROWS = 500;

const columns = [
  ["Employee Code", "employee_code"],
  ["Full Name", "full_name"],
  ["Phone", "phone"],
  ["Email", "email"],
  ["Designation", "designation"],
  ["Status", "status"],
  ["Joining Date", "joining_date"],
  ["Employment End Date", "employment_end_date"],
  ["Date of Birth", "date_of_birth"],
  ["Residential Address", "residential_address"],
  ["Assigned Sites (semicolon-separated site names or codes)", "assigned_sites"],
  ["Salary Amount (INR)", "salary_amount"],
  ["Salary Frequency", "salary_frequency"],
  ["Salary Effective Date", "salary_effective_date"],
  ["Salary Notes", "salary_notes"],
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
      if (character === '"' && source[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        cell += character;
      }
    } else if (character === '"' && cell.length === 0) {
      quoted = true;
    } else if (character === ",") {
      row.push(cell);
      cell = "";
    } else if (character === "\n" || character === "\r") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      if (character === "\r" && source[index + 1] === "\n") index += 1;
    } else {
      cell += character;
    }
  }

  if (quoted) throw new Error("CSV file has an unfinished quoted field.");
  if (cell.length || row.length || source.endsWith(",")) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function scalarCellValue(value) {
  if (value instanceof Date || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (value && typeof value === "object") {
    if (value.formula || value.sharedFormula) return value;
    if (Array.isArray(value.richText)) return value.richText.map(part => part.text || "").join("");
    if (typeof value.text === "string") return value.text;
    if (value.result !== undefined) return scalarCellValue(value.result);
  }
  return "";
}

function rowsToRecords(matrix, { formulaCells = new Map() } = {}) {
  const firstHeaderIndex = matrix.findIndex(row => row.some(value => String(value ?? "").trim()));
  if (firstHeaderIndex < 0) throw new Error("The selected file is empty.");
  const headerRow = matrix[firstHeaderIndex].map(value => String(value ?? "").trim());
  const knownHeaders = new Set(headerRow.map(value => value.toLowerCase().replace(/[^a-z0-9]/g, "")));
  if (!knownHeaders.has("fullname") && !knownHeaders.has("name") && !knownHeaders.has("guardname") && !knownHeaders.has("employeename")) {
    throw new Error("Required column missing: Full Name.");
  }
  if (!knownHeaders.has("phone") && !knownHeaders.has("phonenumber") && !knownHeaders.has("mobile") && !knownHeaders.has("mobilenumber") && !knownHeaders.has("contact") && !knownHeaders.has("contactnumber")) {
    throw new Error("Required column missing: Phone.");
  }

  const recognized = new Set();
  for (const header of headerRow) {
    const normalized = header.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!normalized) continue;
    if (recognized.has(normalized)) throw new Error(`Duplicate column heading: ${header}.`);
    recognized.add(normalized);
  }

  const records = [];
  for (let matrixIndex = firstHeaderIndex + 1; matrixIndex < matrix.length; matrixIndex += 1) {
    const values = matrix[matrixIndex] || [];
    if (!values.some(value => String(value ?? "").trim())) continue;
    const raw = {};
    const formulaFields = formulaCells.get(matrixIndex + 1) || [];
    headerRow.forEach((header, columnIndex) => {
      if (header) raw[header] = scalarCellValue(values[columnIndex]);
    });
    if (formulaFields.length) raw.__formula_fields = formulaFields;
    records.push({ rowNumber: matrixIndex + 1, raw });
    if (records.length > MAX_GUARD_IMPORT_ROWS) {
      throw new Error(`A maximum of ${MAX_GUARD_IMPORT_ROWS} guard rows can be imported at once.`);
    }
  }
  if (!records.length) throw new Error("The selected file contains no guard rows.");
  return records;
}

export async function parseGuardImportFile(file) {
  if (!file || typeof file.name !== "string") throw new Error("Select a CSV or Excel .xlsx file.");
  if (file.size > MAX_GUARD_IMPORT_BYTES) throw new Error("The file must be 5 MB or smaller.");
  const extension = file.name.split(".").pop()?.toLowerCase();

  if (extension === "csv") {
    const text = typeof file.text === "function" ? await file.text() : new TextDecoder().decode(await file.arrayBuffer());
    return rowsToRecords(parseCsvMatrix(text));
  }
  if (extension !== "xlsx") throw new Error("Only CSV and .xlsx files are supported.");

  const { default: ExcelJS } = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await file.arrayBuffer());
  const worksheet = workbook.worksheets[0];
  if (!worksheet) throw new Error("The Excel workbook does not contain a worksheet.");

  const matrix = [];
  const formulaCells = new Map();
  for (let rowNumber = 1; rowNumber <= worksheet.rowCount; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    const values = [];
    const formulas = [];
    for (let column = 1; column <= worksheet.columnCount; column += 1) {
      const cell = row.getCell(column);
      const value = cell.value;
      if (value && typeof value === "object" && (value.formula || value.sharedFormula)) {
        formulas.push(String(worksheet.getRow(1).getCell(column).text || `Column ${column}`));
        values[column - 1] = "";
      } else {
        values[column - 1] = scalarCellValue(value);
      }
    }
    matrix[rowNumber - 1] = values;
    if (formulas.length) formulaCells.set(rowNumber, formulas);
  }
  return rowsToRecords(matrix, { formulaCells });
}

export function previewGuardImportRows(rows, { existingGuards = [], sites = [] } = {}) {
  const existingPhones = new Set(existingGuards.map(guard => normalizePhoneDigits(guard.phone)).filter(Boolean));
  const knownPhones = new Set(existingPhones);
  const normalizeSiteKey = value => String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  const titleMap = new Map();
  const codeMap = new Map();
  for (const site of sites) {
    const title = normalizeSiteKey(site.title);
    if (title) titleMap.set(title, [...(titleMap.get(title) || []), site]);
    const code = normalizeSiteKey(site.site_code);
    if (code) codeMap.set(code, [...(codeMap.get(code) || []), site]);
  }

  return rows.map(({ rowNumber, raw }) => {
    try {
      const record = normalizeGuardRow(raw);
      const phoneKey = normalizePhoneDigits(record.phone);
      if (knownPhones.has(phoneKey)) {
        return { rowNumber, raw, record, state: "skipped", message: "Duplicate phone number already exists." };
      }
      knownPhones.add(phoneKey);
      const matchedSites = [];
      for (const siteName of record.assigned_sites) {
        const key = normalizeSiteKey(siteName);
        const matches = codeMap.get(key) || titleMap.get(key) || [];
        if (!matches.length) return { rowNumber, raw, record, state: "invalid", message: `Assigned site “${siteName}” was not found.` };
        if (matches.length > 1) return { rowNumber, raw, record, state: "invalid", message: `Assigned site “${siteName}” matches more than one site.` };
        matchedSites.push(matches[0]);
      }
      return { rowNumber, raw, record: { ...record, site_ids: matchedSites.map(site => site.id) }, state: "ready", message: "Ready to import." };
    } catch (error) {
      return { rowNumber, raw, record: null, state: "invalid", message: error.message };
    }
  });
}

export function guardRecordsToCsv(records) {
  const escape = value => {
    const text = value === null || value === undefined ? "" : String(value);
    const safeText = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
    return `"${safeText.replace(/"/g, '""')}"`;
  };
  const matrix = [columns.map(([label]) => label)];
  for (const record of records) matrix.push(columns.map(([, key]) => record[key] ?? ""));
  return `\uFEFF${matrix.map(row => row.map(escape).join(",")).join("\r\n")}`;
}

export async function guardRecordsToXlsx(records) {
  const { default: ExcelJS } = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Golconda Security Services";
  workbook.created = new Date();
  const worksheet = workbook.addWorksheet("Guards", { views: [{ state: "frozen", ySplit: 1 }] });
  worksheet.columns = columns.map(([header, key]) => ({
    header,
    key,
    width: header === "Salary Notes" ? 32 : header.includes("Date") ? 18 : 22,
  }));
  for (const record of records) {
    const row = worksheet.addRow({
      ...record,
      joining_date: record.joining_date ? new Date(`${record.joining_date}T00:00:00.000Z`) : null,
      employment_end_date: record.employment_end_date ? new Date(`${record.employment_end_date}T00:00:00.000Z`) : null,
      date_of_birth: record.date_of_birth ? new Date(`${record.date_of_birth}T00:00:00.000Z`) : null,
      salary_effective_date: record.salary_effective_date ? new Date(`${record.salary_effective_date}T00:00:00.000Z`) : null,
    });
    for (let index = 1; index <= row.cellCount; index += 1) {
      const cell = row.getCell(index);
      if (typeof cell.value === "string") cell.value = { richText: [{ text: cell.value }] };
    }
  }
  worksheet.getColumn("joining_date").numFmt = "yyyy-mm-dd";
  worksheet.getColumn("employment_end_date").numFmt = "yyyy-mm-dd";
  worksheet.getColumn("date_of_birth").numFmt = "yyyy-mm-dd";
  worksheet.getColumn("salary_effective_date").numFmt = "yyyy-mm-dd";
  worksheet.getColumn("salary_amount").numFmt = '₹#,##0.00';
  worksheet.getRow(1).font = { bold: true };
  return workbook.xlsx.writeBuffer();
}

export function downloadFile(contents, filename, mimeType) {
  const blob = new Blob([contents], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
