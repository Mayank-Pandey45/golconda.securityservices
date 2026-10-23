import RecordActions, { RecordFilter } from "./RecordActions.jsx";
import { matchesRecordState } from "../../shared/recordLifecycle.js";
import { recordRequest, queueOrphan } from "./recordClient.js";
import React, { useEffect, useState } from "react";
import { ArrowUpRight, FileText, Image as ImageIcon, Pencil, Plus, Upload, Video, X } from "lucide-react";
import { supabase } from "../supabase";
import "./profileVault.css";

const BUCKET = "company-profile";
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const allowedMimeTypes = new Set([
  "image/jpeg", "image/png", "image/webp", "application/pdf", "video/mp4",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);
const categories = ["Company Profile", "Registration & Compliance", "Brochure", "Team & Guards", "Deployment", "Company Activities", "Other"];
const initialForm = { title: "", description: "", category: "Company Profile", file_url: "", storage_path: "", mime_type: "", media_type: "document", is_public: false, sort_order: "0" };

function mediaTypeFor(mimeType) {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType === "application/pdf") return "pdf";
  return "document";
}

function safeExternalUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : "";
  } catch {
    return "";
  }
}

export default function ProfileVault({ items = [], onRefresh, onMetricsRefresh }) {
  const [form, setForm] = useState(initialForm);
  const [recordFilter, setRecordFilter] = useState("all");
  const [editingId, setEditingId] = useState(null);
  const [selectedFile, setSelectedFile] = useState(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [previewUrls, setPreviewUrls] = useState({});

  useEffect(() => {
    let current = true;
    async function loadPreviews() {
      const entries = await Promise.all(items.map(async item => {
        if (!item.storage_path) return [item.id, safeExternalUrl(item.file_url)];
        const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(item.storage_path, 600);
        return [item.id, error ? "" : data?.signedUrl || ""];
      }));
      if (current) setPreviewUrls(Object.fromEntries(entries));
    }
    loadPreviews();
    return () => { current = false; };
  }, [items]);

  function resetForm() {
    setForm(initialForm);
    setEditingId(null);
    setSelectedFile(null);
  }

  function startEditing(item) {
    setEditingId(item.id);
    setSelectedFile(null);
    setForm({
      title: item.title || "", description: item.description || "", category: item.category || "Other",
      file_url: item.file_url || "", storage_path: item.storage_path || "", mime_type: item.mime_type || "",
      media_type: item.media_type || "document", is_public: item.is_public === true, sort_order: String(item.sort_order ?? 0),
    });
    setMessage("");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function uploadSelectedFile(file) {
    if (!allowedMimeTypes.has(file.type)) throw new Error("Choose a JPEG, PNG, WebP, PDF, MP4, DOCX, or XLSX file.");
    if (file.size > MAX_FILE_BYTES) throw new Error("The file must be 20 MB or smaller.");
    const filename = file.name.normalize("NFKD").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(-120) || "profile-file";
    const objectPath = `${crypto.randomUUID()}/${filename}`;
    const { error } = await supabase.storage.from(BUCKET).upload(objectPath, file, {
      cacheControl: "3600", upsert: false, contentType: file.type,
    });
    if (error) throw new Error(`File upload failed: ${error.message}`);
    return objectPath;
  }

  async function saveDocument(event) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    let uploadedPath = "";
    let recordSaved = false;
    try {
      const wasEditing = Boolean(editingId);
      const previousItem = items.find(item => item.id === editingId);
      const previousPath = previousItem?.storage_path;
      if (!form.title.trim()) throw new Error("Document title is required.");
      if (form.is_public && (!editingId || !items.find(item => item.id === editingId)?.is_public)) {
        const approved = window.confirm("This file will be visible to anyone on the public company profile. Confirm that it contains no identity documents, personal records, payroll, or confidential information.");
        if (!approved) throw new Error("Public publishing was cancelled.");
      }
      let fileUrl = form.file_url.trim() ? safeExternalUrl(form.file_url.trim()) : null;
      let storagePath = form.storage_path || null;
      let mimeType = form.mime_type || "";
      let mediaType = form.media_type || "document";
      if (form.file_url.trim() && !fileUrl) {
        const unchangedLegacyUrl = previousItem?.file_url === form.file_url.trim();
        if (!unchangedLegacyUrl || form.is_public) throw new Error("Use a secure HTTPS file URL before publishing or changing this link.");
        fileUrl = form.file_url.trim();
      }
      if (selectedFile) {
        setUploading(true);
        try { uploadedPath = await uploadSelectedFile(selectedFile); }
        finally { setUploading(false); }
        storagePath = uploadedPath;
        fileUrl = null;
        mimeType = selectedFile.type;
        mediaType = mediaTypeFor(mimeType);
      }
      if (!storagePath && !fileUrl) throw new Error("Upload a file or provide a secure HTTPS file URL.");

      const payload = {
        title: form.title.trim(), description: form.description.trim(), category: form.category,
        file_url: fileUrl, storage_path: storagePath, mime_type: mimeType, media_type: mediaType,
        is_public: form.is_public, sort_order: Number(form.sort_order) || 0,
      };
      const result = await recordRequest({ module: "profileDocs", id: editingId, action: "save", patch: payload });
      if (!result.id) throw new Error("The profile record was not saved.");
      recordSaved = true;

      resetForm();
      await onRefresh();
      await onMetricsRefresh();
      setMessage(wasEditing ? "Profile file updated. Replaced files require reviewed cleanup." : "Profile file saved.");
    } catch (error) {
      const orphanMessage = uploadedPath && !recordSaved ? await queueOrphan(BUCKET, uploadedPath) : "";
      setMessage(error.message + " " + orphanMessage);
    } finally {
      setUploading(false);
      setBusy(false);
    }
  }


  return <div className="gss-profile-vault">
    <form className="gss-admin-form" onSubmit={saveDocument}>
      <h3>{editingId ? "Edit company profile file" : "Add company profile file"}</h3>
      <p className="profile-vault-warning">Only publish material intended for anyone to view. Never upload or publish employee identity documents, personal records, payroll, or confidential client information.</p>
      <label>Title<input required maxLength="160" value={form.title} onChange={event => setForm({ ...form, title: event.target.value })} placeholder="Company brochure, GST registration…"/></label>
      <label>Category<select value={form.category} onChange={event => setForm({ ...form, category: event.target.value })}>{categories.map(category => <option key={category}>{category}</option>)}</select></label>
      <label className="full">Description<input maxLength="500" value={form.description} onChange={event => setForm({ ...form, description: event.target.value })} placeholder="Short description of this public company material"/></label>
      <label className="full">Upload a file<input type="file" accept="image/jpeg,image/png,image/webp,application/pdf,video/mp4,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={event => setSelectedFile(event.target.files?.[0] || null)}/><small>Private storage until approved. Maximum 20 MB. Images, PDF, MP4, DOCX, and XLSX.</small></label>
      {uploading && <div className="file-upload-progress full" role="status"><progress aria-label="Uploading company profile file"/><span>Uploading file… Keep this page open until it finishes.</span></div>}
      <label className="full">Or use an existing HTTPS URL<input type="url" value={form.file_url} onChange={event => setForm({ ...form, file_url: event.target.value, storage_path: "" })} placeholder="https://…"/><small>Leave blank when uploading a file. An uploaded file takes priority.</small></label>
      <label>Display Order<input type="number" min="0" max="10000" value={form.sort_order} onChange={event => setForm({ ...form, sort_order: event.target.value })}/></label>
      <label className="profile-publish-option"><input type="checkbox" checked={form.is_public} onChange={event => setForm({ ...form, is_public: event.target.checked })}/><span>Approve for the public company profile</span></label>
      <div className="gss-admin-form-actions"><button className="gss-admin-primary" type="submit" disabled={busy}><Upload size={15}/>{editingId ? "Save File" : "Save Profile File"}</button>{editingId && <button className="gss-admin-secondary" type="button" onClick={resetForm}><X size={15}/> Cancel</button>}</div>
    </form>

    {message && <p className="gss-admin-message" role="status">{message}</p>}
    <div className="gss-admin-list-heading"><h3>Profile vault · {items.length} records</h3><button className="gss-admin-secondary" type="button" onClick={onRefresh}>Refresh</button></div>
    <RecordFilter value={recordFilter} onChange={setRecordFilter}/>{items.length === 0 ? <p className="gss-admin-empty">No profile files have been added.</p> : <div className="profile-vault-list">{items.filter(item => matchesRecordState("profileDocs", item, recordFilter)).map(item => {
      const preview = previewUrls[item.id];
      return <article className="gss-admin-item" key={item.id}>
        <div className="gss-admin-item-copy">
          <strong>{item.title}</strong><p>{item.description || "No description."}</p>
          <div className="site-details"><span><b>Category:</b> {item.category || "Other"}</span><span><b>File:</b> {item.mime_type || "External link"}</span><span><b>Status:</b> {item.is_public ? "Approved for public profile" : "Private draft"}</span></div>
          {preview && item.media_type === "image" && <img className="profile-vault-thumb" src={preview} alt="Private admin preview"/>}
          {preview && item.media_type === "video" && <video className="profile-vault-thumb" src={preview} controls preload="metadata" aria-label={`Preview ${item.title}`}/>}
          {preview && <a href={preview} target="_blank" rel="noopener noreferrer" className="text-link" style={{marginTop: 8}}>View file <ArrowUpRight size={14}/></a>}
        </div>
        <div className="gss-admin-item-actions"><button type="button" disabled={Boolean(item.archived_at)} onClick={() => startEditing(item)}><Pencil size={15}/> Edit</button><RecordActions module={"profileDocs"} item={item} onChanged={async () => { await onRefresh(); await onMetricsRefresh(); }} onEditingDeleted={() => { if (editingId === item.id) resetForm(); }}/></div>
      </article>;
    })}</div>}
  </div>;
}
