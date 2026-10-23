import React, { useCallback, useEffect, useState } from "react";
import { Check, Copy, RefreshCw, Send, Trash2 } from "lucide-react";
import { apiUrl, readApiResponse } from "../api.js";
import { supabase } from "../supabase.js";
import "./telegramIntegration.css";

const EMPTY = { guards: [], supervisors: [], field_officers: [], sites: [] };

async function postAdmin(body) {
  const { data, error } = await supabase.auth.getSession();
  if (error || !data.session?.access_token) throw new Error("Sign in again to manage Telegram Integration.");
  const response = await fetch(apiUrl("/api/integrations/telegram/admin"), {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${data.session.access_token}` }, body: JSON.stringify(body),
  });
  return readApiResponse(response);
}

function aliasTarget(alias, directory) {
  if (alias.entity_type === "site") return directory.sites.find(row => row.id === alias.site_id)?.title || `Site ${alias.site_id}`;
  if (alias.entity_type === "note") return alias.replacement || "Note expansion";
  const key = `${alias.entity_type}s`;
  const list = directory[key] || [];
  const id = alias[`${alias.entity_type}_id`];
  const person = list.find(row => row.id === id);
  return person ? `${person.full_name} (${person.employee_code})` : `Employee ${id}`;
}

export default function TelegramIntegration() {
  const [data, setData] = useState({ linked: null, aliases: [], activity: [], directory: EMPTY, configured: false });
  const [aliasForm, setAliasForm] = useState({ alias: "", entity_type: "guard", employee_id: "", site_id: "", replacement: "" });
  const [linkCode, setLinkCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const refresh = useCallback(async () => {
    setBusy(true); setMessage("");
    try { setData(await postAdmin({ action: "status" })); }
    catch (error) { setMessage(error.message); }
    finally { setBusy(false); }
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  async function generateCode() {
    setBusy(true); setMessage("");
    try {
      const result = await postAdmin({ action: "generate_link" });
      setLinkCode(result.code); setMessage("One-time code generated. Send /link followed by this code to the bot in a private chat. The code is shown only once and expires in 10 minutes.");
      await refresh();
    } catch (error) { setMessage(error.message); }
    finally { setBusy(false); }
  }

  async function revokeLink() {
    setBusy(true); setMessage("");
    try { await postAdmin({ action: "revoke_link" }); setLinkCode(""); setMessage("Telegram link revoked."); await refresh(); }
    catch (error) { setMessage(error.message); }
    finally { setBusy(false); }
  }

  async function addAlias(event) {
    event.preventDefault(); setBusy(true); setMessage("");
    const request = { action: "add_alias", alias: aliasForm.alias, entity_type: aliasForm.entity_type };
    if (aliasForm.entity_type === "site") request.site_id = aliasForm.site_id;
    else if (aliasForm.entity_type === "note") request.replacement = aliasForm.replacement;
    else request.employee_id = aliasForm.employee_id;
    try { await postAdmin(request); setAliasForm({ ...aliasForm, alias: "", replacement: "" }); setMessage("Approved alias saved."); await refresh(); }
    catch (error) { setMessage(error.message); }
    finally { setBusy(false); }
  }

  async function removeAlias(aliasId) {
    setBusy(true); setMessage("");
    try { await postAdmin({ action: "delete_alias", alias_id: aliasId }); setMessage("Alias removed."); await refresh(); }
    catch (error) { setMessage(error.message); }
    finally { setBusy(false); }
  }

  const employeeOptions = aliasForm.entity_type === "guard" ? data.directory.guards
    : aliasForm.entity_type === "supervisor" ? data.directory.supervisors
      : aliasForm.entity_type === "field_officer" ? data.directory.field_officers : [];

  return <div className="telegram-settings">
    <section className="telegram-settings-card" aria-labelledby="telegram-status-heading">
      <div className="telegram-settings-heading"><div><span className="eyebrow">PRIVATE OWNER ADMIN BOT</span><h3 id="telegram-status-heading">Bot connection</h3></div><button type="button" className="gss-admin-secondary" onClick={refresh} disabled={busy}><RefreshCw size={15}/> Refresh</button></div>
      <p className="telegram-settings-status"><span className={data.configured ? "telegram-dot online" : "telegram-dot"}/><b>{data.configured ? "Bot credentials configured" : "Bot unavailable until credentials are configured"}</b></p>
      {!data.configured && <p className="telegram-settings-note">Set TELEGRAM_BOT_TOKEN and a 32-character-or-longer TELEGRAM_WEBHOOK_SECRET in the server's Vercel Production environment. These values stay server-side; they are never shown here.</p>}
      {data.linked ? <div className="telegram-link-card"><div><b>Linked Telegram user ID</b><strong>{data.linked.telegram_user_id}</strong><small>Linked {new Date(data.linked.linked_at).toLocaleString("en-IN")}</small></div><button type="button" className="gss-admin-danger" onClick={revokeLink} disabled={busy}><Trash2 size={15}/> Revoke link</button></div>
        : <div className="telegram-link-actions"><p>No Telegram account is linked.</p><button type="button" className="gss-admin-primary" onClick={generateCode} disabled={busy}><Send size={15}/> Generate one-time link code</button></div>}
      {linkCode && <div className="telegram-code" role="status"><code>{linkCode}</code><button type="button" className="gss-admin-secondary" onClick={() => navigator.clipboard?.writeText(linkCode)} aria-label="Copy Telegram linking code"><Copy size={15}/> Copy</button><p>Send <code>/link {linkCode}</code> to the configured bot from the owner's private Telegram chat.</p></div>}
    </section>

    <section className="telegram-settings-card" aria-labelledby="telegram-alias-heading">
      <div className="telegram-settings-heading"><div><span className="eyebrow">DETERMINISTIC MATCHING</span><h3 id="telegram-alias-heading">Approved aliases and abbreviation dictionary</h3></div></div>
      <p className="telegram-settings-note">The bot matches real employee and Site records. Unrecognized abbreviations such as “pp”, “gp”, or “SL” are not guessed. Map an abbreviation only after its meaning is confirmed.</p>
      <form className="telegram-alias-form" onSubmit={addAlias}>
        <label>Alias or abbreviation<input required maxLength="100" value={aliasForm.alias} onChange={event => setAliasForm({ ...aliasForm, alias: event.target.value })} placeholder="e.g. srekant or VK Enclave"/></label>
        <label>Meaning<select value={aliasForm.entity_type} onChange={event => setAliasForm({ ...aliasForm, entity_type: event.target.value, employee_id: "", site_id: "" })}><option value="guard">Security Guard</option><option value="supervisor">Supervisor</option><option value="field_officer">Field Officer</option><option value="site">Site</option><option value="note">Note abbreviation</option></select></label>
        {aliasForm.entity_type === "site" ? <label>Active Site<select required value={aliasForm.site_id} onChange={event => setAliasForm({ ...aliasForm, site_id: event.target.value })}><option value="">Choose a Site</option>{data.directory.sites.map(site => <option key={site.id} value={site.id}>{site.title} · {site.site_code || site.id}</option>)}</select></label>
          : aliasForm.entity_type === "note" ? <label>Confirmed expansion<input required maxLength="100" value={aliasForm.replacement} onChange={event => setAliasForm({ ...aliasForm, replacement: event.target.value })} placeholder="e.g. payer present"/></label>
            : <label>Active employee<select required value={aliasForm.employee_id} onChange={event => setAliasForm({ ...aliasForm, employee_id: event.target.value })}><option value="">Choose an employee</option>{employeeOptions.map(person => <option key={person.id} value={person.id}>{person.full_name} · {person.employee_code}</option>)}</select></label>}
        <button className="gss-admin-primary" type="submit" disabled={busy}><Check size={15}/> Save approved alias</button>
      </form>
      {data.aliases.length ? <div className="telegram-alias-list">{data.aliases.map(alias => <div key={alias.id}><span><b>{alias.alias}</b><small>{alias.entity_type === "note" ? "Confirmed note" : alias.entity_type.replaceAll("_", " ")} → {aliasTarget(alias, data.directory)}</small></span><button type="button" className="gss-admin-danger" onClick={() => removeAlias(alias.id)} disabled={busy} aria-label={`Remove alias ${alias.alias}`}><Trash2 size={15}/></button></div>)}</div> : <p className="gss-admin-empty">No aliases configured.</p>}
    </section>

    <section className="telegram-settings-card" aria-labelledby="telegram-activity-heading">
      <div className="telegram-settings-heading"><div><span className="eyebrow">SANITIZED AUDIT TRAIL</span><h3 id="telegram-activity-heading">Recent Telegram activity</h3></div></div>
      {data.activity.length ? <div className="telegram-activity-list">{data.activity.map(item => <div key={item.id}><b>{item.event_type.replaceAll("_", " ")}</b><span>{item.telegram_user_id ? `Telegram ID ${item.telegram_user_id}` : "Owner admin"}{item.advance_id ? ` · Advance ${item.advance_id}` : ""}</span><time>{new Date(item.created_at).toLocaleString("en-IN")}</time></div>)}</div> : <p className="gss-admin-empty">No activity recorded yet.</p>}
    </section>
    {message && <p className="gss-admin-message" role="status">{message}</p>}
  </div>;
}
