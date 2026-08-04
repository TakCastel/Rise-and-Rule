import type { GameNotice } from "../game/types";

/**
 * Modale bloquante générique : le jeu reste en pause tant qu'elle est
 * affichée (cf. `pauseForNewNotices` dans useGame.ts). Réutilisable pour
 * n'importe quel évènement méritant un acquittement explicite plutôt qu'une
 * simple ligne de chronique. Sans `actions`, un unique bouton OK est affiché.
 */
export function NoticeModal({
  notice,
  onDismiss,
}: {
  notice: GameNotice | undefined;
  onDismiss: (noticeId: number, actionId: string) => void;
}) {
  if (!notice) return null;
  const actions = notice.actions?.length ? notice.actions : [{ id: "ok", label: "OK" }];

  return (
    <div className="notice-modal-overlay">
      <div className="notice-modal" role="alertdialog" aria-modal="true">
        {notice.title && <div className="notice-modal-title">{notice.title}</div>}
        <div className="notice-modal-message">{notice.message}</div>
        <div className="notice-modal-actions">
          {actions.map((a) => (
            <button
              key={a.id}
              type="button"
              className="notice-modal-btn"
              onClick={() => onDismiss(notice.id, a.id)}
            >
              {a.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
