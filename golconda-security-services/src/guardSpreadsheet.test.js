import assert from "node:assert/strict";
import { test } from "node:test";
import {
  guardRecordsToCsv,
  guardRecordsToXlsx,
  parseGuardImportFile,
  previewGuardImportRows,
} from "./guardSpreadsheet.js";

function asFile(name, contents) {
  const bytes = contents instanceof Uint8Array ? contents : new TextEncoder().encode(contents);
  return {
    name,
    size: bytes.byteLength,
    text: async () => new TextDecoder().decode(bytes),
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

test("CSV import handles quoted columns and validates row-level duplicates and site names", async () => {
  const file = asFile("guards.csv", 'Full Name,Phone Number,Email,Designation,Status,Joining Date,Assigned Site\r\n"Asha, Rao",9876543210,asha@example.com,Supervisor,Active,2024-01-02,North Gate\r\nBala,9876543211,,Security Guard,Relieved,,Unknown Site\r\nAsha Copy,9876543210,,Security Guard,Active,,North Gate');
  const rows = await parseGuardImportFile(file);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].rowNumber, 2);
  assert.equal(rows[0].raw["Full Name"], "Asha, Rao");

  const preview = previewGuardImportRows(rows, {
    existingGuards: [],
    sites: [{ id: 1, title: "North Gate" }],
  });
  assert.deepEqual(preview.map(row => row.state), ["ready", "invalid", "skipped"]);
  assert.match(preview[1].message, /site.*not found/i);
  assert.match(preview[2].message, /duplicate phone/i);
});

test("guard CSV imports preserve profile fields and resolve multiple active sites by title or code", async () => {
  const rows = await parseGuardImportFile(asFile("guards.csv", "Employee Code,Full Name,Phone,Employment End Date,Date of Birth,Residential Address,Assigned Sites\r\nGSS-GRD-55,Asha Rao,9876543210,2025-01-31,1990-02-03,Hyderabad,North Gate; SOUTH"));
  const preview = previewGuardImportRows(rows, { sites: [
    { id: 1, title: "North Gate", site_code: "NORTH" },
    { id: 2, title: "South Gate", site_code: "SOUTH" },
  ] });
  assert.equal(preview[0].state, "ready");
  assert.deepEqual(preview[0].record.site_ids, [1, 2]);
  assert.equal(preview[0].record.employee_code, "GSS-GRD-55");
  assert.equal(preview[0].record.date_of_birth, "1990-02-03");
  assert.equal(preview[0].record.residential_address, "Hyderabad");
});

test("XLSX import reads .xlsx data and reports formula cells without evaluating them", async () => {
  const { default: ExcelJS } = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("Guards");
  worksheet.addRow(["Full Name", "Phone", "Salary Amount"]);
  worksheet.addRow(["Asha Rao", "9876543210", { formula: "1000+1000", result: 2000 }]);
  const buffer = await workbook.xlsx.writeBuffer();
  const bytes = new Uint8Array(buffer);
  const rows = await parseGuardImportFile(asFile("guards.xlsx", bytes));
  assert.equal(rows.length, 1);
  const preview = previewGuardImportRows(rows);
  assert.equal(preview[0].state, "invalid");
  assert.match(preview[0].message, /formula cells are not accepted/i);
});

test("CSV export protects spreadsheet formula prefixes and XLSX export writes a usable workbook", async () => {
  const records = [{
    full_name: "=HYPERLINK(\"https://bad.example\")",
    phone: "+919876543210",
    email: "staff@example.com",
    designation: "Security Guard",
    status: "Active",
    joining_date: "2024-01-02",
    employment_end_date: "2025-01-31",
    date_of_birth: "1990-02-03",
    residential_address: "Hyderabad",
    assigned_sites: "North Gate; South Gate",
    salary_amount: 18000,
    salary_frequency: "monthly",
    salary_effective_date: "2024-01-01",
    salary_notes: "Private note",
  }];
  const csv = guardRecordsToCsv(records);
  assert.match(csv, /'=HYPERLINK/);
  assert.match(csv, /'\+919876543210/);

  const bytes = await guardRecordsToXlsx(records);
  const { default: ExcelJS } = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes);
  const worksheet = workbook.worksheets[0];
  const column = name => worksheet.getRow(1).values.indexOf(name);
  assert.equal(worksheet.getCell(2, column("Full Name")).text, records[0].full_name);
  assert.equal(worksheet.getCell(2, column("Assigned Sites (semicolon-separated site names or codes)")).text, records[0].assigned_sites);
  assert.equal(worksheet.getCell(2, column("Salary Amount (INR)")).value, 18000);
  assert.equal(worksheet.getCell(2, column("Date of Birth")).value.toISOString().slice(0, 10), "1990-02-03");
});

test("spreadsheet import rejects unsupported types and files larger than the cap", async () => {
  await assert.rejects(() => parseGuardImportFile(asFile("guards.xlsm", "")), /only CSV and .xlsx/i);
  const oversized = { name: "guards.csv", size: 5 * 1024 * 1024 + 1, text: async () => "" };
  await assert.rejects(() => parseGuardImportFile(oversized), /5 MB or smaller/i);
});


test('Guard CSV aliases and Excel rich-text headers share the server field mapping', async () => {
  for (const header of ['Full Name', 'FULL_NAME', 'Guard Full Name', 'Employee Full Name', 'Name of Guard', 'Name of Employee', 'Staff Name']) {
    const rows = await parseGuardImportFile(asFile('guards.csv', header + ',Mobile No.,Joining Date,Date of Birth,Salary Effective Date\nAsha Rao,9876543210,31-01-2026,01/04/90,01/01/26'));
    const [preview] = previewGuardImportRows(rows);
    assert.equal(preview.state, 'ready', preview.message);
    assert.equal(preview.record.full_name, 'Asha Rao'); assert.equal(preview.record.joining_date, '2026-01-31'); assert.equal(preview.record.date_of_birth, '1990-04-01'); assert.equal(preview.record.salary_effective_date, '2026-01-01');
  }
  await assert.rejects(() => parseGuardImportFile(asFile('duplicate.csv', 'Full Name,Guard Name,Phone\nA,B,9876543210')), /Duplicate column/);
  const { default: ExcelJS } = await import('exceljs');
  const book = new ExcelJS.Workbook(); const sheet = book.addWorksheet('Guards');
  sheet.addRow([{ richText: [{ text: 'Full ' }, { text: 'Name' }] }, 'Contact No.', 'Joining Date', 'Salary Effective Date']);
  sheet.addRow(['Asha Rao', '9876543210', '01/04/26', new Date('2026-04-01T00:00:00Z')]);
  const [preview] = previewGuardImportRows(await parseGuardImportFile(asFile('guards.xlsx', new Uint8Array(await book.xlsx.writeBuffer()))));
  assert.equal(preview.state, 'ready', preview.message); assert.equal(preview.record.joining_date, '2026-04-01'); assert.equal(preview.record.salary_effective_date, '2026-04-01');
});
