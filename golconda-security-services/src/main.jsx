import React, { useState } from "react";
import { supabase } from "./supabase";
import { createRoot } from "react-dom/client";
import {
  Shield, ShieldCheck, Menu, X, ArrowUpRight, ArrowRight, LockKeyhole,
  Globe, Code2, GraduationCap, UserRound, Bell, CalendarDays, Users,
  FileText, Image as ImageIcon, PlayCircle, Linkedin, Instagram, Youtube,
  Facebook, Send, Mail, Phone, MapPin, ChevronRight, CheckCircle2
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

    const { data, error } = await supabase.auth.signInWithPassword({
      email: login.userId.trim(),
      password: login.password,
    });

    if (error) {
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

    setLoginMessage("Admin login successful.");
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

  setLoginMessage("Admin login successful.");
}

  return <>
    <div className="announcement"><span className="status-dot"/> PHYSICAL SECURITY <i/> CYBERSECURITY <i/> AWARENESS <span className="announcement-right">Security. Intelligence. Trust.</span></div>
    <header className="site-header">
      <div className="container nav-wrap">
        <Brand/>
        <button className="menu-toggle" aria-label="Toggle navigation" onClick={() => setMenuOpen(!menuOpen)}>{menuOpen ? <X/> : <Menu/>}</button>
        <nav className={menuOpen ? "nav-links open" : "nav-links"}>
          {navItems.map(([label, href]) => <a key={label} href={href} onClick={() => setMenuOpen(false)}>{label}</a>)}
         <button className="login-nav" onClick={openLogin}>
  <LockKeyhole size={15}/> Team Login
</button>
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

    <footer className="site-footer"><div className="container footer-main"><div className="footer-brand"><Brand footer/><p>Security. Intelligence. Trust.<br/>Protecting people, systems and possibilities.</p></div><div className="footer-col"><b>Explore</b><a href="#services">Services</a><a href="#profile">Company Profile</a><a href="#events">Upcoming Events</a></div><div className="footer-col"><b>Get involved</b><a href="#careers">Work With Us</a><a href="#notifications">Notifications</a><a href="#contact">Contact Us</a></div><div className="footer-col"><b>Team access</b><button className="footer-login" onClick={openLogin}>
  Team Login <ArrowUpRight size={14}/>
</button><span>Private portal · Coming next</span></div></div><div className="container footer-bottom"><span>© {new Date().getFullYear()} Golconda Security Services. All rights reserved.</span><span>Built with care. Designed for trust.</span><a href="#home">Back to top ↑</a></div></footer>

    {loginOpen && <div className="modal-backdrop" role="presentation" onClick={()=>setLoginOpen(false)}><div className="login-modal" role="dialog" aria-modal="true" aria-labelledby="login-title" onClick={e=>e.stopPropagation()}><button className="modal-close" onClick={()=>setLoginOpen(false)} aria-label="Close login"><X/></button><div className="modal-logo"><Shield size={36}/></div><span className="eyebrow">GSS PRIVATE PORTAL</span><h2 id="login-title">Team <em>access.</em></h2>
    <form onSubmit={handleLogin}><label>Email Address<input value={login.userId} onChange={e=>setLogin({...login,userId:e.target.value})} placeholder="Team member ID" autoComplete="off"/></label><label>Password<input type="password" value={login.password} onChange={e=>setLogin({...login,password:e.target.value})} placeholder="Not active yet" autoComplete="new-password"/></label><button className="button button-gold button-full" type="submit">Continue <ArrowRight size={16}/></button></form>{loginMessage && <p className="form-notice">{loginMessage}</p>}<p className="privacy-note"><LockKeyhole size={13}/> Never enter a real password in this placeholder.</p></div></div>}
    {notice && !loginOpen && <div className="toast" role="status">{notice}<button onClick={()=>setNotice("")} aria-label="Dismiss"><X size={16}/></button></div>}
  </>;
}

createRoot(document.getElementById("root")).render(<App/>);
