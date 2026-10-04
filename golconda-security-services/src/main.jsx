import React, { useEffect, useState } from "react";
import { supabase } from "./supabase";
import { createRoot } from "react-dom/client";
import {
  Shield, ShieldCheck, Menu, X, ArrowUpRight, ArrowRight, LockKeyhole,
  Globe, Code2, GraduationCap, UserRound, Bell, CalendarDays, Users,
  FileText, Image as ImageIcon, PlayCircle, Linkedin, Instagram, Youtube,
  Facebook, Send, Mail, Phone, MapPin, ChevronRight, CheckCircle2, LogOut, Plus, Trash2, Pencil, RefreshCw
} from "lucide-react";
import "./styles.css";

const services = [
  { icon: ShieldCheck, number: "01", title: "Security Guard / ASO", tag: "PHYSICAL SECURITY", description: "Professional security guard deployment and Assistant Security Officer services for workplaces, facilities and events." },
  { icon: Shield, number: "02", title: "VPAT", tag: "ASSESSMENT SERVICES", description: "Assessment service information and scope can be tailored to your organization's requirements." },
  { icon: Globe, number: "03", title: "Web Security", tag: "DIGITAL DEFENCE", description: "Authorized website security reviews, vulnerability assessment and practical remediation guidance." },
  { icon: Code2, number: "04", title: "Web Designing", tag: "DIGITAL PRESENCE", description: "Responsive business websites with clear information architecture, accessible design and polished user experiences." },
  { icon: GraduationCap, number: "05", title: "Cyber Awareness", tag: "EDUCATION & OUTREACH", description: "Cyber safety programs, awareness sessions and workshops for students, teams and communities." }
];

const events = [
  { date: "COMING SOON", type: "AWARENESS PROGRAM", title: "Cyber Safety Awareness Session", desc: "Practical guidance on phishing, passwords, privacy and safer digital habits.", status: "Event details will be announced shortly." },
  { date: "COMING SOON", type: "COMMUNITY", title: "Digital Security Workshop", desc: "An introductory session on everyday security practices and responsible technology use.", status: "Registration is not open yet." }
];

const initialUpdates = [
  { type: "COMPANY UPDATE", title: "Welcome to Golconda Security Services", date: "Latest update", text: "Our website is being prepared. Follow our official channels for announcements and upcoming programs." },
  { type: "CYBER AWARENESS", title: "Pause before you click", date: "Safety reminder", text: "Verify unexpected links and requests before sharing passwords, OTPs or sensitive information." }
];

