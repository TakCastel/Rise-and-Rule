import type { GameState } from "../game/types";
import { findPossession } from "../game/war";

/**
 * Popup bloquante : un seigneur exige ta soumission comme vassal. Refuser
 * déclenche une guerre de vassalisation de sa part (voir `demandAllegiance`
 * / `respondAllegianceDemand`).
 */
export function AllegianceDemandModal({
  game,
  onRespond,
}: {
  game: GameState;
  onRespond: (requestId: number, accept: boolean) => void;
}) {
  const request = (game.allegianceDemands || [])[0];
  if (!request) return null;
  const demander = findPossession(game.world, request.demanderId);
  if (!demander) return null;

  return (
    <div className="notice-modal-overlay">
      <div className="notice-modal" role="alertdialog" aria-modal="true">
        <div className="notice-modal-title">Demand for submission</div>
        <div className="notice-modal-message">
          {demander.holderName} demands you submit as their vassal. Refusing means war.
        </div>
        <div className="notice-modal-actions">
          <button
            type="button"
            className="notice-modal-btn"
            onClick={() => onRespond(request.id, false)}
          >
            Refuse
          </button>
          <button
            type="button"
            className="notice-modal-btn"
            onClick={() => onRespond(request.id, true)}
          >
            Submit
          </button>
        </div>
      </div>
    </div>
  );
}
