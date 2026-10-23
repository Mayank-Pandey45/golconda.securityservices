const DEVANAGARI_DIGITS = "०१२३४५६७८९";
const ENGLISH_DIGITS = "0123456789";
const STOP_WORDS = new Set(["ka", "ki", "ke", "ko", "keliye", "liye", "for", "to", "guard", "advance", "adv", "rs", "rupees", "rupaye", "rupya", "inr", "please"]);
const UNKNOWN_ABBREVIATIONS = new Set(["pp", "gp", "sl"]);

export function asciiDigits(value) {
  return String(value ?? "").replace(/[०-९]/g, digit => ENGLISH_DIGITS[DEVANAGARI_DIGITS.indexOf(digit)]);
}

export function normalizeTelegramText(value) {
  return asciiDigits(value).normalize("NFKC").toLocaleLowerCase("en-IN")
    .replace(/[\p{P}\p{S}]+/gu, " ").replace(/\s+/g, " ").trim();
}

const compact = value => normalizeTelegramText(value).replace(/\s/g, "");

function editDistance(left, right) {
  const a = [...left]; const b = [...right];
  let prior = b.map((_, index) => index + 1);
  for (let i = 0; i < a.length; i += 1) {
    const row = [i + 1];
    for (let j = 0; j < b.length; j += 1) row.push(Math.min(row[j] + 1, prior[j + 1] + 1, prior[j] + (a[i] === b[j] ? 0 : 1)));
    prior = row;
  }
  return prior[b.length];
}

function includesPhrase(source, phrase) {
  const needle = normalizeTelegramText(phrase);
  if (!needle || [...needle].length < 3) return false;
  const haystack = normalizeTelegramText(source);
  if (` ${haystack} `.includes(` ${needle} `)) return true;
  return compact(source).includes(compact(needle));
}

function findEntities(source, rows, aliases, entityType, rowKey, fields) {
  const direct = [];
  for (const row of rows) {
    const variants = fields.flatMap(field => field === "full_name" ? [row[field], ...String(row[field] || "").split(/\s+/)] : [row[field]]).filter(Boolean);
    for (const alias of aliases.filter(item => item.entity_type === entityType && String(item[rowKey] ?? "") === String(row.id))) variants.push(alias.alias);
    const matched = variants.find(value => includesPhrase(source, value));
    if (matched) direct.push({ ...row, match: matched });
  }
  const distinct = [...new Map(direct.map(item => [String(item.id), item])).values()];
  if (distinct.length) return { matches: distinct, suggestions: [] };

  const words = normalizeTelegramText(source).split(" ").filter(word => [...word].length >= 4);
  const suggestions = [];
  for (const row of rows) {
    const variants = fields.flatMap(field => field === "full_name" ? [row[field], ...String(row[field] || "").split(/\s+/)] : [row[field]]).filter(Boolean).concat(
      aliases.filter(item => item.entity_type === entityType && String(item[rowKey] ?? "") === String(row.id)).map(item => item.alias),
    );
    const nearest = variants.some(value => {
      const normalized = normalizeTelegramText(value);
      return normalized.split(" ").some(candidate => [...candidate].length >= 5 && words.some(word => editDistance(word, candidate) <= 1));
    });
    if (nearest) suggestions.push(row);
  }
  return { matches: [], suggestions: suggestions.slice(0, 5) };
}

function parseDate(source, now) {
  const iso = /\b(20\d{2})-(\d{2})-(\d{2})\b/.exec(source);
  const local = /\b(\d{1,2})[/-](\d{1,2})[/-](20\d{2})\b/.exec(source);
  let year; let month; let day;
  if (iso) [, year, month, day] = iso;
  else if (local) [, day, month, year] = local;
  if (!year) return { occurredAt: now.toISOString(), matched: "" };
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (date.getUTCFullYear() !== Number(year) || date.getUTCMonth() !== Number(month) - 1 || date.getUTCDate() !== Number(day)) return { error: "That date is invalid." };
  if (date.valueOf() > now.valueOf() + 5 * 60 * 1000) return { error: "Future advance dates are not allowed." };
  return { occurredAt: `${year}-${month}-${day}T00:00:00+05:30`, matched: iso?.[0] || local?.[0] };
}

export function parseTelegramDate(value, now = new Date()) { return parseDate(asciiDigits(value), now); }

function extractAmount(source) {
  const normalized = asciiDigits(source).replace(/\b20\d{2}-\d{2}-\d{2}\b/g, " ").replace(/\b\d{1,2}[/-]\d{1,2}[/-]20\d{2}\b/g, " ");
  const matches = [...normalized.matchAll(/(?<![\w])(?:₹\s*)?(-?\d{1,3}(?:,\d{3})+|-?\d+)(?:\.(\d+))?(?![\d.])/g)];
  const monetary = matches.filter(match => match[0].includes("₹") || /[,\.]/.test(match[0]) || !/^\d{4}$/.test(match[1].replace(/^-/, "")));
  const candidates = monetary.length ? monetary : matches;
  if (!candidates.length) return { error: "Add one advance amount, for example: 1000 Srikant VK Enclave." };
  if (candidates.length !== 1) return { error: "I found more than one amount. Send one advance amount at a time." };
  const match = candidates[0];
  if (match[1].startsWith("-")) return { error: "Advance amount must be positive." };
  if ((match[2] || "").length > 2) return { error: "Use no more than two digits after the decimal point." };
  const amount = Number(`${match[1].replaceAll(",", "")}${match[2] ? `.${match[2]}` : ""}`);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 10000000) return { error: "Enter an amount greater than ₹0 and no more than ₹1,00,00,000." };
  return { amount: amount.toFixed(2), token: match[0] };
}

