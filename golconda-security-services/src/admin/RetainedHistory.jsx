import React, { useEffect, useState } from "react";
import { supabase } from "../supabase.js";

const tables = ["operations_audit_log","employee_compensation","guard_site_assignments","supervisor_site_assignments","field_officer_site_assignments","supervisor_reporting","advances","advance_adjustments","advance_recoveries","salary_adjustments","advance_sheet_sync_outbox"];
export default function RetainedHistory() {
  const [table, setTable] = useState(tables[0]);
  const [rows, setRows] = useState([]);
  const [page, setPage] = useState(0);
  const [message, setMessage] = useState("");
  useEffect(() => {
    let current = true;
    const columns = table === "operations_audit_log" ? "id,table_name,record_id,action,actor_id,occurred_at" : "*";
    supabase.from(table).select(columns).order(table === "advance_sheet_sync_outbox" ? "advance_id" : "id", { ascending: false }).range(page * 50, page * 50 + 49).then(({ data, error }) => {
      if (!current) return;
      setRows(error ? [] : data || []); setMessage(error ? "History could not be loaded. Verify your administrator session and RLS access." : "");
    });
    return () => { current = false; };
  }, [table,page]);
  return <section><h3>Retained operational history</h3><p className="record-preserve-note">Read-only history. Close assignments through the employee/site editors. Correct financial entries through the existing adjustment, recovery and approval workflows. Audit entries and integration delivery state cannot be edited, deleted, archived or restored here. Archive does not stop payroll accrual or cancel outstanding advances.</p><label>History table<select value={table} onChange={event => { setTable(event.target.value); setPage(0); }}>{tables.map(value => <option key={value}>{value}</option>)}</select></label>{message && <p role="alert">{message}</p>}{rows.map(row => <article className="record-cleanup-row" key={row.id || row.advance_id}><dl>{Object.entries(row).map(([key,value]) => <div key={key}><dt>{key.replaceAll("_"," ")}</dt><dd>{value === null ? "—" : typeof value === "object" ? JSON.stringify(value) : String(value)}</dd></div>)}</dl></article>)}<button type="button" disabled={!page} onClick={() => setPage(value => value - 1)}>Previous 50</button><span> Page {page + 1} </span><button type="button" disabled={rows.length < 50} onClick={() => setPage(value => value + 1)}>Next 50</button></section>;
}
