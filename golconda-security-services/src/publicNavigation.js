export function scrollToPublicSection({ hash, document }) {
  if (!hash || !hash.startsWith('#')) return false;
  let id;
  try { id = decodeURIComponent(hash.slice(1)); } catch { return false; }
  const target = document.getElementById(id);
  if (!target) return false;
  target.scrollIntoView({ block: 'start', behavior: 'instant' });
  return true;
}
