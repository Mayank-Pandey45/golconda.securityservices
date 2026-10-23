export const recordModules = {
  guards: { table: "guards", kind: "operational", label: "Guard" },
  supervisors: { table: "supervisors", kind: "operational", label: "Supervisor" },
  fieldOfficers: { table: "field_officers", kind: "operational", label: "Field Officer" },
  sites: { table: "sites", kind: "operational", label: "Site" },
  services: { table: "services", kind: "catalogue", label: "Service" },
  events: { table: "events", kind: "catalogue", label: "Event" },
  notifications: { table: "notifications", kind: "notification", label: "Notification" },
  profileDocs: { table: "profile_docs", kind: "media", label: "Profile document" },
  contactSubmissions: { table: "contact_submissions", kind: "intake", label: "Enquiry" },
  jobApplications: { table: "job_applications", kind: "intake", label: "Application" },
  complaints: { table: "complaints", kind: "intake", label: "Complaint" },
};
export const intakeStates = {
  contactSubmissions: ["new", "read", "closed"],
  jobApplications: ["new", "reviewing", "closed"],
  complaints: ["pending", "resolved"],
};
export function recordState(module, record) {
  if (record.archived_at) return "archived";
  const kind = recordModules[module]?.kind;
  if (kind === "operational") return record.status === "active" ? "active" : "inactive";
  if (kind === "intake") return ["closed", "resolved"].includes(record.status) ? "inactive" : "active";
  if (kind === "media") return record.is_public ? "active" : "inactive";
  return record.is_active === false ? "inactive" : "active";
}
export function matchesRecordState(module, record, filter = "all") {
  return filter === "all" || recordState(module, record) === filter;
}
export function recordActions(module, record) {
  const config = recordModules[module];
  if (!config) return [];
  if (record.archived_at) return ["restore", ...(config.kind !== "intake" ? ["delete"] : [])];
  const actions = ["archive"];
  if (config.kind === "operational" || config.kind === "catalogue" || config.kind === "notification") {
    actions.unshift(recordState(module, record) === "active" ? "deactivate" : "activate");
  } else if (config.kind === "media" && record.is_public) actions.unshift("hide");
  else if (config.kind === "intake") actions.unshift(recordState(module, record) === "active" ? "close" : "reopen");
  return actions;
}
export function confirmationPhrase(action, id) {
  return action === "delete" ? "DELETE " + id : action === "cleanup" ? "DELETE FILE " + id : "";
}
export const actionLabels = {
  archive: "Archive", restore: "Restore", deactivate: "Deactivate / hide",
  activate: "Activate", hide: "Hide from public", delete: "Permanently delete",
  close: "Close", reopen: "Reopen",
};

export function employeeRecordKey(person) { return person.employee_type + ":" + person.id; }

export function recordLabel(record) {
  return record.title || record.full_name || record.name || record.complainant_name || record.file_title || record.subject || "Record";
}
