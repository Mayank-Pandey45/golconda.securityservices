import RecordActions, { RecordFilter } from "./RecordActions.jsx";
import LifecycleDialog from "./LifecycleDialog.jsx";
import { matchesRecordState } from "../../shared/recordLifecycle.js";
import { queueOrphan } from "./recordClient.js";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDownToLine, Camera, Check, Pencil, Plus, RefreshCw, X } from "lucide-react";
import { apiUrl, readApiResponse } from "../api.js";
import { downloadFile } from "../guardSpreadsheet.js";
import { supabase } from "../supabase.js";
import EmployeeIdentityFields from "./EmployeeIdentityFields.jsx";
import "./peopleManagement.css";

const BUCKET = "employee-private";
const EMPTY_ROWS = [];
const initialForm = {
  employee_code: "", full_name: "", phone: "", email: "", designation: "", status: "active", joining_date: "", employment_end_date: "",
  date_of_birth: "", residential_address: "", photo_storage_path: "", gross_monthly_salary: "", salary_effective_from: "",
  salary_notes: "", esi_applicable: "", esi_contribution_rate: "", pf_applicable: "", pf_contribution_rate: "", site_ids: [], reporting_ids: [],
};

async function postPeople(body) {
  const { data, error } = await supabase.auth.getSession();
  if (error || !data.session?.access_token) throw new Error("Sign in again to continue this administrator action.");
  const response = await fetch(apiUrl("/api/operations/people"), {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${data.session.access_token}` }, body: JSON.stringify(body),
  });
  const result = await readApiResponse(response);
  return result;
}

function exportPeople(items, type) {
  const columns = [["Employee Code", "employee_code"], ["Full Name", "full_name"], ["Phone", "phone"], ["Email", "email"], ["Designation", "designation"], ["Status", "status"], ["Joining Date", "joining_date"], ["Assigned Sites", "sites"], ["Current Gross Monthly Salary (INR)", "salary"]];
  const escape = value => {
    const raw = value === null || value === undefined ? "" : String(value);
    const safe = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
    return `"${safe.replace(/"/g, '""')}"`;
  };
  const records = items.map(item => ({
    ...item,
    sites: (item.site_records || []).map(site => site.title).join("; "),
    salary: item.current_compensation?.gross_monthly_salary ?? "",
  }));
  downloadFile(`\uFEFF${[columns.map(([header]) => header), ...records.map(record => columns.map(([, key]) => record[key] ?? ""))].map(row => row.map(escape).join(",")).join("\r\n")}`, `golconda-${type.replace("_", "-")}.csv`, "text/csv;charset=utf-8");
}

function CheckList({ title, options, selected, onChange, hint }) {
  const selectedSet = new Set(selected);
  return <fieldset className="people-assignment-group">
    <legend>{title} <span>({selected.length})</span></legend>
    {hint && <p>{hint}</p>}
    {options.length ? <div className="people-check-list">{options.map(option => <label key={option.id}>
      <input type="checkbox" checked={selectedSet.has(String(option.id))} onChange={() => onChange(selectedSet.has(String(option.id)) ? selected.filter(id => id !== String(option.id)) : [...selected, String(option.id)])}/>
      <span><b>{option.full_name || option.title}</b><small>{option.employee_code || option.site_code || option.phone}</small></span>
    </label>)}</div> : <small>No records available to assign.</small>}
  </fieldset>;
}

