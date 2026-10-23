import React, { useEffect, useRef, useState } from "react";
import { recordActions, actionLabels, confirmationPhrase, intakeStates, recordState, recordLabel } from "../../shared/recordLifecycle.js";
import { recordRequest } from "./recordClient.js";
import "./recordManagement.css";

export function RecordFilter({ value, onChange }) {
  return <label className="record-filter">Record visibility<select aria-label="Record visibility" value={value} onChange={event => onChange(event.target.value)}><option value="all">All records</option><option value="active">Active / open / public</option><option value="inactive">Inactive / closed / hidden</option><option value="archived">Archived</option></select></label>;
}
export function RecordDialog({ title, children, onClose }) {
  const ref = useRef(null);
  useEffect(() => {
    const previous = document.activeElement;
    const node = ref.current;
    const elements = () => [...node.querySelectorAll("button,input,select,textarea")].filter(element => !element.disabled);
    elements()[0]?.focus();
    function key(event) {
      if (event.key === "Escape") { event.preventDefault(); onClose(); }
      if (event.key === "Tab") {
        const list = elements(); const first = list[0]; const last = list.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }
    node.addEventListener("keydown", key);
    return () => { node.removeEventListener("keydown", key); previous?.focus?.(); };
  }, [onClose]);
  return <div className="record-dialog-backdrop"><section ref={ref} role="dialog" aria-modal="true" aria-label={title} className="record-dialog"><h3>{title}</h3>{children}</section></div>;
}
export default function RecordActions({ module, item, onChanged, onEditingDeleted }) {
  const [action, setAction] = useState("");
  const [phrase, setPhrase] = useState("");
  const [understood, setUnderstood] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [notes, setNotes] = useState(item.admin_notes || "");
  const [status, setStatus] = useState(item.status || intakeStates[module]?.[0]);
  const close = React.useCallback(() => { if (!busy) setAction(""); }, [busy]);
  async function submit(event) {
    event.preventDefault(); setBusy(true); setMessage("");
    try {
      const result = await recordRequest({ module, id: item.id, action: action === "edit" ? "save" : action, confirmation: phrase, ...(action === "edit" ? { patch: { admin_notes: notes, status } } : {}) });
      setAction(""); setMessage(result.message || "Record updated.");
      if (["archive", "delete"].includes(action)) onEditingDeleted?.();
      await onChanged?.();
    } catch (error) { setMessage(error.message); } finally { setBusy(false); }
  }
  return <div className="record-actions">
    <small className="record-state">{recordState(module, item)} · #{item.id}</small>
    {intakeStates[module] && !item.archived_at && <button type="button" onClick={() => { setAction("edit"); setNotes(item.admin_notes || ""); setStatus(item.status); }}>Edit review notes / status</button>}
    {recordActions(module, item).map(value => <button type="button" key={value} disabled={busy} className={value === "delete" ? "danger" : ""} onClick={() => { setPhrase(""); setUnderstood(false); setAction(value); setMessage(""); }}>{actionLabels[value]}</button>)}
    {intakeStates[module] && <small>Original submission retained. Permanent deletion is disabled until a retention policy is approved.</small>}
    {message && <p role="status" className="record-feedback">{message}</p>}
    {action && <RecordDialog title={(action === "edit" ? "Review" : actionLabels[action]) + " · record #" + item.id} onClose={close}><form onSubmit={submit}>
      <p>{recordLabel(item)}.</p>
      {action === "edit" ? <><p>Original submission details are retained unchanged.</p><label>Review status<select value={status} onChange={event => setStatus(event.target.value)}>{intakeStates[module].map(value => <option key={value}>{value}</option>)}</select></label><label>Administrator notes<textarea maxLength={5000} value={notes} onChange={event => setNotes(event.target.value)}/></label></> : <p>{action === "delete" ? "Permanent deletion cannot be undone. Linked assignments, payroll, advances and retained history will never be deleted to force this action. Archive is the safe alternative." : action === "restore" ? "Restore keeps history and files. Review activation, publication and assignments separately." : "This action preserves records and financial history. Deactivation and archive do not change employment dates or stop salary accrual."}</p>}
      {action === "delete" && <><label>Type {confirmationPhrase(action, item.id)}<input autoComplete="off" value={phrase} onChange={event => setPhrase(event.target.value)}/></label><label className="record-ack"><input type="checkbox" checked={understood} onChange={event => setUnderstood(event.target.checked)}/> I understand this record cannot be restored after permanent deletion.</label></>}
      {message && <p role="alert" className="record-feedback">{message}</p>}
      <div className="record-dialog-actions"><button type="button" disabled={busy} onClick={close}>{action === "delete" && item.archived_at ? "Keep archived" : "Cancel"}</button><button type="submit" disabled={busy || (action === "delete" && (!understood || phrase !== confirmationPhrase(action, item.id)))}>{busy ? "Saving…" : "Confirm " + (action === "edit" ? "review" : actionLabels[action])}</button></div>
    </form></RecordDialog>}
  </div>;
}
