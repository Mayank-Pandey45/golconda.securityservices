import React, { useEffect, useMemo, useState } from "react";
import { ArrowLeft, BriefcaseBusiness, Clock3, Coins, FileText, RefreshCw, UserRound } from "lucide-react";
import { supabase } from "../supabase.js";
import { apiUrl, readApiResponse } from "../api.js";
import "./guardProfile.css";

const money = value => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(Number(value || 0));
const dateOnly = value => value ? new Date(`${String(value).slice(0, 10)}T00:00:00`).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric" }) : "—";
const dateTime = value => value ? new Date(value).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" }) : "—";
const inrDate = value => value ? new Date(value).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }) : "";
const fmtStatus = value => ({ active: "Active", inactive: "Inactive", on_leave: "On leave", relieved: "Former employee" })[value] || value || "Not recorded";

async function readAllRows(queryFactory) {
  const result = [];
  const pageSize = 1000;
  for (let from = 0; from < 1000000; from += pageSize) {
    const { data, error } = await queryFactory().range(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    result.push(...(data || []));
    if (!data || data.length < pageSize) break;
  }
  return result;
}

function duration(start, end) {
  if (!start) return "Not recorded";
  const first = Date.parse(`${String(start).slice(0, 10)}T00:00:00Z`);
  const last = Date.parse(`${String(end || inrDate(new Date())).slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(first) || !Number.isFinite(last) || last < first) return "—";
  const days = Math.floor((last - first) / 86400000) + 1;
  return days < 30 ? `${days} day${days === 1 ? "" : "s"}` : `${Math.floor(days / 30)} mo · ${days % 30} d`;
}

async function loadAdvancesForGuard(guardId) {
  const rows = await readAllRows(() => supabase.from("advances").select("id,guard_id,site_id,amount,occurred_at,payment_mode,description,external_reference,recorded_by,source").eq("employee_type", "guard").eq("guard_id", guardId).order("occurred_at", { ascending: false }).order("id", { ascending: false }));
  const adjustmentRows = [];
  const recoveryRows = [];
  for (let offset = 0; offset < rows.length; offset += 200) {
    const ids = rows.slice(offset, offset + 200).map(row => row.id);
    const [adjustments, recoveries] = await Promise.all([
      readAllRows(() => supabase.from("advance_adjustments").select("advance_id,adjustment_type,amount_delta,reason,created_at").in("advance_id", ids).order("created_at", { ascending: true })),
      readAllRows(() => supabase.from("advance_recoveries").select("advance_id,salary_period,amount,notes,created_at").in("advance_id", ids).order("created_at", { ascending: true })),
    ]);
    adjustmentRows.push(...adjustments);
    recoveryRows.push(...recoveries);
  }
  const adjustmentMap = new Map();
  const recoveryMap = new Map();
  for (const item of adjustmentRows) adjustmentMap.set(String(item.advance_id), [...(adjustmentMap.get(String(item.advance_id)) || []), item]);
  for (const item of recoveryRows) recoveryMap.set(String(item.advance_id), [...(recoveryMap.get(String(item.advance_id)) || []), item]);
  return rows.map(row => {
    const adjustments = adjustmentMap.get(String(row.id)) || [];
    const recoveries = recoveryMap.get(String(row.id)) || [];
    const amount = Number((Number(row.amount) + adjustments.reduce((total, item) => total + Number(item.amount_delta), 0)).toFixed(2));
    const recovered = Number(recoveries.reduce((total, item) => total + Number(item.amount), 0).toFixed(2));
    const reversed = amount <= 0;
    return { ...row, adjustments, recoveries, ledger_amount: amount, recovered, remaining: Math.max(0, Number((amount - recovered).toFixed(2))), status: reversed ? "Reversed" : adjustments.length ? "Corrected" : "Recorded" };
  });
}

export default function GuardProfile({ guardId }) {
  const [guard, setGuard] = useState(null);
  const [assignments, setAssignments] = useState([]);
  const [sites, setSites] = useState([]);
  const [advances, setAdvances] = useState([]);
  const [photo, setPhoto] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const [advancePage, setAdvancePage] = useState(1);
  const [filters, setFilters] = useState({ from: "", to: "", month: "", year: "", site_id: "", payment_mode: "" });
  const [salaryMonth, setSalaryMonth] = useState(() => inrDate(new Date()).slice(0, 7));
  const [salaryEstimate, setSalaryEstimate] = useState(null);
  const [salaryError, setSalaryError] = useState("");
  const [salaryLoading, setSalaryLoading] = useState(false);

  useEffect(() => {
    let active = true;
    async function load() {
      setLoading(true); setError("");
      try {
        if (!supabase) throw new Error("Secure profile storage is unavailable.");
        const id = Number(guardId);
        if (!Number.isSafeInteger(id) || id < 1) throw new Error("This Guard Profile link is invalid.");
        const [guardResult, dutyHistory, advanceRows] = await Promise.all([
          supabase.from("guards").select("*").eq("id", id).maybeSingle(),
          readAllRows(() => supabase.from("guard_site_assignments").select("id,guard_id,site_id,valid_from,valid_to,assignment_notes,created_at").eq("guard_id", id).order("valid_from", { ascending: false }).order("id", { ascending: false })),
          loadAdvancesForGuard(id),
        ]);
        if (guardResult.error) throw new Error(guardResult.error.message);
        if (!guardResult.data) throw new Error("This guard record was not found or is not available to this administrator.");
        const siteIds = [...new Set([...dutyHistory.map(row => row.site_id), ...advanceRows.map(row => row.site_id)].filter(Boolean))];
        const siteRows = siteIds.length ? await readAllRows(() => supabase.from("sites").select("id,title,site_code,status,archived_at").in("id", siteIds).order("title")) : [];
        let signedPhoto = "";
        if (guardResult.data.photo_storage_path) {
          const photoResult = await supabase.storage.from("employee-private").createSignedUrl(guardResult.data.photo_storage_path, 600);
          signedPhoto = photoResult.error ? "" : photoResult.data?.signedUrl || "";
        }
        if (!active) return;
        setGuard(guardResult.data); setAssignments(dutyHistory); setAdvances(advanceRows); setSites(siteRows); setPhoto(signedPhoto);
      } catch (loadError) { if (active) setError(loadError.message || "Guard profile could not be loaded."); }
      finally { if (active) setLoading(false); }
    }
    load();
    return () => { active = false; };
  }, [guardId, refreshKey]);

  useEffect(() => {
    let active = true;
    async function loadSalaryEstimate() {
      setSalaryLoading(true); setSalaryError(""); setSalaryEstimate(null);
      try {
        if (!supabase || !/^\d{4}-(0[1-9]|1[0-2])$/.test(salaryMonth)) throw new Error("Select a valid salary month.");
        const { data, error: authError } = await supabase.auth.getSession();
        const token = data?.session?.access_token;
        if (authError || !token) throw new Error("Sign in again to view salary estimates.");
        const response = await fetch(apiUrl(`/api/operations/payroll?period=${encodeURIComponent(salaryMonth)}`), { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
        const result = await readApiResponse(response);
        if (!response.ok) throw new Error(result.error || "Salary estimate could not be loaded.");
        const row = (result.employees || []).find(person => person.employee_type === "guard" && String(person.employee_id) === String(guardId));
        if (active) setSalaryEstimate(row || null);
      } catch (loadError) { if (active) setSalaryError(loadError.message || "Salary estimate is unavailable."); }
      finally { if (active) setSalaryLoading(false); }
    }
    if (guard) loadSalaryEstimate();
    return () => { active = false; };
  }, [guard, guardId, salaryMonth, refreshKey]);

  const siteById = useMemo(() => new Map(sites.map(site => [String(site.id), site])), [sites]);
  const filteredAdvances = useMemo(() => advances.filter(row => {
    const occurred = inrDate(row.occurred_at);
    return (!filters.from || occurred >= filters.from) && (!filters.to || occurred <= filters.to)
      && (!filters.month || occurred.slice(0, 7) === filters.month)
      && (!filters.year || occurred.slice(0, 4) === filters.year)
      && (!filters.site_id || String(row.site_id || "") === filters.site_id)
      && (!filters.payment_mode || String(row.payment_mode || "").toLowerCase() === filters.payment_mode.toLowerCase());
  }), [advances, filters]);
  const advanceTotals = useMemo(() => filteredAdvances.reduce((total, row) => ({
    given: total.given + row.ledger_amount,
    recovered: total.recovered + row.recovered,
    outstanding: total.outstanding + row.remaining,
  }), { given: 0, recovered: 0, outstanding: 0 }), [filteredAdvances]);
  const allAdvanceTotals = useMemo(() => advances.reduce((total, row) => ({
    given: total.given + row.ledger_amount,
    recovered: total.recovered + row.recovered,
    outstanding: total.outstanding + row.remaining,
  }), { given: 0, recovered: 0, outstanding: 0 }), [advances]);
  const siteTotals = useMemo(() => {
    const totals = new Map();
    for (const row of filteredAdvances) {
      const key = String(row.site_id || "unassigned");
      totals.set(key, (totals.get(key) || 0) + row.ledger_amount);
    }
    return [...totals.entries()].map(([id, amount]) => ({ id, amount, title: id === "unassigned" ? "Unassigned / Not Recorded" : siteById.get(id)?.title || "Site not available" })).sort((a, b) => a.title.localeCompare(b.title));
  }, [filteredAdvances, siteById]);
  const currentAssignments = useMemo(() => assignments.filter(item => !item.valid_to), [assignments]);
  const pastAssignments = useMemo(() => assignments.filter(item => item.valid_to), [assignments]);
  const years = useMemo(() => [...new Set(advances.map(row => inrDate(row.occurred_at).slice(0, 4)).filter(Boolean))].sort().reverse(), [advances]);
  const advancePageSize = 50;
  const pageCount = Math.max(1, Math.ceil(filteredAdvances.length / advancePageSize));
  const visibleAdvances = filteredAdvances.slice((advancePage - 1) * advancePageSize, advancePage * advancePageSize);

  useEffect(() => { setAdvancePage(1); }, [filters]);

  if (loading) return <section className="guard-profile-state" role="status">Loading Guard Profile…</section>;
  if (error) return <section className="guard-profile-state" role="alert"><p>{error}</p><a className="gss-admin-secondary" href="/?tab=guards"><ArrowLeft size={15}/> Back to Guard Directory</a></section>;

  return <div className="guard-profile-page">
    <a className="guard-profile-back" href="/?tab=guards"><ArrowLeft size={16}/> Back to Guard Directory</a>
    <header className="guard-profile-header">
      <div className="guard-profile-avatar">{photo ? <img src={photo} alt={`${guard.full_name} profile`}/> : <UserRound size={28}/>}</div>
      <div className="guard-profile-title"><span className="eyebrow">SECURITY GUARD PROFILE · #{guard.id}</span><h2>{guard.full_name}</h2><p>{guard.employee_code || "No Guard ID recorded"} · {guard.designation || "Security Guard"}</p><span className={`people-status ${guard.status}`}>{fmtStatus(guard.status)}</span></div>
      <div className="guard-profile-actions"><a className="gss-admin-secondary" href={`/?tab=guards&editGuard=${encodeURIComponent(guard.id)}`}><FileText size={15}/> Edit Profile</a>{guard.status === "active" && <a className="gss-admin-secondary" href={`/?tab=guards&exitGuard=${encodeURIComponent(guard.id)}`}><BriefcaseBusiness size={15}/> Remove Employee</a>}</div>
    </header>
    <section className="guard-profile-contact" aria-label="Guard contact and employment details">
      <div><small>Phone</small><strong>{guard.phone || "Not recorded"}</strong></div><div><small>Email</small><strong>{guard.email || "Not recorded"}</strong></div>
      <div><small>Joining date</small><strong>{dateOnly(guard.joining_date)}</strong></div><div><small>Last working date</small><strong>{dateOnly(guard.employment_end_date)}</strong></div>
      <div><small>Current assigned sites</small><strong>{currentAssignments.length ? currentAssignments.map(row => siteById.get(String(row.site_id))?.title || "Site not available").join(", ") : "No current assignment"}</strong></div>
    </section>

    <section className="guard-profile-section" aria-labelledby="guard-finance-heading">
      <div className="guard-profile-section-heading"><div><span className="eyebrow">LEDGER SUMMARY</span><h3 id="guard-finance-heading">Financial summary</h3></div><button type="button" className="gss-admin-secondary" onClick={() => setRefreshKey(value => value + 1)}><RefreshCw size={15}/> Refresh profile</button></div>
      <div className="guard-profile-metrics">
        <article><small>Total Advances Taken</small><strong>{money(allAdvanceTotals.given)}</strong><span>Net of ledger corrections and reversals across all sites</span></article>
        <article><small>Total Advance Recovered</small><strong>{money(allAdvanceTotals.recovered)}</strong><span>Recorded salary-period recovery allocations</span></article>
        <article><small>Outstanding Advance Balance</small><strong>{money(allAdvanceTotals.outstanding)}</strong><span>Remaining balance after corrections and recovery</span></article>
        <article><small>Total Salary Paid</small><strong>Unavailable</strong><span>No completed salary-payment ledger is stored</span></article>
        <article><small>Pending Salary</small><strong>Unavailable</strong><span>Payroll data stores estimates, not payment status</span></article>
        <article><small>Current Site Assignments</small><strong>{currentAssignments.length}</strong><span>Active dated assignments</span></article>
      </div>
    </section>

    <section className="guard-profile-section" aria-labelledby="guard-advances-heading">
      <div className="guard-profile-section-heading"><div><span className="eyebrow">APPEND-ONLY FINANCIAL RECORDS</span><h3 id="guard-advances-heading">Advance history</h3><p>Corrections and recoveries are applied once per ledger record. Historical entries remain intact.</p></div><a className="gss-admin-secondary" href="/?tab=advances"><Coins size={15}/> Open Advance Register</a></div>
      <div className="guard-profile-filters">
        <label>From<input type="date" value={filters.from} onChange={event => setFilters({ ...filters, from: event.target.value, month: "" })}/></label>
        <label>To<input type="date" value={filters.to} onChange={event => setFilters({ ...filters, to: event.target.value, month: "" })}/></label>
        <label>Month<input type="month" value={filters.month} onChange={event => setFilters({ ...filters, month: event.target.value, year: "", from: "", to: "" })}/></label>
        <label>Year<select value={filters.year} onChange={event => setFilters({ ...filters, year: event.target.value, month: "", from: "", to: "" })}><option value="">All years</option>{years.map(year => <option key={year}>{year}</option>)}</select></label>
        <label>Site<select value={filters.site_id} onChange={event => setFilters({ ...filters, site_id: event.target.value })}><option value="">All sites</option>{sites.map(site => <option key={site.id} value={site.id}>{site.title}</option>)}</select></label>
        <label>Payment mode<select value={filters.payment_mode} onChange={event => setFilters({ ...filters, payment_mode: event.target.value })}><option value="">All modes</option><option value="cash">Cash</option><option value="online">Online</option>{[...new Set(advances.map(row => row.payment_mode).filter(value => value && !["cash", "online"].includes(String(value).toLowerCase())))].map(value => <option key={value} value={value}>{value}</option>)}</select></label>
      </div>
      <div className="guard-profile-ledger-summary"><span>Total Advances Taken · Filtered</span><strong>{money(advanceTotals.given)}</strong><span>{filteredAdvances.length} entries</span></div>
      {filteredAdvances.length ? <div className="guard-profile-table-wrap"><table className="guard-profile-table"><thead><tr><th>Date</th><th>Guard</th><th>Site</th><th>Advance Amount</th><th>Mode</th><th>Reference</th><th>Remarks</th><th>Recorded By</th><th>Status</th><th>Actions</th></tr></thead><tbody>{visibleAdvances.map(row => <tr key={row.id}>
        <td>{dateTime(row.occurred_at)}<small>#{row.id}</small></td><td>{guard.full_name}<small>{guard.employee_code || `Guard #${guard.id}`}</small></td><td>{row.site_id ? siteById.get(String(row.site_id))?.title || "Site not available" : "Unassigned / Not Recorded"}</td><td>{money(row.amount)}{row.ledger_amount !== Number(row.amount) && <small>Net ledger: {money(row.ledger_amount)}</small>}</td><td>{row.payment_mode ? String(row.payment_mode).replaceAll("_", " ").replace(/\b\w/g, character => character.toUpperCase()) : "Not recorded"}</td><td>{row.external_reference || "—"}</td><td>{row.description || "—"}{row.adjustments.map(item => <small key={`${item.created_at}:${item.reason}`}>Correction: {item.reason}</small>)}</td><td>{row.recorded_by || "Not recorded"}</td><td>{row.status}{row.recovered > 0 && <small>Recovered {money(row.recovered)}</small>}</td><td><a href="/?tab=advances" aria-label={`Review advance ${row.id} in the register`}>Review in register</a></td>
      </tr>)}</tbody></table></div> : <p className="gss-admin-empty">No advances match these filters.</p>}
      {filteredAdvances.length > advancePageSize && <div className="guard-profile-pagination"><span>Page {advancePage} of {pageCount}</span><button className="gss-admin-secondary" type="button" disabled={advancePage <= 1} onClick={() => setAdvancePage(value => value - 1)}>Previous</button><button className="gss-admin-secondary" type="button" disabled={advancePage >= pageCount} onClick={() => setAdvancePage(value => value + 1)}>Next</button></div>}
      <div className="guard-profile-site-totals"><h4>Site-wise Advance Summary</h4>{siteTotals.length ? <div className="guard-profile-table-wrap"><table className="guard-profile-table"><thead><tr><th>Site</th><th>Total Advance</th></tr></thead><tbody>{siteTotals.map(row => <tr key={row.id}><td>{row.id !== "unassigned" && siteById.has(row.id) ? <a href={`/?site=${encodeURIComponent(row.id)}`}>{row.title}</a> : row.title}</td><td>{money(row.amount)}</td></tr>)}<tr><th>Total</th><th>{money(siteTotals.reduce((sum, row) => sum + row.amount, 0))}</th></tr></tbody></table></div> : <p className="gss-admin-empty">No advance entries are recorded for this Guard.</p>}</div>
    </section>

    <section className="guard-profile-section" aria-labelledby="guard-duty-heading">
      <div className="guard-profile-section-heading"><div><span className="eyebrow">DATED ASSIGNMENT LEDGER</span><h3 id="guard-duty-heading">Duty and site history</h3><p>Assignments remain linked to the Guard across transfers and site closure.</p></div><a className="gss-admin-secondary" href={`/?tab=guards&editGuard=${encodeURIComponent(guard.id)}`}><BriefcaseBusiness size={15}/> Manage assignments</a></div>
      <h4>Current duty sites</h4>{currentAssignments.length ? <div className="guard-profile-assignment-grid">{currentAssignments.map(row => <article key={row.id}><a href={`/?site=${encodeURIComponent(row.site_id)}`}>{siteById.get(String(row.site_id))?.title || "Site not available"}</a><span>Start: {dateOnly(row.valid_from)}</span><span>Designation: {guard.designation || "Not recorded"}</span><span>Status: Current</span><span>End date: Not scheduled</span></article>)}</div> : <p className="gss-admin-empty">No current duty site is assigned.</p>}
      <h4>Previous duty sites</h4>{pastAssignments.length ? <div className="guard-profile-table-wrap"><table className="guard-profile-table"><thead><tr><th>Site</th><th>Start date</th><th>End date</th><th>Duration</th><th>Status</th><th>Assignment notes</th></tr></thead><tbody>{pastAssignments.map(row => <tr key={row.id}><td><a href={`/?site=${encodeURIComponent(row.site_id)}`}>{siteById.get(String(row.site_id))?.title || "Site not available"}</a></td><td>{dateOnly(row.valid_from)}</td><td>{dateOnly(row.valid_to)}</td><td>{duration(row.valid_from, row.valid_to)}</td><td>Ended</td><td>{row.assignment_notes || "—"}</td></tr>)}</tbody></table></div> : <p className="gss-admin-empty">No previous duty sites are recorded.</p>}
    </section>

    <section className="guard-profile-section" aria-labelledby="guard-salary-heading">
      <div className="guard-profile-section-heading"><div><span className="eyebrow">ESTIMATES ONLY</span><h3 id="guard-salary-heading">Salary history</h3><p>Total Salary uses the configured monthly salary when the employee is eligible for the selected month. Joining and exit dates do not prorate salary. Proposed recovery is an estimate until an authorized administrator records it in the Advance Register.</p></div></div>
      <div className="guard-profile-filters guard-profile-salary-filters"><label>Year<select value={salaryMonth.slice(0, 4)} onChange={event => setSalaryMonth(`${event.target.value}-${salaryMonth.slice(5, 7)}`)}>{Array.from({ length: Math.max(1, new Date().getFullYear() - (Number(String(guard.joining_date || new Date().getFullYear()).slice(0, 4)) || new Date().getFullYear()) + 1) }, (_, index) => String(new Date().getFullYear() - index)).map(year => <option key={year}>{year}</option>)}</select></label><label>Month<select value={salaryMonth.slice(5, 7)} onChange={event => setSalaryMonth(`${salaryMonth.slice(0, 4)}-${event.target.value}`)}>{Array.from({ length: 12 }, (_, index) => String(index + 1).padStart(2, "0")).map(month => <option key={month} value={month}>{new Date(`${salaryMonth.slice(0, 4)}-${month}-01T00:00:00`).toLocaleDateString("en-IN", { month: "long", timeZone: "Asia/Kolkata" })}</option>)}</select></label></div>
      {salaryLoading ? <p role="status">Loading monthly estimate…</p> : salaryError ? <p role="alert" className="guard-profile-error">{salaryError}</p> : salaryEstimate ? <>
        <div className="guard-profile-salary-breakdown" aria-label="Salary estimate breakdown">
          <article><small>Total Salary</small><strong>{money(salaryEstimate.total_salary ?? salaryEstimate.gross_for_period)}</strong><span>{salaryEstimate.salary_eligible === false ? (salaryEstimate.salary_eligibility_status || "Not eligible for selected month") : "Configured monthly amount; no automatic date proration"}</span></article>
          <article><small>Advance outstanding before recovery</small><strong>{money(salaryEstimate.advance_outstanding_before_payroll)}</strong><span>Across all sites, before this period’s recorded recoveries</span></article>
          <article><small>Finalized recovery this month</small><strong>{money(salaryEstimate.finalized_recovery_amount)}</strong><span>Already recorded in the advance ledger</span></article>
          <article><small>Proposed advance deduction</small><strong>−{money(salaryEstimate.proposed_advance_recovery)}</strong><span>Suggestion only; no ledger entry is created here</span></article>
          <article><small>Approved additions</small><strong>{money(salaryEstimate.approved_additions)}</strong><span>Included in the estimated payable amount</span></article>
          <article><small>Other approved deductions</small><strong>−{money(salaryEstimate.approved_deductions)}</strong><span>Only approved salary adjustments are included</span></article>
          <article className="guard-profile-salary-net"><small>Total Salary After Advance</small><strong>{money(salaryEstimate.net_payable_after_proposed_recovery)}</strong><span>Estimated after finalized recovery, proposed recovery, and approved adjustments</span></article>
          <article><small>Remaining Advance Balance</small><strong>{money(salaryEstimate.advance_outstanding_after_proposed_recovery)}</strong><span>Unrecovered balance remains outstanding</span></article>
        </div>
        <div className="guard-profile-table-wrap"><table className="guard-profile-table"><thead><tr><th>Month and Year</th><th>Eligibility</th><th>Total Salary</th><th>Approved Additions</th><th>Other Deductions</th><th>Advance Given This Month</th><th>Outstanding Advance</th><th>Finalized Recovery</th><th>Proposed Advance Deduction</th><th>Total Salary After Advance</th><th>Advance Balance After Recovery</th><th>Amount Paid</th><th>Pending Amount</th></tr></thead><tbody><tr><td>{new Date(`${salaryMonth}-01T00:00:00`).toLocaleDateString("en-IN", { month: "long", year: "numeric", timeZone: "Asia/Kolkata" })}</td><td>{salaryEstimate.salary_eligibility_status || "Eligible for selected month"}</td><td>{money(salaryEstimate.total_salary ?? salaryEstimate.gross_for_period)}</td><td>{money(salaryEstimate.approved_additions)}</td><td>{money(salaryEstimate.approved_deductions)}</td><td>{money(salaryEstimate.advances_given_period)}</td><td>{money(salaryEstimate.advance_outstanding_before_payroll)}</td><td>{money(salaryEstimate.finalized_recovery_amount)}</td><td>{money(salaryEstimate.proposed_advance_recovery)}</td><td><strong>{money(salaryEstimate.net_payable_after_proposed_recovery)}</strong></td><td>{money(salaryEstimate.advance_outstanding_after_proposed_recovery)}</td><td>Unavailable</td><td>Unavailable</td></tr></tbody></table></div>
      </> : <p className="gss-admin-empty">No salary estimate was returned for this month.</p>}
      <p className="guard-profile-unavailable"><Clock3 size={15}/> Salary paid, pending payment, payment date, payment mode, and payment status are unavailable because no completed salary-payment ledger exists. No amounts have been inferred.</p>
    </section>
  </div>;
}
