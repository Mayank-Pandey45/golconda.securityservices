import { employeeRecordKey } from "../../shared/recordLifecycle.js";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDownToLine, Check, ChevronLeft, ChevronRight, Plus, RefreshCw, RotateCcw, X } from "lucide-react";
import { apiUrl, readApiResponse } from "../api.js";
import { supabase } from "../supabase.js";
import { downloadFile } from "../guardSpreadsheet.js";
import "./advancesManagement.css";

const pageSize = 50;
const currentMonth = new Date().toISOString().slice(0, 7);
const money = value => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(Number(value || 0));
const dateTime = value => value ? new Date(value).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" }) : "—";

async function getToken() {
  const { data, error } = await supabase.auth.getSession();
  if (error || !data.session?.access_token) throw new Error("Your admin session has expired. Sign in again and retry.");
  return data.session.access_token;
}

async function requestJson(path, options = {}) {
  const token = await getToken();
  const response = await fetch(apiUrl(path), { ...options, headers: { ...(options.headers || {}), Authorization: `Bearer ${token}` } });
  const result = await readApiResponse(response);
  return result;
}

function monthRange(month) {
  const [year, number] = month.split("-").map(Number);
  const last = new Date(Date.UTC(year, number, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, "0")}` };
}

function csvCell(value) {
  const text = value === null || value === undefined ? "" : String(value);
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}

function recordsCsv(rows) {
  const columns = [
    ["Advance ID", "id"], ["Date/time (Asia/Kolkata)", "local_time"], ["Employee code", "employee_code"],
    ["Employee name", "employee_name"], ["Employee type", "employee_type"], ["Site", "site_title"],
    ["Amount (INR)", "amount"], ["Recovered (INR)", "recovered_total"], ["Remaining (INR)", "remaining_balance"],
    ["Payment mode", "payment_mode"], ["Description", "description"], ["Source", "source"],
    ["External reference", "external_reference"], ["Recorded by", "recorded_by"],
  ];
  const matrix = [columns.map(([label]) => label), ...rows.map(row => columns.map(([, key]) => row[key] ?? ""))];
  return `\uFEFF${matrix.map(line => line.map(csvCell).join(",")).join("\r\n")}`;
}

export default function AdvancesManagement({ guards = [], supervisors = [], fieldOfficers = [], sites = [], onMetricsRefresh }) {
  const people = useMemo(() => [
    ...guards.map(person => ({ ...person, employee_type: "guard" })),
    ...supervisors.map(person => ({ ...person, employee_type: "supervisor" })),
    ...fieldOfficers.map(person => ({ ...person, employee_type: "field_officer" })),
  ].sort((a, b) => String(a.full_name).localeCompare(String(b.full_name))), [guards, supervisors, fieldOfficers]);
  const [filters, setFilters] = useState({ month: "", from: "", to: "", site_id: "", employee_type: "", employee_id: "" });
  const [records, setRecords] = useState([]);
  const [total, setTotal] = useState(0);
  const [amountTotal, setAmountTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [period, setPeriod] = useState(currentMonth);
  const [payroll, setPayroll] = useState([]);
  const [adjustments, setAdjustments] = useState([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const advancePending = useRef(false);
  const advanceRequest = useRef(null);
  const [recoveryTarget, setRecoveryTarget] = useState(null);
  const [correctionTarget, setCorrectionTarget] = useState(null);
  const [advanceForm, setAdvanceForm] = useState({ employee_id: "", site_id: "", amount: "", occurred_at: "", payment_mode: "", description: "" });
  const [adjustmentForm, setAdjustmentForm] = useState({ employee_type: "guard", employee_id: "", salary_period: currentMonth, adjustment_type: "addition", amount: "", description: "" });
  const [recoveryForm, setRecoveryForm] = useState({ amount: "", salary_period: currentMonth, notes: "" });
  const [correctionForm, setCorrectionForm] = useState({ adjustment_type: "correction", amount_delta: "", reason: "" });

  const queryString = useCallback((currentPage = 1, pageLimit = pageSize) => {
    const params = new URLSearchParams({ page: String(currentPage), page_size: String(pageLimit) });
    for (const key of ["from", "to", "site_id", "employee_type", "employee_id"]) if (filters[key]) params.set(key, filters[key]);
    return params.toString();
  }, [filters]);

  const loadRecords = useCallback(async (currentPage = 1) => {
    setBusy(true); setMessage("");
    try {
      const result = await requestJson(`/api/operations/advances?${queryString(currentPage)}`);
      setRecords(result.advances || []); setTotal(Number(result.total || 0)); setAmountTotal(Number(result.amount_total || 0)); setPage(currentPage);
    } catch (error) { setMessage(error.message); }
    finally { setBusy(false); }
  }, [queryString]);

  const loadPayroll = useCallback(async () => {
    setPayroll([]);
    try {
      const result = await requestJson(`/api/operations/payroll?period=${encodeURIComponent(period)}`);
      setPayroll(result.employees || []);
    } catch (error) { setMessage(error.message); }
  }, [period]);

  const loadAdjustments = useCallback(async () => {
    const { data, error } = await supabase.from("salary_adjustments").select("id,employee_type,guard_id,supervisor_id,field_officer_id,salary_period,adjustment_type,amount,description,is_approved,created_at").eq("salary_period", `${period}-01`).order("created_at", { ascending: false });
    if (error) { setMessage(`Salary adjustments could not load: ${error.message}`); return; }
    setAdjustments(data || []);
  }, [period]);

  useEffect(() => { loadRecords(1); }, [filters, loadRecords]);
  useEffect(() => { loadPayroll(); loadAdjustments(); }, [loadPayroll, loadAdjustments]);

  const peopleByKey = useMemo(() => new Map(people.map(person => [`${person.employee_type}:${person.id}`, person])), [people]);
  const payrollByEmployee = useMemo(() => new Map(payroll.map(person => [`${person.employee_type}:${person.employee_id}`, person])), [payroll]);
  const periodEmployees = payroll.filter(person => person.salary_eligible !== false || person.remaining_advance_balance > 0 || person.advances_given_period > 0 || person.status === "active");
  const totalEstimate = periodEmployees.reduce((sum, person) => sum + Math.round(Number(person.net_payable_after_proposed_recovery || 0) * 100), 0) / 100;

  async function submitAdvance(event) {
    event.preventDefault();
    if (advancePending.current) return;
    advancePending.current = true;
    setBusy(true); setMessage("");
    try {
      const employee = people.find(person => employeeRecordKey(person) === advanceForm.employee_id);
      if (!employee) throw new Error("Select an employee.");
      const input = { action: "record", employee_type: employee.employee_type, employee_id: employee.id, site_id: advanceForm.site_id || null, amount: advanceForm.amount, occurred_at: advanceForm.occurred_at ? new Date(advanceForm.occurred_at).toISOString() : undefined, payment_mode: advanceForm.payment_mode, description: advanceForm.description };
      const fingerprint = JSON.stringify(input);
      if (advanceRequest.current?.fingerprint !== fingerprint) advanceRequest.current = { fingerprint, reference: "dashboard:" + crypto.randomUUID() };
      await requestJson("/api/operations/advances", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...input, external_reference: advanceRequest.current.reference }) });
      advanceRequest.current = null;
      setAdvanceForm({ employee_id: "", site_id: "", amount: "", occurred_at: "", payment_mode: "", description: "" });
      await loadRecords(1); await loadPayroll(); await onMetricsRefresh?.(); setMessage("Advance recorded and stored.");
    } catch (error) { setMessage(error.message); }
    finally { advancePending.current = false; setBusy(false); }
  }

  async function submitRecovery(event) {
    event.preventDefault(); if (!recoveryTarget) return;
    setBusy(true); setMessage("");
    try {
      await requestJson("/api/operations/advances", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "recover", advance_id: recoveryTarget.id, ...recoveryForm }) });
      setRecoveryTarget(null); setRecoveryForm({ amount: "", salary_period: period, notes: "" });
      await loadRecords(page); await loadPayroll(); setMessage("Recovery allocated once to the selected salary month.");
    } catch (error) { setMessage(error.message); }
    finally { setBusy(false); }
  }

  async function submitCorrection(event) {
    event.preventDefault(); if (!correctionTarget) return;
    setBusy(true); setMessage("");
    try {
      await requestJson("/api/operations/advances", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "adjust", advance_id: correctionTarget.id, ...correctionForm }) });
      setCorrectionTarget(null); setCorrectionForm({ adjustment_type: "correction", amount_delta: "", reason: "" });
      await loadRecords(page); await loadPayroll(); setMessage("Financial correction appended to the audit trail.");
    } catch (error) { setMessage(error.message); }
    finally { setBusy(false); }
  }

  async function submitSalaryAdjustment(event) {
    event.preventDefault(); setBusy(true); setMessage("");
    try {
      await requestJson("/api/operations/advances", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "salary-adjustment", ...adjustmentForm }) });
      setAdjustmentForm({ ...adjustmentForm, employee_id: "", amount: "", description: "" });
      await loadAdjustments(); setMessage("Salary adjustment entered as pending. Approve it before it affects the estimate.");
    } catch (error) { setMessage(error.message); }
    finally { setBusy(false); }
  }

  async function approveAdjustment(adjustment) {
    setBusy(true); setMessage("");
    try {
      await requestJson("/api/operations/advances", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "approve-adjustment", adjustment_id: adjustment.id }) });
      await loadAdjustments(); await loadPayroll(); setMessage("Salary adjustment approved and included in the estimate.");
    } catch (error) { setMessage(error.message); }
    finally { setBusy(false); }
  }

  async function exportFiltered(format) {
    setBusy(true); setMessage("");
    try {
      const rows = [];
      const pages = Math.ceil(total / 200);
      for (let current = 1; current <= pages; current += 1) {
        const result = await requestJson(`/api/operations/advances?${queryString(current, 200)}`);
        rows.push(...(result.advances || []));
      }
      if (!rows.length) throw new Error("There are no matching advance records to export.");
      const output = rows.map(row => ({ ...row, local_time: dateTime(row.occurred_at), recovered_total: (row.recoveries || []).reduce((sum, recovery) => sum + Number(recovery.amount), 0) }));
      const stem = `golconda-advances-${filters.from || filters.month || "all"}-${filters.to || "filtered"}`;
      if (format === "csv") downloadFile(recordsCsv(output), `${stem}.csv`, "text/csv;charset=utf-8");
      else {
        const { default: ExcelJS } = await import("exceljs");
        const workbook = new ExcelJS.Workbook(); const sheet = workbook.addWorksheet("Advances", { views: [{ state: "frozen", ySplit: 1 }] });
        sheet.columns = [["Advance ID", "id"], ["Date/time (Asia/Kolkata)", "local_time"], ["Employee code", "employee_code"], ["Employee name", "employee_name"], ["Employee type", "employee_type"], ["Site", "site_title"], ["Amount (INR)", "amount"], ["Recovered (INR)", "recovered_total"], ["Remaining (INR)", "remaining_balance"], ["Payment mode", "payment_mode"], ["Description", "description"], ["Source", "source"], ["External reference", "external_reference"], ["Recorded by", "recorded_by"]].map(([header, key]) => ({ header, key, width: header.includes("name") || header.includes("Description") ? 28 : 20 }));
        for (const row of output) sheet.addRow({ ...row, amount: Number(row.amount), recovered_total: Number(row.recovered_total), remaining_balance: Number(row.remaining_balance) });
        sheet.getRow(1).font = { bold: true };
        downloadFile(await workbook.xlsx.writeBuffer(), `${stem}.xlsx`, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      }
      setMessage(`${rows.length} authorized, filtered records exported.`);
    } catch (error) { setMessage(error.message); }
    finally { setBusy(false); }
  }

  function changeMonth(value) {
    const range = value ? monthRange(value) : { from: "", to: "" };
    setPage(1); setFilters(previous => ({ ...previous, month: value, ...range }));
  }

  const selectedAdvancePerson = people.find(person => employeeRecordKey(person) === advanceForm.employee_id);
  const employeeSites = selectedAdvancePerson?.site_records || [];
  const recoveryEmployeeId = recoveryTarget?.guard_id ?? recoveryTarget?.supervisor_id ?? recoveryTarget?.field_officer_id;
  const recoveryPayroll = recoveryTarget ? payrollByEmployee.get(`${recoveryTarget.employee_type}:${recoveryEmployeeId}`) : null;
  const recoveryMaximum = Math.min(Number(recoveryTarget?.remaining_balance || 0), Math.max(0, Number(recoveryPayroll?.net_payable_estimate || 0)));
  const recoverySuggestion = Math.min(recoveryMaximum, Math.max(0, Number(recoveryPayroll?.proposed_advance_recovery || 0)));

  return <div className="advances-management">
    <p className="advances-note">Financial entries are append-only. Advances are not deducted from net pay until an explicit recovery is allocated to one salary month. ESI/PF rates are not automatically deducted; approved manual salary adjustments are included. Estimates are not statutory payroll processing, and daily guard rates are excluded because attendance is not tracked.</p>
    <form className="gss-admin-form advances-record-form" onSubmit={submitAdvance}>
      <h3>Record an advance</h3>
      <label>Employee<select required value={advanceForm.employee_id} onChange={event => setAdvanceForm({ ...advanceForm, employee_id: event.target.value, site_id: "" })}><option value="">Choose a person</option>{people.filter(person => !person.archived_at).map(person => <option key={employeeRecordKey(person)} value={employeeRecordKey(person)}>{person.employee_code} · {person.full_name} ({person.employee_type.replaceAll("_", " ")})</option>)}</select></label>
      <label>Assigned site (optional)<select value={advanceForm.site_id} onChange={event => setAdvanceForm({ ...advanceForm, site_id: event.target.value })}><option value="">Not assigned to a site</option>{employeeSites.filter(site => !site.archived_at).map(site => <option key={site.id} value={site.id}>{site.title}</option>)}</select></label>
      <label>Amount · INR<input type="number" required min="0.01" max="100000000" step="0.01" value={advanceForm.amount} onChange={event => setAdvanceForm({ ...advanceForm, amount: event.target.value })}/></label>
      <label>Date & time<input type="datetime-local" value={advanceForm.occurred_at} onChange={event => setAdvanceForm({ ...advanceForm, occurred_at: event.target.value })}/><small>Displayed in Asia/Kolkata; stored in UTC.</small></label>
      <label>Payment mode<input maxLength="60" value={advanceForm.payment_mode} onChange={event => setAdvanceForm({ ...advanceForm, payment_mode: event.target.value })} placeholder="Cash / bank transfer"/></label>
      <label className="full">Reason or description<input maxLength="500" value={advanceForm.description} onChange={event => setAdvanceForm({ ...advanceForm, description: event.target.value })}/></label>
      <div className="gss-admin-form-actions full"><button className="gss-admin-primary" type="submit" disabled={busy}><Plus size={15}/> Record advance</button></div>
    </form>

    <section className="advances-report-panel">
      <div className="advances-section-head"><div><h3>Advance register</h3><p>Combined filters apply to the total and exports. Exports include all matching pages.</p></div><button className="gss-admin-secondary" type="button" onClick={() => loadRecords(1)} disabled={busy}><RefreshCw size={15}/> Refresh</button></div>
      <div className="advances-filters">
        <label>Month<input type="month" value={filters.month} onChange={event => changeMonth(event.target.value)}/></label>
        <label>From<input type="date" value={filters.from} onChange={event => setFilters({ ...filters, from: event.target.value, month: "" })}/></label>
        <label>To<input type="date" value={filters.to} onChange={event => setFilters({ ...filters, to: event.target.value, month: "" })}/></label>
        <label>Site<select value={filters.site_id} onChange={event => setFilters({ ...filters, site_id: event.target.value })}><option value="">All sites</option>{sites.map(site => <option key={site.id} value={site.id}>{site.title}</option>)}</select></label>
        <label>Employee type<select value={filters.employee_type} onChange={event => setFilters({ ...filters, employee_type: event.target.value, employee_id: "" })}><option value="">All types</option><option value="guard">Guard</option><option value="supervisor">Supervisor</option><option value="field_officer">Field officer</option></select></label>
        <label>Employee<select value={filters.employee_id} onChange={event => setFilters({ ...filters, employee_id: event.target.value })} disabled={!filters.employee_type}><option value="">All employees</option>{people.filter(person => person.employee_type === filters.employee_type).map(person => <option key={person.id} value={person.id}>{person.employee_code} · {person.full_name}</option>)}</select></label>
      </div>
      <div className="advances-total-line"><strong>{money(amountTotal)}</strong><span>Total advances given in this filtered range</span><span>{total} record{total === 1 ? "" : "s"}</span><div><button className="gss-admin-secondary" type="button" onClick={() => exportFiltered("csv")} disabled={busy}><ArrowDownToLine size={15}/> Export CSV</button><button className="gss-admin-secondary" type="button" onClick={() => exportFiltered("xlsx")} disabled={busy}><ArrowDownToLine size={15}/> Export Excel</button></div></div>
      {records.length === 0 ? <p className="gss-admin-empty">No advance records match these filters.</p> : <div className="advances-table-wrap"><table className="advances-table"><thead><tr><th>Date</th><th>Employee</th><th>Site</th><th>Given</th><th>Recovered</th><th>Remaining</th><th>Details</th><th>Actions</th></tr></thead><tbody>{records.map(row => {
        const recovered = (row.recoveries || []).reduce((sum, item) => sum + Number(item.amount), 0);
        const employeeId = row.guard_id ?? row.supervisor_id ?? row.field_officer_id;
        const payrollRow = payrollByEmployee.get(`${row.employee_type}:${employeeId}`);
        const suggested = Math.min(Number(row.remaining_balance || 0), Math.max(0, Number(payrollRow?.proposed_advance_recovery || 0)));
        return <tr key={row.id}><td>{dateTime(row.occurred_at)}<small>#{row.id} · {row.source}</small></td><td>{row.employee_name}<small>{row.employee_code} · {row.employee_type.replaceAll("_", " ")}</small></td><td>{row.site_title || "Unassigned"}</td><td>{money(row.amount)}</td><td>{money(recovered)}<small>{(row.recoveries || []).map(item => `${item.salary_period.slice(0, 7)}: ${money(item.amount)}`).join(" · ")}</small></td><td>{money(row.remaining_balance)}</td><td>{row.payment_mode || "—"}<small>{row.description || ""}</small></td><td className="advance-actions"><button type="button" className="gss-admin-secondary" onClick={() => { setRecoveryTarget(row); setRecoveryForm({ amount: suggested > 0 ? suggested.toFixed(2) : "", salary_period: period, notes: "" }); }} disabled={busy || row.remaining_balance <= 0}><Check size={14}/> Review recovery</button><button type="button" className="gss-admin-secondary" onClick={() => { setCorrectionTarget(row); setCorrectionForm({ adjustment_type: "correction", amount_delta: "", reason: "" }); }} disabled={busy}><RotateCcw size={14}/> Correct / reverse</button></td></tr>;
      })}</tbody></table></div>}
      <div className="advances-pagination"><span>Page {page} · {total} records</span><button className="gss-admin-secondary" type="button" disabled={busy || page <= 1} onClick={() => loadRecords(page - 1)}><ChevronLeft size={15}/> Previous</button><button className="gss-admin-secondary" type="button" disabled={busy || page * pageSize >= total} onClick={() => loadRecords(page + 1)}>Next <ChevronRight size={15}/></button></div>
    </section>

    {recoveryTarget && <form className="gss-admin-form advances-inline-form" onSubmit={submitRecovery}><h3>Review recovery · Advance #{recoveryTarget.id}</h3><p>Available advance balance: {money(recoveryTarget.remaining_balance)}. Suggested amount for {recoveryForm.salary_period}: {money(recoverySuggestion)}. You can reduce the amount before allocation. The saved allocation becomes a finalized recovery for this salary period.</p><label>Amount · INR<input required type="number" min="0.01" max={recoveryMaximum} step="0.01" value={recoveryForm.amount} onChange={event => setRecoveryForm({ ...recoveryForm, amount: event.target.value })} disabled={busy || recoveryMaximum <= 0}/></label><label>Salary period<input required type="month" value={recoveryForm.salary_period} onChange={event => { setRecoveryForm({ ...recoveryForm, salary_period: event.target.value, amount: "" }); setPeriod(event.target.value); }}/></label><label className="full">Notes<input maxLength="500" value={recoveryForm.notes} onChange={event => setRecoveryForm({ ...recoveryForm, notes: event.target.value })}/></label>{recoveryMaximum <= 0 && <p className="advances-recovery-unavailable full" role="status">No positive salary amount is available for this month’s recovery. The advance remains outstanding.</p>}<div className="gss-admin-form-actions full"><button className="gss-admin-primary" disabled={busy || recoveryMaximum <= 0}><Check size={15}/> Allocate recovery</button><button type="button" className="gss-admin-secondary" onClick={() => setRecoveryTarget(null)}><X size={15}/> Cancel</button></div></form>}
    {correctionTarget && <form className="gss-admin-form advances-inline-form" onSubmit={submitCorrection}><h3>Correct / reverse · Advance #{correctionTarget.id}</h3><p>Original entry is preserved. Reversal sets the remaining balance to zero, if it has not already been fully recovered.</p><label>Correction type<select value={correctionForm.adjustment_type} onChange={event => setCorrectionForm({ ...correctionForm, adjustment_type: event.target.value })}><option value="correction">Correction</option><option value="reversal">Full reversal</option></select></label>{correctionForm.adjustment_type === "correction" && <label>Signed delta · INR<input required type="number" step="0.01" value={correctionForm.amount_delta} onChange={event => setCorrectionForm({ ...correctionForm, amount_delta: event.target.value })} placeholder="Positive or negative"/></label>}<label className="full">Reason<input required maxLength="500" value={correctionForm.reason} onChange={event => setCorrectionForm({ ...correctionForm, reason: event.target.value })}/></label><div className="gss-admin-form-actions full"><button className="gss-admin-primary" disabled={busy}><RotateCcw size={15}/> Append correction</button><button type="button" className="gss-admin-secondary" onClick={() => setCorrectionTarget(null)}><X size={15}/> Cancel</button></div></form>}

    <section className="advances-report-panel">
      <div className="advances-section-head"><div><h3>Salary estimate</h3><p>Total Salary uses the employee's configured monthly salary. Advance recoveries and approved adjustments are applied to calculate the estimated final amount.</p></div><label>Salary month<input type="month" value={period} onChange={event => { setPeriod(event.target.value); setRecoveryTarget(null); setRecoveryForm({ amount: "", salary_period: event.target.value, notes: "" }); }}/></label></div>
      <div className="advances-total-line"><strong>{money(totalEstimate)}</strong><span>Total Salary After Advance for eligible employees in this period</span><span>Proposed amounts are estimates and do not change the ledger until an administrator finalizes them.</span></div>
      <div className="advances-table-wrap"><table className="advances-table advances-payroll-table"><thead><tr><th>Employee</th><th>Total Salary</th><th>Approved Additions</th><th>Other Deductions</th><th>Advance Given This Month</th><th>Outstanding Advance</th><th>Finalized Recovery</th><th>Proposed Advance Deduction</th><th>Total Salary After Advance</th><th>Advance Balance After Recovery</th></tr></thead><tbody>{periodEmployees.map(person => <tr key={`${person.employee_type}:${person.employee_id}`}><td>{person.full_name}{person.salary_eligible === false && <small className="payroll-ineligible">{person.salary_eligibility_status || "Not eligible for selected month"}</small>}<small>{person.employee_code} · {person.employee_type.replaceAll("_", " ")}</small></td><td>{money(person.total_salary ?? person.gross_for_period)}</td><td>{money(person.approved_additions)}</td><td>{money(person.approved_deductions)}</td><td>{money(person.advances_given_period)}</td><td>{money(person.advance_outstanding_before_payroll)}</td><td>{money(person.finalized_recovery_amount)}</td><td>{money(person.proposed_advance_recovery)}</td><td className="payroll-net-cell"><b>{money(person.net_payable_after_proposed_recovery)}</b><small>Estimate</small></td><td>{money(person.advance_outstanding_after_proposed_recovery)}</td></tr>)}</tbody></table></div>
      <p className="advances-note">Total Salary is the configured monthly amount when the employee is eligible for this period. Joining and exit dates determine eligibility only; they do not prorate salary. Partial-month changes must be entered as an explicit approved adjustment. Proposed recovery is capped by the remaining advance and salary after approved adjustments and finalized recovery. ESI/PF rates are not deducted automatically. No completed salary-payment ledger is available, so paid or pending amounts are not inferred.</p>
    </section>

    <form className="gss-admin-form advances-adjustment-form" onSubmit={submitSalaryAdjustment}>
      <h3>Enter salary adjustment</h3><p>New entries are pending and excluded from payroll estimates until an administrator approves them.</p>
      <label>Employee type<select value={adjustmentForm.employee_type} onChange={event => setAdjustmentForm({ ...adjustmentForm, employee_type: event.target.value, employee_id: "" })}><option value="guard">Guard</option><option value="supervisor">Supervisor</option><option value="field_officer">Field officer</option></select></label>
      <label>Employee<select required value={adjustmentForm.employee_id} onChange={event => setAdjustmentForm({ ...adjustmentForm, employee_id: event.target.value })}><option value="">Choose employee</option>{people.filter(person => person.employee_type === adjustmentForm.employee_type).map(person => <option key={person.id} value={person.id}>{person.employee_code} · {person.full_name}</option>)}</select></label>
      <label>Salary month<input required type="month" value={adjustmentForm.salary_period} onChange={event => setAdjustmentForm({ ...adjustmentForm, salary_period: event.target.value })}/></label>
      <label>Adjustment<select value={adjustmentForm.adjustment_type} onChange={event => setAdjustmentForm({ ...adjustmentForm, adjustment_type: event.target.value })}><option value="addition">Addition</option><option value="deduction">Deduction</option></select></label>
      <label>Amount · INR<input required type="number" min="0.01" max="100000000" step="0.01" value={adjustmentForm.amount} onChange={event => setAdjustmentForm({ ...adjustmentForm, amount: event.target.value })}/></label>
      <label className="full">Description / reason<input required maxLength="500" value={adjustmentForm.description} onChange={event => setAdjustmentForm({ ...adjustmentForm, description: event.target.value })}/></label>
      <div className="gss-admin-form-actions full"><button className="gss-admin-primary" disabled={busy}><Plus size={15}/> Add pending adjustment</button></div>
    </form>
    <section className="advances-report-panel"><div className="advances-section-head"><div><h3>Salary adjustments · {period}</h3><p>Approval is audited; only approved entries affect the estimate.</p></div></div>{adjustments.length ? <div className="advances-table-wrap"><table className="advances-table"><thead><tr><th>Employee</th><th>Type</th><th>Amount</th><th>Reason</th><th>Status</th><th>Action</th></tr></thead><tbody>{adjustments.map(adjustment => { const id = adjustment.guard_id ?? adjustment.supervisor_id ?? adjustment.field_officer_id; const person = peopleByKey.get(`${adjustment.employee_type}:${id}`); return <tr key={adjustment.id}><td>{person?.full_name || "Unknown employee"}<small>{person?.employee_code || ""}</small></td><td>{adjustment.adjustment_type}</td><td>{money(adjustment.amount)}</td><td>{adjustment.description}</td><td>{adjustment.is_approved ? "Approved" : "Pending approval"}</td><td>{!adjustment.is_approved && <button className="gss-admin-secondary" type="button" onClick={() => approveAdjustment(adjustment)} disabled={busy}><Check size={14}/> Approve</button>}</td></tr>; })}</tbody></table></div> : <p className="gss-admin-empty">No adjustments for this salary month.</p>}</section>
    {message && <p className="gss-admin-message" role="status">{message}</p>}
  </div>;
}
