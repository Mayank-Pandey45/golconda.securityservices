import React, { useState } from "react";
import { ArrowRight, X } from "lucide-react";
import { dismissNotification, getDismissedNotificationIds, prioritizeNotifications, safeNotificationHref } from "./notificationRules.js";
import "./announcementBanner.css";

export default function AnnouncementBanner({ notifications = [], now = Date.now() }) {
  const [dismissedIds, setDismissedIds] = useState(() => getDismissedNotificationIds());
  const notification = prioritizeNotifications(notifications, now, dismissedIds)[0];
  if (!notification) return null;

  const href = safeNotificationHref(notification.button_url);
  const canDismiss = notification.dismissible !== false;
  const dismiss = () => {
    dismissNotification(notification.id);
    setDismissedIds(previous => new Set(previous).add(String(notification.id)));
  };

  return <aside className={`announcement-banner severity-${notification.notification_severity || "information"}`} aria-live={notification.notification_severity === "urgent" ? "assertive" : "polite"} aria-labelledby="public-announcement-title">
    <div className="container announcement-banner-inner">
      <div className="announcement-banner-icon" aria-hidden="true">{notification.notification_severity === "urgent" || notification.notification_severity === "warning" ? "!" : "i"}</div>
      <div className="announcement-banner-copy"><span>{notification.notification_severity || "announcement"} · {notification.notification_type || "GSS UPDATE"}</span><h2 id="public-announcement-title">{notification.title}</h2><p>{notification.message}</p>{href && notification.button_label && <a href={href} className="announcement-banner-cta">{notification.button_label}<ArrowRight size={15}/></a>}</div>
      {canDismiss && <button type="button" className="announcement-banner-close" onClick={dismiss} aria-label={`Dismiss notification: ${notification.title}`}><X size={18}/></button>}
    </div>
  </aside>;
}