export default function PeopleManagement({ employeeType, items = EMPTY_ROWS, sites = EMPTY_ROWS, guards = EMPTY_ROWS, onRefresh, onMetricsRefresh }) {
  const isSupervisor = employeeType === "supervisor";
  const [recordFilter, setRecordFilter] = useState("all");
  const recordModule = isSupervisor ? "supervisors" : "fieldOfficers";
  const title = isSupervisor ? "Supervisors" : "Field Officers";
  const otherType = isSupervisor ? "field_officer" : "supervisor";
  const relationTable = "supervisor_reporting";
  const [form, setForm] = useState(initialForm);
  const [editingId, setEditingId] = useState(null);
  const [photoFile, setPhotoFile] = useState(null);
  const [filters, setFilters] = useState({ search: "", status: "" });
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [compensation, setCompensation] = useState([]);
  const [reporting, setReporting] = useState([]);
  const [allGuards, setAllGuards] = useState(guards);
  const [otherPeople, setOtherPeople] = useState([]);
  const [signedPhotos, setSignedPhotos] = useState({});
  const [exitTarget, setExitTarget] = useState(null);
  const identityRef = useRef(null);

  useEffect(() => {
    let active = true;
    async function loadRelations() {
      const peopleTable = isSupervisor ? "field_officers" : "supervisors";
      const guardQuery = guards.length ? Promise.resolve({ data: guards, error: null }) : supabase.from("guards").select("id,full_name,employee_code,status,archived_at").order("full_name");
      const [comp, rel, other, guardRecords, guardAssignments] = await Promise.all([
        supabase.from("employee_compensation").select("*").order("effective_from", { ascending: false }),
        supabase.from(relationTable).select("id,supervisor_id,field_officer_id,valid_from,valid_to"),
        supabase.from(peopleTable).select("id,full_name,employee_code,phone,status,archived_at").order("full_name"),
        guardQuery,
        supabase.from("guard_site_assignments").select("guard_id,site_id,valid_to"),
      ]);
      if (!active) return;
      const error = comp.error || rel.error || other.error || guardRecords.error || guardAssignments.error;
      if (error) { setMessage(`Employee relationships could not be loaded: ${error.message}`); return; }
      setCompensation(comp.data || []);
      setReporting(rel.data || []);
      setOtherPeople(other.data || []);
      setAllGuards((guardRecords.data || []).map(guard => ({
        ...guard,
        site_ids: guardAssignments.data.filter(row => row.guard_id === guard.id && !row.valid_to).map(row => String(row.site_id)),
      })));
    }
    loadRelations();
    return () => { active = false; };
  }, [employeeType, items, guards]);

  useEffect(() => {
    let active = true;
    async function loadPhotos() {
      const entries = await Promise.all(items.filter(item => item.photo_storage_path).map(async item => {
        const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(item.photo_storage_path, 600);
        return [item.id, error ? "" : data?.signedUrl || ""];
      }));
      if (active) setSignedPhotos(Object.fromEntries(entries));
    }
    loadPhotos();
    return () => { active = false; };
  }, [items]);

  const compensationByPerson = useMemo(() => {
    const key = isSupervisor ? "supervisor_id" : "field_officer_id";
    const records = new Map();
    for (const row of compensation) {
      if (row[key] != null && !records.has(String(row[key]))) records.set(String(row[key]), row);
    }
    return records;
  }, [compensation, isSupervisor]);

  const records = useMemo(() => items.map(person => {
    const salary = compensationByPerson.get(String(person.id));
    const relationRecords = reporting.filter(row => !row.valid_to && (isSupervisor ? row.supervisor_id === person.id : row.field_officer_id === person.id));
    const relationIds = relationRecords.map(row => String(isSupervisor ? row.field_officer_id : row.supervisor_id));
    const relationships = relationIds.map(id => otherPeople.find(other => String(other.id) === id)).filter(Boolean);
    const siteIds = new Set((person.site_records || []).map(site => String(site.id)));
    const assignedGuards = allGuards.filter(guard => (guard.site_ids || []).some(id => siteIds.has(id)));
    return { ...person, current_compensation: salary || null, reporting_people: relationships, assigned_guards: assignedGuards };
  }), [items, compensationByPerson, reporting, isSupervisor, otherPeople, allGuards]);

  const visible = useMemo(() => records.filter(person => {
    if (!matchesRecordState(recordModule, person, recordFilter)) return false;
    const matchesSearch = `${person.employee_code || ""} ${person.full_name || ""} ${person.phone || ""} ${person.email || ""} ${person.site_records?.map(site => site.title).join(" ") || ""}`.toLowerCase().includes(filters.search.toLowerCase());
    return matchesSearch && (!filters.status || person.status === filters.status);
  }), [records, filters, recordFilter, recordModule]);

  function resetForm() { setForm(initialForm); setPhotoFile(null); setEditingId(null); identityRef.current?.reset(); }

  function editPerson(person) {
    const current = person.current_compensation || compensationByPerson.get(String(person.id));
    const reportIds = reporting.filter(row => !row.valid_to && (isSupervisor ? row.supervisor_id === person.id : row.field_officer_id === person.id)).map(row => String(isSupervisor ? row.field_officer_id : row.supervisor_id));
    setForm({
      ...initialForm,
      employee_code: person.employee_code || "", full_name: person.full_name || "", phone: person.phone || "", email: person.email || "",
      designation: person.designation || (isSupervisor ? "Supervisor" : "Field Officer"), status: person.status || "active",
      joining_date: person.joining_date || "", employment_end_date: person.employment_end_date || "", date_of_birth: person.date_of_birth || "",
      residential_address: person.residential_address || "", photo_storage_path: person.photo_storage_path || "",
      gross_monthly_salary: current?.gross_monthly_salary ?? "", salary_effective_from: current?.effective_from || person.joining_date || "",
      salary_notes: current?.notes || "", esi_applicable: current?.esi_applicable == null ? "" : String(current.esi_applicable),
      esi_contribution_rate: current?.esi_contribution_rate ?? "", pf_applicable: current?.pf_applicable == null ? "" : String(current.pf_applicable),
      pf_contribution_rate: current?.pf_contribution_rate ?? "", site_ids: (person.site_records || []).map(site => String(site.id)), reporting_ids: reportIds,
    });
    setEditingId(person.id); setPhotoFile(null); setMessage("");
    document.getElementById("people-editor-heading")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async function save(event) {
    event.preventDefault(); setBusy(true); setMessage("");
    let uploadedPath = "";
    let persisted = false;
    let savedEmployeeId = null;
    try {
      let photoPath = form.photo_storage_path || null;
      if (photoFile) {
        const extension = photoFile.name.split(".").pop()?.toLowerCase();
        const allowed = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };
        if (!allowed[extension] || allowed[extension] !== photoFile.type) throw new Error("Choose a JPEG, PNG, or WebP photo with a matching file type.");
        if (photoFile.size > 5 * 1024 * 1024) throw new Error("Employee photos must be 5 MB or smaller.");
        uploadedPath = `${isSupervisor ? "supervisors" : "field-officers"}/${crypto.randomUUID()}.${extension}`;
        const { error } = await supabase.storage.from(BUCKET).upload(uploadedPath, photoFile, { contentType: photoFile.type, cacheControl: "3600", upsert: false });
        if (error) throw new Error(`Private photo upload failed. Apply the employee-private Storage migration if the bucket is not configured. ${error.message}`);
        photoPath = uploadedPath;
      }
      const person = { ...form, photo_storage_path: photoPath, gross_monthly_salary: form.gross_monthly_salary || null };
      const result = await postPeople({ action: "save", employee_type: employeeType, employee_id: editingId, person, site_ids: form.site_ids.map(Number), reporting_ids: form.reporting_ids.map(Number) });
      persisted = true;
      savedEmployeeId = result.employee_id;
      await identityRef.current?.save(savedEmployeeId);
      // Previous photos remain private and are queued by the database.
      resetForm(); await onRefresh(); await onMetricsRefresh();
      setMessage(`Employee profile saved (record ${result.employee_id}).`);
    } catch (error) {
      const orphanMessage = uploadedPath && !persisted ? await queueOrphan(BUCKET, uploadedPath) : "";
      if (persisted && savedEmployeeId) setEditingId(savedEmployeeId);
      setMessage(persisted ? `Employee profile saved, but identity changes were not confirmed: ${error.message}` : `${error.message} ${orphanMessage}`);
    } finally { setBusy(false); }
  }

  async function confirmExit(details) {
    if (!exitTarget) return;
    await postPeople({ action: "exit", employee_type: employeeType, employee_id: exitTarget.id, ...details });
    setExitTarget(null); await onRefresh(); await onMetricsRefresh();
    setMessage(`${exitTarget.full_name} moved to Former Employees. Salary, advance, assignment, and audit history were preserved.`);
  }


  const reportingOptions = otherPeople.filter(person => !person.archived_at && person.status === "active");

  return <div className="people-management">
    <form className="gss-admin-form people-editor" onSubmit={save}>
      <h3 id="people-editor-heading">{editingId ? `Edit ${isSupervisor ? "supervisor" : "field officer"} profile` : `Add ${isSupervisor ? "supervisor" : "field officer"}`}</h3>
      <p className="people-private-note">Employee data is visible to authorized administrators only. ESI/PF fields store confirmed reference settings; they are not automatically deducted. Salary figures are estimates, not statutory payroll.</p>
      <label>Employee code<input maxLength="64" pattern="[A-Za-z0-9_-]*" value={form.employee_code} onChange={event => setForm({ ...form, employee_code: event.target.value.toUpperCase() })} placeholder="Assigned automatically if blank"/></label>
      <label>Full name<input required maxLength="160" value={form.full_name} onChange={event => setForm({ ...form, full_name: event.target.value })}/></label>
      <label>Phone<input required type="tel" maxLength="24" value={form.phone} onChange={event => setForm({ ...form, phone: event.target.value })}/></label>
      <label>Email<input type="email" maxLength="254" value={form.email} onChange={event => setForm({ ...form, email: event.target.value })}/></label>
      <label>Designation<input maxLength="100" value={form.designation} onChange={event => setForm({ ...form, designation: event.target.value })} placeholder={isSupervisor ? "Supervisor" : "Field Officer"}/></label>
      <label>Status<select value={form.status} onChange={event => setForm({ ...form, status: event.target.value })}><option value="active">Active</option><option value="inactive">Inactive</option><option value="on_leave">On leave</option><option value="relieved">Relieved</option></select></label>
      <label>Joining date<input type="date" value={form.joining_date} onChange={event => setForm({ ...form, joining_date: event.target.value })}/></label>
      <label>Employment end date<input type="date" value={form.employment_end_date} onChange={event => setForm({ ...form, employment_end_date: event.target.value })}/></label>
      <label>Date of birth (optional)<input type="date" value={form.date_of_birth} onChange={event => setForm({ ...form, date_of_birth: event.target.value })}/></label>
      <label className="full">Residential address (optional)<textarea rows="2" maxLength="1000" value={form.residential_address} onChange={event => setForm({ ...form, residential_address: event.target.value })}/></label>
      <label className="full people-photo-control">Private profile photo<input type="file" accept="image/jpeg,image/png,image/webp" onChange={event => setPhotoFile(event.target.files?.[0] || null)}/><small>{photoFile?.name || (form.photo_storage_path ? "A private photo is already saved." : "No photo stored.")} · JPEG, PNG, WebP · maximum 5 MB</small></label>
      <EmployeeIdentityFields ref={identityRef} employeeType={employeeType} employeeId={editingId}/>
      <h4 className="people-section-heading">Compensation · INR</h4>
      <label>Gross monthly salary<input type="number" min="0" max="100000000" step="0.01" value={form.gross_monthly_salary} onChange={event => setForm({ ...form, gross_monthly_salary: event.target.value })}/></label>
      <label>Salary effective from<input type="date" value={form.salary_effective_from} onChange={event => setForm({ ...form, salary_effective_from: event.target.value })}/></label>
      <label>ESI applicability<select value={form.esi_applicable} onChange={event => setForm({ ...form, esi_applicable: event.target.value })}><option value="">Not configured</option><option value="true">Applicable</option><option value="false">Not applicable</option></select></label>
      <label>ESI rate (%)<input type="number" min="0" max="100" step="0.0001" value={form.esi_contribution_rate} onChange={event => setForm({ ...form, esi_contribution_rate: event.target.value })}/></label>
      <label>PF applicability<select value={form.pf_applicable} onChange={event => setForm({ ...form, pf_applicable: event.target.value })}><option value="">Not configured</option><option value="true">Applicable</option><option value="false">Not applicable</option></select></label>
      <label>PF rate (%)<input type="number" min="0" max="100" step="0.0001" value={form.pf_contribution_rate} onChange={event => setForm({ ...form, pf_contribution_rate: event.target.value })}/></label>
      <label className="full">Compensation notes<input maxLength="1000" value={form.salary_notes} onChange={event => setForm({ ...form, salary_notes: event.target.value })}/></label>
      <CheckList title="Assigned sites" options={sites.filter(site => site.status !== "inactive" && !site.archived_at)} selected={form.site_ids} onChange={site_ids => setForm({ ...form, site_ids })}/>
      <CheckList title={isSupervisor ? "Reports to field officers" : "Supervisors reporting to this field officer"} options={reportingOptions} selected={form.reporting_ids} onChange={reporting_ids => setForm({ ...form, reporting_ids })}/>
      <div className="gss-admin-form-actions full"><button className="gss-admin-primary" type="submit" disabled={busy}>{editingId ? <Check size={15}/> : <Plus size={15}/>} {editingId ? "Save profile" : `Create ${isSupervisor ? "supervisor" : "field officer"}`}</button>{editingId && <button className="gss-admin-secondary" type="button" onClick={resetForm}><X size={15}/> Cancel</button>}</div>
    </form>

    {message && <p className="gss-admin-message" role="status">{message}</p>}
    <RecordFilter value={recordFilter} onChange={setRecordFilter}/><div className="gss-admin-list-heading"><h3>{title} · {items.length}</h3><div className="people-list-actions"><input className="gss-admin-search" type="search" value={filters.search} onChange={event => setFilters({ ...filters, search: event.target.value })} placeholder="Search name, code, phone, site" aria-label={`Search ${title.toLowerCase()}`}/><select aria-label="Filter by status" value={filters.status} onChange={event => setFilters({ ...filters, status: event.target.value })}><option value="">All statuses</option><option value="active">Active</option><option value="inactive">Inactive</option><option value="on_leave">On leave</option><option value="relieved">Former Employees</option></select><button className="gss-admin-secondary" type="button" onClick={onRefresh}><RefreshCw size={15}/> Refresh</button><button className="gss-admin-secondary" type="button" onClick={() => exportPeople(visible, employeeType)}><ArrowDownToLine size={15}/> Export CSV</button></div></div>
    {!visible.length ? <p className="gss-admin-empty">No {title.toLowerCase()} match your search.</p> : <div className="gss-admin-items people-cards">{visible.map(person => <article className="gss-admin-item people-card" key={person.id}>
      <div className="people-avatar">{signedPhotos[person.id] ? <img src={signedPhotos[person.id]} alt={`${person.full_name} private profile`}/> : <Camera size={18}/>}</div>
      <div className="gss-admin-item-copy"><div className="people-name-line"><strong>{person.full_name}</strong><span className={`people-status ${person.status}`}>{String(person.status).replaceAll("_", " ")}</span></div>
        <p>{person.employee_code || "No employee code"} · {person.designation || title.slice(0, -1)}</p>
        <div className="site-details"><span><b>Phone:</b> {person.phone || "None"}</span><span><b>Email:</b> {person.email || "None"}</span><span><b>Joining:</b> {person.joining_date || "Not recorded"}</span><span><b>Monthly gross:</b> {person.current_compensation ? `₹${Number(person.current_compensation.gross_monthly_salary).toLocaleString("en-IN")}` : "Not configured"}</span><span><b>Sites:</b> {person.site_records?.map(site => site.title).join(", ") || "None"}</span>
          {isSupervisor ? <><span><b>Reports to:</b> {person.reporting_people.map(row => row.full_name).join(", ") || "None"}</span><span><b>Guards at assigned sites:</b> {person.assigned_guards.map(guard => guard.full_name).join(", ") || "None"}</span></> : <><span><b>Reporting supervisors:</b> {person.reporting_people.map(row => row.full_name).join(", ") || "None"}</span><span><b>Guard count at assigned sites:</b> {person.assigned_guards.length}</span></>}
          {person.date_of_birth && <span><b>Date of birth:</b> {person.date_of_birth}</span>}{person.residential_address && <span><b>Address:</b> {person.residential_address}</span>}
        </div>
      </div>
      <div className="gss-admin-item-actions">{person.status === "active" && !person.archived_at && <button type="button" onClick={() => setExitTarget(person)}>Remove Employee</button>}<button type="button" disabled={Boolean(person.archived_at)} onClick={() => editPerson(person)}><Pencil size={15}/> Edit</button><RecordActions module={recordModule} item={person} onChanged={async () => { await onRefresh(); await onMetricsRefresh(); }} onEditingDeleted={() => { if (editingId === person.id) resetForm(); }}/></div>
    </article>)}</div>}
    <p className="people-history-note">Former employees stay available through the status filter. Their compensation, assignment, advance, and audit history is retained.</p>
    {exitTarget && <LifecycleDialog kind="employee" record={exitTarget} onCancel={() => setExitTarget(null)} onConfirm={confirmExit}/>}
  </div>;
}
