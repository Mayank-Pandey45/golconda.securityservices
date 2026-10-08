export function toDateInputValue(value) {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const pad = number => String(number).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

export function toUtcDateTimestamp(value) {
  const dateOnly = toDateInputValue(value);
  return dateOnly ? `${dateOnly}T00:00:00.000Z` : null;
}

export function formatUtcDate(value, locale) {
  const dateOnly = toDateInputValue(value);
  if (!dateOnly) return "COMING SOON";
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" })
    .format(new Date(`${dateOnly}T00:00:00.000Z`));
}