function Brand({ footer = false }) {
  return <a className={`brand ${footer ? "brand-footer" : ""}`} href="#home" aria-label="Golconda Security Services home">
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
  const [menuOpen, setMenuOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const [contact, setContact] = useState({ name: "", email: "", service: "Web Security", message: "" });
  const [application, setApplication] = useState({ name: "", email: "", role: "Security Guard / ASO", message: "" });
  const [loginOpen, setLoginOpen] = useState(false);
  const [login, setLogin] = useState({ userId: "", password: "" });
  const [loginMessage, setLoginMessage] = useState("");
  const [adminMode, setAdminMode] = useState(false);
  const [adminEmail, setAdminEmail] = useState("");
  const [adminTab, setAdminTab] = useState("events");
  const [adminItems, setAdminItems] = useState({ events: [], notifications: [], services: [] });
  const [adminLoading, setAdminLoading] = useState(false);
  const [adminMessage, setAdminMessage] = useState("");
  const [editingId, setEditingId] = useState(null);
  const [itemForm, setItemForm] = useState({ title: "", description: "", event_date: "", image_url: "", message: "" });

  const adminTables = {
    events: { table: "events", title: "Events", description: "Manage upcoming events shown on the website." },
    notifications: { table: "notifications", title: "Notifications", description: "Publish announcements and safety updates." },
    services: { table: "services", title: "Services", description: "Manage the services listed for visitors." },
  };

  useEffect(() => {
    let active = true;
    async function restoreAdminSession() {
      const { data } = await supabase.auth.getSession();
      const user = data?.session?.user;
      if (!user || !active) return;
      const { data: admin } = await supabase.from("admin_users").select("user_id").eq("user_id", user.id).maybeSingle();
      if (admin && active) {
        setAdminEmail(user.email || "Admin");
        setAdminMode(true);
      } else {
        await supabase.auth.signOut();
      }
    }
    restoreAdminSession();
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (adminMode) loadAdminItems();
  }, [adminMode, adminTab]);

  async function loadAdminItems() {
    setAdminLoading(true);
    setAdminMessage("");
    const { table } = adminTables[adminTab];
    const { data, error } = await supabase.from(table).select("*").order("created_at", { ascending: false });
    if (error) {
      setAdminMessage(`Could not load ${adminTables[adminTab].title.toLowerCase()}: ${error.message}`);
      setAdminItems(prev => ({ ...prev, [adminTab]: [] }));
    } else {
      setAdminItems(prev => ({ ...prev, [adminTab]: data || [] }));
    }
    setAdminLoading(false);
  }

  function resetItemForm() {
    setEditingId(null);
    setItemForm({ title: "", description: "", event_date: "", image_url: "", message: "" });
  }

  function startEditing(item) {
    setEditingId(item.id);
    setItemForm({
      title: item.title || "", description: item.description || "", event_date: item.event_date || "",
      image_url: item.image_url || "", message: item.message || ""
    });
    setAdminMessage("");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function saveAdminItem(event) {
    event.preventDefault();
    setAdminMessage("");
    const table = adminTables[adminTab].table;
    let payload;
    if (adminTab === "notifications") {
      payload = { title: itemForm.title.trim(), message: itemForm.message.trim() };
    } else if (adminTab === "events") {
      payload = { title: itemForm.title.trim(), description: itemForm.description.trim(), event_date: itemForm.event_date || null, image_url: itemForm.image_url.trim() || null };
    } else {
      payload = { title: itemForm.title.trim(), description: itemForm.description.trim(), image_url: itemForm.image_url.trim() || null };
    }
    const query = supabase.from(table);
    const { error } = editingId
      ? await query.update(payload).eq("id", editingId)
      : await query.insert(payload);
    if (error) {
      setAdminMessage(`Save failed: ${error.message}`);
      return;
    }
    setAdminMessage(editingId ? "Changes saved successfully." : "Item added successfully.");
    resetItemForm();
    await loadAdminItems();
  }

  async function deleteAdminItem(item) {
    if (!window.confirm(`Delete “${item.title || "this item"}”? This cannot be undone.`)) return;
    const { error } = await supabase.from(adminTables[adminTab].table).delete().eq("id", item.id);
    if (error) setAdminMessage(`Delete failed: ${error.message}`);
    else {
      setAdminMessage("Item deleted successfully.");
      await loadAdminItems();
    }
  }

  async function handleAdminLogout() {
    await supabase.auth.signOut();
    setAdminMode(false);
    setAdminEmail("");
    setLogin({ userId: "", password: "" });
    setLoginMessage("");
    setAdminMessage("");
  }

  const navItems = [
    ["Home", "#home"], ["Services", "#services"], ["Notifications", "#notifications"],
    ["Upcoming Events", "#events"], ["Profile", "#profile"], ["Work With Us", "#careers"], ["Contact Us", "#contact"]
  ];

  async function submitForm(event, endpoint, payload, reset, successText) {
    event.preventDefault();
    setNotice("");
    try {
      const response = await fetch(`${import.meta.env.VITE_API_URL || "http://localhost:4000"}/api/${endpoint}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload)
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Submission failed.");
      setNotice(successText);
      reset();
    } catch (error) {
      setNotice(`Could not submit right now. Make sure the backend is running. (${error.message})`);
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
    } catch (error) {
      setLoginMessage("Login could not be completed. Please try again.");
      console.error("Admin login error:", error);
    }
  }

  if (adminMode) {
    const currentItems = adminItems[adminTab] || [];
    return <div className="gss-admin-shell">
      <style>{`
        .gss-admin-shell{min-height:100vh;background:#f4f6fa;color:#172033;font-family:Inter,system-ui,sans-serif}
        .gss-admin-header{height:auto;min-height:78px;padding:16px clamp(18px,5vw,64px);background:#101827;color:#fff;display:flex;align-items:center;justify-content:space-between;gap:18px;border-bottom:1px solid #283449}
        .gss-admin-brand,.gss-admin-account,.gss-admin-account button,.gss-admin-secondary,.gss-admin-primary,.gss-admin-item-actions button{display:flex;align-items:center;gap:10px}
        .gss-admin-mark{width:44px;height:44px;border-radius:12px;display:grid;place-items:center;background:#d7b56d;color:#111827}
        .gss-admin-brand strong,.gss-admin-brand small{display:block;letter-spacing:.12em}.gss-admin-brand strong{font-size:15px}.gss-admin-brand small{font-size:9px;color:#c6cedb;margin-top:4px}
        .gss-admin-account{font-size:13px;color:#dce3ee}.gss-admin-account button{border:1px solid #465267;background:transparent;color:#fff;border-radius:8px;padding:10px 13px;cursor:pointer}
        .gss-admin-main{max-width:1180px;margin:auto;padding:38px 22px 60px}.gss-admin-welcome{display:flex;align-items:center;justify-content:space-between;gap:20px;margin-bottom:26px}.gss-admin-welcome h1{font-size:clamp(30px,4vw,42px);margin:8px 0;color:#172033}.gss-admin-welcome h1 em{font-style:normal;color:#9a742d}.gss-admin-welcome p,.gss-admin-panel-heading p{color:#667085;margin:0;line-height:1.6}.gss-admin-shell .eyebrow{font-size:11px;letter-spacing:.15em;color:#99752e;font-weight:800}
        .gss-admin-secondary,.gss-admin-primary{border:1px solid #d6dce5;border-radius:8px;padding:11px 14px;background:#fff;color:#263246;font-weight:700;cursor:pointer;justify-content:center}.gss-admin-primary{background:#caa65b;color:#151b27;border-color:#caa65b}.gss-admin-stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;margin-bottom:22px}.gss-admin-stats>button{display:flex;align-items:center;text-align:left;gap:14px;border:1px solid #e0e5ed;background:#fff;border-radius:13px;padding:20px;color:#334155;cursor:pointer;box-shadow:0 4px 15px #18223808}.gss-admin-stats>button.active{border-color:#caa65b;box-shadow:0 0 0 2px #caa65b33}.gss-admin-stats>button>svg{color:#a17a31;width:25px;height:25px}.gss-admin-stats small,.gss-admin-stats strong,.gss-admin-stats b{display:block}.gss-admin-stats small{font-size:11px;color:#7b8494}.gss-admin-stats strong{font-size:16px;margin:3px 0}.gss-admin-stats b{font-size:12px;color:#9a742d}
        .gss-admin-panel{background:#fff;border:1px solid #e1e6ee;border-radius:14px;padding:clamp(18px,3vw,30px);box-shadow:0 8px 28px #18223808}.gss-admin-panel-heading{display:flex;justify-content:space-between;align-items:center;gap:18px;margin-bottom:24px}.gss-admin-panel-heading h2{margin:7px 0;font-size:26px}.gss-admin-form{border:1px solid #e5e9ef;background:#fafbfd;border-radius:11px;padding:20px;margin-bottom:24px;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:15px}.gss-admin-form h3{grid-column:1/-1;margin:0;font-size:17px}.gss-admin-form label{display:flex;flex-direction:column;gap:7px;font-size:12px;font-weight:700;color:#475467}.gss-admin-form label:nth-child(3){grid-column:1/-1}.gss-admin-form input,.gss-admin-form textarea{width:100%;box-sizing:border-box;border:1px solid #d8dee8;background:#fff;border-radius:7px;padding:11px 12px;color:#172033;font:inherit;font-weight:400;outline-color:#caa65b}.gss-admin-form textarea{resize:vertical}.gss-admin-form-actions{grid-column:1/-1;display:flex;gap:10px;flex-wrap:wrap}.gss-admin-message{background:#f5f0e4;border:1px solid #e6d8b6;color:#72531c;padding:12px 14px;border-radius:8px;font-size:13px}.gss-admin-list-heading{display:flex;align-items:center;justify-content:space-between;margin:24px 0 12px}.gss-admin-list-heading h3{margin:0;font-size:17px}.gss-admin-list-heading span{font-size:12px;color:#667085}.gss-admin-items{display:grid;gap:10px}.gss-admin-item{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;border:1px solid #e6eaf0;border-radius:10px;padding:16px}.gss-admin-item-copy{min-width:0}.gss-admin-item-copy strong{font-size:15px;overflow-wrap:anywhere}.gss-admin-item-copy p{font-size:13px;color:#5d687a;line-height:1.6;margin:7px 0}.gss-admin-item-copy small{font-size:11px;color:#8a93a2}.gss-admin-item-actions{display:flex;gap:7px;flex-shrink:0}.gss-admin-item-actions button{background:#fff;border:1px solid #dce2eb;border-radius:7px;padding:8px 10px;font-size:12px;cursor:pointer}.gss-admin-item-actions button.danger{color:#b42318}.gss-admin-empty{color:#667085;background:#fafbfd;padding:24px;border-radius:8px;text-align:center;font-size:13px}.gss-admin-security-note{display:flex;align-items:flex-start;gap:8px;color:#737d8d;font-size:12px;line-height:1.6;margin-top:18px}.gss-admin-security-note svg{flex-shrink:0;margin-top:2px}
        @media(max-width:680px){.gss-admin-header{align-items:flex-start;flex-direction:column}.gss-admin-account{width:100%;justify-content:space-between;flex-wrap:wrap}.gss-admin-main{padding:25px 14px 40px}.gss-admin-welcome,.gss-admin-panel-heading{align-items:flex-start;flex-direction:column}.gss-admin-stats{grid-template-columns:1fr;gap:9px}.gss-admin-stats>button{padding:14px}.gss-admin-form{grid-template-columns:1fr;padding:14px}.gss-admin-form label:nth-child(3){grid-column:auto}.gss-admin-item{flex-direction:column}.gss-admin-item-actions{width:100%;flex-wrap:wrap}.gss-admin-item-actions button{flex:1}}
      `}</style>
      <header className="gss-admin-header">
        <div className="gss-admin-brand"><span className="gss-admin-mark"><ShieldCheck size={25}/></span><div><strong>GOLCONDA</strong><small>SECURITY SERVICES · ADMIN</small></div></div>
        <div className="gss-admin-account"><span>{adminEmail}</span><button type="button" onClick={handleAdminLogout}><LogOut size={16}/> Logout</button></div>
      </header>
      <main className="gss-admin-main">
        <div className="gss-admin-welcome"><div><span className="eyebrow">PRIVATE CONTROL PANEL</span><h1>Admin <em>Dashboard</em></h1><p>Manage the content displayed on your public website.</p></div><button className="gss-admin-secondary" onClick={() => { setAdminMode(false); window.location.hash = "home"; }}><ArrowRight size={16}/> View website</button></div>
        <div className="gss-admin-stats">
          <button className={adminTab === "events" ? "active" : ""} onClick={() => { setAdminTab("events"); resetItemForm(); }}><CalendarDays/><span><small>Manage</small><strong>Events</strong><b>{adminItems.events.length}</b></span></button>
          <button className={adminTab === "notifications" ? "active" : ""} onClick={() => { setAdminTab("notifications"); resetItemForm(); }}><Bell/><span><small>Manage</small><strong>Notifications</strong><b>{adminItems.notifications.length}</b></span></button>
          <button className={adminTab === "services" ? "active" : ""} onClick={() => { setAdminTab("services"); resetItemForm(); }}><ShieldCheck/><span><small>Manage</small><strong>Services</strong><b>{adminItems.services.length}</b></span></button>
        </div>
        <section className="gss-admin-panel">
          <div className="gss-admin-panel-heading"><div><span className="eyebrow">CONTENT MANAGEMENT</span><h2>{adminTables[adminTab].title}</h2><p>{adminTables[adminTab].description}</p></div><button className="gss-admin-secondary" onClick={loadAdminItems}><RefreshCw size={15}/> Refresh</button></div>
          <form className="gss-admin-form" onSubmit={saveAdminItem}>
            <h3>{editingId ? "Edit item" : `Add ${adminTab === "notifications" ? "notification" : adminTab === "events" ? "event" : "service"}`}</h3>
            <label>Title<input required maxLength={120} value={itemForm.title} onChange={e => setItemForm({ ...itemForm, title: e.target.value })} placeholder="Enter a clear title"/></label>
            {adminTab === "notifications" ? <label>Message<textarea required rows="3" value={itemForm.message} onChange={e => setItemForm({ ...itemForm, message: e.target.value })} placeholder="Write the announcement"/></label> : <label>Description<textarea required rows="3" value={itemForm.description} onChange={e => setItemForm({ ...itemForm, description: e.target.value })} placeholder="Describe this item"/></label>}
            {adminTab === "events" && <label>Event date<input type="date" value={itemForm.event_date} onChange={e => setItemForm({ ...itemForm, event_date: e.target.value })}/></label>}
            {adminTab !== "notifications" && <label>Image URL (optional)<input type="url" value={itemForm.image_url} onChange={e => setItemForm({ ...itemForm, image_url: e.target.value })} placeholder="https://example.com/image.jpg"/></label>}
            <div className="gss-admin-form-actions"><button className="gss-admin-primary" type="submit"><Plus size={16}/>{editingId ? "Save changes" : "Publish item"}</button>{editingId && <button type="button" className="gss-admin-secondary" onClick={resetItemForm}>Cancel edit</button>}</div>
          </form>
          {adminMessage && <p className="gss-admin-message" role="status">{adminMessage}</p>}
          <div className="gss-admin-list-heading"><h3>Published items</h3><span>{currentItems.length} total</span></div>
          {adminLoading ? <p className="gss-admin-empty">Loading content…</p> : currentItems.length === 0 ? <p className="gss-admin-empty">No items found yet. Use the form above to add your first item.</p> : <div className="gss-admin-items">{currentItems.map(item => <article className="gss-admin-item" key={item.id}><div className="gss-admin-item-copy"><strong>{item.title || "Untitled"}</strong><p>{adminTab === "notifications" ? item.message : item.description}</p><small>{adminTab === "events" && item.event_date ? `Event date: ${item.event_date}` : item.created_at ? `Created: ${new Date(item.created_at).toLocaleDateString()}` : ""}</small></div><div className="gss-admin-item-actions"><button type="button" onClick={() => startEditing(item)} aria-label={`Edit ${item.title}`}><Pencil size={16}/> Edit</button><button type="button" className="danger" onClick={() => deleteAdminItem(item)} aria-label={`Delete ${item.title}`}><Trash2 size={16}/> Delete</button></div></article>)}</div>}
        </section>
        <p className="gss-admin-security-note"><LockKeyhole size={15}/> Admin tools are intended for authorized team members. Make sure Supabase Row Level Security policies restrict write access to approved admins.</p>
      </main>
    </div>;
  }

  return <>
    <div className="announcement"><span className="status-dot"/> PHYSICAL SECURITY <i/> CYBERSECURITY <i/> AWARENESS <span className="announcement-right">Security. Intelligence. Trust.</span></div>
    <header className="site-header">
      <div className="container nav-wrap">
        <Brand/>
        <button className="menu-toggle" aria-label="Toggle navigation" onClick={() => setMenuOpen(!menuOpen)}>{menuOpen ? <X/> : <Menu/>}</button>
        <nav className={menuOpen ? "nav-links open" : "nav-links"}>
          {navItems.map(([label, href]) => <a key={label} href={href} onClick={() => setMenuOpen(false)}>{label}</a>)}
          <button className="login-nav" onClick={openLogin}><LockKeyhole size={15}/> Team Login</button>
        </nav>
      </div>
    </header>

    <main>
      <section className="hero" id="home">
        <div className="hero-grid"/>
        <div className="container hero-inner">
          <div className="hero-copy">
            <span className="eyebrow"><span className="gold-line"/> YOUR TRUSTED SECURITY PARTNER</span>
            <h1>Protect what<br/> <em>matters most.</em></h1>
            <p className="hero-lead">Integrated physical security and digital protection for a safer, more resilient tomorrow.</p>
            <p className="hero-desc">From professional security personnel to web security, website design and cyber awareness — we help people and organizations build confidence in the physical and digital world.</p>
            <div className="hero-actions">
              <a className="button button-gold" href="#services">Explore Services <ArrowRight size={17}/></a>
              <a className="button button-outline" href="#contact">Connect With Us <ArrowUpRight size={17}/></a>
            </div>
            <div className="hero-proof"><span><ShieldCheck size={16}/> Physical & Digital</span><span><CheckCircle2 size={16}/> Awareness-led</span><span><LockKeyhole size={16}/> Trust-focused</span></div>
          </div>
          <div className="hero-art" aria-label="Abstract shield illustration">
            <div className="orbit orbit-one"/><div className="orbit orbit-two"/>
            <div className="hero-shield"><Shield size={164} strokeWidth={0.8}/><span>G</span></div>
            <div className="floating-card card-top"><span className="tiny-icon"><LockKeyhole size={16}/></span><span><b>SECURITY FIRST</b><small>People · Systems · Data</small></span></div>
            <div className="floating-card card-bottom"><span className="pulse-ring"/><span><b>STAY AWARE</b><small>Prevention starts with knowledge</small></span></div>
            <div className="hero-caption">GSS <span> / </span> EST. WITH PURPOSE</div>
          </div>
        </div>
        <div className="hero-bottom-line"/>
      </section>

      <section className="trust-strip"><div className="container trust-inner"><span>OUR FOCUS</span><b>Physical Protection</b><i/><b>Web & Digital Security</b><i/><b>Professional Web Design</b><i/><b>Cyber Awareness</b></div></section>

      <section className="section services-section" id="services">
        <div className="container">
          <SectionHeading eyebrow="WHAT WE DO" title="Security, built around you." subtitle="Practical services for people, businesses and communities — under one trusted name."/>
          <div className="service-grid">
            {services.map(({icon: Icon, number, title, tag, description}) => <article className="service-card" key={title}>
              <div className="service-card-top"><span className="service-icon"><Icon size={25}/></span><span className="service-number">{number}</span></div>
              <span className="card-tag">{tag}</span><h3>{title}</h3><p>{description}</p>
              <a href="#contact" className="text-link">Discuss this service <ArrowUpRight size={15}/></a>
            </article>)}
          </div>
          <div className="services-note"><ShieldCheck size={19}/><p><b>Need a tailored solution?</b> Tell us what you need and our team can discuss the scope with you.</p><a href="#contact">Start a conversation <ArrowRight size={15}/></a></div>
        </div>
      </section>

      <section className="section about-section" id="about">
        <div className="container about-grid">
          <div className="about-visual"><div className="about-emblem"><Shield size={104} strokeWidth={0.9}/><span>G</span></div><div className="visual-caption"><span>GOLCONDA</span><small>SECURITY SERVICES</small></div><div className="visual-corner corner-a"/><div className="visual-corner corner-b"/></div>
          <div className="about-copy"><span className="eyebrow">WHO WE ARE</span><h2>One mission.<br/><em>Two worlds to protect.</em></h2><p>Golconda Security Services brings physical security and digital safety together. Our aim is to help organizations protect their people, strengthen their online presence and create a more cyber-aware community.</p><p>We believe good security is built on preparation, responsible practices, clear communication and continuous learning.</p><a href="#profile" className="button button-outline">Explore Our Profile <ArrowRight size={16}/></a></div>
        </div>
      </section>

      <section className="section updates-section" id="notifications">
        <div className="container">
          <div className="section-row"><SectionHeading eyebrow="THE LATEST" title="Notifications & updates" subtitle="Company news, service announcements and safety reminders." align="left"/><span className="live-label"><span className="status-dot"/> LATEST UPDATES</span></div>
          <div className="updates-grid">{initialUpdates.map((item, i) => <article className="update-card" key={item.title}><div className="update-meta"><span>{item.type}</span><span>{item.date}</span></div><h3>{item.title}</h3><p>{item.text}</p><a href="#contact" className="text-link">Stay connected <ArrowRight size={15}/></a></article>)}</div>
          <p className="small-note"><Bell size={14}/> Live admin-managed notifications will be connected after the database and team dashboard are implemented.</p>
        </div>
      </section>

      <section className="section events-section" id="events">
        <div className="container">
          <SectionHeading eyebrow="LEARN · PREPARE · PROTECT" title="Upcoming events" subtitle="Building safer digital habits through community learning."/>
          <div className="events-grid">{events.map((event, i) => <article className="event-card" key={event.title}><div className="event-date"><CalendarDays size={20}/><span>{event.date}</span></div><div className="event-content"><span className="card-tag">{event.type}</span><h3>{event.title}</h3><p>{event.desc}</p><div className="event-footer"><span>{event.status}</span><a href="#contact" aria-label="Ask about event"><ArrowUpRight size={18}/></a></div></div></article>)}</div>
        </div>
      </section>

      <section className="section profile-section" id="profile">
        <div className="container profile-panel">
          <div className="profile-main"><span className="eyebrow">THE COMPANY PROFILE</span><h2>Get to know <em>our work.</em></h2><p>A dedicated space for company documents, certifications, team photographs, program videos, project highlights and milestones.</p><div className="profile-types"><span><FileText size={17}/> Documents</span><span><ImageIcon size={17}/> Photos</span><span><PlayCircle size={17}/> Videos</span></div><button className="button button-gold" onClick={() => setNotice("The public profile library will be enabled once company documents and media are supplied.")}>View Company Profile <ArrowRight size={16}/></button></div>
          <div className="profile-tiles"><div className="profile-tile tile-large"><FileText size={25}/><b>Company Documents</b><small>Policies · Certificates · Brochures</small></div><div className="profile-tile"><ImageIcon size={23}/><b>Gallery</b><small>Photos & milestones</small></div><div className="profile-tile"><PlayCircle size={23}/><b>Media</b><small>Videos & programs</small></div></div>
        </div>
      </section>

      <section className="section careers-section" id="careers">
        <div className="container careers-grid">
          <div><span className="eyebrow">WORK WITH US</span><h2>Build a safer future<br/><em>with our team.</em></h2><p>Interested in security roles, technology, web design or cyber awareness? Share your details and area of interest with us.</p><div className="career-perks"><span><Users size={17}/> Team opportunities</span><span><GraduationCap size={17}/> Learning & awareness</span></div></div>
          <form className="form-card" onSubmit={(e) => submitForm(e, "applications", application, () => setApplication({name:"",email:"",role:"Security Guard / ASO",message:""}), "Application details submitted successfully.")}>
            <h3>Work with us</h3><p className="form-intro">Start by telling us a little about yourself.</p>
            <label>Full name<input required value={application.name} onChange={e=>setApplication({...application,name:e.target.value})} placeholder="Your full name"/></label>
            <label>Email address<input required type="email" value={application.email} onChange={e=>setApplication({...application,email:e.target.value})} placeholder="you@example.com"/></label>
            <label>Area of interest<select value={application.role} onChange={e=>setApplication({...application,role:e.target.value})}><option>Security Guard / ASO</option><option>Web Security</option><option>Web Designing</option><option>Cyber Awareness</option><option>Other / Internship</option></select></label>
            <label>Short introduction<textarea rows="3" value={application.message} onChange={e=>setApplication({...application,message:e.target.value})} placeholder="Experience, skills or questions"/></label>
            <button className="button button-gold button-full" type="submit">Submit Interest <ArrowRight size={16}/></button>
          </form>
        </div>
      </section>

      <section className="section contact-section" id="contact">
        <div className="container contact-grid">
          <div className="contact-copy"><span className="eyebrow">LET'S CONNECT</span><h2>Start a <em>conversation.</em></h2><p>Have a security requirement, website project, collaboration idea or awareness program in mind? Send us a message.</p>
            <div className="contact-method"><span><Mail size={18}/></span><div><small>EMAIL</small><b>Add your official business email</b></div></div>
            <div className="contact-method"><span><Phone size={18}/></span><div><small>PHONE</small><b>Add your official business number</b></div></div>
            <div className="contact-method"><span><MapPin size={18}/></span><div><small>LOCATION</small><b>Add your business location</b></div></div>
            <div className="social-block"><small>CONNECT WITH US</small><div className="social-links">
              <a href="https://www.linkedin.com/" target="_blank" rel="noreferrer" aria-label="LinkedIn"><Linkedin/></a><a href="https://www.instagram.com/" target="_blank" rel="noreferrer" aria-label="Instagram"><Instagram/></a><a href="https://www.youtube.com/" target="_blank" rel="noreferrer" aria-label="YouTube"><Youtube/></a><a href="https://www.facebook.com/" target="_blank" rel="noreferrer" aria-label="Facebook"><Facebook/></a><a href="https://t.me/" target="_blank" rel="noreferrer" aria-label="Telegram"><Send/></a>
            </div><p className="small-note">Replace these generic links with your official company social profiles before launch.</p></div>
          </div>
          <form className="form-card contact-form" onSubmit={(e) => submitForm(e, "contact", contact, () => setContact({name:"",email:"",service:"Web Security",message:""}), "Your message was submitted successfully.")}>
            <h3>Send us a message</h3><p className="form-intro">Fields marked * are required.</p>
            <label>Full name *<input required value={contact.name} onChange={e=>setContact({...contact,name:e.target.value})} placeholder="Your name"/></label>
            <label>Email address *<input required type="email" value={contact.email} onChange={e=>setContact({...contact,email:e.target.value})} placeholder="you@example.com"/></label>
            <label>I'm interested in<select value={contact.service} onChange={e=>setContact({...contact,service:e.target.value})}>{services.map(s=><option key={s.title}>{s.title}</option>)}<option>General enquiry</option></select></label>
            <label>How can we help? *<textarea required rows="4" value={contact.message} onChange={e=>setContact({...contact,message:e.target.value})} placeholder="Tell us about your requirement..."/></label>
            <button className="button button-gold button-full" type="submit">Send Enquiry <ArrowRight size={16}/></button>
            {notice && <p className="form-notice" role="status">{notice}</p>}
            <p className="privacy-note"><LockKeyhole size={13}/> Please don't include passwords, OTPs or confidential security data.</p>
          </form>
        </div>
      </section>
    </main>

    <footer className="site-footer"><div className="container footer-main"><div className="footer-brand"><Brand footer/><p>Security. Intelligence. Trust.<br/>Protecting people, systems and possibilities.</p></div><div className="footer-col"><b>Explore</b><a href="#services">Services</a><a href="#profile">Company Profile</a><a href="#events">Upcoming Events</a></div><div className="footer-col"><b>Get involved</b><a href="#careers">Work With Us</a><a href="#notifications">Notifications</a><a href="#contact">Contact Us</a></div><div className="footer-col"><b>Team access</b><button className="footer-login" onClick={openLogin}>Team Login <ArrowUpRight size={14}/></button><span>Private portal · Coming next</span></div></div><div className="container footer-bottom"><span>© {new Date().getFullYear()} Golconda Security Services. All rights reserved.</span><span>Built with care. Designed for trust.</span><a href="#home">Back to top ↑</a></div></footer>

    {loginOpen && <div className="modal-backdrop" role="presentation" onClick={()=>setLoginOpen(false)}><div className="login-modal" role="dialog" aria-modal="true" aria-labelledby="login-title" onClick={e=>e.stopPropagation()}><button className="modal-close" onClick={()=>setLoginOpen(false)} aria-label="Close login"><X/></button><div className="modal-logo"><Shield size={36}/></div><span className="eyebrow">GSS PRIVATE PORTAL</span><h2 id="login-title">Team <em>access.</em></h2>
    <form onSubmit={handleLogin}><label>Email Address<input type="email" required value={login.userId} onChange={e=>setLogin({...login,userId:e.target.value})} placeholder="you@example.com" autoComplete="username"/></label><label>Password<input type="password" required value={login.password} onChange={e=>setLogin({...login,password:e.target.value})} placeholder="Your password" autoComplete="current-password"/></label><button className="button button-gold button-full" type="submit">Continue <ArrowRight size={16}/></button></form>{loginMessage && <p className="form-notice">{loginMessage}</p>}<p className="privacy-note"><LockKeyhole size={13}/> Authorized team members only.</p></div></div>}
    {notice && !loginOpen && <div className="toast" role="status">{notice}<button onClick={()=>setNotice("")} aria-label="Dismiss"><X size={16}/></button></div>}
  </>;
}

createRoot(document.getElementById("root")).render(<App/>);
