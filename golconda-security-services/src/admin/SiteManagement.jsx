import React, { useMemo, useState } from "react";
import { ArrowDownToLine, Building2, Check, FileSpreadsheet, Pencil, Plus, RefreshCw, Trash2, Upload, X } from "lucide-react";
import { apiUrl } from "../api.js";
import { downloadFile } from "../guardSpreadsheet.js";
import { parseSiteImportFile, previewSiteImportRows, siteImportTemplateCsv, siteRecordsToCsv } from "../siteSpreadsheet.js";
import { supabase } from "../supabase.js";
import "./siteManagement.css";

const emptyForm = {
  site_code: "", title: "", status: "active", service_taken: "SECURITY GUARD", phone_numbers: "", given_emails: "",
  total_salary: "", security_guard_monthly_billing: "", aso_monthly_billing: "", payroll_effective_date: "",
  esi_applicable: "", esi_contribution_rate: "", pf_applicable: "", pf_contribution_rate: "", payroll_notes: "",
  guard_ids: [], supervisor_ids: [], field_officer_ids: [],
};

function idsFor(records = []) { return records.filter(record => record?.id).map(record => String(record.id)); }

async function apiPost(path, body) {
  const { data, error } = await supabase.auth.getSession();
  if (error || !data.session?.access_token) throw new Error("Sign in again to continue this administrator action.");
  const response = await fetch(apiUrl(path), {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${data.session.access_token}` },
    body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const details = result.details?.rows?.map(row => `Row ${row.row}: ${row.message}`).join(" ")
      || result.details?.matches?.map(match => `${match.site_code}: ${match.message}`).join(" ");
    throw new Error([result.error || "The request failed.", details].filter(Boolean).join(" "));
  }
  return result;
}

function AssignmentChecks({ title, options, value, onChange, label }) {
  const ids = new Set(value);
  function toggle(id) {
    onChange(ids.has(String(id)) ? value.filter(item => item !== String(id)) : [...value, String(id)]);
  }
  return <fieldset className="site-assignment-group">
    <legend>{title} <span>({value.length} assigned)</span></legend>
    {options.length ? <div className="site-assignment-options">{options.map(person => <label key={person.id}>
      <input type="checkbox" checked={ids.has(String(person.id))} onChange={() => toggle(person.id)}/>
      <span><b>{person.full_name}</b><small>{person.employee_code || person.phone || label}</small></span>
    </label>)}</div> : <p className="site-import-empty">No {label.toLowerCase()} records yet. Add them in their own dashboard section first.</p>}
  </fieldset>;
}

export default function SiteManagement({ items = [], guards = [], supervisors = [], fieldOfficers = [], onRefresh, onMetricsRefresh }) {
  const [form, setForm] = useState(emptyForm);
  const [editingId, setEditingId] = useState(null);
  const [search, setSearch] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [selectedFile, setSelectedFile] = useState(null);
  const [preview, setPreview] = useState(null);

  const visibleSites = useMemo(() => items.filter(site => `${site.site_code || ""} ${site.title || ""} ${site.service_taken || ""}`.toLowerCase().includes(search.toLowerCase())), [items, search]);
  const previewCounts = preview?.sites.reduce((counts, site) => ({ ...counts, [site.state]: counts[site.state] + 1 }), { create: 0, update: 0 }) || { create: 0, update: 0 };

  function resetForm() { setForm(emptyForm); setEditingId(null); }

  function editSite(site) {
    setEditingId(site.id);
    setForm({
      ...emptyForm,
      site_code: site.site_code || "", title: site.title || "", status: site.status || "active",
      service_taken: String(site.service_taken || "SECURITY GUARD").toUpperCase(),
      phone_numbers: site.phone_numbers || "", given_emails: site.given_emails || "", total_salary: site.total_salary || "",
      security_guard_monthly_billing: site.security_guard_monthly_billing ?? "", aso_monthly_billing: site.aso_monthly_billing ?? "",
      payroll_effective_date: site.payroll_effective_date || "", esi_applicable: site.esi_applicable === null ? "" : String(site.esi_applicable),
      esi_contribution_rate: site.esi_contribution_rate ?? "", pf_applicable: site.pf_applicable === null ? "" : String(site.pf_applicable),
      pf_contribution_rate: site.pf_contribution_rate ?? "", payroll_notes: site.payroll_notes || "",
      guard_ids: idsFor(site.guard_records), supervisor_ids: idsFor(site.supervisor_records), field_officer_ids: idsFor(site.field_officer_records),
    });
    setMessage("");
    document.getElementById("site-editor-heading")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async function saveSite(event) {
    event.preventDefault();
    setBusy(true); setMessage("");
    try {
      const result = await apiPost("/api/operations/sites", {
        action: "save", site_id: editingId, site: form, guard_ids: form.guard_ids.map(Number),
        supervisor_ids: form.supervisor_ids.map(Number), field_officer_ids: form.field_officer_ids.map(Number),
      });
      resetForm();
      await onRefresh(); await onMetricsRefresh();
      setMessage(`Site and assignments saved (site ${result.site_id}).`);
    } catch (error) { setMessage(error.message); }
    finally { setBusy(false); }
  }

  async function deleteSite(site) {
    if (!window.confirm(`Delete ${site.title}? A site with active or historical assignments, or financial records, must be deactivated instead.`)) return;
    setBusy(true); setMessage("");
    try {
      await apiPost("/api/operations/sites", { action: "delete", site_id: site.id });
      if (editingId === site.id) resetForm();
      await onRefresh(); await onMetricsRefresh();
      setMessage("Site deleted.");
    } catch (error) { setMessage(error.message); }
    finally { setBusy(false); }
  }

  async function readSelectedFile(file) {
    setSelectedFile(file || null); setPreview(null); setMessage("");
    if (!file) return;
    try {
      const rows = await parseSiteImportFile(file);
      const next = previewSiteImportRows(rows, items);
      setPreview({ ...next, rows });
      setMessage(next.errors.length ? `${next.errors.length} row(s) need correction. Nothing can be imported until the file is valid.` : "Preview ready. Repeated site codes will update that site; employee matching uses employee type and phone number.");
    } catch (error) { setMessage(error.message); }
  }

  async function importSites() {
    if (!preview || preview.errors.length) return;
    setBusy(true); setMessage("");
    try {
      const payload = JSON.stringify({ rows: preview.sites });
      if (new TextEncoder().encode(payload).byteLength > 3.75 * 1024 * 1024) throw new Error("The validated import is too large for a single safe request. Split the spreadsheet into smaller imports.");
      const result = await apiPost("/api/operations/site-import", { rows: preview.sites });
      setSelectedFile(null); setPreview(null);
      await onRefresh(); await onMetricsRefresh();
      setMessage(`Import complete: ${result.sites_created} sites created, ${result.sites_updated} sites updated; ${result.guards_created} guards created, ${result.guards_updated} updated; ${result.supervisors_created} supervisors created, ${result.supervisors_updated} updated; ${result.field_officers_created} field officers created, ${result.field_officers_updated} updated; ${result.relationships_added} assignments added.`);
    } catch (error) { setMessage(error.message); }
    finally { setBusy(false); }
  }

  return <div className="site-management">
    <form className="gss-admin-form site-editor" onSubmit={saveSite}>
      <h3 id="site-editor-heading">{editingId ? "Edit site and assignments" : "Add site and assignments"}</h3>
      <p className="site-editor-note">Site code is the stable import key. Staff can be assigned to more than one active site. Assignment changes keep dated history.</p>
      <label>Site code<input required maxLength="64" pattern="[A-Za-z0-9_-]+" value={form.site_code} onChange={event => setForm({ ...form, site_code: event.target.value.toUpperCase() })} placeholder="SITE-001"/></label>
      <label>Site name<input required maxLength="160" value={form.title} onChange={event => setForm({ ...form, title: event.target.value })} placeholder="Deployment site name"/></label>
      <label>Services taken<select value={form.service_taken} onChange={event => setForm({ ...form, service_taken: event.target.value })}><option value="SECURITY GUARD">Security Guard</option><option value="ASO">ASO</option><option value="BOTH">Both</option></select></label>
      <label>Site status<select value={form.status} onChange={event => setForm({ ...form, status: event.target.value })}><option value="active">Active</option><option value="inactive">Inactive</option></select></label>
      <label className="full">Phone numbers (up to 5, comma separated)<input maxLength="1200" value={form.phone_numbers} onChange={event => setForm({ ...form, phone_numbers: event.target.value })} placeholder="+91 90000 00000"/></label>
      <label className="full">Given emails (up to 5, comma separated)<input maxLength="1200" value={form.given_emails} onChange={event => setForm({ ...form, given_emails: event.target.value })} placeholder="site@example.com"/></label>
      <label className="full">Legacy total salary / billing (kept for compatibility)<input maxLength="120" value={form.total_salary} onChange={event => setForm({ ...form, total_salary: event.target.value })}/></label>
      <h4 className="site-form-section-title">Client billing · INR per month</h4>
      {form.service_taken !== "ASO" && <label>Security guard billing<input type="number" min="0" step="0.01" value={form.security_guard_monthly_billing} onChange={event => setForm({ ...form, security_guard_monthly_billing: event.target.value })}/></label>}
      {form.service_taken !== "SECURITY GUARD" && <label>ASO billing<input type="number" min="0" step="0.01" value={form.aso_monthly_billing} onChange={event => setForm({ ...form, aso_monthly_billing: event.target.value })}/></label>}
      <p className="site-editor-note full">These are client billing amounts, separate from employee salaries. Security Guard and ASO billing remain separate when the site takes both services.</p>
      <label>Effective date<input type="date" value={form.payroll_effective_date} onChange={event => setForm({ ...form, payroll_effective_date: event.target.value })}/></label>
      <h4 className="site-form-section-title">ESI / PF configuration</h4>
      <p className="site-editor-note full">Store only confirmed company settings. These reference values are not used to calculate payroll deductions; verify eligibility and rates with the company’s payroll adviser.</p>
      <label>ESI applicability<select value={form.esi_applicable} onChange={event => setForm({ ...form, esi_applicable: event.target.value })}><option value="">Not configured</option><option value="true">Applicable</option><option value="false">Not applicable</option></select></label>
      <label>ESI rate (%)<input type="number" min="0" max="100" step="0.0001" value={form.esi_contribution_rate} onChange={event => setForm({ ...form, esi_contribution_rate: event.target.value })}/></label>
      <label>PF applicability<select value={form.pf_applicable} onChange={event => setForm({ ...form, pf_applicable: event.target.value })}><option value="">Not configured</option><option value="true">Applicable</option><option value="false">Not applicable</option></select></label>
      <label>PF rate (%)<input type="number" min="0" max="100" step="0.0001" value={form.pf_contribution_rate} onChange={event => setForm({ ...form, pf_contribution_rate: event.target.value })}/></label>
      <label className="full">Configuration notes<input maxLength="1000" value={form.payroll_notes} onChange={event => setForm({ ...form, payroll_notes: event.target.value })} placeholder="Add confirmed policy reference or leave blank"/></label>
      <AssignmentChecks title="Guards" label="guard" options={guards} value={form.guard_ids} onChange={guard_ids => setForm({ ...form, guard_ids })}/>
      <AssignmentChecks title="Supervisors" label="supervisor" options={supervisors} value={form.supervisor_ids} onChange={supervisor_ids => setForm({ ...form, supervisor_ids })}/>
      <AssignmentChecks title="Field officers" label="field officer" options={fieldOfficers} value={form.field_officer_ids} onChange={field_officer_ids => setForm({ ...form, field_officer_ids })}/>
      <div className="gss-admin-form-actions full"><button className="gss-admin-primary" disabled={busy} type="submit">{editingId ? <Check size={15}/> : <Plus size={15}/>} {editingId ? "Save site" : "Create site"}</button>{editingId && <button className="gss-admin-secondary" type="button" onClick={resetForm}><X size={15}/> Cancel edit</button>}</div>
    </form>

    <section className="site-import-card" aria-labelledby="site-import-heading">
      <div className="site-module-heading"><div><h3 id="site-import-heading">Import sites and linked staff</h3><p>Upload CSV or Excel .xlsx (maximum 5 MB and 2,000 rows). Repeat a site code across rows to link several guards.</p></div>
        <button className="gss-admin-secondary" type="button" onClick={() => downloadFile(siteImportTemplateCsv(), "golconda-site-import-template.csv", "text/csv;charset=utf-8")}><ArrowDownToLine size={15}/> Download template</button>
      </div>
      <label className="site-import-file">Choose CSV or Excel file<input type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" disabled={busy} onChange={event => readSelectedFile(event.target.files?.[0] || null)}/></label>
      {selectedFile && <p className="site-import-file-name"><FileSpreadsheet size={15}/> {selectedFile.name}</p>}
      {preview && <div className="site-import-preview">
        <p><b>Preview:</b> {preview.sites.length} distinct site code(s) · {previewCounts.create} new · {previewCounts.update} update · {preview.errors.length} row error(s)</p>
        {preview.errors.length > 0 && <ul className="site-import-errors" role="alert">{preview.errors.map((error, index) => <li key={`${error.row}-${index}`}>Row {error.row}: {error.message}</li>)}</ul>}
        <div className="site-import-preview-list">{preview.sites.map(site => <div key={site.site_code}><span>{site.site_code} · {site.title}</span><b>{site.state === "create" ? "New" : "Update"}</b><small>{site.guards.length} guards · {site.supervisors.length} supervisors · {site.field_officers.length} field officers</small></div>)}</div>
        <button className="gss-admin-primary" type="button" disabled={busy || preview.errors.length > 0 || !preview.sites.length} onClick={importSites}><Upload size={15}/> Import all valid rows</button>
      </div>}
      <p className="site-import-help">Imports match sites by site code and staff by employee type plus phone number. Re-importing updates matched records and adds missing site assignments; it never deletes existing records or assignments. No matches are made from names alone.</p>
    </section>

    {message && <p className="gss-admin-message" role="status">{message}</p>}
    <div className="gss-admin-list-heading"><h3>Sites & deployments · {items.length}</h3><div className="site-list-controls"><input className="gss-admin-search" type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Search code, site or service" aria-label="Search sites"/><button className="gss-admin-secondary" type="button" onClick={onRefresh}><RefreshCw size={15}/> Refresh</button><button className="gss-admin-secondary" type="button" onClick={() => downloadFile(siteRecordsToCsv(items), "golconda-sites.csv", "text/csv;charset=utf-8")}><ArrowDownToLine size={15}/> Export CSV</button></div></div>
    {!visibleSites.length ? <p className="gss-admin-empty">No sites match your search.</p> : <div className="gss-admin-items site-card-list">{visibleSites.map(site => <article className="gss-admin-item" key={site.id}>
      <div className="gss-admin-item-copy"><div className="site-title-line"><Building2 size={17}/><strong>{site.title}</strong><span className={`site-status ${site.status || "active"}`}>{site.status || "active"}</span></div>
        <p>{site.site_code || "No site code"} · {site.service_taken || "Service unspecified"}</p>
        <div className="site-details"><span><b>Phones:</b> {site.phone_numbers || "None"}</span><span><b>Emails:</b> {site.given_emails || "None"}</span><span><b>Guard billing:</b> {site.security_guard_monthly_billing == null ? "Not configured" : `₹${Number(site.security_guard_monthly_billing).toLocaleString("en-IN")}`}</span><span><b>ASO billing:</b> {site.aso_monthly_billing == null ? "Not configured" : `₹${Number(site.aso_monthly_billing).toLocaleString("en-IN")}`}</span>
          <span><b>Guards:</b> {site.guard_records?.map(person => `${person.full_name} (${person.status})`).join(", ") || "None"}</span><span><b>Supervisors:</b> {site.supervisor_records?.map(person => person.full_name).join(", ") || "None"}</span><span><b>Field officers:</b> {site.field_officer_records?.map(person => person.full_name).join(", ") || "None"}</span>
        </div>
      </div>
      <div className="gss-admin-item-actions"><button type="button" onClick={() => editSite(site)}><Pencil size={15}/> Edit</button><button type="button" className="danger" disabled={busy} onClick={() => deleteSite(site)}><Trash2 size={15}/> Delete</button></div>
    </article>)}</div>}
  </div>;
}
