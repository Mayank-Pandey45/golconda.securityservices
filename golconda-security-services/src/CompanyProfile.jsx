import React from "react";
import { ArrowLeft, ArrowRight, ArrowUpRight, FileText, Image as ImageIcon, MapPin, PlayCircle, ShieldCheck } from "lucide-react";
import "./companyProfile.css";

function ProfileFileCard({ item }) {
  return <article className="profile-file-card">
    <div className="profile-file-preview">
      {item.media_type === "image" ? <img src={item.file_url} alt={item.title} loading="lazy"/> : item.media_type === "video" ? <video src={item.file_url} controls preload="metadata" aria-label={item.title}/> : <span aria-hidden="true"><FileText size={30}/></span>}
    </div>
    <div className="profile-file-copy">
      <span className="profile-file-category">{item.category || "Company Profile"}</span>
      <h3>{item.title}</h3>
      {item.description && <p>{item.description}</p>}
      <a href={item.file_url} target="_blank" rel="noopener noreferrer" className="text-link">{item.media_type === "image" ? "Open image" : item.media_type === "video" ? "Open video" : "View or download"}<ArrowUpRight size={15}/></a>
    </div>
  </article>;
}

export default function CompanyProfile({ services = [], documents = [], loading = false, error = "", onRefresh }) {
  const gallery = documents.filter(item => ["image", "video"].includes(item.media_type));
  const credentials = documents.filter(item => !["image", "video"].includes(item.media_type));

  return <section className="company-profile-page section" id="profile">
    <div className="container">
      <a className="profile-back-link" href="/"><ArrowLeft size={17}/> Return to home</a>
      <div className="company-profile-hero">
        <div>
          <span className="eyebrow">COMPANY PROFILE · SECUNDERABAD</span>
          <h1>Security grounded in <em>people and trust.</em></h1>
          <p>The public company profile presents the current service catalogue and material approved by the company. Contact the team to confirm service availability, operating terms and coverage for a specific requirement.</p>
          <div className="company-profile-actions"><a className="button button-gold" href="/#contact">Discuss your requirements <ArrowRight size={16}/></a><span><MapPin size={15}/> Secunderabad, Telangana</span></div>
        </div>
        <div className="company-profile-mark" aria-hidden="true"><ShieldCheck size={72}/><b>GSS</b><small>SECURITY · INTELLIGENCE · TRUST</small></div>
      </div>

      <div className="company-profile-facts">
        <div><span>Company</span><strong>Golconda Security Services</strong></div>
        <div><span>Location</span><strong>Secunderabad, Telangana</strong></div>
        <div><span>Current catalogue</span><strong>{services.length ? services.map(service => service.title).join(", ") : "See the Services section"}</strong></div>
      </div>

      <div className="profile-purpose-grid">
        <article><span className="eyebrow">SERVICE ENQUIRIES</span><h3>Discuss your site and requirements.</h3><p>Share the service you are considering, your location and the question you need answered. The company can confirm current availability and terms directly.</p><a className="text-link" href="/#contact">Contact the team <ArrowRight size={14}/></a></article>
        <article><span className="eyebrow">PUBLIC MATERIAL</span><h3>Company information chosen for sharing.</h3><p>Only files explicitly approved by an administrator appear in this public profile. Drafts and employee records remain restricted to the admin portal.</p></article>
      </div>

      <div className="profile-capabilities">
        <div className="section-heading profile-heading align-left"><span className="eyebrow">OUR CAPABILITIES</span><h2>Integrated protection for changing needs.</h2><p>Our service list is maintained by authorized administrators and appears here from the live services catalogue.</p></div>
        <div className="profile-capability-grid">
          {services.length ? services.map(service => <article key={service.id}><span><ShieldCheck size={18}/></span><h3>{service.title}</h3><p>{service.description}</p></article>) : <p>No published services are available right now.</p>}
        </div>
        <div className="profile-operations-note"><b>Guard deployment and site coordination</b><p>Guard assignments connect to managed deployment sites. The public profile shows company capabilities and approved media only; individual guard identities, contact details, salaries, and assignment records remain in the admin portal.</p></div>
      </div>

      <div className="profile-public-content">
        <div className="profile-content-heading"><div><span className="eyebrow">PUBLIC COMPANY MATERIAL</span><h2>Documents & approved media</h2><p>Administrators choose which items can be shared. Draft and private records are not included in this public view.</p></div>{onRefresh && <button className="profile-refresh" type="button" onClick={onRefresh}>Refresh profile</button>}</div>
        {loading ? <p role="status" className="profile-content-state">Loading approved profile files…</p> : error ? <p role="alert" className="profile-content-state">{error}</p> : <>
          <section aria-labelledby="credentials-heading" className="profile-file-section">
            <h3 id="credentials-heading"><FileText size={18}/> Compliance & company documents</h3>
            <p className="profile-document-intro">PASARA licence, GST, ESI, PF and other compliance documents appear only when approved for public sharing.</p>
            {credentials.length ? <div className="profile-file-grid">{credentials.map(item => <ProfileFileCard key={item.id} item={item}/>)}</div> : <p className="profile-content-state">No approved company documents are currently available.</p>}
          </section>
          <section aria-labelledby="gallery-heading" className="profile-file-section">
            <h3 id="gallery-heading"><ImageIcon size={18}/> Company gallery & activities</h3>
            {gallery.length ? <div className="profile-file-grid">{gallery.map(item => <ProfileFileCard key={item.id} item={item}/>)}</div> : <p className="profile-content-state">No approved photos or videos are currently available.</p>}
          </section>
        </>}
      </div>
      <p className="profile-privacy-note"><PlayCircle size={15}/> Documents and media appear here only after an administrator explicitly marks them for public display.</p>
    </div>
  </section>;
}
