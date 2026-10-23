import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { apiUrl, readApiResponse } from "../api.js";
import { supabase } from "../supabase.js";
import "./employeeIdentity.css";

const EMPTY_DRAFT = { aadhaar_reference: "", pan_number: "", other_id_type: "", other_id_number: "", clear_aadhaar_reference: false, clear_pan_number: false, clear_other_id: false };
const EMPTY_MASKS = { aadhaar_reference: "Not recorded", pan_number: "Not recorded", other_id_type: "", other_id_number: "Not recorded" };

async function requestIdentity(body) {
  const { data, error } = await supabase.auth.getSession();
  if (error || !data.session?.access_token) throw new Error("Sign in again to manage identity records.");
  const response = await fetch(apiUrl("/api/operations/people"), {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${data.session.access_token}` }, body: JSON.stringify(body),
  });
  return readApiResponse(response);
}

const EmployeeIdentityFields = forwardRef(function EmployeeIdentityFields({ employeeType, employeeId }, ref) {
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [saved, setSaved] = useState(EMPTY_MASKS);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState("");
  const draftRef = useRef(draft);
  const previousEmployeeId = useRef(employeeId);
  draftRef.current = draft;

  useEffect(() => {
    const preservingNewRecordDraft = previousEmployeeId.current == null && employeeId != null;
    previousEmployeeId.current = employeeId;
    if (!preservingNewRecordDraft) { setDraft(EMPTY_DRAFT); setSaved(EMPTY_MASKS); setNotice(""); }
    if (!employeeId) return undefined;
    let active = true;
    setLoading(true);
    requestIdentity({ action: "identity_get", employee_type: employeeType, employee_id: employeeId })
      .then(result => { if (active) setSaved(result.identity || EMPTY_MASKS); })
      .catch(error => { if (active) setNotice(error.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [employeeType, employeeId]);

  useImperativeHandle(ref, () => ({
    async save(targetEmployeeId) {
      const values = draftRef.current;
      const hasChanges = Boolean(values.aadhaar_reference.trim() || values.pan_number.trim() || values.other_id_number.trim()
        || values.clear_aadhaar_reference || values.clear_pan_number || values.clear_other_id
        || (values.other_id_type.trim() && saved.other_id_recorded));
      if (!hasChanges) return;
      const result = await requestIdentity({ action: "identity_save", employee_type: employeeType, employee_id: targetEmployeeId, ...values });
      setSaved(result.identity || EMPTY_MASKS); setDraft(EMPTY_DRAFT); setNotice("Identity fields saved securely. Values remain masked.");
    },
    reset() { setDraft(EMPTY_DRAFT); setSaved(EMPTY_MASKS); setNotice(""); },
  }), [employeeType, saved.other_id_recorded]);

  const change = (key, value) => setDraft(current => ({ ...current, [key]: value, ...(key === "aadhaar_reference" ? { clear_aadhaar_reference: false } : {}), ...(key === "pan_number" ? { clear_pan_number: false } : {}), ...(key === "other_id_number" || key === "other_id_type" ? { clear_other_id: false } : {}) }));
  return <fieldset className="employee-identity-fields">
    <legend>Identity documents · optional · restricted</legend>
    <p>Only the last four Aadhaar digits are accepted. PAN and other ID numbers are encrypted on the server and masked after saving. They are excluded from Telegram, logs, and standard exports.</p>
    <div className="employee-identity-summary" aria-live="polite">
      <span><b>Aadhaar reference</b>{loading ? "Checking…" : saved.aadhaar_reference || "Not recorded"}</span>
      <span><b>PAN</b>{loading ? "Checking…" : saved.pan_number || "Not recorded"}</span>
      <span><b>Other ID</b>{loading ? "Checking…" : `${saved.other_id_type ? `${saved.other_id_type} · ` : ""}${saved.other_id_number || "Not recorded"}`}</span>
    </div>
    <label>Aadhaar reference (last four digits only)<input inputMode="numeric" autoComplete="off" value={draft.aadhaar_reference} onChange={event => change("aadhaar_reference", event.target.value.replace(/\D/g, ""))} placeholder="Leave blank to keep saved value"/></label>
    {saved.aadhaar_recorded && <label className="identity-clear"><input type="checkbox" checked={draft.clear_aadhaar_reference} onChange={event => setDraft(current => ({ ...current, clear_aadhaar_reference: event.target.checked }))}/> Remove saved Aadhaar reference</label>}
    <label>PAN number<input autoComplete="off" maxLength="10" value={draft.pan_number} onChange={event => change("pan_number", event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))} placeholder="Leave blank to keep saved value"/></label>
    {saved.pan_recorded && <label className="identity-clear"><input type="checkbox" checked={draft.clear_pan_number} onChange={event => setDraft(current => ({ ...current, clear_pan_number: event.target.checked }))}/> Remove saved PAN</label>}
    <label>Other ID proof type<input autoComplete="off" maxLength="80" value={draft.other_id_type} onChange={event => change("other_id_type", event.target.value)} placeholder="e.g. Driving licence"/></label>
    <label>Other ID proof number<input autoComplete="off" maxLength="100" value={draft.other_id_number} onChange={event => change("other_id_number", event.target.value)} placeholder="Leave blank to keep saved value"/></label>
    {saved.other_id_recorded && <label className="identity-clear"><input type="checkbox" checked={draft.clear_other_id} onChange={event => setDraft(current => ({ ...current, clear_other_id: event.target.checked }))}/> Remove saved Other ID proof</label>}
    {notice && <small role="status">{notice}</small>}
  </fieldset>;
});

export default EmployeeIdentityFields;
