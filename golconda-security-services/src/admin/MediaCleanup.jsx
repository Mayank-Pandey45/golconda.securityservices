import React, { useCallback, useEffect, useState } from "react";
import { supabase } from "../supabase.js";
import { recordRequest } from "./recordClient.js";
import { RecordDialog } from "./RecordActions.jsx";
import { confirmationPhrase } from "../../shared/recordLifecycle.js";

export default function MediaCleanup() {
  const [items, setItems] = useState([]);
  const [filter, setFilter] = useState("pending");
  const [message, setMessage] = useState("");
  const [selected, setSelected] = useState(null);
  const [phrase, setPhrase] = useState("");
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    const rows = [];
    for (let from = 0; ; from += 500) {
      const { data, error } = await supabase.from("media_cleanup_queue").select("id,bucket,path,status,attempts,last_error,created_at").order("id").range(from, from + 499);
      if (error) { setMessage("Cleanup unavailable. Verify the approved record-management migration and admin permissions."); return; }
      rows.push(...data); if (data.length < 500) break;
    }
    setItems(rows);
  }, []);
  useEffect(() => { refresh(); }, [refresh]);
  const close = useCallback(() => { if (!busy) setSelected(null); }, [busy]);
  async function remove(event) {
    event.preventDefault(); setBusy(true);
    try { await recordRequest({ action: "cleanup_media", id: selected.id, confirmation: phrase }); setMessage("Private orphan removed; metadata and history preserved."); setSelected(null); }
    catch (error) { setMessage(error.message); }
    finally { setBusy(false); await refresh(); }
  }
  return <section><h3>Reviewed private-file cleanup</h3><p className="record-preserve-note">Archive never removes a file. Replaced/deleted metadata queues cleanup. Current references and retained employee-photo audit history prevent physical deletion. Processing jobs have no automatic expiry: after an interrupted worker, an operator must reconcile the object and reservation before retrying.</p>
    <select aria-label="Cleanup status" value={filter} onChange={event => setFilter(event.target.value)}>{["pending","retry","retained","processing","deleted","all"].map(value => <option key={value}>{value}</option>)}</select><button type="button" onClick={refresh}>Refresh cleanup queue</button>
    {message && <p role="status">{message}</p>}
    {items.filter(item => filter === "all" || item.status === filter).map(item => <article className="record-cleanup-row" key={item.id}><b>#{item.id} · {item.bucket}</b><p>{item.path}</p><p>{item.status} · {item.attempts} attempt(s)</p><p>{item.last_error}</p>{["pending","retry","retained"].includes(item.status) && <button type="button" onClick={() => { setSelected(item); setPhrase(""); }}>Review permanent file removal</button>}</article>)}
    {selected && <RecordDialog title={"Permanently remove orphan #" + selected.id} onClose={close}><form onSubmit={remove}><p>{selected.bucket}/{selected.path}</p><p>This private file cannot be restored after removal. The server will recheck references and reserve this path before deleting it.</p><label>Type {confirmationPhrase("cleanup",selected.id)}<input value={phrase} onChange={event => setPhrase(event.target.value)}/></label>{message && <p role="alert">{message}</p>}<div className="record-dialog-actions"><button type="button" disabled={busy} onClick={close}>Cancel</button><button disabled={busy || phrase !== confirmationPhrase("cleanup",selected.id)}>Permanently remove file</button></div></form></RecordDialog>}
  </section>;
}
