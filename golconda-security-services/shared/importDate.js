// Dates are calendar values, never locale-dependent Date.parse strings.
// Agreed century rule: 00–49 = 2000–2049; 50–99 = 1950–1999.
export function normalizeImportDate(value) {
  if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) return null;
  let year, month, day;
  if (value instanceof Date) {
    if (Number.isNaN(value.valueOf())) throw new Error('Date must be valid.');
    year = value.getUTCFullYear(); month = value.getUTCMonth() + 1; day = value.getUTCDate();
  } else {
    if (!['string', 'number'].includes(typeof value)) throw new Error('Date must use YYYY-MM-DD, DD-MM-YYYY or DD/MM/YY.');
    const raw = String(value).trim();
    const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(raw);
    const local = /^(\d{1,2})([/.\-])(\d{1,2})\2(\d{4}|\d{2})$/.exec(raw);
    if (iso) { year = Number(iso[1]); month = Number(iso[2]); day = Number(iso[3]); }
    else if (local) {
      day = Number(local[1]); month = Number(local[3]); year = Number(local[4]);
      if (local[4].length === 2) year += year <= 49 ? 2000 : 1900;
    } else if (/^\d+(?:\.\d+)?$/.test(raw) && Number(raw) >= 20000 && Number(raw) <= 80000) {
      const excel = new Date(Date.UTC(1899, 11, 30) + Math.floor(Number(raw)) * 86400000);
      year = excel.getUTCFullYear(); month = excel.getUTCMonth() + 1; day = excel.getUTCDate();
    } else throw new Error('Date must use YYYY-MM-DD, DD-MM-YYYY or DD/MM/YY.');
  }
  const check = new Date(Date.UTC(year, month - 1, day));
  if (year < 100 || year > 9999 || check.getUTCFullYear() !== year || check.getUTCMonth() + 1 !== month || check.getUTCDate() !== day) {
    throw new Error('Date must be a real calendar date (YYYY-MM-DD, DD-MM-YYYY or DD/MM/YY).');
  }
  return [String(year).padStart(4, '0'), String(month).padStart(2, '0'), String(day).padStart(2, '0')].join('-');
}
