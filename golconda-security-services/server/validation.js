export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ValidationError";
  }
}

function bodyObject(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ValidationError("A JSON object is required.");
  }
  return body;
}

function text(value, field, { required = false, max = 2000 } = {}) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (required && !normalized) throw new ValidationError(`${field} is required.`);
  if (normalized.length > max) throw new ValidationError(`${field} must be ${max} characters or fewer.`);
  return normalized;
}

function email(value, field = "Email") {
  const normalized = text(value, field, { required: true, max: 254 });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new ValidationError(`${field} must be valid.`);
  }
  return normalized.toLowerCase();
}

export function normalizeContact(body) {
  const input = bodyObject(body);
  return {
    name: text(input.name, "Name", { required: true, max: 120 }),
    email: email(input.email),
    service: text(input.service, "Service", { max: 120 }),
    message: text(input.message, "Message", { required: true, max: 4000 }),
  };
}

export function normalizeApplication(body) {
  const input = bodyObject(body);
  return {
    full_name: text(input.name ?? input.full_name, "Name", { required: true, max: 120 }),
    email: email(input.email),
    role: text(input.role, "Role", { max: 120 }),
    message: text(input.message, "Introduction", { max: 4000 }),
  };
}

export function normalizeComplaint(body) {
  const input = bodyObject(body);
  const role = text(input.role || "Security Guard", "Role", { required: true, max: 80 });
  const allowedRoles = ["Security Guard", "Supervisor", "Field Officer", "Client / Facility Manager"];
  if (!allowedRoles.includes(role)) throw new ValidationError("Role is not supported.");
  const phone = text(input.phone, "Phone number", { required: true, max: 24 });
  if (!/^[+\d()\s.-]{6,24}$/.test(phone) || !/\d/.test(phone)) throw new ValidationError("Phone number must contain 6–24 valid characters and at least one digit.");
  return {
    complainant_name: text(input.complainant_name, "Name", { required: true, max: 120 }),
    role,
    phone,
    subject: text(input.subject, "Subject", { required: true, max: 200 }),
    details: text(input.details, "Complaint details", { required: true, max: 5000 }),
  };
}

export function normalizeMessage(body, fallbackRecipient) {
  const input = bodyObject(body);
  const rawRecipients = input.recipients ?? input.recipient ?? fallbackRecipient;
  const recipients = (Array.isArray(rawRecipients) ? rawRecipients : String(rawRecipients || "").split(","))
    .map((recipient) => email(recipient, "Recipient"));
  if (!recipients.length || recipients.length > 10) {
    throw new ValidationError("Provide between 1 and 10 email recipients.");
  }
  return {
    title: text(input.title, "Title", { required: true, max: 200 }),
    message: text(input.message, "Message", { required: true, max: 5000 }),
    recipients: [...new Set(recipients)],
  };
}
