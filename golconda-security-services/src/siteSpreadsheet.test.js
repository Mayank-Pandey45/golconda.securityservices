import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSiteImportFile, previewSiteImportRows, siteRecordsToCsv } from "./siteSpreadsheet.js";

function asFile(name, source) {
  const bytes = source instanceof Uint8Array ? source : new TextEncoder().encode(source);
  return { name, size: bytes.byteLength, text: async () => new TextDecoder().decode(bytes), arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
}

test("CSV site import parses repeated site rows and previews add/update status", async () => {
  const source = [
    "Site Code,Site Name,Site Status,Services Taken,Guard Full Name,Guard Phone,Supervisor Name,Supervisor Phone",
    "S-01,North Gate,Active,Both,Asha Rao,9876543210,Deepa Rao,9876543212",
    "S-01,North Gate,Active,Both,Bala Rao,9876543211,Deepa Rao,9876543212",
    "S-02,South Gate,Inactive,ASO,,,Deepa Rao,9876543212",
  ].join("\r\n");
  const rows = await parseSiteImportFile(asFile("sites.csv", source));
  const preview = previewSiteImportRows(rows, [{ site_code: "S-02" }]);
  assert.equal(preview.sites.length, 2);
  assert.equal(preview.sites[0].guards.length, 2);
  assert.equal(preview.sites[0].supervisors.length, 1);
  assert.deepEqual(preview.sites.map(site => site.state), ["create", "update"]);
  assert.equal(preview.errors.length, 0);
});

test("site import rejects formula cells and malformed headers before save", async () => {
  const { default: ExcelJS } = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("Sites");
  worksheet.addRow(["Site Code", "Site Name", "Services Taken"]);
  worksheet.addRow(["S-01", { formula: '"North Gate"', result: "North Gate" }, "SECURITY GUARD"]);
  const buffer = await workbook.xlsx.writeBuffer();
  const rows = await parseSiteImportFile(asFile("sites.xlsx", new Uint8Array(buffer)));
  const preview = previewSiteImportRows(rows);
  assert.match(preview.errors[0].message, /formulas are not accepted/i);
  await assert.rejects(() => parseSiteImportFile(asFile("bad.csv", "Phone,Status\r\n9876543210,Active")), /Site Code/i);
});

test("site CSV export escapes formula-like values for spreadsheet applications", () => {
  const csv = siteRecordsToCsv([{ site_code: "=cmd", title: "+HYPERLINK(1)", status: "active", service_taken: "SECURITY GUARD" }]);
  assert.match(csv, /'=cmd/);
  assert.match(csv, /'\+HYPERLINK/);
});