export function parseTelegramAmount(value) {
  const result = extractAmount(String(value ?? ""));
  return result.error ? { error: result.error } : { amount: result.amount };
}

export function parseAdvanceMessage(input, { employees = [], sites = [], aliases = [], now = new Date() } = {}) {
  const text = String(input ?? "").trim();
  if (!text || text.length > 500) return { status: "clarification", message: "Send an advance note of up to 500 characters." };
  if (/\b(expense|reimburse(?:ment)?|refund|bill|invoice)\b/i.test(text)) return { status: "clarification", message: "This sounds like an expense or reimbursement. This bot records employee advances only." };
  let amountSearchText = text;
  for (const code of [...employees.map(row => row.employee_code), ...sites.map(row => row.site_code)].filter(Boolean).sort((a, b) => b.length - a.length)) {
    amountSearchText = amountSearchText.replace(new RegExp(String(code).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu"), " ");
  }
  const amount = extractAmount(amountSearchText);
  if (amount.error) return { status: "clarification", message: amount.error };
  const date = parseDate(text, now);
  if (date.error) return { status: "clarification", message: date.error };
  const normalized = normalizeTelegramText(text);
  const configuredNotes = aliases.filter(alias => {
    if (alias.entity_type !== "note") return false;
    const normalizedAlias = normalizeTelegramText(alias.alias);
    return normalizedAlias.length < 3 ? normalized.split(" ").includes(normalizedAlias) : includesPhrase(text, alias.alias);
  });
  const recognizedAbbreviations = new Set(configuredNotes.map(alias => normalizeTelegramText(alias.alias)));
  const unresolved = [...UNKNOWN_ABBREVIATIONS].filter(abbreviation => normalized.split(" ").includes(abbreviation) && !recognizedAbbreviations.has(abbreviation));
  if (unresolved.length) return { status: "clarification", message: `I do not know what ${unresolved.join(", ")} means. Add an approved alias in Telegram Integration settings or clarify the note.` };

  const employeeRows = employees.filter(row => String(row.status || "").toLowerCase() === "active");
  const employeeTypes = ["guard", "supervisor", "field_officer"];
  const employeeResults = employeeTypes.map(type => findEntities(text, employeeRows.filter(row => row.employee_type === type), aliases, type, `${type}_id`, ["full_name", "employee_code"]));
  const employeeMatches = employeeResults.flatMap(result => result.matches);
  if (employeeMatches.length !== 1) {
    if (employeeMatches.length > 1) return { status: "ambiguous_employee", candidates: employeeMatches.slice(0, 5).map(row => ({ id: row.id, employee_type: row.employee_type, full_name: row.full_name, employee_code: row.employee_code })) };
    const suggestions = [...new Map(employeeResults.flatMap(result => result.suggestions).map(row => [String(row.id), row])).values()];
    return { status: "clarification", message: suggestions.length ? `I could not confirm the employee. Did you mean: ${suggestions.map(row => `${row.full_name} (${row.employee_code})`).join(", ")}?` : "I could not match an active employee. Add their exact name, employee code, or an approved alias." };
  }
  const employee = employeeMatches[0];
  const siteResult = findEntities(text, sites.filter(row => String(row.status || "").toLowerCase() === "active"), aliases, "site", "site_id", ["title", "site_code"]);
  if (siteResult.matches.length !== 1) {
    if (siteResult.matches.length > 1) return { status: "ambiguous_site", employee: { id: employee.id, employee_type: employee.employee_type, full_name: employee.full_name, employee_code: employee.employee_code }, candidates: siteResult.matches.slice(0, 5).map(row => ({ id: row.id, title: row.title, site_code: row.site_code })) };
    return { status: "clarification", message: siteResult.suggestions.length ? `I could not confirm the site. Did you mean: ${siteResult.suggestions.map(row => row.title).join(", ")}?` : "I could not match an active site. Add its exact name, site code, or an approved alias." };
  }
  const site = siteResult.matches[0];

  const mode = /\b(cash|nakad)\b/i.test(text) ? "Cash" : /\b(online|upi|bank|transfer)\b/i.test(text) ? "Online" : "";
  let residue = asciiDigits(text).replace(amount.token, " ");
  if (date.matched) residue = residue.replace(date.matched, " ");
  for (const variant of [employee.full_name, employee.employee_code, employee.match, site.title, site.site_code, site.match, ...aliases.filter(alias => alias.entity_type !== "note" && includesPhrase(text, alias.alias)).map(alias => alias.alias)].filter(Boolean).sort((a,b) => b.length - a.length)) {
    residue = residue.replace(new RegExp(variant.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu"), " ");
  }
  residue = normalizeTelegramText(residue).split(" ").filter(word => !STOP_WORDS.has(word) && !/^\d+$/.test(word) && !new Set(["cash", "nakad", "online", "upi", "bank", "transfer"]).has(word)).join(" ");
  const description = configuredNotes.reduce((value, alias) => value.replace(normalizeTelegramText(alias.alias), normalizeTelegramText(alias.replacement)), residue).trim().slice(0, 500);
  return {
    status: "ready",
    advance: {
      employee: { id: employee.id, employee_type: employee.employee_type, full_name: employee.full_name, employee_code: employee.employee_code },
      site: { id: site.id, title: site.title, site_code: site.site_code },
      amount: amount.amount,
      occurred_at: date.occurredAt,
      payment_mode: mode,
      description,
      notes: "",
    },
  };
}
