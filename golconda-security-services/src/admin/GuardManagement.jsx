import RecordActions, { RecordFilter } from "./RecordActions.jsx";
import { matchesRecordState } from "../../shared/recordLifecycle.js";
import { queueOrphan } from "./recordClient.js";
import React, { useEffect, useMemo, useState } from "react";
import { Camera, Download, FileSpreadsheet, FileText, Pencil, Plus, RefreshCw, Upload, X } from "lucide-react";
import { supabase } from "../supabase";
import { apiUrl, readApiResponse } from "../api";
import { normalizeGuardRow } from "../../shared/guardValidation.js";
import {
  downloadFile,
  guardRecordsToCsv,
  guardRecordsToXlsx,
  MAX_GUARD_IMPORT_BYTES,
  parseGuardImportFile,
  previewGuardImportRows,
} from "../guardSpreadsheet.js";
import "./guardManagement.css";

const initialForm = {
  employee_code: "", full_name: "", phone: "", email: "", designation: "Security Guard", status: "active",
  joining_date: "", employment_end_date: "", date_of_birth: "", residential_address: "", photo_storage_path: "", site_ids: [],
  salary_amount: "", salary_frequency: "monthly", salary_effective_date: "", salary_notes: "",
};

const employeeBucket = "employee-private";

async function postGuard(body) {
  const { data, error } = await supabase.auth.getSession();
  if (error || !data.session?.access_token) throw new Error("Sign in again to continue this administrator action.");
  const response = await fetch(apiUrl("/api/operations/guards"), {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${data.session.access_token}` }, body: JSON.stringify(body),
  });
  const result = await readApiResponse(response);
  return result;
}

function formatSalary(amount, frequency) {
  if (amount === null || amount === undefined || amount === "") return "Not set";
  const formatted = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(Number(amount));
  return `${formatted} / ${frequency === "daily" ? "day" : "month"}`;
}

function statusLabel(status) {
  return ({ active: "Active", inactive: "Inactive", on_leave: "On leave", relieved: "Relieved" })[status] || status;
}

function rowMatchesFilters(guard, search, filters) {
  const query = search.trim().toLowerCase();
  const matchesQuery = !query || [guard.full_name, guard.phone, guard.email, guard.designation, guard.status, guard.site_title, guard.salary_notes]
    .some(value => String(value ?? "").toLowerCase().includes(query));
  return matchesQuery
    && (!filters.status || guard.status === filters.status)
    && (!filters.designation || guard.designation === filters.designation)
    && (!filters.site_id || (guard.site_records || []).some(site => String(site.id) === filters.site_id));
}

function exportRows(guards, sites) {
  const siteNames = new Map(sites.map(site => [String(site.id), site.title]));
  return guards.map(guard => ({
    employee_code: guard.employee_code,
    full_name: guard.full_name,
    phone: guard.phone,
    email: guard.email,
    designation: guard.designation,
    status: statusLabel(guard.status),
    joining_date: guard.joining_date,
    employment_end_date: guard.employment_end_date,
    date_of_birth: guard.date_of_birth,
    residential_address: guard.residential_address,
    assigned_sites: (guard.site_records || []).map(site => siteNames.get(String(site.id)) || site.title).filter(Boolean).join("; "),
    salary_amount: guard.salary_amount,
    salary_frequency: guard.salary_frequency,
    salary_effective_date: guard.salary_effective_date,
    salary_notes: guard.salary_notes,
  }));
}

function currentDateLabel() {
  return new Date().toISOString().slice(0, 10);
}

async function fetchAllRows(table, columns = "*") {
  const rows = [];
  const pageSize = 1000;
  for (let offset = 0; offset < 1000000; offset += pageSize) {
    const { data, error } = await supabase.from(table).select(columns).order("id", { ascending: true }).range(offset, offset + pageSize - 1);
    if (error) throw new Error(error.message);
    rows.push(...(data || []));
    if (!data || data.length < pageSize) break;
  }
  return rows;
}

export default function GuardManagement({ items = [], sites = [], search = "", onSearchChange, onRefresh, onMetricsRefresh }) {
  const [filters, setFilters] = useState({ status: "", designation: "", site_id: "" });
  const [recordFilter, setRecordFilter] = useState("all");
  const [form, setForm] = useState(initialForm);
  const [editingId, setEditingId] = useState(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [importFile, setImportFile] = useState(null);
  const [preview, setPreview] = useState([]);
  const [importResult, setImportResult] = useState(null);
  const [photoFile, setPhotoFile] = useState(null);
  const [compensation, setCompensation] = useState([]);
  const [signedPhotos, setSignedPhotos] = useState({});

  useEffect(() => {
    let active = true;
    async function loadPrivateProfiles() {
      const [salaryResult, ...photoResults] = await Promise.all([
        supabase.from("employee_compensation").select("*").eq("employee_type", "guard").order("effective_from", { ascending: false }),
        ...items.filter(guard => guard.photo_storage_path).map(async guard => {
          const { data, error } = await supabase.storage.from(employeeBucket).createSignedUrl(guard.photo_storage_path, 600);
          return [guard.id, error ? "" : data?.signedUrl || ""];
        }),
      ]);
      if (!active) return;
      if (!salaryResult.error) setCompensation(salaryResult.data || []);
      setSignedPhotos(Object.fromEntries(photoResults));
    }
    loadPrivateProfiles();
    return () => { active = false; };
  }, [items]);

  const compensationByGuard = useMemo(() => {
    const result = new Map();
    for (const row of compensation) if (row.guard_id != null && !result.has(String(row.guard_id))) result.set(String(row.guard_id), row);
    return result;
  }, [compensation]);

  const visibleItems = useMemo(() => items.filter(item => matchesRecordState("guards", item, recordFilter) && rowMatchesFilters(item, search, filters)), [items, search, filters, recordFilter]);
  const designations = useMemo(() => [...new Set(items.map(item => item.designation).filter(Boolean))].sort((a, b) => a.localeCompare(b)), [items]);
  const counts = useMemo(() => ({
    total: items.length,
    active: items.filter(item => item.status === "active").length,
    on_leave: items.filter(item => item.status === "on_leave").length,
    inactive: items.filter(item => item.status === "inactive").length,
    relieved: items.filter(item => item.status === "relieved").length,
  }), [items]);

  function resetForm() {
    setForm(initialForm);
    setEditingId(null);
    setPhotoFile(null);
  }

  function startEditing(item) {
    setEditingId(item.id);
    setForm({
      employee_code: item.employee_code || "", full_name: item.full_name || "", phone: item.phone || "", email: item.email || "",
      designation: item.designation || "Security Guard", status: item.status || "active",
      joining_date: item.joining_date || "", employment_end_date: item.employment_end_date || "", date_of_birth: item.date_of_birth || "",
      residential_address: item.residential_address || "", photo_storage_path: item.photo_storage_path || "",
      site_ids: (item.site_records || []).map(site => String(site.id)),
      salary_amount: item.salary_amount ?? "", salary_frequency: item.salary_frequency || "monthly",
      salary_effective_date: item.salary_effective_date || "", salary_notes: item.salary_notes || "",
    });
    setPhotoFile(null);
    setMessage("");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function saveGuard(event) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    let uploadedPath = "";
    let saved = false;
    try {
      const wasEditing = Boolean(editingId);
      const normalized = normalizeGuardRow({
        "Full Name": form.full_name,
        Phone: form.phone,
        Email: form.email,
        Designation: form.designation,
        Status: form.status,
        "Joining Date": form.joining_date,
        "Assigned Site": "",
        "Salary Amount": form.salary_amount,
        "Salary Frequency": form.salary_frequency,
        "Salary Effective Date": form.salary_effective_date,
        "Salary Notes": form.salary_notes,
      });
      let photoPath = form.photo_storage_path;
      if (photoFile) {
        if (!new Set(["image/jpeg", "image/png", "image/webp"]).has(photoFile.type) || photoFile.size > 5 * 1024 * 1024) throw new Error("Choose a JPEG, PNG, or WebP photo no larger than 5 MB.");
        const safeName = photoFile.name.replace(/[^A-Za-z0-9._-]+/g, "-").slice(-100) || "guard-photo";
        uploadedPath = `${crypto.randomUUID()}/${safeName}`;
        setUploadingPhoto(true);
        try {
          const uploadResult = await supabase.storage.from(employeeBucket).upload(uploadedPath, photoFile, { upsert: false, contentType: photoFile.type, cacheControl: "3600" });
          if (uploadResult.error) throw new Error(`Private photo upload failed: ${uploadResult.error.message}`);
        } finally { setUploadingPhoto(false); }
        photoPath = uploadedPath;
      }
      const person = {
        employee_code: form.employee_code.trim(),
        full_name: normalized.full_name,
        phone: normalized.phone,
        email: normalized.email,
        designation: normalized.designation,
        status: normalized.status,
        joining_date: normalized.joining_date,
        employment_end_date: form.employment_end_date || null,
        date_of_birth: form.date_of_birth || null,
        residential_address: form.residential_address.trim(),
        photo_storage_path: photoPath,
        salary_amount: normalized.salary_amount,
        salary_frequency: normalized.salary_frequency,
        salary_effective_date: normalized.salary_effective_date,
        salary_notes: normalized.salary_notes,
      };
      await postGuard({ action: "save", guard_id: editingId, person, site_ids: form.site_ids.map(Number) });
      saved = true;
      const previousPhotoPath = items.find(item => item.id === editingId)?.photo_storage_path;
      // Replaced private photos are queued by the database; never removed inline.
      resetForm();
      await onRefresh();
      await onMetricsRefresh();
      setMessage(wasEditing ? "Guard record and site assignments updated." : "Guard record added.");
    } catch (error) {
      setMessage(`Save failed: ${error.message}`);
    } finally {
      setUploadingPhoto(false);
      const orphanMessage = uploadedPath && !saved ? await queueOrphan(employeeBucket, uploadedPath) : "";
      if (uploadedPath && !saved) setMessage(previous => previous + " " + orphanMessage);
      setBusy(false);
    }
  }


  async function handleImportFile(file) {
    setImportFile(file || null);
    setPreview([]);
    setImportResult(null);
    setMessage("");
    if (!file) return;
    try {
      if (file.size > MAX_GUARD_IMPORT_BYTES) throw new Error("The file must be 5 MB or smaller.");
      const rawRows = await parseGuardImportFile(file);
      setPreview(previewGuardImportRows(rawRows, { existingGuards: items, sites }));
    } catch (error) {
      setMessage(`Import preview failed: ${error.message}`);
      setImportFile(null);
    }
  }

  async function confirmImport() {
    if (!importFile || preview.length === 0) return;
    setBusy(true);
    setMessage("");
    setImportResult(null);
    try {
      const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
      const accessToken = sessionData?.session?.access_token;
      if (sessionError || !accessToken) throw new Error("Your admin session has expired. Sign in again and retry.");
      const response = await fetch(apiUrl("/api/guards/import"), {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ rows: preview.map(row => ({ rowNumber: row.rowNumber, fields: row.raw })) }),
      });
      const result = await readApiResponse(response);
      setImportResult(result);
      setMessage(`Import complete: ${result.inserted} inserted, ${result.skipped} skipped, ${result.failed} failed.`);
      await onRefresh();
      await onMetricsRefresh();
    } catch (error) {
      setMessage(`Import failed: ${error.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function doExport(scope, format) {
    setBusy(true);
    setMessage("");
    try {
      const [guardRecords, siteRecords] = await Promise.all([
        fetchAllRows("guards"),
        fetchAllRows("sites", "id,title"),
      ]);
      const { data: assignmentRows, error: assignmentError } = await supabase.from("guard_site_assignments").select("guard_id,site_id,valid_to");
      if (assignmentError) throw new Error(assignmentError.message);
      const sitesById = new Map(siteRecords.map(site => [String(site.id), site.title]));
      let records = guardRecords.map(guard => ({ ...guard,
        site_records: assignmentRows.filter(row => row.guard_id === guard.id && !row.valid_to).map(row => ({ id: row.site_id, title: sitesById.get(String(row.site_id)) || "" })),
      }));
      if (scope === "filtered") records = records.filter(guard => rowMatchesFilters(guard, search, filters));
      if (!records.length) {
        setMessage(scope === "filtered" ? "There are no matching guard records to export." : "There are no guard records to export.");
        return;
      }
      const output = exportRows(records, siteRecords);
      const stem = `golconda-guard-records-${currentDateLabel()}${scope === "filtered" ? "-filtered" : ""}`;
      if (format === "csv") downloadFile(guardRecordsToCsv(output), `${stem}.csv`, "text/csv;charset=utf-8");
      else downloadFile(await guardRecordsToXlsx(output), `${stem}.xlsx`, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      setMessage(`${records.length} current database record${records.length === 1 ? "" : "s"} exported.`);
    } catch (error) {
      setMessage(`Export failed: ${error.message}`);
    } finally {
      setBusy(false);
    }
  }

  const readyCount = preview.filter(row => row.state === "ready").length;
  const skipCount = preview.filter(row => row.state === "skipped").length;
  const invalidCount = preview.filter(row => row.state === "invalid").length;

  return <div className="gss-guard-module">
    <div className="guard-count-grid" aria-label="Guard status counts">
      {[['Total', counts.total], ['Active', counts.active], ['On leave', counts.on_leave], ['Inactive', counts.inactive], ['Relieved', counts.relieved]].map(([label, count]) => <div key={label}><small>{label}</small><strong>{count}</strong></div>)}
    </div>

    <form className="gss-admin-form" onSubmit={saveGuard}>
      <h3>{editingId ? "Edit guard details" : "Add a guard"}</h3>
      <label>Employee code<input maxLength="64" pattern="[A-Za-z0-9_-]*" value={form.employee_code} onChange={event => setForm({ ...form, employee_code: event.target.value.toUpperCase() })} placeholder="Assigned automatically if blank"/></label>
      <label>Full Name<input required maxLength="120" value={form.full_name} onChange={event => setForm({ ...form, full_name: event.target.value })}/></label>
      <label>Phone Number<input required maxLength="24" inputMode="tel" value={form.phone} onChange={event => setForm({ ...form, phone: event.target.value })}/></label>
      <label>Email (optional)<input type="email" maxLength="254" value={form.email} onChange={event => setForm({ ...form, email: event.target.value })}/></label>
      <label>Designation<input maxLength="100" value={form.designation} onChange={event => setForm({ ...form, designation: event.target.value })}/></label>
      <label>Status<select value={form.status} onChange={event => setForm({ ...form, status: event.target.value })}><option value="active">Active</option><option value="inactive">Inactive</option><option value="on_leave">On leave</option><option value="relieved">Relieved</option></select></label>
      <label>Joining Date<input type="date" value={form.joining_date} onChange={event => setForm({ ...form, joining_date: event.target.value })}/></label>
      <label>Employment End Date<input type="date" value={form.employment_end_date} onChange={event => setForm({ ...form, employment_end_date: event.target.value })}/></label>
      <label>Date of Birth (optional)<input type="date" value={form.date_of_birth} onChange={event => setForm({ ...form, date_of_birth: event.target.value })}/></label>
      <label className="full">Residential Address (optional)<textarea rows="2" maxLength="1000" value={form.residential_address} onChange={event => setForm({ ...form, residential_address: event.target.value })}/></label>
      <label className="full">Private profile photo<input type="file" accept="image/jpeg,image/png,image/webp" onChange={event => setPhotoFile(event.target.files?.[0] || null)}/><small>{photoFile?.name || (form.photo_storage_path ? "A private photo is already saved." : "No photo stored.")} · JPEG, PNG, WebP · maximum 5 MB</small></label>
      {uploadingPhoto && <div className="file-upload-progress full" role="status"><progress aria-label="Uploading private guard photo"/><span>Uploading private photo… Keep this page open until it finishes.</span></div>}
      <fieldset className="guard-site-checks"><legend>Assigned sites ({form.site_ids.length})</legend><div>{sites.filter(site => site.status !== "inactive").map(site => <label key={site.id}><input type="checkbox" checked={form.site_ids.includes(String(site.id))} onChange={() => setForm({ ...form, site_ids: form.site_ids.includes(String(site.id)) ? form.site_ids.filter(id => id !== String(site.id)) : [...form.site_ids, String(site.id)] })}/><span>{site.title}<small>{site.site_code || ""}</small></span></label>)}</div></fieldset>
      <div className="guard-salary-divider"><strong>Salary and assignment</strong><span>Visible to authorized administrators only. Daily rates are profile-only; monthly estimates require a monthly gross amount because attendance is not tracked.</span></div>
      <label>Salary Amount (₹)<input type="number" min="0" max="100000000" step="0.01" value={form.salary_amount} onChange={event => setForm({ ...form, salary_amount: event.target.value })} placeholder="Optional"/></label>
      <label>Salary Frequency<select value={form.salary_frequency} onChange={event => setForm({ ...form, salary_frequency: event.target.value })}><option value="monthly">Monthly</option><option value="daily">Daily</option></select></label>
      <label>Salary Effective Date<input type="date" value={form.salary_effective_date} onChange={event => setForm({ ...form, salary_effective_date: event.target.value })}/></label>
      <label className="full">Private Salary Notes<textarea rows="2" maxLength="1000" value={form.salary_notes} onChange={event => setForm({ ...form, salary_notes: event.target.value })}/></label>
      <div className="gss-admin-form-actions"><button className="gss-admin-primary" type="submit" disabled={busy}><Plus size={16}/>{editingId ? "Save Guard" : "Add Guard"}</button>{editingId && <button className="gss-admin-secondary" type="button" onClick={resetForm}><X size={15}/> Cancel</button>}</div>
    </form>

    <section className="guard-import-panel" aria-labelledby="guard-import-heading">
      <div className="guard-module-heading"><div><h3 id="guard-import-heading">Import guard records</h3><p>Upload CSV or Excel .xlsx. File size limit: 5 MB; up to 500 rows per import.</p></div><a className="gss-admin-secondary" href={`data:text/csv;charset=utf-8,${encodeURIComponent('Employee Code,Full Name,Phone,Email,Designation,Status,Joining Date,Employment End Date,Date of Birth,Residential Address,Assigned Sites,Salary Amount (INR),Salary Frequency,Salary Effective Date,Salary Notes\r\n')}`} download="golconda-guards-import-template.csv"><Download size={15}/> Template CSV</a></div>
      <label className="guard-file-input"><Upload size={18}/><span>{importFile ? importFile.name : "Choose a .csv or .xlsx file"}</span><input type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={event => handleImportFile(event.target.files?.[0])}/></label>
      <p className="guard-import-help">Required: Full Name and Phone. Optional: Employee Code, Email, Designation, Status, Joining/End Date, Date of Birth, Residential Address, Salary fields, and Assigned Sites. Separate multiple site names or codes with semicolons.</p>
      <p className="guard-import-help">Only .xlsx and .csv are accepted; formulas are never evaluated. Duplicate phone numbers are skipped. Existing records are never overwritten.</p>
      {preview.length > 0 && <>
        <div className="guard-preview-summary"><strong>Preview:</strong> {readyCount} ready · {skipCount} duplicate/skipped · {invalidCount} invalid</div>
        <div className="guard-preview-scroll"><table className="guard-preview-table"><thead><tr><th>Row</th><th>Name</th><th>Phone</th><th>Designation</th><th>Sites</th><th>Status</th><th>Validation</th></tr></thead><tbody>
          {preview.map(row => <tr key={row.rowNumber}><td>{row.rowNumber}</td><td>{row.record?.full_name || row.raw["Full Name"] || row.raw["full_name"] || "—"}</td><td>{row.record?.phone || row.raw.Phone || row.raw["Phone Number"] || "—"}</td><td>{row.record?.designation || "—"}</td><td>{row.record?.assigned_sites?.join(", ") || "Unassigned"}</td><td>{row.record ? statusLabel(row.record.status) : "—"}</td><td className={`guard-row-${row.state}`}>{row.message}</td></tr>)}
        </tbody></table></div>
        <div className="guard-import-actions"><button type="button" className="gss-admin-secondary" onClick={() => { setImportFile(null); setPreview([]); setImportResult(null); }} disabled={busy}><X size={15}/> Cancel import</button><button type="button" className="gss-admin-primary" onClick={confirmImport} disabled={busy || preview.length === 0}><Upload size={15}/> Confirm import</button></div>
      </>}
      {importResult && <div className="guard-import-result"><strong>Import result:</strong> {importResult.inserted} inserted, {importResult.skipped} skipped, {importResult.failed} failed. See row details above.</div>}
      {importResult?.rows?.length > 0 && <div className="guard-result-rows">{importResult.rows.filter(row => row.status !== "inserted").map(row => <p key={`${row.row}-${row.status}`} className={`guard-row-${row.status}`}><b>Row {row.row}:</b> {row.message}</p>)}</div>}
    </section>

    <section className="guard-export-panel" aria-labelledby="guard-export-heading">
      <div className="guard-module-heading"><div><h3 id="guard-export-heading">Export live guard records</h3><p>Exports fetch the current records from Supabase. Filtered exports use the search and filters below.</p></div></div>
      <div className="guard-export-actions">
        <button className="gss-admin-secondary" type="button" disabled={busy} onClick={() => doExport("all", "csv")}><FileText size={15}/> All · CSV</button>
        <button className="gss-admin-secondary" type="button" disabled={busy} onClick={() => doExport("all", "xlsx")}><FileSpreadsheet size={15}/> All · Excel</button>
        <button className="gss-admin-secondary" type="button" disabled={busy} onClick={() => doExport("filtered", "csv")}><FileText size={15}/> Filtered · CSV</button>
        <button className="gss-admin-secondary" type="button" disabled={busy} onClick={() => doExport("filtered", "xlsx")}><FileSpreadsheet size={15}/> Filtered · Excel</button>
      </div>
    </section>

    {message && <p className="gss-admin-message" role="status">{message}</p>}
    <div className="guard-list-toolbar"><div className="guard-module-heading"><div><h3>Guard directory</h3><p>{visibleItems.length} shown · {items.length} total</p></div><button type="button" className="gss-admin-secondary" onClick={onRefresh} disabled={busy}><RefreshCw size={15}/> Refresh from database</button></div>
      <RecordFilter value={recordFilter} onChange={setRecordFilter}/><div className="guard-filters"><input className="gss-admin-search" type="search" value={search} onChange={event => onSearchChange(event.target.value)} placeholder="Search name, phone, designation, site" aria-label="Search guards"/><select value={filters.status} onChange={event => setFilters({ ...filters, status: event.target.value })} aria-label="Filter by guard status"><option value="">All statuses</option><option value="active">Active</option><option value="inactive">Inactive</option><option value="on_leave">On leave</option><option value="relieved">Relieved</option></select><select value={filters.designation} onChange={event => setFilters({ ...filters, designation: event.target.value })} aria-label="Filter by designation"><option value="">All designations</option>{designations.map(value => <option key={value}>{value}</option>)}</select><select value={filters.site_id} onChange={event => setFilters({ ...filters, site_id: event.target.value })} aria-label="Filter by assigned site"><option value="">All sites</option>{sites.filter(site => !site.archived_at && site.status !== "inactive").map(site => <option key={site.id} value={site.id}>{site.title}</option>)}</select></div>
    </div>
    {visibleItems.length === 0 ? <p className="gss-admin-empty">No guards match the selected filters.</p> : <div className="gss-admin-items">{visibleItems.map(item => {
      const currentSalary = compensationByGuard.get(String(item.id));
      return <article className="gss-admin-item" key={item.id}>
        <div className="gss-admin-item-copy"><div className="people-name-line">{signedPhotos[item.id] ? <img className="guard-profile-photo" src={signedPhotos[item.id]} alt={`${item.full_name} private profile`}/> : <span className="guard-profile-photo-empty"><Camera size={17}/></span>}<strong>{item.full_name}</strong><span className={`people-status ${item.status}`}>{statusLabel(item.status)}</span></div><p>{item.employee_code || "No employee code"} · {item.designation}</p><div className="site-details"><span><b>Phone:</b> {item.phone}</span><span><b>Email:</b> {item.email || "—"}</span><span><b>Sites:</b> {item.site_records?.map(site => site.title).join(", ") || "Unassigned"}</span><span><b>Joined:</b> {item.joining_date || "—"}</span><span><b>End date:</b> {item.employment_end_date || "—"}</span>{item.date_of_birth && <span><b>Date of birth:</b> {item.date_of_birth}</span>}{item.residential_address && <span><b>Address:</b> {item.residential_address}</span>}</div><div className="site-details guard-private-details"><span><b>Configured pay:</b> {formatSalary(item.salary_amount, item.salary_frequency)}</span><span><b>Payroll monthly gross:</b> {currentSalary ? formatSalary(currentSalary.gross_monthly_salary, "monthly") : "Not configured"}</span><span><b>Effective:</b> {currentSalary?.effective_from || item.salary_effective_date || "—"}</span>{item.salary_notes && <span><b>Private notes:</b> {item.salary_notes}</span>}</div><small>{item.created_at ? `Added: ${new Date(item.created_at).toLocaleDateString()}` : ""}</small></div>
        <div className="gss-admin-item-actions"><button type="button" disabled={Boolean(item.archived_at)} onClick={() => startEditing(item)} aria-label={`Edit ${item.full_name}`}><Pencil size={15}/> Edit</button><RecordActions module={"guards"} item={item} onChanged={async () => { await onRefresh(); await onMetricsRefresh(); }} onEditingDeleted={() => { if (editingId === item.id) resetForm(); }}/></div>
      </article>;
    })}</div>}
  </div>;
}
