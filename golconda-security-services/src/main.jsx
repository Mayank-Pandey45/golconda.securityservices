import React, { useEffect, useState } from "react";
import { supabase, supabaseError } from "./supabase";
import { apiUrl, readApiResponse } from "./api";
import { formatUtcDate, toDateInputValue, toUtcDateTimestamp } from "./dateOnly";
import { toDateTimeLocalValue, toUtcDateTime, safeNotificationHref } from "./notificationRules.js";
import { prioritizeNotifications } from "./notificationRules.js";
import { scrollToPublicSection } from "./publicNavigation.js";
import CompanyProfile from "./CompanyProfile.jsx";
import GuardManagement from "./admin/GuardManagement.jsx";
import ProfileVault from "./admin/ProfileVault.jsx";
import SiteManagement from "./admin/SiteManagement.jsx";
import PeopleManagement from "./admin/PeopleManagement.jsx";
import AdvancesManagement from "./admin/AdvancesManagement.jsx";
import AnnouncementBanner from "./AnnouncementBanner.jsx";
import { createRoot } from "react-dom/client";
import {
  Shield, ShieldCheck, Menu, X, ArrowUpRight, ArrowRight, LockKeyhole,
  Globe, Code2, GraduationCap, UserRound, Bell, CalendarDays, Users,
  FileText, Mail, Phone, MapPin, ChevronRight, CheckCircle2, LogOut, Plus, Trash2, Pencil, RefreshCw, AlertCircle, Building2
} from "lucide-react";
import "./styles.css";

const serviceIconMap = { "shield-check": ShieldCheck, shield: Shield, globe: Globe, code: Code2, "graduation-cap": GraduationCap };

async function fetchAllSupabaseRows(table, columns = "*") {
  const allRows = [];
  const pageSize = 1000;
  for (let from = 0; from < 1000000; from += pageSize) {
    const { data, error } = await supabase.from(table).select(columns).order("id", { ascending: true }).range(from, from + pageSize - 1);
    if (error) return { data: null, error };
    allRows.push(...(data || []));
    if (!data || data.length < pageSize) break;
  }
  return { data: allRows, error: null };
}

function Brand({ footer = false }) {
  return <a className={`brand ${footer ? "brand-footer" : ""}`} href="/#home" aria-label="Golconda Security Services home">
    <img className="brand-logo-image" src="/gss-logo.png" alt="Golconda Security Services logo" />
    <span className="brand-copy"><strong>GOLCONDA</strong><small>SECURITY SERVICES</small></span>
  </a>;
}

function SectionHeading({ eyebrow, title, subtitle, align = "center" }) {
  return <div className={`section-heading ${align === "left" ? "align-left" : ""}`}>
    {eyebrow && <span className="eyebrow">{eyebrow}</span>}
    <h2>{title}</h2>
    {subtitle && <p>{subtitle}</p>}
  </div>;
}

