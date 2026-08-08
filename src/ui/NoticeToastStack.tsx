import { useEffect } from "react";
import type { GameNotice } from "../game/types";

/** Délai avant fermeture automatique d'une notice non bloquante. */
const NOTICE_TOAST_AUTO_DISMISS_MS = 10_000;

function NoticeToast({
  notice,
  onDismiss,
}: {
  notice: GameNotice;
  onDismiss: (noticeId: number, actionId: string) => void;
}) {
  useEffect(() => {
    const timer = setTimeout(
      () => onDismiss(notice.id, "auto"),
      NOTICE_TOAST_AUTO_DISMISS_MS,
    );
    return () => clearTimeout(timer);
  }, [notice.id, onDismiss]);

  const actions = notice.actions?.length ? notice.actions : [{ id: "ok", label: "OK" }];
  return (
    <div className="notice-toast" role="status">
      {notice.title && <div className="notice-toast-title">{notice.title}</div>}
      <div className="notice-toast-message">{notice.message}</div>
      <div className="notice-toast-actions">
        {actions.map((a) => (
          <button
            key={a.id}
            type="button"
            className="notice-toast-btn"
            onClick={() => onDismiss(notice.id, a.id)}
          >
            {a.label}
          </button>
        ))}
      </div>
      {/* Décompte visuel avant fermeture auto — pure CSS, pas de re-render à
          chaque frame : une seule animation lancée au montage. */}
      <div className="notice-toast-progress">
        <div
          key={notice.id}
          className="notice-toast-progress-bar"
          style={{ animationDuration: `${NOTICE_TOAST_AUTO_DISMISS_MS}ms` }}
        />
      </div>
    </div>
  );
}

/**
 * Notices non bloquantes (`blocking: false`) empilées dans un coin de
 * l'écran — contrairement à `NoticeModal`, plusieurs s'affichent à la fois,
 * le jeu continue de tourner en dessous, et chacune se ferme d'elle-même
 * après quelques secondes si elle n'est pas acquittée manuellement.
 */
export function NoticeToastStack({
  notices,
  onDismiss,
}: {
  notices: GameNotice[];
  onDismiss: (noticeId: number, actionId: string) => void;
}) {
  if (!notices.length) return null;

  return (
    <div className="notice-toast-stack">
      {notices.map((notice) => (
        <NoticeToast key={notice.id} notice={notice} onDismiss={onDismiss} />
      ))}
    </div>
  );
}
