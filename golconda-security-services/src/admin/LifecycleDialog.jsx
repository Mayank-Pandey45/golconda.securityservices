import React, { useState } from "react";
import { RecordDialog } from "./RecordActions.jsx";

function localDate(value = new Date()) {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}

export default function LifecycleDialog({ kind, record, onCancel, onConfirm }) {
  const isSite = kind === "site";
  const [reason, setReason] = useState("");
  const [effectiveDate, setEffectiveDate] = useState(localDate());
  const [remarks, setRemarks] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const close = () => { if (!busy) onCancel(); };

  async function submit(event) {
    event.preventDefault(); setBusy(true); setMessage("");
    try {
      await onConfirm(isSite
        ? { closure_reason: reason.trim(), contract_end_date: effectiveDate, remarks: remarks.trim() }
        : { exit_reason: reason, last_working_date: effectiveDate, remarks: remarks.trim() });
    } catch (error) { setMessage(error.message || "The lifecycle change could not be saved."); }
    finally { setBusy(false); }
  }

  return <RecordDialog title={isSite ? "Close Site" : "Remove Employee"} onClose={close}>
    <form className="lifecycle-form" onSubmit={submit}>
      <p>{isSite ? "Closing a Site ends its active assignments and preserves employee and financial history." : "This removes the employee from active operations. Financial, assignment, and audit history remain available."}</p>
      <label>{isSite ? "Site Name" : "Employee Name"}<input value={record.title || record.full_name || ""} readOnly/></label>
      {isSite ? <label>Closure Reason<input required maxLength="200" value={reason} onChange={event => setReason(event.target.value)} placeholder="Contract expired, client request…"/></label>
        : <label>Reason<select required value={reason} onChange={event => setReason(event.target.value)}><option value="">Choose a reason</option><option>Resigned</option><option>Terminated</option><option>Left Company</option><option>Other</option></select></label>}
      <label>{isSite ? "Contract End Date" : "Last Working Date"}<input required type="date" max={localDate()} min={isSite ? (record.contract_start_date || undefined) : (record.joining_date || undefined)} value={effectiveDate} onChange={event => setEffectiveDate(event.target.value)}/></label>
      <label>Remarks{reason === "Other" && !isSite ? " (required)" : " (optional)"}<textarea rows="3" maxLength="2000" required={reason === "Other" && !isSite} value={remarks} onChange={event => setRemarks(event.target.value)} placeholder="Add relevant context for the retained record"/></label>
      {message && <p className="lifecycle-error" role="alert">{message}</p>}
      <div className="record-dialog-actions"><button type="button" disabled={busy} onClick={close}>Cancel</button><button type="submit" disabled={busy || !reason || !effectiveDate}>{busy ? "Saving…" : isSite ? "Confirm Site Closure" : "Confirm Removal"}</button></div>
    </form>
  </RecordDialog>;
}
