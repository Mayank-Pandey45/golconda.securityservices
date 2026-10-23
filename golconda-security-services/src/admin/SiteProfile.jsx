import React, { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Building2, RefreshCw } from "lucide-react";
import { supabase } from "../supabase.js";
import "./siteProfile.css";

const dateLabel = value => value ? new Date(`${String(value).slice(0, 10)}T00:00:00`).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric" }) : "Not recorded";

async function allRows(queryFactory) {
  const rows = [];
  for (let offset = 0; offset < 1000000; offset += 1000) {
    const { data, error } = await queryFactory().range(offset, offset + 999);
    if (error) throw new Error(error.message);
    rows.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return rows;
}

async function peopleByIds(table, ids) {
  if (!ids.length) return [];
  const records = [];
  for (let offset = 0; offset < ids.length; offset += 200) {
    const { data, error } = await supabase.from(table).select("id,full_name,employee_code,phone,email,designation,status,employment_end_date").in("id", ids.slice(offset, offset + 200));
    if (error) throw new Error(error.message);
    records.push(...(data || []));
  }
  return records;
}

export default function SiteProfile({ siteId }) {
  const [site, setSite] = useState(null);
  const [staff, setStaff] = useState({ guard: [], supervisor: [], field_officer: [] });
  const [assignments, setAssignments] = useState({ guard: [], supervisor: [], field_officer: [] });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let active = true;
    async function load() {
      setLoading(true); setError("");
      try {
        if (!supabase) throw new Error("Secure site storage is unavailable.");
        const id = Number(siteId);
        if (!Number.isSafeInteger(id) || id < 1) throw new Error("This Site link is invalid.");
        const [siteResult, guardAssignments, supervisorAssignments, officerAssignments] = await Promise.all([
          supabase.from("sites").select("*").eq("id", id).maybeSingle(),
          allRows(() => supabase.from("guard_site_assignments").select("id,guard_id,site_id,valid_from,valid_to,assignment_notes").eq("site_id", id).order("valid_from", { ascending: false })),
          allRows(() => supabase.from("supervisor_site_assignments").select("id,supervisor_id,site_id,valid_from,valid_to,assignment_notes").eq("site_id", id).order("valid_from", { ascending: false })),
          allRows(() => supabase.from("field_officer_site_assignments").select("id,field_officer_id,site_id,valid_from,valid_to,assignment_notes").eq("site_id", id).order("valid_from", { ascending: false })),
        ]);
        if (siteResult.error) throw new Error(siteResult.error.message);
        if (!siteResult.data) throw new Error("This Site was not found or is not available to this administrator.");
        const [guards, supervisors, fieldOfficers] = await Promise.all([
          peopleByIds("guards", [...new Set(guardAssignments.map(row => row.guard_id))]),
          peopleByIds("supervisors", [...new Set(supervisorAssignments.map(row => row.supervisor_id))]),
          peopleByIds("field_officers", [...new Set(officerAssignments.map(row => row.field_officer_id))]),
        ]);
        if (!active) return;
        setSite(siteResult.data);
        setAssignments({ guard: guardAssignments, supervisor: supervisorAssignments, field_officer: officerAssignments });
        setStaff({ guard: guards, supervisor: supervisors, field_officer: fieldOfficers });
      } catch (loadError) { if (active) setError(loadError.message || "Site profile could not be loaded."); }
      finally { if (active) setLoading(false); }
    }
    load();
    return () => { active = false; };
  }, [siteId, refreshKey]);

  const staffMaps = useMemo(() => Object.fromEntries(Object.entries(staff).map(([type, people]) => [type, new Map(people.map(person => [String(person.id), person]))])), [staff]);
  const current = type => assignments[type].filter(row => !row.valid_to && staffMaps[type].get(String(row[`${type === "guard" ? "guard" : type === "supervisor" ? "supervisor" : "field_officer"}_id`]))?.status === "active");
  const previous = type => assignments[type].filter(row => row.valid_to || staffMaps[type].get(String(row[`${type === "guard" ? "guard" : type === "supervisor" ? "supervisor" : "field_officer"}_id`]))?.status !== "active");
  const linkFor = (type, id) => type === "guard" ? `/?guard=${encodeURIComponent(id)}` : "";

  if (loading) return <section className="site-profile-state" role="status">Loading Site Profile…</section>;
  if (error) return <section className="site-profile-state" role="alert"><p>{error}</p><a className="gss-admin-secondary" href="/?tab=sites"><ArrowLeft size={15}/> Back to Sites</a></section>;

  const staffSection = (type, title, rows) => {
    const fk = type === "guard" ? "guard_id" : type === "supervisor" ? "supervisor_id" : "field_officer_id";
    const people = staffMaps[type];
    return <section className="site-profile-section" key={`${type}-${title}`}><h3>{title}</h3>{rows.length ? <div className="site-profile-table-wrap"><table className="site-profile-table"><thead><tr><th>Employee</th><th>Employee ID</th><th>Phone</th><th>Role</th><th>Assignment dates</th><th>Status</th></tr></thead><tbody>{rows.map(row => {
      const person = people.get(String(row[fk]));
      if (!person) return null;
      const name = type === "guard" ? <a href={linkFor(type, person.id)}>{person.full_name}</a> : person.full_name;
      return <tr key={row.id}><td>{name}</td><td>{person.employee_code || `#${person.id}`}</td><td>{person.phone || "Not recorded"}</td><td>{person.designation || (type === "field_officer" ? "Field Officer" : type === "supervisor" ? "Supervisor" : "Security Guard")}</td><td>{dateLabel(row.valid_from)} — {row.valid_to ? dateLabel(row.valid_to) : "Current"}</td><td>{person.status || "Not recorded"}{row.valid_to ? " · Assignment ended" : " · Assignment current"}</td></tr>;
    })}</tbody></table></div> : <p className="gss-admin-empty">No records in this section.</p>}</section>;
  };

  return <div className="site-profile-page">
    <a className="site-profile-back" href="/?tab=sites"><ArrowLeft size={16}/> Back to Sites</a>
    <header className="site-profile-header"><div className="site-profile-icon"><Building2 size={27}/></div><div><span className="eyebrow">SITE PROFILE · {site.site_code || `#${site.id}`}</span><h2>{site.title}</h2><p>{site.service_taken || "Service not recorded"}</p></div><div className="site-profile-actions"><span className={`site-status ${site.status || "active"}`}>{site.status || "Not recorded"}</span><button className="gss-admin-secondary" type="button" onClick={() => setRefreshKey(value => value + 1)}><RefreshCw size={15}/> Refresh</button></div></header>
    <section className="site-profile-facts"><div><small>Status</small><strong>{site.closure_date ? "Closed" : site.status || "Not recorded"}</strong></div><div><small>Contract start</small><strong>{dateLabel(site.contract_start_date)}</strong></div><div><small>Contract end</small><strong>{dateLabel(site.contract_end_date)}</strong></div><div><small>Site closure date</small><strong>{dateLabel(site.closure_date)}</strong></div>{site.closure_reason && <div><small>Closure reason</small><strong>{site.closure_reason}</strong></div>}{site.closure_remarks && <div><small>Closure remarks</small><strong>{site.closure_remarks}</strong></div>}<div><small>Phone numbers</small><strong>{site.phone_numbers || "Not recorded"}</strong></div><div><small>Emails</small><strong>{site.given_emails || "Not recorded"}</strong></div></section>
    <div className="site-profile-counts">{[["guard", "Active Guards"], ["supervisor", "Active Supervisors"], ["field_officer", "Active Field Officers"]].map(([type, label]) => <article key={type}><small>{label}</small><strong>{current(type).length}</strong></article>)}</div>
    {staffSection("guard", "Current Guards", current("guard"))}
    {staffSection("supervisor", "Current Supervisors", current("supervisor"))}
    {staffSection("field_officer", "Current Field Officers", current("field_officer"))}
    {staffSection("guard", "Previous and Former Guards", previous("guard"))}
    {staffSection("supervisor", "Previous Supervisors", previous("supervisor"))}
    {staffSection("field_officer", "Previous Field Officers", previous("field_officer"))}
    <p className="site-profile-note">Employee and assignment history is displayed from dated assignment records. Site contract dates are shown only when stored.</p>
  </div>;
}