function App() {
  const isCompanyProfile = /^\/company-profile\/?$/.test(window.location.pathname);
  const [menuOpen, setMenuOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const [publicContent, setPublicContent] = useState({ services: [], events: [], notifications: [] });
  const [publicContentLoading, setPublicContentLoading] = useState(true);
  const [publicContentError, setPublicContentError] = useState("");
  const [profileDocuments, setProfileDocuments] = useState([]);
  const [profileLoading, setProfileLoading] = useState(true);
  const [profileError, setProfileError] = useState("");
  const [notificationNow, setNotificationNow] = useState(Date.now());
  const [showAllPublicNotifications, setShowAllPublicNotifications] = useState(false);
  const [contact, setContact] = useState({ name: "", email: "", service: "Web Security", message: "" });
  const [application, setApplication] = useState({ name: "", email: "", role: "Security Guard / ASO", message: "" });
  const [complaintForm, setComplaintForm] = useState({ complainant_name: "", role: "Security Guard", phone: "", subject: "", details: "" });
  
  const [loginOpen, setLoginOpen] = useState(false);
  const [login, setLogin] = useState({ userId: "", password: "" });
  const [loginMessage, setLoginMessage] = useState("");
  
  const [adminMode, setAdminMode] = useState(false);
  const [adminEmail, setAdminEmail] = useState("");
  const [adminTab, setAdminTab] = useState("overview");
  const [dashboardMetrics, setDashboardMetrics] = useState(null);
  const [adminSearch, setAdminSearch] = useState("");
  
  // Admin Data State
  const [adminItems, setAdminItems] = useState({
    events: [],
    notifications: [],
    services: [],
    sites: [],
    guards: [],
    supervisors: [],
    fieldOfficers: [],
    advances: [],
    profileDocs: [],
    complaints: [],
    contactSubmissions: [],
    jobApplications: []
  });
  const [adminLoading, setAdminLoading] = useState(false);
  const [adminMessage, setAdminMessage] = useState("");
  const [editingId, setEditingId] = useState(null);

  // Forms for different admin tabs
  const [itemForm, setItemForm] = useState({
    title: "", description: "", event_date: "", image_url: "", message: "", tag: "", icon_key: "shield-check", sort_order: "0", event_type: "COMMUNITY", display_status: "", notification_type: "COMPANY UPDATE", display_date: "",
    notification_severity: "announcement", starts_at: "", expires_at: "", is_active: true, is_published: false, dismissible: true, button_label: "", button_url: "",
    // Site specific fields
    phone_numbers: "", total_salary: "", service_taken: "SECURITY GUARD", given_emails: "", supervisor_name: "", field_officer_name: "",
    // Guard fields
    full_name: "", phone: "", email: "", designation: "Security Guard", status: "active", joining_date: "", site_id: "",
    // Profile doc specific fields
    file_title: "", file_description: "", file_url: ""
  });

  const adminTabsConfig = {
    overview: { title: "Dashboard Overview", description: "Summary metrics of Golconda Security Services operations." },
    events: { title: "Manage Events", description: "Add, modify, or remove upcoming events and awareness programs." },
    notifications: { title: "Manage Notifications", description: "Publish announcements and safety updates." },
    services: { title: "Manage Services", description: "Configure physical security and cybersecurity services." },
    sites: { title: "Sites & Deployments", description: "Manage deployment sites, supervisors, field officers, phone numbers & emails." },
    guards: { title: "Guard Directory", description: "Manage guard records and assign each guard to one or more sites." },
    supervisors: { title: "Supervisors", description: "Manage supervisor profiles, site assignments, reporting relationships, and compensation." },
    fieldOfficers: { title: "Field Officers", description: "Manage field officer profiles, site assignments, reporting relationships, and compensation." },
    advances: { title: "Advances & Salary Estimates", description: "Record advances, recover them once against a salary period, and review a transparent monthly estimate." },
    profileDocs: { title: "Company Profile Vault", description: "Upload and organize company documents, certifications, and media files." },
    complaints: { title: "Complaints Register", description: "Review and resolve complaints submitted by guards, supervisors, and clients." },
    contactSubmissions: { title: "Contact Enquiries", description: "Review website enquiries stored in the database." },
    jobApplications: { title: "Job Applications", description: "Review applications and job interest submissions." }
  };

  useEffect(() => {
    let active = true;
    async function loadPublicContent() {
      if (!supabase) {
        setPublicContentError(supabaseError || "Public content database is not configured.");
        setPublicContentLoading(false);
        return;
      }
      const [services, events, notifications] = await Promise.all([
        supabase.from("services").select("id,title,description,image_url,tag,icon_key,sort_order,created_at").order("sort_order", { ascending: true }).order("created_at", { ascending: true }),
        supabase.from("events").select("id,title,description,event_date,image_url,event_type,display_status,sort_order,created_at").order("sort_order", { ascending: true }).order("created_at", { ascending: false }),
        supabase.from("notifications").select("id,title,message,notification_type,notification_severity,display_date,sort_order,created_at,starts_at,expires_at,is_active,is_published,dismissible,button_label,button_url").eq("is_published", true).eq("is_active", true).order("sort_order", { ascending: true }).order("created_at", { ascending: false })
      ]);
      if (!active) return;
      const error = services.error || events.error || notifications.error;
      if (error) {
        setPublicContentError(`Public content could not be loaded: ${error.message}`);
      } else {
        setPublicContent({ services: services.data || [], events: events.data || [], notifications: notifications.data || [] });
        setPublicContentError("");
      }
      setPublicContentLoading(false);
    }
    loadPublicContent();
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!isCompanyProfile && !adminMode && !publicContentLoading) {
      scrollToPublicSection({ hash: window.location.hash, document: window.document });
    }
  }, [isCompanyProfile, adminMode, publicContentLoading]);

  async function loadPublicProfile() {
    setProfileLoading(true);
    setProfileError("");
    try {
      const response = await fetch(apiUrl("/api/profile"), { cache: "no-store" });
      const result = await readApiResponse(response);
      if (!response.ok) throw new Error(result.error || "Approved company profile files could not be loaded.");
      setProfileDocuments(Array.isArray(result.documents) ? result.documents : []);
    } catch (error) {
      setProfileError(error.message);
    } finally {
      setProfileLoading(false);
    }
  }

  useEffect(() => { loadPublicProfile(); }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setNotificationNow(Date.now()), 30000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let active = true;
    async function restoreAdminSession() {
      if (!supabase) return;
      const { data } = await supabase.auth.getSession();
      const user = data?.session?.user;
      if (!user || !active) return;
      const { data: admin } = await supabase.from("admin_users").select("user_id").eq("user_id", user.id).maybeSingle();
      if (admin && active) {
        setAdminEmail(user.email || "Admin");
        setAdminMode(!isCompanyProfile);
      } else {
        await supabase.auth.signOut();
      }
    }
    restoreAdminSession();
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!adminMode) return;
    if (adminTab === "overview") loadDashboardMetrics();
    else if (adminTab === "advances") {
      Promise.all([loadAdminItems("guards"), loadAdminItems("supervisors"), loadAdminItems("fieldOfficers"), loadAdminItems("sites")]);
    } else loadAdminItems(adminTab);
  }, [adminMode, adminTab]);

  async function loadDashboardMetrics() {
    if (!supabase) return;
    setAdminLoading(true);
    setAdminMessage("");
    const keys = ["guards", "sites", "supervisors", "field_officers", "advances", "services", "events", "notifications", "complaints", "contact_submissions", "job_applications", "profile_docs"];
    const results = await Promise.all(keys.map(table => supabase.from(table).select("id", { count: "exact", head: true })));
    const failed = results.find(result => result.error);
    if (failed) {
      setDashboardMetrics(null);
      setAdminMessage(`Dashboard counts could not load: ${failed.error.message}`);
    } else {
      setDashboardMetrics(Object.fromEntries(keys.map((key, index) => [key, results[index].count ?? 0])));
    }
    setAdminLoading(false);
  }

  async function loadAdminItems(tabKey) {
    if (!supabase) return;
    setAdminLoading(true);
    setAdminMessage("");
    const tableName = ({ profileDocs: "profile_docs", contactSubmissions: "contact_submissions", jobApplications: "job_applications" })[tabKey] || tabKey;
    let result;
    if (tabKey === "sites") {
      const [sites, guards, supervisors, fieldOfficers, guardAssignments, supervisorAssignments, fieldOfficerAssignments] = await Promise.all([
        fetchAllSupabaseRows("sites"),
        fetchAllSupabaseRows("guards", "id,full_name,employee_code,status,site_id"),
        fetchAllSupabaseRows("supervisors", "id,full_name,employee_code,status"),
        fetchAllSupabaseRows("field_officers", "id,full_name,employee_code,status"),
        fetchAllSupabaseRows("guard_site_assignments", "id,guard_id,site_id,valid_from,valid_to"),
        fetchAllSupabaseRows("supervisor_site_assignments", "id,supervisor_id,site_id,valid_from,valid_to"),
        fetchAllSupabaseRows("field_officer_site_assignments", "id,field_officer_id,site_id,valid_from,valid_to")
      ]);
      const failed = [sites, guards, supervisors, fieldOfficers, guardAssignments, supervisorAssignments, fieldOfficerAssignments].find(item => item.error);
      result = failed ? failed : { data: sites.data.map(site => ({
        ...site,
        guard_records: guardAssignments.data.filter(row => row.site_id === site.id && !row.valid_to).map(row => guards.data.find(person => person.id === row.guard_id)).filter(Boolean),
        supervisor_records: supervisorAssignments.data.filter(row => row.site_id === site.id && !row.valid_to).map(row => supervisors.data.find(person => person.id === row.supervisor_id)).filter(Boolean),
        field_officer_records: fieldOfficerAssignments.data.filter(row => row.site_id === site.id && !row.valid_to).map(row => fieldOfficers.data.find(person => person.id === row.field_officer_id)).filter(Boolean)
      })) };
      if (!failed) {
        const activeGuardRows = guards.data.map(person => ({ ...person,
          site_records: guardAssignments.data.filter(row => row.guard_id === person.id && !row.valid_to).map(row => sites.data.find(site => site.id === row.site_id)).filter(Boolean),
        }));
        const activeSupervisorRows = supervisors.data.map(person => ({ ...person,
          site_records: supervisorAssignments.data.filter(row => row.supervisor_id === person.id && !row.valid_to).map(row => sites.data.find(site => site.id === row.site_id)).filter(Boolean),
        }));
        const activeOfficerRows = fieldOfficers.data.map(person => ({ ...person,
          site_records: fieldOfficerAssignments.data.filter(row => row.field_officer_id === person.id && !row.valid_to).map(row => sites.data.find(site => site.id === row.site_id)).filter(Boolean),
        }));
        setAdminItems(previous => ({ ...previous, guards: activeGuardRows, supervisors: activeSupervisorRows, fieldOfficers: activeOfficerRows }));
      }
    } else if (tabKey === "guards") {
      const [guards, sites, assignments] = await Promise.all([
        fetchAllSupabaseRows("guards"),
        fetchAllSupabaseRows("sites", "id,title,site_code"),
        fetchAllSupabaseRows("guard_site_assignments", "id,guard_id,site_id,valid_from,valid_to")
      ]);
      const failed = [guards, sites, assignments].find(item => item.error);
      result = failed ? failed : { data: guards.data.map(guard => ({
        ...guard,
        site_records: assignments.data.filter(row => row.guard_id === guard.id && !row.valid_to).map(row => sites.data.find(site => site.id === row.site_id)).filter(Boolean),
        site_title: assignments.data.filter(row => row.guard_id === guard.id && !row.valid_to).map(row => sites.data.find(site => site.id === row.site_id)?.title).filter(Boolean).join(", ") || "Unassigned"
      })) };
      if (!sites.error) setAdminItems(previous => ({ ...previous, sites: sites.data }));
    } else if (tabKey === "supervisors" || tabKey === "fieldOfficers") {
      const isSupervisor = tabKey === "supervisors";
      const table = isSupervisor ? "supervisors" : "field_officers";
      const assignmentTable = isSupervisor ? "supervisor_site_assignments" : "field_officer_site_assignments";
      const relationKey = isSupervisor ? "supervisor_id" : "field_officer_id";
      const [people, sites, assignments] = await Promise.all([
        fetchAllSupabaseRows(table), fetchAllSupabaseRows("sites", "id,title,site_code"),
        fetchAllSupabaseRows(assignmentTable, `id,${relationKey},site_id,valid_from,valid_to`)
      ]);
      const failed = [people, sites, assignments].find(item => item.error);
      result = failed ? failed : { data: people.data.map(person => ({
        ...person,
        site_records: assignments.data.filter(row => row[relationKey] === person.id && !row.valid_to).map(row => sites.data.find(site => site.id === row.site_id)).filter(Boolean)
      })) };
      if (!sites.error) setAdminItems(previous => ({ ...previous, sites: sites.data }));
    } else {
      result = await fetchAllSupabaseRows(tableName);
    }
    const { data, error } = result;
    if (error) {
      setAdminMessage(`Could not load ${tabKey}: ${error.message}`);
    } else if (data) {
      setAdminItems(prev => ({ ...prev, [tabKey]: data }));
    }
    setAdminLoading(false);
  }

  function resetItemForm() {
    setEditingId(null);
    setItemForm({
      title: "", description: "", event_date: "", image_url: "", message: "", tag: "", icon_key: "shield-check", sort_order: "0", event_type: "COMMUNITY", display_status: "", notification_type: "COMPANY UPDATE", display_date: "",
      notification_severity: "announcement", starts_at: "", expires_at: "", is_active: true, is_published: false, dismissible: true, button_label: "", button_url: "",
      phone_numbers: "", total_salary: "", service_taken: "SECURITY GUARD", given_emails: "", supervisor_name: "", field_officer_name: "",
      full_name: "", phone: "", email: "", designation: "Security Guard", status: "active", joining_date: "", site_id: "",
      file_title: "", file_description: "", file_url: ""
    });
  }

  function startEditing(item, tabKey) {
    setEditingId(item.id);
    setItemForm({
      title: item.title || "",
      description: item.description || "",
      event_date: toDateInputValue(item.event_date),
      image_url: item.image_url || "",
      message: item.message || "",
      tag: item.tag || "",
      icon_key: item.icon_key || "shield-check",
      sort_order: String(item.sort_order ?? 0),
      event_type: item.event_type || "COMMUNITY",
      display_status: item.display_status || "",
      notification_type: item.notification_type || "COMPANY UPDATE",
      display_date: item.display_date || "",
      notification_severity: item.notification_severity || "announcement",
      starts_at: toDateTimeLocalValue(item.starts_at),
      expires_at: toDateTimeLocalValue(item.expires_at),
      is_active: item.is_active !== false,
      is_published: item.is_published === true,
      dismissible: item.dismissible !== false,
      button_label: item.button_label || "",
      button_url: item.button_url || "",
      phone_numbers: item.phone_numbers || "",
      total_salary: item.total_salary || "",
      service_taken: item.service_taken || "SECURITY GUARD",
      given_emails: item.given_emails || "",
      supervisor_name: item.supervisor_name || "",
      field_officer_name: item.field_officer_name || "",
      full_name: item.full_name || "",
      phone: item.phone || "",
      email: item.email || "",
      designation: item.designation || "Security Guard",
      status: item.status || "active",
      joining_date: item.joining_date || "",
      site_id: item.site_id ? String(item.site_id) : "",
      file_title: item.file_title || item.title || "",
      file_description: item.file_description || item.description || "",
      file_url: item.file_url || ""
    });
    setAdminMessage("");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function saveAdminItem(event) {
    event.preventDefault();
    setAdminMessage("");
    const tableName = ({ profileDocs: "profile_docs" })[adminTab] || adminTab;
    
    let payload = {};
    if (adminTab === "events") {
      payload = { title: itemForm.title.trim(), description: itemForm.description.trim(), event_date: toUtcDateTimestamp(itemForm.event_date), image_url: itemForm.image_url.trim() || null, event_type: itemForm.event_type.trim(), display_status: itemForm.display_status.trim(), sort_order: Number(itemForm.sort_order) || 0 };
    } else if (adminTab === "notifications") {
      const startsAt = toUtcDateTime(itemForm.starts_at);
      const expiresAt = toUtcDateTime(itemForm.expires_at);
      const buttonUrl = safeNotificationHref(itemForm.button_url);
      if ((itemForm.starts_at && !startsAt) || (itemForm.expires_at && !expiresAt)) {
        setAdminMessage("Notification start and expiry must be valid dates.");
        return;
      }
      if (startsAt && expiresAt && Date.parse(expiresAt) <= Date.parse(startsAt)) {
        setAdminMessage("Notification expiry must be later than its start time.");
        return;
      }
      if ((itemForm.button_label.trim() || itemForm.button_url.trim()) && (!itemForm.button_label.trim() || !buttonUrl)) {
        setAdminMessage("Add both a button label and a safe HTTPS or same-site destination URL.");
        return;
      }
      payload = {
        title: itemForm.title.trim(), message: itemForm.message.trim(),
        notification_type: itemForm.notification_type.trim(), display_date: itemForm.display_date.trim(),
        notification_severity: itemForm.notification_severity, starts_at: startsAt, expires_at: expiresAt,
        is_active: itemForm.is_active, is_published: itemForm.is_published, dismissible: itemForm.dismissible,
        button_label: itemForm.button_label.trim() || null, button_url: buttonUrl || null,
        sort_order: Number(itemForm.sort_order) || 0,
      };
    } else if (adminTab === "services") {
      payload = { title: itemForm.title.trim(), description: itemForm.description.trim(), image_url: itemForm.image_url.trim() || null, tag: itemForm.tag.trim(), icon_key: itemForm.icon_key, sort_order: Number(itemForm.sort_order) || 0 };
    } else if (adminTab === "sites") {
      payload = {
        title: itemForm.title.trim(),
        phone_numbers: itemForm.phone_numbers.trim(),
        total_salary: itemForm.total_salary.trim(),
        service_taken: itemForm.service_taken,
        given_emails: itemForm.given_emails.trim(),
        supervisor_name: itemForm.supervisor_name.trim(),
        field_officer_name: itemForm.field_officer_name.trim(),
        updated_at: new Date().toISOString()
      };
    }

    const query = supabase.from(tableName);
    const { error } = editingId
      ? await query.update(payload).eq("id", editingId)
      : await query.insert(payload);

    if (error) {
      setAdminMessage(`Save failed: ${error.message}`);
      return;
    }
    const successMessage = editingId ? "Changes saved successfully." : "Item added successfully.";
    resetItemForm();
    await loadAdminItems(adminTab);
    await loadDashboardMetrics();
    setAdminMessage(successMessage);
  }

  async function deleteAdminItem(item, tabKey) {
    if (!window.confirm(`Delete item? This cannot be undone.`)) return;
    const tableName = ({ profileDocs: "profile_docs", contactSubmissions: "contact_submissions", jobApplications: "job_applications" })[tabKey] || tabKey;
    const { error } = await supabase.from(tableName).delete().eq("id", item.id);
    if (error) setAdminMessage(`Delete failed: ${error.message}`);
    else {
      await loadAdminItems(tabKey);
      await loadDashboardMetrics();
      setAdminMessage("Item deleted successfully.");
    }
  }

  async function toggleComplaintStatus(complaint) {
    const status = complaint.status === "resolved" ? "pending" : "resolved";
    const { error } = await supabase.from("complaints").update({
      status,
      resolved_at: status === "resolved" ? new Date().toISOString() : null,
      updated_at: new Date().toISOString(),
    }).eq("id", complaint.id);
    if (error) setAdminMessage(`Complaint update failed: ${error.message}`);
    else {
      await loadAdminItems("complaints");
      await loadDashboardMetrics();
      setAdminMessage(`Complaint marked ${status}.`);
    }
  }

  async function handleAdminLogout() {
    await supabase?.auth.signOut();
    setAdminMode(false);
    setAdminEmail("");
    setLogin({ userId: "", password: "" });
    setLoginMessage("");
    setAdminMessage("");
  }

  const navItems = [
    ["Home", "#home"], ["Services", "#services"], ["Notifications", "#notifications"],
    ["Upcoming Events", "#events"], ["FAQ", "#faq"], ["Company Profile", "/company-profile"], ["Complaints", "#complaints"], ["Work With Us", "#careers"], ["Contact Us", "#contact"]
  ];

  async function submitForm(event, endpoint, payload, reset, successText) {
    event.preventDefault();
    setNotice("");
    try {
      const response = await fetch(apiUrl(`/api/${endpoint}`), {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload)
      });
      const result = await readApiResponse(response);
      if (!response.ok || result.ok !== true || !result.id) throw new Error(result.error || "The submission could not be confirmed as saved. Please retry or contact the company.");
      setNotice(result.message || successText);
      reset();
    } catch (error) {
      setNotice(`Submission failed: ${error.message}`);
    }
  }

  function openLogin() {
    setLoginOpen(true);
    setMenuOpen(false);
    setLoginMessage("");
  }

  async function handleLogin(event) {
    event.preventDefault();
    setLoginMessage("");
    if (!supabase) {
      setLoginMessage(supabaseError || "Authentication is not configured.");
      return;
    }

    try {
      const { data, error } = await supabase.auth.signInWithPassword({
        email: login.userId.trim(),
        password: login.password,
      });

      if (error || !data?.user) {
        setLoginMessage("Login failed. Check your email and password.");
        return;
      }

      const { data: admin, error: adminError } = await supabase
        .from("admin_users")
        .select("user_id")
        .eq("user_id", data.user.id)
        .maybeSingle();

      if (adminError || !admin) {
        await supabase.auth.signOut();
        setLoginMessage("Access denied. This account is not an authorized admin.");
        return;
      }

      setAdminEmail(data.user.email || login.userId.trim());
      setAdminMode(true);
      setLoginOpen(false);
      setLogin({ userId: "", password: "" });
      setLoginMessage("");
    } catch {
      setLoginMessage("Login could not be completed. Please try again.");
    }
  }

  const activePublicNotifications = prioritizeNotifications(publicContent.notifications, notificationNow);

  if (adminMode) {
    const currentItems = adminItems[adminTab] || [];
    const query = adminSearch.trim().toLowerCase();
    const visibleItems = query ? currentItems.filter(item => Object.values(item).some(value => String(value ?? "").toLowerCase().includes(query))) : currentItems;
    const totalGuardsCount = dashboardMetrics?.guards ?? "—";
    const totalSitesCount = dashboardMetrics?.sites ?? "—";
    const metric = (key) => dashboardMetrics?.[key] ?? "—";

    return <div className="gss-admin-shell">
      <style>{`
        .gss-admin-shell{min-height:100vh;background:#f4f6fa;color:#172033;font-family:Inter,system-ui,sans-serif}
        .gss-admin-header{height:auto;min-height:78px;padding:16px clamp(18px,5vw,64px);background:#101827;color:#fff;display:flex;align-items:center;justify-content:space-between;gap:18px;border-bottom:1px solid #283449}
        .gss-admin-brand,.gss-admin-account,.gss-admin-account button,.gss-admin-secondary,.gss-admin-primary,.gss-admin-item-actions button{display:flex;align-items:center;gap:10px}
        .gss-admin-mark{width:44px;height:44px;border-radius:12px;display:grid;place-items:center;background:#101827;color:#d7b56d;border:2px solid #d7b56d;overflow:hidden}
        .gss-admin-mark img{width:100%;height:100%;object-fit:cover}
        .gss-admin-brand strong,.gss-admin-brand small{display:block;letter-spacing:.12em}.gss-admin-brand strong{font-size:15px}.gss-admin-brand small{font-size:9px;color:#c6cedb;margin-top:4px}
        .gss-admin-account{font-size:13px;color:#dce3ee}.gss-admin-account button{border:1px solid #465267;background:transparent;color:#fff;border-radius:8px;padding:10px 13px;cursor:pointer}
        .gss-admin-main{max-width:1240px;margin:auto;padding:38px 22px 60px}
        .gss-admin-welcome{display:flex;align-items:center;justify-content:space-between;gap:20px;margin-bottom:26px}
        .gss-admin-welcome h1{font-size:clamp(28px,4vw,38px);margin:8px 0;color:#172033}
        .gss-admin-welcome h1 em{font-style:normal;color:#9a742d}
        .gss-admin-welcome p,.gss-admin-panel-heading p{color:#667085;margin:0;line-height:1.6}
        .gss-admin-shell .eyebrow{font-size:11px;letter-spacing:.15em;color:#99752e;font-weight:800}
        .gss-admin-secondary,.gss-admin-primary{border:1px solid #d6dce5;border-radius:8px;padding:11px 14px;background:#fff;color:#263246;font-weight:700;cursor:pointer;justify-content:center}
        .gss-admin-primary{background:#caa65b;color:#151b27;border-color:#caa65b}
        .gss-admin-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:14px;margin-bottom:22px}
        .gss-admin-stats>button{display:flex;align-items:center;text-align:left;gap:12px;border:1px solid #e0e5ed;background:#fff;border-radius:12px;padding:16px;color:#334155;cursor:pointer;box-shadow:0 4px 15px #18223808}
        .gss-admin-stats>button.active{border-color:#caa65b;box-shadow:0 0 0 2px #caa65b33;background:#fffcf5}
        .gss-admin-stats>button>svg{color:#a17a31;width:22px;height:22px;flex-shrink:0}
        .gss-admin-stats small,.gss-admin-stats strong,.gss-admin-stats b{display:block}
        .gss-admin-stats small{font-size:10px;color:#7b8494;text-transform:uppercase}
        .gss-admin-stats strong{font-size:15px;margin:2px 0}
        .gss-admin-stats b{font-size:11px;color:#9a742d}
        .gss-admin-panel{background:#fff;border:1px solid #e1e6ee;border-radius:14px;padding:clamp(18px,3vw,30px);box-shadow:0 8px 28px #18223808}
        .gss-admin-panel-heading{display:flex;justify-content:space-between;align-items:center;gap:18px;margin-bottom:24px}
        .gss-admin-panel-heading h2{margin:7px 0;font-size:24px}
        .gss-admin-form{border:1px solid #e5e9ef;background:#fafbfd;border-radius:11px;padding:20px;margin-bottom:24px;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:15px}
        .gss-admin-form h3{grid-column:1/-1;margin:0;font-size:17px}
        .gss-admin-form label{display:flex;flex-direction:column;gap:7px;font-size:12px;font-weight:700;color:#475467}
        .gss-admin-form label.full{grid-column:1/-1}
        .gss-admin-form input,.gss-admin-form textarea,.gss-admin-form select{width:100%;box-sizing:border-box;border:1px solid #d8dee8;background:#fff;border-radius:7px;padding:11px 12px;color:#172033;font:inherit;font-weight:400;outline-color:#caa65b}
        .gss-admin-form textarea{resize:vertical}
        .gss-admin-form-actions{grid-column:1/-1;display:flex;gap:10px;flex-wrap:wrap}
        .gss-admin-message{background:#f5f0e4;border:1px solid #e6d8b6;color:#72531c;padding:12px 14px;border-radius:8px;font-size:13px}
        .gss-admin-list-heading{display:flex;align-items:center;justify-content:space-between;margin:24px 0 12px}
        .gss-admin-list-heading h3{margin:0;font-size:17px}
        .gss-admin-list-heading span{font-size:12px;color:#667085}
        .gss-admin-items{display:grid;gap:12px}
        .gss-admin-item{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;border:1px solid #e6eaf0;border-radius:10px;padding:16px;background:#fff}
        .gss-admin-item-copy{min-width:0}
        .gss-admin-item-copy strong{font-size:15px;overflow-wrap:anywhere;color:#101827}
        .gss-admin-item-copy p{font-size:13px;color:#5d687a;line-height:1.6;margin:6px 0}
        .gss-admin-item-copy .site-details{display:flex;flex-wrap:wrap;gap:12px;font-size:12px;color:#475467;margin-top:8px;background:#f8fafc;padding:8px 12px;border-radius:6px;border:1px solid #e2e8f0}
        .gss-admin-item-copy small{font-size:11px;color:#8a93a2;display:block;margin-top:4px}
        .gss-admin-item-actions{display:flex;gap:7px;flex-shrink:0;flex-wrap:wrap}
        .gss-admin-search{max-width:360px;width:100%;border:1px solid #d8dee8;border-radius:8px;padding:10px 12px;font:inherit}
        .gss-admin-item-actions button{background:#fff;border:1px solid #dce2eb;border-radius:7px;padding:8px 10px;font-size:12px;cursor:pointer;display:flex;align-items:center;gap:6px}
        .gss-admin-item-actions button.danger{color:#b42318;border-color:#fecdca}
        .gss-admin-empty{color:#667085;background:#fafbfd;padding:28px;border-radius:8px;text-align:center;font-size:13px}
        .gss-overview-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:20px;margin-top:20px}
        .gss-overview-card{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:24px;box-shadow:0 4px 12px rgba(0,0,0,0.03)}
        .gss-overview-card h3{margin:0 0 10px 0;font-size:18px;color:#1e293b}
        .gss-overview-card p{color:#64748b;font-size:14px;line-height:1.6;margin:0 0 16px 0}
        .drag-drop-box{border:2px dashed #cbd5e1;background:#f8fafc;padding:24px;border-radius:8px;text-align:center;cursor:pointer;grid-column:1/-1}
        .drag-drop-box:hover{border-color:#caa65b;background:#fffcf5}
      `}</style>
      
      <header className="gss-admin-header">
        <div className="gss-admin-brand">
          <span className="gss-admin-mark"><img src="/gss-logo.png" alt="Logo" /></span>
          <div><strong>GOLCONDA</strong><small>SECURITY SERVICES · ADMIN PORTAL</small></div>
        </div>
        <div className="gss-admin-account"><span>{adminEmail}</span><button type="button" onClick={handleAdminLogout}><LogOut size={16}/> Logout</button></div>
      </header>

      <main className="gss-admin-main">
        <div className="gss-admin-welcome">
          <div>
            <span className="eyebrow">COMMAND CENTER & OPERATIONS</span>
            <h1>Admin <em>Dashboard</em></h1>
            <p>Managing Golconda Security Services (Ph: 9032545115 | Email: golcondasecservices@gmail.com)</p>
          </div>
          <button className="gss-admin-secondary" onClick={() => { setAdminMode(false); window.location.hash = "home"; }}>
            <ArrowRight size={16}/> View public website
          </button>
        </div>

        {/* Stats Navigation bar */}
        <div className="gss-admin-stats">
          <button className={adminTab === "overview" ? "active" : ""} onClick={() => setAdminTab("overview")}><ShieldCheck/><span><small>Overview</small><strong>Dashboard</strong><b>Live database counts</b></span></button>
          <button className={adminTab === "sites" ? "active" : ""} onClick={() => { setAdminTab("sites"); resetItemForm(); }}><Building2/><span><small>Management</small><strong>Sites</strong><b>{totalSitesCount} Records</b></span></button>
          <button className={adminTab === "guards" ? "active" : ""} onClick={() => { setAdminTab("guards"); resetItemForm(); }}><Users/><span><small>Management</small><strong>Guards</strong><b>{totalGuardsCount} Records</b></span></button>
          <button className={adminTab === "supervisors" ? "active" : ""} onClick={() => { setAdminTab("supervisors"); resetItemForm(); }}><UserRound/><span><small>Management</small><strong>Supervisors</strong><b>{metric("supervisors")} Records</b></span></button>
          <button className={adminTab === "fieldOfficers" ? "active" : ""} onClick={() => { setAdminTab("fieldOfficers"); resetItemForm(); }}><UserRound/><span><small>Management</small><strong>Field Officers</strong><b>{metric("field_officers")} Records</b></span></button>
          <button className={adminTab === "advances" ? "active" : ""} onClick={() => { setAdminTab("advances"); resetItemForm(); }}><FileText/><span><small>Payroll</small><strong>Advances</strong><b>{metric("advances")} Records</b></span></button>
          <button className={adminTab === "profileDocs" ? "active" : ""} onClick={() => { setAdminTab("profileDocs"); resetItemForm(); }}><FileText/><span><small>Company Vault</small><strong>Profile Docs</strong><b>{metric("profile_docs")} Files</b></span></button>
          <button className={adminTab === "complaints" ? "active" : ""} onClick={() => { setAdminTab("complaints"); resetItemForm(); }}><AlertCircle/><span><small>Client & Staff</small><strong>Complaints</strong><b>{metric("complaints")} Logged</b></span></button>
          <button className={adminTab === "events" ? "active" : ""} onClick={() => { setAdminTab("events"); resetItemForm(); }}><CalendarDays/><span><small>Schedule</small><strong>Events</strong><b>{metric("events")} Items</b></span></button>
          <button className={adminTab === "notifications" ? "active" : ""} onClick={() => { setAdminTab("notifications"); resetItemForm(); }}><Bell/><span><small>Broadcasts</small><strong>Notifications</strong><b>{metric("notifications")} Records</b></span></button>
          <button className={adminTab === "services" ? "active" : ""} onClick={() => { setAdminTab("services"); resetItemForm(); }}><Globe/><span><small>Offerings</small><strong>Services</strong><b>{metric("services")} Listed</b></span></button>
          <button className={adminTab === "contactSubmissions" ? "active" : ""} onClick={() => { setAdminTab("contactSubmissions"); resetItemForm(); }}><Mail/><span><small>Website</small><strong>Enquiries</strong><b>{metric("contact_submissions")} Records</b></span></button>
          <button className={adminTab === "jobApplications" ? "active" : ""} onClick={() => { setAdminTab("jobApplications"); resetItemForm(); }}><UserRound/><span><small>Recruitment</small><strong>Applications</strong><b>{metric("job_applications")} Records</b></span></button>
        </div>

        <section className="gss-admin-panel">
          <div className="gss-admin-panel-heading">
            <div>
              <span className="eyebrow">MODULE CONTROL</span>
              <h2>{adminTabsConfig[adminTab].title}</h2>
              <p>{adminTabsConfig[adminTab].description}</p>
            </div>
            {adminTab !== "overview" && <button className="gss-admin-secondary" onClick={() => loadAdminItems(adminTab)}><RefreshCw size={15}/> Refresh</button>}
          </div>

          {adminTab === "overview" && (
            <div>
              {adminLoading ? <p className="gss-admin-empty">Loading live database counts…</p> : <div className="gss-admin-stats" style={{marginBottom: "30px"}}>
                {[["guards", "Guards"], ["sites", "Sites"], ["services", "Services"], ["events", "Events"], ["notifications", "Notifications"], ["complaints", "Complaints"], ["contact_submissions", "Contact enquiries"], ["job_applications", "Applications"]].map(([key, label]) => <div key={key} style={{background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: "12px", padding: "20px"}}><small style={{color: "#64748b", fontWeight: "700", textTransform: "uppercase"}}>{label}</small><strong style={{fontSize: "28px", color: "#1e293b", margin: "8px 0", display: "block"}}>{metric(key)}</strong><span style={{fontSize: "12px", color: "#0d9488"}}>Current database total</span></div>)}
              </div>}

              <div className="gss-admin-stats" style={{marginBottom: "30px"}}>
                {[["supervisors", "Supervisors"], ["field_officers", "Field officers"], ["advances", "Advances"]].map(([key, label]) => <div key={key} style={{background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: "12px", padding: "20px"}}><small style={{color: "#64748b", fontWeight: "700", textTransform: "uppercase"}}>{label}</small><strong style={{fontSize: "28px", color: "#1e293b", margin: "8px 0", display: "block"}}>{metric(key)}</strong><span style={{fontSize: "12px", color: "#0d9488"}}>Current database total</span></div>)}
              </div>

              <div className="gss-overview-grid">
                <div className="gss-overview-card">
                  <h3>🏢 Sites & Hierarchy</h3>
                  <p>Assign and monitor sites under designated Supervisors and Field Officers. Keep track of guard deployments and phone/email directories.</p>
                  <button className="gss-admin-secondary" onClick={() => setAdminTab("sites")}><Building2 size={15}/> Manage Sites</button>
                </div>
                <div className="gss-overview-card">
                  <h3>📁 Company Profile Vault</h3>
                  <p>Upload profile documents, quotations, and certificates by dragging files or selecting them directly.</p>
                  <button className="gss-admin-secondary" onClick={() => setAdminTab("profileDocs")}><FileText size={15}/> Open Vault</button>
                </div>
                <div className="gss-overview-card">
                  <h3>📣 Published Updates</h3>
                  <p>Manage announcements and safety updates shown on the public website.</p>
                  <button className="gss-admin-secondary" onClick={() => setAdminTab("notifications")}><Bell size={15}/> Notifications</button>
                </div>
              </div>
            </div>
          )}

          {adminTab !== "overview" && !["complaints", "contactSubmissions", "jobApplications", "guards", "profileDocs", "sites", "supervisors", "fieldOfficers", "advances"].includes(adminTab) && (
            <form className="gss-admin-form" onSubmit={saveAdminItem}>
              <h3>{editingId ? "Edit Item" : `Add New ${adminTab === "sites" ? "Site" : adminTab === "guards" ? "Guard" : adminTab === "profileDocs" ? "Profile Document" : adminTab === "notifications" ? "Notification" : adminTab === "events" ? "Event" : "Service"}`}</h3>
              
              {(adminTab === "events" || adminTab === "notifications" || adminTab === "services") && (
                <>
                  <label className="full">Title<input required maxLength={120} value={itemForm.title} onChange={e => setItemForm({ ...itemForm, title: e.target.value })} placeholder="Enter title"/></label>
                  {adminTab === "notifications" ? (
                    <label className="full">Message<textarea required rows="3" value={itemForm.message} onChange={e => setItemForm({ ...itemForm, message: e.target.value })} placeholder="Write announcement"/></label>
                  ) : (
                    <label className="full">Description<textarea required rows="3" value={itemForm.description} onChange={e => setItemForm({ ...itemForm, description: e.target.value })} placeholder="Describe item"/></label>
                  )}
                  {adminTab === "events" && <label>Event Date<input type="date" value={itemForm.event_date} onChange={e => setItemForm({ ...itemForm, event_date: e.target.value })}/></label>}
                  {adminTab === "events" && <><label>Event Type<input value={itemForm.event_type} onChange={e => setItemForm({ ...itemForm, event_type: e.target.value })}/></label><label>Display Status<input value={itemForm.display_status} onChange={e => setItemForm({ ...itemForm, display_status: e.target.value })} placeholder="Registration details / status"/></label></>}
                  {adminTab === "notifications" && <>
                    <label>Notification Type<input maxLength="60" value={itemForm.notification_type} onChange={e => setItemForm({ ...itemForm, notification_type: e.target.value })} placeholder="Company update / Safety reminder"/></label>
                    <label>Severity<select value={itemForm.notification_severity} onChange={e => setItemForm({ ...itemForm, notification_severity: e.target.value })}><option value="information">Information</option><option value="announcement">Announcement</option><option value="warning">Warning</option><option value="urgent">Urgent</option></select></label>
                    <label>Date Label<input maxLength="60" value={itemForm.display_date} onChange={e => setItemForm({ ...itemForm, display_date: e.target.value })} placeholder="Latest update"/></label>
                    <label>Start Date & Time<input type="datetime-local" value={itemForm.starts_at} onChange={e => setItemForm({ ...itemForm, starts_at: e.target.value })}/></label>
                    <label>Expiry Date & Time<input type="datetime-local" value={itemForm.expires_at} onChange={e => setItemForm({ ...itemForm, expires_at: e.target.value })}/></label>
                    <label>Button Label (optional)<input maxLength="60" value={itemForm.button_label} onChange={e => setItemForm({ ...itemForm, button_label: e.target.value })} placeholder="Learn more"/></label>
                    <label>Button URL (optional)<input type="text" maxLength="500" value={itemForm.button_url} onChange={e => setItemForm({ ...itemForm, button_url: e.target.value })} placeholder="https://… or /contact"/></label>
                    <label className="gss-admin-checkbox"><input type="checkbox" checked={itemForm.is_active} onChange={e => setItemForm({ ...itemForm, is_active: e.target.checked })}/> Active</label>
                    <label className="gss-admin-checkbox"><input type="checkbox" checked={itemForm.is_published} onChange={e => setItemForm({ ...itemForm, is_published: e.target.checked })}/> Published on the public website</label>
                    <label className="gss-admin-checkbox"><input type="checkbox" checked={itemForm.dismissible} onChange={e => setItemForm({ ...itemForm, dismissible: e.target.checked })}/> Visitors can dismiss this banner</label>
                  </>}
                  {adminTab === "services" && <><label>Card Tag<input value={itemForm.tag} onChange={e => setItemForm({ ...itemForm, tag: e.target.value })} placeholder="PHYSICAL SECURITY"/></label><label>Card Icon<select value={itemForm.icon_key} onChange={e => setItemForm({ ...itemForm, icon_key: e.target.value })}><option value="shield-check">Shield check</option><option value="shield">Shield</option><option value="globe">Globe</option><option value="code">Code</option><option value="graduation-cap">Graduation cap</option></select></label></>}
                  <label>Display Order<input type="number" min="0" value={itemForm.sort_order} onChange={e => setItemForm({ ...itemForm, sort_order: e.target.value })}/></label>
                  {adminTab !== "notifications" && <label>Image URL (Optional)<input type="url" value={itemForm.image_url} onChange={e => setItemForm({ ...itemForm, image_url: e.target.value })} placeholder="https://..."/></label>}
                </>
              )}

              {adminTab === "sites" && (
                <>
                  <label>Site Name<input required value={itemForm.title} onChange={e => setItemForm({ ...itemForm, title: e.target.value })} placeholder="Client / Location Name"/></label>
                  <label>Phone Numbers (up to 5, comma separated)<input value={itemForm.phone_numbers} onChange={e => setItemForm({ ...itemForm, phone_numbers: e.target.value })} placeholder="9032545115, 9876543210"/></label>
                  <label>Total Salary / Billing<input value={itemForm.total_salary} onChange={e => setItemForm({ ...itemForm, total_salary: e.target.value })} placeholder="e.g. ₹1,50,000 / mo"/></label>
                  <label>Services Taken<select value={itemForm.service_taken} onChange={e => setItemForm({ ...itemForm, service_taken: e.target.value })}><option>SECURITY GUARD</option><option>ASO</option><option>BOTH</option></select></label>
                  <label className="full">Given Emails (upto 5 emails, comma separated)<input value={itemForm.given_emails} onChange={e => setItemForm({ ...itemForm, given_emails: e.target.value })} placeholder="client1@example.com, client2@example.com"/></label>
                  <label>Supervisor Name<input value={itemForm.supervisor_name} onChange={e => setItemForm({ ...itemForm, supervisor_name: e.target.value })} placeholder="Assigned Supervisor"/></label>
                  <label>Field Officer Name<input value={itemForm.field_officer_name} onChange={e => setItemForm({ ...itemForm, field_officer_name: e.target.value })} placeholder="Managing Field Officer"/></label>
                </>
              )}

              <div className="gss-admin-form-actions">
                <button className="gss-admin-primary" type="submit"><Plus size={16}/>{adminTab === "notifications" ? "Save Notification" : editingId ? "Save Changes" : "Publish Item"}</button>
                {editingId && <button type="button" className="gss-admin-secondary" onClick={resetItemForm}>Cancel Edit</button>}
              </div>
            </form>
          )}

          {adminMessage && <p className="gss-admin-message" role="status">{adminMessage}</p>}

          {adminTab === "guards" && <GuardManagement
            items={adminItems.guards}
            sites={adminItems.sites}
            search={adminSearch}
            onSearchChange={setAdminSearch}
            onRefresh={() => loadAdminItems("guards")}
            onMetricsRefresh={loadDashboardMetrics}
          />}
          {adminTab === "sites" && <SiteManagement
            items={adminItems.sites}
            guards={adminItems.guards}
            supervisors={adminItems.supervisors}
            fieldOfficers={adminItems.fieldOfficers}
            onRefresh={() => loadAdminItems("sites")}
            onMetricsRefresh={loadDashboardMetrics}
          />}
          {adminTab === "supervisors" && <PeopleManagement
            employeeType="supervisor"
            items={adminItems.supervisors}
            sites={adminItems.sites}
            guards={adminItems.guards}
            onRefresh={() => loadAdminItems("supervisors")}
            onMetricsRefresh={loadDashboardMetrics}
          />}
          {adminTab === "fieldOfficers" && <PeopleManagement
            employeeType="field_officer"
            items={adminItems.fieldOfficers}
            sites={adminItems.sites}
            guards={adminItems.guards}
            onRefresh={() => loadAdminItems("fieldOfficers")}
            onMetricsRefresh={loadDashboardMetrics}
          />}
          {adminTab === "advances" && <AdvancesManagement
            guards={adminItems.guards}
            supervisors={adminItems.supervisors}
            fieldOfficers={adminItems.fieldOfficers}
            sites={adminItems.sites}
            onMetricsRefresh={loadDashboardMetrics}
          />}
          {adminTab === "profileDocs" && <ProfileVault
            items={adminItems.profileDocs}
            onRefresh={() => loadAdminItems("profileDocs")}
            onMetricsRefresh={loadDashboardMetrics}
          />}

          {! ["guards", "profileDocs", "sites", "supervisors", "fieldOfficers", "advances"].includes(adminTab) && <>
          <div className="gss-admin-list-heading">
            <h3>{adminTab === "overview" ? "Quick Operational Actions" : "Records & Entries"}</h3>
            {adminTab !== "overview" && <input className="gss-admin-search" type="search" value={adminSearch} onChange={e => setAdminSearch(e.target.value)} placeholder="Search records" aria-label="Search records"/>}
            <span>{adminTab === "overview" ? "" : `${visibleItems.length} shown · ${currentItems.length} total`}</span>
          </div>

          {adminLoading ? (
            <p className="gss-admin-empty">Loading records…</p>
          ) : adminTab === "overview" ? (
            <div className="gss-admin-empty">Select any tab above (Sites, Profile Vault, Complaints, Events) to view, add, edit, or delete items.</div>
          ) : visibleItems.length === 0 ? (
            <p className="gss-admin-empty">No items found. Use the form above to add your first record.</p>
          ) : (
            <div className="gss-admin-items">
              {visibleItems.map(item => (
                <article className="gss-admin-item" key={item.id}>
                  <div className="gss-admin-item-copy">
                    <strong>{item.title || item.full_name || item.name || item.file_title || "Untitled Record"}</strong>
                    {adminTab === "complaints" ? <>
                      <div className="site-details"><span><b>Role:</b> {item.role}</span><span><b>Phone:</b> {item.phone}</span><span><b>Status:</b> {item.status || "pending"}</span><span><b>Submitted:</b> {new Date(item.created_at).toLocaleString()}</span></div>
                      <p><b>Subject:</b> {item.subject}</p><p><b>Details:</b> {item.details}</p>
                    </> : adminTab === "contactSubmissions" ? <>
                      <div className="site-details"><span><b>Email:</b> {item.email}</span><span><b>Service:</b> {item.service || "General enquiry"}</span><span><b>Status:</b> {item.status}</span><span><b>Submitted:</b> {new Date(item.created_at).toLocaleString()}</span></div><p>{item.message}</p>
                    </> : adminTab === "jobApplications" ? <>
                      <div className="site-details"><span><b>Email:</b> {item.email}</span><span><b>Role:</b> {item.role}</span><span><b>Status:</b> {item.status}</span><span><b>Submitted:</b> {new Date(item.created_at).toLocaleString()}</span></div><p>{item.message || "No introduction provided."}</p>
                    </> : <p>{adminTab === "notifications" ? item.message : item.description}</p>}
                    {adminTab === "notifications" && <div className="site-details"><span><b>Severity:</b> {item.notification_severity}</span><span><b>Active:</b> {item.is_active ? "Yes" : "No"}</span><span><b>Published:</b> {item.is_published ? "Yes" : "No"}</span><span><b>Start:</b> {item.starts_at ? new Date(item.starts_at).toLocaleString() : "Immediately"}</span><span><b>Expiry:</b> {item.expires_at ? new Date(item.expires_at).toLocaleString() : "No expiry"}</span></div>}
                    
                    {adminTab === "sites" && (
                      <div className="site-details">
                        <span>📞 <b>Phones:</b> {item.phone_numbers}</span>
                        <span>💰 <b>Salary:</b> {item.total_salary}</span>
                        <span>🛡️ <b>Service:</b> {item.service_taken}</span>
                        <span>✉️ <b>Emails:</b> {item.given_emails || "N/A"}</span>
                        <span>👤 <b>Supervisor:</b> {item.supervisor_name}</span>
                        <span>⭐ <b>Field Officer:</b> {item.field_officer_name}</span>
                        <span>👥 <b>Assigned guards:</b> {item.guard_records?.map(guard => `${guard.full_name} (${guard.status})`).join(", ") || "None"}</span>
                      </div>
                    )}

                    {adminTab === "notifications" && item.button_label && safeNotificationHref(item.button_url) && <a href={safeNotificationHref(item.button_url)} target={item.button_url?.startsWith("https://") ? "_blank" : undefined} rel="noopener noreferrer" className="text-link" style={{marginTop: 5}}>{item.button_label}<ArrowUpRight size={13}/></a>}

                    <small>{item.created_at ? `Added: ${new Date(item.created_at).toLocaleDateString()}` : ""}</small>
                  </div>
                  <div className="gss-admin-item-actions">
                    {adminTab === "complaints" && <button type="button" onClick={() => toggleComplaintStatus(item)}>{item.status === "resolved" ? "Reopen" : "Mark Resolved"}</button>}
                    {!['complaints', 'contactSubmissions', 'jobApplications'].includes(adminTab) && (
                      <button type="button" onClick={() => startEditing(item, adminTab)} aria-label="Edit item">
                        <Pencil size={15}/> Edit
                      </button>
                    )}
                    <button type="button" className="danger" onClick={() => deleteAdminItem(item, adminTab)} aria-label="Delete item">
                      <Trash2 size={15}/> Delete
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}
          </>}
        </section>

        <p className="gss-admin-security-note">
          <LockKeyhole size={15}/> Submissions are stored in Supabase for authorized admin review.
        </p>
      </main>
    </div>;
  }

  return <>
    <div className="announcement">
      <span className="status-dot"/> PHYSICAL SECURITY <i/> CYBERSECURITY <i/> AWARENESS 
      <span className="announcement-right">📞 +91-9032545115 <i/> golcondasecservices@gmail.com</span>
    </div>
    
    <header className="site-header">
      <div className="container nav-wrap">
        <Brand/>
        <button className="menu-toggle" aria-label="Toggle navigation" onClick={() => setMenuOpen(!menuOpen)}>{menuOpen ? <X/> : <Menu/>}</button>
        <nav className={menuOpen ? "nav-links open" : "nav-links"}>
          {navItems.map(([label, href]) => <a key={label} href={href.startsWith("#") && isCompanyProfile ? `/${href}` : href} onClick={() => setMenuOpen(false)}>{label}</a>)}
          <button className="login-nav" onClick={openLogin}><LockKeyhole size={15}/> Team Login</button>
        </nav>
      </div>
    </header>

    <main>
      {isCompanyProfile ? <CompanyProfile services={publicContent.services} documents={profileDocuments} loading={profileLoading} error={profileError} onRefresh={loadPublicProfile}/> : <>
      <section className="hero" id="home">
        <div className="hero-grid"/>
        <div className="container hero-inner">
          <div className="hero-copy">
            <span className="eyebrow"><span className="gold-line"/> GOLCONDA SECURITY & FACILITY SERVICES</span>
            <h1>Protect what<br/> <em>matters most.</em></h1>
            <p className="hero-lead">Integrated physical security, guard deployment, and digital protection for resilient enterprises.</p>
            <p className="hero-desc">Reg. No. 493-2013 (AP Gov.) · Security personnel, ASO services, web security, and cyber awareness. Contact the team to confirm current service availability and coverage.</p>
            <div className="hero-actions">
              <a className="button button-gold" href="#services">Explore Services <ArrowRight size={17}/></a>
              <a className="button button-outline" href="#contact">Connect With Us <ArrowUpRight size={17}/></a>
            </div>
            <div className="hero-proof"><span><ShieldCheck size={16}/> Physical Security</span><span><CheckCircle2 size={16}/> Cyber Awareness</span><span><MapPin size={16}/> Secunderabad</span></div>
          </div>
          <div className="hero-art" aria-label="Shield illustration">
            <div className="orbit orbit-one"/><div className="orbit orbit-two"/>
            <div className="hero-shield"><Shield size={164} strokeWidth={0.8}/><span>G</span></div>
            <div className="floating-card card-top"><span className="tiny-icon"><LockKeyhole size={16}/></span><span><b>SECURITY FIRST</b><small>People · Systems · Assets</small></span></div>
            <div className="floating-card card-bottom"><span className="pulse-ring"/><span><b>STAY AWARE</b><small>Safety at any cost</small></span></div>
            <div className="hero-caption">GSS <span> / </span> SECUNDERABAD</div>
          </div>
        </div>
        <div className="hero-bottom-line"/>
      </section>

      <AnnouncementBanner notifications={publicContent.notifications} now={notificationNow}/>

      <section className="trust-strip"><div className="container trust-inner"><span>OUR FOCUS</span>{publicContent.services.slice(0, 4).map((service, index) => <React.Fragment key={service.id}>{index > 0 && <i/>}<b>{service.title}</b></React.Fragment>)}</div></section>

      <section className="section services-section" id="services">
        <div className="container">
          <SectionHeading eyebrow="WHAT WE DO" title="Security, built around you." subtitle="Practical physical and digital security services delivered under one trusted banner."/>
          <div className="service-grid">
            {publicContentLoading ? <p role="status">Loading services…</p> : publicContentError ? <p role="alert">{publicContentError}</p> : publicContent.services.length ? publicContent.services.map((service, index) => {
              const Icon = serviceIconMap[service.icon_key] || ShieldCheck;
              return <article className="service-card" key={service.id}>
                <div className="service-card-top"><span className="service-icon"><Icon size={25}/></span><span className="service-number">{String(index + 1).padStart(2, "0")}</span></div>
                <span className="card-tag">{service.tag || "SECURITY SERVICES"}</span><h3>{service.title}</h3><p>{service.description}</p>
                <a href="#contact" className="text-link">Discuss this service <ArrowUpRight size={15}/></a>
              </article>;
            }) : <p>No services are currently published.</p>}
          </div>
        </div>
      </section>

      <section className="section updates-section" id="notifications">
        <div className="container">
          <div className="section-row"><SectionHeading eyebrow="THE LATEST" title="Notifications & updates" subtitle="Company news, service announcements and safety reminders." align="left"/><span className="live-label"><span className="status-dot"/> LIVE UPDATES</span></div>
          <div className="updates-grid">
            {publicContentLoading ? <p role="status">Loading updates…</p> : publicContentError ? <p role="alert">{publicContentError}</p> : activePublicNotifications.length ? <>{activePublicNotifications.slice(0, showAllPublicNotifications ? undefined : 6).map(item => {
              const actionHref = safeNotificationHref(item.button_url) || "#contact";
              return <article className={`update-card severity-${item.notification_severity || "information"}`} key={item.id}><div className="update-meta"><span>{item.notification_type || item.notification_severity || "COMPANY UPDATE"}</span><span>{item.display_date || (item.created_at ? new Date(item.created_at).toLocaleDateString() : "Latest update")}</span></div><h3>{item.title}</h3><p>{item.message}</p><a href={actionHref} target={actionHref.startsWith("https://") ? "_blank" : undefined} rel="noopener noreferrer" className="text-link">{item.button_label || "Stay connected"} <ArrowRight size={15}/></a></article>;
            })}{activePublicNotifications.length > 6 && <button type="button" className="notification-more-count" onClick={() => setShowAllPublicNotifications(value => !value)}>{showAllPublicNotifications ? "Show fewer updates" : `Show all ${activePublicNotifications.length} published updates`}</button>}</> : <p>No updates are currently published.</p>}
          </div>
        </div>
      </section>

      <section className="section events-section" id="events">
        <div className="container">
          <SectionHeading eyebrow="LEARN · PREPARE · PROTECT" title="Upcoming events" subtitle="Building safer habits through professional training and community learning."/>
          <div className="events-grid">
            {publicContentLoading ? <p role="status">Loading events…</p> : publicContentError ? <p role="alert">{publicContentError}</p> : publicContent.events.length ? publicContent.events.map(event => <article className="event-card" key={event.id}><div className="event-date"><CalendarDays size={20}/><span>{formatUtcDate(event.event_date)}</span></div><div className="event-content"><span className="card-tag">{event.event_type || "COMMUNITY"}</span><h3>{event.title}</h3><p>{event.description}</p><div className="event-footer"><span>{event.display_status || "Contact us for details."}</span><a href="#contact" aria-label="Ask about event"><ArrowUpRight size={18}/></a></div></div></article>) : <p>No events are currently published.</p>}
          </div>
        </div>
      </section>

      <section className="section faq-section" id="faq">
        <div className="container">
          <SectionHeading eyebrow="COMMON QUESTIONS" title="Questions before you reach out?" subtitle="Service availability and operating terms are confirmed directly with the company." align="left"/>
          <div className="faq-list">
            <details><summary>Which services are currently listed?</summary><p>{publicContent.services.length ? publicContent.services.map(service => service.title).join(", ") : "The live service catalogue is currently unavailable."} The current catalogue is loaded from the company database.</p></details>
            <details><summary>How do I request a quotation or site discussion?</summary><p>Use the contact form and describe your service requirement, site location and any operational details you want the team to review. The company will confirm availability and terms directly.</p></details>
            <details><summary>Which locations does the company serve?</summary><p>The company lists its office in Secunderabad, Telangana. Contact the team to confirm whether a particular deployment location is currently served.</p></details>
            <details><summary>How can I apply for a role?</summary><p>Use the Work With Us form to share your name, email address, area of interest and an optional introduction. Submissions are saved for authorized review.</p></details>
            <details><summary>How can I submit a complaint?</summary><p>Use the complaint form to include your role, a contact phone number, subject and details. The submission is stored for authorized administrator review. Do not include passwords or unrelated sensitive information.</p></details>
            <details><summary>Are company documents public?</summary><p>Only profile materials an administrator explicitly approves are shown on the public Company Profile page. Employee records and private drafts are not part of that page.</p></details>
          </div>
        </div>
      </section>

      {/* Complaints Section */}
      <section className="section" id="complaints" style={{background: "#f8fafc", borderTop: "1px solid #e2e8f0", borderBottom: "1px solid #e2e8f0"}}>
        <div className="container careers-grid">
          <div>
            <span className="eyebrow">GRIEVANCE & COMPLAINTS</span>
            <h2>Register a <em>Complaint.</em></h2>
            <p>Guards, supervisors, field officers, or clients can register grievances or operational complaints here. Submissions are saved for authorized review in the Admin Dashboard.</p>
            <div className="career-perks">
              <span><Phone size={17}/> Direct Hotline: 9032545115</span>
              <span><LockKeyhole size={17}/> Authorized Admin Review</span>
            </div>
          </div>
          <form className="form-card" onSubmit={(e) => submitForm(e, "complaints", complaintForm, () => setComplaintForm({complainant_name: "", role: "Security Guard", phone: "", subject: "", details: ""}), "Your submission has been received successfully.")}>
            <h3>Submit Complaint</h3>
            <p className="form-intro">Submissions are stored for authorized administrator review. See the <a href="/privacy.html">Privacy Policy</a>.</p>
            <label>Your Name<input required value={complaintForm.complainant_name} onChange={e=>setComplaintForm({...complaintForm, complainant_name: e.target.value})} placeholder="Full name"/></label>
            <label>Your Role<select value={complaintForm.role} onChange={e=>setComplaintForm({...complaintForm, role: e.target.value})}><option>Security Guard</option><option>Supervisor</option><option>Field Officer</option><option>Client / Facility Manager</option></select></label>
            <label>Phone Number<input required value={complaintForm.phone} onChange={e=>setComplaintForm({...complaintForm, phone: e.target.value})} placeholder="9xxxxxxxxx"/></label>
            <label>Subject<input required value={complaintForm.subject} onChange={e=>setComplaintForm({...complaintForm, subject: e.target.value})} placeholder="Brief subject of complaint"/></label>
            <label>Complaint Details<textarea required rows="3" value={complaintForm.details} onChange={e=>setComplaintForm({...complaintForm, details: e.target.value})} placeholder="Provide full details..."/></label>
            <button className="button button-gold button-full" type="submit">Submit Complaint <ArrowRight size={16}/></button>
          </form>
        </div>
      </section>

      <section className="section careers-section" id="careers">
        <div className="container careers-grid">
          <div><span className="eyebrow">WORK WITH US</span><h2>Build a safer future<br/><em>with our team.</em></h2><p>Interested in security guard deployments, ASO roles, or cyber awareness? Share your details and the team can confirm current openings.</p><div className="career-perks"><span><Users size={17}/> Career Opportunities</span><span><Mail size={17}/> Role enquiries</span></div></div>
          <form className="form-card" onSubmit={(e) => submitForm(e, "applications", application, () => setApplication({name:"",email:"",role:"Security Guard / ASO",message:""}), "Your submission has been received successfully.")}>
            <h3>Work with us</h3><p className="form-intro">Join Golconda Security Services.</p>
            <p className="form-intro">Your details are stored for authorized review. See the <a href="/privacy.html">Privacy Policy</a>.</p>
            <label>Full name<input required value={application.name} onChange={e=>setApplication({...application,name:e.target.value})} placeholder="Your full name"/></label>
            <label>Email address<input required type="email" value={application.email} onChange={e=>setApplication({...application,email:e.target.value})} placeholder="you@example.com"/></label>
            <label>Area of interest<select value={application.role} onChange={e=>setApplication({...application,role:e.target.value})}>{publicContent.services.map(service => <option key={service.id}>{service.title}</option>)}<option>Supervisor / Field Officer</option><option>General Interest</option></select></label>
            <label>Short introduction<textarea rows="3" value={application.message} onChange={e=>setApplication({...application,message:e.target.value})} placeholder="Experience or inquiries"/></label>
            <button className="button button-gold button-full" type="submit">Submit Interest <ArrowRight size={16}/></button>
          </form>
        </div>
      </section>

      <section className="section contact-section" id="contact">
        <div className="container contact-grid">
          <div className="contact-copy"><span className="eyebrow">LET'S CONNECT</span><h2>Start a <em>conversation.</em></h2><p>Have a security requirement, deployment query, or project in mind? Contact us directly.</p>
            <div className="contact-method"><span><Mail size={18}/></span><div><small>EMAIL</small><b>golcondasecservices@gmail.com</b></div></div>
            <div className="contact-method"><span><Phone size={18}/></span><div><small>PHONE</small><b>+91-9032545115</b></div></div>
            <div className="contact-method"><span><MapPin size={18}/></span><div><small>LOCATION</small><b>Plot No. 202, Shanti Nagar, Balaji Nagar, Jawahar Nagar, Sainikpuri, Secunderabad - 500087</b></div></div>
          </div>
          <form className="form-card contact-form" onSubmit={(e) => submitForm(e, "contact", contact, () => setContact({name:"",email:"",service:"Security Guard / ASO",message:""}), "Your submission has been received successfully.")}>
            <h3>Send us a message</h3><p className="form-intro">Stored for authorized administrator review. See the <a href="/privacy.html">Privacy Policy</a>.</p>
            <label>Full name *<input required value={contact.name} onChange={e=>setContact({...contact,name:e.target.value})} placeholder="Your name"/></label>
            <label>Email address *<input required type="email" value={contact.email} onChange={e=>setContact({...contact,email:e.target.value})} placeholder="you@example.com"/></label>
            <label>I'm interested in<select value={contact.service} onChange={e=>setContact({...contact,service:e.target.value})}>
              {publicContent.services.map(service => <option key={service.id}>{service.title}</option>)}
              <option>General Enquiry</option>
            </select></label>
            <label>How can we help? *<textarea required rows="4" value={contact.message} onChange={e=>setContact({...contact,message:e.target.value})} placeholder="Tell us about your requirement..."/></label>
            <button className="button button-gold button-full" type="submit">Send Enquiry <ArrowRight size={16}/></button>
            {notice && <p className="form-notice" role="status">{notice}</p>}
            <p className="privacy-note"><LockKeyhole size={13}/> Secure & confidential communication.</p>
          </form>
        </div>
      </section>
      </>}
    </main>

    <footer className="site-footer">
      <div className="container footer-main">
        <div className="footer-brand"><Brand footer/><p>Security. Intelligence. Trust.<br/>Safety and security at any cost.</p></div>
      <div className="footer-col"><b>Explore</b><a href="/#services">Services</a><a href="/company-profile">Company Profile</a><a href="/#events">Upcoming Events</a><a href="/#faq">Questions &amp; Answers</a></div>
        <div className="footer-col"><b>Get involved</b><a href="/#complaints">Register Complaint</a><a href="/#careers">Work With Us</a><a href="/#contact">Contact Us</a></div>
        <div className="footer-col"><b>Team access</b><button className="footer-login" onClick={openLogin}>Team Login <ArrowUpRight size={14}/></button><span>Private Portal</span></div>
      </div>
      <div className="container footer-bottom">
        <span>© {new Date().getFullYear()} Golconda Security Services (Reg. No. 493-2013). All rights reserved.</span>
        <span>Ph: 9032545115 · Secunderabad</span>
        <nav aria-label="Legal"><a href="/terms.html">Terms &amp; Conditions</a><a href="/privacy.html">Privacy Policy</a></nav>
        <a href="/#home">Back to top ↑</a>
      </div>
      <div className="container footer-credit">Created by Mayank Pandey</div>
    </footer>

    {loginOpen && <div className="modal-backdrop" role="presentation" onClick={()=>setLoginOpen(false)}>
      <div className="login-modal" role="dialog" aria-modal="true" aria-labelledby="login-title" onClick={e=>e.stopPropagation()}>
        <button className="modal-close" onClick={()=>setLoginOpen(false)} aria-label="Close login"><X/></button>
        <div className="modal-logo"><Shield size={36}/></div>
        <span className="eyebrow">GSS PRIVATE PORTAL</span>
        <h2 id="login-title">Team <em>access.</em></h2>
        <form onSubmit={handleLogin}>
          <label>Email Address<input type="email" required value={login.userId} onChange={e=>setLogin({...login,userId:e.target.value})} placeholder="you@example.com" autoComplete="username"/></label>
          <label>Password<input type="password" required value={login.password} onChange={e=>setLogin({...login,password:e.target.value})} placeholder="Your password" autoComplete="current-password"/></label>
          <button className="button button-gold button-full" type="submit">Continue <ArrowRight size={16}/></button>
        </form>
        {loginMessage && <p className="form-notice">{loginMessage}</p>}
        <p className="privacy-note"><LockKeyhole size={13}/> Authorized team members only.</p>
      </div>
    </div>}

    {notice && !loginOpen && <div className="toast" role="status">{notice}<button onClick={()=>setNotice("")} aria-label="Dismiss"><X size={16}/></button></div>}
  </>;
}

const rootElement = document.getElementById("root");
// Reuse the root when Vite re-evaluates this entry module during hot updates.
const root = import.meta.hot
  ? (import.meta.hot.data.root ||= createRoot(rootElement))
  : createRoot(rootElement);
root.render(<App/>);
