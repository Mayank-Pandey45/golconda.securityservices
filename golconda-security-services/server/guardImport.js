import {
  GuardValidationError,
  normalizeGuardRow,
  normalizeSiteKey,
} from "../shared/guardValidation.js";
import { normalizePhoneDigits } from "../shared/operationsValidation.js";
import { readAllRows } from "./paginatedQuery.js";

export class GuardImportRequestError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "GuardImportRequestError";
    this.status = status;
  }
}

function rowNumber(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 2 && number <= 100000 ? number : fallback;
}

export async function importGuardRows(database, rows, actorId) {
  if (!Array.isArray(rows) || rows.length === 0) throw new GuardImportRequestError("At least one guard row is required.");
  if (rows.length > 500) throw new GuardImportRequestError("A maximum of 500 guard rows can be imported at once.");

  let sites;
  let guards;
  try {
    [sites, guards] = await Promise.all([
      readAllRows(() => database.from("sites").select("id,title,site_code,status").order("id", { ascending: true })),
      readAllRows(() => database.from("guards").select("id,phone,employee_code").order("id", { ascending: true })),
    ]);
  } catch {
    throw new Error("Guard import could not read the current database records.");
  }

  const sitesByName = new Map();
  const sitesByCode = new Map();
  for (const site of sites) {
    const key = normalizeSiteKey(site.title);
    const values = sitesByName.get(key) || [];
    values.push(site.id);
    sitesByName.set(key, values);
    if (site.site_code) sitesByCode.set(String(site.site_code).trim().toLowerCase(), site.id);
  }

  const rowsResult = [];
  const validRows = [];
  const seenPhones = new Set(guards.map(guard => normalizePhoneDigits(guard.phone)).filter(Boolean));
  const seenEmployeeCodes = new Set(guards.map(guard => String(guard.employee_code || "").trim().toLowerCase()).filter(Boolean));
  for (let index = 0; index < rows.length; index += 1) {
    const item = rows[index];
    const source = item && typeof item === "object" && !Array.isArray(item)
      ? item.fields ?? item.raw ?? item.record ?? item
      : null;
    const number = rowNumber(item?.rowNumber, index + 2);
    try {
      const record = normalizeGuardRow(source);
      const phoneKey = normalizePhoneDigits(record.phone);
      if (seenPhones.has(phoneKey)) {
        rowsResult.push({ position: index, row: number, status: "skipped", message: "Duplicate phone number already exists or appears earlier in this file." });
        continue;
      }
      const codeKey = String(record.employee_code || "").trim().toLowerCase();
      if (codeKey && seenEmployeeCodes.has(codeKey)) {
        rowsResult.push({ position: index, row: number, status: "failed", message: "Employee Code is already assigned to another record." });
        continue;
      }

      const siteIds = [];
      for (const siteName of record.assigned_sites) {
        const normalizedSite = normalizeSiteKey(siteName);
        const exactCodeMatch = sitesByCode.get(normalizedSite);
        const matchingSites = exactCodeMatch ? [exactCodeMatch] : sitesByName.get(normalizedSite) || [];
        if (matchingSites.length === 0) throw new GuardValidationError(`Assigned site “${siteName}” was not found.`, "assigned_sites");
        if (matchingSites.length > 1) throw new GuardValidationError(`Assigned site “${siteName}” matches more than one site. Use its site code.`, "assigned_sites");
        const siteId = matchingSites[0];
        const site = sites.find(item => item.id === siteId);
        if (site?.status === "inactive") throw new GuardValidationError(`Assigned site “${siteName}” is inactive.`, "assigned_sites");
        siteIds.push(siteId);
      }

      seenPhones.add(phoneKey);
      if (codeKey) seenEmployeeCodes.add(codeKey);
      validRows.push({ position: index, row: number, phoneKey, values: {
        employee_code: record.employee_code,
        full_name: record.full_name,
        phone: record.phone,
        email: record.email,
        designation: record.designation,
        status: record.status,
        joining_date: record.joining_date,
        employment_end_date: record.employment_end_date,
        date_of_birth: record.date_of_birth,
        residential_address: record.residential_address,
        salary_amount: record.salary_amount,
        salary_frequency: record.salary_frequency,
        salary_effective_date: record.salary_effective_date,
        salary_notes: record.salary_notes,
      }, siteIds });
      rowsResult.push({ position: index, row: number, status: "pending", message: "Validated." });
    } catch (error) {
      rowsResult.push({
        position: index,
        row: number,
        status: "failed",
        message: error instanceof GuardValidationError ? error.message : "Row validation failed.",
      });
    }
  }

  for (const item of validRows) {
    const row = rowsResult.find(result => result.position === item.position && result.status === "pending");
    try {
      const { data, error } = await database.rpc("save_guard_profile", {
        p_guard_id: null,
        p_person: { ...item.values, photo_storage_path: "" },
        p_site_ids: item.siteIds,
        p_actor_id: actorId,
      });
      if (error || !Number.isSafeInteger(Number(data)) || Number(data) < 1) throw error || new Error("No guard record was returned.");
      if (row) {
        row.status = "inserted";
        row.message = "Imported successfully.";
      }
    } catch {
      if (row) {
        row.status = "failed";
        row.message = "Database save failed for this row. Check employee code and phone uniqueness, then retry.";
      }
    }
  }

  const inserted = rowsResult.filter(row => row.status === "inserted").length;
  const skipped = rowsResult.filter(row => row.status === "skipped").length;
  const failed = rowsResult.filter(row => row.status === "failed").length;
  return { ok: true, inserted, skipped, failed, rows: rowsResult.map(({ position, ...row }) => row) };
}
