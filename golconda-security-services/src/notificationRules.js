const severityOrder = { urgent: 0, warning: 1, announcement: 2, information: 3 };

export function isNotificationVisible(notification, now = Date.now()) {
  if (!notification || notification.is_active !== true || notification.is_published !== true) return false;
  const startsAt = notification.starts_at ? Date.parse(notification.starts_at) : null;
  const expiresAt = notification.expires_at ? Date.parse(notification.expires_at) : null;
  if (startsAt !== null && (!Number.isFinite(startsAt) || startsAt > now)) return false;
  if (expiresAt !== null && (!Number.isFinite(expiresAt) || expiresAt <= now)) return false;
  return true;
}

export function prioritizeNotifications(notifications, now = Date.now(), dismissedIds = new Set()) {
  return (notifications || [])
    .filter(notification => isNotificationVisible(notification, now) && !dismissedIds.has(String(notification.id)))
    .sort((first, second) => {
      const priority = (severityOrder[first.notification_severity] ?? 4) - (severityOrder[second.notification_severity] ?? 4);
      if (priority) return priority;
      return Date.parse(second.created_at || 0) - Date.parse(first.created_at || 0);
    });
}

export function safeNotificationHref(value) {
  const href = String(value ?? "").trim();
  if (!href) return "";
  if (/^\/(?!\/)/.test(href) || href.startsWith("#")) return href;
  try {
    const url = new URL(href);
    return url.protocol === "https:" ? url.href : "";
  } catch {
    return "";
  }
}

export function getDismissedNotificationIds(storage) {
  if (storage === undefined) {
    try { storage = globalThis.sessionStorage; } catch { storage = null; }
  }
  const ids = new Set();
  if (!storage) return ids;
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith("gss-dismissed-notification:")) ids.add(key.slice("gss-dismissed-notification:".length));
    }
  } catch {
    // Storage can be unavailable in private or restricted browser contexts.
  }
  return ids;
}

export function dismissNotification(id, storage) {
  if (storage === undefined) {
    try { storage = globalThis.sessionStorage; } catch { storage = null; }
  }
  if (!storage) return;
  try {
    storage.setItem(`gss-dismissed-notification:${id}`, "1");
  } catch {
    // The banner remains usable when session storage is unavailable.
  }
}

export function toDateTimeLocalValue(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "";
  const pad = number => String(number).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function toUtcDateTime(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}
